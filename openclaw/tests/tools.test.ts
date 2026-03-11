import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  BitrouterPluginConfig,
  BitrouterState,
  OpenClawPluginApi,
  ToolResult,
} from "../src/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function createMockState(
  overrides?: Partial<BitrouterState>
): BitrouterState {
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

function createMockApi(): OpenClawPluginApi & {
  _tools: Map<
    string,
    {
      execute: (
        id: string,
        params: Record<string, unknown>
      ) => Promise<ToolResult>;
    }
  >;
} {
  const tools = new Map<
    string,
    {
      execute: (
        id: string,
        params: Record<string, unknown>
      ) => Promise<ToolResult>;
    }
  >();

  return {
    _tools: tools,
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerTool: vi.fn(
      (
        def: {
          name: string;
          execute: (
            id: string,
            params: Record<string, unknown>
          ) => Promise<ToolResult>;
        },
        _opts?: { optional?: boolean }
      ) => {
        tools.set(def.name, def);
      }
    ),
    on: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerGatewayMethod: vi.fn(),
    getConfig: vi.fn(() => ({})),
    getDataDir: vi.fn(() => "/tmp"),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

async function callTool(
  api: ReturnType<typeof createMockApi>,
  name: string,
  params: Record<string, unknown> = {}
): Promise<ToolResult> {
  const tool = api._tools.get(name);
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  return tool.execute("test-id", params);
}

function parseJsonResult(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

// ── Tests ────────────────────────────────────────────────────────────

// We import registerAgentTools dynamically to allow mocking child_process
let registerAgentTools: typeof import("../src/tools.js").registerAgentTools;

beforeEach(async () => {
  vi.restoreAllMocks();
  const mod = await import("../src/tools.js");
  registerAgentTools = mod.registerAgentTools;
});

describe("bitrouter_status", () => {
  it("returns health and route counts from state", async () => {
    const api = createMockApi();
    const state = createMockState({
      healthy: true,
      knownRoutes: [
        { model: "fast", provider: "openai", protocol: "openai" },
      ],
    });
    state.dynamicRoutes.set("custom", {
      model: "custom",
      strategy: "priority",
      endpoints: [{ provider: "anthropic", modelId: "claude-sonnet" }],
      rrCounter: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    registerAgentTools(api, {}, state);

    const result = await callTool(api, "bitrouter_status");
    const data = parseJsonResult(result) as Record<string, unknown>;

    expect(data.healthy).toBe(true);
    expect(data.processRunning).toBe(false);
    expect(data.staticRouteCount).toBe(1);
    expect(data.dynamicRouteCount).toBe(1);
    expect(data.providerCount).toBe(1); // openai from knownRoutes
  });
});

describe("bitrouter_list_routes", () => {
  it("merges static and dynamic routes with source labels", async () => {
    const api = createMockApi();
    const state = createMockState({
      knownRoutes: [
        { model: "fast", provider: "openai", protocol: "openai" },
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
    registerAgentTools(api, {}, state);

    const result = await callTool(api, "bitrouter_list_routes");
    const data = parseJsonResult(result) as Array<Record<string, unknown>>;

    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({ model: "fast", source: "static" });
    expect(data[1]).toMatchObject({
      model: "custom",
      source: "dynamic",
      strategy: "load_balance",
    });
  });
});

describe("bitrouter_create_route", () => {
  it("stores a DynamicRoute in state", async () => {
    const api = createMockApi();
    const state = createMockState();
    registerAgentTools(api, {}, state);

    const result = await callTool(api, "bitrouter_create_route", {
      model: "my-model",
      strategy: "priority",
      endpoints: [{ provider: "openai", modelId: "gpt-4o" }],
    });
    const data = parseJsonResult(result) as Record<string, unknown>;

    expect(data.ok).toBe(true);
    expect(data.model).toBe("my-model");
    expect(state.dynamicRoutes.has("my-model")).toBe(true);

    const route = state.dynamicRoutes.get("my-model")!;
    expect(route.strategy).toBe("priority");
    expect(route.endpoints).toHaveLength(1);
    expect(route.rrCounter).toBe(0);
  });

  it("defaults strategy to priority", async () => {
    const api = createMockApi();
    const state = createMockState();
    registerAgentTools(api, {}, state);

    await callTool(api, "bitrouter_create_route", {
      model: "test",
      endpoints: [{ provider: "openai", modelId: "gpt-4o" }],
    });

    expect(state.dynamicRoutes.get("test")!.strategy).toBe("priority");
  });

  it("upserts — overwrites existing route with same model name", async () => {
    const api = createMockApi();
    const state = createMockState();
    registerAgentTools(api, {}, state);

    await callTool(api, "bitrouter_create_route", {
      model: "test",
      endpoints: [{ provider: "openai", modelId: "gpt-4o" }],
    });
    await callTool(api, "bitrouter_create_route", {
      model: "test",
      strategy: "load_balance",
      endpoints: [
        { provider: "anthropic", modelId: "claude-sonnet" },
        { provider: "openai", modelId: "gpt-4o-mini" },
      ],
    });

    const route = state.dynamicRoutes.get("test")!;
    expect(route.strategy).toBe("load_balance");
    expect(route.endpoints).toHaveLength(2);
    expect(route.rrCounter).toBe(0); // Reset on upsert
  });

  it("warns when shadowing a static route", async () => {
    const api = createMockApi();
    const state = createMockState({
      knownRoutes: [
        { model: "fast", provider: "openai", protocol: "openai" },
      ],
    });
    registerAgentTools(api, {}, state);

    const result = await callTool(api, "bitrouter_create_route", {
      model: "fast",
      endpoints: [{ provider: "anthropic", modelId: "claude-sonnet" }],
    });
    const data = parseJsonResult(result) as Record<string, unknown>;

    expect(data.warnings).toBeDefined();
    expect((data.warnings as string[])[0]).toContain("shadows a static route");
  });

  it("warns when provider is unknown", async () => {
    const api = createMockApi();
    const state = createMockState();
    registerAgentTools(api, {}, state);

    const result = await callTool(api, "bitrouter_create_route", {
      model: "test",
      endpoints: [{ provider: "unknown-provider", modelId: "some-model" }],
    });
    const data = parseJsonResult(result) as Record<string, unknown>;

    expect(data.warnings).toBeDefined();
    expect((data.warnings as string[])[0]).toContain("not in the known provider list");
  });
});

describe("bitrouter_delete_route", () => {
  it("removes a dynamic route", async () => {
    const api = createMockApi();
    const state = createMockState();
    state.dynamicRoutes.set("test", {
      model: "test",
      strategy: "priority",
      endpoints: [{ provider: "openai", modelId: "gpt-4o" }],
      rrCounter: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    registerAgentTools(api, {}, state);

    const result = await callTool(api, "bitrouter_delete_route", {
      model: "test",
    });
    const data = parseJsonResult(result) as Record<string, unknown>;

    expect(data.ok).toBe(true);
    expect(data.deleted).toBe(true);
    expect(state.dynamicRoutes.has("test")).toBe(false);
  });

  it("errors when model not found", async () => {
    const api = createMockApi();
    const state = createMockState();
    registerAgentTools(api, {}, state);

    const result = await callTool(api, "bitrouter_delete_route", {
      model: "nonexistent",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No dynamic route found");
  });

  it("errors when targeting a static-only route", async () => {
    const api = createMockApi();
    const state = createMockState({
      knownRoutes: [
        { model: "fast", provider: "openai", protocol: "openai" },
      ],
    });
    registerAgentTools(api, {}, state);

    const result = await callTool(api, "bitrouter_delete_route", {
      model: "fast",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Cannot delete static route");
  });
});

describe("bitrouter_create_token", () => {
  it("returns an error result when the CLI command fails", async () => {
    const api = createMockApi();
    const state = createMockState();
    registerAgentTools(api, {}, state);

    const result = await callTool(api, "bitrouter_create_token", {
      scope: "api",
      exp: "1h",
    });

    // Either binary not found or CLI fails — either way it's an error
    expect(result.isError).toBe(true);
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  it("is registered as a tool", () => {
    const api = createMockApi();
    const state = createMockState();
    registerAgentTools(api, {}, state);

    expect(api._tools.has("bitrouter_create_token")).toBe(true);
  });
});

describe("bitrouter_status with metrics", () => {
  it("includes aggregate metrics when available", async () => {
    const api = createMockApi();
    const state = createMockState({
      metrics: {
        routes: {
          fast: {
            model: "fast",
            total_requests: 100,
            total_errors: 5,
            error_rate: 0.05,
            latency_p50_ms: 200,
            latency_p99_ms: 800,
            by_endpoint: {},
          },
        },
      },
    });
    registerAgentTools(api, {}, state);

    const result = await callTool(api, "bitrouter_status");
    const data = parseJsonResult(result) as Record<string, unknown>;

    expect(data.metricsAvailable).toBe(true);
    expect(data.totalRequests).toBe(100);
    expect(data.totalErrors).toBe(5);
  });

  it("shows metricsAvailable=false when no metrics", async () => {
    const api = createMockApi();
    const state = createMockState();
    registerAgentTools(api, {}, state);

    const result = await callTool(api, "bitrouter_status");
    const data = parseJsonResult(result) as Record<string, unknown>;

    expect(data.metricsAvailable).toBe(false);
    expect(data.totalRequests).toBeUndefined();
  });
});

describe("bitrouter_route_metrics", () => {
  it("returns metrics for a known model", async () => {
    const api = createMockApi();
    const state = createMockState({
      metrics: {
        routes: {
          fast: {
            model: "fast",
            total_requests: 50,
            total_errors: 2,
            error_rate: 0.04,
            latency_p50_ms: 150,
            latency_p99_ms: 600,
            by_endpoint: {
              "openai:gpt-4o": {
                total_requests: 50,
                total_errors: 2,
                error_rate: 0.04,
                latency_p50_ms: 150,
                latency_p99_ms: 600,
              },
            },
          },
        },
      },
    });
    registerAgentTools(api, {}, state);

    const result = await callTool(api, "bitrouter_route_metrics", { model: "fast" });
    const data = parseJsonResult(result) as Record<string, unknown>;

    expect(data.model).toBe("fast");
    expect(data.total_requests).toBe(50);
  });

  it("errors when metrics unavailable", async () => {
    const api = createMockApi();
    const state = createMockState();
    registerAgentTools(api, {}, state);

    const result = await callTool(api, "bitrouter_route_metrics", { model: "fast" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Metrics not available");
  });

  it("errors for unknown model", async () => {
    const api = createMockApi();
    const state = createMockState({
      metrics: { routes: {} },
    });
    registerAgentTools(api, {}, state);

    const result = await callTool(api, "bitrouter_route_metrics", { model: "unknown" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No metrics found");
  });
});

describe("bitrouter_route_task", () => {
  it("recommends a model for a task type", async () => {
    const api = createMockApi();
    const state = createMockState({
      knownRoutes: [
        { model: "gpt-4o", provider: "openai", protocol: "openai" as const },
        { model: "gpt-4o-mini", provider: "openai", protocol: "openai" as const },
      ],
    });
    registerAgentTools(api, {}, state);

    const result = await callTool(api, "bitrouter_route_task", {
      taskType: "coding",
    });
    const data = parseJsonResult(result) as Record<string, unknown>;

    expect(data.model).toBeDefined();
    expect(data.rationale).toBeDefined();
    expect(data.alternatives).toBeDefined();
  });

  it("prefers cheaper models for summarization with cheap budget", async () => {
    const api = createMockApi();
    const state = createMockState({
      knownRoutes: [
        { model: "gpt-4o", provider: "openai", protocol: "openai" as const },
        { model: "gpt-4o-mini", provider: "openai", protocol: "openai" as const },
      ],
    });
    registerAgentTools(api, {}, state);

    const result = await callTool(api, "bitrouter_route_task", {
      taskType: "summarization",
      budgetHint: "cheap",
    });
    const data = parseJsonResult(result) as Record<string, unknown>;

    // gpt-4o-mini is "low" tier, which should match for cheap summarization.
    expect(data.model).toBe("gpt-4o-mini");
  });

  it("errors when no routes available", async () => {
    const api = createMockApi();
    const state = createMockState();
    registerAgentTools(api, {}, state);

    const result = await callTool(api, "bitrouter_route_task", {
      taskType: "reasoning",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No routes available");
  });
});

describe("bitrouter_list_routes with metrics", () => {
  it("includes metrics summary per route when available", async () => {
    const api = createMockApi();
    const state = createMockState({
      knownRoutes: [
        { model: "fast", provider: "openai", protocol: "openai" as const },
      ],
      metrics: {
        routes: {
          fast: {
            model: "fast",
            total_requests: 100,
            total_errors: 5,
            error_rate: 0.05,
            latency_p50_ms: 200,
            latency_p99_ms: 800,
            by_endpoint: {},
          },
        },
      },
    });
    registerAgentTools(api, {}, state);

    const result = await callTool(api, "bitrouter_list_routes");
    const data = parseJsonResult(result) as Array<Record<string, unknown>>;

    expect(data[0].metrics).toBeDefined();
    const metrics = data[0].metrics as Record<string, unknown>;
    expect(metrics.requests).toBe(100);
    expect(metrics.latencyP50).toBe(200);
  });
});
