/**
 * writer/claimer.js — On-chain job marketplace claimer for writer nodes.
 *
 * Polling loop (runs when MARKETPLACE_ENABLED=true):
 *   1. Poll open jobs from freezedry_jobs program
 *   2. Pick oldest (FIFO by job_id) within local capacity
 *   3. Claim on-chain → fetch blob → inscribe → submit receipt
 *
 * Uses tx-builder.js for instruction construction (no Anchor dependency).
 */

import { PublicKey } from '@solana/web3.js';
import { createHash } from 'crypto';
import { env } from '../config.js';
import { getServerKeypair } from '../wallet.js';
import { rpcCall, sendWithRetry, fetchPriorityFee } from './rpc.js';
import { processInscription, jobs as activeJobs } from './inscribe.js';
import * as db from '../db.js';
import { isHydBlob, isOpenMode, extractContentHash, stripSha256Prefix, computeBlobHash } from '../hyd.js';
import {
  JOBS_PROGRAM_ID, REGISTRY_PROGRAM_ID,
  JOB_DISC, deriveConfigPDA, deriveJobPDA, deriveNodePDA,
  deriveRegistryConfigPDA, parseNodeAccount, parseRegistryConfig,
  parseJobAccount, parseConfigAccount, buildClaimJobIx, buildSubmitReceiptIx,
  buildRequeueExpiredIx, buildSignedTx,
} from '../chain/tx-builder.js';
import {
  fetchOpenJobs as cachedFetchOpenJobs,
  fetchAllJobs as cachedFetchAllJobs,
  getConnection as getJobsConnection,
} from '../chain/jobs-cache.js';
import { gossipBlob } from '../gossip.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const POLL_INTERVAL = parseInt(env('CLAIM_POLL_INTERVAL') || '30000', 10);
const CLAIM_TIMEOUT = parseInt(env('CLAIM_TIMEOUT_MS') || '1800000', 10); // 30 min
const MAX_CONCURRENT_CLAIMS = parseInt(env('CAPACITY') || '2', 10);
const MAX_BLOB_BYTES = parseInt(env('MAX_BLOB_MB') || '10', 10) * 1024 * 1024; // default 10MB
// Minimum escrow multiplier over TX cost — skip jobs that don't cover costs + margin.
// 1.0 = accept any job where escrow covers TX reimbursement. >1.0 = require margin cushion.
const MIN_ESCROW_MULTIPLIER = parseFloat(env('MIN_ESCROW_MULTIPLIER') || '1.0');
const BASE_TX_FEE_ESTIMATE = parseInt(env('BASE_TX_FEE_ESTIMATE') || '5000', 10); // on-chain baseTxFeeLamports (v3)

// ── Node operation mode ──────────────────────────────────────────────────────
// "dedicated" — only claim jobs assigned to this node. Overflow → open market after window expires.
// "open"      — claim any job, but assigned-to-me jobs always jump to front of queue.
const NODE_MODE = (env('NODE_MODE') || 'open').toLowerCase();
// Reserve capacity slots for assigned jobs (only in "open" mode).
// e.g. CAPACITY=3, RESERVED_SLOTS=1 → max 2 open-market jobs, 1 slot always free for assigned work.
const RESERVED_SLOTS = parseInt(env('RESERVED_SLOTS') || '0', 10);

// ── Priority claim delay (3-tier on-chain stake verification) ────────────────
// Tier 1: Node staked to FreezeDry preferred validator → 0ms (instant claim)
// Tier 2: Node staked to any other validator → 0-7s (scaled by amount, 500 SOL = 0s)
// Tier 3: No verified stake or stale (>7 days) → 15s delay
const TIER3_DELAY_MS     = 15_000;        // unstaked nodes wait 15s
const TIER2_MAX_DELAY_MS = 7_000;         // staked (non-preferred) max delay
const TIER2_ZERO_AT_SOL  = 500;           // 500 SOL delegation = 0s in Tier 2
const STAKE_FRESH_WINDOW = 7 * 24 * 3600; // 7 days in seconds

