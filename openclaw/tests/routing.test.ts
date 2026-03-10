import { describe, it, expect, vi, beforeEach } from "vitest";
import { refreshRoutes, registerModelInterceptor } from "../src/routing.js";
import type {
  BitrouterState,
  BitrouterPluginConfig,
  OpenClawPluginApi,
  ModelResolveEvent,
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
    ...overrides,
  };
}

function createMockApi(): OpenClawPluginApi {
  return {
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    on: vi.fn(),
    getConfig: vi.fn(() => ({})),
    getDataDir: vi.fn(() => "/tmp"),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
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
    expect(api.log.info).toHaveBeenCalledWith(
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
    expect(api.log.warn).toHaveBeenCalled();
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
    const api = createMockApi();
    const state = createMockState({ healthy: false });
    registerModelInterceptor(api, {}, state);

    // Extract the registered handler.
    const handler = (api.on as ReturnType<typeof vi.fn>).mock.calls[0][1] as (
      event: ModelResolveEvent
    ) => void;

    const event: ModelResolveEvent = {
      model: "fast",
      override: vi.fn(),
    };
    handler(event);

    expect(event.override).not.toHaveBeenCalled();
  });

  it("intercepts known models in selective mode", () => {
    const api = createMockApi();
    const state = createMockState({
      knownRoutes: [
        { model: "fast", provider: "openai", protocol: "openai" },
      ],
    });
    const config: BitrouterPluginConfig = { interceptAllModels: false };
    registerModelInterceptor(api, config, state);

    const handler = (api.on as ReturnType<typeof vi.fn>).mock.calls[0][1] as (
      event: ModelResolveEvent
    ) => void;

    const event: ModelResolveEvent = {
      model: "fast",
      override: vi.fn(),
    };
    handler(event);

    expect(event.override).toHaveBeenCalledWith({
      provider: "bitrouter",
      model: "fast",
    });
  });

  it("ignores unknown models in selective mode", () => {
    const api = createMockApi();
    const state = createMockState({
      knownRoutes: [
        { model: "fast", provider: "openai", protocol: "openai" },
      ],
    });
    const config: BitrouterPluginConfig = { interceptAllModels: false };
    registerModelInterceptor(api, config, state);

    const handler = (api.on as ReturnType<typeof vi.fn>).mock.calls[0][1] as (
      event: ModelResolveEvent
    ) => void;

    const event: ModelResolveEvent = {
      model: "unknown-model",
      override: vi.fn(),
    };
    handler(event);

    // Should NOT redirect — fall through to OpenClaw's native resolution.
    expect(event.override).not.toHaveBeenCalled();
  });

  it("intercepts ALL models when interceptAllModels is true", () => {
    const api = createMockApi();
    const state = createMockState({ knownRoutes: [] }); // No routes cached.
    const config: BitrouterPluginConfig = { interceptAllModels: true };
    registerModelInterceptor(api, config, state);

    const handler = (api.on as ReturnType<typeof vi.fn>).mock.calls[0][1] as (
      event: ModelResolveEvent
    ) => void;

    const event: ModelResolveEvent = {
      model: "anything-at-all",
      override: vi.fn(),
    };
    handler(event);

    expect(event.override).toHaveBeenCalledWith({
      provider: "bitrouter",
      model: "anything-at-all",
    });
  });
});
