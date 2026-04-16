import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for the unified `bitrouter` agent tool.
 *
 * Tests focus on:
 * - Command allowlist validation
 * - Tokenization of command strings
 * - Rejection of blocked commands
 * - Successful dispatch (mocked binary execution)
 */

// Mock child_process before importing.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Mock binary resolution.
vi.mock("../src/binary.js", () => ({
  resolveBinaryPath: vi.fn(() => Promise.resolve("/usr/local/bin/bitrouter")),
}));

import { execFile } from "node:child_process";
import {
  createBitrouterTool,
  ALLOWED_COMMANDS_DESCRIPTION,
} from "../src/bitrouter-tool.js";
import type { BitrouterState } from "../src/types.js";

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

function mockExecFileSuccess(stdout: string, stderr = "") {
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, stdout, stderr);
    },
  );
}

function mockExecFileFailure(stderr: string, code = 1) {
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      const err = new Error(`exit code ${code}`) as Error & { code: number };
      err.code = code;
      cb(err, "", stderr);
    },
  );
}

describe("bitrouter tool", () => {
  const state = createMockState();
  const stateDirRef = { value: "/tmp/plugins/bitrouter" };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a tool with correct name and description", () => {
    const tool = createBitrouterTool(state, stateDirRef);
    expect(tool.name).toBe("bitrouter");
    expect(tool.description).toContain("Available commands");
    expect(tool.label).toBe("BitRouter CLI");
  });

  it("exports ALLOWED_COMMANDS_DESCRIPTION", () => {
    expect(ALLOWED_COMMANDS_DESCRIPTION).toContain("bitrouter status");
    expect(ALLOWED_COMMANDS_DESCRIPTION).toContain("bitrouter models list");
    expect(ALLOWED_COMMANDS_DESCRIPTION).toContain("bitrouter route add");
    expect(ALLOWED_COMMANDS_DESCRIPTION).toContain("bitrouter route rm");
  });

  // ── Allowed commands ─────────────────────────────────────────────

  it("executes 'status' command", async () => {
    mockExecFileSuccess("BitRouter v0.12.0 running");
    const tool = createBitrouterTool(state, stateDirRef);
    const result = await tool.execute("call-1", { command: "status" });

    expect(result.content[0]).toEqual({
      type: "text",
      text: "BitRouter v0.12.0 running",
    });
    expect(result.details.exitCode).toBe(0);

    // Verify binary was called with --home-dir and the command.
    const call = (execFile as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(call[1]).toEqual(["--home-dir", "/tmp/bitrouter-test", "status"]);
  });

  it("executes 'models list' command", async () => {
    mockExecFileSuccess("gpt-4o\nclaude-sonnet-4-20250514");
    const tool = createBitrouterTool(state, stateDirRef);
    const result = await tool.execute("call-2", { command: "models list" });

    expect(result.content[0].text).toContain("gpt-4o");
    expect(result.details.exitCode).toBe(0);
  });

  it("executes 'route add' with positional args", async () => {
    mockExecFileSuccess("Route added: fast → openai:gpt-4o-mini");
    const tool = createBitrouterTool(state, stateDirRef);
    const result = await tool.execute("call-3", {
      command: "route add fast openai:gpt-4o-mini",
    });

    expect(result.details.exitCode).toBe(0);
    const call = (execFile as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(call[1]).toContain("route");
    expect(call[1]).toContain("add");
    expect(call[1]).toContain("fast");
    expect(call[1]).toContain("openai:gpt-4o-mini");
  });

  it("executes 'route add' with --strategy flag", async () => {
    mockExecFileSuccess("Route added");
    const tool = createBitrouterTool(state, stateDirRef);
    await tool.execute("call-4", {
      command:
        "route add research openai:o3 anthropic:claude-opus-4-20250514 --strategy load_balance",
    });

    const call = (execFile as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(call[1]).toContain("--strategy");
    expect(call[1]).toContain("load_balance");
  });

  it("executes 'route rm' command", async () => {
    mockExecFileSuccess("Route removed: fast");
    const tool = createBitrouterTool(state, stateDirRef);
    const result = await tool.execute("call-5", { command: "route rm fast" });
    expect(result.details.exitCode).toBe(0);
  });

  it("executes 'wallet list' command", async () => {
    mockExecFileSuccess("default (active)");
    const tool = createBitrouterTool(state, stateDirRef);
    const result = await tool.execute("call-6", { command: "wallet list" });
    expect(result.details.exitCode).toBe(0);
  });

  it("executes 'policy show --id default' command", async () => {
    mockExecFileSuccess('{"name": "default"}');
    const tool = createBitrouterTool(state, stateDirRef);
    const result = await tool.execute("call-7", {
      command: "policy show --id default",
    });
    expect(result.details.exitCode).toBe(0);
  });

  it("strips leading 'bitrouter' from command", async () => {
    mockExecFileSuccess("ok");
    const tool = createBitrouterTool(state, stateDirRef);
    await tool.execute("call-8", { command: "bitrouter status" });

    const call = (execFile as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    // Should NOT pass "bitrouter" as an arg — only "status".
    expect(call[1]).toEqual(["--home-dir", "/tmp/bitrouter-test", "status"]);
  });

  // ── Blocked commands ─────────────────────────────────────────────

  it("rejects 'wallet create' as blocked", async () => {
    const tool = createBitrouterTool(state, stateDirRef);
    const result = await tool.execute("call-block-1", {
      command: "wallet create --name evil",
    });

    expect(result.content[0].text).toContain("not allowed");
    expect(result.details.exitCode).toBe(1);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("rejects 'key create' as blocked", async () => {
    const tool = createBitrouterTool(state, stateDirRef);
    const result = await tool.execute("call-block-2", {
      command: "key create --name test --wallet default",
    });

    expect(result.content[0].text).toContain("not allowed");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("rejects 'auth login' as blocked", async () => {
    const tool = createBitrouterTool(state, stateDirRef);
    const result = await tool.execute("call-block-3", {
      command: "auth login",
    });

    expect(result.content[0].text).toContain("not allowed");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("rejects 'serve' as blocked", async () => {
    const tool = createBitrouterTool(state, stateDirRef);
    const result = await tool.execute("call-block-4", { command: "serve" });

    expect(result.content[0].text).toContain("not allowed");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("rejects 'init' as blocked", async () => {
    const tool = createBitrouterTool(state, stateDirRef);
    const result = await tool.execute("call-block-5", { command: "init" });

    expect(result.content[0].text).toContain("not allowed");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("rejects 'policy create' as blocked", async () => {
    const tool = createBitrouterTool(state, stateDirRef);
    const result = await tool.execute("call-block-6", {
      command: "policy create --name evil",
    });

    expect(result.content[0].text).toContain("not allowed");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("rejects 'tools discover' as blocked", async () => {
    const tool = createBitrouterTool(state, stateDirRef);
    const result = await tool.execute("call-block-7", {
      command: "tools discover github",
    });

    expect(result.content[0].text).toContain("not allowed");
    expect(execFile).not.toHaveBeenCalled();
  });

  // ── Edge cases ───────────────────────────────────────────────────

  it("rejects empty command", async () => {
    const tool = createBitrouterTool(state, stateDirRef);
    const result = await tool.execute("call-edge-1", { command: "" });

    expect(result.content[0].text).toContain("empty command");
    expect(result.details.exitCode).toBe(1);
  });

  it("rejects whitespace-only command", async () => {
    const tool = createBitrouterTool(state, stateDirRef);
    const result = await tool.execute("call-edge-2", { command: "   " });

    expect(result.content[0].text).toContain("empty command");
    expect(result.details.exitCode).toBe(1);
  });

  it("handles CLI failure gracefully", async () => {
    mockExecFileFailure("error: unknown model", 1);
    const tool = createBitrouterTool(state, stateDirRef);
    const result = await tool.execute("call-fail-1", {
      command: "route rm nonexistent",
    });

    expect(result.content[0].text).toContain("error: unknown model");
    expect(result.details.exitCode).toBe(1);
  });

  it("handles quoted arguments", async () => {
    mockExecFileSuccess("ok");
    const tool = createBitrouterTool(state, stateDirRef);
    await tool.execute("call-quote-1", {
      command: 'wallet info --wallet "my wallet"',
    });

    const call = (execFile as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(call[1]).toContain("my wallet");
  });
});