let _claimDelayMs = TIER3_DELAY_MS; // default to unstaked, updated on startup
let _stakeTier = 'unstaked';         // 'preferred-validator' | 'staked' | 'unstaked'

async function computeClaimDelay() {
  try {
    const keypair = getServerKeypair();
    const [nodePDA] = deriveNodePDA(keypair.publicKey);
    const conn = getConnection();

    // 1. Read NodeAccount PDA to get verified stake fields
    const nodeInfo = await conn.getAccountInfo(nodePDA);
    if (!nodeInfo) {
      console.log(`[Claimer] NodeAccount PDA not found — Tier 3 (${TIER3_DELAY_MS}ms delay)`);
      _stakeTier = 'unstaked';
      return TIER3_DELAY_MS;
    }

    const node = parseNodeAccount(nodePDA, Buffer.from(nodeInfo.data));
    if (!node) {
      console.log(`[Claimer] Failed to parse NodeAccount — Tier 3 (${TIER3_DELAY_MS}ms delay)`);
      _stakeTier = 'unstaked';
      return TIER3_DELAY_MS;
    }

    // 2. Check if stake is verified and fresh
    const now = Math.floor(Date.now() / 1000);
    if (node.verifiedStake === 0 || (now - node.stakeVerifiedAt) > STAKE_FRESH_WINDOW) {
      const reason = node.verifiedStake === 0 ? 'no verified stake' : 'stake verification stale';
      console.log(`[Claimer] ${reason} — Tier 3 (${TIER3_DELAY_MS}ms delay)`);
      _stakeTier = 'unstaked';
      return TIER3_DELAY_MS;
    }

    // 3. Read RegistryConfig PDA for preferred validator
    const [configPDA] = deriveRegistryConfigPDA();
    const configInfo = await conn.getAccountInfo(configPDA);
    let preferredValidator = null;

    if (configInfo) {
      const config = parseRegistryConfig(configPDA, Buffer.from(configInfo.data));
      if (config) preferredValidator = config.preferredValidator;
    }

    // 4. Tier 1: staked to preferred validator
    if (preferredValidator && node.stakeVoter.equals(preferredValidator)) {
      const stakeSol = (node.verifiedStake / 1e9).toFixed(2);
      console.log(`[Claimer] Staked to preferred validator (${stakeSol} SOL) — Tier 1 (0ms delay)`);
      _stakeTier = 'preferred-validator';
      return 0;
    }

    // 5. Tier 2: staked to any validator — delay scales inversely with amount
    const stakeSol = node.verifiedStake / 1e9;
    const ratio = Math.min(1, stakeSol / TIER2_ZERO_AT_SOL);
    const delay = Math.round(TIER2_MAX_DELAY_MS * (1 - ratio));
    console.log(`[Claimer] Staked ${stakeSol.toFixed(2)} SOL to ${node.stakeVoter.toBase58().slice(0, 8)}... — Tier 2 (${delay}ms delay)`);
    _stakeTier = 'staked';
    return delay;

  } catch (err) {
    console.warn(`[Claimer] Could not read stake: ${err.message} — Tier 3 default`);
    _stakeTier = 'unstaked';
    return TIER3_DELAY_MS;
  }
}

// Track claimed jobs in-progress
const claimedJobs = new Map(); // jobId → { startedAt, status, pointerSig }

let _running = false;
let _pollTimer = null;

// ── Queue snapshot (updated every poll cycle for /marketplace/queue) ─────────
let _queueSnapshot = { depth: 0, oldestJobId: null, oldestJobAge: 0, staleCount: 0, snapshotAt: 0 };
const STALE_THRESHOLD_S = 2 * 3600; // 2 hours — jobs older than this get a warning

// ── RPC connection (shared with attester via jobs-cache.js) ──────────────────

function getConnection() {
  return getJobsConnection();
}

// ── Fetch open jobs (shared cache — saves 1 gPA per poll cycle) ──────────────
// Shared with attester via chain/jobs-cache.js (10s TTL).

