/**
 * Thin wrapper around the `bitrouter` CLI for wallet and token management.
 *
 * Instead of reimplementing keypair generation and JWT signing, we delegate
 * to the bitrouter binary:
 *
 *   `bitrouter wallet`  — manage OWS wallets (create, list, info)
 *   `bitrouter key sign` — mint fresh JWTs signed by a wallet key
 *   `bitrouter auth`    — provider authentication (login, status)
 *
 * This keeps the wallet identity owned by bitrouter (not the plugin) and
 * avoids drift when bitrouter updates its auth format.
 */

import { execFile, spawnSync } from "node:child_process";
import { resolveBinaryPath } from "./binary.js";

/** Default wallet name used by the plugin for automated JWT signing. */
const PLUGIN_WALLET_NAME = "openclaw";

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
 *
 * Sets OWS_PASSPHRASE to empty string when not already in env,
 * so wallet operations work non-interactively (empty passphrase).
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
      {
        timeout: 15_000,
        env: {
          ...process.env,
          // Allow non-interactive wallet/key operations with empty passphrase.
          OWS_PASSPHRASE: process.env.OWS_PASSPHRASE ?? "",
        },
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `bitrouter ${args.join(" ")} failed: ${stderr || err.message}`,
            ),
          );
        } else {
          resolve(stdout.trim());
        }
      },
    );
  });
}

/**
 * Check whether the plugin's OWS wallet exists.
 *
 * Parses `bitrouter wallet list` output and looks for a row whose NAME
 * column matches the plugin wallet name. The CLI also emits a version
 * upgrade notice to stderr, but `wallet list` prints the table to stdout.
 */
export async function hasWallet(
  stateDir: string,
  homeDir: string,
  walletName: string = PLUGIN_WALLET_NAME,
): Promise<boolean> {
  try {
    const output = await runBitrouter(stateDir, homeDir, ["wallet", "list"]);
    // Rows look like: `openclaw              <uuid>   <chains>`.
    // Match the wallet name at the start of a line (possibly after whitespace).
    const pattern = new RegExp(`^\\s*${escapeRegex(walletName)}\\s+`, "m");
    return pattern.test(output);
  } catch {
    return false;
  }
}

/**
 * Escape a string for use in a RegExp.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Create an OWS wallet for the plugin to use for JWT signing.
 *
 * Spawns with `stdio: "inherit"` so `dialoguer::Password` can prompt the
 * user for a passphrase (it requires a TTY — the env var only works for
 * subsequent operations like `key sign`). The user can press Enter twice
 * to accept an empty passphrase.
 */
export async function createWallet(
  stateDir: string,
  homeDir: string,
): Promise<void> {
  const binaryPath = await getBinaryPath(stateDir);
  console.log(
    `\nCreating OWS wallet '${PLUGIN_WALLET_NAME}' for plugin JWT signing.\n` +
      "You'll be prompted for a passphrase — press Enter twice to skip.\n",
  );
  const result = spawnSync(
    binaryPath,
    ["--home-dir", homeDir, "wallet", "create", "--name", PLUGIN_WALLET_NAME],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        OWS_PASSPHRASE: process.env.OWS_PASSPHRASE ?? "",
      },
    },
  );

  if (result.status !== 0) {
    throw new Error(
      `bitrouter wallet create --name ${PLUGIN_WALLET_NAME} exited with code ${result.status}` +
        (result.error ? `: ${result.error.message}` : ""),
    );
  }
}

/**
 * Mint a fresh JWT via `bitrouter key sign`.
 *
 * The token is signed by the named wallet. `key sign` outputs only the
 * raw JWT to stdout.
 *
 * `key sign` prompts interactively for the wallet passphrase via
 * `dialoguer::Password`, so we inherit stdin/stderr to let the user type
 * the passphrase while capturing stdout to read the JWT.
 *
 * @param wallet - Wallet name to sign with.
 * @param exp - Expiration duration (e.g. "1h", "24h", "30d").
 * @param models - Optional model restriction list.
 */
export async function signToken(
  stateDir: string,
  homeDir: string,
  wallet?: string,
  exp?: string,
  models?: string[],
): Promise<string> {
  const walletName = wallet ?? PLUGIN_WALLET_NAME;
  const args = ["--home-dir", homeDir, "key", "sign", "--wallet", walletName];
  if (exp) args.push("--exp", exp);
  if (models && models.length > 0) args.push("--models", models.join(","));

  const binaryPath = await getBinaryPath(stateDir);
  console.log(
    "\nMinting a JWT for OpenClaw. Enter the wallet passphrase if prompted.\n",
  );
  const result = spawnSync(binaryPath, args, {
    // Inherit stdin/stderr so the passphrase prompt reaches the user's
    // terminal; pipe stdout so we can capture the JWT.
    stdio: ["inherit", "pipe", "inherit"],
    env: {
      ...process.env,
      OWS_PASSPHRASE: process.env.OWS_PASSPHRASE ?? "",
    },
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    throw new Error(
      `bitrouter key sign --wallet ${walletName} exited with code ${result.status}` +
        (result.error ? `: ${result.error.message}` : ""),
    );
  }

  const token = (result.stdout ?? "").trim();
  if (!token) {
    throw new Error(`bitrouter key sign returned empty token`);
  }
  return token;
}

/**
 * Run `bitrouter auth login [provider]` for provider authentication.
 *
 * When provider is specified, authenticates that single provider.
 * Without provider, runs the interactive multi-provider selection.
 *
 * Note: this requires an interactive terminal for most providers.
 */
export async function authLogin(
  stateDir: string,
  homeDir: string,
  provider?: string,
): Promise<string> {
  const args = ["auth", "login"];
  if (provider) args.push(provider);

  return runBitrouter(stateDir, homeDir, args);
}

/**
 * Get provider auth status via `bitrouter auth status`.
 */
export async function authStatus(
  stateDir: string,
  homeDir: string,
): Promise<string> {
  return runBitrouter(stateDir, homeDir, ["auth", "status"]);
}

/**
 * Ensure an OWS wallet exists, creating one if needed.
 * Then mint an API token for authenticating with the local BitRouter instance.
 *
 * This is the main entry point for plugin auth setup.
 */
export async function ensureAuthViaCli(
  stateDir: string,
  homeDir: string,
): Promise<{ apiToken: string }> {
  // Ensure a wallet exists.
  if (!(await hasWallet(stateDir, homeDir))) {
    await createWallet(stateDir, homeDir);
  }

  // Mint a fresh API token — uses OWS_PASSPHRASE env for non-interactive signing.
  const apiToken = await signToken(
    stateDir,
    homeDir,
    PLUGIN_WALLET_NAME,
    "30d",
  );

  return { apiToken };
}
