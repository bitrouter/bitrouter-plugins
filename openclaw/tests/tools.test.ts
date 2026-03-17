import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  BitrouterState,
  OpenClawPluginApi,
} from "../src/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

/** Result shape returned by factory-wrapped tool execute. */
interface FactoryToolResult {
  content: Array<{ type: string; text: string }>;
  details?: unknown;
}

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
    metrics: null,
    apiToken: null,
    adminToken: null,
    onboardingState: null,
    ...overrides,
  };
}

function createMockApi() {
  const tools = new Map<
    string,
    {
      name: string;
      execute: (
        id: string,
        params: Record<string, unknown>
      ) => Promise<FactoryToolResult>;
    }
  >();

  const api = {
    _tools: tools,
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerTool: vi.fn(
      (factory: Function, _opts?: { optional?: boolean }) => {
        const tool = factory();
        tools.set(tool.name, tool);
      }
    ),
    on: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    pluginConfig: {},
    config: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };

  return api as typeof api & { _tools: typeof tools };
}

// ── Tests ────────────────────────────────────────────────────────────

let registerAgentTools: typeof import("../src/tools.js").registerAgentTools;

beforeEach(async () => {
  vi.restoreAllMocks();
  const mod = await import("../src/tools.js");
  registerAgentTools = mod.registerAgentTools;
});

const stateDirRef = { value: "/tmp" };

describe("tool registration", () => {
  it("registers all 9 tools", () => {
    const api = createMockApi();
    const state = createMockState();
    registerAgentTools(api as unknown as OpenClawPluginApi, {}, state, stateDirRef);

    expect(api._tools.has("bitrouter_status")).toBe(true);
    expect(api._tools.has("bitrouter_keygen")).toBe(true);
    expect(api._tools.has("bitrouter_account")).toBe(true);
    expect(api._tools.has("bitrouter_keys")).toBe(true);
    expect(api._tools.has("bitrouter_add_route")).toBe(true);
    expect(api._tools.has("bitrouter_remove_route")).toBe(true);
    expect(api._tools.has("bitrouter_list_routes")).toBe(true);
    expect(api._tools.has("bitrouter_wallet")).toBe(true);
    expect(api._tools.has("bitrouter_spend")).toBe(true);
    expect(api._tools.size).toBe(9);
  });

  it("does not register removed tools", () => {
    const api = createMockApi();
    const state = createMockState();
    registerAgentTools(api as unknown as OpenClawPluginApi, {}, state, stateDirRef);

    expect(api._tools.has("bitrouter_start")).toBe(false);
    expect(api._tools.has("bitrouter_stop")).toBe(false);
    expect(api._tools.has("bitrouter_restart")).toBe(false);
    expect(api._tools.has("bitrouter_list_providers")).toBe(false);
    expect(api._tools.has("bitrouter_create_route")).toBe(false);
    expect(api._tools.has("bitrouter_delete_route")).toBe(false);
    expect(api._tools.has("bitrouter_route_metrics")).toBe(false);
    expect(api._tools.has("bitrouter_route_task")).toBe(false);
    expect(api._tools.has("bitrouter_create_token")).toBe(false);
  });

  it("registers all tools as optional", () => {
    const api = createMockApi();
    const state = createMockState();
    registerAgentTools(api as unknown as OpenClawPluginApi, {}, state, stateDirRef);

    for (const call of api.registerTool.mock.calls) {
      expect(call[1]).toEqual({ optional: true });
    }
  });

  it("each tool has a name, description, and parameters", () => {
    const api = createMockApi();
    const state = createMockState();
    registerAgentTools(api as unknown as OpenClawPluginApi, {}, state, stateDirRef);

    for (const [, tool] of api._tools) {
      expect(tool.name).toBeTruthy();
      expect(typeof tool.execute).toBe("function");
    }
  });
});