async function fetchOpenJobs() {
  return cachedFetchOpenJobs();
}

// ── Claim a job on-chain ─────────────────────────────────────────────────────

async function claimJob(job) {
  const keypair = getServerKeypair();
  const writerPubkey = keypair.publicKey;
  const conn = getConnection(); // Uses JOBS_RPC_URL (same network as Jobs program)

  const [configPDA] = deriveConfigPDA();
  const [nodePDA] = deriveNodePDA(writerPubkey);
  const [registryConfigPDA] = deriveRegistryConfigPDA();
  const jobPDA = job.address; // already a PublicKey from parseJobAccount

  const ix = buildClaimJobIx(jobPDA, configPDA, nodePDA, registryConfigPDA, writerPubkey);

  const { blockhash, lastValidBlockHeight } = (await conn.getLatestBlockhash('confirmed'));
  const txBase64 = buildSignedTx(ix, blockhash, keypair);
  const rawTx = Buffer.from(txBase64, 'base64');
  const sig = await conn.sendRawTransaction(rawTx, { skipPreflight: false, preflightCommitment: 'confirmed' });

  // Proper confirmation — wait up to 30s
  const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (conf.value?.err) throw new Error(`claim_job tx failed: ${JSON.stringify(conf.value.err)}`);

  console.log(`[Claimer] Claimed job #${job.jobId} — tx: ${sig}`);
  return sig;
}

// ── Submit receipt after inscription completes ───────────────────────────────

async function submitReceipt(job, pointerSig) {
  const keypair = getServerKeypair();
  const conn = getConnection(); // Uses JOBS_RPC_URL (same network as Jobs program)
  const jobPDA = job.address;

  const ix = buildSubmitReceiptIx(jobPDA, keypair.publicKey, pointerSig);

  const { blockhash, lastValidBlockHeight } = (await conn.getLatestBlockhash('confirmed'));
  const txBase64 = buildSignedTx(ix, blockhash, keypair);
  const rawTx = Buffer.from(txBase64, 'base64');
  const sig = await conn.sendRawTransaction(rawTx, { skipPreflight: false, preflightCommitment: 'confirmed' });

  // Proper confirmation — wait up to 30s
  const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (conf.value?.err) throw new Error(`submit_receipt tx failed: ${JSON.stringify(conf.value.err)}`);

  console.log(`[Claimer] Submitted receipt for job #${job.jobId} — pointer: ${pointerSig}, tx: ${sig}`);
  return sig;
}

// ── SSRF guard — block fetches to private/internal IPs ───────────────────────

function isPrivateUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const host = u.hostname;
    if (['localhost', '127.0.0.1', '::1', '0.0.0.0', 'metadata.google.internal'].includes(host)) return true;
    const parts = host.split('.');
    if (parts[0] === '10') return true;
    if (parts[0] === '172' && parseInt(parts[1]) >= 16 && parseInt(parts[1]) <= 31) return true;
    if (parts[0] === '192' && parts[1] === '168') return true;
    if (parts[0] === '169' && parts[1] === '254') return true;
    return false;
  } catch { return true; }
}

// ── Fetch blob for a job ─────────────────────────────────────────────────────

