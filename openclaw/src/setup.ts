/**
 * BitRouter first-run setup wizard.
 *
 * Runs inside the `openclaw models auth login --provider bitrouter` flow.
 * Two auth methods are registered on the provider:
 *
 *   byok  — Bring Your Own Key: interactive wizard that collects an
 *            upstream provider (OpenRouter, OpenAI, Anthropic, or custom)
 *            and an API key. Persists mode + byok config via configPatch.
 *
 *   cloud — BitRouter Cloud (stub; OAuth coming in next version). Shows a
 *            "coming soon" message and exits without making changes.
 *
 * On success, returns a ProviderAuthResult whose `configPatch` writes
 * `mode`, `byok`, and `interceptAllModels: true` into
 * `plugins.entries.bitrouter.config` in openclaw.json — no filesystem
 * hacks required.
 *
 * The API key is also written to the BitRouter home dir's .env file so
 * the service can inject it into bitrouter.yaml on startup.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type {
  ChainType,
  ProviderAuthContext,
  ProviderAuthResult,
  SetupMode,
} from "./types.js";
import { DEFAULTS } from "./types.js";
import { PROVIDER_API_BASES, toEnvVarKey, parseEnvFile, serializeEnvFile } from "./config.js";
import { ensureAuth } from "./auth.js";

// ── Well-known upstream providers ────────────────────────────────────

type UpstreamProviderId = "openrouter" | "openai" | "anthropic" | "other";

interface UpstreamProviderMeta {
  value: UpstreamProviderId;
  label: string;
  hint: string;
  apiBase?: string;
  keyPlaceholder: string;
  docsUrl?: string;
}

const UPSTREAM_PROVIDERS: UpstreamProviderMeta[] = [
  {
    value: "openrouter",
    label: "OpenRouter",
    hint: "Access 100+ models via a single key — recommended",
    apiBase: PROVIDER_API_BASES.openrouter,
    keyPlaceholder: "sk-or-...",
    docsUrl: "https://openrouter.ai/keys",
  },
  {
    value: "openai",
    label: "OpenAI",
    hint: "GPT-4o, o1, and other OpenAI models",
    apiBase: PROVIDER_API_BASES.openai,
    keyPlaceholder: "sk-...",
    docsUrl: "https://platform.openai.com/api-keys",
  },
  {
    value: "anthropic",
    label: "Anthropic",
    hint: "Claude 3.5, Claude 3 Opus, and others",
    apiBase: PROVIDER_API_BASES.anthropic,
    keyPlaceholder: "sk-ant-...",
    docsUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    value: "other",
    label: "Other / self-hosted",
    hint: "Any OpenAI-compatible API (Ollama, LM Studio, etc.)",
    keyPlaceholder: "",
  },
];

// ── BYOK wizard ──────────────────────────────────────────────────────

/**
 * Run the BYOK setup wizard.
 *
 * Registered as the "byok" ProviderAuthMethod on the "bitrouter" provider.
 * Called by: `openclaw models auth login --provider bitrouter --method byok`
 * or: `openclaw models auth login --provider bitrouter` (first choice).
 */
