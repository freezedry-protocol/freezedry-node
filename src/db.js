/**
 * db.js — SQLite database layer for Freeze Dry Node
 * WAL mode for concurrent reads, single-writer safety
 */

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { verifyBlobHash } from './hyd.js';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// DATA_DIR can be set outside the repo (e.g. /var/lib/freezedry-node) so
// git operations never touch persistent data.
const DB_DIR = process.env.DATA_DIR
  ? join(process.env.DATA_DIR, 'db')
  : join(__dirname, '..', 'db');
const DB_PATH = join(DB_DIR, 'freezedry.db');

if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);

// Performance: WAL mode + larger cache
db.pragma('journal_mode = WAL');
db.pragma('cache_size = -64000'); // 64MB cache
db.pragma('synchronous = NORMAL');

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS artworks (
    hash TEXT PRIMARY KEY,
    chunk_count INTEGER NOT NULL,
    blob_size INTEGER,
    width INTEGER,
    height INTEGER,
    mode TEXT DEFAULT 'open',
    network TEXT DEFAULT 'mainnet',
    indexed_at INTEGER NOT NULL,
    pointer_sig TEXT,
    complete INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS chunks (
    hash TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    signature TEXT NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (hash, chunk_index)
  );

  CREATE TABLE IF NOT EXISTS peers (
    url TEXT PRIMARY KEY,
    last_seen INTEGER,
    status TEXT DEFAULT 'active',
    identity_pubkey TEXT,
    hot_wallet_pubkey TEXT
  );

  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(hash);
  CREATE INDEX IF NOT EXISTS idx_artworks_complete ON artworks(complete);
  CREATE INDEX IF NOT EXISTS idx_artworks_indexed ON artworks(indexed_at);
`);

// ── v7 Schema migration: last_access tracking + pinned + pruned_blobs tombstone ──
// Backward-compatible ALTER TABLE — try/catch for re-runs (column already exists).
try {
  db.exec(`ALTER TABLE artworks ADD COLUMN last_access INTEGER DEFAULT 0`);
} catch (err) {
  if (!err.message?.includes('duplicate column')) console.warn('[DB] ALTER artworks.last_access:', err.message);
}
try {
  db.exec(`ALTER TABLE artworks ADD COLUMN pinned INTEGER DEFAULT 0`);
} catch (err) {
  if (!err.message?.includes('duplicate column')) console.warn('[DB] ALTER artworks.pinned:', err.message);
}
// Backfill: set last_access = indexed_at for rows that haven't been accessed yet
db.exec(`UPDATE artworks SET last_access = indexed_at WHERE last_access = 0 OR last_access IS NULL`);

// Tombstone table for pruned blobs — prevents gossip re-ingestion loops
db.exec(`
  CREATE TABLE IF NOT EXISTS pruned_blobs (
    hash TEXT PRIMARY KEY,
    pruned_at INTEGER NOT NULL
  );
`);

// Direct jobs table — persist direct inscription jobs for auto-resume on restart
db.exec(`
  CREATE TABLE IF NOT EXISTS direct_jobs (
    job_id TEXT PRIMARY KEY,
    payment_sig TEXT NOT NULL,
    payer_wallet TEXT NOT NULL,
    manifest_hash TEXT NOT NULL,
    blob_hash TEXT,
    chunk_count INTEGER NOT NULL,
    blob_size INTEGER NOT NULL,
    status TEXT DEFAULT 'writing',
    callback_url TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  );
`);

// ── P2P Discovery migration: add identity columns to peers table ──
try {
  db.exec(`ALTER TABLE peers ADD COLUMN identity_pubkey TEXT`);
} catch (err) {
  if (!err.message?.includes('duplicate column')) console.warn('[DB] ALTER peers.identity_pubkey:', err.message);
}
try {
  db.exec(`ALTER TABLE peers ADD COLUMN hot_wallet_pubkey TEXT`);
} catch (err) {
  if (!err.message?.includes('duplicate column')) console.warn('[DB] ALTER peers.hot_wallet_pubkey:', err.message);
}

// Earnings ledger — append-only log of all income and costs per job
db.exec(`
  CREATE TABLE IF NOT EXISTS earnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    type TEXT NOT NULL,
    event TEXT NOT NULL,
    amount_lamports INTEGER NOT NULL,
    tx_sig TEXT,
    meta TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(job_id, event)
  );
  CREATE INDEX IF NOT EXISTS idx_earnings_job ON earnings(job_id);
  CREATE INDEX IF NOT EXISTS idx_earnings_type ON earnings(type);
  CREATE INDEX IF NOT EXISTS idx_earnings_created ON earnings(created_at);