async function fetchJobBlob(job) {
  // Try multiple sources with priority cascade.
  // Only the claimer who claimed the job on-chain should be fetching — stake delay prevents stampede.
  const coordinatorUrl = env('COORDINATOR_URL') || 'https://freezedry.art';
  const cdnUrl = env('CDN_URL') || 'https://cdn.freezedry.art';
  const hash = job.contentHash; // raw hex (no sha256: prefix) from on-chain Job PDA
  const cleanHash = hash.replace(/^sha256:/, '');

  // Priority -1: Check local DB first — blob may already be here from /upload endpoint
  const localBlob = db.getBlob(`sha256:${cleanHash}`);
  if (localBlob && localBlob.length > 0) {
    console.log(`[Claimer] Local blob found for job #${job.jobId} (${localBlob.length} bytes) — zero fetch`);
    return localBlob;
  }

  // Priority 0: on-chain blob_source (implementor-specified URL)
  // Priority 1: CDN R2 staging (Path C uploads go here directly)
  // Priority 2: coordinator fallback (legacy Path A/B)
  // Priority 3: chain reconstruction (slowest fallback)
  const urls = [];
  if (job.blobSource && job.blobSource.length > 0) {
    if (isPrivateUrl(job.blobSource)) {
      console.warn(`[Claimer] Skipping private/internal blob_source for job #${job.jobId}: ${job.blobSource}`);
    } else {
      urls.push(job.blobSource);
    }
  }
  urls.push(
    `${cdnUrl}/blob/sha256:${encodeURIComponent(hash)}`,
    `${coordinatorUrl}/api/memo-store?action=serve-job-blob&hash=${encodeURIComponent(hash)}`,
    `${coordinatorUrl}/api/fetch-chain?hash=${encodeURIComponent(hash)}&format=blob`,
  );

  for (const url of urls) {
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
        redirect: 'follow',
      });
      if (!resp.ok) continue;
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length === 0) continue;

      // Verify hash — try both SHA-256(blob) and manifest hash
      const cleanHash = stripSha256Prefix(hash);
      const blobSha256 = createHash('sha256').update(buf).digest('hex');
      let hashMatch = blobSha256 === cleanHash;
      if (!hashMatch && isOpenMode(buf)) {
        hashMatch = extractContentHash(buf) === cleanHash;
      }
      if (!hashMatch) {
        console.warn(`[Claimer] Hash mismatch for job #${job.jobId}: expected ${cleanHash.slice(0, 16)}...`);
        continue;
      }

      console.log(`[Claimer] Fetched blob for job #${job.jobId} (${buf.length} bytes) from ${new URL(url).pathname}`);
      return buf;
    } catch (err) {
      console.warn(`[Claimer] Blob fetch failed from ${url}: ${err.message}`);
    }
  }

  throw new Error(`Could not fetch blob for job #${job.jobId} (hash: ${hash})`);
}

// ── Execute a claimed job (fetch blob → inscribe → submit receipt) ───────────

