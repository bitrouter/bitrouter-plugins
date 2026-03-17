/**
 * @bitrouter/openclaw-plugin — entry point.
 *
 * Exports an OpenClawPluginDefinition that OpenClaw loads directly.
 * Wires together all sub-modules:
 *
 *   - service.ts  → daemon lifecycle (spawn/stop bitrouter)
 *   - provider.ts → register "bitrouter" as an LLM provider
 *   - routing.ts  → before_model_resolve hook for selective interception
 *   - config.ts   → generate bitrouter.yaml from plugin config
 *   - health.ts   → periodic health checks and readiness polling
 *   - setup.ts    → first-run wizard (BYOK / Cloud)
 *
 * First-run behaviour:
 *   If config.mode is unset (plugin never configured), the plugin:
 *     1. Registers the "bitrouter" provider with both auth methods
 *        (so `openclaw models auth login --provider bitrouter` works)
 *     2. Registers a `openclaw bitrouter setup` CLI alias
 *     3. Logs a clear hint and returns early — daemon is NOT started,
 *        tools are NOT registered, model interception is OFF.
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
import { registerModelInterceptor } from "./routing.js";
import { registerAgentTools } from "./tools.js";
import { registerGatewayMethods } from "./gateway.js";
import { detectProviders } from "./auto-detect.js";
import { loadOnboardingState, isOnboardingComplete, needsOnboarding } from "./onboarding.js";
import { resolveBinaryPath } from "./binary.js";

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
      config.interceptAllModels = true;
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

    // If not resolved to cloud, try env var auto-detection.
    if (!config.mode) {
      const detected = detectProviders(api);

      if (detected.length === 0) {
        api.logger.warn(
          "BitRouter plugin is installed but no API keys detected in environment. " +
            "Run: openclaw bitrouter setup"
        );
        return;
      }

      // Found providers — activate in auto mode.
      api.logger.info(
        `BitRouter auto-detected ${detected.length} provider(s): ` +
          detected.map((p) => p.name).join(", ")
      );
      for (const p of detected) {
        const masked = p.apiKey.length > 8
          ? `${p.apiKey.slice(0, 4)}...${p.apiKey.slice(-4)}`
          : "****";
        api.logger.info(`  ${p.name}: ${p.envVarKey} found (${masked})`);
      }

      // Set mode in-memory only — auto mode re-scans on every restart.
      config.mode = "auto";
      config.interceptAllModels = true;
      state.autoDetectedProviders = detected;
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
    registerModelInterceptor(api, config, state);
  } catch (err) {
    api.logger.error(`Failed to register model interceptor: ${err}`);
  }

  // Register agent tools for runtime route management.
  try {
    registerAgentTools(api, config, state, stateDirRef);
  } catch (err) {
    api.logger.error(`Failed to register agent tools: ${err}`);
  }

  // Register gateway RPC methods.
  try {
    registerGatewayMethods(api, state);
  } catch (err) {
    api.logger.error(`Failed to register gateway methods: ${err}`);
  }

  if (config.mode === "auto") {
    const names = state.autoDetectedProviders?.map((p) => p.name).join(", ") ?? "none";
    api.logger.info(
      `BitRouter plugin activated in auto mode (${state.baseUrl}, ` +
        `providers=${names}, interceptAll=true)`
    );
  } else {
    const upstream = config.byok?.upstreamProvider ?? "unknown";
    api.logger.info(
      `BitRouter plugin activated (${state.baseUrl}, mode=${config.mode}, ` +
        `upstream=${upstream}, interceptAll=${config.interceptAllModels ?? DEFAULTS.interceptAllModels})`
    );
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
