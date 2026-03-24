/**
 * Shared types for the BitRouter OpenClaw plugin.
 *
 * These types bridge three worlds:
 * 1. OpenClaw's plugin API (what we register with)
 * 2. BitRouter's YAML config format (what we generate)
 * 3. BitRouter's HTTP API (what we query at runtime)
 */

import type { ChildProcess } from "node:child_process";

// ── Onboarding types ─────────────────────────────────────────────────

/**
 * Status of the Swig wallet onboarding flow (read from onboarding.json).
 */
export type OnboardingStatus =
  | "not_started"
  | "completed_cloud"
  | "completed_byok"
  | "deferred"
  | "failed_recoverable";

/**
 * Permission caps for an agent wallet role.
 */
export interface AgentPermissions {
  per_tx_cap?: number;
  cumulative_cap?: number;
  expires_at?: number;
}

/**
 * An agent wallet entry within the Swig onboarding state.
 */
export interface AgentWalletInfo {
  label: string;
  address: string;
  role_id: number;
  permissions: AgentPermissions;
  created_at: string;
}

/**
 * Onboarding state persisted by the Rust CLI in `<homeDir>/onboarding.json`.
 * The plugin reads this file but never writes to it.
 */
export interface OnboardingState {
  status: OnboardingStatus;
  master_wallet_path?: string;
  embedded_wallet_address?: string;
  wallet_address?: string;
  swig_id?: string;
  rpc_url?: string;
  agent_wallets: AgentWalletInfo[];
}

// ── Setup mode ───────────────────────────────────────────────────────

/**
 * How the user wants to use BitRouter.
 *
 * "byok"  — bring-your-own-key: user provides upstream provider API key(s).
 *           BitRouter holds them and proxies requests.
 * "cloud" — sign in to BitRouterAI cloud (stub; OAuth coming in next version).
 */
export type SetupMode = "byok" | "cloud" | "auto";

/**
 * BYOK upstream provider config — stored in pluginConfig after wizard runs.
 * The apiKey is the raw key string (stored in openclaw's credential store
 * via ProviderAuthResult.profiles, not in plain config).
 */
export interface BitrouterByokConfig {
  /** Upstream provider id: "openrouter" | "openai" | "anthropic" | custom */
  upstreamProvider: string;
  /** Custom API base URL (optional — defaults to provider's public URL). */
  apiBase?: string;
}

// ── Plugin configuration (from openclaw.plugin.json configSchema) ────

/** Root plugin config — matches the configSchema in openclaw.plugin.json. */
export interface BitrouterPluginConfig {
  port?: number;
  host?: string;
  autoStart?: boolean;
  healthCheckIntervalMs?: number;
  providers?: Record<string, ProviderEntry>;
  models?: Record<string, ModelEntry>;
  guardrails?: GuardrailPluginConfig;
  /** Set by the first-run wizard. Undefined = not yet configured. */
  mode?: SetupMode;
  /** BYOK upstream provider config. Set when mode === "byok". */
  byok?: BitrouterByokConfig;
  /** Solana RPC URL for on-chain operations. */
  solanaRpcUrl?: string;
  /** Cloud-specific configuration. */
  cloud?: { solanaRpcUrl?: string };
  /** Stored original model mappings, set by `openclaw bitrouter switch-all`. */
  originalModels?: {
    defaultModel?: AgentModelConfig;
    agentModels?: Record<string, AgentModelConfig>;
    switchedAt?: string;
  };
}

/** Agent model config — mirrors the SDK's model field shape. */
export type AgentModelConfig = string | { primary?: string; fallbacks?: string[] };

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

/**
 * A model entry from GET /v1/models (OpenAI-compatible format).
 *
 * BitRouter may include extended fields beyond the OpenAI spec
 * (context_window, max_tokens, capabilities). Unknown fields are
 * preserved via the index signature.
 */
export interface ModelInfo {
  /** Model ID (e.g. "gpt-4o", "claude-sonnet-4-20250514"). */
  id: string;
  /** Object type — always "model" in OpenAI format. */
  object?: string;
  /** Creation timestamp. */
  created?: number;
  /** Owner/provider identifier. */
  owned_by?: string;