async function executeClaimedJob(job) {
  const jobId = String(job.jobId);
  claimedJobs.set(job.jobId, { startedAt: Date.now(), status: 'inscribing', pointerSig: null });

  try {
    // Fetch the blob
    console.log(`[Claimer] Fetching blob for job #${job.jobId} (${job.chunkCount} chunks)...`);
    const blobBuffer = await fetchJobBlob(job);

    // Run inscription (reuses existing inscription pipeline)
    // Callback to our coordinator so we have visibility into our own node's progress
    const coordinatorUrl = env('COORDINATOR_URL') || 'https://freezedry.art';
    const callbackUrl = `${coordinatorUrl}/api/memo-store?action=job-callback`;
    const localJobId = `chain-${job.jobId}`;
    const meta = { creator: job.creator?.toBase58?.() || job.creator || undefined };
    await processInscription(localJobId, blobBuffer, job.chunkCount, job.contentHash, callbackUrl, meta);

    // Get the inscription result
    const result = activeJobs.get(localJobId);
    if (!result || result.status === 'failed' || result.status === 'error') {
      throw new Error(result?.error || 'Inscription failed');
    }

    let pointerSig = result.pointerSig;
    if (!pointerSig) {
      // Inscription succeeded but pointer failed — retry here before giving up
      console.warn(`[Claimer] Job #${job.jobId} inscription done but no pointer — retrying pointer...`);
      const { sendPointerMemo } = await import('./pointer.js');
      for (let retry = 0; retry < 3; retry++) {
        try {
          pointerSig = await sendPointerMemo(result);
          if (pointerSig) { result.pointerSig = pointerSig; break; }
        } catch (e) {
          console.error(`[Claimer] Pointer retry ${retry + 1}/3: ${e.message}`);
          await new Promise(r => setTimeout(r, 5000 * (retry + 1)));
        }
      }
      if (!pointerSig) {
        throw new Error('Inscription completed but pointer failed after all retries — chunks are on-chain, job will be retried');
      }
    }

    // Store blob locally so peer attesters can fetch via GET /blob/:hash
    // CDN + registry use the MANIFEST hash (HYD header bytes 17-48), not SHA-256(blob).
    const storageHash = computeBlobHash(blobBuffer);
    const hydBlob = isHydBlob(blobBuffer);
    const openMode = isOpenMode(blobBuffer);

    // Create artwork record first (storeBlob needs it for markComplete)
    db.upsertArtwork({
      hash: storageHash,
      chunkCount: job.chunkCount,
      blobSize: blobBuffer.length,
      width: openMode ? blobBuffer.readUInt16LE(5) : null,
      height: openMode ? blobBuffer.readUInt16LE(7) : null,
      mode: openMode ? 'open' : 'encrypted',
      network: 'mainnet',
      pointerSig: pointerSig,
      chunks: null,
    });
    db.storeBlob(storageHash, blobBuffer);

    // Auto-pin blobs this node inscribed — protected from pruning
    db.pinBlob(storageHash);

    // Twilight Bark: gossip blob to peers so CDN + other nodes can serve it
    gossipBlob(storageHash, job.chunkCount, []).catch(err => {
      console.warn(`[Claimer] Gossip failed for job #${job.jobId}: ${err.message}`);
    });
    console.log(`[Claimer] Stored blob under ${storageHash.slice(0, 30)}... (${hydBlob ? 'manifest' : 'sha256'} hash)`);

    // Submit receipt on-chain (with retries — inscription + pointer already done)
    claimedJobs.get(job.jobId).status = 'submitting';
    let receiptSubmitted = false;
    for (let rAttempt = 0; rAttempt < 3; rAttempt++) {
      try {
        await submitReceipt(job, pointerSig);
        receiptSubmitted = true;
        break;
      } catch (rErr) {
        console.error(`[Claimer] submit_receipt attempt ${rAttempt + 1}/3 for job #${job.jobId}: ${rErr.message}`);
        if (rAttempt < 2) await sleep(5000 * (rAttempt + 1));
      }
    }
    if (!receiptSubmitted) {
      throw new Error('submit_receipt failed after 3 attempts — pointer is on-chain, receipt not submitted');
    }

    claimedJobs.get(job.jobId).status = 'completed';
    claimedJobs.get(job.jobId).pointerSig = pointerSig;
    console.log(`[Claimer] Job #${job.jobId} fully completed — pointer: ${pointerSig}`);

    // Log expected marketplace writer earnings (reimbursement + 40% margin)
    try {
      const reimbursement = job.chunkCount * 5000;
      const margin = Number(job.escrowLamports) - reimbursement;
      const writerMargin = Math.floor(margin * 4000 / 10000);
      db.logEarning(job.jobId.toString(), 'marketplace', 'escrow_released',
        reimbursement + writerMargin, null,
        { escrow: Number(job.escrowLamports), chunks: job.chunkCount, role: 'writer' }
      );
    } catch (err) {
      console.warn('[Claimer] Earnings log failed:', err.message);
    }

    // Clean up after a delay (keep for status queries)
    setTimeout(() => {
      claimedJobs.delete(job.jobId);
      activeJobs.delete(localJobId);
    }, 5 * 60_000);

  } catch (err) {
    console.error(`[Claimer] Job #${job.jobId} failed: ${err.message}`);
    const tracked = claimedJobs.get(job.jobId);
    if (tracked) tracked.status = 'error';

    // Clean up failed job after 2 minutes
    setTimeout(() => claimedJobs.delete(job.jobId), 2 * 60_000);
  }
}

// ── ZombieSlayer: sweep stale claimed jobs back to Open ──────────────────

let _lastSweep = 0;
const SWEEP_INTERVAL = 5 * 60_000; // check every 5 min (not every poll)

