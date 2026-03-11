/**
 * Service lifecycle — manages the BitRouter daemon as a child process.
 *
 * Registers a service with OpenClaw's plugin API so BitRouter starts
 * automatically when OpenClaw starts and stops when OpenClaw stops.
 *
 * The service:
 * 1. Generates bitrouter.yaml from plugin config (via config.ts)
 * 2. Resolves the bitrouter binary (auto-downloads from GitHub releases if needed)
 * 3. Spawns `bitrouter --home-dir <dir> serve` as a child process
 * 4. Waits for the health endpoint to respond
 * 5. Starts the periodic health check loop
 *
 * On stop, sends SIGTERM → waits up to 10s → SIGKILL as fallback.
 */

import { spawn, type ChildProcess } from "node:child_process";

import type {
  BitrouterPluginConfig,
  BitrouterState,
  OpenClawPluginApi,
} from "./types.js";
import { DEFAULTS } from "./types.js";
import { writeConfigToDir, resolveHomeDir } from "./config.js";
import { startHealthCheck, stopHealthCheck, waitForReady } from "./health.js";
import { refreshRoutes } from "./routing.js";
import { refreshMetrics } from "./metrics.js";
import { resolveBinaryPath } from "./binary.js";

// ── Service registration ─────────────────────────────────────────────

/**
 * Register the BitRouter daemon as an OpenClaw managed service.
 */
export function registerBitrouterService(
  api: OpenClawPluginApi,
  config: BitrouterPluginConfig,
  state: BitrouterState
): void {
  api.registerService({
    id: "bitrouter",

    start: async () => {
      // 1. Resolve home directory and write config files.
      state.homeDir = resolveHomeDir(api);
      writeConfigToDir(config, state.homeDir);
      api.log.info(`Config written to ${state.homeDir}`);

      // 2. Find the binary (downloads from GitHub releases if not cached).
      let binaryPath: string;
      try {
        const dataDir = api.getDataDir();
        binaryPath = await resolveBinaryPath(dataDir);
      } catch (err) {
        api.log.error(`${err}`);
        throw err;
      }
      api.log.info(`Using binary: ${binaryPath}`);

      // 3. Spawn the process.
      //
      // Key: detached is false — the plugin owns the process lifecycle.
      // If OpenClaw stops, the child process is cleaned up via stop().
      //
      // The --home-dir flag ensures BitRouter reads our generated config
      // rather than any user-level ~/.bitrouter config.
      const child = spawn(binaryPath, ["--home-dir", state.homeDir, "serve"], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });

      state.process = child;

      // Pipe stdout/stderr to the plugin logger.
      child.stdout?.on("data", (data: Buffer) => {
        const line = data.toString().trim();
        if (line) api.log.info(`[bitrouter] ${line}`);
      });

      child.stderr?.on("data", (data: Buffer) => {
        const line = data.toString().trim();
        if (line) api.log.warn(`[bitrouter] ${line}`);
      });

      // Handle unexpected exits.
      child.on("exit", (code, signal) => {
        state.process = null;
        state.healthy = false;
        stopHealthCheck(state);

        if (code !== null && code !== 0) {
          api.log.error(
            `BitRouter exited with code ${code}` +
              (signal ? ` (signal: ${signal})` : "")
          );
        }
      });

      // 4. Wait for readiness.
      const ready = await waitForReady(state);
      if (!ready) {
        // Process may have crashed — check if still alive.
        if (state.process === null) {
          throw new Error(
            "BitRouter process exited before becoming healthy. " +
              `Check logs in ${state.homeDir}/logs/`
          );
        }
        api.log.warn(
          "BitRouter did not become healthy within timeout — " +
            "continuing with health checks"
        );
      } else {
        state.healthy = true;
        api.log.info("BitRouter is ready");

        // Load the initial routing table and metrics.
        await refreshRoutes(state, api);
        await refreshMetrics(state, api, config);
      }

      // 5. Start periodic health checks.
      startHealthCheck(api, config, state);
    },

    stop: async () => {
      // Stop health checks first.
      stopHealthCheck(state);

      const child = state.process;
      if (!child) return;

      // Send SIGTERM for graceful shutdown.
      child.kill("SIGTERM");

      // Wait for the process to exit.
      const exited = await waitForExit(child, DEFAULTS.stopTimeoutMs);

      if (!exited) {
        // Escalate to SIGKILL.
        api.log.warn("BitRouter did not exit gracefully — sending SIGKILL");
        child.kill("SIGKILL");
        await waitForExit(child, 3_000);
      }

      state.process = null;
      state.healthy = false;
      api.log.info("BitRouter stopped");
    },
  });
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Wait for a child process to emit the 'exit' event. */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(false);
      }
    }, timeoutMs);

    child.on("exit", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
}
