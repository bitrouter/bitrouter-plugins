/**
 * Shared types for the BitRouter OpenClaw plugin.
 *
 * These types bridge three worlds:
 * 1. OpenClaw's plugin API (what we register with)
 * 2. BitRouter's YAML config format (what we generate)
 * 3. BitRouter's HTTP API (what we query at runtime)
 */

import type { ChildProcess } from "node:child_process";

// ── Plugin configuration (from openclaw.plugin.json configSchema) ────

/** Root plugin config — matches the configSchema in openclaw.plugin.json. */
export interface BitrouterPluginConfig {
  port?: number;
  host?: string;
  autoStart?: boolean;
  healthCheckIntervalMs?: number;
  interceptAllModels?: boolean;
  providers?: Record<string, ProviderEntry>;
  models?: Record<string, ModelEntry>;
}

/** A single provider entry in the plugin config (camelCase, TS-side). */
export interface ProviderEntry {
  apiKey?: string;
  apiBase?: string;
  envPrefix?: string;
  derives?: string;
}

/** A virtual model routing definition. */
export interface ModelEntry {
  strategy?: "priority" | "load_balance";
  endpoints: EndpointEntry[];
}

/** A single endpoint within a model route. */
export interface EndpointEntry {
  provider: string;
  modelId: string;
  apiKey?: string;
  apiBase?: string;
}

// ── BitRouter HTTP API response types ────────────────────────────────

/** A single route entry from GET /v1/routes. */
export interface RouteInfo {
  /** The virtual model name (e.g. "fast", "gpt-4o"). */
  model: string;
  /** Provider name (e.g. "openai", "anthropic"). */
  provider: string;
  /** API protocol used by this provider. */
  protocol: "openai" | "anthropic" | "google";
}

/** Response from GET /health. */
export interface HealthStatus {
  status: "ok" | "error";
}

// ── Plugin runtime state ─────────────────────────────────────────────

/**
 * Mutable state shared across all plugin modules.
 *
 * Created once in index.ts and passed by reference to service.ts,
 * routing.ts, health.ts, and provider.ts. This avoids module-level
 * global state and makes testing straightforward (inject a mock state).
 */
export interface BitrouterState {
  /** The managed BitRouter child process, or null if not running. */
  process: ChildProcess | null;
  /** Whether the last health check succeeded. */
  healthy: boolean;
  /** Base URL for BitRouter's HTTP API (e.g. "http://127.0.0.1:8787"). */
  baseUrl: string;
  /** Cached routing table from GET /v1/routes. */
  knownRoutes: RouteInfo[];
  /** Handle for the periodic health check interval. */
  healthCheckTimer: ReturnType<typeof setInterval> | null;
  /** Absolute path to the generated BitRouter home directory. */
  homeDir: string;
}

// ── OpenClaw Plugin API type stubs ───────────────────────────────────
//
// These are minimal type declarations for the OpenClaw plugin API surface
// that this plugin uses. In production, these would come from @openclaw/sdk.
// For now, we declare them here so the plugin compiles without the SDK.

export interface OpenClawPluginApi {
  /** Register a managed service with start/stop lifecycle. */
  registerService(opts: {
    id: string;
    start: () => Promise<void>;
    stop: () => Promise<void>;
  }): void;

  /** Register an LLM provider. */
  registerProvider(opts: {
    id: string;
    label: string;
    baseUrl?: string;
    auth?: ProviderAuthMethod[];
  }): void;

  /**
   * Listen for plugin lifecycle events.
   *
   * The `before_model_resolve` hook fires before the agent runtime selects
   * a model. The handler can call `event.override()` to redirect the
   * request to a different provider/model.
   */
  on(
    event: "before_model_resolve",
    handler: (event: ModelResolveEvent) => void
  ): void;

  /** Get this plugin's resolved config (merged with defaults). */
  getConfig(): BitrouterPluginConfig;

  /** Get the plugin's data directory (persistent across restarts). */
  getDataDir(): string;

  /** Structured logger scoped to this plugin. */
  log: {
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
  };
}

/** A single auth method offered by a provider. */
export interface ProviderAuthMethod {
  id: string;
  label: string;
  kind: "api_key" | "oauth";
  run: (ctx: ProviderAuthContext) => Promise<ProviderAuthResult>;
}

/** Context passed to a provider's auth run() function. */
export interface ProviderAuthContext {
  /** Prompt the user for input (e.g. an API key). */
  prompter: {
    prompt(opts: { message: string; type?: "text" | "password" }): Promise<string>;
  };
}

/** Result returned from a provider's auth run() function. */
export interface ProviderAuthResult {
  profiles: Array<{
    profileId: string;
    credential: {
      type: "api_key";
      provider: string;
      key: string;
    };
  }>;
}

/** Event object passed to the before_model_resolve hook. */
export interface ModelResolveEvent {
  /** The model name requested by the agent (e.g. "gpt-4o", "claude-sonnet"). */
  model: string;
  /** Override the provider and optionally the model name. */
  override(opts: { provider: string; model?: string }): void;
}

// ── Config defaults ──────────────────────────────────────────────────

export const DEFAULTS = {
  port: 8787,
  host: "127.0.0.1",
  autoStart: true,
  healthCheckIntervalMs: 30_000,
  interceptAllModels: false,
  /** How long to wait for BitRouter to become healthy on startup. */
  startupTimeoutMs: 15_000,
  /** Interval between startup health check polls. */
  startupPollMs: 200,
  /** How long to wait for the process to exit on stop. */
  stopTimeoutMs: 10_000,
  /** Refresh the routing table every N health checks. */
  routeRefreshInterval: 5,
} as const;