async function sweepZombieJobs() {
  const now = Date.now();
  if (now - _lastSweep < SWEEP_INTERVAL) return;
  _lastSweep = now;

  try {
    const allJobs = await cachedFetchAllJobs();
    const conn = getJobsConnection();

    // Read config for claim timeout (job_expiry_seconds / 2 is enforced on-chain)
    const [configPDA] = deriveConfigPDA();
    const configInfo = await conn.getAccountInfo(configPDA);
    if (!configInfo) return;
    const config = parseConfigAccount(configPDA, Buffer.from(configInfo.data));
    if (!config) return;
    const claimTimeout = config.jobExpirySeconds / 2;

    const nowSec = Math.floor(now / 1000);
    const keypair = getServerKeypair();

    for (const job of allJobs) {
      if (job.status !== 'claimed') continue;
      if (job.claimedAt === 0) continue;

      const elapsed = nowSec - job.claimedAt;
      if (elapsed <= claimTimeout) continue;

      // This job is a zombie — requeue it
      console.log(`[ZombieSlayer] Job #${job.jobId} claimed ${Math.round(elapsed / 60)}min ago (timeout ${Math.round(claimTimeout / 60)}min) — requeuing`);

      try {
        const ix = buildRequeueExpiredIx(job.address, configPDA, keypair.publicKey);
        const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
        const txBase64 = buildSignedTx(ix, blockhash, keypair);
        const rawTx = Buffer.from(txBase64, 'base64');
        const sig = await conn.sendRawTransaction(rawTx, { skipPreflight: false, preflightCommitment: 'confirmed' });
        const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
        if (conf.value?.err) {
          console.warn(`[ZombieSlayer] requeue tx failed: ${JSON.stringify(conf.value.err)}`);
        } else {
          console.log(`[ZombieSlayer] Job #${job.jobId} requeued to Open — tx: ${sig}`);
        }
      } catch (err) {
        console.warn(`[ZombieSlayer] Failed to requeue job #${job.jobId}: ${err.message}`);
      }
    }
  } catch (err) {
    console.warn(`[ZombieSlayer] Sweep error: ${err.message}`);
  }
}

// ── Main polling loop ────────────────────────────────────────────────────────

