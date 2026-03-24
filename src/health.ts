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
import { refreshRoutes, refreshModels, refreshAgents, refreshTools, refreshSkills } from "./routing.js";
import { detectProviders } from "./discovery.js";

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
      headers: state.apiToken
        ? { Authorization: `Bearer ${state.apiToken}` }
        : undefined,
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
  state: BitrouterState,
): void {
  let tickCount = 0;
  const interval =
    config.healthCheckIntervalMs ?? DEFAULTS.healthCheckIntervalMs;

  state.healthCheckTimer = setInterval(async () => {
    const wasHealthy = state.healthy;
    const isHealthy = await checkHealth(state);

    // Log state transitions.
    if (isHealthy && !wasHealthy) {
      api.logger.info("BitRouter is healthy");
      // Refresh routes, models, and new discovery endpoints on recovery.
      await refreshRoutes(state, api);
      await refreshModels(state, api);
      await refreshAgents(state, api);
      await refreshTools(state, api);
      await refreshSkills(state, api);
    } else if (!isHealthy && wasHealthy) {
      api.logger.warn("BitRouter health check failed");
    }

    state.healthy = isHealthy;

    // Periodically refresh routes even when continuously healthy,
    // in case the config was reloaded on the BitRouter side.
    tickCount++;
    if (isHealthy && tickCount % DEFAULTS.routeRefreshInterval === 0) {
      await refreshRoutes(state, api);
      await refreshModels(state, api);
      await refreshAgents(state, api);
      await refreshTools(state, api);
      await refreshSkills(state, api);

      // In auto mode, re-scan for provider changes at the same cadence.
      if (config.mode === "auto") {
        rescanProviders(api, state);
      }
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

// ── Auto-mode provider re-scan ───────────────────────────────────────

/**
 * Re-scan environment for provider changes in auto mode.
 * Logs additions/removals but does NOT hot-reload — the user must
 * restart the gateway to apply changes.
 */
function rescanProviders(api: OpenClawPluginApi, state: BitrouterState): void {
  const newDetected = detectProviders(api);
  const currentNames = new Set(
    state.autoDetectedProviders?.map((p) => p.name) ?? [],
  );
  const newNames = new Set(newDetected.map((p) => p.name));

  const added = newDetected.filter((p) => !currentNames.has(p.name));
  const removed = [...currentNames].filter((n) => !newNames.has(n));

  if (added.length === 0 && removed.length === 0) return;

  api.logger.info(
    `Provider change detected: ` +
      (added.length > 0 ? `+[${added.map((p) => p.name).join(", ")}] ` : "") +
      (removed.length > 0 ? `-[${removed.join(", ")}]` : ""),
  );
  api.logger.info(
    "Restart the gateway to apply provider changes: openclaw gateway restart",
  );
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
