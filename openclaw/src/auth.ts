/**
 * Ed25519 keypair generation and JWT minting for BitRouter auth.
 *
 * BitRouter authenticates API requests via EdDSA-signed JWTs. This module
 * generates an Ed25519 keypair in BitRouter's key format and mints JWTs
 * that the plugin uses to authenticate with the local BitRouter instance.
 *
 * Key format (from bitrouter-core/src/jwt/keys.rs):
 *   master.json: { "algorithm": "eddsa", "secret_key": "<base64url(seed+pubkey)>" }
 *   The 64-byte secret is 32-byte seed + 32-byte public key, base64url-encoded.
 *
 * JWT format (from bitrouter-core/src/jwt/token.rs):
 *   base64url(header).base64url(claims).base64url(signature), no padding.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Base64url helpers ─────────────────────────────────────────────────

function base64urlEncode(buf: Buffer): string {
  return buf.toString("base64url");
}

function base64urlDecode(str: string): Buffer {
  return Buffer.from(str, "base64url");
}

// ── Keypair generation ────────────────────────────────────────────────

export interface Ed25519Keypair {
  publicKey: Buffer;
  privateKey: Buffer;
}

/**
 * Generate a new Ed25519 keypair.
 *
 * Returns raw key buffers: privateKey is the 32-byte seed,
 * publicKey is the 32-byte public key.
 */
export function generateKeypair(): Ed25519Keypair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });

  // Extract raw 32-byte keys from DER encoding.
  // Ed25519 SPKI DER: 12-byte header + 32-byte public key
  // Ed25519 PKCS8 DER: 16-byte header + 34-byte wrapper (2-byte prefix + 32-byte seed)
  const rawPublic = publicKey.subarray(publicKey.length - 32);
  const rawPrivate = privateKey.subarray(privateKey.length - 32);

  return {
    publicKey: Buffer.from(rawPublic),
    privateKey: Buffer.from(rawPrivate),
  };
}

// ── Keypair persistence ───────────────────────────────────────────────

/** Key prefix used for BitRouter's key directory structure. */
const KEY_PREFIX = "openclaw";

/**
 * Save an Ed25519 keypair to BitRouter's key directory format.
 *
 * Writes:
 *   <homeDir>/.keys/<prefix>/master.json — the key in BitRouter format
 *   <homeDir>/.keys/active — the active key prefix
 */
export function saveKeypair(
  homeDir: string,
  publicKey: Buffer,
  privateKey: Buffer
): void {
  const keysDir = path.join(homeDir, ".keys", KEY_PREFIX);
  fs.mkdirSync(keysDir, { recursive: true });

  // BitRouter format: 64-byte secret = 32-byte seed + 32-byte public key
  const secretKey = Buffer.concat([privateKey, publicKey]);

  const masterJson = {
    algorithm: "eddsa",
    secret_key: base64urlEncode(secretKey),
  };

  fs.writeFileSync(
    path.join(keysDir, "master.json"),
    JSON.stringify(masterJson, null, 2) + "\n",
    "utf-8"
  );

  // Write active prefix marker.
  fs.writeFileSync(
    path.join(homeDir, ".keys", "active"),
    KEY_PREFIX + "\n",
    "utf-8"
  );
}

/**
 * Load an existing Ed25519 keypair from the BitRouter key directory.
 *
 * Returns null if no keypair is found.
 */
export function loadKeypair(homeDir: string): Ed25519Keypair | null {
  try {
    // Read the active prefix.
    const activePath = path.join(homeDir, ".keys", "active");
    const prefix = fs.readFileSync(activePath, "utf-8").trim();

    // Read master.json.
    const masterPath = path.join(homeDir, ".keys", prefix, "master.json");
    const masterJson = JSON.parse(fs.readFileSync(masterPath, "utf-8")) as {
      algorithm: string;
      secret_key: string;
    };

    if (masterJson.algorithm !== "eddsa") return null;

    const secretKey = base64urlDecode(masterJson.secret_key);
    if (secretKey.length !== 64) return null;

    return {
      privateKey: Buffer.from(secretKey.subarray(0, 32)),
      publicKey: Buffer.from(secretKey.subarray(32, 64)),
    };
  } catch {
    return null;
  }
}

// ── JWT minting ───────────────────────────────────────────────────────

/**
 * Mint a JWT signed with EdDSA (Ed25519).
 *
 * Produces: base64url(header).base64url(claims).base64url(signature)
 * No padding, per BitRouter's token format.
 */
export function mintJwt(
  privateKey: Buffer,
  publicKey: Buffer,
  claims: Record<string, unknown>
): string {
  const header = { alg: "EdDSA", typ: "JWT" };

  const headerB64 = base64urlEncode(Buffer.from(JSON.stringify(header)));
  const claimsB64 = base64urlEncode(Buffer.from(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${claimsB64}`;

  // Reconstruct the Node.js key object from raw bytes for signing.
  // Ed25519 PKCS8 DER: fixed prefix + 32-byte seed
  const pkcs8Prefix = Buffer.from(
    "302e020100300506032b657004220420",
    "hex"
  );
  const pkcs8Der = Buffer.concat([pkcs8Prefix, privateKey]);
  const keyObject = crypto.createPrivateKey({
    key: pkcs8Der,
    format: "der",
    type: "pkcs8",
  });

  const signature = crypto.sign(null, Buffer.from(signingInput), keyObject);

  return `${signingInput}.${base64urlEncode(signature)}`;
}

// ── High-level API ────────────────────────────────────────────────────

/**
 * Ensure a keypair exists and return a stable API-scope JWT.
 *
 * Idempotent: reuses an existing keypair and cached token if present.
 * The JWT has no iat/exp — the same token is valid for the lifetime of
 * the keypair. This lets OpenClaw store it as a provider credential once
 * and use it across gateway restarts without re-minting.
 *
 * The token is cached at <homeDir>/.keys/<prefix>/tokens/plugin.jwt.
 *
 * @returns The JWT string for authenticating with BitRouter.
 */
export function ensureAuth(homeDir: string): string {
  let keypair = loadKeypair(homeDir);

  if (!keypair) {
    keypair = generateKeypair();
    saveKeypair(homeDir, keypair.publicKey, keypair.privateKey);
  }

  // Try to reuse a previously minted token — same keypair, same token.
  const activePath = path.join(homeDir, ".keys", "active");
  const activePrefix = fs.readFileSync(activePath, "utf-8").trim();
  const tokenPath = path.join(homeDir, ".keys", activePrefix, "tokens", "plugin.jwt");

  try {
    const cached = fs.readFileSync(tokenPath, "utf-8").trim();
    if (cached) return cached;
  } catch {
    // No cached token — mint a fresh one below.
  }

  // Mint a stable JWT: no iat, no exp. Valid for the lifetime of the keypair.
  const jwt = mintJwt(keypair.privateKey, keypair.publicKey, {
    iss: base64urlEncode(keypair.publicKey),
    scope: "api",
  });

  // Cache it for future restarts.
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, jwt + "\n", "utf-8");

  return jwt;
}
