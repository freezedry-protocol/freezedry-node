/**
 * crypto-auth.js — Shared ed25519 signing + verification for Freeze Dry Node.
 *
 * Consolidates duplicated signing logic from inscribe.js + indexer.js,
 * and ports verification from hydrate/api/wallet-auth.js for peer-to-peer auth.
 *
 * Uses Node.js built-in crypto only — zero external dependencies.
 *
 * Two key types:
 *   Private (signing):  DER PKCS#8 = prefix + 32-byte seed
 *   Public  (verify):   DER SPKI   = prefix + 32-byte pubkey
 *
 * Solana Keypair.secretKey is 64 bytes: [32-byte seed | 32-byte pubkey].
 * We extract seed (first 32) for signing, pubkey (last 32) for identity.
 */

import { sign as cryptoSign, verify as cryptoVerify, createPrivateKey, createPublicKey, randomBytes } from 'crypto';

// ── DER encoding prefixes (RFC 8410, Ed25519) ───────────────────────────────

/** PKCS#8 private key prefix — prepend to 32-byte seed for signing */
const DER_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** SubjectPublicKeyInfo prefix — prepend to 32-byte pubkey for verification */
const DER_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// ── Base58 encoding/decoding (Solana addresses) ─────────────────────────────

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = new Uint8Array(128).fill(255);
for (let i = 0; i < B58_ALPHABET.length; i++) B58_MAP[B58_ALPHABET.charCodeAt(i)] = i;

/** Encode raw bytes to base58 string */
export function encodeBase58(bytes) {
  if (bytes.length === 0) return '';
  const digits = [0];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let output = '';
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) output += B58_ALPHABET[0];
  for (let i = digits.length - 1; i >= 0; i--) output += B58_ALPHABET[digits[i]];
  return output;
}

/** Decode base58 string to Buffer (32 bytes for Solana pubkeys) */
export function decodeBase58(str) {
  const bytes = [0];
  for (const char of str) {
    const val = B58_MAP[char.charCodeAt(0)];
    if (val === 255) throw new Error('Invalid base58 character');
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of str) {
    if (char !== '1') break;
    bytes.push(0);
  }
  return Buffer.from(bytes.reverse());
}

// ── Signing (uses seed from Solana keypair) ──────────────────────────────────

/**
 * Sign a UTF-8 message with a Solana keypair's ed25519 seed.
 * @param {import('@solana/web3.js').Keypair} keypair — Solana Keypair object
 * @param {string} message — UTF-8 message to sign
 * @returns {string} base64-encoded 64-byte ed25519 signature
 */
export function signMessage(keypair, message) {
  const seed = keypair.secretKey.slice(0, 32);
  const derKey = Buffer.concat([DER_PKCS8_PREFIX, Buffer.from(seed)]);
  const keyObj = createPrivateKey({ key: derKey, format: 'der', type: 'pkcs8' });
  return cryptoSign(null, Buffer.from(message, 'utf-8'), keyObj).toString('base64');
}

// ── Verification (uses base58 pubkey) ────────────────────────────────────────

/**
 * Verify an ed25519 signature against a base58 public key.
 * @param {string} pubkeyBase58 — base58-encoded 32-byte public key
 * @param {string} message — UTF-8 message that was signed
 * @param {string} signatureBase64 — base64-encoded 64-byte signature
 * @returns {{ valid: boolean, error?: string }}
 */
export function verifySignature(pubkeyBase58, message, signatureBase64) {
  try {
    const pubkeyBytes = decodeBase58(pubkeyBase58);
    if (pubkeyBytes.length !== 32) {
      return { valid: false, error: 'Invalid public key length' };
    }
    const derKey = Buffer.concat([DER_SPKI_PREFIX, pubkeyBytes]);
    const keyObj = createPublicKey({ key: derKey, format: 'der', type: 'spki' });

    const sigBytes = Buffer.from(signatureBase64, 'base64');
    if (sigBytes.length !== 64) {
      return { valid: false, error: 'Invalid signature length' };
    }

    const valid = cryptoVerify(null, Buffer.from(message, 'utf-8'), keyObj, sigBytes);
    return valid ? { valid: true } : { valid: false, error: 'Signature verification failed' };
  } catch (err) {
    return { valid: false, error: `Signature error: ${err.message}` };
  }
}

// ── Peer message helpers ─────────────────────────────────────────────────────

