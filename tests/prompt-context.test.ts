import { describe, it, expect, vi } from "vitest";
import { registerPromptContext } from "../src/prompt-context.js";
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
    knownAgents: [],
    knownTools: [],
    knownSkills: [],
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

/** Extract the hook handler registered via api.on("before_prompt_build", ...) */
function getHookHandler(api: OpenClawPluginApi) {
  const onMock = api.on as ReturnType<typeof vi.fn>;
  const call = onMock.mock.calls.find(
    (c: unknown[]) => c[0] === "before_prompt_build"
  );
  expect(call).toBeTruthy();
  return call![1] as (
    event: { prompt: string },
    ctx: { agentId?: string }
  ) => { prependContext?: string; appendSystemContext?: string } | void;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("registerPromptContext", () => {
  it("registers a before_prompt_build hook", () => {
    const api = createMockApi();
    const config: BitrouterPluginConfig = { mode: "byok" };
    const state = createMockState();

    registerPromptContext(api, config, state);

    const onMock = api.on as ReturnType<typeof vi.fn>;
    expect(onMock).toHaveBeenCalledWith(
      "before_prompt_build",
      expect.any(Function)
    );
  });

  it("returns static appendSystemContext with CLI reference", () => {
    const api = createMockApi();
    const config: BitrouterPluginConfig = { mode: "byok" };
    const state = createMockState();

    registerPromptContext(api, config, state);
    const handler = getHookHandler(api);
    const result = handler({ prompt: "hello" }, {});

    expect(result).toBeTruthy();
    expect(result!.appendSystemContext).toContain("openclaw bitrouter status");
    expect(result!.appendSystemContext).toContain("/bitrouter skill");
  });

  it("omits healthy tag when BitRouter is down", () => {
    const api = createMockApi();
    const config: BitrouterPluginConfig = { mode: "byok" };
    const state = createMockState({ healthy: false });

    registerPromptContext(api, config, state);
    const handler = getHookHandler(api);
    const result = handler({ prompt: "hello" }, {});

    expect(result!.prependContext).not.toContain("healthy");
  });

  it("includes mode and route count in dynamic context", () => {
    const api = createMockApi();
    const config: BitrouterPluginConfig = {
      mode: "byok",
      byok: { upstreamProvider: "openrouter" },
    };
    const state = createMockState({
      healthy: true,
      knownRoutes: [
        { model: "gpt-4o", provider: "openai", protocol: "openai" },
        { model: "claude-3-5-sonnet", provider: "anthropic", protocol: "anthropic" },
      ],
    });

    registerPromptContext(api, config, state);
    const handler = getHookHandler(api);
    const result = handler({ prompt: "hello" }, {});

    expect(result!.prependContext).toContain("byok");
    expect(result!.prependContext).toContain("openrouter");
    expect(result!.prependContext).toContain("2 routes");
    expect(result!.prependContext).toContain("gpt-4o→openai");
  });

  it("shows auto mode without upstream provider", () => {
    const api = createMockApi();
    const config: BitrouterPluginConfig = { mode: "auto" };
    const state = createMockState({
      healthy: true,
      knownRoutes: [
        { model: "gpt-4o", provider: "openai", protocol: "openai" },
      ],
    });

    registerPromptContext(api, config, state);
    const handler = getHookHandler(api);
    const result = handler({ prompt: "hello" }, {});

    expect(result!.prependContext).toContain("auto");
    expect(result!.prependContext).toContain("1 routes");
  });

  it("shows unconfigured when mode is not set", () => {
    const api = createMockApi();
    const config: BitrouterPluginConfig = {};
    const state = createMockState({ healthy: true });

    registerPromptContext(api, config, state);
    const handler = getHookHandler(api);
    const result = handler({ prompt: "hello" }, {});

    expect(result!.prependContext).toContain("unconfigured");
  });
});
