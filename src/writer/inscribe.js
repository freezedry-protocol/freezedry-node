/**
 * writer/inscribe.js — Core inscription loop for Freeze Dry writer nodes.
 *
 * Supports parallel workers: a single file's chunks are split across N workers,
 * each inscribing a different range simultaneously. WORKERS=auto scales by RPS budget.
 * Single worker (legacy) behavior preserved when WORKERS=1 or file is small.
 *
 * All Redis/Blob coupling removed. State lives in-memory (jobs Map).
 * Progress reported via callback POST to coordinator.
 */

import { createHash } from 'crypto';
import {
  Transaction, TransactionInstruction, PublicKey, ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  env, MEMO_PROGRAM_ID, SEND_CONCURRENCY, BATCH_DELAY_MS,
  CONFIRM_WAIT_MS, CONFIRM_RETRIES, CONFIRM_RETRY_WAIT,
  PROGRESS_SAVE_INTERVAL, MAX_JOB_RUNTIME_MS,
  FEE_REFRESH_MS, MULTI_JOB_CONCURRENCY,
  USE_WEBSOCKET, JITO_ENABLED, JITO_BUNDLE_SIZE,
  WORKERS, MAX_WORKERS, RPS_LIMIT, MIN_CHUNKS_PER_WORKER,
  TX_BASE_FEE,
} from '../config.js';
import { getServerKeypair } from '../wallet.js';
import { signMessage } from '../crypto-auth.js';
import { rpcCall, sendWithRetry, sendToUrl, fetchPriorityFee } from './rpc.js';
import { buildV3ChunkData, splitIntoChunks, extractManifestHash } from './chunks.js';
import { confirmAllSigs, surgicalRetry, verifyChunkZero } from './confirm.js';
import { wsConfirmBatch, initWsConnection, isWsReady, createWsConfirmer } from './ws-confirm.js';
import { addTipInstruction, sendBundleAndConfirm, getTxSignature } from './jito.js';
import { sendPointerMemo } from './pointer.js';
import {
  recordJob, recordJobFailed, recordChunkConfirm, recordJitoBundleSent,
  recordJitoBundleLanded, recordJitoBundleFallback, recordWsConfirm,
  recordWsTimeout, recordPollingConfirm,
} from './metrics.js';
import { isHydBlob } from '../hyd.js';
import { getKV, setKV, getBlob, getIncompleteDirectJobs, completeDirectJob, failDirectJob, logEarning } from '../db.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Stagger concurrent sends to avoid burst rate limiting (30ms between each)
const SEND_STAGGER_MS = parseInt(process.env.SEND_STAGGER_MS || '30', 10);
async function staggeredSendAll(tasks) {
  if (SEND_STAGGER_MS <= 0) return Promise.all(tasks.map(fn => fn()));
  const results = new Array(tasks.length);
  const promises = tasks.map((fn, i) =>
    sleep(i * SEND_STAGGER_MS).then(() => fn()).then(r => { results[i] = r; })
  );
  await Promise.all(promises);
  return results;
}

// Transient RPC errors that should trigger backoff + retry, NOT kill the job
const TRANSIENT_PATTERNS = [
  'HTTP 500', 'HTTP 429', 'HTTP 502', 'HTTP 503', 'HTTP 504',
  'ratelimit', '429', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
  'timeout', 'fetch failed', 'network', 'socket hang up',
  'blockhash not found', '-32002', '-32429',
];

function isTransientError(err) {
  const msg = (err.message || '').toLowerCase();
  return TRANSIENT_PATTERNS.some(p => msg.includes(p.toLowerCase()));
}

const MAX_TRANSIENT_RETRIES = 5;
const TRANSIENT_BACKOFF = [5_000, 15_000, 30_000, 60_000, 120_000]; // 5s, 15s, 30s, 1m, 2m

// ── In-memory job state ──────────────────────────────────────────────────────

/** @type {Map<string, object>} */
export const jobs = new Map();

// ── Dynamic send concurrency ─────────────────────────────────────────────────

function getEffectiveSendConcurrency() {
  if (MULTI_JOB_CONCURRENCY > 0) return MULTI_JOB_CONCURRENCY; // operator override
  const active = [...jobs.values()].filter(j => j.status === 'writing').length;
  if (active <= 1) return SEND_CONCURRENCY;
  if (active === 2) return Math.floor(SEND_CONCURRENCY * 0.6);
  return Math.floor(SEND_CONCURRENCY * 0.4); // 3+ jobs
}