/** Maximum age (seconds) for peer messages before they're rejected */
export const PEER_MSG_MAX_AGE_SEC = 300; // 5 minutes

/** Nonce replay protection — tracks used nonces within the TTL window */
const _usedNonces = new Map(); // nonce → expiresAt (ms)
const NONCE_PRUNE_INTERVAL = 60_000; // prune expired entries every 60s
let _lastPrune = Date.now();

function _checkAndRecordNonce(nonce) {
  const now = Date.now();
  // Prune expired entries periodically
  if (now - _lastPrune > NONCE_PRUNE_INTERVAL) {
    for (const [k, exp] of _usedNonces) {
      if (exp < now) _usedNonces.delete(k);
    }
    _lastPrune = now;
  }
  if (_usedNonces.has(nonce)) return false; // replay detected
  _usedNonces.set(nonce, now + PEER_MSG_MAX_AGE_SEC * 1000);
  return true;
}

/**
 * Build a signed peer message for node-to-node auth.
 * Format: "FreezeDry:peer:{action}:{timestamp}:{nonce}"
 *
 * @param {import('@solana/web3.js').Keypair} keypair — identity keypair
 * @param {string} action — e.g. 'sync', 'announce', 'gossip', 'pull'
 * @returns {{ message: string, signature: string, identity: string }}
 */
export function buildSignedPeerMessage(keypair, action) {
  const identity = keypair.publicKey.toBase58();
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(8).toString('hex');
  const message = `FreezeDry:peer:${action}:${timestamp}:${nonce}`;
  const signature = signMessage(keypair, message);
  return { message, signature, identity };
}

/**
 * Validate and verify a signed peer message from HTTP headers.
 * Checks format, timestamp freshness, and ed25519 signature.
 *
 * @param {string} identity — base58 identity pubkey (from X-FD-Identity header)
 * @param {string} message — signed message string (from X-FD-Message header)
 * @param {string} signature — base64 signature (from X-FD-Signature header)
 * @param {string} [expectedAction] — optional action to verify (e.g. 'sync')
 * @returns {{ valid: boolean, action?: string, error?: string }}
 */
export function verifyPeerMessage(identity, message, signature, expectedAction) {
  if (!identity || !message || !signature) {
    return { valid: false, error: 'Missing identity, message, or signature' };
  }

  // Parse: "FreezeDry:peer:{action}:{timestamp}:{nonce}"
  const parts = message.split(':');
  if (parts.length < 5 || parts[0] !== 'FreezeDry' || parts[1] !== 'peer') {
    return { valid: false, error: 'Invalid peer message format' };
  }

  const action = parts[2];
  if (expectedAction && action !== expectedAction) {
    return { valid: false, error: `Action mismatch: expected ${expectedAction}, got ${action}` };
  }

  // Timestamp freshness
  const timestamp = parseInt(parts[3], 10);
  const nowSec = Math.floor(Date.now() / 1000);
  if (isNaN(timestamp) || Math.abs(nowSec - timestamp) > PEER_MSG_MAX_AGE_SEC) {
    return { valid: false, error: 'Peer message expired or invalid timestamp' };
  }

  // Nonce replay protection
  const nonce = parts[4];
  if (!nonce || !_checkAndRecordNonce(`${identity}:${nonce}`)) {
    return { valid: false, error: 'Nonce missing or already used (replay detected)' };
  }

  // Verify ed25519 signature
  const result = verifySignature(identity, message, signature);
  if (!result.valid) return result;

  return { valid: true, action };
}

/**
 * Extract peer auth headers from an HTTP request.
 * Returns null if headers are not present.
 *
 * @param {object} headers — request headers object
 * @returns {{ identity: string, message: string, signature: string } | null}
 */
export function extractPeerHeaders(headers) {
  const identity = headers['x-fd-identity'];
  const message = headers['x-fd-message'];
  const signature = headers['x-fd-signature'];
  if (!identity || !message || !signature) return null;
  return { identity, message, signature };
}

/**
 * Build HTTP headers for a signed peer request.
 *
 * @param {import('@solana/web3.js').Keypair} keypair — identity keypair
 * @param {string} action — e.g. 'sync', 'announce', 'gossip'
 * @returns {Record<string, string>} headers to include in fetch()
 */
export function buildPeerHeaders(keypair, action) {
  const { message, signature, identity } = buildSignedPeerMessage(keypair, action);
  return {
    'X-FD-Identity': identity,
    'X-FD-Signature': signature,
    'X-FD-Message': message,
  };
}
