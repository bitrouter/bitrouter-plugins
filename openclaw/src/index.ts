/**
 * @bitrouter/openclaw-plugin — entry point.
 *
 * This is the main export that OpenClaw calls when the plugin is loaded.
 * It wires together all sub-modules:
 *
 *   - service.ts  → daemon lifecycle (spawn/stop bitrouter)
 *   - provider.ts → register "bitrouter" as an LLM provider
 *   - routing.ts  → before_model_resolve hook for selective interception
 *   - config.ts   → generate bitrouter.yaml from plugin config
 *   - health.ts   → periodic health checks and readiness polling
 *
 * The plugin degrades gracefully:
 *   - If the binary isn't found, it logs an error but still registers
 *     the provider and hook (the user may be running BitRouter externally).
 *   - If health checks fail, the routing hook becomes a no-op (falls
 *     through to OpenClaw's native model resolution).
 */

import type {
  BitrouterPluginConfig,
  BitrouterState,
  OpenClawPluginApi,
} from "./types.js";
import { DEFAULTS } from "./types.js";
import { resolveHomeDir } from "./config.js";
import { registerBitrouterService } from "./service.js";
import { registerBitrouterProvider } from "./provider.js";
import { registerModelInterceptor } from "./routing.js";

/**
 * Plugin activation — called by OpenClaw when the plugin is loaded.
 *
 * Registers the service, provider, and model routing hook. Each
 * registration is independent: a failure in one doesn't block the others.
 */
export function activate(api: OpenClawPluginApi): void {
  const config: BitrouterPluginConfig = api.getConfig();
  const host = config.host ?? DEFAULTS.host;
  const port = config.port ?? DEFAULTS.port;

  // Shared mutable state — passed by reference to all sub-modules.
  const state: BitrouterState = {
    process: null,
    healthy: false,
    baseUrl: `http://${host}:${port}`,
    knownRoutes: [],
    healthCheckTimer: null,
    homeDir: resolveHomeDir(api),
  };

  // Register the daemon service (spawn/stop bitrouter).
  try {
    registerBitrouterService(api, config, state);
  } catch (err) {
    api.log.error(`Failed to register BitRouter service: ${err}`);
    // Continue — the user may run BitRouter externally.
  }

  // Register "bitrouter" as a provider pointing to localhost.
  try {
    registerBitrouterProvider(api, config, state);
  } catch (err) {
    api.log.error(`Failed to register BitRouter provider: ${err}`);
  }

  // Hook into model resolution to selectively route through BitRouter.
  try {
    registerModelInterceptor(api, config, state);
  } catch (err) {
    api.log.error(`Failed to register model interceptor: ${err}`);
  }

  api.log.info(
    `BitRouter plugin activated (${state.baseUrl}, ` +
      `interceptAll=${config.interceptAllModels ?? DEFAULTS.interceptAllModels})`
  );
}

// Default export for OpenClaw plugin loading.
export default activate;
