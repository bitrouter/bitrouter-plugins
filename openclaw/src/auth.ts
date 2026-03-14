/**
 * Multi-chain keypair generation and JWT minting for BitRouter auth.
 *
 * Supports two signing schemes (matching bitrouter-core v0.7):
 *
 *   Solana (SOL_EDDSA):
 *     - Ed25519 signing over raw message bytes.
 *     - Public key encoded as base58 (Solana address).
 *     - master.json: { algorithm: "web3", seed: "<base64url(32-byte seed)>" }
 *     - JWT iss: "solana:<chain-id>:<base58-pubkey>"
 *
 *   EVM (EIP191K):
 *     - secp256k1 ECDSA with EIP-191 message prefix.
 *     - Address is checksummed 0x-prefixed hex (last 20 bytes of keccak256(pubkey)).
 *     - master.json: { algorithm: "evm", seed: "<base64url(32-byte seed)>" }
 *     - JWT iss: "eip155:<chain-id>:<0x-address>"
 *
 * Default chain IDs:
 *   Solana mainnet: 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp
 *   EVM (Base):     8453
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

import type { ChainType } from "./types.js";

// ── Constants ─────────────────────────────────────────────────────────

/** Solana mainnet genesis hash prefix. */
const SOLANA_CHAIN_ID = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

/** Base L2 chain ID (default EVM chain). */
const EVM_CHAIN_ID = "8453";

/** PKCS8 DER prefix for a bare Ed25519 private key seed (RFC 8410). */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

// ── Base64url helpers ─────────────────────────────────────────────────

