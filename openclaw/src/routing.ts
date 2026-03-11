/**
 * Model routing — hooks into OpenClaw's before_model_resolve event to
 * selectively redirect model requests through BitRouter.
 *
 * How it works:
 *
 * 1. On startup (and periodically), we query GET /v1/routes to learn
 *    which models BitRouter has routes for.
 *
 * 2. When OpenClaw resolves a model, the before_model_resolve hook fires.
 *    We check if the requested model is in BitRouter's routing table.
 *
 * 3. If yes (or if interceptAllModels is true), we call event.override()
 *    to redirect the request to the "bitrouter" provider.
 *
 * 4. If no, we do nothing — OpenClaw resolves the model normally.
 *
 * This is purely a metadata decision. No HTTP calls happen in the hook
 * itself — we only consult the cached state.knownRoutes set.
 */

import type {
  BitrouterPluginConfig,
  BitrouterState,
  DynamicRoute,
  EndpointMetrics,
  ModelResolveEvent,
  OpenClawPluginApi,
  RouteInfo,
} from "./types.js";
import { DEFAULTS } from "./types.js";

// ── Route table refresh ──────────────────────────────────────────────

/**
 * Fetch the current routing table from BitRouter and cache it in state.
 *
 * On failure, preserves the existing cache (stale data is better than
 * empty data for the interception set).
 */
export async function refreshRoutes(
  state: BitrouterState,
  api: OpenClawPluginApi
): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    const res = await fetch(`${state.baseUrl}/v1/routes`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      api.log.warn(
        `Failed to fetch routes: ${res.status} ${res.statusText}`
      );
      return;
    }

    const body = (await res.json()) as { routes: RouteInfo[] };
    state.knownRoutes = body.routes;
    api.log.info(
      `Loaded ${state.knownRoutes.length} route(s) from BitRouter`
    );
  } catch (err) {
    // Don't clear existing routes — they may still be valid.
    api.log.warn(`Route refresh failed: ${err}`);
  }
}

// ── Metrics-informed endpoint selection ───────────────────────────────

/**
 * Score an endpoint based on its metrics. Higher is better.
 * score = (1 - error_rate) / latency_p50_ms
 *
 * Returns null if the endpoint should be skipped (circuit breaker).
 */
export function scoreEndpoint(
  metrics: EndpointMetrics | undefined,
  errorRateThreshold: number,
  minRequests: number
): number | null {
  if (!metrics || metrics.total_requests < minRequests) {
    return 0; // No data — neutral score, don't skip.
  }

  // Circuit breaker: skip endpoints with error rate above threshold.
  if (metrics.error_rate > errorRateThreshold) {
    return null;
  }

  const latency = Math.max(metrics.latency_p50_ms, 1); // avoid division by zero
  return (1 - metrics.error_rate) / latency;
}

/**
 * Select the best endpoint from a list using metrics data.
 * Falls back to the first endpoint if no metrics or all are tripped.
 */
export function selectBestEndpoint(
  endpoints: Array<{ provider: string; modelId: string }>,
  modelName: string,
  state: BitrouterState,
  config: BitrouterPluginConfig
): { provider: string; modelId: string } {
  if (endpoints.length <= 1 || !state.metrics) {
    return endpoints[0];
  }

  const routeMetrics = state.metrics.routes[modelName];
  if (!routeMetrics?.by_endpoint) {
    return endpoints[0];
  }

  const threshold = config.routing?.errorRateThreshold ?? 0.5;
  const minReqs = config.routing?.minRequestsForScoring ?? 5;

  let bestScore = -1;
  let bestEndpoint = endpoints[0];
  let allTripped = true;

  for (const ep of endpoints) {
    const key = `${ep.provider}:${ep.modelId}`;
    const epMetrics = routeMetrics.by_endpoint[key];
    const score = scoreEndpoint(epMetrics, threshold, minReqs);

    if (score !== null) {
      allTripped = false;
      if (score > bestScore) {
        bestScore = score;
        bestEndpoint = ep;
      }
    }
  }

  // If all endpoints are circuit-broken, fall back to first (let BitRouter handle it).
  if (allTripped) return endpoints[0];

  return bestEndpoint;
}

// ── Dynamic route resolution ─────────────────────────────────────────

/**
 * Resolve a model name against agent-created dynamic routes.
 *
 * Returns a direct routing string like "openai:gpt-4o" that BitRouter
 * will proxy without consulting its static routing table, or null if
 * no dynamic route exists for this model.
 *
 * For load_balance strategy with metrics available, uses weighted
 * selection preferring healthier endpoints over pure round-robin.
 */
export function resolveDynamicRoute(
  state: BitrouterState,
  modelName: string,
  config?: BitrouterPluginConfig
): string | null {
  const route = state.dynamicRoutes.get(modelName);
  if (!route || route.endpoints.length === 0) return null;

  let endpoint;

  // If metrics are available and preferMetrics is enabled, use scoring.
  const useMetrics =
    config?.routing?.preferMetrics !== false &&
    state.metrics &&
    route.strategy === "load_balance" &&
    route.endpoints.length > 1;

  if (useMetrics) {
    endpoint = selectBestEndpoint(
      route.endpoints,
      modelName,
      state,
      config!
    );
  } else if (route.strategy === "load_balance") {
    const idx = route.rrCounter % route.endpoints.length;
    route.rrCounter++;
    endpoint = route.endpoints[idx];
  } else {
    // "priority" — always use the first endpoint.
    endpoint = route.endpoints[0];
  }

  return `${endpoint.provider}:${endpoint.modelId}`;
}

// ── Hook registration ────────────────────────────────────────────────

/**
 * Register the before_model_resolve hook that redirects matching model
 * requests to the "bitrouter" provider.
 *
 * Resolution order:
 * 1. Dynamic routes (agent-created, plugin-layer) — checked first
 * 2. Static routes (BitRouter config, cached in knownRoutes)
 * 3. Fall through to OpenClaw's native resolution
 */
export function registerModelInterceptor(
  api: OpenClawPluginApi,
  config: BitrouterPluginConfig,
  state: BitrouterState
): void {
  const interceptAll = config.interceptAllModels ?? DEFAULTS.interceptAllModels;

  api.on("before_model_resolve", (event: ModelResolveEvent) => {
    // Don't intercept if BitRouter isn't healthy.
    if (!state.healthy) return;

    const modelName = event.model;

    // 1. Dynamic routes (plugin-layer, agent-created) take priority.
    const directRoute = resolveDynamicRoute(state, modelName, config);
    if (directRoute) {
      event.override({ provider: "bitrouter", model: directRoute });
      return;
    }

    // 2. Existing static route logic.
    if (interceptAll) {
      // Route everything through BitRouter (it can handle any model
      // via direct routing like "openai:gpt-4o").
      event.override({ provider: "bitrouter", model: modelName });
      return;
    }

    // Selective mode: only intercept models in BitRouter's routing table.
    const isKnownRoute = state.knownRoutes.some(
      (r) => r.model === modelName
    );

    if (isKnownRoute) {
      event.override({ provider: "bitrouter", model: modelName });
    }
    // Unknown models fall through to OpenClaw's native resolution.
  });
}
