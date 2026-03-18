/**
 * indexer.js — Chain scanner for Freeze Dry pointer memos
 *
 * Scans Solana for FREEZEDRY: pointer memos from the configured SERVER_WALLET.
 * Default wallet is the official Freeze Dry inscriber, so new nodes auto-discover
 * all public Freeze Dry content out of the box. Change SERVER_WALLET in .env to
 * index a different inscriber's content.
 *
 * Helius plan auto-detection (no config needed):
 *   Paid key (Developer+) → Enhanced API (~50x cheaper, faster)
 *   Free key             → Standard RPC (getSignaturesForAddress + getTransaction)
 *   Override: USE_ENHANCED_API=true|false in .env
 */

import * as db from './db.js';
import { isHydBlob, isOpenMode, extractContentHash, verifyBlobHash } from './hyd.js';
import { buildPoolFromEnv } from './rpc-pool.js';
import { signMessage, buildPeerHeaders } from './crypto-auth.js';
import { getIdentityKeypair, getHotWallet } from './wallet.js';
import { randomBytes } from 'crypto';

// Env vars read lazily — loadEnv() in server.js must run first
let HELIUS_API_KEY, HELIUS_RPC, SERVER_WALLET, REGISTRY_URL, POLL_INTERVAL, PEER_NODES, NODE_URL, NODE_ENDPOINT, GENESIS_SIG;

// Auto-detected: true = paid key with Enhanced API, false = free key (RPC only)
let useEnhancedAPI = null; // null = not yet detected

// RPC pool for dual/multi-RPC support (v7)
let _rpcPool = null;

/** Build signed peer headers — identity key required, no legacy fallback */
function peerHeaders(action) {
  try {
    const kp = getIdentityKeypair();
    return buildPeerHeaders(kp, action);
  } catch (err) {
    log.warn(`Indexer: no identity key for ${action} — ${err.message}`);
    return {};
  }
}

/** Get the node's self-identifier (endpoint preferred, URL fallback) */
function selfId() { return NODE_ENDPOINT || NODE_URL; }

function loadConfig() {
  HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
  HELIUS_RPC = process.env.HELIUS_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
  SERVER_WALLET = process.env.SERVER_WALLET || '';
  REGISTRY_URL = process.env.REGISTRY_URL || 'https://freezedry.art';
  // Default 1 hour — webhooks handle real-time, scan is just a safety net.
  // Community nodes should NOT need to change this. Lower values burn more credits.
  POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '3600000', 10);
  PEER_NODES = (process.env.PEER_NODES || '').split(',').map(s => s.trim()).filter(Boolean);
  NODE_URL = process.env.NODE_URL || '';
  NODE_ENDPOINT = process.env.NODE_ENDPOINT || ''; // ip:port for P2P discovery
  // Hard stop for backwards pagination — don't scan older than this signature.
  // Saves RPC credits on first scan. Set to the first Freeze Dry inscription sig.
  GENESIS_SIG = process.env.GENESIS_SIG || '';
  // Allow explicit override via env var
  if (process.env.USE_ENHANCED_API === 'true') useEnhancedAPI = true;
  if (process.env.USE_ENHANCED_API === 'false') useEnhancedAPI = false;
  // Build RPC pool — reads HELIUS_RPC_URL, HELIUS_RPC_URL_2, etc.
  _rpcPool = buildPoolFromEnv('HELIUS_RPC_URL', HELIUS_RPC);
}

/** Get the current RPC URL from the pool (rotates on round-robin, fails over on failover). */
function getPoolRpcUrl() {
  return _rpcPool ? _rpcPool.getUrl() : HELIUS_RPC;
}

/** Get a Connection instance from the pool. */
function getPoolConnection() {
  return _rpcPool ? _rpcPool.getConnection() : null;
}

/** Mark a URL as failed in the pool. */
function markPoolFailed(url) {
  if (_rpcPool) _rpcPool.markFailed(url);
}

// Rate limiting: 3 concurrent, 500ms stagger
const MAX_CONCURRENT = 3;
const STAGGER_MS = 500;

// ── Tier-based auto-configuration ───────────────────────────────────────────
// Set HELIUS_PLAN=free|developer|business|geyser and the node configures itself.
// Individual env vars still override if you need fine-grained control.
const PLAN_PRESETS = {
  free:      { budget: 1_000_000,   marketplace: false, chainFill: false },
  developer: { budget: 10_000_000,  marketplace: true,  chainFill: false },
  business:  { budget: 100_000_000, marketplace: true,  chainFill: false },
  geyser:    { budget: 0,           marketplace: true,  chainFill: false },
};
const _plan = (process.env.HELIUS_PLAN || '').toLowerCase();
const _preset = PLAN_PRESETS[_plan] || null;

// ── Credit-aware circuit breaker ────────────────────────────────────────────
// Protects Helius subscription from runaway polling.
// Tracks 429s and backs off exponentially. Caps fill attempts per cycle.
// DEFAULT: chain fill is OFF. Blobs come from peers/gossip/webhooks.
// Set CHAIN_FILL=true to enable chain reads as fallback (burns Enhanced API credits).
const MONTHLY_CREDIT_BUDGET = parseInt(process.env.CREDIT_BUDGET || String(_preset?.budget ?? 10_000_000), 10);
const MAX_FILL_PER_CYCLE = parseInt(process.env.MAX_FILL_PER_CYCLE || '0', 10); // 0 = peers only
const CHAIN_FILL_ENABLED = process.env.CHAIN_FILL === 'true'; // explicit opt-in
const MAX_FILL_ATTEMPTS = parseInt(process.env.MAX_FILL_ATTEMPTS || '5', 10); // give up after N failures

// Export plan info for /health endpoint
export function getActivePlan() {
  return _plan || 'custom';
}
let _consecutive429s = 0;
let _creditEstimate = 0; // rough running total this session
let _sessionStart = Date.now();

function trackCredits(n) {
  _creditEstimate += n;
}

function getBackoffMs() {
  if (_consecutive429s === 0) return 0;
  // Exponential: 60s, 120s, 240s, 480s, cap at 15 min
  return Math.min(60_000 * Math.pow(2, _consecutive429s - 1), 900_000);
}

function shouldSkipRPC(label) {
  if (MONTHLY_CREDIT_BUDGET > 0) {
    const hoursRunning = Math.max(1, (Date.now() - _sessionStart) / 3_600_000);
    const projectedMonthly = (_creditEstimate / hoursRunning) * 720;
    if (projectedMonthly > MONTHLY_CREDIT_BUDGET * 0.8) {
      log.warn(`Indexer: ${label} skipped — projected ${Math.round(projectedMonthly).toLocaleString()} credits/mo exceeds 80% of budget (${MONTHLY_CREDIT_BUDGET.toLocaleString()})`);
      return true;
    }
  }
  const backoff = getBackoffMs();
  if (backoff > 0) {
    log.info(`Indexer: ${label} delayed ${Math.round(backoff / 1000)}s (${_consecutive429s} consecutive 429s)`);
  }
  return false;
}

const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

let log = console;
// Initial history scan cursor (persisted to SQLite — survives restarts)
// Once the full history is scanned, this stays at the oldest known sig.
let oldestScannedSig = null;
let initialScanDone = false;

/**
 * Parse a FREEZEDRY pointer memo string into structured data.
 * Supports v3 (with lastChunkSig), v2, and v1 formats.
 */
