/**
 * Service lifecycle — manages the BitRouter daemon as a child process.
 *
 * Registers a service with OpenClaw's plugin API so BitRouter starts
 * automatically when OpenClaw starts and stops when OpenClaw stops.
 *
 * The service:
 * 1. Generates bitrouter.yaml from plugin config (via config.ts)
 * 2. Resolves the bitrouter binary (auto-downloads from GitHub releases if needed)
 * 3. Spawns `bitrouter --home-dir <dir> serve` as a child process
 * 4. Waits for the health endpoint to respond
 * 5. Starts the periodic health check loop
 *
 * On stop, sends SIGTERM → waits up to 10s → SIGKILL as fallback.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type {
  BitrouterPluginConfig,
  BitrouterState,
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
} from "./types.js";
import { DEFAULTS } from "./types.js";
import {
  writeConfigToDir,
  resolveHomeDir,
  PROVIDER_API_BASES,
  toEnvVarKey,
  parseEnvFile,
} from "./config.js";
import { ensureAuth } from "./auth.js";
import { startHealthCheck, stopHealthCheck, waitForReady } from "./health.js";
import { refreshRoutes } from "./routing.js";
import { resolveBinaryPath } from "./binary.js";
import { buildAutoProviderConfig, type DetectedProvider } from "./discovery.js";
import { loadOnboardingState } from "./onboarding.js";

// ── Service registration ─────────────────────────────────────────────

/**
 * Register the BitRouter daemon as an OpenClaw managed service.
 */
export function registerBitrouterService(
  api: OpenClawPluginApi,
  config: BitrouterPluginConfig,
  state: BitrouterState,
  stateDirRef: { value: string },
): void {
  api.registerService({
    id: "bitrouter",

    start: async (ctx: OpenClawPluginServiceContext) => {
      // Capture stateDir from service context — authoritative source.
      stateDirRef.value = ctx.stateDir;

      // 1. Resolve home directory and write config files.
      state.homeDir = resolveHomeDir(ctx.stateDir);

      // Synthesize provider entries from stored credentials (BYOK) or
      // auto-detected env vars (auto mode).
      //
      // In auto mode, state.autoDetectedProviders may already be populated
      // by discovery.run(ctx) if discovery ran before service.start().
      // If not, fall back to a direct env scan so we can still build config.
      let autoDetected = state.autoDetectedProviders;
      if (
        config.mode === "auto" &&
        (!autoDetected || autoDetected.length === 0)
      ) {
        const { detectProviders } = await import("./discovery.js");
        autoDetected = detectProviders(api);
        state.autoDetectedProviders = autoDetected;
      }

      const effectiveConfig = buildEffectiveConfig(
        config,
        state.homeDir,
        autoDetected,
      );

      writeConfigToDir(effectiveConfig, state.homeDir);
      api.logger.info(`Config written to ${state.homeDir}`);

      // Load onboarding state from onboarding.json (written by Rust CLI).
      state.onboardingState = loadOnboardingState(state.homeDir);

      // Generate/load keypair and mint JWTs for authenticating with
      // the local BitRouter instance (API + admin scopes).
      try {
        const tokens = ensureAuth(state.homeDir, config.chain);
        state.apiToken = tokens.apiToken;
        state.adminToken = tokens.adminToken;
        api.logger.info(`Auth keypair ready (${config.chain ?? "solana"})`);
      } catch (err) {
        api.logger.warn(`Failed to generate auth tokens: ${err}`);
      }

      // 2. Find the binary (downloads from GitHub releases if not cached).
      let binaryPath: string;
      try {
        binaryPath = await resolveBinaryPath(ctx.stateDir);
      } catch (err) {
        api.logger.error(`${err}`);
        throw err;
      }
      api.logger.info(`Using binary: ${binaryPath}`);

      // 3. Spawn the process.
      //
      // Key: detached is false — the plugin owns the process lifecycle.
      // If OpenClaw stops, the child process is cleaned up via stop().
      //
      // The --home-dir flag ensures BitRouter reads our generated config
      // rather than any user-level ~/.bitrouter config.
      const child = spawn(binaryPath, ["--home-dir", state.homeDir, "serve"], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });

      state.process = child;

      // Pipe stdout/stderr to the plugin logger.
      child.stdout?.on("data", (data: Buffer) => {
        const line = data.toString().trim();
        if (line) api.logger.info(`[bitrouter] ${line}`);
      });

      child.stderr?.on("data", (data: Buffer) => {
        const line = data.toString().trim();
        if (line) api.logger.warn(`[bitrouter] ${line}`);
      });

      // Handle unexpected exits.
      child.on("exit", (code, signal) => {
        state.process = null;
        state.healthy = false;
        stopHealthCheck(state);

        if (code !== null && code !== 0) {
          api.logger.error(
            `BitRouter exited with code ${code}` +
              (signal ? ` (signal: ${signal})` : ""),
          );
        }
      });

      // 4. Wait for readiness.
      const ready = await waitForReady(state);
      if (!ready) {
        // Process may have crashed — check if still alive.
        if (state.process === null) {
          throw new Error(
            "BitRouter process exited before becoming healthy. " +
              `Check logs in ${state.homeDir}/logs/`,
          );
        }
        api.logger.warn(
          "BitRouter did not become healthy within timeout — " +
            "continuing with health checks",
        );
      } else {
        state.healthy = true;
        api.logger.info("BitRouter is ready");

        // Load the initial routing table and metrics.
        await refreshRoutes(state, api);
      }

      // 5. Start periodic health checks.
      startHealthCheck(api, config, state);
    },

    stop: async (_ctx: OpenClawPluginServiceContext) => {
      // Stop health checks first.
      stopHealthCheck(state);

      const child = state.process;
      if (!child) return;

      // Send SIGTERM for graceful shutdown.
      child.kill("SIGTERM");

      // Wait for the process to exit.
      const exited = await waitForExit(child, DEFAULTS.stopTimeoutMs);

      if (!exited) {
        // Escalate to SIGKILL.
        api.logger.warn("BitRouter did not exit gracefully — sending SIGKILL");
        child.kill("SIGKILL");
        await waitForExit(child, 3_000);
      }

      state.process = null;
      state.healthy = false;
      api.logger.info("BitRouter stopped");
    },
  });
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Build an effective plugin config for BYOK mode.
 *
 * When mode is "byok", we read the stored API key from the BitRouter home
 * dir's .env file (written by setup.ts) and synthesize a provider entry
 * for the upstream provider chosen during setup.
 *
 * For other modes or when no BYOK credential is found, returns config as-is.
 */
