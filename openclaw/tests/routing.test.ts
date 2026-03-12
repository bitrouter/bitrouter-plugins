import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  refreshRoutes,
  registerModelInterceptor,
  scoreEndpoint,
  selectBestEndpoint,
} from "../src/routing.js";
import type {
  BitrouterState,
  BitrouterPluginConfig,
  EndpointMetrics,
  MetricsResponse,
  OpenClawPluginApi,
  PluginHookBeforeModelResolveEvent,
  PluginHookAgentContext,
  PluginHookBeforeModelResolveResult,
} from "../src/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function createMockState(overrides?: Partial<BitrouterState>): BitrouterState {
  return {
    process: null,
    healthy: true,
    baseUrl: "http://127.0.0.1:8787",
    knownRoutes: [],
    healthCheckTimer: null,
    homeDir: "/tmp/bitrouter-test",
    metrics: null,
    authToken: null,
    ...overrides,
  };
}

/**
 * Create a mock OpenClawPluginApi.
 * `model` sets the default model name that resolveModelName() will find
 * when looking up agent config.
 */
function createMockApi(model = "default") {
  return {
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerTool: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    on: vi.fn(),
    pluginConfig: {},
    config: {
      agents: {
        defaults: { model: { primary: model } },
      },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as OpenClawPluginApi;
}

/** Extract the before_model_resolve handler from a mock api. */
function extractHookHandler(api: OpenClawPluginApi) {
  return (api.on as ReturnType<typeof vi.fn>).mock.calls[0][1] as (
    event: PluginHookBeforeModelResolveEvent,
    ctx: PluginHookAgentContext
  ) => PluginHookBeforeModelResolveResult | void;
}

// ── refreshRoutes ────────────────────────────────────────────────────

describe("refreshRoutes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("populates state.knownRoutes on success", async () => {
    const routes = [
      { model: "fast", provider: "openai", protocol: "openai" as const },
      { model: "smart", provider: "anthropic", protocol: "anthropic" as const },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ routes }),
      })
    );

    const state = createMockState();
    const api = createMockApi();
    await refreshRoutes(state, api);

    expect(state.knownRoutes).toEqual(routes);
    expect(api.logger.info).toHaveBeenCalledWith(
      "Loaded 2 route(s) from BitRouter"
    );
  });

  it("preserves existing routes on fetch failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connection refused"))
    );

    const existingRoutes = [
      { model: "fast", provider: "openai", protocol: "openai" as const },
    ];
    const state = createMockState({ knownRoutes: existingRoutes });
    const api = createMockApi();
    await refreshRoutes(state, api);

    // Routes should be preserved, not cleared.
    expect(state.knownRoutes).toEqual(existingRoutes);
    expect(api.logger.warn).toHaveBeenCalled();
  });

  it("preserves existing routes on non-200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      })
    );

    const existingRoutes = [
      { model: "fast", provider: "openai", protocol: "openai" as const },
    ];
    const state = createMockState({ knownRoutes: existingRoutes });
    const api = createMockApi();
    await refreshRoutes(state, api);

    expect(state.knownRoutes).toEqual(existingRoutes);
  });
});

// ── registerModelInterceptor ─────────────────────────────────────────

describe("registerModelInterceptor", () => {
  it("registers a before_model_resolve handler", () => {
    const api = createMockApi();
    const state = createMockState();
    registerModelInterceptor(api, {}, state);

    expect(api.on).toHaveBeenCalledWith(
      "before_model_resolve",
      expect.any(Function)
    );
  });

  it("does not intercept when BitRouter is unhealthy", () => {
    const api = createMockApi("fast");
    const state = createMockState({ healthy: false });
    registerModelInterceptor(api, {}, state);

    const handler = extractHookHandler(api);
    const result = handler({ prompt: "test" }, { agentId: "main" });

    expect(result).toBeUndefined();
  });

  it("intercepts known models in selective mode", () => {
    const api = createMockApi("fast");
    const state = createMockState({
      knownRoutes: [
        { model: "fast", provider: "openai", protocol: "openai" },
      ],
    });
    const config: BitrouterPluginConfig = { interceptAllModels: false };
    registerModelInterceptor(api, config, state);

    const handler = extractHookHandler(api);
    const result = handler({ prompt: "test" }, { agentId: "main" });

    expect(result).toEqual({
      providerOverride: "bitrouter",
      modelOverride: "fast",
    });
  });

  it("ignores unknown models in selective mode", () => {
    const api = createMockApi("unknown-model");
    const state = createMockState({
      knownRoutes: [
        { model: "fast", provider: "openai", protocol: "openai" },
      ],
    });
    const config: BitrouterPluginConfig = { interceptAllModels: false };
    registerModelInterceptor(api, config, state);

    const handler = extractHookHandler(api);
    const result = handler({ prompt: "test" }, { agentId: "main" });

    // Should NOT redirect — fall through to OpenClaw's native resolution.
    expect(result).toBeUndefined();
  });

  it("intercepts ALL models when interceptAllModels is true", () => {
    const api = createMockApi("anything-at-all");
    const state = createMockState({ knownRoutes: [] }); // No routes cached.
    const config: BitrouterPluginConfig = { interceptAllModels: true };
    registerModelInterceptor(api, config, state);

    const handler = extractHookHandler(api);
    const result = handler({ prompt: "test" }, { agentId: "main" });

    expect(result).toEqual({
      providerOverride: "bitrouter",
      modelOverride: "anything-at-all",
    });
  });
});