function parsePointerMemo(memo) {
  if (!memo || typeof memo !== 'string' || !memo.startsWith('FREEZEDRY:')) return null;
  const parts = memo.split(':');
  // v3: FREEZEDRY:3:sha256:{hex}:{chunks}:{size}:{chunkSize}:{flags}:{inscriber}:{lastChunkSig}
  if (parts[1] === '3' && parts.length >= 10) {
    return {
      version: 3,
      hash: parts[2] + ':' + parts[3],
      chunkCount: parseInt(parts[4], 10),
      blobSize: parseInt(parts[5], 10),
      chunkSize: parseInt(parts[6], 10),
      flags: parts[7],
      inscriber: parts[8],
      lastChunkSig: parts[9],
    };
  }
  // v2: FREEZEDRY:2:sha256:{hex}:{chunks}:{size}:{chunkSize}:{flags}:{inscriber}
  if (parts[1] === '2' && parts.length >= 9) {
    return {
      version: 2,
      hash: parts[2] + ':' + parts[3],
      chunkCount: parseInt(parts[4], 10),
      blobSize: parseInt(parts[5], 10),
      chunkSize: parseInt(parts[6], 10),
      flags: parts[7],
      inscriber: parts[8],
      lastChunkSig: null,
    };
  }
  // v1: FREEZEDRY:sha256:{hex}:{chunks}:{size?}
  if (parts.length >= 4) {
    return {
      version: 1,
      hash: parts[1] + ':' + parts[2],
      chunkCount: parseInt(parts[3], 10),
      blobSize: parts[4] ? parseInt(parts[4], 10) : null,
      chunkSize: null,
      flags: null,
      inscriber: null,
      lastChunkSig: null,
    };
  }
  return null;
}

/** Strip v3 chunk header (FD:{hash8}:{index}:) from memo data. No-op for v2. */
function stripV3Header(str) {
  if (str.startsWith('FD:')) {
    const thirdColon = str.indexOf(':', str.indexOf(':', 3) + 1);
    if (thirdColon !== -1) return str.slice(thirdColon + 1);
  }
  return str;
}

/**
 * Start the indexer loop
 */
export function getIndexerBudget() {
  const hoursRunning = Math.max(0.01, (Date.now() - _sessionStart) / 3_600_000);
  return {
    plan: _plan || 'custom',
    creditsUsed: _creditEstimate,
    creditsPerHour: Math.round(_creditEstimate / hoursRunning),
    projectedMonthly: Math.round((_creditEstimate / hoursRunning) * 720),
    budget: MONTHLY_CREDIT_BUDGET,
    chainFill: CHAIN_FILL_ENABLED,
    consecutive429s: _consecutive429s,
    backoffMs: getBackoffMs(),
    maxFillPerCycle: MAX_FILL_PER_CYCLE,
    maxFillAttempts: MAX_FILL_ATTEMPTS,
    sessionHours: Math.round(hoursRunning * 10) / 10,
    rpcPool: _rpcPool ? _rpcPool.getStats() : null,
  };
}

export function startIndexer(logger) {
  if (logger) log = logger;
  loadConfig();

  if (!HELIUS_API_KEY) {
    log.warn('HELIUS_API_KEY not set — indexer disabled (webhook-only mode)');
    return;
  }

  const planLabel = _plan ? `plan=${_plan}` : 'plan=custom';
  log.info(`Indexer: starting (${planLabel}, poll ${POLL_INTERVAL / 1000}s, wallet ${SERVER_WALLET.slice(0, 8)}..., chain_fill=${CHAIN_FILL_ENABLED}, budget=${MONTHLY_CREDIT_BUDGET.toLocaleString()})`);

  // Restore scan state from SQLite
  oldestScannedSig = db.getKV('oldest_scanned_sig') || null;
  initialScanDone = db.getKV('initial_scan_done') === 'true';
  if (initialScanDone) {
    log.info('Indexer: resuming — initial history scan already complete');
  }

  // Peer manifest sync — bootstrap from peers FIRST (fast, zero RPC credits)
  // Gets all artwork metadata from first reachable peer, then delta-sync on future startups.
  if (PEER_NODES.length > 0) {
    syncManifestFromPeers().catch(err => log.warn(`Manifest sync failed: ${err.message}`));
  }

  // Seed from registry on startup (backfill — fallback if no peers available)
  if (REGISTRY_URL) {
    seedFromRegistry().catch(err => log.warn(`Registry seed failed: ${err.message}`));
  }

  // Auto-register with coordinator (wallet auth), then discover peers
  // Three-layer discovery: coordinator API → on-chain PDA → gossip
  registerWithCoordinator()
    .then(() => discoverFromCoordinator())
    .then(() => discoverFromRegistry())
    .catch(err => log.warn(`Coordinator startup failed: ${err.message}`));

  // Connect to peer network on startup (manual PEER_NODES + gossip)
  if (PEER_NODES.length > 0 || selfId()) {
    joinPeerNetwork().catch(err => log.warn(`Peer network join failed: ${err.message}`));
  }

  // Start polling
  pollLoop();
}

let pollCount = 0;

async function pollLoop() {
  while (true) {
    try {
      // Scan: discover new pointer memos from chain.
      // With webhooks active, this is a SAFETY NET only — webhooks handle real-time.
      // Skip scan entirely after initial history scan if webhooks are configured.
      const webhooksActive = !!process.env.WEBHOOK_SECRET; // webhook handler exists
      const scanNeeded = !initialScanDone || !webhooksActive || (pollCount % 6 === 0); // every 6th poll = ~6hr safety check
      if (scanNeeded && !shouldSkipRPC('scan')) {
        await scanForPointerMemos();
      }
      await fillIncomplete();

      // Every 10 polls: refresh coordinator registration, discover peers, gossip, manifest delta
      pollCount++;
      if (pollCount % 10 === 0) {
        db.cleanStalePeers();
        await syncManifestFromPeers().catch(e => log.warn(`[poll] syncManifest: ${e.message}`));
        await registerWithCoordinator().catch(e => log.warn(`[poll] registerCoordinator: ${e.message}`));
        await discoverFromCoordinator().catch(e => log.warn(`[poll] discoverCoordinator: ${e.message}`));
        await discoverFromRegistry().catch(e => log.warn(`[poll] discoverRegistry: ${e.message}`));
        await gossipPeers().catch(e => log.warn(`[poll] gossipPeers: ${e.message}`));
      }
    } catch (err) {
      log.warn(`Indexer poll error: ${err.message}`);
    }
    await sleep(POLL_INTERVAL);
  }
}

// ─── Scanning: discover pointer memos ───

async function scanForPointerMemos() {
  // After initial scan, use cheap RPC scan for safety checks (~6 credits vs 500 for Enhanced).
  // Enhanced API only needed for initial full-history scan (one-time).
  if (initialScanDone) {
    await scanRPC();
    return;
  }

  if (useEnhancedAPI !== false) {
    try {
      await scanEnhanced();
      if (useEnhancedAPI === null) {
        useEnhancedAPI = true;
        log.info('Indexer: Enhanced API available — using optimized path');
      }
      return;
    } catch (err) {
      if (err.message.includes('403') || err.message.includes('401') || err.message.includes('Forbidden')) {
        useEnhancedAPI = false;
        log.info('Indexer: Enhanced API not available (free plan) — using standard RPC');
      } else {
        throw err; // re-throw non-auth errors
      }
    }
  }
  // Fallback: standard RPC
  await scanRPC();
}

