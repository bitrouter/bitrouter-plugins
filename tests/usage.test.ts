import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchMetrics,
  summarizeMetrics,
  formatUsageText,
} from "../src/usage.js";
import type { BitrouterState, MetricsResponse } from "../src/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function createMockState(overrides?: Partial<BitrouterState>): BitrouterState {
  return {
    process: null,
    healthy: true,
    baseUrl: "http://127.0.0.1:8787",
    knownRoutes: [],
    knownModels: [],
    knownAgents: [],
    knownTools: [],
    knownSkills: [],
    healthCheckTimer: null,
    homeDir: "/tmp/bitrouter-test",
    metrics: null,
    apiToken: null,
    onboardingState: null,
    ...overrides,
  };
}

const SAMPLE_METRICS: MetricsResponse = {
  uptime_seconds: 3661,
  routes: {
    fast: {
      total_requests: 42,
      total_errors: 2,
      latency_p50_ms: 150,
      latency_p99_ms: 800,
      avg_input_tokens: 100,
      avg_output_tokens: 500,
      last_used: "2025-01-15T10:30:00Z",
      by_endpoint: {
        "openai:gpt-4o-mini": {
          total_requests: 42,
          total_errors: 2,
          latency_p50_ms: 150,
          latency_p99_ms: 800,
        },
      },
    },
    research: {
      total_requests: 5,
      total_errors: 0,
      latency_p50_ms: 2000,
      latency_p99_ms: 5000,
      avg_input_tokens: 500,
      avg_output_tokens: 2000,
      last_used: "2025-01-15T09:00:00Z",
      by_endpoint: {},
    },
  },
};

// ── Tests ────────────────────────────────────────────────────────────

describe("fetchMetrics", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches and caches metrics on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(SAMPLE_METRICS),
      }),
    );

    const state = createMockState();
    const result = await fetchMetrics(state);

    expect(result).toEqual(SAMPLE_METRICS);
    expect(state.metrics).toEqual(SAMPLE_METRICS);
  });

  it("returns null when BitRouter is unhealthy", async () => {
    const state = createMockState({ healthy: false });
    const result = await fetchMetrics(state);
    expect(result).toBeNull();
  });

  it("returns null on fetch failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connection refused")),
    );

    const state = createMockState();
    const result = await fetchMetrics(state);
    expect(result).toBeNull();
  });

  it("returns null on non-200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );

    const state = createMockState();
    const result = await fetchMetrics(state);
    expect(result).toBeNull();
  });

  it("includes auth header when apiToken is set", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(SAMPLE_METRICS),
      }),
    );

    const state = createMockState({ apiToken: "test-jwt" });
    await fetchMetrics(state);

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[1].headers).toEqual({
      Authorization: "Bearer test-jwt",
    });
  });
});

describe("summarizeMetrics", () => {
  it("converts metrics into structured summary", () => {
    const summary = summarizeMetrics(SAMPLE_METRICS);

    expect(summary.uptime).toBe(3661);
    expect(summary.routes).toHaveLength(2);

    const fast = summary.routes.find((r) => r.route === "fast");
    expect(fast).toBeDefined();
    expect(fast?.requests).toBe(42);
    expect(fast?.errors).toBe(2);
    expect(fast?.p50Ms).toBe(150);
  });

  it("handles empty routes", () => {
    const summary = summarizeMetrics({
      uptime_seconds: 100,
      routes: {},
    });

    expect(summary.routes).toHaveLength(0);
  });
});

describe("formatUsageText", () => {
  it("formats metrics as readable text", () => {
    const text = formatUsageText(SAMPLE_METRICS);

    expect(text).toContain("BitRouter Uptime: 61m 1s");
    expect(text).toContain("Route Metrics:");
    expect(text).toContain("fast:");
    expect(text).toContain("42 req");
    expect(text).toContain("research:");
  });

  it("handles empty routes", () => {
    const text = formatUsageText({
      uptime_seconds: 0,
      routes: {},
    });

    expect(text).toContain("No route metrics recorded yet.");
  });
});
