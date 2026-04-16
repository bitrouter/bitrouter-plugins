/**
 * BitRouter first-run setup wizard.
 *
 * Runs inside the `openclaw models auth login --provider bitrouter` flow.
 *
 * Always delegates to the `bitrouter auth login` CLI command — either
 * the system-installed binary on PATH or the plugin's bundled copy.
 * The native CLI handles wallet creation, provider auth (API key + OAuth),
 * and config generation with its own interactive prompts, so we avoid
 * duplicating the provider-picker UI here.
 *
 * On success, returns a ProviderAuthResult whose `configPatch` writes
 * `mode` into `plugins.entries.bitrouter.config` in openclaw.json, and
 * a JWT credential for authenticating with the local BitRouter instance.
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";

import type {
  ProviderAuthContext,
  ProviderAuthResult,
  SetupMode,
} from "./types.js";
import { DEFAULTS } from "./types.js";
import { ensureAuthViaCli } from "./bitrouter-cli.js";
import { resolveBinaryPath } from "./binary.js";

// ── BYOK wizard ──────────────────────────────────────────────────────

/**
 * Run the auth setup wizard.
 *
 * Registered as the "byok" ProviderAuthMethod on the "bitrouter" provider.
 * Called by: `openclaw models auth login --provider bitrouter`
 *
 * Always delegates to `bitrouter auth login` — the native CLI handles
 * wallet creation, provider selection, API key entry, and OAuth device
 * flows with its own interactive prompts. We resolve the binary from
 * PATH first, then fall back to the plugin's bundled/downloaded copy.
 *
 * After `bitrouter auth login` completes, mints a JWT for OpenClaw's
 * credential store.
 */
export async function byokWizard(
  ctx: ProviderAuthContext,
): Promise<ProviderAuthResult> {
  const stateDir =
    ctx.workspaceDir ?? `${os.homedir()}/.openclaw/plugins/bitrouter`;
  const homeDir = resolveSetupHomeDir(ctx);

  const binaryPath = await resolveBinaryPath(stateDir);

  const result = spawnSync(
    binaryPath,
    ["--home-dir", homeDir, "auth", "login"],
    { stdio: "inherit" },
  );

  if (result.status !== 0) {
    throw new Error(
      `bitrouter auth login exited with code ${result.status}` +
        (result.error ? `: ${result.error.message}` : ""),
    );
  }

  // Mint a JWT so OpenClaw can authenticate with the local instance.
  const { apiToken: jwt } = await ensureAuthViaCli(stateDir, homeDir);

  // Start the BitRouter daemon so it's running immediately after setup.
  // `bitrouter start` is idempotent — if the daemon is already running
  // it will report that and exit cleanly.
  console.log("\nStarting BitRouter daemon...\n");
  const startResult = spawnSync(binaryPath, ["--home-dir", homeDir, "start"], {
    stdio: "inherit",
  });
  if (startResult.status !== 0) {
    console.warn(
      `\nWarning: bitrouter start exited with code ${startResult.status}. ` +
        "You can start it manually with: bitrouter start\n",
    );
  }

  const bitrouterApiBase = `http://${DEFAULTS.host}:${DEFAULTS.port}/v1`;

  return {
    profiles: [
      {
        profileId: "bitrouter:default",
        credential: {
          type: "api_key" as const,
          provider: "bitrouter",
          key: jwt,
        },
      },
    ],
    configPatch: {
      plugins: {
        entries: {
          bitrouter: {
            config: {
              mode: "byok" satisfies SetupMode,
            },
          },
        },
      },
      models: {
        mode: "merge" as const,
        providers: {
          bitrouter: {
            baseUrl: bitrouterApiBase,
            models: [],
          },
        },
      },
    },
    notes: [
      "BitRouter configured and daemon started.",
      "Restart the gateway to activate: openclaw gateway restart",
    ],
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Resolve the BitRouter home directory from auth context.
 *
 * Uses ctx.stateDir when available (matches config.ts resolveHomeDir).
 * Falls back to ~/.openclaw/bitrouter for the common dev-install case.
 */
function resolveSetupHomeDir(ctx: ProviderAuthContext): string {
  // stateDir is set by OpenClaw's service runner and matches what
  // config.ts resolveHomeDir(api) produces via api.getDataDir().
  if (ctx.workspaceDir) {
    return path.join(ctx.workspaceDir, "bitrouter");
  }
  return path.join(os.homedir(), ".openclaw", "bitrouter");
}
