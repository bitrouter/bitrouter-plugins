/**
 * Provider registration — registers "bitrouter" as an LLM provider in
 * OpenClaw, pointing to the local BitRouter instance.
 *
 * Auth method:
 *
 *   byok  — Delegates to `bitrouter auth login` via the native CLI
 *            (system binary on PATH or plugin's bundled copy). The CLI
 *            handles provider selection, API key entry, and OAuth flows.
 *            A non-interactive path detects API keys from env vars for
 *            headless/CI environments.
 *
 * The wizard is triggered by:
 *   openclaw models auth login --provider bitrouter
 *
 * Provider features:
 *   - discovery: publishes BitRouter's routing table into the model catalog
 *   - envVars: declares well-known env vars for `openclaw plugins doctor`
 *   - formatApiKey: formats stored JWT credentials for API requests
 */

import type {
  BitrouterPluginConfig,
  BitrouterState,
  OpenClawPluginApi,
  ProviderAuthMethodNonInteractiveContext,
} from "./types.js";
import { DEFAULTS } from "./types.js";
import { byokWizard } from "./setup.js";
import { buildCatalogHandler } from "./discovery.js";
import { PROVIDER_API_BASES, toEnvVarKey } from "./config.js";
import { ensureAuthViaCli } from "./bitrouter-cli.js";
import { detectProviders } from "./discovery.js";
import { fetchMetrics, formatUsageText } from "./usage.js";

// ── Non-interactive auth ──────────────────────────────────────────────

/**
 * Non-interactive BYOK auth for headless/CI environments.
 *
 * Detects API keys from environment variables (OPENAI_API_KEY,
 * ANTHROPIC_API_KEY, OPENROUTER_API_KEY, etc.) and auto-configures
 * BitRouter without any interactive prompts.
 *
 * Returns an OpenClawConfig patch on success, or null if no keys found.
 */
