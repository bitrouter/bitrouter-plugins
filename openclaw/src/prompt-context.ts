/**
 * Prompt context injection — registers a `before_prompt_build` hook that
 * injects dynamic BitRouter state into the agent's context.
 *
 * Replaces the previous 9 registered tools with a lightweight context
 * injection (~150 tokens) that tells the LLM about BitRouter's current
 * state and points it to the `/bitrouter` skill and CLI for management.
 *
 * Uses two injection channels:
 *   - `appendSystemContext` — static CLI/skill reference (prompt-cache friendly)
 *   - `prependContext`      — dynamic per-turn state (health, routes, mode)
 */

import type {
  BitrouterPluginConfig,
  BitrouterState,
  OpenClawPluginApi,
  PluginHookAgentContext,
} from "./types.js";

// ── Hook event/result types (structural match to SDK) ────────────────

type BeforePromptBuildEvent = {
  prompt: string;
  messages?: unknown[];
};

type BeforePromptBuildResult = {
  prependContext?: string;
  appendSystemContext?: string;
};

// ── Static context (cacheable across turns) ──────────────────────────

const STATIC_CONTEXT = `BitRouter LLM proxy is available. For route management, status, key generation, or admin operations use the /bitrouter skill or the CLI:
  openclaw bitrouter status   — health, routes, daemon info
  openclaw bitrouter setup    — reconfigure provider/mode
  openclaw bitrouter wallet   — wallet/onboarding state`;

// ── Dynamic context builder ──────────────────────────────────────────

function buildDynamicContext(
  config: BitrouterPluginConfig,
  state: BitrouterState
): string {
  if (!state.healthy) {
    return "[BitRouter: unhealthy]";
  }

  const mode = config.mode ?? "unconfigured";
  const upstream =
    mode === "byok"
      ? `/${config.byok?.upstreamProvider ?? "unknown"}`
      : mode === "auto"
        ? ""
        : "";

  const routeCount = state.knownRoutes.length;
  const routeSummary =
    routeCount > 0
      ? state.knownRoutes.map((r) => `${r.model}→${r.provider}`).join(", ")
      : "none";

  return `[BitRouter: ${mode}${upstream}, healthy, ${routeCount} routes (${routeSummary})]`;
}

// ── Hook registration ────────────────────────────────────────────────

/**
 * Register the `before_prompt_build` hook that injects BitRouter context.
 *
 * The hook fires before every agent turn and injects:
 * - A static reference to the `/bitrouter` skill and CLI commands
 * - A dynamic one-liner with current health, mode, and route summary
 */
export function registerPromptContext(
  api: OpenClawPluginApi,
  config: BitrouterPluginConfig,
  state: BitrouterState
): void {
  api.on(
    "before_prompt_build",
    (
      _event: BeforePromptBuildEvent,
      _ctx: PluginHookAgentContext
    ): BeforePromptBuildResult => {
      return {
        appendSystemContext: STATIC_CONTEXT,
        prependContext: buildDynamicContext(config, state),
      };
    }
  );
}
