import { describe, it, expect, vi } from "vitest";
import { registerBitrouterProvider } from "../src/provider.js";
import type {
  BitrouterPluginConfig,
  BitrouterState,
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

describe("registerBitrouterProvider", () => {
  it("registers provider with correct id and label", () => {
    const api = createMockApi();
    const config: BitrouterPluginConfig = {};
    const state = createMockState();

    registerBitrouterProvider(api, config, state);

    const call = (api.registerProvider as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.id).toBe("bitrouter");
    expect(call.label).toBe("BitRouter");
  });

  it("declares envVars for auth doctor integration", () => {
    const api = createMockApi();
    const config: BitrouterPluginConfig = {};
    const state = createMockState();

    registerBitrouterProvider(api, config, state);

    const call = (api.registerProvider as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.envVars).toContain("BITROUTER_API_KEY");
    expect(call.envVars).toContain("OPENAI_API_KEY");
    expect(call.envVars).toContain("ANTHROPIC_API_KEY");
    expect(call.envVars).toContain("OPENROUTER_API_KEY");
  });

  it("includes catalog handler", () => {
    const api = createMockApi();
    const config: BitrouterPluginConfig = {};
    const state = createMockState();

    registerBitrouterProvider(api, config, state);

    const call = (api.registerProvider as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.catalog).toBeTruthy();
    expect(call.catalog.order).toBe("late");
    expect(typeof call.catalog.run).toBe("function");
  });

  it("includes two auth methods with non-interactive support on byok", () => {
    const api = createMockApi();
    const config: BitrouterPluginConfig = {};
    const state = createMockState();

    registerBitrouterProvider(api, config, state);

    const call = (api.registerProvider as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.auth).toHaveLength(2);

    const byok = call.auth.find((a: { id: string }) => a.id === "byok");
    expect(byok).toBeTruthy();
    expect(typeof byok.run).toBe("function");
    expect(typeof byok.runNonInteractive).toBe("function");

    const cloud = call.auth.find((a: { id: string }) => a.id === "cloud");
    expect(cloud).toBeTruthy();
  });

  it("includes formatApiKey handler", () => {
    const api = createMockApi();
    const config: BitrouterPluginConfig = {};
    const state = createMockState();

    registerBitrouterProvider(api, config, state);

    const call = (api.registerProvider as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(typeof call.formatApiKey).toBe("function");

    // formatApiKey extracts the key from an api_key credential.
    const result = call.formatApiKey({ type: "api_key", key: "test-jwt-token" });
    expect(result).toBe("test-jwt-token");
  });
});
