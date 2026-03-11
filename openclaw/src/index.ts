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
import { registerFeedbackRoute } from "./feedback.js";
import { registerGatewayMethods } from "./gateway.js";

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
    dynamicRoutes: new Map(),
    metrics: null,
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

  // ── Always register CLI alias ─────────────────────────────────────
  //
  // `openclaw bitrouter setup` is a discoverable alias for the wizard.
  try {
    api.registerCli(
      ({ program }: { program: unknown }) => {
        (program as { command(s: string): { description(s: string): { action(fn: () => void): void } } })
          .command("bitrouter setup")
          .description(
            "Configure BitRouter (first-run setup wizard). " +
              "Equivalent to: openclaw models auth login --provider bitrouter"
          )
          .action(() => {
            console.log(
              "\nBitRouter setup wizard:\n" +
                "  openclaw models auth login --provider bitrouter\n\n" +
                "Choose 'BYOK' to enter your API key, or 'BitRouter Cloud'\n" +
                "to sign in (coming soon).\n"
            );
          });
      },
      { commands: ["bitrouter"] }
    );
  } catch (err) {
    // Non-fatal — CLI alias is a convenience, not required.
    api.logger.warn(`Failed to register bitrouter CLI alias: ${err}`);
  }

  // ── Check if setup has been completed ────────────────────────────
  //
  // If mode is unset, emit a clear hint and stop here. The daemon won't
  // start and no tools or hooks will be registered until setup is done.
  if (!config.mode) {
    api.logger.warn(
      "BitRouter plugin is installed but not yet configured. " +
        "Run: openclaw models auth login --provider bitrouter"
    );
    return;
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

  // Register HTTP feedback endpoint.
  try {
    registerFeedbackRoute(api, stateDirRef);
  } catch (err) {
    api.logger.error(`Failed to register feedback route: ${err}`);
  }

  // Register gateway RPC methods.
  try {
    registerGatewayMethods(api, state);
  } catch (err) {
    api.logger.error(`Failed to register gateway methods: ${err}`);
  }

  const upstream = config.byok?.upstreamProvider ?? "unknown";
  api.logger.info(
    `BitRouter plugin activated (${state.baseUrl}, mode=${config.mode}, ` +
      `upstream=${upstream}, interceptAll=${config.interceptAllModels ?? DEFAULTS.interceptAllModels})`
  );
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
