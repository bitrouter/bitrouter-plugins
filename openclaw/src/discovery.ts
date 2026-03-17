/**
 * Provider discovery — detects available providers and publishes BitRouter's
 * model catalog as OpenClaw model definitions.
 *
 * Detection priority (single source of truth):
 *   1. ctx.resolveApiKey (via OpenClaw's discovery system) — preferred path,
 *      uses the platform's full key resolution (env vars, profiles, CLI flags).
 *      Results are cached in state.autoDetectedProviders for other consumers.
 *   2. detectProviders(api) — simple env var fallback when discovery context
 *      is unavailable (e.g. service.start runs before discovery).
 *
 * Catalog priority (highest → lowest):
 *   1. state.knownModels (from GET /v1/models) — BitRouter is the source
 *      of truth for model capabilities (context window, vision, reasoning).
 *   2. state.knownRoutes (from GET /v1/routes) — fallback when /v1/models
 *      hasn't been fetched yet. Uses protocol-level defaults.
 *   3. Auto-detected providers — placeholder catalog entries so models are
 *      visible in `openclaw models list` before the daemon starts.
 */

import type {
  BitrouterState,
  ModelInfo,
  OpenClawPluginApi,
  ProviderEntry,
  RouteInfo,
} from "./types.js";
import { PROVIDER_API_BASES, toEnvVarKey } from "./config.js";

// ── Types ────────────────────────────────────────────────────────────

/**
 * Minimal shape of ProviderDiscoveryContext — only the fields we need.
 * Avoids coupling to the SDK's internal types.
 */
export interface DiscoveryCtxLike {
  resolveApiKey: (params: {
    provider: string;
    flagName: `--${string}`;
    flagValue?: string;
    envVar: string;
    envVarName?: string;
    allowProfile?: boolean;
    required?: boolean;
  }) => Promise<{ key: string; source: string; envVarName?: string } | null>;
}

/** A provider discovered via API key resolution. */
export interface DetectedProvider {
  /** Provider name (e.g. "openai", "anthropic"). */
  name: string;
  /** The env var that held the key (e.g. "OPENAI_API_KEY"). */
  envVarKey: string;
  /** The raw API key value from the environment. */
  apiKey: string;
  /** Canonical API base URL, if known. */
  apiBase?: string;
}

// ── Protocol-level defaults ──────────────────────────────────────────

const PROTOCOL_DEFAULTS: Record<string, { contextWindow: number; maxTokens: number }> = {
  openai: { contextWindow: 128_000, maxTokens: 16_384 },
  anthropic: { contextWindow: 200_000, maxTokens: 8_192 },
  google: { contextWindow: 128_000, maxTokens: 8_192 },
};

/** Map provider name → most likely API protocol for defaults. */
const PROVIDER_PROTOCOL: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  openrouter: "openai",
};

/** Default model IDs per well-known provider for "auto" routes. */
const AUTO_MODEL_IDS: Record<string, string> = {
  openrouter: "anthropic/claude-3-haiku",
  openai: "gpt-4o",
  anthropic: "claude-3-5-haiku-20241022",
};

// ── Provider detection ───────────────────────────────────────────────

/**
 * Detect providers using the ProviderDiscoveryContext's resolveApiKey helper.
 *
 * This is the preferred detection path — it participates in OpenClaw's
 * standard discovery flow and uses the platform's key resolution (env vars,
 * profiles, flags) rather than raw process.env reads.
 *
 * Results are cached in state.autoDetectedProviders so other consumers
 * (service, health, provider) can use them without re-scanning.
 */
async function detectProvidersFromCtx(
  ctx: DiscoveryCtxLike,
  api?: OpenClawPluginApi
): Promise<DetectedProvider[]> {
  const candidates = new Set<string>(Object.keys(PROVIDER_API_BASES));

  if (api) {
    const openclawProviders = (api.config as {
      models?: { providers?: Record<string, unknown> };
    }).models?.providers;
    if (openclawProviders) {
      for (const name of Object.keys(openclawProviders)) {
        candidates.add(name);
      }
    }
  }

  const detected: DetectedProvider[] = [];

  for (const name of candidates) {
    const envVarKey = toEnvVarKey(name);

    const resolved = await ctx.resolveApiKey({
      provider: name,
      flagName: `--${name}-api-key` as `--${string}`,
      flagValue: undefined,
      envVar: envVarKey,
      envVarName: envVarKey,
      allowProfile: true,
      required: false,
    });

    if (!resolved) continue;

    detected.push({
      name,
      envVarKey: resolved.envVarName ?? envVarKey,
      apiKey: resolved.key,
      apiBase: PROVIDER_API_BASES[name],
    });
  }

  detected.sort((a, b) => a.name.localeCompare(b.name));
  return detected;
}

/**
 * Simple env var fallback — scans process.env for provider API keys.
 *
 * Used when the discovery context (ctx.resolveApiKey) is unavailable,
 * e.g. when service.start runs before discovery, or in health rescans.
 */
export function detectProviders(api: OpenClawPluginApi): DetectedProvider[] {
  const candidates = new Set<string>();

  const openclawProviders = (api.config as {
    models?: { providers?: Record<string, unknown> };
  }).models?.providers;

  if (openclawProviders) {
    for (const name of Object.keys(openclawProviders)) {
      candidates.add(name);
    }
  }

  for (const name of Object.keys(PROVIDER_API_BASES)) {
    candidates.add(name);
  }

  const detected: DetectedProvider[] = [];

  for (const name of candidates) {
    const envVarKey = toEnvVarKey(name);
    const apiKey = process.env[envVarKey]?.trim();

    if (!apiKey) continue;

    detected.push({
      name,
      envVarKey,
      apiKey,
      apiBase: PROVIDER_API_BASES[name],
    });
  }

  detected.sort((a, b) => a.name.localeCompare(b.name));
  return detected;
}