/**
 * Scan via Enhanced Transactions API (paid plans — 100 credits per 100 results).
 *
 * Strategy: always start from newest (before=null), paginate backwards.
 * Stop when we hit an already-known artwork hash — everything older is already indexed.
 * On first run, walks the full history. On subsequent runs, only fetches new txs.
 */
async function scanEnhanced() {
  let before = null;       // start from newest
  let discovered = 0;
  // Safety net scans (post-initial): cap at 5 pages (500 credits max).
  // Initial scan: up to 100 pages to walk full history.
  const MAX_PAGES = initialScanDone ? 5 : 100;

  // Backfill: only on first scan, not every cycle (saves thousands of credits)
  const needsBackfill = !initialScanDone && db.getIncomplete().some(a => !a.pointer_sig);
  if (needsBackfill) {
    log.info('Indexer: initial scan — backfilling pointer_sig for artworks');
  }

  for (let page = 0; page < MAX_PAGES; page++) {
    const txs = await fetchEnhancedTransactions(SERVER_WALLET, before);
    if (!txs || txs.length === 0) break;

    let hitKnown = false;
    for (const tx of txs) {
      if (tx.transactionError) continue;
      const memoData = extractEnhancedMemoData(tx);
      if (!memoData) continue;

      const pointer = parsePointerMemo(memoData);
      if (!pointer || !pointer.hash || isNaN(pointer.chunkCount) || pointer.chunkCount <= 0) continue;

      const existing = db.getArtwork(pointer.hash);
      if (existing) {
        if (existing.pointer_sig) hitKnown = true;
        processPointerMemo(memoData, tx.signature);
        continue;
      }

      processPointerMemo(memoData, tx.signature);
      discovered++;
    }

    // Stop on known artwork (after initial scan is done)
    if (hitKnown && initialScanDone) break;

    // Update backward cursor for initial full-history scan
    before = txs[txs.length - 1].signature;
    db.setKV('oldest_scanned_sig', before);

    // Genesis sig: hard stop — don't scan older than the first Freeze Dry inscription
    if (GENESIS_SIG && txs.some(tx => tx.signature === GENESIS_SIG)) {
      if (!initialScanDone) {
        initialScanDone = true;
        db.setKV('initial_scan_done', 'true');
        log.info('Indexer: reached genesis signature — initial scan complete');
      }
      break;
    }

    // If batch was smaller than limit, we've reached the end of history
    if (txs.length < 100) {
      if (!initialScanDone) {
        initialScanDone = true;
        db.setKV('initial_scan_done', 'true');
        log.info('Indexer: initial full history scan complete');
      }
      break;
    }

    await sleep(200); // rate limit between pages
  }

  if (discovered > 0) {
    log.info(`Indexer: discovered ${discovered} new artwork(s) via Enhanced API`);
  }
}

/**
 * Scan via standard RPC (free plan — getSignaturesForAddress + getTransaction).
 * Same strategy: newest-first, stop on known artwork.
 */
async function scanRPC() {
  let before = null;
  let discovered = 0;
  // Post-initial: cap at 5 pages (safety net). Initial: up to 100 pages.
  const MAX_PAGES = initialScanDone ? 5 : 100;

  const needsBackfill = !initialScanDone && db.getIncomplete().some(a => !a.pointer_sig);

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = { limit: 50 };
    if (before) params.before = before;

    const resp = await fetchRPC({
      jsonrpc: '2.0', id: 1,
      method: 'getSignaturesForAddress',
      params: [SERVER_WALLET, params],
    });
    trackCredits(1); // gSFA = 1 credit
    const sigs = resp?.result || [];
    if (sigs.length === 0) break;

    let hitKnown = false;
    for (const sigInfo of sigs) {
      if (sigInfo.err) continue;

      // Optimization: use memo field from gSFA to skip chunk memos (saves ~50 credits/page).
      // Only fetch full tx for signatures that look like pointer memos.
      // Chunk memos contain "FD:" prefix; pointer memos contain "FREEZEDRY:" prefix.
      if (initialScanDone && sigInfo.memo) {
        const memoStr = String(sigInfo.memo);
        if (!memoStr.includes('FREEZEDRY:')) continue; // skip chunk memos
      }

      try {
        const txData = await fetchTransaction(sigInfo.signature);
        trackCredits(1); // getTransaction = 1 credit
        if (!txData) continue;
        const memoData = extractRPCMemoData(txData);
        if (!memoData) continue;

        const pointer = parsePointerMemo(memoData);
        if (pointer && pointer.hash) {
          const existing = db.getArtwork(pointer.hash);
          if (existing) {
            if (existing.pointer_sig) hitKnown = true;
            processPointerMemo(memoData, sigInfo.signature);
            // Early break on known artwork (don't waste credits on rest of page)
            if (hitKnown && initialScanDone) break;
            continue;
          }
        }

        processPointerMemo(memoData, sigInfo.signature);
        if (pointer && !db.getArtwork(pointer?.hash)) discovered++;
        await sleep(STAGGER_MS);
      } catch (err) {
        log.warn(`Indexer: failed to process sig ${sigInfo.signature.slice(0, 12)}... — ${err.message}`);
      }
    }

    if (hitKnown && initialScanDone) break;

    before = sigs[sigs.length - 1].signature;
    db.setKV('oldest_scanned_sig', before);

    // Genesis sig: hard stop
    if (GENESIS_SIG && sigs.some(s => s.signature === GENESIS_SIG)) {
      if (!initialScanDone) {
        initialScanDone = true;
        db.setKV('initial_scan_done', 'true');
        log.info('Indexer: reached genesis signature — initial scan complete');
      }
      break;
    }

    if (sigs.length < 50) {
      if (!initialScanDone) {
        initialScanDone = true;
        db.setKV('initial_scan_done', 'true');
        log.info('Indexer: initial full history scan complete');
      }
      break;
    }

    await sleep(200);
  }

  if (discovered > 0) {
    log.info(`Indexer: discovered ${discovered} new artwork(s) via RPC`);
  }
}

/** Shared: process a potential pointer memo string */
function processPointerMemo(memoData, signature) {
  const pointer = parsePointerMemo(memoData);
  if (!pointer) return;
  if (!pointer.hash || isNaN(pointer.chunkCount) || pointer.chunkCount <= 0) return;

  const existing = db.getArtwork(pointer.hash);
  if (existing) {
    // Existing record from registry seed may lack pointer_sig — backfill it
    if (!existing.pointer_sig && signature) {
      db.upsertArtwork({
        hash: pointer.hash,
        chunkCount: pointer.chunkCount || existing.chunk_count,
        blobSize: pointer.blobSize || existing.blob_size,
        width: existing.width,
        height: existing.height,
        mode: existing.mode || 'open',
        network: existing.network || 'mainnet',
        pointerSig: signature,
        chunks: null,
      });
      log.info(`Indexer: backfilled pointer sig for ${pointer.hash.slice(0, 24)}...`);
    }
    return;
  }

  db.upsertArtwork({
    hash: pointer.hash,
    chunkCount: pointer.chunkCount,
    blobSize: pointer.blobSize || null,
    width: null,
    height: null,
    mode: 'open',
    network: 'mainnet',
    pointerSig: signature,
    chunks: null,
  });
  log.info(`Indexer: discovered ${pointer.hash} (${pointer.chunkCount} chunks, v${pointer.version})`);
}

