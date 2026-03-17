import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Service tests — focused on lifecycle logic (start/stop).
 *
 * These tests mock child_process and binary resolution to avoid spawning
 * real processes or downloading binaries.
 */

// Mock child_process before importing service.ts.
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

// Mock binary resolution.
vi.mock("../src/binary.js", () => ({
  resolveBinaryPath: vi.fn(() => Promise.resolve("/usr/local/bin/bitrouter")),
}));

// Mock the config and health modules to isolate service logic.
vi.mock("../src/config.js", () => ({
  writeConfigToDir: vi.fn(() => "/tmp/bitrouter-test"),
  resolveHomeDir: vi.fn(() => "/tmp/bitrouter-test"),
  PROVIDER_API_BASES: {},
  toEnvVarKey: vi.fn((s: string) => `${s.toUpperCase()}_API_KEY`),
  parseEnvFile: vi.fn(() => new Map()),
}));

vi.mock("../src/health.js", () => ({
  startHealthCheck: vi.fn(),
  stopHealthCheck: vi.fn(),
  waitForReady: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("../src/routing.js", () => ({
  refreshRoutes: vi.fn(() => Promise.resolve()),
}));

vi.mock("../src/metrics.js", () => ({
  refreshMetrics: vi.fn(() => Promise.resolve()),
}));

vi.mock("../src/auth.js", () => ({
  ensureAuth: vi.fn(() => ({ apiToken: "mock-api-jwt", adminToken: "mock-admin-jwt" })),
}));

vi.mock("../src/auto-detect.js", () => ({
  buildAutoProviderConfig: vi.fn(() => ({ providers: {}, models: {} })),
}));

vi.mock("../src/onboarding.js", () => ({
  loadOnboardingState: vi.fn(() => null),
}));

import { spawn } from "node:child_process";
import { resolveBinaryPath } from "../src/binary.js";
import { registerBitrouterService } from "../src/service.js";
import type {
  BitrouterState,
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
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
    dynamicRoutes: new Map(),
    metrics: null,
    onboardingState: null,
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

/** Create a mock ChildProcess with EventEmitter behavior. */
function createMockChild() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.pid = 12345;
  return child;
}

/** Mock service context matching OpenClawPluginServiceContext. */
const mockCtx: OpenClawPluginServiceContext = {
  stateDir: "/tmp/bitrouter-service-test",
};

// ── Tests ────────────────────────────────────────────────────────────

describe("registerBitrouterService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(resolveBinaryPath).mockResolvedValue("/usr/local/bin/bitrouter");
  });

  it("registers a service with id 'bitrouter'", () => {
    const api = createMockApi();
    const state = createMockState();
    const stateDirRef = { value: "/tmp" };
    registerBitrouterService(api, {}, state, stateDirRef);

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

    const api = createMockApi();
    const state = createMockState();
    const stateDirRef = { value: "/tmp" };
    registerBitrouterService(api, {}, state, stateDirRef);

    // Extract and call the start function with service context.
    const serviceOpts = vi.mocked(api.registerService).mock.calls[0][0];
    await serviceOpts.start(mockCtx);

    expect(resolveBinaryPath).toHaveBeenCalledWith(mockCtx.stateDir);
    expect(spawn).toHaveBeenCalledWith(
      "/usr/local/bin/bitrouter",
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

    const stateDirRef = { value: "/tmp" };
    registerBitrouterService(api, {}, state, stateDirRef);

    const serviceOpts = vi.mocked(api.registerService).mock.calls[0][0];

    // Simulate the child exiting after SIGTERM.
    mockChild.kill.mockImplementation(() => {
      setTimeout(() => mockChild.emit("exit", 0, null), 50);
      return true;
    });

    await serviceOpts.stop(mockCtx);

    expect(mockChild.kill).toHaveBeenCalledWith("SIGTERM");
    expect(state.process).toBeNull();
    expect(state.healthy).toBe(false);
  });

  it("throws when binary resolution fails", async () => {
    vi.mocked(resolveBinaryPath).mockRejectedValue(
      new Error("BitRouter binary not found.")
    );

    const api = createMockApi();
    const state = createMockState();
    const stateDirRef = { value: "/tmp" };
    registerBitrouterService(api, {}, state, stateDirRef);

    const serviceOpts = vi.mocked(api.registerService).mock.calls[0][0];
    await expect(serviceOpts.start(mockCtx)).rejects.toThrow("BitRouter binary not found.");
  });
});