async function byokNonInteractive(
  ctx: ProviderAuthMethodNonInteractiveContext,
  api: OpenClawPluginApi,
): Promise<Record<string, unknown> | null> {
  // Try to resolve a BitRouter-specific API key first (for pre-configured setups).
  const resolved = await ctx.resolveApiKey({
    provider: "bitrouter",
    flagName: "--bitrouter-api-key",
    flagValue: undefined,
    envVar: "BITROUTER_API_KEY",
    envVarName: "BITROUTER_API_KEY",
    allowProfile: true,
    required: false,
  });

  if (resolved) {
    // User has a dedicated BitRouter API key — use it directly.
    api.logger.info("BitRouter non-interactive auth: using BITROUTER_API_KEY");
    const bitrouterApiBase = `http://${DEFAULTS.host}:${DEFAULTS.port}/v1`;
    return {
      plugins: {
        entries: {
          bitrouter: {
            config: {
              mode: "byok",
            },
          },
        },
      },
      models: {
        mode: "merge",
        providers: {
          bitrouter: {
            baseUrl: bitrouterApiBase,
            models: [],
          },
        },
      },
    };
  }

  // No dedicated key — try auto-detecting upstream provider API keys.
  const detected = detectProviders(api);
  if (detected.length === 0) {
    api.logger.info(
      "BitRouter non-interactive auth: no API keys found in environment",
    );
    return null;
  }

  // Pick the first detected provider as the upstream for BYOK mode.
  // Prefer openrouter > anthropic > openai > others for best coverage.
  const preferred = ["openrouter", "anthropic", "openai"];
  const sorted = [...detected].sort((a, b) => {
    const ai = preferred.indexOf(a.name);
    const bi = preferred.indexOf(b.name);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
  const primary = sorted[0];

  api.logger.info(
    `BitRouter non-interactive auth: auto-configuring with ${primary.name} ` +
      `(${primary.envVarKey})`,
  );

  // Generate JWT for authenticating with local BitRouter.
  const homeDir = ctx.workspaceDir
    ? `${ctx.workspaceDir}/bitrouter`
    : `${process.env.HOME}/.openclaw/bitrouter`;

  const stateDir = ctx.workspaceDir
    ? `${ctx.workspaceDir}/plugins/bitrouter`
    : `${process.env.HOME}/.openclaw/plugins/bitrouter`;
  const { apiToken: jwt } = await ensureAuthViaCli(stateDir, homeDir);

  const bitrouterApiBase = `http://${DEFAULTS.host}:${DEFAULTS.port}/v1`;

  // If multiple providers detected, use auto mode instead of byok.
  if (detected.length > 1) {
    api.logger.info(
      `BitRouter non-interactive auth: ${detected.length} providers detected, using auto mode`,
    );
    return {
      plugins: {
        entries: {
          bitrouter: {
            config: {
              mode: "auto",
            },
          },
        },
      },
      models: {
        mode: "merge",
        providers: {
          bitrouter: {
            baseUrl: bitrouterApiBase,
            apiKey: jwt,
            models: [],
          },
        },
      },
    };
  }

  // Single provider — configure as BYOK.
  return {
    plugins: {
      entries: {
        bitrouter: {
          config: {
            mode: "byok",
            byok: {
              upstreamProvider: primary.name,
              ...(primary.apiBase ? { apiBase: primary.apiBase } : {}),
            },
          },
        },
      },
    },
    models: {
      mode: "merge",
      providers: {
        bitrouter: {
          baseUrl: bitrouterApiBase,
          apiKey: jwt,
          models: [],
        },
      },
    },
  };
}

// ── Provider registration ─────────────────────────────────────────────

/**
 * Register "bitrouter" as a provider in OpenClaw.
 *
 * Features:
 * - Auth methods: interactive BYOK wizard, cloud hint, and non-interactive BYOK
 * - Discovery: publishes BitRouter's route table into the model catalog
 * - envVars: declares well-known env vars for auth doctor integration
 * - formatApiKey: properly extracts JWT from stored credentials
 */
export function registerBitrouterProvider(
  api: OpenClawPluginApi,
  _config: BitrouterPluginConfig,
  state: BitrouterState,
): void {
  // Collect env var names for all well-known providers.
  const envVars = [
    "BITROUTER_API_KEY",
    ...Object.keys(PROVIDER_API_BASES).map(toEnvVarKey),
  ];

  api.registerProvider({
    id: "bitrouter",
    label: "BitRouter",

    // Declare env vars so `openclaw plugins doctor` can check them.
    envVars,

    auth: [
      {
        id: "byok",
        label: "Set up BitRouter provider authentication",
        hint: "Runs `bitrouter auth login` to configure providers (API keys, OAuth, etc.)",
        kind: "api_key" as const,
        run: byokWizard,

        // Non-interactive auth for CI/headless environments.
        // Detects API keys from environment variables and auto-configures.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runNonInteractive: (ctx: any) =>
          byokNonInteractive(
            ctx as ProviderAuthMethodNonInteractiveContext,
            api,
          ),
      },
    ],

    // Catalog: publish BitRouter's routes as model catalog entries.
    // Runs during gateway startup and model catalog refresh.
    // Uses ctx.resolveProviderApiKey for auto-detection when BitRouter isn't healthy.
    catalog: {
      order: "late" as const,
      run: buildCatalogHandler(state, api),
    },

    // Accept any model ID that BitRouter has a route for.
    // This is the canonical proxy/router provider pattern.
    resolveDynamicModel: (ctx) => {
      if (!state.healthy) return null;

      const modelId = ctx.modelId;
      const isKnown = state.knownRoutes.some((r) => r.model === modelId);
      if (!isKnown) return null;

      const knownModel = state.knownModels.find((m) => m.id === modelId);

      return {
        id: modelId,
        name: `${modelId} (via BitRouter)`,
        provider: "bitrouter",
        api: "openai-completions",
        baseUrl: `${state.baseUrl}/v1`,
        reasoning: knownModel?.reasoning ?? false,
        input: (knownModel?.input ?? ["text"]) as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: knownModel?.context_window ?? 128_000,
        maxTokens: knownModel?.max_tokens ?? 16_384,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
    },

    // Exchange stored credentials into a runtime JWT before inference.
    prepareRuntimeAuth: async () => {
      const token = state.apiToken;
      if (!token) return null;
      return {
        apiKey: token,
        baseUrl: `${state.baseUrl}/v1`,
      };
    },

    // Fallback credential formatter for direct auth profile access.
    formatApiKey: (cred) => {
      if (cred && "type" in cred && cred.type === "api_key" && "key" in cred) {
        return (cred as { key: string }).key;
      }
      return state.apiToken ?? "";
    },

    // ── Usage & spend tracking ─────────────────────────────────────

    // Resolve auth for usage endpoints — use the local JWT token.
    resolveUsageAuth: async () => {
      const token = state.apiToken;
      if (!token) return null;
      return { token };
    },

    // Fetch usage/spend snapshot from BitRouter's /v1/metrics endpoint.
    fetchUsageSnapshot: async () => {
      const metrics = await fetchMetrics(state);
      if (!metrics) return null;

      const text = formatUsageText(metrics);
      const totalRequests = Object.values(metrics.routes).reduce(
        (sum, r) => sum + r.total_requests,
        0,
      );

      // Return a provider-compatible snapshot shape.
      // Since "bitrouter" isn't in the core UsageProviderId union,
      // we return the data through the generic provider surface.
      return {
        provider: "bitrouter",
        displayName: "BitRouter",
        windows: [
          {
            label: `${totalRequests} requests across ${Object.keys(metrics.routes).length} routes`,
            usedPercent: 0,
          },
        ],
        plan: text,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
    },

    // ── Auth guidance ──────────────────────────────────────────────

    // Custom missing-auth message for BitRouter.
    buildMissingAuthMessage: () => {
      return (
        "BitRouter is not authenticated. Run one of:\n" +
        "  openclaw bitrouter setup        — interactive onboarding wizard\n" +
        "  openclaw models auth login --provider bitrouter  — configure auth\n" +
        "  export BITROUTER_API_KEY=...    — set API key directly"
      );
    },
  });
}
