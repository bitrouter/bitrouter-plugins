/**
 * @bitrouter/openclaw-plugin — entry point.
 *
 * Exports an OpenClawPluginDefinition that OpenClaw loads directly.
 * Wires together all sub-modules:
 *
 *   - service.ts        → daemon lifecycle (spawn/stop bitrouter)
 *   - provider.ts       → register "bitrouter" as an LLM provider
 *   - routing.ts        → before_model_resolve hook for selective interception
 *   - prompt-context.ts → before_prompt_build hook for dynamic state injection
 *   - http-routes.ts    → HTTP routes proxying to BitRouter's native API
 *   - config.ts         → generate bitrouter.yaml from plugin config
 *   - health.ts         → periodic health checks and readiness polling
 *   - setup.ts          → first-run wizard (BYOK / Cloud)
 *
 * First-run behaviour:
 *   If config.mode is unset (plugin never configured), the plugin:
 *     1. Registers the "bitrouter" provider with both auth methods
 *        (so `openclaw models auth login --provider bitrouter` works)
 *     2. Registers a `openclaw bitrouter setup` CLI alias
 *     3. Activates in "auto" mode — provider detection is deferred to
 *        the discovery.run(ctx) hook which uses ctx.resolveApiKey for
 *        standard key resolution through OpenClaw's discovery phases.
 *
 *   After the wizard runs (writes configPatch → openclaw.json) and the
 *   gateway is restarted, config.mode will be set and full activation runs.
 *
 * The plugin degrades gracefully:
 *   - If the binary isn't found, logs an error but still registers
 *     the provider and hook (the user may be running BitRouter externally).
 *   - If health checks fail, the routing hook becomes a no-op (falls
 *     through to OpenClaw's native model resolution).
 */

import { spawnSync } from "node:child_process";
import type {
  BitrouterPluginConfig,
  BitrouterState,
  OpenClawPluginApi,
  OpenClawPluginDefinition,
} from "./types.js";
import { DEFAULTS } from "./types.js";
import { resolveHomeDir } from "./config.js";
import { registerBitrouterService } from "./service.js";
import { registerBitrouterProvider } from "./provider.js";
import { registerModelInterceptor, refreshAgents, refreshTools, refreshSkills } from "./routing.js";
import { registerPromptContext } from "./prompt-context.js";
import { registerHttpRoutes } from "./http-routes.js";
import { loadOnboardingState, isOnboardingComplete, needsOnboarding } from "./onboarding.js";
import { resolveBinaryPath } from "./binary.js";
import { switchAll, restoreModels } from "./switch.js";

/**
 * Plugin activation — called by OpenClaw when the plugin is loaded.
 *
 * Registers the service, provider, and model routing hook. Each
 * registration is independent: a failure in one doesn't block the others.
 */