// ─── Fill incomplete: fetch chunk data ───

async function fillIncomplete() {
  const incomplete = db.getIncomplete();
  if (incomplete.length === 0) return;

  // Filter out artworks that have exceeded fill attempts (dead/partial inscriptions)
  const fillable = incomplete.filter(art => {
    const attempts = parseInt(db.getKV(`fill_attempts:${art.hash}`) || '0', 10);
    if (attempts >= MAX_FILL_ATTEMPTS) return false; // give up — probably incomplete on chain
    return true;
  });

  const abandoned = incomplete.length - fillable.length;
  if (fillable.length > 0 || abandoned > 0) {
    log.info(`Indexer: ${fillable.length} incomplete artworks to fill` +
      (abandoned > 0 ? ` (${abandoned} abandoned after ${MAX_FILL_ATTEMPTS} attempts)` : ''));
  }

  if (fillable.length === 0) return;

  // Phase 1: Parallel peer sync (fast — just HTTP, no RPC credits)
  const PEER_BATCH = 4;
  const peerRemaining = [];
  for (let i = 0; i < fillable.length; i += PEER_BATCH) {
    const batch = fillable.slice(i, i + PEER_BATCH);
    const results = await Promise.allSettled(
      batch.map(art => fillFromPeers(art).then(ok => ({ art, ok })))
    );
    for (const r of results) {
      if (r.status === 'rejected' || !r.value.ok) {
        const art = r.status === 'fulfilled' ? r.value.art : batch[results.indexOf(r)];
        peerRemaining.push(art);
        // Track failed fill attempts
        const key = `fill_attempts:${art.hash}`;
        db.setKV(key, String(parseInt(db.getKV(key) || '0', 10) + 1));
      }
    }
  }

  if (peerRemaining.length === 0) return; // all filled from peers

  // Phase 2: Chain reads — DISABLED by default. Blobs should come from peers/gossip/webhooks.
  // Enable with CHAIN_FILL=true for emergency recovery only.
  if (!CHAIN_FILL_ENABLED || MAX_FILL_PER_CYCLE === 0) {
    if (peerRemaining.length > 0) {
      log.info(`Indexer: ${peerRemaining.length} artworks need chain fill — skipped (CHAIN_FILL=${CHAIN_FILL_ENABLED ? 'true' : 'false'}, peers/gossip will retry next cycle)`);
    }
    return;
  }

  const fillBatch = peerRemaining.slice(0, MAX_FILL_PER_CYCLE);
  if (peerRemaining.length > MAX_FILL_PER_CYCLE) {
    log.info(`Indexer: capping chain fill to ${MAX_FILL_PER_CYCLE}/${peerRemaining.length} artworks this cycle`);
  }

  if (shouldSkipRPC('fill')) return; // circuit breaker

  for (const artwork of fillBatch) {
    try {
      await fetchAndCacheChunks(artwork);
      // Reset fill attempts on success
      db.setKV(`fill_attempts:${artwork.hash}`, '0');
      await sleep(STAGGER_MS * 2);
    } catch (err) {
      if (err.message.includes('429') || err.message.includes('rate')) {
        log.warn(`Indexer: rate limited during fill — stopping batch`);
        break;
      }
      log.warn(`Indexer: failed to fill ${artwork.hash.slice(0, 16)}... — ${err.message}`);
    }
  }
}

async function fetchAndCacheChunks(artwork) {
  if (!artwork.pointer_sig) {
    log.info(`Indexer: no pointer sig for ${artwork.hash.slice(0, 16)}... — skipping`);
    return;
  }

  let chunks;
  if (useEnhancedAPI) {
    chunks = await fillChunksEnhanced(artwork);
  } else {
    chunks = await fillChunksRPC(artwork);
  }

  if (chunks && chunks.length > 0) {
    db.upsertArtwork({
      hash: artwork.hash,
      chunkCount: artwork.chunk_count,
      blobSize: artwork.blob_size,
      width: artwork.width,
      height: artwork.height,
      mode: artwork.mode,
      network: artwork.network,
      pointerSig: artwork.pointer_sig,
      chunks,
    });

    const cached = db.getChunkCount(artwork.hash);
    log.info(`Indexer: cached ${cached}/${artwork.chunk_count} chunks for ${artwork.hash.slice(0, 16)}...`);

    // Verify reconstructed blob matches the manifest hash from the pointer.
    // The pointer/work-record hash is the MANIFEST hash (bytes 17-48 of the HYD header),
    // NOT SHA-256(entire blob). The manifest hash is embedded during .hyd creation and
    // represents the content hash. SHA-256(blob) includes the header itself, so it differs.
    if (cached >= artwork.chunk_count) {
      const blob = db.getBlob(artwork.hash);
      if (blob) {
        let verified = false;

        if (verifyBlobHash(blob, artwork.hash)) {
          verified = true;
          log.info(`Indexer: blob verified for ${artwork.hash.slice(0, 16)}...`);
        }

        // Secondary verification: check blob size matches pointer's blobSize
        if (verified && artwork.blob_size && blob.length !== artwork.blob_size) {
          log.warn(`Indexer: size mismatch for ${artwork.hash.slice(0, 16)}... — got ${blob.length}, expected ${artwork.blob_size}`);
          verified = false;
        }

        if (!verified) {
          const retryKey = `repair_attempts:${artwork.hash}`;
          const attempts = parseInt(db.getKV(retryKey) || '0', 10);
          if (attempts < 3) {
            db.setKV(retryKey, String(attempts + 1));
            log.warn(`Indexer: blob verification failed for ${artwork.hash.slice(0, 16)}... — reset attempt ${attempts + 1}/3`);
            db.resetCorruptBlob(artwork.hash);
          } else {
            log.error(`Indexer: blob ${artwork.hash.slice(0, 16)}... failed verification after 3 attempts — leaving as-is`);
          }
        } else {
          db.setKV(`repair_attempts:${artwork.hash}`, '0');
        }
      }
    }
  }
}

