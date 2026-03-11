/**
 * Integration test — exercises the plugin against a real running BitRouter
 * proxy on localhost:8787.
 *
 * Prerequisites:
 *   - BitRouter running locally: `bitrouter serve` (or the release binary)
 *   - At least one model route configured (e.g. "default")
 *
 * Run with: npm test -- tests/integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type {
  OpenClawPluginApi,
  BitrouterPluginConfig,
  BitrouterState,
  ModelResolveEvent,
} from "../src/types.js";
import { checkHealth, waitForReady } from "../src/health.js";
import { refreshRoutes, registerModelInterceptor } from "../src/routing.js";
import { generateConfig } from "../src/config.js";
import { activate } from "../src/index.js";

// ── Helpers ──────────────────────────────────────────────────────────

const BITROUTER_URL = "http://127.0.0.1:8787";

/** Check if BitRouter is actually running before tests. */
async function isBitrouterRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BITROUTER_URL}/health`);
    const body = (await res.json()) as { status: string };
    return body.status === "ok";
  } catch {
    return false;
  }
}

/** Create a mock OpenClaw plugin API that records all registrations. */
function createMockApi(config: BitrouterPluginConfig = {}) {
  const registrations = {
    services: [] as Array<{ id: string; start: () => Promise<void>; stop: () => Promise<void> }>,
    providers: [] as Array<{ id: string; label: string; baseUrl?: string }>,
    hooks: [] as Array<{ event: string; handler: Function }>,
  };

  const logs: string[] = [];

  const api: OpenClawPluginApi = {
    registerService(opts) {
      registrations.services.push(opts);
    },
    registerProvider(opts) {
      registrations.providers.push(opts);
    },
    on(event, handler) {
      registrations.hooks.push({ event, handler });
    },
    getConfig() {
      return config;
    },
    getDataDir() {
      return "/tmp/bitrouter-integration-test";
    },
    log: {
      info(msg: string) { logs.push(`[INFO] ${msg}`); },
      warn(msg: string) { logs.push(`[WARN] ${msg}`); },
      error(msg: string) { logs.push(`[ERROR] ${msg}`); },
    },
  };

  return { api, registrations, logs };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("Integration: plugin against live BitRouter", () => {
  let running: boolean;

  beforeAll(async () => {
    running = await isBitrouterRunning();
    if (!running) {
      console.warn(
        "\n⚠ BitRouter not running on localhost:8787 — skipping integration tests.\n" +
        "  Start it with: bitrouter serve\n"
      );
    }
  });

  // ── Health check against real server ──

  describe("health", () => {
    it("checkHealth returns true against live server", async () => {
      if (!running) return;

      const state: BitrouterState = {
        process: null,
        healthy: false,
        baseUrl: BITROUTER_URL,
        knownRoutes: [],
        healthCheckTimer: null,
        homeDir: "/tmp/test",
      };

      const result = await checkHealth(state);
      expect(result).toBe(true);
    });

    it("waitForReady resolves true when server is already up", async () => {
      if (!running) return;

      const state: BitrouterState = {
        process: null,
        healthy: false,
        baseUrl: BITROUTER_URL,
        knownRoutes: [],
        healthCheckTimer: null,
        homeDir: "/tmp/test",
      };

      const result = await waitForReady(state);
      expect(result).toBe(true);
    });
  });

  // ── Route discovery ──

  describe("routing", () => {
    it("refreshRoutes loads routes from live server", async () => {
      if (!running) return;

      const { api, logs } = createMockApi();
      const state: BitrouterState = {
        process: null,
        healthy: true,
        baseUrl: BITROUTER_URL,
        knownRoutes: [],
        healthCheckTimer: null,
        homeDir: "/tmp/test",
      };

      await refreshRoutes(state, api);

      console.log("  Routes discovered:", state.knownRoutes);
      console.log("  Logs:", logs);

      // /v1/routes may not be implemented yet — verify graceful degradation.
      // If routes were loaded, check structure. If not, verify no crash.
      if (state.knownRoutes.length > 0) {
        expect(state.knownRoutes.some((r) => r.model === "default")).toBe(true);
      } else {
        // Graceful fallback: stale routes preserved (empty in this case).
        expect(logs.some((l) => l.includes("Failed to fetch routes") || l.includes("Route refresh failed"))).toBe(true);
      }
    });

    it("model interceptor overrides known routes", async () => {
      if (!running) return;

      const config: BitrouterPluginConfig = { interceptAllModels: false };
      const { api } = createMockApi(config);
      const state: BitrouterState = {
        process: null,
        healthy: true,
        baseUrl: BITROUTER_URL,
        knownRoutes: [{ model: "default", provider: "openrouter", protocol: "openai" }],
        healthCheckTimer: null,
        homeDir: "/tmp/test",
      };

      // Register the hook
      registerModelInterceptor(api, config, state);

      // Simulate a before_model_resolve event for a known model
      let overrideResult: { provider: string; model?: string } | null = null;
      const event: ModelResolveEvent = {
        model: "default",
        override(opts) {
          overrideResult = opts;
        },
      };

      // Find and call the registered hook handler
      const hookEntry = (api as any);
      // We need to call the handler that was registered via api.on()
      // Since our mock stores hooks, get it from registrations
      const { registrations } = createMockApi(config);
      // Re-register to capture
      const api2 = createMockApi(config);
      const state2 = { ...state };
      registerModelInterceptor(api2.api, config, state2);

      const hook = api2.registrations.hooks.find(
        (h) => h.event === "before_model_resolve"
      );
      expect(hook).toBeDefined();

      hook!.handler(event);

      expect(overrideResult).toEqual({
        provider: "bitrouter",
        model: "default",
      });
    });

    it("model interceptor ignores unknown models in selective mode", async () => {
      if (!running) return;

      const config: BitrouterPluginConfig = { interceptAllModels: false };
      const { api, registrations } = createMockApi(config);
      const state: BitrouterState = {
        process: null,
        healthy: true,
        baseUrl: BITROUTER_URL,
        knownRoutes: [{ model: "default", provider: "openrouter", protocol: "openai" }],
        healthCheckTimer: null,
        homeDir: "/tmp/test",
      };

      registerModelInterceptor(api, config, state);

      let overrideCalled = false;
      const event: ModelResolveEvent = {
        model: "unknown-model-xyz",
        override() {
          overrideCalled = true;
        },
      };

      registrations.hooks[0].handler(event);
      expect(overrideCalled).toBe(false);
    });

    it("model interceptor routes everything in interceptAll mode", async () => {
      if (!running) return;

      const config: BitrouterPluginConfig = { interceptAllModels: true };
      const { api, registrations } = createMockApi(config);
      const state: BitrouterState = {
        process: null,
        healthy: true,
        baseUrl: BITROUTER_URL,
        knownRoutes: [],
        healthCheckTimer: null,
        homeDir: "/tmp/test",
      };

      registerModelInterceptor(api, config, state);

      let overrideResult: { provider: string; model?: string } | null = null;
      const event: ModelResolveEvent = {
        model: "any-random-model",
        override(opts) {
          overrideResult = opts;
        },
      };

      registrations.hooks[0].handler(event);
      expect(overrideResult).toEqual({
        provider: "bitrouter",
        model: "any-random-model",
      });
    });
  });

  // ── Full plugin activation ──

  describe("activate", () => {
    it("activate registers service, provider, and hook", () => {
      if (!running) return;

      const config: BitrouterPluginConfig = {
        port: 8787,
        host: "127.0.0.1",
        providers: {
          openrouter: {
            derives: "openai",
            apiBase: "https://openrouter.ai/api/v1",
            apiKey: "${OPENROUTER_API_KEY}",
          },
        },
        models: {
          default: {
            strategy: "priority",
            endpoints: [
              { provider: "openrouter", modelId: "anthropic/claude-sonnet-4" },
            ],
          },
        },
      };

      const { api, registrations, logs } = createMockApi(config);

      // Mock child_process to prevent actual process spawning
      vi.mock("node:child_process", () => ({
        spawn: vi.fn(),
        execSync: vi.fn(() => "/usr/local/bin/bitrouter"),
      }));

      activate(api);

      console.log("  Registrations:", {
        services: registrations.services.map((s) => s.id),
        providers: registrations.providers.map((p) => ({ id: p.id, baseUrl: p.baseUrl })),
        hooks: registrations.hooks.map((h) => h.event),
      });
      console.log("  Logs:", logs);

      // Service registered
      expect(registrations.services).toHaveLength(1);
      expect(registrations.services[0].id).toBe("bitrouter");

      // Provider registered
      expect(registrations.providers).toHaveLength(1);
      expect(registrations.providers[0].id).toBe("bitrouter");
      expect(registrations.providers[0].baseUrl).toBe("http://127.0.0.1:8787");

      // Hook registered
      expect(registrations.hooks).toHaveLength(1);
      expect(registrations.hooks[0].event).toBe("before_model_resolve");
    });
  });

  // ── Config generation ──

  describe("config generation", () => {
    it("generates valid YAML config matching the running server", () => {
      const config: BitrouterPluginConfig = {
        port: 8787,
        host: "127.0.0.1",
        providers: {
          openrouter: {
            derives: "openai",
            apiBase: "https://openrouter.ai/api/v1",
            apiKey: "${OPENROUTER_API_KEY}",
          },
        },
        models: {
          default: {
            strategy: "priority",
            endpoints: [
              { provider: "openrouter", modelId: "anthropic/claude-sonnet-4" },
            ],
          },
        },
      };

      const { yaml, envVars } = generateConfig(config);

      console.log("  Generated YAML:\n", yaml);
      console.log("  Env vars:", envVars);

      // Env var references should stay in YAML, not go to envVars
      expect(envVars).toEqual({});
      expect(yaml).toContain("listen: 127.0.0.1:8787");
      expect(yaml).toContain("openrouter");
      expect(yaml).toContain("${OPENROUTER_API_KEY}");
      expect(yaml).toContain("model_id: anthropic/claude-sonnet-4");
      expect(yaml).toContain("strategy: priority");
    });
  });

  // ── Live LLM request through proxy ──

  describe("end-to-end proxy request", () => {
    it("sends a chat completion through BitRouter and gets a response", async () => {
      if (!running) return;

      const res = await fetch(`${BITROUTER_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "default",
          max_tokens: 20,
          messages: [{ role: "user", content: "Respond with exactly: BITROUTER_OK" }],
        }),
      });

      expect(res.ok).toBe(true);
      const body = await res.json() as any;

      console.log("  Response:", JSON.stringify(body, null, 2));

      expect(body.choices).toBeDefined();
      expect(body.choices.length).toBeGreaterThan(0);
      expect(body.choices[0].message.content).toBeTruthy();
      expect(body.model).toContain("claude");
    }, 30_000);
  });
});
