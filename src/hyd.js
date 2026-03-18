/**
 * hyd.js — Shared HYD blob utilities for Freeze Dry nodes
 * Single source of truth for magic byte checks and hash extraction.
 */

import { createHash } from 'crypto';

const HYD_MAGIC = Buffer.from([0x48, 0x59, 0x44, 0x01]);
const HEADER_SIZE = 49;
const HASH_OFFSET = 17;
const HASH_LENGTH = 32;

/** Check if a buffer is a valid HYD blob (magic bytes + minimum header size) */
export function isHydBlob(buf) {
  return buf.length >= HEADER_SIZE &&
    buf[0] === 0x48 && buf[1] === 0x59 && buf[2] === 0x44 && buf[3] === 0x01;
}

/** Check if a HYD blob has a readable 49-byte header (open modes: 0, 3). Encrypted modes (1,2,4,5) have 5-byte header only. */
export function isOpenMode(buf) {
  return isHydBlob(buf) && buf[4] % 3 === 0;
}

/** Extract the content hash from a HYD blob header (bytes 17-48) as hex string.
 *  Only valid for open-mode blobs — encrypted blobs have no readable hash in header. */
export function extractContentHash(buf) {
  return Buffer.from(buf.slice(HASH_OFFSET, HASH_OFFSET + HASH_LENGTH)).toString('hex');
}

/** Ensure a hash string has the sha256: prefix */
export function ensureSha256Prefix(hash) {
  return hash.startsWith('sha256:') ? hash : `sha256:${hash}`;
}

/** Strip sha256: prefix from a hash string */
export function stripSha256Prefix(hash) {
  return hash.replace(/^sha256:/, '');
}

/**
 * Verify a blob against an expected hash.
 * Open-mode HYD blobs: manifest hash from header bytes 17-48.
 * Encrypted HYD blobs + non-HYD: SHA-256 of entire blob.
 * Falls back to SHA-256 if manifest hash doesn't match (handles encrypted blobs stored with blob hash).
 * @param {Buffer} buf - blob data
 * @param {string} expectedHash - expected hash (with or without sha256: prefix)
 * @returns {boolean}
 */
export function verifyBlobHash(buf, expectedHash) {
  if (isOpenMode(buf)) {
    const manifestHash = 'sha256:' + extractContentHash(buf);
    if (manifestHash === expectedHash) return true;
  }
  const computed = 'sha256:' + createHash('sha256').update(buf).digest('hex');
  return computed === expectedHash;
}

/**
 * Compute the canonical hash for a blob.
 * Open-mode HYD: manifest hash from header. Encrypted HYD + non-HYD: SHA-256 of blob.
 * @param {Buffer} buf
 * @returns {string} hash with sha256: prefix
 */
export function computeBlobHash(buf) {
  if (isOpenMode(buf)) {
    return 'sha256:' + extractContentHash(buf);
  }
  return 'sha256:' + createHash('sha256').update(buf).digest('hex');
}