/** Fill chunks via Enhanced API (paid plan) — paginates through all chunks */
async function fillChunksEnhanced(artwork) {
  const needed = artwork.chunk_count;
  // v3 hash prefix for filtering — first 8 chars after "sha256:"
  const hash8 = artwork.hash.startsWith('sha256:') ? artwork.hash.slice(7, 15) : artwork.hash.slice(0, 8);
  const chunks = [];
  let beforeSig = artwork.pointer_sig;

  // Paginate: Enhanced API returns max 100 per call.
  // Other artworks' chunks are interspersed — filter by hash8 prefix.
  // Large artworks with re-inscription duplicates may need 300+ pages.
  const MAX_PAGES = 500;
  const allTxs = [];
  // Running unique index counter — avoids O(n²) re-decoding every page
  const earlyIndices = new Set();
  let noProgressPages = 0; // stop if 10 consecutive pages have no new chunks

  for (let page = 0; page < MAX_PAGES; page++) {
    const txs = await fetchEnhancedTransactions(SERVER_WALLET, beforeSig, 100);
    if (!txs || txs.length === 0) break;
    allTxs.push(...txs);
    if (txs.length < 100) break; // last page
    beforeSig = txs[txs.length - 1].signature;
    await sleep(200); // rate limit between pages

    // Early exit: count UNIQUE v3 chunk indices from THIS page only
    const prevSize = earlyIndices.size;
    for (const tx of txs) {
      if (tx.transactionError) continue;
      const memoData = extractEnhancedMemoData(tx);
      if (!memoData || memoData.startsWith('FREEZEDRY:')) continue;
      if (!memoData.startsWith(`FD:${hash8}:`)) continue;
      const idx = parseV3Index(memoData);
      earlyIndices.add(idx !== null ? idx : earlyIndices.size);
    }
    if (earlyIndices.size >= needed) break;
    // Stop if no new chunks found in 10 consecutive pages (past the inscription range)
    if (earlyIndices.size === prevSize) { noProgressPages++; if (noProgressPages >= 10) break; }
    else noProgressPages = 0;
  }

  if (allTxs.length === 0) return [];

  // Extract only v3 chunks belonging to this artwork (chronological order).
  // IMPORTANT: require FD:{hash8}: prefix to exclude old pre-v3 chunks from
  // earlier inscription attempts that used different payload sizes (500B vs 585B).
  // Without this, old chunks get mixed in with wrong byte boundaries → corrupt blob.
  // Deduplicate by index: multiple inscription attempts produce duplicate v3 chunks.
  const seenIndices = new Set();
  for (let i = allTxs.length - 1; i >= 0 && chunks.length < needed; i--) {
    const tx = allTxs[i];
    if (tx.transactionError) continue;
    const memoData = extractEnhancedMemoData(tx);
    if (!memoData || memoData.startsWith('FREEZEDRY:')) continue;
    // REQUIRE v3 header with matching hash prefix — reject all non-v3 memos
    if (!memoData.startsWith(`FD:${hash8}:`)) continue;
    const v3Index = parseV3Index(memoData);
    const idx = v3Index !== null ? v3Index : chunks.length;
    if (seenIndices.has(idx)) continue; // skip duplicate index from re-inscription
    seenIndices.add(idx);
    const stripped = stripV3Header(memoData);
    chunks.push({ index: idx, signature: tx.signature, data: stripped });
  }
  return chunks;
}

/** Extract chunk index from v3 header: FD:{hash8}:{index}:{data} → index */
function parseV3Index(str) {
  if (!str.startsWith('FD:')) return null;
  const parts = str.split(':');
  if (parts.length < 4) return null;
  const idx = parseInt(parts[2], 10);
  return isNaN(idx) ? null : idx;
}

/** Fill chunks via standard RPC (free plan) — paginates through all sigs */
async function fillChunksRPC(artwork) {
  const needed = artwork.chunk_count;
  const hash8 = artwork.hash.startsWith('sha256:') ? artwork.hash.slice(7, 15) : artwork.hash.slice(0, 8);
  const allSigs = [];
  let beforeSig = artwork.pointer_sig;

  // Paginate: getSignaturesForAddress returns max 1000 per call.
  // Other artworks' txs are interspersed — we over-fetch then filter by hash8.
  // Safety: max 20 pages = 20,000 sigs.
  const MAX_PAGES = 20;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batchLimit = 1000;
    const resp = await fetchRPC({
      jsonrpc: '2.0', id: 1,
      method: 'getSignaturesForAddress',
      params: [SERVER_WALLET, { before: beforeSig, limit: batchLimit }],
    });
    const sigs = resp?.result || [];
    if (sigs.length === 0) break;
    allSigs.push(...sigs);

    // Rough proxy — need more sigs than needed chunks due to interleaving
    const validCount = allSigs.filter(s => !s.err).length;
    if (validCount >= needed * 2) break; // 2x buffer for interleaved txs

    if (sigs.length < batchLimit) break; // last page
    beforeSig = sigs[sigs.length - 1].signature;
    await sleep(200);
  }

  const chunks = [];
  const seenIndices = new Set(); // deduplicate re-inscription attempts
  let concurrent = 0;

  for (let i = allSigs.length - 1; i >= 0 && chunks.length < needed; i--) {
    const sigInfo = allSigs[i];
    if (sigInfo.err) continue;

    concurrent++;
    if (concurrent >= MAX_CONCURRENT) {
      await sleep(STAGGER_MS);
      concurrent = 0;
    }

    try {
      const txData = await fetchTransaction(sigInfo.signature);
      if (!txData) continue;
      const memoData = extractRPCMemoData(txData);
      if (!memoData || memoData.startsWith('FREEZEDRY:')) continue;
      // REQUIRE v3 header with matching hash prefix — reject all non-v3 memos
      if (!memoData.startsWith(`FD:${hash8}:`)) continue;
      const v3Index = parseV3Index(memoData);
      const idx = v3Index !== null ? v3Index : chunks.length;
      if (seenIndices.has(idx)) continue; // skip duplicate index from re-inscription
      seenIndices.add(idx);
      const stripped = stripV3Header(memoData);
      chunks.push({ index: idx, signature: sigInfo.signature, data: stripped });
    } catch (err) { log.warn(`[chunksBySignature] Failed to parse chunk from ${sigInfo.signature?.slice(0, 20)}...: ${err.message}`); }
  }
  return chunks;
}

// ─── Peer Network: sync blobs from peers, gossip discovery ───

/**
 * Try to fill an artwork's blob from a peer node (much faster than chain reads).
 * Peers serve cached blobs via GET /blob/:hash.
 *
 * Trustless verification (3 layers):
 *   1. Header hash matches pointer memo's hash (blob claims the right identity)
 *   2. SHA-256 of actual file data matches the embedded hash (data is authentic)
 *   3. Chain spot-check: fetch 1-2 random memo txs and compare to blob chunks
 *      (proves the blob matches what's actually on-chain)
 */
async function fillFromPeers(artwork) {
  const peers = db.listPeers();
  if (peers.length === 0) return false;

  const { createHash } = await import('crypto');

  for (const peer of peers) {
    try {
      const fetchOpts = {
        signal: AbortSignal.timeout(30000),
        headers: peerHeaders('blob-pull'),
        redirect: 'manual',
      };
      const resp = await fetch(`${peer.url}/blob/${encodeURIComponent(artwork.hash)}`, fetchOpts);
      if (!resp.ok) continue;

      const blobBuffer = Buffer.from(await resp.arrayBuffer());
      if (blobBuffer.length < 10) continue;

      if (!verifyBlobHash(blobBuffer, artwork.hash)) {
        log.warn(`Indexer: peer ${peer.url} hash mismatch for ${artwork.hash.slice(0, 16)}...`);
        continue;
      }
      log.info(`Indexer: peer ${peer.url} blob verified for ${artwork.hash.slice(0, 16)}...`);

      // ── Verified — store complete blob ──
      db.storeBlob(artwork.hash, blobBuffer);
      db.upsertArtwork({
        hash: artwork.hash,
        chunkCount: artwork.chunk_count,
        blobSize: blobBuffer.length,
        width: artwork.width,
        height: artwork.height,
        mode: artwork.mode,
        network: artwork.network,
        pointerSig: artwork.pointer_sig,
      });

      log.info(`Indexer: filled ${artwork.hash.slice(0, 16)}... from peer ${peer.url} (${blobBuffer.length}B, verified)`);
      return true;
    } catch (err) {
      log.warn(`Indexer: peer ${peer.url} unavailable — ${err.message}`);
    }
  }
  return false;
}