async function pollAndClaim() {
  if (!_running) return;

  // ZombieSlayer: check for stale claimed jobs (throttled to every 5 min)
  await sweepZombieJobs();

  try {
    // Check local capacity
    const activeClaims = [...claimedJobs.values()].filter(
      c => c.status === 'inscribing' || c.status === 'submitting'
    ).length;

    const myWallet = getServerKeypair().publicKey.toBase58();
    const atFullCapacity = activeClaims >= MAX_CONCURRENT_CLAIMS;
    // In open mode with reserved slots, open-market jobs have a lower cap
    const openMarketCap = Math.max(1, MAX_CONCURRENT_CLAIMS - RESERVED_SLOTS);
    const atOpenMarketCap = activeClaims >= openMarketCap;

    // Check for stale claims (timeout)
    const now = Date.now();
    for (const [jobId, claim] of claimedJobs) {
      if ((claim.status === 'inscribing' || claim.status === 'submitting')
          && now - claim.startedAt > CLAIM_TIMEOUT) {
        console.warn(`[Claimer] Job #${jobId} timed out after ${Math.round((now - claim.startedAt) / 60_000)}min — marking failed`);
        claim.status = 'timeout';
      }
    }

    // Fetch open jobs + update queue snapshot
    const openJobs = await fetchOpenJobs();

    // Update queue snapshot for monitoring
    const nowSec = Math.floor(Date.now() / 1000);
    if (openJobs.length > 0) {
      const oldest = openJobs[0]; // FIFO-sorted, oldest first
      const oldestAge = oldest.createdAt ? nowSec - oldest.createdAt : 0;
      let staleCount = 0;
      for (const j of openJobs) {
        const age = j.createdAt ? nowSec - j.createdAt : 0;
        if (age > STALE_THRESHOLD_S) {
          staleCount++;
          console.warn(`[Claimer] STALE JOB #${j.jobId} — open for ${Math.round(age / 60)}min (>${Math.round(STALE_THRESHOLD_S / 60)}min threshold)`);
        }
      }
      _queueSnapshot = {
        depth: openJobs.length,
        oldestJobId: oldest.jobId,
        oldestJobAge: oldestAge,
        staleCount,
        snapshotAt: Date.now(),
      };
    } else {
      _queueSnapshot = { depth: 0, oldestJobId: null, oldestJobAge: 0, staleCount: 0, snapshotAt: Date.now() };
    }

    if (openJobs.length === 0) return;

    // Pick the oldest job we haven't already claimed
    const alreadyClaimed = new Set(claimedJobs.keys());
    const available = openJobs.filter(j => !alreadyClaimed.has(j.jobId));
    if (available.length === 0) return;

    // Separate assigned-to-me jobs from open market
    const assignedToMe = available.filter(j => j.assignedNode && j.assignedNode.toBase58() === myWallet);
    const openMarket = available.filter(j => !j.assignedNode || j.assignedNode.toBase58() !== myWallet);

    // Assigned jobs always get priority — pick from those first
    let target = assignedToMe[0] || null;
    let isAssigned = !!target;

    if (target && atFullCapacity) {
      // Even assigned jobs can't exceed hard capacity
      return;
    }

    if (!target) {
      // No assigned jobs — consider open market
      if (NODE_MODE === 'dedicated') return; // dedicated mode: only my assigned jobs
      if (atOpenMarketCap) return;           // open mode: respect reserved slots
      target = openMarket[0];                // FIFO — oldest first
    }

    if (!target) return;

    console.log(`[Claimer] Found ${isAssigned ? 'ASSIGNED' : 'open'} job #${target.jobId} (${target.chunkCount} chunks, ${target.escrowLamports / 1e9} SOL escrow)`);

    // Pre-claim size check: skip jobs too large for this node
    const estimatedBlobSize = target.chunkCount * 585; // ~585 bytes payload per chunk
    if (estimatedBlobSize > MAX_BLOB_BYTES) {
      console.log(`[Claimer] Skipping job #${target.jobId} — ~${(estimatedBlobSize / 1024 / 1024).toFixed(1)}MB exceeds MAX_BLOB_MB (${MAX_BLOB_BYTES / 1024 / 1024}MB)`);
      return;
    }

    // Pre-claim profitability check: skip jobs with escrow too low for this node's margin threshold
    const minEscrow = Math.ceil(target.chunkCount * BASE_TX_FEE_ESTIMATE * MIN_ESCROW_MULTIPLIER);
    if (target.escrowLamports < minEscrow) {
      console.log(`[Claimer] Skipping job #${target.jobId} — escrow ${target.escrowLamports} < min ${minEscrow} (${MIN_ESCROW_MULTIPLIER}x threshold)`);
      return;
    }

    // Pre-claim balance check: estimate TX cost, skip if wallet can't cover it
    const estimatedTxCost = (target.chunkCount + 5) * 5500; // ~5500 lamports per memo TX + overhead
    const conn = getConnection();
    const walletBalance = await conn.getBalance(getServerKeypair().publicKey);
    if (walletBalance < estimatedTxCost) {
      console.warn(`[Claimer] Skipping job #${target.jobId} — need ~${(estimatedTxCost / 1e9).toFixed(4)} SOL but wallet has ${(walletBalance / 1e9).toFixed(4)} SOL`);
      return;
    }

    // Priority delay: high-stake nodes claim immediately, low-stake nodes wait
    // Assigned jobs skip the delay — they're already ours by exclusive window
    if (_claimDelayMs > 0 && !isAssigned) {
      console.log(`[Claimer] Waiting ${_claimDelayMs}ms (stake-based priority delay)...`);
      await sleep(_claimDelayMs);
      // Re-check: job may have been claimed by a higher-priority node during our delay
      if (!_running) return;
    }

    // Claim it on-chain
    await claimJob(target);

    // Execute in background (don't block the polling loop)
    executeClaimedJob(target).catch(err => {
      console.error(`[Claimer] Background execution failed for job #${target.jobId}: ${err.message}`);
    });

  } catch (err) {
    // v3: ExclusiveWindowActive means another node has priority — skip quietly
    if (err.message?.includes('0x1784') || err.message?.includes('ExclusiveWindowActive')) {
      console.log(`[Claimer] Job #${target?.jobId ?? '?'} has exclusive window — skipping`);
    } else {
      console.error(`[Claimer] Poll error: ${err.message}`);
    }
  }
}

