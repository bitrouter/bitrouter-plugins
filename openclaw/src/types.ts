/**
 * Shared types for the BitRouter OpenClaw plugin.
 *
 * These types bridge three worlds:
 * 1. OpenClaw's plugin API (what we register with)
 * 2. BitRouter's YAML config format (what we generate)
 * 3. BitRouter's HTTP API (what we query at runtime)
 */

import type { ChildProcess } from "node:child_process";

// ── Chain type ───────────────────────────────────────────────────────

/**
 * Which blockchain identity to use for JWT auth with the local BitRouter.
 *
 * "solana" — Ed25519 signing (SOL_EDDSA JWT). Default, backward-compatible.
 * "evm"    — secp256k1 / EIP-191 signing (EIP191K JWT). Uses Base (chain 8453).
 */
export type ChainType = "solana" | "evm";

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
  interceptAllModels?: boolean;
  providers?: Record<string, ProviderEntry>;
  models?: Record<string, ModelEntry>;
  guardrails?: GuardrailPluginConfig;
  /** Set by the first-run wizard. Undefined = not yet configured. */
  mode?: SetupMode;
  /** BYOK upstream provider config. Set when mode === "byok". */
  byok?: BitrouterByokConfig;
  /** Blockchain identity for JWT auth. Defaults to "solana". */
  chain?: ChainType;
  /** Solana RPC URL for on-chain operations. */
  solanaRpcUrl?: string;
  /** Cloud-specific configuration. */
  cloud?: { solanaRpcUrl?: string };
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

// ── Tool result type ─────────────────────────────────────────────────

/** Standard tool result returned from agent tool execute functions. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
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
  /** Cached metrics from GET /v1/metrics (null if unavailable). */
  metrics: MetricsResponse | null;
  /** JWT token for API-scope requests to the local BitRouter instance. */
  apiToken: string | null;
  /** JWT token for admin-scope requests (24h expiry, auto-refreshed). */
  adminToken: string | null;
  /** Providers detected via env var sniffing in auto mode. */
  autoDetectedProviders?: import("./auto-detect.js").DetectedProvider[];
  /** Onboarding state loaded from onboarding.json (null if not present). */
  onboardingState: OnboardingState | null;
}

// ── Re-exports from OpenClaw plugin SDK ──────────────────────────────
//
// The plugin uses the real OpenClaw SDK types directly.
// Re-exported here so all modules can import from "./types.js".
//
// Note: only types that are re-exported through the SDK barrel are listed here.
// Types defined in the SDK but not in its barrel are defined locally below.

export type {
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
  OpenClawPluginService,
  PluginLogger,
  ProviderAuthContext,
  ProviderAuthResult,
  AnyAgentTool,
  GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk";

// ── Locally-defined types matching SDK internals ─────────────────────
//
// These types exist in the SDK's .d.ts files but are not re-exported
// through the openclaw/plugin-sdk barrel. We define structural
// equivalents here based on the SDK's declarations.

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

/** Plugin definition — the default export shape. */
export type OpenClawPluginDefinition = {
  id?: string;
  name?: string;
  description?: string;
  version?: string;
  register?: (api: OpenClawPluginApi) => void | Promise<void>;
  activate?: (api: OpenClawPluginApi) => void | Promise<void>;
};

/** Hook event for before_model_resolve. */
export type PluginHookBeforeModelResolveEvent = {
  prompt: string;
};

/** Hook result for before_model_resolve. */
export type PluginHookBeforeModelResolveResult = {
  modelOverride?: string;
  providerOverride?: string;
};

/** Agent context passed to hooks. */
export type PluginHookAgentContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string;
};

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
