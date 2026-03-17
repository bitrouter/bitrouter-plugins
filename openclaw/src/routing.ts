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
  ModelInfo,
  OpenClawPluginApi,
  PluginHookBeforeModelResolveEvent,
  PluginHookBeforeModelResolveResult,
  PluginHookAgentContext,
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
      headers: state.apiToken
        ? { Authorization: `Bearer ${state.apiToken}` }
        : undefined,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      api.logger.warn(
        `Failed to fetch routes: ${res.status} ${res.statusText}`
      );
      return;
    }

    const body = (await res.json()) as { routes: RouteInfo[] };
    state.knownRoutes = body.routes;
    api.logger.info(
      `Loaded ${state.knownRoutes.length} route(s) from BitRouter`
    );
  } catch (err) {
    // Don't clear existing routes — they may still be valid.
    api.logger.warn(`Route refresh failed: ${err}`);
  }
}

// ── Model catalog refresh ────────────────────────────────────────────

/**
 * Fetch the model catalog from BitRouter's /v1/models endpoint.
 *
 * Returns OpenAI-compatible model objects, potentially enriched with
 * BitRouter-specific fields (context_window, max_tokens, reasoning, input).
 *
 * On failure, preserves the existing cache.
 */
export async function refreshModels(
  state: BitrouterState,
  api: OpenClawPluginApi
): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    const res = await fetch(`${state.baseUrl}/v1/models`, {
      signal: controller.signal,
      headers: state.apiToken
        ? { Authorization: `Bearer ${state.apiToken}` }
        : undefined,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      api.logger.warn(
        `Failed to fetch models: ${res.status} ${res.statusText}`
      );
      return;
    }

    const body = (await res.json()) as { data: ModelInfo[] };
    state.knownModels = body.data ?? [];
    api.logger.info(
      `Loaded ${state.knownModels.length} model(s) from BitRouter`
    );
  } catch (err) {
    // Don't clear existing models — they may still be valid.
    api.logger.warn(`Model catalog refresh failed: ${err}`);
  }
}

// ── Model name resolution ────────────────────────────────────────────

/**
 * Resolve the full model string (with provider prefix) for a given agent.
 *
 * Returns the raw value from OpenClaw config, e.g. "openai/gpt-4o".
 */
function resolveFullModelString(api: OpenClawPluginApi, agentId: string): string {
  const agentList = (api.config as {
    agents?: {
      list?: Array<{
        id: string;
        model?: { primary?: string } | string;
      }>;
      defaults?: { model?: { primary?: string } | string };
    };
  }).agents;

  const agentEntry = agentList?.list?.find((a) => a.id === agentId);
  const agentModel = agentEntry?.model;
  const defaultModel = agentList?.defaults?.model;

  const extract = (m: unknown): string | undefined => {
    if (typeof m === "string") return m;
    if (m && typeof m === "object" && "primary" in m) {
      return (m as { primary?: string }).primary;
    }
    return undefined;
  };

  return extract(agentModel) ?? extract(defaultModel) ?? "default";
}

/**
 * Resolve the model name for a given agent from the OpenClaw config.
 *
 * The before_model_resolve hook receives `{ prompt }` and `{ agentId }`,
 * not the model name directly. We look up the agent's configured primary
 * model in `api.config.agents` and strip the provider prefix.
 */
function resolveModelName(api: OpenClawPluginApi, agentId: string): string {
  const fullModel = resolveFullModelString(api, agentId);

  // Strip provider prefix (e.g. "openrouter/auto" → "auto")
  return fullModel.includes("/")
    ? fullModel.split("/").slice(1).join("/")
    : fullModel;
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
  // interceptAll logic:
  // - When interceptAllModels is true (or mode is "auto"), ALL model requests
  //   are redirected to the "bitrouter" provider.
  // - When interceptAllModels is false (default), only models with a known
  //   route in BitRouter's routing table are intercepted.
  // In both cases, the "bitrouter" provider in openclaw.json (baseUrl +
  // JWT credential) handles the actual HTTP request.
  const interceptAll = config.interceptAllModels ?? DEFAULTS.interceptAllModels;

  api.on(
    "before_model_resolve",
    (
      _event: PluginHookBeforeModelResolveEvent,
      ctx: PluginHookAgentContext
    ): PluginHookBeforeModelResolveResult | void => {
      // Don't intercept if BitRouter isn't healthy.
      if (!state.healthy) return;

      const modelName = resolveModelName(api, ctx.agentId ?? "main");
      if (interceptAll) {
        // In auto mode, preserve the provider prefix so BitRouter can
        // route to the correct upstream via its direct routing format
        // (e.g. "openai/gpt-4o" → "openai:gpt-4o").
        if (config.mode === "auto") {
          const fullModel = resolveFullModelString(api, ctx.agentId ?? "main");
          const directRoute = fullModel.includes("/")
            ? fullModel.replace("/", ":")
            : modelName;
          return { providerOverride: "bitrouter", modelOverride: directRoute };
        }

        // Non-auto interceptAll: use stripped model name.
        return { providerOverride: "bitrouter", modelOverride: modelName };
      }

      // Selective mode: only intercept models in BitRouter's routing table.
      const isKnownRoute = state.knownRoutes.some(
        (r) => r.model === modelName
      );

      if (isKnownRoute) {
        return { providerOverride: "bitrouter", modelOverride: modelName };
      }
      // Unknown models fall through to OpenClaw's native resolution.
    }
  );
}