function base64urlEncode(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

function base64urlDecode(str: string): Buffer {
  return Buffer.from(str, "base64url");
}

// ── Base58 encode (Solana address format) ─────────────────────────────

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(buf: Buffer): string {
  let n = BigInt("0x" + buf.toString("hex"));
  let out = "";
  while (n > 0n) {
    out = BASE58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of buf) {
    if (byte === 0) out = "1" + out;
    else break;
  }
  return out;
}

// ── EIP-55 checksummed address ────────────────────────────────────────

function toChecksumAddress(address: Uint8Array): string {
  const hex = Buffer.from(address).toString("hex");
  const hash = Buffer.from(keccak_256(Buffer.from(hex, "ascii"))).toString("hex");
  let checksummed = "0x";
  for (let i = 0; i < hex.length; i++) {
    checksummed += parseInt(hash[i], 16) >= 8 ? hex[i].toUpperCase() : hex[i];
  }
  return checksummed;
}

// ── Keypair types ─────────────────────────────────────────────────────

export interface Keypair {
  /** Which chain this keypair is for. */
  chain: ChainType;
  /** Raw 32-byte seed / private key. */
  seed: Buffer;
  /** Raw public key bytes (32 bytes for Ed25519, 33 bytes compressed for secp256k1). */
  publicKey: Buffer;
  /** On-chain address (base58 for Solana, checksummed 0x-hex for EVM). */
  address: string;
}

// ── Solana keypair derivation ─────────────────────────────────────────

function deriveSolanaPublicKey(seed: Buffer): { publicKey: Buffer; address: string } {
  const pkcs8Der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  const privKey = crypto.createPrivateKey({ key: pkcs8Der, format: "der", type: "pkcs8" });
  const pubKeyObj = crypto.createPublicKey(privKey);
  const spki = pubKeyObj.export({ type: "spki", format: "der" }) as Buffer;
  const publicKey = Buffer.from(spki.subarray(spki.length - 32));
  return { publicKey, address: base58Encode(publicKey) };
}

// ── EVM keypair derivation ────────────────────────────────────────────

function deriveEvmPublicKey(seed: Buffer): { publicKey: Buffer; address: string } {
  // Uncompressed public key (65 bytes: 0x04 || x || y).
  const uncompressed = secp256k1.getPublicKey(seed, false);
  // keccak256 of the 64-byte public key (skip the 0x04 prefix).
  const hash = keccak_256(uncompressed.subarray(1));
  // Last 20 bytes = Ethereum address.
  const addressBytes = hash.subarray(hash.length - 20);
  const address = toChecksumAddress(addressBytes);
  // Store compressed public key (33 bytes) for space efficiency.
  const compressed = secp256k1.getPublicKey(seed, true);
  return { publicKey: Buffer.from(compressed), address };
}

// ── Keypair generation ────────────────────────────────────────────────

/**
 * Generate a new keypair for the given chain.
 * Defaults to Solana for backward compatibility.
 */
export function generateKeypair(chain: ChainType = "solana"): Keypair {
  const seed = crypto.randomBytes(32);
  if (chain === "evm") {
    const { publicKey, address } = deriveEvmPublicKey(seed);
    return { chain, seed, publicKey, address };
  }
  const { publicKey, address } = deriveSolanaPublicKey(seed);
  return { chain, seed, publicKey, address };
}

// ── Keypair persistence ───────────────────────────────────────────────

/** Key prefix used for BitRouter's key directory structure. */
const KEY_PREFIX = "openclaw";

/**
 * Save a keypair to BitRouter's key directory.
 *
 * Writes:
 *   <homeDir>/.keys/<prefix>/master.json
 *   <homeDir>/.keys/active
 */
export function saveKeypair(homeDir: string, keypair: Keypair): void {
  const keysDir = path.join(homeDir, ".keys", KEY_PREFIX);
  fs.mkdirSync(keysDir, { recursive: true });

  const masterJson = keypair.chain === "evm"
    ? { algorithm: "evm", seed: base64urlEncode(keypair.seed) }
    : { algorithm: "web3", seed: base64urlEncode(keypair.seed) };

  fs.writeFileSync(
    path.join(keysDir, "master.json"),
    JSON.stringify(masterJson, null, 2) + "\n",
    "utf-8"
  );

  fs.writeFileSync(
    path.join(homeDir, ".keys", "active"),
    KEY_PREFIX + "\n",
    "utf-8"
  );
}

/**
 * Load an existing keypair from BitRouter's key directory.
 *
 * Supports:
 *   - "web3" format (Solana Ed25519, v0.5+)
 *   - "evm" format (secp256k1, v0.7+)
 *   - Legacy "eddsa" format (v0.4.x)
 *
 * Returns null if no valid keypair is found.
 */
export function loadKeypair(homeDir: string): Keypair | null {
  try {
    const activePath = path.join(homeDir, ".keys", "active");
    const prefix = fs.readFileSync(activePath, "utf-8").trim();

    const masterPath = path.join(homeDir, ".keys", prefix, "master.json");
    const masterJson = JSON.parse(fs.readFileSync(masterPath, "utf-8")) as {
      algorithm: string;
      seed?: string;
      secret_key?: string;
    };

    let seed: Buffer;
    let chain: ChainType;

    if (masterJson.algorithm === "evm" && masterJson.seed) {
      seed = base64urlDecode(masterJson.seed);
      if (seed.length !== 32) return null;
      chain = "evm";
    } else if (masterJson.algorithm === "web3" && masterJson.seed) {
      seed = base64urlDecode(masterJson.seed);
      if (seed.length !== 32) return null;
      chain = "solana";
    } else if (masterJson.algorithm === "eddsa" && masterJson.secret_key) {
      // Legacy v0.4.x format: 64-byte seed+pubkey, first 32 bytes = seed.
      const secretKey = base64urlDecode(masterJson.secret_key);
      if (secretKey.length !== 64) return null;
      seed = Buffer.from(secretKey.subarray(0, 32));
      chain = "solana";
    } else {
      return null;
    }

    const derive = chain === "evm" ? deriveEvmPublicKey : deriveSolanaPublicKey;
    const { publicKey, address } = derive(seed);
    return { chain, seed, publicKey, address };
  } catch {
    return null;
  }
}

// ── JWT minting ───────────────────────────────────────────────────────

/**
 * Mint a JWT for the given keypair.
 *
 * Automatically selects the signing algorithm based on keypair.chain:
 *   - Solana: SOL_EDDSA (Ed25519 over raw message bytes)
 *   - EVM:    EIP191K (EIP-191 prefixed secp256k1 ECDSA)
 */
export function mintJwt(
  keypair: Keypair,
  claims: Record<string, unknown>
): string {
  if (keypair.chain === "evm") {
    return mintEvmJwt(keypair, claims);
  }
  return mintSolanaJwt(keypair, claims);
}

function mintSolanaJwt(
  keypair: Keypair,
  claims: Record<string, unknown>
): string {
  const header = { alg: "SOL_EDDSA", typ: "JWT" };

  const fullClaims = {
    iss: `solana:${SOLANA_CHAIN_ID}:${keypair.address}`,
    chain: `solana:${SOLANA_CHAIN_ID}`,
    ...claims,
  };

  const headerB64 = base64urlEncode(Buffer.from(JSON.stringify(header)));
  const claimsB64 = base64urlEncode(Buffer.from(JSON.stringify(fullClaims)));
  const signingInput = `${headerB64}.${claimsB64}`;

  const pkcs8Der = Buffer.concat([PKCS8_ED25519_PREFIX, keypair.seed]);
  const keyObject = crypto.createPrivateKey({ key: pkcs8Der, format: "der", type: "pkcs8" });
  const signature = crypto.sign(null, Buffer.from(signingInput), keyObject);

  return `${signingInput}.${base64urlEncode(signature)}`;
}

function mintEvmJwt(
  keypair: Keypair,
  claims: Record<string, unknown>
): string {
  const header = { alg: "EIP191K", typ: "JWT" };

  const fullClaims = {
    iss: `eip155:${EVM_CHAIN_ID}:${keypair.address}`,
    chain: `eip155:${EVM_CHAIN_ID}`,
    ...claims,
  };

  const headerB64 = base64urlEncode(Buffer.from(JSON.stringify(header)));
  const claimsB64 = base64urlEncode(Buffer.from(JSON.stringify(fullClaims)));
  const signingInput = `${headerB64}.${claimsB64}`;

  // EIP-191 personal sign: prefix the message, then keccak256, then secp256k1 sign.
  const messageBytes = Buffer.from(signingInput);
  const prefix = Buffer.from(`\x19Ethereum Signed Message:\n${messageBytes.length}`);
  const prefixedMessage = Buffer.concat([prefix, messageBytes]);
  const messageHash = keccak_256(prefixedMessage);

  const sig = secp256k1.sign(messageHash, keypair.seed);
  // Signature format: r (32 bytes) || s (32 bytes) || v (1 byte).
  // v = recovery param + 27 (Ethereum convention).
  const r = Buffer.from(sig.toCompactRawBytes().subarray(0, 32));
  const s = Buffer.from(sig.toCompactRawBytes().subarray(32, 64));
  const v = Buffer.from([sig.recovery + 27]);
  const signature = Buffer.concat([r, s, v]);

  return `${signingInput}.${base64urlEncode(signature)}`;
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Decode the `exp` claim from a JWT without verifying the signature.
 * Returns null if the token is malformed or has no exp claim.
 */
function decodeExp(jwt: string): number | null {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as { exp?: number };
    return claims.exp ?? null;
  } catch {
    return null;
  }
}

// ── High-level API ────────────────────────────────────────────────────

/**
 * Ensure a keypair exists in the homeDir and return both API-scope
 * and admin-scope JWTs.
 *
 * If the requested chain doesn't match the stored keypair's chain,
 * a new keypair is generated for the requested chain.
 *
 * API token:   scope "api",   no expiry, cached at tokens/plugin.jwt.
 * Admin token: scope "admin", 24h expiry, cached at tokens/admin.jwt,
 *              re-minted when within 1h of expiry.
 */
export function ensureAuth(
  homeDir: string,
  chain: ChainType = "solana"
): { apiToken: string; adminToken: string } {
  let keypair = loadKeypair(homeDir);

  // Regenerate if missing, legacy format, or chain mismatch.
  const needsRegen = !keypair || keypair.chain !== chain || (() => {
    try {
      const activePath = path.join(homeDir, ".keys", "active");
      const prefix = fs.readFileSync(activePath, "utf-8").trim();
      const masterPath = path.join(homeDir, ".keys", prefix, "master.json");
      const m = JSON.parse(fs.readFileSync(masterPath, "utf-8")) as { algorithm?: string };
      // Legacy "eddsa" format should be regenerated.
      return m.algorithm === "eddsa";
    } catch {
      return false;
    }
  })();

  if (needsRegen) {
    keypair = generateKeypair(chain);
    saveKeypair(homeDir, keypair);
  }

  const activePath = path.join(homeDir, ".keys", "active");
  const activePrefix = fs.readFileSync(activePath, "utf-8").trim();
  const tokensDir = path.join(homeDir, ".keys", activePrefix, "tokens");

  // ── API token (stable, no expiry) ──
  const apiTokenPath = path.join(tokensDir, "plugin.jwt");
  let apiToken: string | undefined;

  // Only reuse cached token if chain matches (check the alg in the header).
  try {
    const cached = fs.readFileSync(apiTokenPath, "utf-8").trim();
    if (cached && isTokenForChain(cached, chain)) {
      apiToken = cached;
    }
  } catch {
    // No cached token — mint below.
  }

  if (!apiToken) {
    apiToken = mintJwt(keypair!, { scope: "api" });
    fs.mkdirSync(path.dirname(apiTokenPath), { recursive: true });
    fs.writeFileSync(apiTokenPath, apiToken + "\n", "utf-8");
  }

  // ── Admin token (24h expiry, refresh when within 1h of expiry) ──
  const adminTokenPath = path.join(tokensDir, "admin.jwt");
  let adminToken: string | undefined;

  try {
    const cached = fs.readFileSync(adminTokenPath, "utf-8").trim();
    if (cached && isTokenForChain(cached, chain)) {
      const exp = decodeExp(cached);
      const now = Math.floor(Date.now() / 1000);
      if (exp && exp - now > 3600) {
        adminToken = cached;
      }
    }
  } catch {
    // No cached token — mint below.
  }

  if (!adminToken) {
    const now = Math.floor(Date.now() / 1000);
    adminToken = mintJwt(keypair!, {
      scope: "admin",
      iat: now,
      exp: now + 86400,
    });
    fs.mkdirSync(path.dirname(adminTokenPath), { recursive: true });
    fs.writeFileSync(adminTokenPath, adminToken + "\n", "utf-8");
  }

  return { apiToken, adminToken };
}

/**
 * Check if a JWT's algorithm matches the expected chain.
 * Used to invalidate cached tokens when switching chains.
 */
function isTokenForChain(jwt: string, chain: ChainType): boolean {
  try {
    const header = JSON.parse(Buffer.from(jwt.split(".")[0], "base64url").toString()) as { alg?: string };
    if (chain === "evm") return header.alg === "EIP191K";
    return header.alg === "SOL_EDDSA";
  } catch {
    return false;
  }
}