export async function byokWizard(
  ctx: ProviderAuthContext
): Promise<ProviderAuthResult> {
  const { prompter } = ctx;

  await prompter.intro("BitRouter — BYOK Setup");
  await prompter.note(
    "BitRouter proxies your LLM requests locally, adding failover,\n" +
      "load balancing, and metrics. Your API key is stored securely\n" +
      "in OpenClaw's credential store.",
    "Welcome"
  );

  // ── Step 1: Choose upstream provider ────────────────────────────

  const providerChoice = await prompter.select<UpstreamProviderId>({
    message: "Which LLM provider do you want BitRouter to route through?",
    options: UPSTREAM_PROVIDERS.map((p) => ({
      value: p.value,
      label: p.label,
      hint: p.hint,
    })),
    initialValue: "openrouter",
  });

  const providerMeta = UPSTREAM_PROVIDERS.find(
    (p) => p.value === providerChoice
  )!;

  // ── Step 2: API key ──────────────────────────────────────────────

  let apiBase: string | undefined;

  if (providerChoice === "other") {
    apiBase = await prompter.text({
      message: "API base URL (must be OpenAI-compatible):",
      placeholder: "http://localhost:11434/v1",
      validate: (v) => {
        if (!v.trim()) return "Base URL is required for custom providers.";
        try {
          new URL(v.trim());
        } catch {
          return "Enter a valid URL (e.g. http://localhost:11434/v1)";
        }
        return undefined;
      },
    });
  } else {
    apiBase = providerMeta.apiBase;
  }

  const keyHint =
    providerMeta.docsUrl
      ? `Get your key at ${providerMeta.docsUrl}`
      : "Paste your API key below.";

  await prompter.note(keyHint);

  const apiKey = await prompter.text({
    message: `${providerMeta.label} API key:`,
    placeholder:
      providerChoice !== "other" ? providerMeta.keyPlaceholder : "sk-...",
    validate: (v) => {
      if (!v.trim()) return "API key cannot be empty.";
      if (v.trim().length < 8) return "That doesn't look like a valid API key.";
      return undefined;
    },
  });

  // ── Step 3: Confirm ──────────────────────────────────────────────

  const confirmed = await prompter.confirm({
    message: `Route all agent requests through BitRouter → ${providerMeta.label}?`,
    initialValue: true,
  });

  if (!confirmed) {
    throw new Error("Setup cancelled.");
  }

  // ── Step 4: Chain identity ──────────────────────────────────────

  const chainChoice = await prompter.select<ChainType>({
    message: "Which wallet identity should BitRouter use for JWT auth?",
    options: [
      {
        value: "solana" as ChainType,
        label: "Solana (Ed25519)",
        hint: "Default — compatible with all BitRouter versions",
      },
      {
        value: "evm" as ChainType,
        label: "EVM / Base (secp256k1)",
        hint: "EIP-191 signing — new in BitRouter v0.7",
      },
    ],
    initialValue: "solana" as ChainType,
  });

  // ── Done ─────────────────────────────────────────────────────────

  // Write the API key to the BitRouter home dir's .env file so the service
  // can pick it up at startup without re-prompting.
  const homeDir = resolveSetupHomeDir(ctx);
  writeKeyToEnv(homeDir, providerChoice, apiKey.trim());

  // Generate keypair + JWTs for authenticating with local BitRouter.
  const { apiToken: jwt } = ensureAuth(homeDir, chainChoice);

  await prompter.outro(
    "BitRouter configured! Restart the gateway to activate routing:\n" +
      "  openclaw gateway restart"
  );

  // Build the config patch. This gets merged into openclaw.json by OpenClaw.
  //
  // Two things we patch:
  //
  // 1. plugins.entries.bitrouter.config — stores mode/byok settings so the
  //    plugin knows it's configured on next gateway start.
  //
  // 2. models.providers.bitrouter — registers "bitrouter" as a provider with
  //    baseUrl pointing to the local BitRouter instance. Combined with
  //    interceptAllModels: true, this routes all requests through BitRouter
  //    using providerOverride instead of URL redirect.
  const bitrouterApiBase = `http://${DEFAULTS.host}:${DEFAULTS.port}/v1`;

  const configPatch = {
    plugins: {
      entries: {
        bitrouter: {
          config: {
            mode: "byok" satisfies SetupMode,
            byok: {
              upstreamProvider: providerChoice,
              ...(apiBase ? { apiBase } : {}),
            },
            chain: chainChoice,
            interceptAllModels: true,
          },
        },
      },
    },
    // Register "bitrouter" as a provider pointing to the local instance.
    // All requests are routed via providerOverride: "bitrouter" in the
    // before_model_resolve hook (interceptAllModels: true).
    models: {
      mode: "merge" as const,
      providers: {
        bitrouter: {
          baseUrl: bitrouterApiBase,
          models: [],
        },
      },
    },
  };

  return {
    profiles: [
      {
        profileId: "bitrouter:default",
        credential: {
          type: "api_key" as const,
          provider: "bitrouter",
          key: jwt,
        },
      },
    ],
    configPatch,
    notes: [
      `Upstream provider: ${providerMeta.label}`,
      `BitRouter will intercept all model requests via providerOverride (127.0.0.1:8787/v1).`,
      "Restart the gateway to activate: openclaw gateway restart",
      "To change settings, run: openclaw models auth login --provider bitrouter",
    ],
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Resolve the BitRouter home directory from auth context.
 *
 * Uses ctx.stateDir when available (matches config.ts resolveHomeDir).
 * Falls back to ~/.openclaw/bitrouter for the common dev-install case.
 */
function resolveSetupHomeDir(ctx: ProviderAuthContext): string {
  // stateDir is set by OpenClaw's service runner and matches what
  // config.ts resolveHomeDir(api) produces via api.getDataDir().
  if (ctx.workspaceDir) {
    return path.join(ctx.workspaceDir, "bitrouter");
  }
  return path.join(os.homedir(), ".openclaw", "bitrouter");
}

/**
 * Write the API key to the BitRouter home dir's .env file.
 * The key name follows the pattern PROVIDER_API_KEY.
 */
function writeKeyToEnv(
  homeDir: string,
  provider: string,
  apiKey: string
): void {
  try {
    fs.mkdirSync(homeDir, { recursive: true });
    const envPath = path.join(homeDir, ".env");
    const envKey = toEnvVarKey(provider);

    // Read existing .env entries (if any) and merge.
    let entries = new Map<string, string>();
    try {
      entries = parseEnvFile(fs.readFileSync(envPath, "utf-8"));
    } catch {
      // File doesn't exist yet — start fresh.
    }

    entries.set(envKey, apiKey);
    fs.writeFileSync(envPath, serializeEnvFile(entries), "utf-8");
  } catch (err) {
    // Non-fatal — the service will fall back to env vars.
    console.warn(`[bitrouter] Warning: could not write .env file: ${err}`);
  }
}

// ── Cloud stub ───────────────────────────────────────────────────────

/**
 * Stub for the BitRouterAI Cloud auth flow.
 *
 * Shows a "coming soon" message and exits cleanly.
 * Will be replaced with OAuth in the next version.
 */
export async function cloudStub(
  ctx: ProviderAuthContext
): Promise<ProviderAuthResult> {
  const { prompter } = ctx;

  await prompter.intro("BitRouter Cloud");
  await prompter.note(
    "BitRouter Cloud authentication is coming in the next version.\n\n" +
      "In the meantime, use the BYOK option to route through your own\n" +
      "API key (OpenRouter, OpenAI, Anthropic, or any OpenAI-compatible API).\n\n" +
      "Run: openclaw models auth login --provider bitrouter --method byok",
    "Coming Soon"
  );
  await prompter.outro("No changes made.");

  // Return a no-op result — no profiles, no config patch.
  return {
    profiles: [],
    notes: [
      "BitRouter Cloud is not yet available. Use BYOK mode for now.",
      "Run: openclaw models auth login --provider bitrouter --method byok",
    ],
  };
}
