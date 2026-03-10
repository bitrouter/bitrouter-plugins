/**
 * Provider registration — registers "bitrouter" as an LLM provider in
 * OpenClaw, pointing to the local BitRouter instance.
 *
 * Credential strategy (Option D — env var passthrough with auth fallback):
 *
 * 1. By default, BitRouter auto-detects API keys from environment variables
 *    via its built-in env_prefix mechanism (OPENAI_API_KEY, ANTHROPIC_API_KEY,
 *    GOOGLE_API_KEY). If these are already set, no auth prompt is needed.
 *
 * 2. If no env vars are found, the plugin offers an auth flow that walks
 *    the user through entering their API keys. These get written to the
 *    BitRouter home directory's .env file.
 *
 * This means most users get zero-config setup (they already have env vars
 * from using OpenClaw with native providers), while users without env vars
 * get a guided setup experience.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type {
  BitrouterPluginConfig,
  BitrouterState,
  OpenClawPluginApi,
  ProviderAuthContext,
  ProviderAuthMethod,
} from "./types.js";

// ── Well-known env vars for built-in providers ───────────────────────

const PROVIDER_ENV_VARS: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
};

// ── Provider registration ────────────────────────────────────────────

/**
 * Register "bitrouter" as a provider in OpenClaw.
 *
 * The provider's baseUrl points to the local BitRouter instance. When
 * the before_model_resolve hook redirects a model to provider "bitrouter",
 * OpenClaw sends the HTTP request here.
 */
export function registerBitrouterProvider(
  api: OpenClawPluginApi,
  config: BitrouterPluginConfig,
  state: BitrouterState
): void {
  const needsAuth = !hasEnvVarKeys() && !hasConfigKeys(config);

  api.registerProvider({
    id: "bitrouter",
    label: "BitRouter",
    baseUrl: state.baseUrl,
    auth: needsAuth ? [buildAuthMethod(state)] : [],
  });
}

// ── Auth fallback ────────────────────────────────────────────────────

/**
 * Build an auth method that prompts for provider API keys.
 *
 * Only triggered when the user runs `openclaw models auth login --provider bitrouter`.
 * Collects keys for OpenAI, Anthropic, and Google, writes them to the
 * BitRouter home dir's .env file.
 */
function buildAuthMethod(state: BitrouterState): ProviderAuthMethod {
  return {
    id: "api_keys",
    label: "API Keys",
    kind: "api_key",
    run: async (ctx: ProviderAuthContext) => {
      const keys: Record<string, string> = {};

      // Prompt for each major provider. Empty responses are skipped.
      for (const [provider, envVar] of Object.entries(PROVIDER_ENV_VARS)) {
        const key = await ctx.prompter.prompt({
          message: `${provider} API key (${envVar}), or press Enter to skip:`,
          type: "password",
        });
        if (key.trim()) {
          keys[envVar] = key.trim();
        }
      }

      if (Object.keys(keys).length === 0) {
        throw new Error(
          "No API keys provided. At least one provider key is required."
        );
      }

      // Write keys to the BitRouter home dir's .env file.
      writeEnvKeys(state.homeDir, keys);

      return {
        profiles: [
          {
            profileId: "bitrouter:default",
            credential: {
              type: "api_key" as const,
              provider: "bitrouter",
              key: "managed-by-bitrouter",
            },
          },
        ],
      };
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Check if any well-known provider API keys are in the environment. */
function hasEnvVarKeys(): boolean {
  return Object.values(PROVIDER_ENV_VARS).some(
    (envVar) => !!process.env[envVar]
  );
}

/** Check if any API keys are explicitly set in the plugin config. */
function hasConfigKeys(config: BitrouterPluginConfig): boolean {
  if (!config.providers) return false;
  return Object.values(config.providers).some((p) => !!p.apiKey);
}

/**
 * Append or merge API keys into the .env file in the BitRouter home dir.
 * Does not overwrite existing non-empty values.
 */
function writeEnvKeys(
  homeDir: string,
  keys: Record<string, string>
): void {
  const envPath = path.join(homeDir, ".env");
  const existing = new Map<string, string>();

  // Parse existing .env if it exists.
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        existing.set(key, value);
      }
    }
  }

  // Merge: only set keys that are empty or missing.
  for (const [key, value] of Object.entries(keys)) {
    const current = existing.get(key);
    if (!current) {
      existing.set(key, value);
    }
  }

  // Write back.
  const header =
    "# BitRouter environment variables\n" +
    "# Generated by @bitrouter/openclaw-plugin — do not commit.\n\n";
  const lines = Array.from(existing.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(envPath, header + lines + "\n", "utf-8");
}
