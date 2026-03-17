/**
 * Thin wrapper around the `bitrouter` CLI for account and token management.
 *
 * Instead of reimplementing keypair generation and JWT signing (which the
 * plugin previously did in auth.ts), we delegate to the bitrouter binary:
 *
 *   `bitrouter account`  — manage wallet keypairs
 *   `bitrouter keygen`   — mint fresh JWTs signed by the active account key
 *   `bitrouter keys`     — list/inspect saved tokens
 *
 * This keeps the wallet identity owned by bitrouter (not the plugin) and
 * avoids drift when bitrouter updates its auth format.
 */

import { execFile } from "node:child_process";
import { resolveBinaryPath } from "./binary.js";

/** Cached binary path — resolved once per process. */
let cachedBinaryPath: string | null = null;

/** State dir used for binary resolution. */
let cachedStateDir: string | null = null;

/**
 * Resolve the bitrouter binary path, caching it for the process lifetime.
 */
async function getBinaryPath(stateDir: string): Promise<string> {
  if (cachedBinaryPath && cachedStateDir === stateDir) {
    return cachedBinaryPath;
  }
  cachedBinaryPath = await resolveBinaryPath(stateDir);
  cachedStateDir = stateDir;
  return cachedBinaryPath;
}

/**
 * Run a bitrouter CLI command and return stdout.
 */
async function runBitrouter(
  stateDir: string,
  homeDir: string,
  args: string[],
): Promise<string> {
  const binaryPath = await getBinaryPath(stateDir);
  return new Promise((resolve, reject) => {
    execFile(
      binaryPath,
      ["--home-dir", homeDir, ...args],
      { timeout: 10_000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`bitrouter ${args.join(" ")} failed: ${stderr || err.message}`));
        } else {
          resolve(stdout.trim());
        }
      },
    );
  });
}

/**
 * Check whether the bitrouter CLI has an active account keypair.
 *
 * Returns true if `bitrouter account --list` shows at least one key
 * with an active marker.
 */
export async function hasActiveAccount(
  stateDir: string,
  homeDir: string,
): Promise<boolean> {
  try {
    const output = await runBitrouter(stateDir, homeDir, ["account", "--list"]);
    // The list output marks the active key with "*"
    return output.includes("*");
  } catch {
    return false;
  }
}

/**
 * Generate a new account keypair via `bitrouter account --generate-key`.
 *
 * This is a non-interactive operation — the CLI creates the key and
 * sets it as active immediately.
 */
export async function generateAccount(
  stateDir: string,
  homeDir: string,
): Promise<void> {
  await runBitrouter(stateDir, homeDir, ["account", "--generate-key"]);
}

/**
 * Mint a fresh JWT for the given scope via `bitrouter keygen`.
 *
 * The token is signed by the active account key. Each call produces
 * a fresh token (no caching in the CLI).
 *
 * @param scope - "api" or "admin"
 * @param exp - Expiration (e.g. "1h", "24h", "never"). Required for admin scope.
 * @param name - Optional label to save the token locally in bitrouter's key store.
 */
export async function mintToken(
  stateDir: string,
  homeDir: string,
  scope: "api" | "admin",
  exp?: string,
  name?: string,
): Promise<string> {
  const args = ["keygen", "--scope", scope];
  if (exp) args.push("--exp", exp);
  if (name) args.push("--name", name);

  const token = await runBitrouter(stateDir, homeDir, args);
  if (!token) {
    throw new Error(`bitrouter keygen returned empty token (scope=${scope})`);
  }
  return token;
}

/**
 * Ensure an active account exists, creating one if needed.
 * Then mint API and admin tokens.
 *
 * This is the main entry point replacing the old ensureAuth().
 */
export async function ensureAuthViaCli(
  stateDir: string,
  homeDir: string,
): Promise<{ apiToken: string; adminToken: string }> {
  // Ensure an account keypair exists.
  if (!(await hasActiveAccount(stateDir, homeDir))) {
    await generateAccount(stateDir, homeDir);
  }

  // Mint fresh tokens — cheap local crypto operation.
  const [apiToken, adminToken] = await Promise.all([
    mintToken(stateDir, homeDir, "api"),
    mintToken(stateDir, homeDir, "admin", "24h"),
  ]);

  return { apiToken, adminToken };
}