function buildEffectiveConfig(
  config: BitrouterPluginConfig,
  homeDir: string,
  autoDetected?: DetectedProvider[],
): BitrouterPluginConfig {
  // ── Cloud mode: delegate to Rust binary with solanaRpcUrl ──
  if (config.mode === "cloud") {
    const solanaRpcUrl = config.solanaRpcUrl ?? config.cloud?.solanaRpcUrl;
    return {
      ...config,
      ...(solanaRpcUrl ? { solanaRpcUrl } : {}),
      guardrails: config.guardrails ?? {
        enabled: true,
        upgoing: {
          private_keys: "redact",
          credentials: "warn",
          api_keys: "warn",
        },
        downgoing: { suspicious_commands: "warn" },
      },
    };
  }

  // ── Default guardrails when not explicitly configured ──
  if (!config.guardrails) {
    config = {
      ...config,
      guardrails: {
        enabled: true,
        upgoing: {
          private_keys: "redact",
          credentials: "warn",
          api_keys: "warn",
        },
        downgoing: { suspicious_commands: "warn" },
      },
    };
  }

  // ── Auto mode: multi-provider config from env var scan ──
  if (config.mode === "auto" && autoDetected && autoDetected.length > 0) {
    const { providers, models } = buildAutoProviderConfig(autoDetected);
    return {
      ...config,
      providers: { ...config.providers, ...providers },
      models: { ...config.models, ...models },
    };
  }

  if (config.mode !== "byok" || !config.byok?.upstreamProvider) {
    return config;
  }

  const { upstreamProvider, apiBase } = config.byok;

  // Read the API key from the .env file written by the wizard.
  const envPath = path.join(homeDir, ".env");
  let apiKey: string | undefined;

  try {
    const entries = parseEnvFile(fs.readFileSync(envPath, "utf-8"));
    const expectedKey = toEnvVarKey(upstreamProvider);
    apiKey = entries.get(expectedKey) || undefined;
  } catch {
    // .env file doesn't exist — fall through to env-var detection.
  }

  // Default model routes: map well-known virtual model names to the upstream
  // provider. This lets BitRouter resolve requests without a DB, covering
  // the common models OpenClaw sends (auto, latest, etc.).
  const defaultModelRoutes = buildDefaultModelRoutes(upstreamProvider);

  if (!apiKey) {
    // No key in .env — BitRouter will pick it up from env vars if set
    // (e.g. OPENROUTER_API_KEY in the shell environment).
    return {
      ...config,
      providers: {
        ...config.providers,
        [upstreamProvider]: {
          ...(apiBase ? { apiBase } : resolveProviderApiBase(upstreamProvider)),
          ...(upstreamProvider === "openai" ? {} : { derives: "openai" }),
        },
      },
      models: { ...config.models, ...defaultModelRoutes },
    };
  }

  // Build a synthesized provider entry with the stored API key.
  // If the user supplied an apiBase via config.byok.apiBase, use that.
  // Otherwise fall back to the canonical base URL for well-known providers.
  return {
    ...config,
    providers: {
      ...config.providers,
      [upstreamProvider]: {
        apiKey,
        ...(apiBase ? { apiBase } : resolveProviderApiBase(upstreamProvider)),
        ...(upstreamProvider === "openai" ? {} : { derives: "openai" }),
      },
    },
    models: { ...config.models, ...defaultModelRoutes },
  };
}

