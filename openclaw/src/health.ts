/**
 * Health check loop — periodically polls BitRouter's /health endpoint
 * and keeps state.healthy up to date.
 *
 * Also triggers route table refreshes at a slower cadence so the
 * interception set in routing.ts stays current.
 */

import type {
  BitrouterPluginConfig,
  BitrouterState,
  HealthStatus,
  OpenClawPluginApi,
} from "./types.js";
import { DEFAULTS } from "./types.js";
import { refreshRoutes } from "./routing.js";
import { refreshMetrics } from "./metrics.js";

// ── Single health check ──────────────────────────────────────────────

/**
 * Check if BitRouter is alive by hitting GET /health.
 * Returns true if the response is 200 with {"status":"ok"}.
 * Never throws — returns false on any error.
 */
export async function checkHealth(state: BitrouterState): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    const res = await fetch(`${state.baseUrl}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return false;

    const body = (await res.json()) as HealthStatus;
    return body.status === "ok";
  } catch {
    return false;
  }
}

// ── Periodic health check loop ───────────────────────────────────────

/**
 * Start the health check interval. Updates state.healthy and
 * periodically refreshes the routing table.
 */
export function startHealthCheck(
  api: OpenClawPluginApi,
  config: BitrouterPluginConfig,
  state: BitrouterState
): void {
  let tickCount = 0;
  const interval = config.healthCheckIntervalMs ?? DEFAULTS.healthCheckIntervalMs;

  state.healthCheckTimer = setInterval(async () => {
    const wasHealthy = state.healthy;
    const isHealthy = await checkHealth(state);

    // Log state transitions.
    if (isHealthy && !wasHealthy) {
      api.log.info("BitRouter is healthy");
      // Refresh routes immediately on recovery.
      await refreshRoutes(state, api);
    } else if (!isHealthy && wasHealthy) {
      api.log.warn("BitRouter health check failed");
    }

    state.healthy = isHealthy;

    // Refresh metrics on every healthy tick (lightweight).
    if (isHealthy) {
      await refreshMetrics(state, api, config);
    }

    // Periodically refresh routes even when continuously healthy,
    // in case the config was reloaded on the BitRouter side.
    tickCount++;
    if (isHealthy && tickCount % DEFAULTS.routeRefreshInterval === 0) {
      await refreshRoutes(state, api);
    }
  }, interval);
}

/** Stop the health check interval and clean up. */
export function stopHealthCheck(state: BitrouterState): void {
  if (state.healthCheckTimer) {
    clearInterval(state.healthCheckTimer);
    state.healthCheckTimer = null;
  }
}

// ── Startup readiness poll ───────────────────────────────────────────

/**
 * Wait for BitRouter to become healthy after spawning.
 *
 * Uses exponential backoff starting at startupPollMs, up to a max of
 * startupTimeoutMs total. Resolves true if healthy, false if timed out.
 */
export async function waitForReady(state: BitrouterState): Promise<boolean> {
  const deadline = Date.now() + DEFAULTS.startupTimeoutMs;
  let delay: number = DEFAULTS.startupPollMs;

  while (Date.now() < deadline) {
    if (await checkHealth(state)) return true;
    await sleep(delay);
    delay = Math.min(delay * 1.5, 2_000);
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