// ── Blockhash cache — refresh scales with concurrency ────────────────────────

let _cachedBlockhash = null;
let _blockhashFetchedAt = 0;

function getBlockhashRefreshMs() {
  // Scale cache duration with concurrency — more TXs sharing a blockhash = refresh sooner
  return Math.max(5_000, 20_000 - (SEND_CONCURRENCY * 100));
}

async function getFreshBlockhash() {
  const now = Date.now();
  if (_cachedBlockhash && (now - _blockhashFetchedAt) < getBlockhashRefreshMs()) {
    return _cachedBlockhash;
  }
  const result = await rpcCall('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  _cachedBlockhash = result.value.blockhash;
  _blockhashFetchedAt = Date.now();
  return _cachedBlockhash;
}

// ── Shared priority fee cache — one refresh serves all workers ───────────────

let _cachedFee = 10_000;
let _feeFetchedAt = 0;

async function getFreshFee() {
  const now = Date.now();
  if (_cachedFee && (now - _feeFetchedAt) < FEE_REFRESH_MS) return _cachedFee;
  _cachedFee = await fetchPriorityFee();
  _feeFetchedAt = now;
  return _cachedFee;
}

// ── Worker count — 1 worker per RPC key ─────────────────────────────────────
// Reads process.env directly. No pool abstraction, no module timing issues.
// Add SEND_RPC_URL_2 (or HELIUS_RPC_URL_2) → get a second worker. _3 → third. Up to 5.

function countAvailableRpcKeys() {
  let count = 1; // HELIUS_API_KEY is always key 1
  for (let i = 2; i <= 5; i++) {
    if ((process.env[`SEND_RPC_URL_${i}`] || process.env[`HELIUS_RPC_URL_${i}`] || '').trim()) count++;
    else break;
  }
  return count;
}

/** Get the RPC URL for a specific worker index. Worker 0 = main key, 1 = _2, 2 = _3, etc. */
function getRpcUrlForWorker(workerIndex) {
  if (workerIndex === 0) {
    const key = (process.env.HELIUS_API_KEY || '').trim();
    return key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : null;
  }
  const i = workerIndex + 1;
  return (process.env[`SEND_RPC_URL_${i}`] || process.env[`HELIUS_RPC_URL_${i}`] || '').trim() || null;
}

/** Get WSS URL for a worker. Checks explicit HELIUS_WS_URL_N first, then derives from RPC URL. */
function getWsUrlForWorker(workerIndex) {
  // Explicit WS URLs take priority (operator can set optimal WSS endpoints)
  if (workerIndex === 0) {
    const explicit = (process.env.HELIUS_WS_URL || '').trim();
    if (explicit) return explicit;
  } else {
    const i = workerIndex + 1;
    const explicit = (process.env[`HELIUS_WS_URL_${i}`] || '').trim();
    if (explicit) return explicit;
  }
  // Fallback: derive from RPC URL (https→wss)
  const rpcUrl = getRpcUrlForWorker(workerIndex);
  if (!rpcUrl) return null;
  return rpcUrl.replace('https://', 'wss://').replace('http://', 'ws://');
}

function computeWorkerCount(totalChunks) {
  const rpcKeys = countAvailableRpcKeys();
  if (totalChunks < MIN_CHUNKS_PER_WORKER) return 1;
  if (WORKERS !== 'auto') {
    const n = parseInt(WORKERS, 10);
    if (!isNaN(n) && n >= 1) return Math.min(n, Math.floor(totalChunks / MIN_CHUNKS_PER_WORKER), rpcKeys);
  }
  return Math.min(rpcKeys, Math.floor(totalChunks / MIN_CHUNKS_PER_WORKER));
}

// ── Progress callback to coordinator ─────────────────────────────────────────

function signCallbackMessage(message) {
  return signMessage(getServerKeypair(), message);
}

async function reportProgress(callbackUrl, jobId, status, data) {
  if (!callbackUrl) return;
  const isCritical = status === 'complete' || status === 'failed';
  const maxAttempts = isCritical ? 3 : 1;
  const timeout = isCritical ? 15000 : 5000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const keypair = getServerKeypair();
      const wallet = keypair.publicKey.toBase58();
      const timestamp = Math.floor(Date.now() / 1000);
      const message = `FreezeDry:job-callback:${jobId}:${timestamp}`;
      const signature = signCallbackMessage(message);
      const resp = await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, status, wallet, message, signature, ...data }),
        signal: AbortSignal.timeout(timeout),
      });
      if (resp.ok) {
        if (isCritical) console.log(`[reportProgress] ${status} callback succeeded for job ${jobId}`);
        return;
      }
      console.warn(`[reportProgress] ${status} callback HTTP ${resp.status} for job ${jobId} (attempt ${attempt + 1}/${maxAttempts})`);
    } catch (cbErr) {
      console.warn(`[reportProgress] ${status} callback failed for job ${jobId} (attempt ${attempt + 1}/${maxAttempts}): ${cbErr.message}`);
    }
    if (attempt < maxAttempts - 1) await sleep(2000 * (attempt + 1));
  }
}