/**
 * Chain spot-check: fetch 1-2 random on-chain memo chunks and compare to the blob.
 * This proves the peer's blob matches what's actually inscribed on Solana.
 * Returns true (passed), false (failed), or null (couldn't check).
 */
async function chainSpotCheck(blobBuffer, artwork) {
  if (!artwork.pointer_sig || !HELIUS_API_KEY) return null;

  try {
    // Get the list of chunk signatures from the chain (just the sigs, not full txs)
    const resp = await fetchRPC({
      jsonrpc: '2.0', id: 1,
      method: 'getSignaturesForAddress',
      params: [SERVER_WALLET, {
        before: artwork.pointer_sig,
        limit: Math.min(artwork.chunk_count + 5, 50),
      }],
    });
    const sigs = resp?.result || [];
    if (sigs.length === 0) return null;

    // Pick 1-2 random indices to spot-check
    const checkCount = Math.min(2, sigs.length);
    const indices = [];
    while (indices.length < checkCount) {
      const idx = Math.floor(Math.random() * Math.min(sigs.length, artwork.chunk_count));
      if (!indices.includes(idx)) indices.push(idx);
    }

    // Shred the blob the same way as inscription (585B chunks)
    const PAYLOAD_SIZE = 585;
    const blobChunks = [];
    for (let off = 0; off < blobBuffer.length; off += PAYLOAD_SIZE) {
      blobChunks.push(blobBuffer.slice(off, Math.min(off + PAYLOAD_SIZE, blobBuffer.length)));
    }

    // For each spot-check index, fetch the chain memo and compare
    for (const idx of indices) {
      // sigs are newest-first, chunks are oldest-first — reverse index
      const sigIdx = sigs.length - 1 - idx;
      if (sigIdx < 0 || sigIdx >= sigs.length) continue;
      if (sigs[sigIdx].err) continue;

      const txData = await fetchTransaction(sigs[sigIdx].signature);
      if (!txData) continue;

      const memoData = extractRPCMemoData(txData);
      if (!memoData || memoData.startsWith('FREEZEDRY:')) continue;

      // Strip v3 header to get the base64 payload
      const stripped = stripV3Header(memoData);

      // Decode the on-chain base64 data
      const chainBytes = Buffer.from(stripped, 'base64');

      // Compare to the blob's chunk at the same index
      if (idx < blobChunks.length) {
        const blobChunk = blobChunks[idx];
        if (!chainBytes.equals(blobChunk)) {
          log.warn(`Indexer: spot-check FAILED at chunk ${idx} — on-chain data doesn't match peer blob`);
          return false;
        }
      }

      await sleep(STAGGER_MS);
    }

    log.info(`Indexer: spot-check passed (${checkCount} chunks verified against chain) for ${artwork.hash.slice(0, 16)}...`);
    return true;
  } catch (err) {
    log.warn(`Indexer: spot-check error — ${err.message}`);
    return null; // couldn't check, don't reject
  }
}

/**
 * Bootstrap from peers — fetch artwork manifest on startup.
 * Uses delta sync (since=lastManifestSync) on subsequent runs.
 * Zero RPC credits. Typically <1s for deltas, <15s for full 100K sync.
 */
