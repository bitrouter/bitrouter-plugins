import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMcpToolsBridge } from "../src/mcp-tools.js";
import type {
  BitrouterState,
  OpenClawPluginApi,
  ToolInfo,
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
    config: { agents: { defaults: { model: { primary: "default" } } } },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as OpenClawPluginApi;
}

function makeTool(id: string, provider = "mcp-server"): ToolInfo {
  return {
    id,
    name: id,
    provider,
    description: `Tool ${id}`,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("MCP Tools Bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers MCP tools from state.knownTools", () => {
    const tools = [makeTool("read_file"), makeTool("list_dir")];
    const state = createMockState({ knownTools: tools });
    const api = createMockApi();

    const bridge = createMcpToolsBridge(api, state);
    bridge.registerInitialTools();

    expect(api.registerTool).toHaveBeenCalledTimes(2);
    expect(bridge.registeredToolNames.has("bitrouter_read_file")).toBe(true);
    expect(bridge.registeredToolNames.has("bitrouter_list_dir")).toBe(true);
  });

  it("skips skill entries (provider === 'skill')", () => {
    const tools = [
      makeTool("read_file", "mcp-server"),
      makeTool("my_skill", "skill"),
    ];
    const state = createMockState({ knownTools: tools });
    const api = createMockApi();

    const bridge = createMcpToolsBridge(api, state);
    bridge.registerInitialTools();

    expect(api.registerTool).toHaveBeenCalledTimes(1);
    expect(bridge.registeredToolNames.has("bitrouter_my_skill")).toBe(false);
  });

  it("does not re-register already registered tools", () => {
    const tools = [makeTool("read_file")];
    const state = createMockState({ knownTools: tools });
    const api = createMockApi();

    const bridge = createMcpToolsBridge(api, state);
    bridge.registerInitialTools();
    bridge.registerInitialTools(); // second call

    expect(api.registerTool).toHaveBeenCalledTimes(1);
  });

  it("registers new tools on refresh", () => {
    const state = createMockState({ knownTools: [makeTool("read_file")] });
    const api = createMockApi();

    const bridge = createMcpToolsBridge(api, state);
    bridge.registerInitialTools();
    expect(api.registerTool).toHaveBeenCalledTimes(1);

    // Add a new tool.
    state.knownTools.push(makeTool("write_file"));
    bridge.refresh();

    expect(api.registerTool).toHaveBeenCalledTimes(2);
    expect(bridge.registeredToolNames.has("bitrouter_write_file")).toBe(true);
  });

  it("removes stale tool names on refresh", () => {
    const state = createMockState({
      knownTools: [makeTool("read_file"), makeTool("list_dir")],
    });
    const api = createMockApi();

    const bridge = createMcpToolsBridge(api, state);
    bridge.registerInitialTools();
    expect(bridge.registeredToolNames.size).toBe(2);

    // Remove list_dir from state.
    state.knownTools = [makeTool("read_file")];
    bridge.refresh();

    expect(bridge.registeredToolNames.has("bitrouter_list_dir")).toBe(false);
    expect(bridge.registeredToolNames.has("bitrouter_read_file")).toBe(true);
  });

  it("registers tools as optional", () => {
    const state = createMockState({ knownTools: [makeTool("read_file")] });
    const api = createMockApi();

    const bridge = createMcpToolsBridge(api, state);
    bridge.registerInitialTools();

    const opts = (api.registerTool as ReturnType<typeof vi.fn>).mock
      .calls[0][1];
    expect(opts.optional).toBe(true);
  });

  it("namespaces tool names with bitrouter_ prefix", () => {
    const state = createMockState({ knownTools: [makeTool("read_file")] });
    const api = createMockApi();

    const bridge = createMcpToolsBridge(api, state);
    bridge.registerInitialTools();

    const opts = (api.registerTool as ReturnType<typeof vi.fn>).mock
      .calls[0][1];
    expect(opts.name).toBe("bitrouter_read_file");
  });

  it("handles empty tool list gracefully", () => {
    const state = createMockState({ knownTools: [] });
    const api = createMockApi();

    const bridge = createMcpToolsBridge(api, state);
    bridge.registerInitialTools();

    expect(api.registerTool).not.toHaveBeenCalled();
    expect(bridge.registeredToolNames.size).toBe(0);
  });

  it("replaces special chars in tool names", () => {
    const state = createMockState({
      knownTools: [makeTool("some-server/read.file")],
    });
    const api = createMockApi();

    const bridge = createMcpToolsBridge(api, state);
    bridge.registerInitialTools();

    expect(
      bridge.registeredToolNames.has("bitrouter_some_server_read_file"),
    ).toBe(true);
  });

  it("logs warning on registration failure", () => {
    const state = createMockState({ knownTools: [makeTool("read_file")] });
    const api = createMockApi();
    (api.registerTool as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("registration failed");
    });

    const bridge = createMcpToolsBridge(api, state);
    bridge.registerInitialTools();

    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to register MCP tool"),
    );
  });
});

describe("MCP proxy tool execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("proxy tool returns error when BitRouter is unhealthy", async () => {
    const state = createMockState({
      healthy: false,
      knownTools: [makeTool("read_file")],
    });
    const api = createMockApi();

    const bridge = createMcpToolsBridge(api, state);
    bridge.registerInitialTools();

    // Get the registered tool.
    const registeredTool = (api.registerTool as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    const result = await registeredTool.execute("call-1", {});

    expect(result.content[0].text).toContain("not healthy");
    expect(result.details.isError).toBe(true);
  });

  it("proxy tool calls MCP gateway on execution", async () => {
    const state = createMockState({
      healthy: true,
      knownTools: [makeTool("read_file")],
    });
    const api = createMockApi();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            result: {
              content: [{ type: "text", text: "file contents here" }],
              isError: false,
            },
          }),
      }),
    );

    const bridge = createMcpToolsBridge(api, state);
    bridge.registerInitialTools();

    const registeredTool = (api.registerTool as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    const result = await registeredTool.execute("call-2", {
      arguments: { path: "/test.txt" },
    });

    expect(result.content[0].text).toBe("file contents here");
    expect(result.details.isError).toBe(false);

    // Verify the MCP gateway was called correctly.
    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toBe("http://127.0.0.1:8787/mcp");
    const body = JSON.parse(fetchCall[1].body);
    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("read_file");
    expect(body.params.arguments).toEqual({ path: "/test.txt" });
  });

  it("proxy tool handles MCP gateway errors", async () => {
    const state = createMockState({
      healthy: true,
      knownTools: [makeTool("read_file")],
    });
    const api = createMockApi();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      }),
    );

    const bridge = createMcpToolsBridge(api, state);
    bridge.registerInitialTools();

    const registeredTool = (api.registerTool as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    const result = await registeredTool.execute("call-3", {});

    expect(result.content[0].text).toContain("MCP gateway error");
    expect(result.details.isError).toBe(true);
  });
});