// ── Graceful shutdown flag ───────────────────────────────────────────────────

let _shuttingDown = false;
export function setShuttingDown(val) { _shuttingDown = val; }

// ── Worker loop — inscribes a chunk range [startIdx, endIdx) ─────────────────

/**
 * Run one worker loop that inscribes chunks from startIdx to endIdx.
 * Multiple workers run in parallel on different ranges of the same file.
 * Shares: blockhash cache, fee cache, WS connection, Jito throttle, job state.
 */
async function runWorkerLoop({
  workerId, startIdx, endIdx, allChunks, manifestHash,
  job, jobId, callbackUrl, workerCount, keypairOverride, wsConfirmer,
}) {
  const serverKeypair = keypairOverride || getServerKeypair();
  const payerKey = serverKeypair.publicKey;
  const memoProgramId = new PublicKey(MEMO_PROGRAM_ID);
  const logPrefix = workerCount > 1 ? `[Job ${jobId}:W${workerId}]` : `[Job ${jobId}]`;

  let transientRetries = 0;
  let b = startIdx;

  // Resume: skip chunks that already have signatures (from checkpoint restore)
  while (b < endIdx && job.signatures[b] != null) b++;
  if (b > startIdx) {
    console.log(`${logPrefix} Resuming from chunk ${b} (${b - startIdx}/${endIdx - startIdx} done)`);
  }

  // Each worker gets its own RPC URL (multi-key) or falls back to round-robin (single key)
  const workerRpcUrl = workerCount > 1 ? getRpcUrlForWorker(workerId) : null;
  const send = workerRpcUrl
    ? (enc) => sendToUrl(enc, workerRpcUrl)
    : sendWithRetry;

  while (b < endIdx) {
    try {
      const sendBatch = getEffectiveSendConcurrency();
      const remaining = endIdx - b;
      const batchSize = Math.min(sendBatch, remaining);
      const microLamports = await getFreshFee();

      // Check shutdown + runtime limit
      if (_shuttingDown) {
        console.log(`${logPrefix} Shutdown signal`);
        job.status = 'interrupted';
        break;
      }
      if (Date.now() - job.startedAt > MAX_JOB_RUNTIME_MS) {
        console.log(`${logPrefix} Hit ${MAX_JOB_RUNTIME_MS / 60000} min runtime limit`);
        job.status = 'interrupted';
        break;
      }

      const batchChunks = allChunks.slice(b, b + batchSize);

      // Build + sign + send sub-batch
      let blockhash = await getFreshBlockhash();
      let batchSigs;

      if (JITO_ENABLED) {
        // Jito path: group into bundles of JITO_BUNDLE_SIZE, add tip to last TX
        batchSigs = [];
        for (let g = 0; g < batchChunks.length; g += JITO_BUNDLE_SIZE) {
          const bundleChunks = batchChunks.slice(g, g + JITO_BUNDLE_SIZE);
          const bundleTxs = bundleChunks.map((chunk, j) => {
            const chunkIdx = b + g + j;
            const tx = new Transaction({ recentBlockhash: blockhash, feePayer: payerKey })
              .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 }))
              .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }))
              .add(new TransactionInstruction({
                keys: [{ pubkey: payerKey, isSigner: true, isWritable: false }],
                programId: memoProgramId,
                data: buildV3ChunkData(chunk, chunkIdx, manifestHash),
              }));
            if (j === bundleChunks.length - 1) addTipInstruction(tx, payerKey);
            tx.sign(serverKeypair);
            return tx;
          });

          const serialized = bundleTxs.map(tx => tx.serialize().toString('base64'));
          recordJitoBundleSent();
          const result = await sendBundleAndConfirm(serialized);
          if (result.landed) {
            recordJitoBundleLanded();
            if (result.transactions?.length === bundleTxs.length) {
              batchSigs.push(...result.transactions);
            } else {
              batchSigs.push(...bundleTxs.map(tx => getTxSignature(tx)));
            }
          } else {
            recordJitoBundleFallback();
            console.log(`${logPrefix} Jito rejected: ${result.error} — fallback`);
            const fallbackSigs = await staggeredSendAll(bundleTxs.map(tx => () =>
              send(tx.serialize().toString('base64'))
            ));
            batchSigs.push(...fallbackSigs);
          }
        }
      } else {
        // Standard path: send with stagger to avoid burst 429s
        batchSigs = await staggeredSendAll(batchChunks.map((chunk, j) => () => {
          const chunkIdx = b + j;
          const tx = new Transaction({ recentBlockhash: blockhash, feePayer: payerKey })
            .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 }))
            .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }))
            .add(new TransactionInstruction({
              keys: [{ pubkey: payerKey, isSigner: true, isWritable: false }],
              programId: memoProgramId,
              data: buildV3ChunkData(chunk, chunkIdx, manifestHash),
            }));
          tx.sign(serverKeypair);
          return send(tx.serialize().toString('base64'));
        }));
      }

      // Confirm sub-batch — WebSocket (push, ~0.6s) or polling (2.5s fallback)
      // Per-worker WS confirmer if available, else shared singleton
      const _wsReady = wsConfirmer ? wsConfirmer.isReady() : (USE_WEBSOCKET && isWsReady());
      const _wsConfirm = wsConfirmer ? wsConfirmer.confirmBatch : wsConfirmBatch;
      if (_wsReady) {
        const wsFailed = await _wsConfirm(batchSigs);
        const wsOk = batchSigs.length - wsFailed.length;
        if (wsOk > 0) for (let i = 0; i < wsOk; i++) recordWsConfirm();
        if (wsFailed.length > 0) {
          for (let i = 0; i < wsFailed.length; i++) recordWsTimeout();
          console.log(`${logPrefix} WS: ${wsFailed.length}/${batchSigs.length} timed out — polling fallback`);
          _blockhashFetchedAt = 0;
          blockhash = await getFreshBlockhash();
          for (const j of wsFailed) {
            try {
              const chunkIdx = b + j;
              const tx = new Transaction({ recentBlockhash: blockhash, feePayer: payerKey })
                .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 }))
                .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }))
                .add(new TransactionInstruction({
                  keys: [{ pubkey: payerKey, isSigner: true, isWritable: false }],
                  programId: memoProgramId,
                  data: buildV3ChunkData(batchChunks[j], chunkIdx, manifestHash),
                }));
              tx.sign(serverKeypair);
              batchSigs[j] = await send(tx.serialize().toString('base64'));
            } catch (resendErr) {
              console.log(`${logPrefix} re-send chunk ${b + j} failed: ${resendErr.message}`);
            }
          }
          await sleep(CONFIRM_WAIT_MS);
        }
      } else {
        // Polling fallback (original path)
        recordPollingConfirm();
        await sleep(CONFIRM_WAIT_MS);
        for (let retry = 0; retry < CONFIRM_RETRIES; retry++) {
          const statuses = await rpcCall('getSignatureStatuses', [batchSigs]);
          const needResend = [];
          (statuses.value || []).forEach((s, j) => {
            const ok = s && !s.err && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized');
            if (!ok) needResend.push(j);
          });

          if (needResend.length === 0) break;

          if (retry < CONFIRM_RETRIES - 1) {
            console.log(`${logPrefix} batch ${b}: ${needResend.length} unconfirmed — re-sending (attempt ${retry + 1})`);
            _blockhashFetchedAt = 0;
            blockhash = await getFreshBlockhash();
            for (const j of needResend) {
              try {
                const chunkIdx = b + j;
                const tx = new Transaction({ recentBlockhash: blockhash, feePayer: payerKey })
                  .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 }))
                  .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }))
                  .add(new TransactionInstruction({
                    keys: [{ pubkey: payerKey, isSigner: true, isWritable: false }],
                    programId: memoProgramId,
                    data: buildV3ChunkData(batchChunks[j], chunkIdx, manifestHash),
                  }));
                tx.sign(serverKeypair);
                batchSigs[j] = await send(tx.serialize().toString('base64'));
              } catch (resendErr) {
                console.log(`${logPrefix} re-send chunk ${b + j} failed: ${resendErr.message} — keeping original sig`);
              }
            }
            await sleep(CONFIRM_RETRY_WAIT);
          }
        }
      }

      // Write confirmed sigs to shared array at correct indices (non-overlapping ranges)
      for (let k = 0; k < batchSigs.length; k++) {
        job.signatures[b + k] = batchSigs[k];
      }
      job.chunksWritten += batchSigs.length;
      recordChunkConfirm(batchSigs.length);

      // Report progress periodically
      if (job.chunksWritten % PROGRESS_SAVE_INTERVAL < batchSize) {
        console.log(`${logPrefix} Progress: ${job.chunksWritten}/${job.chunksTotal}`);
        reportProgress(callbackUrl, jobId, 'writing', {
          chunksWritten: job.chunksWritten,
          chunksTotal: job.chunksTotal,
        });
      }

      b += batchSize;
      transientRetries = 0; // reset on successful sub-batch
      if (b < endIdx) await sleep(BATCH_DELAY_MS);

    } catch (loopErr) {
      // ── Transient error backoff: don't kill the job ──────────────
      if (isTransientError(loopErr) && transientRetries < MAX_TRANSIENT_RETRIES) {
        const delay = TRANSIENT_BACKOFF[transientRetries] || 120_000;
        transientRetries++;
        console.warn(`${logPrefix} Transient error at chunk ${b}: ${loopErr.message}`);
        console.warn(`${logPrefix} Backing off ${delay / 1000}s (attempt ${transientRetries}/${MAX_TRANSIENT_RETRIES})`);
        _blockhashFetchedAt = 0;
        await sleep(delay);
        continue;
      }
      throw loopErr;
    }
  }
}

