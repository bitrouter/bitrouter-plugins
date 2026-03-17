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
    knownModels: [],
    healthCheckTimer: null,
    homeDir: "/tmp/bitrouter-test",
    metrics: null,
    apiToken: null,
    adminToken: null,
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
  uptime_seconds: 3600,
  routes: {
    fast: {
      total_requests: 100,
      total_errors: 5,
      latency_p50_ms: 200,
      latency_p99_ms: 800,
      by_endpoint: {
        "openai:gpt-4o": {
          total_requests: 60,
          total_errors: 2,
          latency_p50_ms: 180,
          latency_p99_ms: 700,
        },
        "anthropic:claude-sonnet": {
          total_requests: 40,
          total_errors: 3,
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

  it("returns null on 404 without warning", async () => {
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