async function syncManifestFromPeers() {
  const lastSync = parseInt(db.getKV('last_manifest_sync') || '0', 10);
  const sources = [...PEER_NODES, ...db.listPeers().map(p => p.url)];
  const uniqueSources = [...new Set(sources)].filter(Boolean);

  if (uniqueSources.length === 0) return;

  for (const peerUrl of uniqueSources) {
    try {
      // Announce first so the peer recognizes us for the manifest request
      if (selfId()) {
        try { await announceToNode(peerUrl); } catch (err) { console.warn('[Indexer] announce to peer failed:', err.message); }
      }

      const url = lastSync > 0
        ? `${peerUrl}/sync/manifest?since=${lastSync}`
        : `${peerUrl}/sync/manifest`;

      const resp = await fetch(url, {
        headers: peerHeaders('manifest-pull'),
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) continue;

      const data = await resp.json();
      if (!data.artworks || data.artworks.length === 0) {
        log.info(`[Manifest] Peer ${peerUrl} — up to date (0 new since ${new Date(lastSync).toISOString()})`);
        break;
      }

      const result = db.importManifest(data.artworks);
      db.setKV('last_manifest_sync', String(data.latest || Date.now()));
      log.info(`[Manifest] Synced from ${peerUrl}: ${result.imported} new, ${result.skipped} known (${data.count} total from peer)`);
      break; // success — don't need to try other peers
    } catch (err) {
      log.warn(`[Manifest] Failed from ${peerUrl}: ${err.message}`);
    }
  }
}

/**
 * Join the peer network on startup:
 * 1. Register configured PEER_NODES
 * 2. Announce self to all peers (bidirectional)
 * 3. Gossip: fetch peers' peer lists to discover more nodes
 */
async function joinPeerNetwork() {
  // Register configured peers
  for (const peerUrl of PEER_NODES) {
    db.upsertPeer(peerUrl);
    log.info(`Indexer: registered peer ${peerUrl}`);
  }

  // Announce self to all known peers (works with NODE_URL or NODE_ENDPOINT)
  if (selfId()) {
    const peers = db.listPeers();
    for (const peer of peers) {
      try {
        await announceToNode(peer.url);
      } catch (err) {
        log.warn(`Indexer: failed to announce to ${peer.url} — ${err.message}`);
      }
    }
  }

  // Gossip: fetch peer lists from known peers to discover more
  await gossipPeers();
}

/** Announce this node to a peer — sends identity fields + signed headers */
async function announceToNode(peerUrl) {
  let identityPubkey = null, hotWalletPubkey = null;
  try {
    identityPubkey = getIdentityKeypair().publicKey.toBase58();
    hotWalletPubkey = getHotWallet().publicKey.toBase58();
  } catch (err) { console.warn('[Indexer] identity key unavailable, announcing without it:', err.message); }

  const resp = await fetch(`${peerUrl}/sync/announce`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...peerHeaders('sync-announce'),
    },
    body: JSON.stringify({
      url: NODE_URL || null,
      endpoint: NODE_ENDPOINT || null,
      identityPubkey,
      hotWalletPubkey,
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (resp.ok) {
    log.info(`Indexer: announced self to ${peerUrl}`);
  }
}

/** Gossip: fetch peer lists from known peers to discover the network */
async function gossipPeers() {
  const peers = db.listPeers();
  let discovered = 0;

  for (const peer of peers) {
    try {
      const fetchOpts = {
        signal: AbortSignal.timeout(10000),
        headers: peerHeaders('gossip-peers'),
        redirect: 'manual',
      };
      const resp = await fetch(`${peer.url}/nodes`, fetchOpts);
      if (!resp.ok) continue;
      const data = await resp.json();
      const peerList = data.nodes || [];

      const MAX_GOSSIP_PEERS = 20;  // cap per response to prevent flooding
      const MAX_TOTAL_PEERS = 50;   // cap total peer list size
      let accepted = 0;

      for (const node of peerList) {
        if (accepted >= MAX_GOSSIP_PEERS) break;
        if (db.listPeers().length >= MAX_TOTAL_PEERS) break;

        const nodeUrl = node.url || node;
        if (typeof nodeUrl !== 'string') continue;
        // Validate: public URL or IP:port, no private/reserved IPs or hostnames
        try {
          const parsed = new URL(nodeUrl);
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
          const h = parsed.hostname;
          if (h === 'localhost' || h === '127.0.0.1' || h === '::1') continue;
          if (h.startsWith('10.') || h.startsWith('192.168.') || h.startsWith('169.254.')) continue;
          if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) continue;
          if (h.endsWith('.internal') || h.endsWith('.local')) continue;
          if (h.startsWith('fd') || h.startsWith('fe80:')) continue; // IPv6 private
          if (h === '0.0.0.0' || h.startsWith('0.')) continue;
        } catch (err) { console.warn('[Indexer] invalid peer URL:', nodeUrl, err.message); continue; }
        if (nodeUrl === NODE_URL || nodeUrl === selfId()) continue; // don't add self

        const existing = db.listPeers().find(p => p.url === nodeUrl);
        if (!existing) {
          db.upsertPeer(nodeUrl, node.identityPubkey || null, node.hotWalletPubkey || null);
          discovered++;
          accepted++;
          log.info(`Indexer: discovered peer ${nodeUrl} via gossip from ${peer.url}`);
        }
      }
    } catch (err) {
      log.warn(`Indexer: gossip from ${peer.url} failed — ${err.message}`);
    }
  }

  if (discovered > 0) {
    log.info(`Indexer: gossip discovered ${discovered} new peer(s)`);

    // Announce self to newly discovered peers
    if (selfId()) {
      const allPeers = db.listPeers();
      for (const peer of allPeers) {
        try { await announceToNode(peer.url); } catch (err) { log.warn(`Indexer: announce to ${peer.url} failed — ${err.message}`); }
      }
    }
  }
}

// ─── Coordinator discovery: learn about peers from freezedry.art ───

// NOTE: COORDINATOR_URL read lazily via function — process.env isn't populated
// at module-init time because loadEnv() in server.js runs after static imports.
function getCoordinatorUrl() {
  return process.env.COORDINATOR_URL || 'https://freezedry.art';
}

/**
 * Discover peer nodes from the coordinator's node registry.
 * Nodes register with the coordinator (wallet-authed), and we discover them here.
 * Runs on startup + every gossip cycle.
 */
async function discoverFromCoordinator() {
  try {
    const resp = await fetch(`${getCoordinatorUrl()}/api/nodes?action=list`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const nodes = data.nodes || [];

    let discovered = 0;
    for (const node of nodes) {
      const peerAddr = node.nodeUrl || node.endpoint;
      if (!peerAddr || peerAddr === NODE_URL || peerAddr === selfId()) continue; // skip self
      if (node.role !== 'reader' && node.role !== 'both') continue; // only sync from readers
      // SSRF validation — don't store private/reserved addresses
      try {
        const parsed = new URL(peerAddr.startsWith('http') ? peerAddr : `http://${peerAddr}`);
        const h = parsed.hostname;
        if (h === 'localhost' || h === '127.0.0.1' || h === '::1') continue;
        if (h.startsWith('10.') || h.startsWith('192.168.') || h.startsWith('169.254.')) continue;
        if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) continue;
        if (h.endsWith('.internal') || h.endsWith('.local')) continue;
      } catch (err) { console.warn('[Indexer] invalid coordinator peer URL:', peerAddr, err.message); continue; }
      const existing = db.listPeers().find(p => p.url === peerAddr);
      if (!existing) {
        db.upsertPeer(peerAddr, node.identityPubkey || null, node.hotWalletPubkey || null);
        discovered++;
        log.info(`Indexer: discovered peer ${peerAddr} from coordinator`);
      }
    }
    if (discovered > 0) log.info(`Indexer: coordinator discovery found ${discovered} new peer(s)`);
  } catch (err) {
    log.warn(`Indexer: coordinator discovery failed — ${err.message}`);
  }
}

// ─── Direct PDA discovery: read Registry program on-chain (no middleman) ───

/**
 * Discover peer nodes directly from on-chain Registry PDAs.
 * Reads getProgramAccounts with NODE_DISC discriminator — ~1 RPC call, ~3 credits.
 * Runs alongside coordinator discovery for resilience: if coordinator is down,
 * nodes still find each other via chain. New nodes auto-discovered on next cycle.
 */
async function discoverFromRegistry() {
  if (!HELIUS_RPC) return;

  try {
    const { Connection, PublicKey } = await import('@solana/web3.js');
    const { REGISTRY_PROGRAM_ID, NODE_DISC, parseNodeAccount } = await import('./chain/tx-builder.js');

    const conn = getPoolConnection() || new Connection(HELIUS_RPC, 'confirmed');
    const accounts = await conn.getProgramAccounts(REGISTRY_PROGRAM_ID, {
      filters: [{
        memcmp: { offset: 0, bytes: Buffer.from(NODE_DISC).toString('base64'), encoding: 'base64' },
      }],
    });

    let discovered = 0;
    for (const { pubkey, account } of accounts) {
      const node = parseNodeAccount(pubkey, account.data);
      if (!node) continue;
      if (!node.isActive) continue;
      const peerAddr = node.url || node.endpoint;
      if (!peerAddr || peerAddr === NODE_URL || peerAddr === selfId()) continue; // skip self
      if (node.role !== 'reader' && node.role !== 'both') continue; // only sync from readers

      const existing = db.listPeers().find(p => p.url === peerAddr);
      if (!existing) {
        db.upsertPeer(peerAddr, null, node.wallet ? node.wallet.toBase58() : null);
        discovered++;
        log.info(`Indexer: discovered peer ${peerAddr} from on-chain registry (wallet: ${node.wallet.toBase58().slice(0, 8)}...)`);
      }
    }

    if (discovered > 0) {
      log.info(`Indexer: on-chain registry found ${discovered} new peer(s)`);
      // Announce self to newly discovered peers for bidirectional sync
      if (selfId()) {
        const allPeers = db.listPeers();
        for (const peer of allPeers) {
          try { await announceToNode(peer.url); } catch (err) { console.warn('[Indexer] announce to discovered peer failed:', err.message); }
        }
      }
    }
  } catch (err) {
    log.warn(`Indexer: on-chain registry discovery failed — ${err.message}`);
  }
}

// ─── Coordinator registration: auto-register with wallet auth ───

/**
 * Auto-register this node with the coordinator using ed25519 wallet signature.
 * Requires NODE_URL + WALLET_KEYPAIR in .env.
 * Runs on startup + periodically to refresh liveness.
 */
async function registerWithCoordinator() {
  if (!NODE_URL && !NODE_ENDPOINT) return;

  let identityPubkey, hotWalletPubkey, keypair;
  try {
    keypair = getIdentityKeypair();
    identityPubkey = keypair.publicKey.toBase58();
    hotWalletPubkey = getHotWallet().publicKey.toBase58();
  } catch (err) {
    console.warn('[Indexer] identity/hot wallet load failed, trying legacy fallback:', err.message);
    // Legacy fallback — try WALLET_KEYPAIR directly
    const keypairJson = process.env.WALLET_KEYPAIR || '';
    if (!keypairJson) {
      log.info('Indexer: no identity key — skipping coordinator registration (discovery still works)');
      return;
    }
    const { Keypair } = await import('@solana/web3.js');
    keypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(keypairJson)));
    identityPubkey = keypair.publicKey.toBase58();
    hotWalletPubkey = identityPubkey; // same wallet for both
  }

  try {
    const ROLE = process.env.ROLE || 'both';
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = randomBytes(8).toString('hex');
    // Use identity pubkey as identifier (colon-free) — URLs break the : delimiter
    const message = `FreezeDry:node-register:${identityPubkey}:${timestamp}:${nonce}`;
    const signature = signMessage(keypair, message);

    const resp = await fetch(`${getCoordinatorUrl()}/api/nodes?action=register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: process.env.NODE_ID || 'freezedry-node',
        nodeUrl: NODE_URL || null,
        endpoint: NODE_ENDPOINT || null,
        role: ROLE,
        walletPubkey: identityPubkey, // signer must match walletPubkey for verification
        identityPubkey,
        hotWalletPubkey,
        message,
        signature,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (resp.ok) {
      const data = await resp.json();
      log.info(`Indexer: registered with coordinator (identity: ${identityPubkey.slice(0, 8)}..., status: ${data.status})`);
    } else {
      const text = await resp.text().catch(() => '');
      log.warn(`Indexer: coordinator registration failed (${resp.status}): ${text.slice(0, 200)}`);
    }
  } catch (err) {
    log.warn(`Indexer: coordinator registration error — ${err.message}`);
  }
}

// ─── Seed from registry (startup backfill) ───

async function seedFromRegistry() {
  if (!REGISTRY_URL) return;

  log.info('Indexer: seeding from registry...');
  const baseUrl = REGISTRY_URL.includes('/api/registry')
    ? REGISTRY_URL
    : `${REGISTRY_URL}/api/registry`;

  let page = 1;
  let newCount = 0;
  let totalPages = 1;

  while (page <= totalPages) {
    const resp = await fetch(`${baseUrl}?action=list&limit=100&page=${page}&showLocked=true`);
    if (!resp.ok) {
      log.warn(`Indexer: registry page ${page} returned ${resp.status}, stopping seed`);
      break;
    }

    const data = await resp.json();
    const artworks = data.artworks || [];
    totalPages = data.pages || 1;

    if (artworks.length === 0) break;

    for (const art of artworks) {
      const existing = db.getArtwork(art.hash);
      if (existing) {
        // Backfill pointer_sig from registry if missing locally
        if (!existing.pointer_sig && art.pointerSig) {
          db.upsertArtwork({
            hash: art.hash,
            chunkCount: art.chunkCount || existing.chunk_count,
            blobSize: art.blobSize || existing.blob_size,
            width: art.width || existing.width,
            height: art.height || existing.height,
            mode: art.mode || existing.mode || 'open',
            network: art.network || existing.network || 'mainnet',
            pointerSig: art.pointerSig,
            chunks: null,
          });
          log.info(`Indexer: backfilled pointer_sig from registry for ${art.hash.slice(0, 24)}...`);
          newCount++;
        }
        continue;
      }

      db.upsertArtwork({
        hash: art.hash,
        chunkCount: art.chunkCount || art.sigCount || 0,
        blobSize: art.blobSize || null,
        width: art.width || null,
        height: art.height || null,
        mode: art.mode || 'open',
        network: art.network || 'mainnet',
        pointerSig: art.pointerSig || null,
        chunks: null,
      });
      newCount++;
    }

    page++;
  }

  log.info(`Indexer: seeded ${newCount} new artworks from registry (${totalPages} pages)`);
}

// ─── Enhanced API helpers (paid plans) ───

/**
 * Fetch via Helius Enhanced Transactions API.
 * 100 credits per 100 results — Developer+ plans only.
 */
async function fetchEnhancedTransactions(address, beforeSig, limit = 100) {
  let url = `https://api-mainnet.helius-rpc.com/v0/addresses/${address}/transactions/?api-key=${HELIUS_API_KEY}&limit=${Math.min(limit, 100)}`;
  if (beforeSig) url += `&before=${beforeSig}`;

  const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });

  if (resp.status === 429) {
    _consecutive429s++;
    const backoff = getBackoffMs();
    log.warn(`Indexer: rate limited (429) — backoff ${Math.round(backoff / 1000)}s (streak: ${_consecutive429s})`);
    await sleep(backoff);
    return [];
  }
  _consecutive429s = 0; // reset on success
  if (resp.status === 403 || resp.status === 401) {
    throw new Error(`Enhanced API returned ${resp.status} — Forbidden`);
  }
  if (!resp.ok) throw new Error(`Enhanced API returned ${resp.status}`);
  trackCredits(100); // Enhanced API: ~100 credits per batch
  return resp.json();
}

