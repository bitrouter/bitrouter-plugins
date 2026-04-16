import { describe, it, expect, vi } from "vitest";
import { buildCatalogHandler } from "../src/discovery.js";
import type { BitrouterState, ModelInfo, RouteInfo } from "../src/types.js";

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
    onboardingState: null,
    ...overrides,
  };
}

const ROUTES: RouteInfo[] = [
  { model: "gpt-4o", provider: "openai", protocol: "openai" },
  { model: "claude-3-5-sonnet", provider: "anthropic", protocol: "anthropic" },
  { model: "gemini-pro", provider: "google", protocol: "google" },
];

const MODELS: ModelInfo[] = [
  {
    id: "gpt-4o",
    owned_by: "openai",
    context_window: 128_000,
    max_tokens: 16_384,
    reasoning: false,
    input: ["text", "image"],
  },
  {
    id: "claude-sonnet-4-20250514",
    owned_by: "anthropic",
    context_window: 200_000,
    max_tokens: 16_384,
    reasoning: true,
    input: ["text", "image"],
  },
];

/**
 * Build a mock catalog context with resolveProviderApiKey that returns
 * keys for the given provider names.
 */
function mockCatalogCtx(
  availableProviders: string[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  return {
    config: {},
    env: process.env,
    resolveProviderApiKey: vi.fn((providerId: string) => {
      if (availableProviders.includes(providerId)) {
        return { apiKey: `sk-test-${providerId}` };
      }
      return { apiKey: undefined };
    }),
    resolveProviderAuth: vi.fn(() => ({
      apiKey: undefined,
      mode: "none" as const,
      source: "none" as const,
    })),
  };
}

// ── Tests: healthy BitRouter (existing behavior) ─────────────────────

describe("buildCatalogHandler — healthy BitRouter", () => {
  it("returns models from knownModels when healthy", async () => {
    const state = createMockState({ healthy: true, knownModels: MODELS });
    const handler = buildCatalogHandler(state);
    const result = await handler({} as any);

    expect(result.provider.models).toHaveLength(2);
    const ids = result.provider.models.map((m: Record<string, unknown>) => m.id);
    expect(ids).toContain("gpt-4o");
    expect(ids).toContain("claude-sonnet-4-20250514");
  });

  it("prefers knownModels over knownRoutes when both available", async () => {
    const state = createMockState({
      healthy: true,
      knownRoutes: ROUTES,
      knownModels: MODELS,
    });
    const handler = buildCatalogHandler(state);
    const result = await handler({} as any);

    expect(result.provider.models).toHaveLength(2);
    // Should use model IDs from /v1/models, not routes.
    const ids = result.provider.models.map((m: Record<string, unknown>) => m.id);
    expect(ids).toContain("gpt-4o");
    expect(ids).toContain("claude-sonnet-4-20250514");
  });

  it("uses capabilities from /v1/models directly", async () => {
    const state = createMockState({
      healthy: true,
      knownModels: MODELS,
    });
    const handler = buildCatalogHandler(state);
    const result = await handler({} as any);

    const gpt4o = result.provider.models.find(
      (m: Record<string, unknown>) => m.id === "gpt-4o"
    );
    expect(gpt4o.contextWindow).toBe(128_000);
    expect(gpt4o.maxTokens).toBe(16_384);
    expect(gpt4o.reasoning).toBe(false);
    expect(gpt4o.input).toEqual(["text", "image"]);

    const claude = result.provider.models.find(
      (m: Record<string, unknown>) => m.id === "claude-sonnet-4-20250514"
    );
    expect(claude.reasoning).toBe(true);
    expect(claude.contextWindow).toBe(200_000);
  });

  it("includes owned_by in model name from /v1/models", async () => {
    const state = createMockState({
      healthy: true,
      knownModels: [{ id: "gpt-4o", owned_by: "openai" }],
    });
    const handler = buildCatalogHandler(state);
    const result = await handler({} as any);

    expect(result.provider.models[0].name).toContain("BitRouter");
    expect(result.provider.models[0].name).toContain("openai");
  });

  // ── /v1/routes fallback path ───────────────────────────────────────

  it("falls back to knownRoutes when knownModels is empty", async () => {
    const state = createMockState({ healthy: true, knownRoutes: ROUTES });
    const handler = buildCatalogHandler(state);
    const result = await handler({} as any);

    expect(result).toBeTruthy();
    expect(result.provider.baseUrl).toBe("http://127.0.0.1:8787/v1");
    expect(result.provider.models).toHaveLength(3);
  });

  it("uses protocol defaults in route fallback path", async () => {
    const routes: RouteInfo[] = [
      { model: "claude", provider: "anthropic", protocol: "anthropic" },
    ];
    const state = createMockState({ healthy: true, knownRoutes: routes });
    const handler = buildCatalogHandler(state);
    const result = await handler({} as any);

    expect(result.provider.models[0].contextWindow).toBe(200_000);
    expect(result.provider.models[0].maxTokens).toBe(8_192);
  });

  // ── Deduplication ──────────────────────────────────────────────────

  it("deduplicates models by id", async () => {
    const models: ModelInfo[] = [
      { id: "gpt-4o", owned_by: "openai", context_window: 128_000 },
      { id: "gpt-4o", owned_by: "openrouter", context_window: 128_000 },
    ];
    const state = createMockState({ healthy: true, knownModels: models });
    const handler = buildCatalogHandler(state);
    const result = await handler({} as any);

    expect(result.provider.models).toHaveLength(1);
    // First entry wins.
    expect(result.provider.models[0].name).toContain("openai");
  });

  it("deduplicates routes by model id", async () => {
    const routes: RouteInfo[] = [
      { model: "gpt-4o", provider: "openai", protocol: "openai" },
      { model: "gpt-4o", provider: "openrouter", protocol: "openai" },
    ];
    const state = createMockState({ healthy: true, knownRoutes: routes });
    const handler = buildCatalogHandler(state);
    const result = await handler({} as any);

    expect(result.provider.models).toHaveLength(1);
    expect(result.provider.models[0].name).toContain("openai");
  });
});

// ── Tests: auto-detection via ctx.resolveProviderApiKey ───────────────

describe("buildCatalogHandler — auto-detect fallback", () => {
  it("returns null when unhealthy and ctx has no resolveProviderApiKey", async () => {
    const state = createMockState({ healthy: false, knownRoutes: ROUTES });
    const handler = buildCatalogHandler(state);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await handler({} as any);
    expect(result).toBeNull();
  });

  it("returns null when unhealthy and no providers detected", async () => {
    const state = createMockState({ healthy: false });
    const ctx = mockCatalogCtx([]); // no providers available
    const handler = buildCatalogHandler(state);
    const result = await handler(ctx);
    expect(result).toBeNull();
  });

  it("auto-detects providers via ctx.resolveProviderApiKey when unhealthy", async () => {
    const state = createMockState({ healthy: false });
    const ctx = mockCatalogCtx(["openai", "anthropic"]);
    const handler = buildCatalogHandler(state);
    const result = await handler(ctx);

    expect(result).toBeTruthy();
    expect(result.provider.baseUrl).toBe("http://127.0.0.1:8787/v1");
    expect(result.provider.models).toHaveLength(2);

    const ids = result.provider.models.map((m: Record<string, unknown>) => m.id);
    expect(ids).toContain("anthropic/auto");
    expect(ids).toContain("openai/auto");
  });

  it("populates state.autoDetectedProviders as side effect", async () => {
    const state = createMockState({ healthy: false });
    const ctx = mockCatalogCtx(["openai"]);
    const handler = buildCatalogHandler(state);
    await handler(ctx);

    expect(state.autoDetectedProviders).toHaveLength(1);
    expect(state.autoDetectedProviders![0].name).toBe("openai");
    expect(state.autoDetectedProviders![0].apiKey).toBe("sk-test-openai");
  });

  it("calls ctx.resolveProviderApiKey for each well-known provider", async () => {
    const state = createMockState({ healthy: false });
    const ctx = mockCatalogCtx([]);
    const handler = buildCatalogHandler(state);
    await handler(ctx);

    // Should have been called for at least the well-known providers.
    expect(ctx.resolveProviderApiKey).toHaveBeenCalled();
    const calledProviders = ctx.resolveProviderApiKey.mock.calls.map(
      (c: string[]) => c[0]
    );
    expect(calledProviders).toContain("openai");
    expect(calledProviders).toContain("anthropic");
    expect(calledProviders).toContain("openrouter");
  });

  it("prefers healthy BitRouter data over auto-detect", async () => {
    const state = createMockState({ healthy: true, knownModels: MODELS });
    const ctx = mockCatalogCtx(["openai"]);
    const handler = buildCatalogHandler(state);
    const result = await handler(ctx);

    // Should return real models, not auto-detected placeholders.
    const ids = result.provider.models.map((m: Record<string, unknown>) => m.id);
    expect(ids).toContain("gpt-4o");
    expect(ids).not.toContain("openai/auto");
    // resolveProviderApiKey should not have been called.
    expect(ctx.resolveProviderApiKey).not.toHaveBeenCalled();
  });

  it("falls through to auto-detect when healthy but no models/routes", async () => {
    const state = createMockState({ healthy: true }); // no models or routes
    const ctx = mockCatalogCtx(["anthropic"]);
    const handler = buildCatalogHandler(state);
    const result = await handler(ctx);

    expect(result).toBeTruthy();
    const ids = result.provider.models.map((m: Record<string, unknown>) => m.id);
    expect(ids).toContain("anthropic/auto");
  });

  it("uses protocol defaults for auto-detected provider entries", async () => {
    const state = createMockState({ healthy: false });
    const ctx = mockCatalogCtx(["anthropic"]);
    const handler = buildCatalogHandler(state);
    const result = await handler(ctx);

    const model = result.provider.models[0];
    expect(model.contextWindow).toBe(200_000);
    expect(model.maxTokens).toBe(8_192);
  });

  it("returns null on resolveProviderApiKey errors (best-effort)", async () => {
    const state = createMockState({ healthy: false });
    const ctx = {
      config: {},
      env: process.env,
      resolveProviderApiKey: vi.fn(() => {
        throw new Error("resolver broke");
      }),
      resolveProviderAuth: vi.fn(() => ({
        apiKey: undefined,
        mode: "none" as const,
        source: "none" as const,
      })),
    };
    const handler = buildCatalogHandler(state);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await handler(ctx as any);
    expect(result).toBeNull();
  });
});