// ── Main inscription function (coordinator) ──────────────────────────────────

/**
 * Process a single inscription job. Splits chunks across parallel workers
 * based on WORKERS config and file size. Each worker inscribes a different
 * chunk range simultaneously. Coordinator handles checkpoint, confirmation,
 * and pointer memo after all workers complete.
 *
 * @param {string} jobId
 * @param {Buffer} blobBuffer - raw .hyd blob
 * @param {number} chunkCount - expected chunk count
 * @param {string} hash - artwork hash (sha256:...)
 * @param {string} callbackUrl - coordinator URL for progress/completion POSTs
 * @param {object} [meta] - optional metadata (creator wallet, etc.) passed through to callbacks
 */
export async function processInscription(jobId, blobBuffer, chunkCount, hash, callbackUrl, meta, keypairOverride) {
  const startTime = Date.now();

  // Detect content type from .hyd blob: Direct Store (avifLength=0) with HTML bytes
  let contentType = null;
  if (isHydBlob(blobBuffer)) {
    const avifLen = blobBuffer.readUInt32LE(9);
    if (avifLen === 0) {
      let start = 49;
      if (blobBuffer[start] === 0xEF && blobBuffer[start+1] === 0xBB && blobBuffer[start+2] === 0xBF) start += 3;
      while (start < blobBuffer.length && (blobBuffer[start] === 0x20 || blobBuffer[start] === 0x09 || blobBuffer[start] === 0x0A || blobBuffer[start] === 0x0D)) start++;
      const head = blobBuffer.slice(start, start + 15).toString('utf-8').toLowerCase();
      if (head.startsWith('<!doctype') || head.startsWith('<html')) contentType = 'text/html';
    }
  }

  // Split chunks + compute workers before initializing job state
  const allChunks = splitIntoChunks(blobBuffer);
  const manifestHash = extractManifestHash(blobBuffer);
  const totalChunks = allChunks.length;

  if (allChunks.length !== chunkCount) {
    console.log(`[Job ${jobId}] Chunk count mismatch: got ${allChunks.length}, expected ${chunkCount}. Using actual.`);
  }

  const workerCount = computeWorkerCount(totalChunks);

  // Initialize job state — pre-allocate signatures array for indexed writes
  const job = {
    jobId,
    status: 'writing',
    chunksWritten: 0,
    chunksTotal: totalChunks,
    signatures: new Array(totalChunks).fill(null),
    manifestHash,
    blobSize: blobBuffer.length,
    chunkCount: totalChunks,
    startedAt: startTime,
    error: null,
    pointerSig: null,
    contentType,
    _workerCount: workerCount,
  };
  jobs.set(jobId, job);

  try {
    // ── Checkpoint/resume: restore confirmed sigs into pre-allocated array ──
    const checkpointKey = `checkpoint:${jobId}`;
    try {
      const saved = getKV(checkpointKey);
      if (saved) {
        const cp = JSON.parse(saved);
        if (cp.manifestHash === manifestHash && Array.isArray(cp.signatures) && cp.signatures.length > 0) {
          // Find a non-null sig to verify
          const nonNull = cp.signatures.filter(s => s != null);
          if (nonNull.length > 0) {
            const sampleSig = nonNull[Math.floor(nonNull.length / 2)];
            const check = await rpcCall('getSignatureStatuses', [[sampleSig]]);
            const st = check.value?.[0];
            if (st && !st.err && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
              // Restore sigs into pre-allocated array
              for (let i = 0; i < Math.min(cp.signatures.length, totalChunks); i++) {
                if (cp.signatures[i]) job.signatures[i] = cp.signatures[i];
              }
              job.chunksWritten = job.signatures.filter(s => s != null).length;
              console.log(`[Job ${jobId}] Resuming: ${job.chunksWritten}/${totalChunks} chunks from checkpoint`);
            } else {
              console.log(`[Job ${jobId}] Checkpoint found but sample sig unconfirmed — starting fresh`);
            }
          }
        }
      }
    } catch (cpErr) {
      console.log(`[Job ${jobId}] Checkpoint load error: ${cpErr.message} — starting fresh`);
    }

    console.log(`[Job ${jobId}] Starting: ${totalChunks} chunks, ${workerCount} worker(s), ${(blobBuffer.length / 1024).toFixed(1)} KB`);

    // ── Dispatch workers (staggered start to avoid RPS burst) ────────────
    const WORKER_STAGGER_MS = 500;
    const rangeSize = Math.ceil(totalChunks / workerCount);
    const workerPromises = [];

    // Per-worker WS confirmers (multi-worker only — each worker gets its own WS pipe)
    const wsConfirmers = workerCount > 1
      ? Array.from({ length: workerCount }, (_, i) => {
          const wsUrl = getWsUrlForWorker(i);
          if (wsUrl) {
            try { return createWsConfirmer(wsUrl); }
            catch (e) { console.warn(`[Job ${jobId}] WS confirmer ${i} failed: ${e.message}`); return null; }
          }
          return null;
        })
      : null;

    // Wait for WS connections to establish before workers start sending
    if (wsConfirmers) {
      const WS_WARMUP_MS = 3000;
      const ready = await Promise.race([
        Promise.all(wsConfirmers.map(c => c ? new Promise(r => {
          const check = () => c.isReady() ? r(true) : setTimeout(check, 100);
          check();
        }) : Promise.resolve(true))),
        new Promise(r => setTimeout(() => r(false), WS_WARMUP_MS)),
      ]);
      if (ready) console.log(`[Job ${jobId}] WS connections ready`);
      else console.log(`[Job ${jobId}] WS warmup timeout — starting with polling fallback`);
    }

    for (let w = 0; w < workerCount; w++) {
      const start = w * rangeSize;
      const end = Math.min(start + rangeSize, totalChunks);
      if (start >= totalChunks) break;
      if (w > 0) await new Promise(r => setTimeout(r, WORKER_STAGGER_MS));
      workerPromises.push(runWorkerLoop({
        workerId: w, startIdx: start, endIdx: end,
        allChunks, manifestHash, job, jobId,
        callbackUrl, workerCount, keypairOverride,
        wsConfirmer: wsConfirmers ? wsConfirmers[w] : null,
      }));
    }

    // Periodic checkpoint saver — runs alongside workers (every 10s)
    const cpInterval = setInterval(() => {
      try {
        setKV(checkpointKey, JSON.stringify({
          manifestHash,
          signatures: job.signatures,
          chunksTotal: totalChunks,
          updatedAt: Date.now(),
        }));
      } catch (err) { console.warn('[checkpoint] periodic save failed:', err.message); }
    }, 10_000);

    try {
      const results = await Promise.allSettled(workerPromises);
      clearInterval(cpInterval);

      // Close per-worker WS connections
      if (wsConfirmers) wsConfirmers.forEach(c => c?.close());

      // Save final checkpoint
      try {
        setKV(checkpointKey, JSON.stringify({
          manifestHash, signatures: job.signatures,
          chunksTotal: totalChunks, updatedAt: Date.now(),
        }));
      } catch (err) { console.warn('[checkpoint] final save failed:', err.message); }

      // Check for worker failures
      const failed = results.filter(r => r.status === 'rejected');
      if (failed.length > 0) {
        throw failed[0].reason;
      }
    } catch (e) {
      clearInterval(cpInterval);
      throw e;
    }

    // If interrupted, stop here
    if (job.status === 'interrupted') {
      reportProgress(callbackUrl, jobId, 'interrupted', {
        chunksWritten: job.chunksWritten,
        chunksTotal: totalChunks,
        signatures: job.signatures.filter(s => s != null),
      });
      return;
    }

    // Verify all slots filled
    const confirmedCount = job.signatures.filter(s => s != null).length;
    if (confirmedCount !== totalChunks) {
      console.error(`[Job ${jobId}] Sig count mismatch: ${confirmedCount}/${totalChunks}`);
      job.status = 'failed';
      job.error = `Only ${confirmedCount}/${totalChunks} chunks confirmed`;
      reportProgress(callbackUrl, jobId, 'failed', {
        error: job.error, chunksWritten: confirmedCount, chunksTotal: totalChunks,
      });
      return;
    }

    // ── Confirmation + completion ────────────────────────────────────────

    console.log(`[Job ${jobId}] All chunks sent — confirming...`);
    let failedIdxs = await confirmAllSigs(job.signatures);

    // Surgical retry for dropped txs
    if (failedIdxs.length > 0) {
      console.log(`[Job ${jobId}] ${failedIdxs.length} dropped txs — surgical retry`);
      const microLamports = await getFreshFee();
      const stillBroken = await surgicalRetry(job.signatures, allChunks, failedIdxs, manifestHash, microLamports);

      if (stillBroken.length > 0) {
        console.error(`[Job ${jobId}] ${stillBroken.length} chunks still broken after retry`);
        job.status = 'failed';
        job.error = `${stillBroken.length} chunks broken after retry`;
        reportProgress(callbackUrl, jobId, 'failed', {
          error: job.error,
          chunksWritten: job.chunksWritten,
          chunksTotal: totalChunks,
          signatures: job.signatures,
        });
        return;
      }
    }

    // Final verify — read chunk 0 from chain
    try {
      await verifyChunkZero(job.signatures[0]);
      console.log(`[Job ${jobId}] Final verify passed`);
    } catch (verifyErr) {
      console.error(`[Job ${jobId}] Final verify failed: ${verifyErr.message}`);
      job.status = 'failed';
      job.error = `Final verify failed: ${verifyErr.message}`;
      reportProgress(callbackUrl, jobId, 'failed', {
        error: job.error,
        signatures: job.signatures,
      });
      return;
    }

    // ── Send pointer memo (with retries — inscription is done, only pointer needed) ──

    await sleep(3000); // wait after batch to avoid rate limits
    for (let ptrAttempt = 0; ptrAttempt < 5; ptrAttempt++) {
      try {
        const pointerSig = await sendPointerMemo(job, keypairOverride);
        if (pointerSig) {
          job.pointerSig = pointerSig;
          break;
        }
        console.warn(`[Job ${jobId}] Pointer attempt ${ptrAttempt + 1}/5 returned null (confirmation timeout)`);
      } catch (ptrErr) {
        console.error(`[Job ${jobId}] Pointer memo attempt ${ptrAttempt + 1}/5 failed: ${ptrErr.message}`);
      }
      if (ptrAttempt < 4) await sleep(3000 * (ptrAttempt + 1)); // backoff: 3s, 6s, 9s, 12s
    }

    // Clear checkpoint on success
    try { setKV(checkpointKey, ''); } catch (err) { console.warn('[checkpoint] clear failed:', err.message); }

    // Mark complete
    job.status = 'complete';
    job.completedAt = Date.now();
    job.chunksWritten = totalChunks;
    job.blobHash = 'sha256:' + createHash('sha256').update(blobBuffer).digest('hex');
    const elapsed = (Date.now() - startTime) / 1000;
    const mode = (USE_WEBSOCKET && JITO_ENABLED) ? 'ws+jito' : USE_WEBSOCKET ? 'ws' : JITO_ENABLED ? 'jito' : 'standard';
    console.log(`[Job ${jobId}] Complete — ${totalChunks} chunks, ${workerCount} worker(s), ${Math.round(elapsed)}s (${(totalChunks / elapsed).toFixed(1)} TPS, mode=${mode})`);
    recordJob(jobId, { chunks: totalChunks, elapsedMs: Date.now() - startTime, blobSize: blobBuffer.length, mode, workers: workerCount });

    // Log TX fees spent for earnings ledger
    const earningsType = meta?.direct ? 'direct' : jobId.startsWith('voucher-') ? 'voucher' : 'marketplace';
    logEarning(jobId, earningsType, 'tx_fees_spent', -(totalChunks * TX_BASE_FEE), null, {
      chunks: totalChunks, elapsed: Math.round(elapsed), workers: workerCount,
    });

    // Report completion to coordinator (await — this is the critical one)
    await reportProgress(callbackUrl, jobId, 'complete', {
      chunksWritten: totalChunks,
      chunksTotal: totalChunks,
      signatures: job.signatures,
      manifestHash: job.manifestHash,
      pointerSig: job.pointerSig,
      blobHash: job.blobHash,
      elapsedSeconds: Math.round(elapsed),
      creator: meta?.creator || undefined,
    });

  } catch (err) {
    console.error(`[Job ${jobId}] FAILED: ${err.message}`);
    job.status = 'failed';
    job.error = err.message;
    recordJobFailed();
    reportProgress(callbackUrl, jobId, 'failed', {
      error: err.message,
      chunksWritten: job.chunksWritten,
      chunksTotal: job.chunksTotal,
      signatures: job.signatures.filter(s => s != null),
    });
  }
}