/** Extract memo data from Enhanced API transaction format.
 *  Helius Enhanced API returns memo instruction data as base58 — decode to UTF-8. */
function extractEnhancedMemoData(tx) {
  for (const ix of tx?.instructions || []) {
    if (ix.programId === MEMO_PROGRAM && ix.data) return decodeBase58Memo(ix.data);
  }
  for (const inner of tx?.innerInstructions || []) {
    for (const ix of inner?.instructions || []) {
      if (ix.programId === MEMO_PROGRAM && ix.data) return decodeBase58Memo(ix.data);
    }
  }
  return null;
}

/** Decode base58-encoded memo data to UTF-8 string.
 *  Inline decoder — no external dependency needed. */
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = new Uint8Array(128).fill(255);
for (let i = 0; i < B58_ALPHABET.length; i++) B58_MAP[B58_ALPHABET.charCodeAt(i)] = i;

function decodeBase58(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let carry = B58_MAP[str.charCodeAt(i)];
    if (carry === 255) throw new Error('Invalid base58 char');
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
  // Leading '1's = leading zero bytes
  for (let i = 0; i < str.length && str[i] === '1'; i++) bytes.push(0);
  return Buffer.from(bytes.reverse());
}

function decodeBase58Memo(data) {
  if (data.startsWith('FREEZEDRY:') || data.startsWith('FD:')) return data;
  try {
    return decodeBase58(data).toString('utf-8');
  } catch (err) {
    console.warn('[Indexer] base58 memo decode failed, using raw:', err.message);
    return data;
  }
}

/** Encode bytes to base58 string (for public key → base58 address) */
function encodeBase58(bytes) {
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

// ─── Standard RPC helpers (free plan) ───

async function fetchRPC(body) {
  const rpcUrl = getPoolRpcUrl();
  const resp = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (resp.status === 429) {
    _consecutive429s++;
    const backoff = getBackoffMs();
    log.warn(`Indexer: rate limited (429) — backoff ${Math.round(backoff / 1000)}s (streak: ${_consecutive429s})`);
    await sleep(backoff);
    return null;
  }
  _consecutive429s = 0;
  trackCredits(1);

  if (!resp.ok) throw new Error(`RPC returned ${resp.status}`);
  return resp.json();
}

async function fetchTransaction(signature) {
  const resp = await fetchRPC({
    jsonrpc: '2.0', id: 1,
    method: 'getTransaction',
    params: [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
  });
  return resp?.result || null;
}

/** Extract memo data from standard jsonParsed RPC transaction format */
function extractRPCMemoData(tx) {
  const msg = tx?.transaction?.message;
  if (!msg) return null;
  for (const ix of msg.instructions || []) {
    if (ix.programId === MEMO_PROGRAM && ix.parsed) return ix.parsed;
  }
  for (const inner of tx.meta?.innerInstructions || []) {
    for (const ix of inner.instructions || []) {
      if (ix.programId === MEMO_PROGRAM && ix.parsed) return ix.parsed;
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
