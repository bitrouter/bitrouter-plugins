import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  refreshRoutes,
  registerModelInterceptor,
} from "../src/routing.js";
import type {
  BitrouterState,
  BitrouterPluginConfig,
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
    knownModels: [],
    healthCheckTimer: null,
    homeDir: "/tmp/bitrouter-test",
    metrics: null,
    apiToken: null,
    adminToken: null,
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

