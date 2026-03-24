/**
 * Binary resolution — downloads and caches the BitRouter binary from GitHub
 * releases, or falls back to finding it on $PATH.
 *
 * Resolution order:
 * 1. Cached binary in the plugin's data directory ({dataDir}/bin/bitrouter)
 * 2. Auto-download from GitHub releases (cached for future use)
 * 3. `bitrouter` on $PATH (for users who installed manually)
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  chmodSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

const BITROUTER_VERSION = "0.12.0";

const GITHUB_DOWNLOAD_BASE = `https://github.com/bitrouter/bitrouter/releases/download/v${BITROUTER_VERSION}`;

/**
 * Check if a cached binary matches the expected version.
 * Returns true if the version matches, false otherwise.
 */
function checkBinaryVersion(binaryPath: string): boolean {
  try {
    const output = execSync(`"${binaryPath}" --version`, {
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();
    // Output is typically "bitrouter X.Y.Z" or just "X.Y.Z"
    return output.includes(BITROUTER_VERSION);
  } catch {
    return false;
  }
}

/**
 * Map Node.js platform/arch to the GitHub release asset name.
 */
function getAssetName(): string {
  const { platform, arch } = process;

  const archMap: Record<string, string> = {
    arm64: "aarch64",
    x64: "x86_64",
  };

  const rustArch = archMap[arch];
  if (!rustArch) {
    throw new Error(`Unsupported architecture: ${arch}`);
  }

  switch (platform) {
    case "darwin":
      return `bitrouter-${rustArch}-apple-darwin.tar.gz`;
    case "linux":
      return `bitrouter-${rustArch}-unknown-linux-gnu.tar.gz`;
    case "win32":
      return `bitrouter-${rustArch}-pc-windows-msvc.zip`;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

/**
 * Download and extract the BitRouter binary to the given directory.
 */
async function downloadBinary(binDir: string): Promise<string> {
  const asset = getAssetName();
  const url = `${GITHUB_DOWNLOAD_BASE}/${asset}`;
  const binaryName = process.platform === "win32" ? "bitrouter.exe" : "bitrouter";
  const binaryPath = join(binDir, binaryName);
  const archivePath = join(binDir, asset);

  mkdirSync(binDir, { recursive: true });

  // Download the archive.
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  writeFileSync(archivePath, buffer);

  try {
    // Extract using system tar (available on macOS, Linux, and modern Windows).
    execSync(`tar -xzf "${archivePath}" -C "${binDir}"`, { timeout: 30_000 });
  } finally {
    // Clean up the archive.
    try {
      unlinkSync(archivePath);
    } catch {
      // Non-critical.
    }
  }

  // Ensure the binary is executable.
  if (process.platform !== "win32") {
    chmodSync(binaryPath, 0o755);
  }

  if (!existsSync(binaryPath)) {
    throw new Error(
      `Download succeeded but binary not found at ${binaryPath}. ` +
        `Archive may have an unexpected structure.`
    );
  }

  return binaryPath;
}

/**
 * Resolve the BitRouter binary path.
 *
 * @param dataDir - The plugin's persistent data directory (from api.getDataDir()).
 *                  Pass `null` to skip cached/download resolution and only check PATH.
 */
export async function resolveBinaryPath(dataDir: string | null): Promise<string> {
  const binaryName = process.platform === "win32" ? "bitrouter.exe" : "bitrouter";

  // Try 1: Cached binary in data directory.
  if (dataDir) {
    const binDir = join(dataDir, "bin");
    const cachedPath = join(binDir, binaryName);

    if (existsSync(cachedPath)) {
      // Verify version matches — re-download if mismatched.
      if (checkBinaryVersion(cachedPath)) {
        return cachedPath;
      }
      // Version mismatch — remove stale binary and re-download.
      try {
        unlinkSync(cachedPath);
      } catch {
        // Non-critical.
      }
    }

    // Try 2: Download from GitHub releases.
    try {
      return await downloadBinary(binDir);
    } catch {
      // Download failed — fall through to PATH.
    }
  }

  // Try 3: binary on PATH.
  try {
    const cmd = process.platform === "win32" ? "where bitrouter" : "which bitrouter";
    const result = execSync(cmd, {
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();
    if (result) return result.split("\n")[0];
  } catch {
    // Not on PATH — fall through.
  }

  throw new Error(
    "BitRouter binary not found.\n" +
      `Automatic download from GitHub releases (v${BITROUTER_VERSION}) failed.\n` +
      "You can install it manually:\n" +
      `  Download from: ${GITHUB_DOWNLOAD_BASE}\n` +
      "  Or: cargo install bitrouter\n" +
      "\n" +
      "Then ensure `bitrouter` is on your $PATH."
  );
}
