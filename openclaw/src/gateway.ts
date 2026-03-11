/**
 * Gateway RPC methods — registered via api.registerGatewayMethod()
 * for external access to plugin state.
 */

import type {
  BitrouterState,
  OpenClawPluginApi,
} from "./types.js";
import { refreshMetrics } from "./metrics.js";

/**
 * Register gateway RPC methods.
 */
export function registerGatewayMethods(
  api: OpenClawPluginApi,
  state: BitrouterState
): void {
  // ── bitrouter.metrics ─────────────────────────────────────────────
  api.registerGatewayMethod("bitrouter.metrics", async () => {
    // Return cached metrics, or fetch fresh if stale/missing.
    if (!state.metrics) {
      await refreshMetrics(state, api);
    }
    return state.metrics ?? { error: "No metrics available" };
  });

  // ── bitrouter.routing.explain ─────────────────────────────────────
  api.registerGatewayMethod("bitrouter.routing.explain", async () => {
    const staticRoutes = state.knownRoutes.map((r) => ({
      model: r.model,
      provider: r.provider,
      protocol: r.protocol,
      source: "static" as const,
    }));

    const dynamicRoutes = Array.from(state.dynamicRoutes.values()).map((dr) => ({
      model: dr.model,
      strategy: dr.strategy,
      endpoints: dr.endpoints.map((e) => ({
        provider: e.provider,
        modelId: e.modelId,
      })),
      source: "dynamic" as const,
      createdAt: dr.createdAt,
    }));

    return {
      healthy: state.healthy,
      baseUrl: state.baseUrl,
      resolutionOrder: [
        "1. Dynamic routes (agent-created, plugin-layer)",
        "2. Static routes (BitRouter config, cached in knownRoutes)",
        "3. Fall through to OpenClaw native resolution",
      ],
      staticRoutes,
      dynamicRoutes,
      metricsAvailable: state.metrics !== null,
    };
  });
}
