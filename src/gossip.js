/**
 * gossip.js — Admin-push blob propagation (v2 — simplified).
 *
 * v1/v7 used epidemic fan-out to ALL peers.
 * v2: Optional push to a single admin node (if ADMIN_NODE_URL is set).
 * Inscriber nodes don't need each other's data.
 *
 * Used by claimer.js (after job inscription) — same export signature.
 */

import * as db from './db.js';
import { verifyBlobHash, isHydBlob } from './hyd.js';
import { buildPeerHeaders } from './crypto-auth.js';
import { getIdentityKeypair } from './wallet.js';

const PUSH_TIMEOUT = 30_000;   // 30s for full blob push
const NOTIFY_TIMEOUT = 10_000; // 10s for hash-only notify
const PULL_TIMEOUT = 30_000;   // 30s for blob pull

function getAdminUrl() { return process.env.ADMIN_NODE_URL || ''; }
function getNodeUrl() { return process.env.NODE_URL || process.env.NODE_ENDPOINT || ''; }

/** Build signed auth headers — identity key required, no legacy fallback */
function peerHeaders(action) {
  try {
    const kp = getIdentityKeypair();
    return buildPeerHeaders(kp, action);
  } catch (err) {
    console.warn('[Gossip] No identity key — peer requests will be unauthenticated:', err.message);
    return {};
  }
}

/**
 * Push blob to admin node after inscription completes.
 * If ADMIN_NODE_URL not set, this is a no-op.
 *
 * @param {string} hash - Blob hash (sha256:...)
 * @param {number} chunkCount - Expected chunk count
 * @param {string[]} origins - Unused in v2 (kept for backward compat)
 * @param {number} [blobSize] - Blob size in bytes
 */
export async function gossipBlob(hash, chunkCount, origins = [], blobSize = 0) {
  const adminUrl = getAdminUrl();
  if (!adminUrl) return; // no admin configured — silent no-op

  const nodeUrl = getNodeUrl();

  // Try to send the full blob (admin can serve it immediately)
  const blob = db.getBlob(hash);
  if (blob) {
    try {
      const resp = await fetch(`${adminUrl}/sync/push`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...peerHeaders('sync-push'),
          'X-Gossip-Origin': nodeUrl,
        },
        body: JSON.stringify({
          hash,
          chunkCount,
          data: blob.toString('base64'),
          size: blob.length,
        }),
        signal: AbortSignal.timeout(PUSH_TIMEOUT),
      });
      if (resp.ok) {
        console.log(`[Gossip] Pushed ${hash.slice(0, 20)}... (${blob.length}B) to admin`);
        return;
      }
    } catch (err) {
      console.warn(`[Gossip] Push to admin failed: ${err.message}`);
    }
  }

  // Fallback: notify only (admin can pull later)
  try {
    await fetch(`${adminUrl}/sync/notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...peerHeaders('sync-notify'),
      },
      body: JSON.stringify({ hash, chunkCount, size: blobSize, sourceUrl: nodeUrl }),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT),
    });
    console.log(`[Gossip] Notified admin about ${hash.slice(0, 20)}...`);
  } catch (err) {
    console.warn(`[Gossip] Notify admin failed: ${err.message}`);
  }
}

/**
 * Pull a blob from a source node after receiving a notification.
 * Tries sourceUrl first, then falls back to other known peers.
 *
 * @param {string} hash - Blob hash
 * @param {string} sourceUrl - The node that notified us
 * @param {number} chunkCount - Expected chunks
 * @returns {boolean} true if blob was successfully pulled and stored
 */
export async function pullBlob(hash, sourceUrl, chunkCount) {
  const nodeUrl = getNodeUrl();

  // Build source list: notifier first, then other peers as fallback
  const sources = [];
  if (sourceUrl) sources.push(sourceUrl);
  const peers = db.listPeers();
  for (const p of peers) {
    if (p.url !== sourceUrl && p.url !== nodeUrl) sources.push(p.url);
  }

  for (const url of sources) {
    try {
      const resp = await fetch(`${url}/blob/${hash}`, {
        headers: {
          ...peerHeaders('blob-pull'),
        },
        signal: AbortSignal.timeout(PULL_TIMEOUT),
        redirect: 'manual',
      });
      if (!resp.ok) continue;

      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length === 0) continue;

      if (!verifyBlobHash(buf, hash)) continue;

      // Store it
      db.upsertArtwork({
        hash,
        chunkCount: chunkCount || Math.ceil(buf.length / 585),
        blobSize: buf.length,
        width: isHydBlob(buf) ? buf.readUInt16LE(5) : null,
        height: isHydBlob(buf) ? buf.readUInt16LE(7) : null,
        mode: 'open', network: 'mainnet', pointerSig: null, chunks: null,
      });
      db.storeBlob(hash, buf);

      const sourceHost = new URL(url).hostname;
      console.log(`[Gossip] Pulled ${hash.slice(0, 20)}... (${buf.length}B) from ${sourceHost}`);
      return true;
    } catch (err) {
      console.warn(`[Gossip] Pull from ${url} failed:`, err.message);
    }
  }

  console.warn(`[Gossip] Failed to pull ${hash.slice(0, 20)}... from ${sources.length} source(s)`);
  return false;
}