  // ── BitRouter extended fields ──────────────────────────────────────
  /** Context window size in tokens. */
  context_window?: number;
  /** Maximum output tokens. */
  max_tokens?: number;
  /** Whether the model supports reasoning/chain-of-thought. */
  reasoning?: boolean;
  /** Supported input modalities. */
  input?: Array<"text" | "image">;

  /** Catch-all for additional fields BitRouter may add. */
  [key: string]: unknown;
}

// ── Metrics types ───────────────────────────────────────────────────

/** Per-endpoint performance metrics. */
export interface EndpointMetrics {
  total_requests: number;
  total_errors: number;
  latency_p50_ms?: number;
  latency_p99_ms?: number;
}

/** Per-route metrics from GET /v1/metrics. */
export interface RouteMetrics {
  total_requests: number;
  total_errors: number;
  latency_p50_ms?: number;
  latency_p99_ms?: number;
  avg_input_tokens?: number;
  avg_output_tokens?: number;
  last_used?: string;
  by_endpoint: Record<string, EndpointMetrics>;
}

/** Full response from GET /v1/metrics. */
export interface MetricsResponse {
  uptime_seconds: number;
  routes: Record<string, RouteMetrics>;
}

// ── Guardrails config ───────────────────────────────────────────────

/** Content guardrail configuration for scanning traffic. */
export interface GuardrailPluginConfig {
  enabled?: boolean;
  disabledPatterns?: string[];
  customPatterns?: Array<{ name: string; regex: string; direction?: "upgoing" | "downgoing" | "both" }>;
  upgoing?: Record<string, "warn" | "redact" | "block">;
  downgoing?: Record<string, "warn" | "redact" | "block">;
}

// ── Admin API types ─────────────────────────────────────────────────

/** A dynamic route definition for POST /admin/routes. */
export interface DynamicRoute {
  model: string;
  strategy?: "priority" | "load_balance";
  endpoints: RouteEndpoint[];
}

/** An endpoint within a dynamic route. */
export interface RouteEndpoint {
  provider: string;
  model_id: string;
}

/** A route entry from GET /admin/routes. */
export interface AdminRouteEntry {
  model: string;
  strategy?: string;
  endpoints: AdminRouteEndpoint[];
  source: "config" | "dynamic";
}

/** An endpoint within an admin route entry. */
export interface AdminRouteEndpoint {
  provider: string;
  model_id: string;
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
  /** Cached model catalog from GET /v1/models. */
  knownModels: ModelInfo[];
  /** Handle for the periodic health check interval. */
  healthCheckTimer: ReturnType<typeof setInterval> | null;
  /** Absolute path to the generated BitRouter home directory. */
  homeDir: string;
  /** Cached metrics from GET /v1/metrics (null if unavailable). */
  metrics: MetricsResponse | null;
  /** JWT token for API-scope requests to the local BitRouter instance. */
  apiToken: string | null;
  /** JWT token for admin-scope requests (24h expiry, auto-refreshed). */
  adminToken: string | null;
  /** Providers detected via env var sniffing in auto mode. */
  autoDetectedProviders?: import("./discovery.js").DetectedProvider[];
  /** Onboarding state loaded from onboarding.json (null if not present). */
  onboardingState: OnboardingState | null;
}

// ── Re-exports from OpenClaw plugin SDK ──────────────────────────────
//
// The plugin uses the real OpenClaw SDK types directly.
// Re-exported here so all modules can import from "./types.js".

export type {
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
  OpenClawPluginService,
  OpenClawPluginDefinition,
  PluginLogger,
  ProviderAuthContext,
  ProviderAuthResult,
  ProviderAuthMethodNonInteractiveContext,
  ProviderCatalogContext,
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
  ProviderPrepareRuntimeAuthContext,
  ProviderPreparedRuntimeAuth,
} from "openclaw/plugin-sdk/plugin-entry";

// ── Config defaults ──────────────────────────────────────────────────

export const DEFAULTS = {
  port: 8787,
  host: "127.0.0.1",
  autoStart: true,
  healthCheckIntervalMs: 30_000,
  /** How long to wait for BitRouter to become healthy on startup. */
  startupTimeoutMs: 15_000,
  /** Interval between startup health check polls. */
  startupPollMs: 200,
  /** How long to wait for the process to exit on stop. */
  stopTimeoutMs: 10_000,
  /** Refresh the routing table every N health checks. */
  routeRefreshInterval: 5,
} as const;
