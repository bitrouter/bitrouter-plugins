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

// ── Hook registration ────────────────────────────────────────────────

/**
 * Register the before_model_resolve hook that redirects matching model
 * requests to the "bitrouter" provider.
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
