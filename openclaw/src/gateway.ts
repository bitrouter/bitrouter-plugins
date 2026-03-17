/**
 * Gateway RPC methods — registered via api.registerGatewayMethod()
 * for external access to plugin state.
 */

import type {
  BitrouterState,
  GatewayRequestHandlerOptions,
  OpenClawPluginApi,
} from "./types.js";
import { refreshMetrics } from "./metrics.js";
import { loadOnboardingState } from "./onboarding.js";

/**
 * Register gateway RPC methods.
 */
export function registerGatewayMethods(
  api: OpenClawPluginApi,
  state: BitrouterState
): void {
  // ── bitrouter.metrics ─────────────────────────────────────────────
  api.registerGatewayMethod("bitrouter.metrics", async (opts: GatewayRequestHandlerOptions) => {
    // Return cached metrics, or fetch fresh if stale/missing.
    if (!state.metrics) {
      await refreshMetrics(state, api);
    }
    opts.respond(true, state.metrics ?? { error: "No metrics available" });
  });

  // ── bitrouter.routing.explain ─────────────────────────────────────
  api.registerGatewayMethod("bitrouter.routing.explain", async (opts: GatewayRequestHandlerOptions) => {
    const routes = state.knownRoutes.map((r) => ({
      model: r.model,
      provider: r.provider,
      protocol: r.protocol,
    }));

    opts.respond(true, {
      healthy: state.healthy,
      baseUrl: state.baseUrl,
      routes,
      metricsAvailable: state.metrics !== null,
    });
  });

  // ── bitrouter.wallet ──────────────────────────────────────────────
  api.registerGatewayMethod("bitrouter.wallet", async (opts: GatewayRequestHandlerOptions) => {
    const onboarding = loadOnboardingState(state.homeDir);
    opts.respond(true, onboarding ?? { error: "No onboarding state found" });
  });
}
