/**
 * Service lifecycle — manages the BitRouter daemon as a child process.
 *
 * Registers a service with OpenClaw's plugin API so BitRouter starts
 * automatically when OpenClaw starts and stops when OpenClaw stops.
 *
 * The service:
 * 1. Generates bitrouter.yaml from plugin config (via config.ts)
 * 2. Resolves the bitrouter binary (via @bitrouter/cli npm package or PATH)
 * 3. Spawns `bitrouter --home-dir <dir> serve` as a child process
 * 4. Waits for the health endpoint to respond
 * 5. Starts the periodic health check loop
 *
 * On stop, sends SIGTERM → waits up to 10s → SIGKILL as fallback.
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  BitrouterPluginConfig,
  BitrouterState,
  OpenClawPluginApi,
} from "./types.js";
import { DEFAULTS } from "./types.js";
import { writeConfigToDir, resolveHomeDir } from "./config.js";
import { startHealthCheck, stopHealthCheck, waitForReady } from "./health.js";
import { refreshRoutes } from "./routing.js";

// ── Binary resolution ────────────────────────────────────────────────

/**
 * Find the bitrouter binary.
 *
 * Resolution order:
 * 1. BITROUTER_BIN environment variable (explicit override)
 * 2. Sibling local build (../bitrouter/target/{release,debug}/bitrouter
 *    relative to the package root — for local development)
 * 3. @bitrouter/cli npm package (installed via cargo-dist, provides
 *    platform-specific binaries like esbuild's approach)
 * 4. `bitrouter` on $PATH (for users who installed via cargo install)
 *
 * Throws a descriptive error if none is available.
 */
function resolveBinaryPath(): string {
  // Try 1: explicit env var override.
  const envBin = process.env.BITROUTER_BIN;
  if (envBin) return envBin;

  // Try 2: sibling local build (for local development).
  // Package root is one level up from dist/ (where __dirname points).
  const packageRoot = resolve(__dirname, "..");
  for (const profile of ["release", "debug"]) {
    const candidate = resolve(
      packageRoot,
      "..",
      "bitrouter",
      "target",
      profile,
      "bitrouter"
    );
    if (existsSync(candidate)) return candidate;
  }

  // Try 3: npm package (@bitrouter/cli published by cargo-dist).
  try {
    // The package exports the path to the platform-specific binary.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cli = require("@bitrouter/cli") as { getBinaryPath: () => string };
    return cli.getBinaryPath();
  } catch {
    // Package not installed or doesn't export getBinaryPath — fall through.
  }

  // Try 4: binary on PATH.
  try {
    const result = execSync("which bitrouter", {
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();
    if (result) return result;
  } catch {
    // Not on PATH — fall through.
  }

  throw new Error(
    "BitRouter binary not found.\n" +
      "Install it with one of:\n" +
      "  cargo build (in sibling ../bitrouter dir)  # local development\n" +
      "  npm install @bitrouter/cli          # recommended (via cargo-dist)\n" +
      "  cargo install bitrouter             # from source\n" +
      "  cargo binstall bitrouter            # pre-built binary\n" +
      "\n" +
      "Or set BITROUTER_BIN=/path/to/bitrouter or ensure `bitrouter` is on your $PATH."
  );
}

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

      // 2. Find the binary.
      let binaryPath: string;
      try {
        binaryPath = resolveBinaryPath();
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

        // Load the initial routing table.
        await refreshRoutes(state, api);
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
