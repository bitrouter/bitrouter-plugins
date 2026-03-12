/**
 * Metrics integration — fetches and caches performance metrics from
 * BitRouter's GET /v1/metrics endpoint.
 *
 * Metrics are consumed by:
 * - routing.ts — smarter endpoint selection based on latency/error rates
 * - tools.ts — surfaced in agent tools for visibility
 *
 * Degrades gracefully: returns null if the endpoint isn't available
 * (e.g. older BitRouter binary without metrics support).
 *
 * TEMPORARY: When config.routing.mockMetrics is true, generates
 * synthetic metrics from known routes so the plugin can be tested
 * in the OpenClaw runtime before bitrouter/bitrouter#70 ships.
 */

import type {
  BitrouterPluginConfig,
  BitrouterState,
  EndpointMetrics,
  MetricsResponse,
  OpenClawPluginApi,
  RouteMetrics,
} from "./types.js";

/**
 * Fetch metrics from BitRouter and cache them on state.
 *
 * On failure, preserves the existing cache (stale > empty).
 * Falls back to mock data if config.routing.mockMetrics is true.
 */
export async function refreshMetrics(
  state: BitrouterState,
  api: OpenClawPluginApi,
  config?: BitrouterPluginConfig
): Promise<MetricsResponse | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    const res = await fetch(`${state.baseUrl}/v1/metrics`, {
      signal: controller.signal,
      headers: state.authToken
        ? { Authorization: `Bearer ${state.authToken}` }
        : undefined,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      if (res.status === 404 && config?.routing?.mockMetrics) {
        // Binary doesn't support metrics — use mock data.
        const mock = generateMockMetrics(state);
        state.metrics = mock;
        return mock;
      }
      if (res.status !== 404) {
        api.logger.warn(
          `Failed to fetch metrics: ${res.status} ${res.statusText}`
        );
      }
      return null;
    }

    const body = (await res.json()) as MetricsResponse;
    state.metrics = body;
    return body;
  } catch (err) {
    // Connection refused / timeout — if mockMetrics, generate mock data.
    if (config?.routing?.mockMetrics) {
      const mock = generateMockMetrics(state);
      state.metrics = mock;
      return mock;
    }
    api.logger.warn(`Metrics refresh failed: ${err}`);
    return null;
  }
}

// ── Mock metrics generator ──────────────────────────────────────────

/**
 * Generate synthetic metrics from state.knownRoutes + state.dynamicRoutes.
 *
 * Each call bumps request counts slightly to simulate live traffic.
 * Latency and error rates are randomized within realistic ranges.
 */
export function generateMockMetrics(state: BitrouterState): MetricsResponse {
  const existing = state.metrics?.routes ?? {};
  const routes: Record<string, RouteMetrics> = {};

  // Build from static routes.
  for (const r of state.knownRoutes) {
    const prev = existing[r.model];
    routes[r.model] = mockRouteMetricsMulti(
      r.model,
      [`${r.provider}:${r.model}`],
      prev
    );
  }

  return { routes };
}

function mockRouteMetricsMulti(
  model: string,
  endpointKeys: string[],
  prev?: RouteMetrics
): RouteMetrics {
  const byEndpoint: Record<string, EndpointMetrics> = {};
  let totalReqs = 0;
  let totalErrs = 0;
  let weightedLatency = 0;
  let maxP99 = 0;

  for (const key of endpointKeys) {
    const prevEp = prev?.by_endpoint[key];
    const ep = mockEndpointMetrics(key, prevEp);
    byEndpoint[key] = ep;
    totalReqs += ep.total_requests;
    totalErrs += ep.total_errors;
    weightedLatency += ep.latency_p50_ms * ep.total_requests;
    maxP99 = Math.max(maxP99, ep.latency_p99_ms);
  }

  return {
    model,
    total_requests: totalReqs,
    total_errors: totalErrs,
    error_rate: totalReqs > 0 ? totalErrs / totalReqs : 0,
    latency_p50_ms: totalReqs > 0 ? Math.round(weightedLatency / totalReqs) : 0,
    latency_p99_ms: maxP99,
    by_endpoint: byEndpoint,
  };
}

function mockEndpointMetrics(
  key: string,
  prev?: EndpointMetrics
): EndpointMetrics {
  // Increment from previous values or start fresh.
  const baseReqs = prev?.total_requests ?? jitter(20, 80);
  const newReqs = baseReqs + jitter(1, 10);
  const baseErrs = prev?.total_errors ?? jitter(0, 3);
  const newErrs = baseErrs + (Math.random() < 0.15 ? 1 : 0);

  // Latency varies by endpoint name to make them distinguishable.
  const hash = simpleHash(key);
  const baseLatency = 80 + (hash % 300); // 80-380ms range
  const p50 = baseLatency + jitter(-20, 20);
  const p99 = p50 * (2.5 + Math.random());

  return {
    total_requests: newReqs,
    total_errors: newErrs,
    error_rate: newReqs > 0 ? newErrs / newReqs : 0,
    latency_p50_ms: Math.round(Math.max(10, p50)),
    latency_p99_ms: Math.round(Math.max(p50 + 50, p99)),
  };
}

function jitter(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}
