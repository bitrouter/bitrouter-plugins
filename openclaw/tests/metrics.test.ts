import { describe, it, expect, vi, beforeEach } from "vitest";
import { refreshMetrics } from "../src/metrics.js";
import type {
  BitrouterState,
  MetricsResponse,
  OpenClawPluginApi,
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
    dynamicRoutes: new Map(),
    metrics: null,
    ...overrides,
  };
}

function createMockApi() {
  return {
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerTool: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    on: vi.fn(),
    pluginConfig: {},
    config: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as OpenClawPluginApi;
}

const sampleMetrics: MetricsResponse = {
  routes: {
    fast: {
      model: "fast",
      total_requests: 100,
      total_errors: 5,
      error_rate: 0.05,
      latency_p50_ms: 200,
      latency_p99_ms: 800,
      by_endpoint: {
        "openai:gpt-4o": {
          total_requests: 60,
          total_errors: 2,
          error_rate: 0.033,
          latency_p50_ms: 180,
          latency_p99_ms: 700,
        },
        "anthropic:claude-sonnet": {
          total_requests: 40,
          total_errors: 3,
          error_rate: 0.075,
          latency_p50_ms: 230,
          latency_p99_ms: 900,
        },
      },
    },
  },
};

// ── Tests ────────────────────────────────────────────────────────────

describe("refreshMetrics", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("caches metrics on state when fetch succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(sampleMetrics),
      })
    );

    const state = createMockState();
    const api = createMockApi();
    const result = await refreshMetrics(state, api);

    expect(result).toEqual(sampleMetrics);
    expect(state.metrics).toEqual(sampleMetrics);
  });

  it("returns null on fetch failure without clearing cache", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connection refused"))
    );

    const state = createMockState({ metrics: sampleMetrics });
    const api = createMockApi();
    const result = await refreshMetrics(state, api);

    expect(result).toBeNull();
    // Existing cache preserved.
    expect(state.metrics).toEqual(sampleMetrics);
    expect(api.logger.warn).toHaveBeenCalled();
  });

  it("returns null on 404 without warning (no mock)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
      })
    );

    const state = createMockState();
    const api = createMockApi();
    const result = await refreshMetrics(state, api);

    expect(result).toBeNull();
    expect(api.logger.warn).not.toHaveBeenCalled();
  });

  it("generates mock metrics on 404 when mockMetrics=true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
      })
    );

    const state = createMockState({
      knownRoutes: [
        { model: "fast", provider: "openai", protocol: "openai" as const },
        { model: "smart", provider: "anthropic", protocol: "anthropic" as const },
      ],
    });
    const api = createMockApi();
    const config = { routing: { mockMetrics: true } };
    const result = await refreshMetrics(state, api, config);

    expect(result).not.toBeNull();
    expect(result!.routes.fast).toBeDefined();
    expect(result!.routes.smart).toBeDefined();
    expect(result!.routes.fast.total_requests).toBeGreaterThan(0);
    expect(result!.routes.fast.latency_p50_ms).toBeGreaterThan(0);
    expect(state.metrics).toEqual(result);
  });

  it("generates mock metrics on connection error when mockMetrics=true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connection refused"))
    );

    const state = createMockState({
      knownRoutes: [
        { model: "fast", provider: "openai", protocol: "openai" as const },
      ],
    });
    const api = createMockApi();
    const config = { routing: { mockMetrics: true } };
    const result = await refreshMetrics(state, api, config);

    expect(result).not.toBeNull();
    expect(result!.routes.fast).toBeDefined();
    // Should not warn when falling back to mock.
    expect(api.logger.warn).not.toHaveBeenCalled();
  });

  it("mock metrics include dynamic routes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
      })
    );

    const state = createMockState({
      knownRoutes: [
        { model: "fast", provider: "openai", protocol: "openai" as const },
      ],
    });
    state.dynamicRoutes.set("custom", {
      model: "custom",
      strategy: "load_balance",
      endpoints: [
        { provider: "openai", modelId: "gpt-4o" },
        { provider: "anthropic", modelId: "claude-sonnet" },
      ],
      rrCounter: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const api = createMockApi();
    const config = { routing: { mockMetrics: true } };
    const result = await refreshMetrics(state, api, config);

    expect(result!.routes.custom).toBeDefined();
    expect(result!.routes.custom.by_endpoint["openai:gpt-4o"]).toBeDefined();
    expect(result!.routes.custom.by_endpoint["anthropic:claude-sonnet"]).toBeDefined();
  });

  it("warns on non-404 error status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      })
    );

    const state = createMockState();
    const api = createMockApi();
    await refreshMetrics(state, api);

    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("500")
    );
  });
});
