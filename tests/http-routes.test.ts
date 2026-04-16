import { describe, it, expect, vi } from "vitest";
import { registerHttpRoutes } from "../src/http-routes.js";
import type { BitrouterState, OpenClawPluginApi } from "../src/types.js";

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
    apiToken: "test-api-token",
    onboardingState: null,
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

// ── Tests ────────────────────────────────────────────────────────────

describe("registerHttpRoutes", () => {
  it("registers eight HTTP routes", () => {
    const api = createMockApi();
    const state = createMockState();

    registerHttpRoutes(api, state);

    const mock = api.registerHttpRoute as ReturnType<typeof vi.fn>;
    expect(mock).toHaveBeenCalledTimes(8);
  });

  it("registers /bitrouter/status route", () => {
    const api = createMockApi();
    const state = createMockState();

    registerHttpRoutes(api, state);

    const mock = api.registerHttpRoute as ReturnType<typeof vi.fn>;
    const paths = mock.mock.calls.map(
      (c: unknown[]) => (c[0] as { path: string }).path,
    );
    expect(paths).toContain("/bitrouter/status");
  });

  it("registers /bitrouter/metrics route", () => {
    const api = createMockApi();
    const state = createMockState();

    registerHttpRoutes(api, state);

    const mock = api.registerHttpRoute as ReturnType<typeof vi.fn>;
    const paths = mock.mock.calls.map(
      (c: unknown[]) => (c[0] as { path: string }).path,
    );
    expect(paths).toContain("/bitrouter/metrics");
  });

  it("registers /bitrouter/routes route", () => {
    const api = createMockApi();
    const state = createMockState();

    registerHttpRoutes(api, state);

    const mock = api.registerHttpRoute as ReturnType<typeof vi.fn>;
    const paths = mock.mock.calls.map(
      (c: unknown[]) => (c[0] as { path: string }).path,
    );
    expect(paths).toContain("/bitrouter/routes");
  });

  it("registers /bitrouter/models route", () => {
    const api = createMockApi();
    const state = createMockState();

    registerHttpRoutes(api, state);

    const mock = api.registerHttpRoute as ReturnType<typeof vi.fn>;
    const paths = mock.mock.calls.map(
      (c: unknown[]) => (c[0] as { path: string }).path,
    );
    expect(paths).toContain("/bitrouter/models");
  });

  it("all routes use plugin auth", () => {
    const api = createMockApi();
    const state = createMockState();

    registerHttpRoutes(api, state);

    const mock = api.registerHttpRoute as ReturnType<typeof vi.fn>;
    for (const call of mock.mock.calls) {
      expect((call[0] as { auth: string }).auth).toBe("plugin");
    }
  });

  it("all routes use exact matching", () => {
    const api = createMockApi();
    const state = createMockState();

    registerHttpRoutes(api, state);

    const mock = api.registerHttpRoute as ReturnType<typeof vi.fn>;
    for (const call of mock.mock.calls) {
      expect((call[0] as { match: string }).match).toBe("exact");
    }
  });

  it("route handler returns 503 when unhealthy", async () => {
    const api = createMockApi();
    const state = createMockState({ healthy: false });

    registerHttpRoutes(api, state);

    const mock = api.registerHttpRoute as ReturnType<typeof vi.fn>;
    const statusRoute = mock.mock.calls.find(
      (c: unknown[]) => (c[0] as { path: string }).path === "/bitrouter/status",
    );
    const handler = (statusRoute![0] as { handler: Function }).handler;

    const res = {
      writeHead: vi.fn(),
      end: vi.fn(),
    };

    await handler({}, res);

    expect(res.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
    expect(res.end).toHaveBeenCalledWith(
      expect.stringContaining("not healthy"),
    );
  });
});
