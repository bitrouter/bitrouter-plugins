import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Service tests — focused on binary resolution and lifecycle logic.
 *
 * These tests mock child_process and @bitrouter/cli to avoid spawning
 * real processes. Integration testing with a real BitRouter binary
 * is left to CI.
 */

// Mock child_process before importing service.ts.
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

// Mock node:fs for sibling-build detection.
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
}));

// Mock the config and health modules to isolate service logic.
vi.mock("../src/config.js", () => ({
  writeConfigToDir: vi.fn(() => "/tmp/bitrouter-test"),
  resolveHomeDir: vi.fn(() => "/tmp/bitrouter-test"),
}));

vi.mock("../src/health.js", () => ({
  startHealthCheck: vi.fn(),
  stopHealthCheck: vi.fn(),
  waitForReady: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("../src/routing.js", () => ({
  refreshRoutes: vi.fn(() => Promise.resolve()),
}));

import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { registerBitrouterService } from "../src/service.js";
import { waitForReady } from "../src/health.js";
import type {
  BitrouterState,
  OpenClawPluginApi,
} from "../src/types.js";
import { EventEmitter } from "node:events";

// ── Helpers ──────────────────────────────────────────────────────────

function createMockState(): BitrouterState {
  return {
    process: null,
    healthy: false,
    baseUrl: "http://127.0.0.1:8787",
    knownRoutes: [],
    healthCheckTimer: null,
    homeDir: "/tmp/bitrouter-test",
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

/** Create a mock ChildProcess with EventEmitter behavior. */
function createMockChild() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.pid = 12345;
  return child;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("registerBitrouterService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("registers a service with id 'bitrouter'", () => {
    const api = createMockApi();
    const state = createMockState();
    registerBitrouterService(api, {}, state);

    expect(api.registerService).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "bitrouter",
        start: expect.any(Function),
        stop: expect.any(Function),
      })
    );
  });

  it("start() spawns bitrouter with --home-dir and serve", async () => {
    const mockChild = createMockChild();
    vi.mocked(spawn).mockReturnValue(mockChild as any);

    // @bitrouter/cli isn't installed — fall back to PATH.
    vi.mocked(execSync).mockReturnValue("/usr/local/bin/bitrouter\n");

    const api = createMockApi();
    const state = createMockState();
    registerBitrouterService(api, {}, state);

    // Extract and call the start function.
    const serviceOpts = vi.mocked(api.registerService).mock.calls[0][0];
    await serviceOpts.start();

    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      ["--home-dir", expect.any(String), "serve"],
      expect.objectContaining({
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      })
    );
    expect(state.process).toBe(mockChild);
  });

  it("stop() sends SIGTERM and cleans up state", async () => {
    const mockChild = createMockChild();

    const api = createMockApi();
    const state = createMockState();
    state.process = mockChild;
    state.healthy = true;

    registerBitrouterService(api, {}, state);

    const serviceOpts = vi.mocked(api.registerService).mock.calls[0][0];

    // Simulate the child exiting after SIGTERM.
    mockChild.kill.mockImplementation(() => {
      setTimeout(() => mockChild.emit("exit", 0, null), 50);
      return true;
    });

    await serviceOpts.stop();

    expect(mockChild.kill).toHaveBeenCalledWith("SIGTERM");
    expect(state.process).toBeNull();
    expect(state.healthy).toBe(false);
  });

  it("falls back to PATH lookup when @bitrouter/cli is not available", async () => {
    const mockChild = createMockChild();
    vi.mocked(spawn).mockReturnValue(mockChild as any);
    vi.mocked(execSync).mockReturnValue("/usr/bin/bitrouter\n");

    const api = createMockApi();
    const state = createMockState();
    registerBitrouterService(api, {}, state);

    const serviceOpts = vi.mocked(api.registerService).mock.calls[0][0];
    await serviceOpts.start();

    // Should have fallen back to `which bitrouter`.
    expect(state.process).toBe(mockChild);
  });

  it("uses BITROUTER_BIN env var when set", async () => {
    vi.stubEnv("BITROUTER_BIN", "/custom/path/bitrouter");

    const mockChild = createMockChild();
    vi.mocked(spawn).mockReturnValue(mockChild as any);

    const api = createMockApi();
    const state = createMockState();
    registerBitrouterService(api, {}, state);

    const serviceOpts = vi.mocked(api.registerService).mock.calls[0][0];
    await serviceOpts.start();

    expect(spawn).toHaveBeenCalledWith(
      "/custom/path/bitrouter",
      expect.any(Array),
      expect.any(Object)
    );

    vi.unstubAllEnvs();
  });

  it("finds sibling local build when it exists", async () => {
    // Simulate the sibling release binary existing.
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).includes("target/release/bitrouter")
    );

    const mockChild = createMockChild();
    vi.mocked(spawn).mockReturnValue(mockChild as any);

    const api = createMockApi();
    const state = createMockState();
    registerBitrouterService(api, {}, state);

    const serviceOpts = vi.mocked(api.registerService).mock.calls[0][0];
    await serviceOpts.start();

    const spawnPath = vi.mocked(spawn).mock.calls[0][0] as string;
    expect(spawnPath).toContain("target/release/bitrouter");
  });

  it("prefers BITROUTER_BIN over sibling build", async () => {
    vi.stubEnv("BITROUTER_BIN", "/env/bitrouter");
    vi.mocked(existsSync).mockReturnValue(true);

    const mockChild = createMockChild();
    vi.mocked(spawn).mockReturnValue(mockChild as any);

    const api = createMockApi();
    const state = createMockState();
    registerBitrouterService(api, {}, state);

    const serviceOpts = vi.mocked(api.registerService).mock.calls[0][0];
    await serviceOpts.start();

    expect(spawn).toHaveBeenCalledWith(
      "/env/bitrouter",
      expect.any(Array),
      expect.any(Object)
    );

    vi.unstubAllEnvs();
  });
});