// ── scoreEndpoint ───────────────────────────────────────────────────

describe("scoreEndpoint", () => {
  it("returns 0 for undefined metrics", () => {
    expect(scoreEndpoint(undefined, 0.5, 5)).toBe(0);
  });

  it("returns 0 for metrics below minRequests", () => {
    const metrics: EndpointMetrics = {
      total_requests: 3,
      total_errors: 0,
      error_rate: 0,
      latency_p50_ms: 100,
      latency_p99_ms: 200,
    };
    expect(scoreEndpoint(metrics, 0.5, 5)).toBe(0);
  });

  it("returns null (circuit-broken) when error rate exceeds threshold", () => {
    const metrics: EndpointMetrics = {
      total_requests: 100,
      total_errors: 60,
      error_rate: 0.6,
      latency_p50_ms: 100,
      latency_p99_ms: 200,
    };
    expect(scoreEndpoint(metrics, 0.5, 5)).toBeNull();
  });

  it("returns positive score for healthy endpoint", () => {
    const metrics: EndpointMetrics = {
      total_requests: 100,
      total_errors: 2,
      error_rate: 0.02,
      latency_p50_ms: 100,
      latency_p99_ms: 200,
    };
    const score = scoreEndpoint(metrics, 0.5, 5);
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThan(0);
  });

  it("scores faster endpoints higher", () => {
    const fast: EndpointMetrics = {
      total_requests: 100,
      total_errors: 2,
      error_rate: 0.02,
      latency_p50_ms: 50,
      latency_p99_ms: 100,
    };
    const slow: EndpointMetrics = {
      total_requests: 100,
      total_errors: 2,
      error_rate: 0.02,
      latency_p50_ms: 500,
      latency_p99_ms: 1000,
    };
    expect(scoreEndpoint(fast, 0.5, 5)!).toBeGreaterThan(
      scoreEndpoint(slow, 0.5, 5)!
    );
  });
});

// ── selectBestEndpoint ──────────────────────────────────────────────

describe("selectBestEndpoint", () => {
  it("returns first endpoint when no metrics available", () => {
    const state = createMockState();
    const endpoints = [
      { provider: "openai", modelId: "gpt-4o" },
      { provider: "anthropic", modelId: "claude-sonnet" },
    ];
    const result = selectBestEndpoint(endpoints, "fast", state, {});
    expect(result).toEqual({ provider: "openai", modelId: "gpt-4o" });
  });

  it("returns first endpoint for single endpoint", () => {
    const state = createMockState();
    const endpoints = [{ provider: "openai", modelId: "gpt-4o" }];
    const result = selectBestEndpoint(endpoints, "fast", state, {});
    expect(result).toEqual({ provider: "openai", modelId: "gpt-4o" });
  });

  it("selects endpoint with better metrics", () => {
    const metrics: MetricsResponse = {
      routes: {
        fast: {
          model: "fast",
          total_requests: 100,
          total_errors: 10,
          error_rate: 0.1,
          latency_p50_ms: 200,
          latency_p99_ms: 800,
          by_endpoint: {
            "openai:gpt-4o": {
              total_requests: 50,
              total_errors: 1,
              error_rate: 0.02,
              latency_p50_ms: 100,
              latency_p99_ms: 300,
            },
            "anthropic:claude-sonnet": {
              total_requests: 50,
              total_errors: 9,
              error_rate: 0.18,
              latency_p50_ms: 300,
              latency_p99_ms: 1000,
            },
          },
        },
      },
    };

    const state = createMockState({ metrics });
    const endpoints = [
      { provider: "openai", modelId: "gpt-4o" },
      { provider: "anthropic", modelId: "claude-sonnet" },
    ];
    const result = selectBestEndpoint(endpoints, "fast", state, {});
    // OpenAI has lower error rate and lower latency.
    expect(result).toEqual({ provider: "openai", modelId: "gpt-4o" });
  });

  it("falls back to first endpoint when all are circuit-broken", () => {
    const metrics: MetricsResponse = {
      routes: {
        fast: {
          model: "fast",
          total_requests: 100,
          total_errors: 60,
          error_rate: 0.6,
          latency_p50_ms: 200,
          latency_p99_ms: 800,
          by_endpoint: {
            "openai:gpt-4o": {
              total_requests: 50,
              total_errors: 30,
              error_rate: 0.6,
              latency_p50_ms: 200,
              latency_p99_ms: 800,
            },
            "anthropic:claude-sonnet": {
              total_requests: 50,
              total_errors: 30,
              error_rate: 0.6,
              latency_p50_ms: 200,
              latency_p99_ms: 800,
            },
          },
        },
      },
    };

    const state = createMockState({ metrics });
    const endpoints = [
      { provider: "openai", modelId: "gpt-4o" },
      { provider: "anthropic", modelId: "claude-sonnet" },
    ];
    const result = selectBestEndpoint(endpoints, "fast", state, {});
    // All tripped — fall back to first.
    expect(result).toEqual({ provider: "openai", modelId: "gpt-4o" });
  });
});