export function activate(api: OpenClawPluginApi): void {
  const config = (api.pluginConfig ?? {}) as BitrouterPluginConfig;
  const host = config.host ?? DEFAULTS.host;
  const port = config.port ?? DEFAULTS.port;

  // Mutable ref for stateDir — set when the service's start(ctx) fires.
  // Fallback covers provider/CLI registration that happens before service start.
  const stateDirRef = { value: `${process.env.HOME}/.openclaw/plugins/bitrouter` };

  // Shared mutable state — passed by reference to all sub-modules.
  const state: BitrouterState = {
    process: null,
    healthy: false,
    baseUrl: `http://${host}:${port}`,
    knownRoutes: [],
    knownModels: [],
    knownAgents: [],
    knownTools: [],
    knownSkills: [],
    healthCheckTimer: null,
    homeDir: resolveHomeDir(stateDirRef.value),
    metrics: null,
    apiToken: null,
    adminToken: null,
    onboardingState: null,
  };

  // ── Always register the provider so the auth wizard is reachable ──
  //
  // This must happen even before mode is checked, so the user can always
  // run `openclaw models auth login --provider bitrouter` regardless of
  // whether they've completed setup.
  try {
    registerBitrouterProvider(api, config, state);
  } catch (err) {
    api.logger.error(`Failed to register BitRouter provider: ${err}`);
  }

  // ── Register CLI subcommands ────────────────────────────────────────
  try {
    api.registerCli(
      ({ program }: { program: unknown }) => {
        const prog = program as {
          command(s: string): {
            description(s: string): {
              action(fn: () => void | Promise<void>): unknown;
            };
          };
        };

        // openclaw bitrouter setup — spawn `bitrouter init` interactively
        prog
          .command("bitrouter setup")
          .description("Set up BitRouter wallet and onboarding via interactive CLI")
          .action(async () => {
            if (!process.stdin.isTTY) {
              console.log(
                "\nBitRouter setup requires an interactive terminal.\n" +
                  "Run this command directly in your terminal (not piped).\n"
              );
              return;
            }

            let binaryPath: string;
            try {
              binaryPath = await resolveBinaryPath(stateDirRef.value);
            } catch (err) {
              console.error(`\nFailed to resolve BitRouter binary: ${err}\n`);
              return;
            }

            console.log("\nLaunching BitRouter onboarding wizard...\n");
            const result = spawnSync(binaryPath, ["--home-dir", state.homeDir, "init"], {
              stdio: "inherit",
            });

            if (result.status !== 0) {
              console.error(
                `\nBitRouter init exited with code ${result.status}.` +
                  (result.error ? ` Error: ${result.error.message}` : "") +
                  "\n"
              );
              return;
            }

            // Read onboarding state after completion.
            const onboarding = loadOnboardingState(state.homeDir);
            if (onboarding && isOnboardingComplete(onboarding)) {
              console.log(
                `\nOnboarding complete (${onboarding.status}).` +
                  "\nRestart the gateway to activate: openclaw gateway restart\n"
              );
            } else {
              console.log(
                "\nOnboarding did not complete. You can re-run: openclaw bitrouter setup\n"
              );
            }
          });

        // openclaw bitrouter wallet — show wallet/onboarding info
        prog
          .command("bitrouter wallet")
          .description("Show BitRouter wallet and onboarding state")
          .action(() => {
            const onboarding = loadOnboardingState(state.homeDir);
            if (!onboarding) {
              console.log("\nNo onboarding state found. Run: openclaw bitrouter setup\n");
              return;
            }
            console.log("\nBitRouter Onboarding State:");
            console.log(JSON.stringify(onboarding, null, 2));
            console.log();
          });

        // openclaw bitrouter status — overview of plugin state
        prog
          .command("bitrouter status")
          .description("Show BitRouter plugin status, daemon health, and wallet info")
          .action(() => {
            const sections: string[] = ["\nBitRouter Status:"];

            // Onboarding
            const onboarding = loadOnboardingState(state.homeDir);
            sections.push(
              `  Onboarding: ${onboarding?.status ?? "not found"}`
            );

            // Daemon health
            sections.push(`  Daemon: ${state.healthy ? "healthy" : "unhealthy"}`);
            sections.push(`  URL: ${state.baseUrl}`);

            // Routes
            sections.push(`  Routes: ${state.knownRoutes.length} known`);
            for (const r of state.knownRoutes) {
              sections.push(`    ${r.model} → ${r.provider} (${r.protocol})`);
            }

            // Agents
            sections.push(`  A2A Agents: ${state.knownAgents.length} upstream`);
            for (const a of state.knownAgents) {
              const skills = a.skills.length > 0
                ? ` (${a.skills.map((s) => s.name).join(", ")})`
                : "";
              sections.push(`    ${a.id}${skills}`);
            }

            // Tools & Skills
            const mcpTools = state.knownTools.filter((t) => t.provider !== "skill");
            const skillTools = state.knownTools.filter((t) => t.provider === "skill");
            sections.push(`  MCP Tools: ${mcpTools.length}, Skills: ${skillTools.length}`);

            // Wallet info
            if (onboarding?.wallet_address) {
              sections.push(`  Wallet: ${onboarding.wallet_address}`);
            }
            if (onboarding?.swig_id) {
              sections.push(`  Swig ID: ${onboarding.swig_id}`);
            }
            if (onboarding?.agent_wallets?.length) {
              sections.push(`  Agent wallets: ${onboarding.agent_wallets.length}`);
              for (const aw of onboarding.agent_wallets) {
                sections.push(`    ${aw.label}: ${aw.address} (role ${aw.role_id})`);
              }
            }

            console.log(sections.join("\n") + "\n");
          });

        // openclaw bitrouter switch-all — rewrite agent models to bitrouter/
        prog
          .command("bitrouter switch-all")
          .description("Rewrite all agent model configs to route through BitRouter")
          .action(async () => {
            const result = await switchAll(api, config, state);
            if (result.error) {
              console.error(`\nError: ${result.error}\n`);
              return;
            }
            console.log("\nSwitched agent models to BitRouter:");
            for (const line of result.changes) {
              console.log(line);
            }
            console.log("\nRestart the gateway to apply: openclaw gateway restart\n");
          });

        // openclaw bitrouter restore-models — restore original agent models
        prog
          .command("bitrouter restore-models")
          .description("Restore agent model configs to their original values")
          .action(async () => {
            const result = await restoreModels(api, config);
            if (result.error) {
              console.error(`\nError: ${result.error}\n`);
              return;
            }
            console.log("\nRestored original agent models:");
            for (const line of result.changes) {
              console.log(line);
            }
            console.log("\nRestart the gateway to apply: openclaw gateway restart\n");
          });

        // openclaw bitrouter agents — list upstream A2A agents
        prog
          .command("bitrouter agents")
          .description("List upstream A2A agents proxied through BitRouter")
          .action(async () => {
            if (!state.healthy) {
              console.log("\nBitRouter is not healthy. Start the gateway first.\n");
              return;
            }
            await refreshAgents(state, api);
            if (state.knownAgents.length === 0) {
              console.log("\nNo upstream A2A agents configured.\n");
              console.log("Configure agents in openclaw.json under plugins.entries.bitrouter.config.a2aAgents\n");
              return;
            }
            console.log(`\nUpstream A2A Agents (${state.knownAgents.length}):\n`);
            for (const agent of state.knownAgents) {
              const streaming = agent.streaming ? " [streaming]" : "";
              console.log(`  ${agent.id}${streaming}`);
              if (agent.description) console.log(`    ${agent.description}`);
              if (agent.skills.length > 0) {
                console.log(`    Skills: ${agent.skills.map((s) => s.name).join(", ")}`);
              }
              if (agent.input_modes.length > 0) {
                console.log(`    Input: ${agent.input_modes.join(", ")}  Output: ${agent.output_modes.join(", ")}`);
              }
            }
            console.log();
          });

        // openclaw bitrouter tools — list MCP tools and skills
        prog
          .command("bitrouter tools")
          .description("List MCP tools and registered skills available through BitRouter")
          .action(async () => {
            if (!state.healthy) {
              console.log("\nBitRouter is not healthy. Start the gateway first.\n");
              return;
            }
            await refreshTools(state, api);
            await refreshSkills(state, api);

            if (state.knownTools.length === 0) {
              console.log("\nNo tools or skills registered.\n");
              console.log("Configure MCP servers in openclaw.json under plugins.entries.bitrouter.config.mcpServers");
              console.log("Configure skills under plugins.entries.bitrouter.config.skills\n");
              return;
            }

            const mcpTools = state.knownTools.filter((t) => t.provider !== "skill");
            const skillEntries = state.knownTools.filter((t) => t.provider === "skill");

            if (mcpTools.length > 0) {
              console.log(`\nMCP Tools (${mcpTools.length}):\n`);
              for (const tool of mcpTools) {
                console.log(`  ${tool.id} [${tool.provider}]`);
                if (tool.description) console.log(`    ${tool.description}`);
              }
            }

            if (skillEntries.length > 0) {
              console.log(`\nSkills (${skillEntries.length}):\n`);
              for (const skill of skillEntries) {
                console.log(`  ${skill.id}`);
                if (skill.description) console.log(`    ${skill.description}`);
              }
            }

            console.log();
          });
      },
      { commands: ["bitrouter"] }
    );
  } catch (err) {
    api.logger.warn(`Failed to register bitrouter CLI commands: ${err}`);
  }

  // ── Check if setup has been completed ────────────────────────────
  //
  // If mode is unset, check onboarding state first, then try auto-detection.
  if (!config.mode) {
    // Check onboarding.json for completed Rust CLI onboarding.
    const onboarding = loadOnboardingState(state.homeDir);

    if (onboarding && onboarding.status === "completed_cloud") {
      // Cloud onboarding completed — activate in cloud mode.
      config.mode = "cloud";
      if (onboarding.rpc_url && !config.solanaRpcUrl) {
        config.solanaRpcUrl = onboarding.rpc_url;
      }
      state.onboardingState = onboarding;
      api.logger.info("BitRouter activating in cloud mode (onboarding completed)");
    } else if (onboarding && onboarding.status === "completed_byok") {
      // BYOK onboarding completed via Rust CLI — fall through to auto-detect.
      state.onboardingState = onboarding;
      api.logger.info("BitRouter BYOK onboarding detected, using auto-detect flow");
    } else {
      if (onboarding && needsOnboarding(onboarding)) {
        api.logger.info(
          "BitRouter onboarding not complete. Run: openclaw bitrouter setup"
        );
      }
    }

    // If not resolved to cloud, activate in auto mode.
    // Actual provider detection is deferred to the discovery.run(ctx) hook
    // which uses ctx.resolveApiKey for standard key resolution.
    if (!config.mode) {
      config.mode = "auto";
      api.logger.info(
        "BitRouter activating in auto mode — provider detection deferred to discovery phase"
      );
    }
  }

  // ── Full activation (mode is set) ────────────────────────────────

  // Register the daemon service (spawn/stop bitrouter).
  try {
    registerBitrouterService(api, config, state, stateDirRef);
  } catch (err) {
    api.logger.error(`Failed to register BitRouter service: ${err}`);
    // Continue — the user may run BitRouter externally.
  }

  // Hook into model resolution to selectively route through BitRouter.
  try {
    registerModelInterceptor(api, state);
  } catch (err) {
    api.logger.error(`Failed to register model interceptor: ${err}`);
  }

  // Register before_prompt_build hook for dynamic context injection.
  try {
    registerPromptContext(api, config, state);
  } catch (err) {
    api.logger.error(`Failed to register prompt context hook: ${err}`);
  }

  // Register HTTP routes that proxy to BitRouter's native API.
  try {
    registerHttpRoutes(api, state);
  } catch (err) {
    api.logger.error(`Failed to register HTTP routes: ${err}`);
  }

  if (config.mode === "auto") {
    api.logger.info(
      `BitRouter plugin activated in auto mode (${state.baseUrl}, use 'openclaw bitrouter switch-all' to route all models)`
    );
  } else {
    const upstream = config.byok?.upstreamProvider ?? "unknown";
    api.logger.info(
      `BitRouter plugin activated (${state.baseUrl}, mode=${config.mode}, upstream=${upstream})`
    );
  }

  // ── Synchronous probe for an already-running BitRouter instance ──
  //
  // Covers single-shot agent commands (openclaw agent --message) where
  // the service start() lifecycle doesn't execute. Uses spawnSync+curl
  // so routes are available before the first prompt hook fires (~10ms
  // overhead for two localhost calls).
  try {
    const healthResult = spawnSync("curl", [
      "-s", "--max-time", "1", `${state.baseUrl}/health`,
    ]);
    if (healthResult.status === 0) {
      const health = JSON.parse(healthResult.stdout.toString());
      if (health.status === "ok") {
        state.healthy = true;

        const routesResult = spawnSync("curl", [
          "-s", "--max-time", "2", `${state.baseUrl}/v1/routes`,
        ]);
        if (routesResult.status === 0) {
          const body = JSON.parse(routesResult.stdout.toString());
          state.knownRoutes = body.routes ?? [];
          api.logger.info(
            `Loaded ${state.knownRoutes.length} route(s) from BitRouter (sync probe)`
          );
        }
      }
    }
  } catch {
    /* graceful — prompt just shows "0 routes" */
  }
}

// OpenClaw plugin definition — the default export.
const plugin: OpenClawPluginDefinition = {
  id: "bitrouter",
  name: "BitRouter",
  description:
    "Route LLM requests through BitRouter — a local multi-provider proxy with " +
    "failover, load balancing, and unified API key management.",
  register: activate,
};

export default plugin;