`);

// Prepared statements
const stmts = {
  upsertArtwork: db.prepare(`
    INSERT INTO artworks (hash, chunk_count, blob_size, width, height, mode, network, indexed_at, pointer_sig, complete)
    VALUES (@hash, @chunkCount, @blobSize, @width, @height, @mode, @network, @indexedAt, @pointerSig, @complete)
    ON CONFLICT(hash) DO UPDATE SET
      chunk_count = COALESCE(@chunkCount, chunk_count),
      blob_size = COALESCE(@blobSize, blob_size),
      width = COALESCE(@width, width),
      height = COALESCE(@height, height),
      pointer_sig = COALESCE(@pointerSig, pointer_sig),
      complete = MAX(complete, @complete)
  `),

  insertChunk: db.prepare(`
    INSERT OR IGNORE INTO chunks (hash, chunk_index, signature, data)
    VALUES (@hash, @chunkIndex, @signature, @data)
  `),

  getArtwork: db.prepare(`SELECT * FROM artworks WHERE hash = ?`),

  getBlob: db.prepare(`
    SELECT data FROM chunks WHERE hash = ? ORDER BY chunk_index ASC
  `),

  getChunkCount: db.prepare(`SELECT COUNT(*) as count FROM chunks WHERE hash = ?`),

  listArtworks: db.prepare(`
    SELECT hash, chunk_count, blob_size, width, height, mode, network, indexed_at, complete
    FROM artworks ORDER BY indexed_at DESC LIMIT ? OFFSET ?
  `),

  countArtworks: db.prepare(`SELECT COUNT(*) as count FROM artworks`),
  countComplete: db.prepare(`SELECT COUNT(*) as count FROM artworks WHERE complete = 1`),
  countChunks: db.prepare(`SELECT COUNT(*) as count FROM chunks`),

  getIncomplete: db.prepare(`SELECT * FROM artworks WHERE complete = 0`),

  markComplete: db.prepare(`UPDATE artworks SET complete = 1 WHERE hash = ?`),

  upsertPeer: db.prepare(`
    INSERT INTO peers (url, last_seen, status, identity_pubkey, hot_wallet_pubkey)
    VALUES (@url, @lastSeen, 'active', @identityPubkey, @hotWalletPubkey)
    ON CONFLICT(url) DO UPDATE SET
      last_seen = @lastSeen, status = 'active',
      identity_pubkey = COALESCE(@identityPubkey, identity_pubkey),
      hot_wallet_pubkey = COALESCE(@hotWalletPubkey, hot_wallet_pubkey)
  `),

  listPeers: db.prepare(`SELECT * FROM peers WHERE status = 'active' ORDER BY last_seen DESC`),
  stalePeers: db.prepare(`UPDATE peers SET status = 'stale' WHERE status = 'active' AND last_seen < ?`),

  // ── Blob pruning (v7) ──
  touchLastAccess: db.prepare(`UPDATE artworks SET last_access = ? WHERE hash = ?`),
  isPruned: db.prepare(`SELECT 1 FROM pruned_blobs WHERE hash = ?`),
  markPruned: db.prepare(`INSERT OR IGNORE INTO pruned_blobs (hash, pruned_at) VALUES (?, ?)`),
  getBlobCacheSize: db.prepare(`SELECT COALESCE(SUM(LENGTH(data)), 0) as total_bytes FROM chunks`),
  getStaleBlobsLRU: db.prepare(`
    SELECT a.hash, a.last_access, a.blob_size
    FROM artworks a
    WHERE a.complete = 1 AND a.pinned = 0 AND a.last_access < ?
    ORDER BY a.last_access ASC
    LIMIT ?
  `),
  pinBlob: db.prepare(`UPDATE artworks SET pinned = 1 WHERE hash = ?`),
  unpinBlob: db.prepare(`UPDATE artworks SET pinned = 0 WHERE hash = ?`),
  deleteChunksByHash: db.prepare(`DELETE FROM chunks WHERE hash = ?`),
  resetArtworkComplete: db.prepare(`UPDATE artworks SET complete = 0 WHERE hash = ?`),

  // ── Direct jobs (auto-resume on restart) ──
  insertDirectJob: db.prepare(`
    INSERT OR REPLACE INTO direct_jobs (job_id, payment_sig, payer_wallet, manifest_hash, blob_hash, chunk_count, blob_size, status, callback_url, created_at)
    VALUES (@jobId, @paymentSig, @payerWallet, @manifestHash, @blobHash, @chunkCount, @blobSize, @status, @callbackUrl, @createdAt)
  `),
  getIncompleteDirectJobs: db.prepare(`SELECT * FROM direct_jobs WHERE status = 'writing'`),
  completeDirectJob: db.prepare(`UPDATE direct_jobs SET status = 'complete', completed_at = ? WHERE job_id = ?`),
  failDirectJob: db.prepare(`UPDATE direct_jobs SET status = 'failed', completed_at = ? WHERE job_id = ?`),

  // ── Manifest sync (peer bootstrap) ──
  getManifestFull: db.prepare(`
    SELECT hash, chunk_count, blob_size, width, height, mode, network, indexed_at, pointer_sig, complete, pinned
    FROM artworks ORDER BY indexed_at ASC
  `),
  getManifestSince: db.prepare(`
    SELECT hash, chunk_count, blob_size, width, height, mode, network, indexed_at, pointer_sig, complete, pinned
    FROM artworks WHERE indexed_at > ? ORDER BY indexed_at ASC
  `),
  getManifestCount: db.prepare(`SELECT COUNT(*) as count FROM artworks`),
  getManifestLatest: db.prepare(`SELECT MAX(indexed_at) as latest FROM artworks`),

  // ── Earnings ledger ──
  insertEarning: db.prepare(`
    INSERT OR IGNORE INTO earnings (job_id, type, event, amount_lamports, tx_sig, meta, created_at)
    VALUES (@jobId, @type, @event, @amountLamports, @txSig, @meta, @createdAt)
  `),
  getEarningsSummary: db.prepare(`
    SELECT type,
      SUM(CASE WHEN amount_lamports > 0 THEN amount_lamports ELSE 0 END) as total_in,
      SUM(CASE WHEN amount_lamports < 0 THEN amount_lamports ELSE 0 END) as total_out,
      SUM(amount_lamports) as net,
      COUNT(DISTINCT job_id) as jobs
    FROM earnings GROUP BY type
  `),
  getEarningsForJob: db.prepare(`SELECT * FROM earnings WHERE job_id = ? ORDER BY created_at`),
  getEarningsSince: db.prepare(`SELECT * FROM earnings WHERE created_at > ? ORDER BY created_at DESC LIMIT ?`),
};

// Transaction wrapper for bulk inserts
const ingestArtwork = db.transaction((artwork) => {
  const { hash, chunkCount, blobSize, width, height, mode, network, pointerSig, chunks } = artwork;
  const now = Date.now();

  stmts.upsertArtwork.run({
    hash, chunkCount, blobSize, width, height,
    mode: mode || 'open',
    network: network || 'mainnet',
    indexedAt: now,
    pointerSig: pointerSig || null,
    complete: 0, // never pre-set — only markComplete after SHA-256 verification
  });

  if (chunks) {
    for (const chunk of chunks) {
      stmts.insertChunk.run({
        hash,
        chunkIndex: chunk.index,
        signature: chunk.signature || null, // must be null, not undefined — better-sqlite3 throws on undefined
        data: typeof chunk.data === 'string' ? Buffer.from(chunk.data, 'base64') : chunk.data,
      });
    }

    // Check if now complete
    const { count } = stmts.getChunkCount.get(hash);
    if (count >= chunkCount) {
      stmts.markComplete.run(hash);
    }
  }
});

export function upsertArtwork(artwork) {
  return ingestArtwork(artwork);
}

export function getArtwork(hash) {
  return stmts.getArtwork.get(hash);
}

export function getBlob(hash) {
  const rows = stmts.getBlob.all(hash);
  if (rows.length === 0) return null;
  // Touch last_access on successful reads (LRU tracking for pruning)
  stmts.touchLastAccess.run(Date.now(), hash);
  return Buffer.concat(rows.map(r => r.data));
}

export function listArtworks(limit = 50, offset = 0) {
  return stmts.listArtworks.all(limit, offset);
}

export function getStats() {
  return {
    artworks: stmts.countArtworks.get().count,
    complete: stmts.countComplete.get().count,
    chunks: stmts.countChunks.get().count,
  };
}

export function getIncomplete() {
  return stmts.getIncomplete.all();
}

export function markComplete(hash) {
  stmts.markComplete.run(hash);
}

/** Store a complete blob from peer sync — replaces any partial chain-sourced chunks. */
export function storeBlob(hash, blobBuffer) {
  db.transaction(() => {
    db.prepare('DELETE FROM chunks WHERE hash = ?').run(hash);
    db.prepare('INSERT INTO chunks (hash, chunk_index, signature, data) VALUES (?, 0, ?, ?)').run(
      hash, 'peer-sync', blobBuffer
    );
    stmts.markComplete.run(hash);
  })();
}

export function getChunkCount(hash) {
  return stmts.getChunkCount.get(hash).count;
}

export function upsertPeer(url, identityPubkey = null, hotWalletPubkey = null) {
  stmts.upsertPeer.run({ url, lastSeen: Date.now(), identityPubkey, hotWalletPubkey });
}

export function listPeers() {
  return stmts.listPeers.all();
}

/** Mark peers as stale if not seen in the given window (default 24h) */
export function cleanStalePeers(maxAgeMs = 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  return stmts.stalePeers.run(cutoff);
}

// KV store — persist indexer cursors across restarts
const kvGet = db.prepare(`SELECT value FROM kv WHERE key = ?`);
const kvSet = db.prepare(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);

export function getKV(key) {
  const row = kvGet.get(key);
  return row ? row.value : null;
}

export function setKV(key, value) {
  kvSet.run(key, value);
}

// ── Earnings ledger ─────────────────────────────────────────────────────────

/** Log an earnings event. Fire-and-forget — never throws. */
export function logEarning(jobId, type, event, amountLamports, txSig = null, metaObj = null) {
  try {
    stmts.insertEarning.run({
      jobId, type, event, amountLamports,
      txSig: txSig || null,
      meta: metaObj ? JSON.stringify(metaObj) : null,
      createdAt: Date.now(),
    });
  } catch (err) {
    console.warn('[earnings] INSERT failed (continuing):', err.message);
  }
}

export function getEarningsSummary() {
  return stmts.getEarningsSummary.all();
}

export function getEarningsForJob(jobId) {
  return stmts.getEarningsForJob.all(jobId);
}

export function getEarningsSince(sinceMs, limit = 100) {
  return stmts.getEarningsSince.all(sinceMs, limit);
}

// ── Blob repair functions ─────────────────────────────────────────────────

/** Reset a corrupt blob so the indexer re-fetches it from chain. */
export function resetCorruptBlob(hash) {
  db.transaction(() => {
    db.prepare('DELETE FROM chunks WHERE hash = ?').run(hash);
    db.prepare('UPDATE artworks SET complete = 0 WHERE hash = ?').run(hash);
  })();
}

/**
 * Verify all complete blobs against their expected hash.
 * For HYD blobs: checks manifest hash at bytes 17-48 of the HYD header.
 * For non-HYD blobs: falls back to SHA-256(entire blob).
 * The pointer/work-record hash is the manifest hash (content hash), not SHA-256(blob).
 * Returns { verified, corrupt, missing } counts + list of corrupt hashes.
 */
export function repairCorruptBlobs() {
  const complete = db.prepare('SELECT hash FROM artworks WHERE complete = 1').all();
  let verified = 0, corrupt = 0, missing = 0;
  const corruptHashes = [];

  for (const { hash } of complete) {
    const rows = stmts.getBlob.all(hash);
    if (rows.length === 0) {
      missing++;
      stmts.resetArtworkComplete.run(hash);
      corruptHashes.push({ hash, reason: 'missing-chunks' });
      continue;
    }
    const blob = Buffer.concat(rows.map(r => r.data));

    const match = verifyBlobHash(blob, hash);

    if (match) {
      verified++;
    } else {
      corrupt++;
      corruptHashes.push({ hash, reason: 'hash-mismatch', blobSize: blob.length });
      stmts.deleteChunksByHash.run(hash);
      stmts.resetArtworkComplete.run(hash);
    }
  }

  return { verified, corrupt, missing, total: complete.length, corruptHashes };
}

// ── Blob pruning functions (v7) ───────────────────────────────────────────────

/** Update last_access timestamp on reads (LRU tracking). */
export function touchLastAccess(hash) {
  stmts.touchLastAccess.run(Date.now(), hash);
}

/** Check if a blob has been pruned (tombstone exists). */
export function isPruned(hash) {
  return !!stmts.isPruned.get(hash);
}

/** Add a tombstone entry for a pruned blob. */
export function markPruned(hash) {
  stmts.markPruned.run(hash, Date.now());
}

/** Pin a blob — protected from pruning (e.g. blobs this node inscribed). */
export function pinBlob(hash) {
  stmts.pinBlob.run(hash);
}

/** Unpin a blob — eligible for pruning again. */
export function unpinBlob(hash) {
  stmts.unpinBlob.run(hash);
}

/** Get total blob cache size in bytes. */
export function getBlobCacheSize() {
  return stmts.getBlobCacheSize.get().total_bytes;
}

/**
 * Evict oldest-accessed blobs when over age/size limits.
 * Prunes to 90% of maxSizeMB target. Adds tombstones for each evicted blob.
 * @param {number} maxAgeDays — evict blobs not accessed in N days (0 = skip age check)
 * @param {number} maxSizeMB — evict when cache exceeds this (0 = skip size check)
 * @returns {{ evicted: number, freedBytes: number }}
 */
export function pruneStaleBlobsLRU(maxAgeDays, maxSizeMB) {
  let evicted = 0;
  let freedBytes = 0;

  // Phase 1: Age-based eviction
  if (maxAgeDays > 0) {
    const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
    const stale = stmts.getStaleBlobsLRU.all(cutoff, 500); // batch of 500

    const evictBatch = db.transaction((blobs) => {
      for (const blob of blobs) {
        stmts.deleteChunksByHash.run(blob.hash);
        stmts.resetArtworkComplete.run(blob.hash);
        stmts.markPruned.run(blob.hash, Date.now());
        freedBytes += blob.blob_size || 0;
        evicted++;
      }
    });
    evictBatch(stale);
  }

  // Phase 2: Size-based eviction (prune to 90% target)
  if (maxSizeMB > 0) {
    const maxBytes = maxSizeMB * 1024 * 1024;
    const targetBytes = maxBytes * 0.9;
    let currentSize = stmts.getBlobCacheSize.get().total_bytes;

    if (currentSize > maxBytes) {
      // Evict oldest-accessed first until under 90% target
      const candidates = db.prepare(`
        SELECT a.hash, a.last_access, a.blob_size
        FROM artworks a
        WHERE a.complete = 1 AND a.pinned = 0
        ORDER BY a.last_access ASC
        LIMIT 1000
      `).all();

      const evictSize = db.transaction((blobs) => {
        for (const blob of blobs) {
          if (currentSize <= targetBytes) break;
          stmts.deleteChunksByHash.run(blob.hash);
          stmts.resetArtworkComplete.run(blob.hash);
          stmts.markPruned.run(blob.hash, Date.now());
          const size = blob.blob_size || 0;
          freedBytes += size;
          currentSize -= size;
          evicted++;
        }
      });
      evictSize(candidates);
    }
  }

  return { evicted, freedBytes };
}

// ── Manifest sync (peer-to-peer bootstrap) ─────────────────────────────────

/**
 * Export artwork manifest for peer bootstrap.
 * @param {number} [since] — timestamp, only return artworks indexed after this
 * @returns {{ artworks: object[], count: number, latest: number }}
 */
export function getManifest(since = 0) {
  const artworks = since > 0
    ? stmts.getManifestSince.all(since)
    : stmts.getManifestFull.all();
  const latest = stmts.getManifestLatest.get().latest || 0;
  return { artworks, count: artworks.length, latest };
}

/**
 * Import artwork manifest from a peer. Upserts metadata only — no blobs.
 * Skips artworks we already have. Returns count of new artworks added.
 * @param {object[]} artworks — array from peer's getManifest()
 * @returns {{ imported: number, skipped: number }}
 */
export function importManifest(artworks) {
  let imported = 0, skipped = 0;

  const importBatch = db.transaction((items) => {
    for (const a of items) {
      const existing = stmts.getArtwork.get(a.hash);
      if (existing) { skipped++; continue; }

      stmts.upsertArtwork.run({
        hash: a.hash,
        chunkCount: a.chunk_count,
        blobSize: a.blob_size || null,
        width: a.width || null,
        height: a.height || null,
        mode: a.mode || 'open',
        network: a.network || 'mainnet',
        indexedAt: a.indexed_at || Date.now(),
        pointerSig: a.pointer_sig || null,
        complete: 0, // no blob yet — metadata only
      });
      imported++;
    }
  });

  importBatch(artworks);
  return { imported, skipped };
}

// ── Direct job persistence (auto-resume on restart) ─────────────────────────

/** Save a direct inscription job for resume on restart. */
export function saveDirectJob({ jobId, paymentSig, payerWallet, manifestHash, blobHash, chunkCount, blobSize, callbackUrl }) {
  stmts.insertDirectJob.run({
    jobId, paymentSig, payerWallet, manifestHash,
    blobHash: blobHash || null,
    chunkCount, blobSize,
    status: 'writing',
    callbackUrl: callbackUrl || null,
    createdAt: Date.now(),
  });
}

/** Get all incomplete direct jobs (for resume on startup). */
export function getIncompleteDirectJobs() {
  return stmts.getIncompleteDirectJobs.all();
}

/** Mark a direct job as complete. */
export function completeDirectJob(jobId) {
  stmts.completeDirectJob.run(Date.now(), jobId);
}

/** Mark a direct job as failed. */
export function failDirectJob(jobId) {
  stmts.failDirectJob.run(Date.now(), jobId);
}

export { db };