// ── Resume claimed-but-incomplete jobs on startup ────────────────────────────
// If the node crashed mid-inscription, jobs in Claimed status (by us) need to
// be resumed rather than waiting for ZombieSlayer to expire + requeue them.

async function resumeClaimedJobs() {
  try {
    const keypair = getServerKeypair();
    const writerPubkey = keypair.publicKey.toBase58();
    const allJobs = await cachedFetchAllJobs();
    // Find jobs claimed by us (status = claimed, writer = our pubkey)
    const ours = allJobs.filter(j =>
      j.status === 'claimed' && j.writer && j.writer.toBase58() === writerPubkey
    );
    if (ours.length === 0) return;

    console.log(`[Claimer] Found ${ours.length} claimed job(s) to resume after restart`);
    for (const job of ours) {
      if (claimedJobs.has(job.jobId)) continue; // already being processed
      console.log(`[Claimer] Resuming job #${job.jobId} (${job.chunkCount} chunks)`);
      executeClaimedJob(job).catch(err => {
        console.error(`[Claimer] Resume failed for job #${job.jobId}: ${err.message}`);
      });
    }
  } catch (err) {
    console.warn(`[Claimer] Resume check failed: ${err.message}`);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function startClaimer() {
  if (_running) return;
  _running = true;

  // Compute stake-based claim delay once on startup
  _claimDelayMs = await computeClaimDelay();

  const modeLabel = NODE_MODE === 'dedicated' ? 'DEDICATED (assigned only)' : `OPEN (reserved ${RESERVED_SLOTS}/${MAX_CONCURRENT_CLAIMS} slots)`;
  console.log(`[Claimer] Starting marketplace claimer — ${modeLabel}, poll ${POLL_INTERVAL / 1000}s, capacity ${MAX_CONCURRENT_CLAIMS}, delay ${_claimDelayMs}ms`);

  // Resume any claimed-but-incomplete jobs from before restart
  // Delay 15s to let startup memory settle (indexer, announcements, etc.)
  setTimeout(() => resumeClaimedJobs(), 15_000);

  // Initial poll after a short delay (let server start up)
  setTimeout(() => {
    pollAndClaim();
    _pollTimer = setInterval(pollAndClaim, POLL_INTERVAL);
  }, 5000);
}

export function stopClaimer() {
  _running = false;
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  console.log('[Claimer] Stopped');
}

export function getClaimerStatus() {
  const claims = [];
  for (const [jobId, claim] of claimedJobs) {
    claims.push({
      jobId,
      status: claim.status,
      startedAt: claim.startedAt,
      runningMs: Date.now() - claim.startedAt,
      pointerSig: claim.pointerSig,
    });
  }
  return {
    running: _running,
    mode: NODE_MODE,
    minEscrowMultiplier: MIN_ESCROW_MULTIPLIER,
    reservedSlots: RESERVED_SLOTS,
    pollIntervalMs: POLL_INTERVAL,
    maxConcurrent: MAX_CONCURRENT_CLAIMS,
    claimDelayMs: _claimDelayMs,
    stakeTier: _stakeTier,
    activeClaims: claims.filter(c => c.status === 'inscribing' || c.status === 'submitting').length,
    claims,
    queue: _queueSnapshot,
  };
}