/**
 * Clean up completed/failed jobs older than maxAge (default 1 hour).
 */
export function cleanupJobs(maxAgeMs = 60 * 60 * 1000) {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status === 'complete' || job.status === 'failed') {
      const age = now - (job.completedAt || job.startedAt);
      if (age > maxAgeMs) jobs.delete(id);
    }
  }
}

// ── Resume incomplete direct jobs on startup ──────────────────────────────────
// Similar to marketplace's resumeClaimedJobs() — queries persisted direct_jobs
// table for incomplete jobs, loads blob from DB + checkpoint from KV, resumes.

export async function resumeDirectJobs() {
  try {
    const incomplete = getIncompleteDirectJobs();
    if (incomplete.length === 0) return;

    console.log(`[Writer] Found ${incomplete.length} incomplete direct job(s) to resume`);

    for (const row of incomplete) {
      // Skip if already running in-memory
      if (jobs.has(row.job_id)) {
        const existing = jobs.get(row.job_id);
        if (existing.status === 'writing') {
          console.log(`[Writer] Direct job ${row.job_id} already in progress — skipping`);
          continue;
        }
      }

      // Load blob from DB (was persisted via storeBlob before inscription started)
      const blobBuffer = getBlob(row.manifest_hash);
      if (!blobBuffer) {
        console.warn(`[Writer] Direct job ${row.job_id} — blob not found in DB, marking failed`);
        failDirectJob(row.job_id);
        continue;
      }

      console.log(`[Writer] Resuming direct job ${row.job_id} (${row.chunk_count} chunks, payer: ${row.payer_wallet.slice(0, 8)}...)`);

      processInscription(
        row.job_id, blobBuffer, row.chunk_count, row.manifest_hash,
        row.callback_url || null,
        { payerWallet: row.payer_wallet, paymentSig: row.payment_sig, direct: true, creator: row.payer_wallet },
      )
        .then(() => {
          const j = jobs.get(row.job_id);
          if (j && j.status === 'complete') completeDirectJob(row.job_id);
          // interrupted jobs stay as 'writing' in DB for next restart
        })
        .catch(err => {
          console.error(`[Writer] Resumed direct job ${row.job_id} failed: ${err.message}`);
          failDirectJob(row.job_id);
        });

      // Stagger resume starts (2s between each) to avoid RPS burst
      await sleep(2000);
    }
  } catch (err) {
    console.warn(`[Writer] Direct job resume check failed: ${err.message}`);
  }
}