/**
 * Return the canonical OpenAI-compatible base URL for well-known providers.
 * BitRouter's `derives: openai` only inherits the auth scheme, not the URL;
 * we must supply `api_base` explicitly for non-OpenAI providers.
 */
function resolveProviderApiBase(
  provider: string,
): { apiBase: string } | Record<string, never> {
  // OpenAI uses the default baked into BitRouter — no override needed.
  if (provider === "openai") return {};
  return provider in PROVIDER_API_BASES
    ? { apiBase: PROVIDER_API_BASES[provider] }
    : {};
}

/**
 * Build default model→provider routes for BYOK mode.
 *
 * Maps common virtual model names to the chosen upstream provider so
 * BitRouter can resolve requests without a persistent DB. OpenClaw
 * sends model names like "auto", "openrouter/auto" etc.; we normalise
 * them here. The provider:modelId pairs are passed-through as-is
 * (e.g. OpenRouter accepts "auto" as a valid model identifier).
 */
function buildDefaultModelRoutes(
  upstreamProvider: string,
): Record<
  string,
  {
    strategy: "priority";
    endpoints: Array<{ provider: string; modelId: string }>;
  }
> {
  // Virtual names that map to the provider's default model.
  //
  // For OpenRouter, avoid "auto" — it currently resolves to reasoning models
  // (gpt-5-nano etc.) that return content:null, which BitRouter v0.4.0 cannot
  // parse. Use a stable non-reasoning model instead.
  // For other providers, use a sensible default.
  const autoModelIds: Record<string, string> = {
    openrouter: "anthropic/claude-3-haiku",
    openai: "gpt-4o",
    anthropic: "claude-3-5-haiku-20241022",
    other: "default",
  };

  const autoModelId = autoModelIds[upstreamProvider] ?? "auto";

  // Cover the common names OpenClaw might send:
  const virtualNames = ["auto", "default", `${upstreamProvider}/auto`];

  const routes: Record<
    string,
    {
      strategy: "priority";
      endpoints: Array<{ provider: string; modelId: string }>;
    }
  > = {};
  for (const name of virtualNames) {
    routes[name] = {
      strategy: "priority",
      endpoints: [{ provider: upstreamProvider, modelId: autoModelId }],
    };
  }
  return routes;
}

/** Wait for a child process to emit the 'exit' event. */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(false);
      }
    }, timeoutMs);

    child.on("exit", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
}