// ── Model → catalog entry mapping ────────────────────────────────────

/** Convert a BitRouter ModelInfo (from /v1/models) into a catalog entry. */
function modelInfoToModelDef(model: ModelInfo): Record<string, unknown> {
  return {
    id: model.id,
    name: `${model.id} (via BitRouter${model.owned_by ? ` → ${model.owned_by}` : ""})`,
    reasoning: model.reasoning ?? false,
    input: model.input ?? ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.context_window ?? 128_000,
    maxTokens: model.max_tokens ?? 16_384,
  };
}

/** Convert a BitRouter RouteInfo (from /v1/routes) into a catalog entry. */
function routeToModelDef(route: RouteInfo): Record<string, unknown> {
  const defaults = PROTOCOL_DEFAULTS[route.protocol] ?? PROTOCOL_DEFAULTS.openai;
  return {
    id: route.model,
    name: `${route.model} (via BitRouter → ${route.provider})`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: defaults.contextWindow,
    maxTokens: defaults.maxTokens,
  };
}

/** Build a placeholder catalog entry for an auto-detected provider. */
function detectedProviderToModelDef(name: string): Record<string, unknown> {
  const protocol = PROVIDER_PROTOCOL[name] ?? "openai";
  const defaults = PROTOCOL_DEFAULTS[protocol] ?? PROTOCOL_DEFAULTS.openai;
  return {
    id: `${name}/auto`,
    name: `${name}/auto (via BitRouter → ${name})`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: defaults.contextWindow,
    maxTokens: defaults.maxTokens,
  };
}

// ── Discovery handler ────────────────────────────────────────────────

/**
 * Build the discovery handler for the "bitrouter" provider.
 *
 * Returns a function that, when called by OpenClaw's discovery system:
 *
 * 1. If BitRouter is healthy — returns its full model catalog from
 *    /v1/models or /v1/routes (rich metadata, real capabilities).
 *
 * 2. If BitRouter is not healthy — falls back to auto-detection via
 *    ctx.resolveApiKey, discovers providers through OpenClaw's standard
 *    key resolution, and returns placeholder catalog entries. Also
 *    populates state.autoDetectedProviders so the service can use them
 *    for YAML config generation.
 *
 * 3. If nothing is found — returns null (no models to add).
 */
export function buildDiscoveryHandler(
  state: BitrouterState,
  api?: OpenClawPluginApi
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): (ctx: any) => Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (ctx: any) => {
    // ── Path 1: BitRouter is healthy — use live data ──────────────
    if (state.healthy) {
      let models: Record<string, unknown>[];
      if (state.knownModels.length > 0) {
        models = state.knownModels.map(modelInfoToModelDef);
      } else if (state.knownRoutes.length > 0) {
        models = state.knownRoutes.map(routeToModelDef);
      } else {
        models = [];
      }

      if (models.length > 0) {
        return {
          provider: {
            baseUrl: `${state.baseUrl}/v1`,
            models: dedup(models),
          },
        };
      }
    }

    // ── Path 2: Auto-detect via ctx.resolveApiKey ─────────────────
    if (!ctx?.resolveApiKey) {
      return null;
    }

    try {
      const detected = await detectProvidersFromCtx(
        ctx as DiscoveryCtxLike,
        api
      );

      if (detected.length === 0) {
        return null;
      }

      // Cache so service.ts / health.ts can reuse without re-scanning.
      state.autoDetectedProviders = detected;

      if (api) {
        api.logger.info(
          `Discovery auto-detected ${detected.length} provider(s): ` +
            detected.map((p) => p.name).join(", ")
        );
      }

      const models = detected.map((p) => detectedProviderToModelDef(p.name));

      return {
        provider: {
          baseUrl: `${state.baseUrl}/v1`,
          models: dedup(models),
        },
      };
    } catch {
      // Discovery is best-effort — safe to skip on failure.
      return null;
    }
  };
}

// ── Auto-provider config building ────────────────────────────────────

/**
 * Build provider entries and model routes from detected providers.
 *
 * Returns the providers and models maps that can be merged into a
 * BitrouterPluginConfig for YAML generation.
 */
export function buildAutoProviderConfig(detected: DetectedProvider[]): {
  providers: Record<string, ProviderEntry>;
  models: Record<string, { strategy: "priority"; endpoints: Array<{ provider: string; modelId: string }> }>;
} {
  const providers: Record<string, ProviderEntry> = {};
  const models: Record<string, { strategy: "priority"; endpoints: Array<{ provider: string; modelId: string }> }> = {};

  for (const dp of detected) {
    providers[dp.name] = {
      apiKey: dp.apiKey,
      ...(dp.apiBase ? { apiBase: dp.apiBase } : {}),
      ...(dp.name === "openai" ? {} : { derives: "openai" }),
    };

    const defaultModelId = AUTO_MODEL_IDS[dp.name] ?? "auto";
    const virtualNames = ["auto", "default", `${dp.name}/auto`];

    for (const vn of virtualNames) {
      if (!models[vn]) {
        models[vn] = {
          strategy: "priority",
          endpoints: [{ provider: dp.name, modelId: defaultModelId }],
        };
      }
    }
  }

  if (detected.length > 1) {
    models["auto"] = {
      strategy: "priority",
      endpoints: detected.map((dp) => ({
        provider: dp.name,
        modelId: AUTO_MODEL_IDS[dp.name] ?? "auto",
      })),
    };
  }

  return { providers, models };
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Deduplicate catalog entries by model id (first entry wins). */
function dedup(models: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  return models.filter((m) => {
    const id = m.id as string;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
