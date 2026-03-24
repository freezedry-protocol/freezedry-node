/**
 * writer/routes.js — HTTP endpoints for the writer role.
 * POST /inscribe        — accept marketplace inscription job (API_KEY auth)
 * POST /inscribe/direct — accept direct inscription job (SOL transfer auth)
 * GET  /quote/direct    — direct pricing + congestion info
 * POST /admin/mode      — runtime inscription mode switch
 * GET  /status/:jobId   — check job progress
 * /health extended with writer fields
 */

import { timingSafeEqual } from 'crypto';
import {
  env, MEMO_PAYLOAD_SIZE, BASE_CHUNK_COST_LAMPORTS, PARTNER_MARGIN_MULTIPLIER,
  INSCRIPTION_MODE, DIRECT_PRICE_PER_MB_USD, DIRECT_MIN_PRICE_USD,
  DIRECT_PAYMENT_WALLET, COORDINATOR_URL, setInscriptionMode, fetchSolPrice, usdToLamports,
  BODY_LIMIT_BYTES, MAX_BLOB_BYTES,
} from '../config.js';
import { getServerKeypair, getVoucherKeypair } from '../wallet.js';
import { rpcCall } from './rpc.js';
import { jobs, processInscription, cleanupJobs, setShuttingDown, resumeDirectJobs } from './inscribe.js';
import { getKV, setKV, getBlob, storeBlob, saveDirectJob, completeDirectJob, failDirectJob, logEarning, getEarningsSummary, getEarningsSince } from '../db.js';

const CAPACITY = parseInt(env('CAPACITY') || '3', 10);
const QUEUE_MAX = parseInt(env('QUEUE_MAX') || '0', 10); // 0 = no queue (503 at capacity)
const API_KEY = env('API_KEY');

// ── Internal job queue ────────────────────────────────────────────────────
const jobQueue = []; // FIFO: { jobId, blobBuffer, chunkCount, hash, callbackUrl, meta, queuedAt, keypairOverride }

/** Try to drain queued jobs when a slot opens. */
function drainQueue() {
  while (jobQueue.length > 0 && activeJobCount() < CAPACITY) {
    const queued = jobQueue.shift();
    console.log(`[Writer] Dequeuing job ${queued.jobId} (${jobQueue.length} remaining in queue)`);
    processInscription(queued.jobId, queued.blobBuffer, queued.chunkCount, queued.hash, queued.callbackUrl, queued.meta, queued.keypairOverride || null)
      .catch(err => console.error(`[Writer] Queued job ${queued.jobId} uncaught: ${err.message}`))
      .finally(() => drainQueue());
  }
}

/** Validate X-API-Key header (timing-safe) */
function requireApiKey(req, reply) {
  if (!API_KEY) {
    reply.status(503);
    return { error: 'Writer API_KEY not configured' };
  }
  const expectedBuf = Buffer.from(API_KEY);
  const providedBuf = Buffer.from(req.headers['x-api-key'] || '');
  if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
    reply.status(401);
    return { error: 'Invalid API key' };
  }
  return null;
}

/** Count active (writing) jobs */
function activeJobCount() {
  let count = 0;
  for (const job of jobs.values()) {
    if (job.status === 'writing') count++;
  }
  return count;
}

/** Check if wallet has enough SOL to cover inscription network fees. */
async function checkWalletBalance(chunkCount, reply, keypairOverride) {
  const requiredLamports = chunkCount * BASE_CHUNK_COST_LAMPORTS;
  try {
    const walletPubkey = (keypairOverride || getServerKeypair()).publicKey.toBase58();
    const result = await rpcCall('getBalance', [walletPubkey]);
    const balance = result?.value ?? result;
    if (typeof balance === 'number' && balance < requiredLamports) {
      reply.status(402);
      return {
        error: 'Insufficient node wallet balance for inscription',
        requiredLamports,
        requiredSol: requiredLamports / 1e9,
        balanceLamports: balance,
        balanceSol: balance / 1e9,
      };
    }
  } catch (err) {
    // Fail-open: don't block inscription if RPC is temporarily down
    console.warn('[Writer] Balance check failed, proceeding:', err.message);
  }
  return null;
}

/**
 * Register writer routes on the Fastify app.
 * @param {import('fastify').FastifyInstance} app
 */
export function registerWriterRoutes(app) {
  // Validate writer can start
  try {
    getServerKeypair();
  } catch (err) {
    console.error(`[Writer] Cannot start: ${err.message}`);
    console.error('[Writer] Set WALLET_KEYPAIR in .env to enable writer role');
    return;
  }

  const walletAddress = getServerKeypair().publicKey.toBase58();
  console.log(`[Writer] Writer role active — wallet: ${walletAddress}, capacity: ${CAPACITY}`);

  // Periodic cleanup of old finished jobs (every 10 minutes)
  setInterval(() => cleanupJobs(), 10 * 60 * 1000);

  // Graceful shutdown — close Fastify and exit so systemd doesn't SIGKILL
  async function gracefulShutdown(signal) {
    console.log(`[Writer] ${signal} received — shutting down gracefully`);
    setShuttingDown(true);
    // Give inscription loops time to checkpoint at next batch boundary
    await new Promise(r => setTimeout(r, 5000));
    try { await app.close(); } catch (err) { console.warn('[Writer] app.close error:', err.message); }
    console.log('[Writer] Shutdown complete');
    process.exit(0);
  }
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // Resume incomplete direct jobs after startup settles (15s delay, same as marketplace)
  setTimeout(() => resumeDirectJobs(), 15_000);

  // ── GET /quote — cost estimate for a blob ────────────────────────────────

  // Congestion: marketplace pricing when estimated wait exceeds threshold
  const CONGESTION_MULTIPLIER = parseFloat(process.env.CONGESTION_MULTIPLIER || '2.0');
  const CONGESTION_THRESHOLD_SEC = parseInt(process.env.CONGESTION_THRESHOLD_SEC || '1200', 10); // 20 min default

  /** Estimate seconds to clear all queued + active jobs */
  function estimateQueueWaitSec() {
    let totalChunks = 0;
    for (const q of jobQueue) totalChunks += q.chunkCount;
    for (const job of jobs.values()) {
      if (job.status === 'writing') totalChunks += (job.chunksTotal - job.chunksWritten);
    }
    // 15.7 TPS proven with WS confirms (1 chunk per TX)
    return Math.ceil(totalChunks / 15);
  }

  app.get('/quote', (req, reply) => {
    const sizeStr = req.query.size;
    if (!sizeStr) {
      reply.status(400);
      return { error: 'Missing required query param: size (blob size in bytes)' };
    }
    const size = parseInt(sizeStr, 10);
    if (!Number.isFinite(size) || size <= 0) {
      reply.status(400);
      return { error: 'size must be a positive integer (bytes)' };
    }

    const chunkCount = Math.ceil(size / MEMO_PAYLOAD_SIZE);
    const networkCostLamports = chunkCount * BASE_CHUNK_COST_LAMPORTS;

    // Base price until wait time exceeds threshold, then congestion price
    const estimatedWaitSec = estimateQueueWaitSec();
    const congested = estimatedWaitSec > CONGESTION_THRESHOLD_SEC;
    const multiplier = congested ? CONGESTION_MULTIPLIER : PARTNER_MARGIN_MULTIPLIER;
    const totalCostLamports = Math.ceil(networkCostLamports * multiplier);

    return {
      chunkCount,
      blobSizeBytes: size,
      networkCostLamports,
      totalCostLamports,
      totalCostSol: totalCostLamports / 1e9,
      multiplier,
      congested,
      estimatedWaitSec,
      congestionThresholdSec: CONGESTION_THRESHOLD_SEC,
      activeJobs: activeJobCount(),
      queueDepth: jobQueue.length,
      queueMax: QUEUE_MAX,
    };
  });

  // ── POST /inscribe — accept a new inscription job ──────────────────────

  app.post('/inscribe', {
    config: { rawBody: true },
    bodyLimit: BODY_LIMIT_BYTES, // 6MB — blob + JSON overhead
  }, async (req, reply) => {
    // Block marketplace inscriptions when in direct-only mode
    if (INSCRIPTION_MODE === 'direct') {
      reply.status(404);
      return { error: 'Marketplace inscription disabled (mode=direct). Use /inscribe/direct.' };
    }

    const authErr = requireApiKey(req, reply);
    if (authErr) return authErr;

    const { jobId, blob, chunkCount, hash, callbackUrl } = req.body || {};

    if (!jobId || !blob || !chunkCount || !hash) {
      reply.status(400);
      return { error: 'Missing required fields: jobId, blob, chunkCount, hash' };
    }

    // Prefix direct API jobs to avoid conflicts with marketplace (chain-N) or voucher IDs
    const prefixedJobId = jobId.startsWith('direct-') ? jobId : `direct-${jobId}`;

    // Check for duplicate job
    if (jobs.has(prefixedJobId)) {
      const existing = jobs.get(prefixedJobId);
      if (existing.status === 'writing') {
        return {
          accepted: false,
          reason: 'Job already in progress',
          jobId: prefixedJobId,
          status: existing.status,
          chunksWritten: existing.chunksWritten,
          chunksTotal: existing.chunksTotal,
        };
      }
      jobs.delete(prefixedJobId);
    }
    // Also check queue for duplicate
    if (jobQueue.some(q => q.jobId === prefixedJobId)) {
      return { accepted: false, reason: 'Job already queued', jobId: prefixedJobId };
    }

    // Decode blob from base64
    let blobBuffer;
    try {
      blobBuffer = Buffer.from(blob, 'base64');
    } catch (err) {
      reply.status(400);
      return { error: 'Invalid base64 blob data' };
    }

    // Check wallet balance before accepting
    const balanceErr = await checkWalletBalance(chunkCount, reply);
    if (balanceErr) return balanceErr;

    const active = activeJobCount();
    const estimatedSeconds = Math.ceil(chunkCount / 150 * 30);

    // If at capacity, queue the job (if queue enabled and not full)
    if (active >= CAPACITY) {
      if (QUEUE_MAX <= 0 || jobQueue.length >= QUEUE_MAX) {
        reply.status(503);
        return {
          error: 'At capacity and queue full',
          activeJobs: active,
          capacity: CAPACITY,
          queueSize: jobQueue.length,
          queueMax: QUEUE_MAX,
          hint: 'Try another writer or wait',
        };
      }

      jobQueue.push({ jobId: prefixedJobId, blobBuffer, chunkCount, hash, callbackUrl: callbackUrl || null, meta: null, queuedAt: Date.now() });
      console.log(`[Writer] Job ${prefixedJobId} queued (position ${jobQueue.length}/${QUEUE_MAX})`);

      const queueWaitSeconds = jobQueue.length * estimatedSeconds;
      reply.status(202);
      return {
        accepted: true,
        queued: true,
        jobId: prefixedJobId,
        queuePosition: jobQueue.length,
        queueMax: QUEUE_MAX,
        estimatedSeconds: estimatedSeconds + queueWaitSeconds,
        activeJobs: active,
        capacity: CAPACITY,
      };
    }

    // Start inscription immediately
    processInscription(prefixedJobId, blobBuffer, chunkCount, hash, callbackUrl || null)
      .catch(err => console.error(`[Writer] Job ${prefixedJobId} uncaught: ${err.message}`))
      .finally(() => drainQueue());

    reply.status(202);
    return {
      accepted: true,
      queued: false,
      jobId: prefixedJobId,
      estimatedSeconds,
      activeJobs: active + 1,
      capacity: CAPACITY,
    };
  });

  // ── GET /status/:jobId — check job progress ───────────────────────────

  app.get('/status/:jobId', (req) => {
    // Check queue first
    const qIdx = jobQueue.findIndex(q => q.jobId === req.params.jobId);
    if (qIdx !== -1) {
      const queued = jobQueue[qIdx];
      return {
        jobId: queued.jobId,
        status: 'queued',
        queuePosition: qIdx + 1,
        queuedAt: queued.queuedAt,
        chunksTotal: queued.chunkCount,
      };
    }
    const job = jobs.get(req.params.jobId);
    if (!job) {
      return { error: 'Job not found', jobId: req.params.jobId };
    }
    return {
      jobId: job.jobId,
      status: job.status,
      chunksWritten: job.chunksWritten,
      chunksTotal: job.chunksTotal,
      manifestHash: job.manifestHash,
      pointerSig: job.pointerSig || null,
      error: job.error || null,
      startedAt: job.startedAt,
      completedAt: job.completedAt || null,
      ...(job.status === 'complete' ? { signatures: job.signatures } : {}),
    };
  });

  // ── POST /inscribe/voucher — accept a voucher-funded inscription job ──
  // Called by the Vercel server after validating a user's voucher redemption.
  // Same pipeline as /inscribe but auth'd via API key, with creator metadata.

  app.post('/inscribe/voucher', {
    config: { rawBody: true },
    bodyLimit: BODY_LIMIT_BYTES,
  }, async (req, reply) => {
    // Vouchers work in ALL modes — they're operator-controlled pre-payments.
    // Direct mode makes vouchers cheaper to fulfill (no escrow/PDA overhead).
    const authErr = requireApiKey(req, reply);
    if (authErr) return authErr;

    const { blob, hash, creator, voucherAddress, callbackUrl } = req.body || {};

    if (!blob || !hash || !creator || !voucherAddress) {
      reply.status(400);
      return { error: 'Missing required fields: blob, hash, creator, voucherAddress' };
    }

    // Decode blob
    let blobBuffer;
    try {
      blobBuffer = Buffer.from(blob, 'base64');
    } catch (err) {
      console.warn('[Writer] base64 decode failed (voucher):', err.message);
      reply.status(400);
      return { error: 'Invalid base64 blob data' };
    }

    // Calculate chunk count from blob size
    const chunkCount = Math.ceil(blobBuffer.length / MEMO_PAYLOAD_SIZE);
    const jobId = `voucher-${voucherAddress.slice(0, 8)}-${Date.now().toString(36)}`;

    // Check voucher wallet balance before accepting
    const voucherKpForCheck = getVoucherKeypair();
    const balanceErr = await checkWalletBalance(chunkCount, reply, voucherKpForCheck);
    if (balanceErr) return balanceErr;

    // Check for duplicate
    if (jobs.has(jobId)) {
      const existing = jobs.get(jobId);
      if (existing.status === 'writing') {
        return { accepted: false, reason: 'Job already in progress', status: existing.status };
      }
      jobs.delete(jobId);
    }

    const active = activeJobCount();
    const estimatedSeconds = Math.ceil(chunkCount / 150 * 30);
    const meta = { creator, voucherAddress };

    // If at capacity, queue the job
    if (active >= CAPACITY) {
      if (QUEUE_MAX <= 0 || jobQueue.length >= QUEUE_MAX) {
        reply.status(503);
        return { error: 'At capacity and queue full', activeJobs: active, capacity: CAPACITY, queueSize: jobQueue.length };
      }

      jobQueue.push({ jobId, blobBuffer, chunkCount, hash, callbackUrl: callbackUrl || null, meta, queuedAt: Date.now(), keypairOverride: getVoucherKeypair() });
      console.log(`[Writer] Voucher job ${jobId} queued (position ${jobQueue.length}/${QUEUE_MAX})`);

      reply.status(202);
      return { accepted: true, queued: true, jobId, chunkCount, queuePosition: jobQueue.length, estimatedSeconds };
    }

    // Start inscription immediately — use voucher wallet if configured
    const voucherKp = getVoucherKeypair();
    processInscription(jobId, blobBuffer, chunkCount, hash, callbackUrl || null, meta, voucherKp)
      .catch(err => console.error(`[Writer] Voucher job ${jobId} uncaught: ${err.message}`))
      .finally(() => drainQueue());

    console.log(`[Writer] Voucher job accepted: ${jobId} (${chunkCount} chunks, creator: ${creator.slice(0, 8)}...)`);

    reply.status(202);
    return {
      accepted: true,
      queued: false,
      jobId,
      chunkCount,
      estimatedSeconds,
      activeJobs: active + 1,
      capacity: CAPACITY,
    };
  });

  // ── GET /quote/direct — direct pricing + congestion info ──────────────

  app.get('/quote/direct', async (req, reply) => {
    if (INSCRIPTION_MODE === 'marketplace') {
      reply.status(404);
      return { error: 'Direct inscription disabled (mode=marketplace)' };
    }

    const sizeStr = req.query.size;
    if (!sizeStr) {
      reply.status(400);
      return { error: 'Missing required query param: size (blob size in bytes)' };
    }
    const size = parseInt(sizeStr, 10);
    if (!Number.isFinite(size) || size <= 0) {
      reply.status(400);
      return { error: 'size must be a positive integer (bytes)' };
    }

    // Fetch live SOL price for USD → lamports conversion
    const solPrice = await fetchSolPrice();

    const chunkCount = Math.ceil(size / MEMO_PAYLOAD_SIZE);
    // Two-step pricing: TX cost (pass-through) + margin ($1 min, $1/MB)
    const txCostLamports = chunkCount * BASE_CHUNK_COST_LAMPORTS; // actual Solana TX fees
    const sizeMb = size / 1_000_000;
    const marginUsd = Math.max(DIRECT_MIN_PRICE_USD, sizeMb * DIRECT_PRICE_PER_MB_USD);
    const marginLamports = usdToLamports(marginUsd, solPrice);
    const priceLamports = txCostLamports + marginLamports;

    // Marketplace comparison price (for UI)
    const marketplacePriceLamports = Math.max(15_385_000, chunkCount * 7500);

    const estimatedWaitSec = estimateQueueWaitSec();
    const congested = estimatedWaitSec > CONGESTION_THRESHOLD_SEC;
    const overflowToMarketplace = congested && INSCRIPTION_MODE === 'hybrid';

    // Congestion pricing for direct-only mode (no marketplace fallback)
    const finalPriceLamports = (congested && INSCRIPTION_MODE === 'direct')
      ? Math.ceil(priceLamports * CONGESTION_MULTIPLIER)
      : priceLamports;

    const paymentWallet = DIRECT_PAYMENT_WALLET || walletAddress;

    return {
      chunkCount,
      blobSizeBytes: size,
      priceLamports: finalPriceLamports,
      priceSol: finalPriceLamports / 1e9,
      txCostLamports,
      marginUsd: Math.round(marginUsd * 100) / 100,
      solPrice,
      marketplacePriceLamports,
      marketplacePriceSol: marketplacePriceLamports / 1e9,
      paymentWallet,
      estimatedWaitSec,
      congested,
      overflowToMarketplace,
      mode: INSCRIPTION_MODE,
      activeJobs: activeJobCount(),
      queueDepth: jobQueue.length,
    };
  });

  // ── POST /inscribe/direct — accept direct inscription (SOL transfer auth) ──

  app.post('/inscribe/direct', {
    config: { rawBody: true },
    bodyLimit: BODY_LIMIT_BYTES,
  }, async (req, reply) => {
    if (INSCRIPTION_MODE === 'marketplace') {
      reply.status(404);
      return { error: 'Direct inscription disabled (mode=marketplace)' };
    }

    const { blob, hash, chunkCount, paymentSig, payerWallet } = req.body || {};

    if (!hash || !paymentSig || !payerWallet) {
      reply.status(400);
      return { error: 'Missing required fields: hash, paymentSig, payerWallet' };
    }

    // Resolve blob: from POST body (base64) or from upload cache (pre-uploaded via PUT /upload/:hash)
    let blobBuffer;
    if (blob) {
      try {
        blobBuffer = Buffer.from(blob, 'base64');
      } catch (err) {
        console.warn('[Writer] base64 decode failed (direct):', err.message);
        reply.status(400);
        return { error: 'Invalid base64 blob data' };
      }
    } else {
      // Read from upload cache — blob was pre-uploaded via PUT /upload/:hash
      blobBuffer = getBlob(hash);
      if (!blobBuffer) {
        reply.status(400);
        return { error: 'Blob not found — upload via PUT /upload/:hash first' };
      }
    }

    const actualChunkCount = chunkCount || Math.ceil(blobBuffer.length / MEMO_PAYLOAD_SIZE);

    // Verify SOL transfer on-chain — two-step: TX cost + margin (USD-based)
    const paymentWallet = DIRECT_PAYMENT_WALLET || walletAddress;
    const solPrice = await fetchSolPrice();
    const sizeMb = blobBuffer.length / 1_000_000;
    const txCostLamports = actualChunkCount * BASE_CHUNK_COST_LAMPORTS;
    const marginUsd = Math.max(DIRECT_MIN_PRICE_USD, sizeMb * DIRECT_PRICE_PER_MB_USD);
    const marginLamports = usdToLamports(marginUsd, solPrice);
    // Allow 5% tolerance on margin for price movement between quote and verification
    const expectedLamports = txCostLamports + Math.ceil(marginLamports * 0.95);

    try {
      // Retry getTransaction — TX may take a few seconds to propagate across RPC nodes
      let txInfo = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        txInfo = await rpcCall('getTransaction', [paymentSig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
        if (txInfo) break;
        if (attempt < 4) await new Promise(r => setTimeout(r, 2000)); // 2s between retries
      }
      if (!txInfo) {
        reply.status(402);
        return { error: 'Payment transaction not found after 5 attempts. Ensure it is confirmed before submitting.', paymentSig };
      }
      if (txInfo.meta?.err) {
        reply.status(402);
        return { error: 'Payment transaction failed on-chain', txError: txInfo.meta.err };
      }

      // Find a SOL transfer to our payment wallet in the TX instructions
      let transferFound = false;
      let actualLamports = 0;
      const instructions = txInfo.transaction?.message?.instructions || [];
      for (const ix of instructions) {
        if (ix.program === 'system' && ix.parsed?.type === 'transfer') {
          const info = ix.parsed.info;
          if (info.destination === paymentWallet && info.lamports >= expectedLamports) {
            transferFound = true;
            actualLamports = info.lamports;
            break;
          }
        }
      }

      if (!transferFound) {
        reply.status(402);
        return {
          error: 'No valid SOL transfer found in transaction',
          expectedDestination: paymentWallet,
          expectedLamports,
          paymentSig,
        };
      }
    } catch (err) {
      console.warn('[Writer] Payment verification failed:', err.message);
      reply.status(502);
      return { error: 'Payment verification failed — RPC error', detail: err.message };
    }

    // Replay protection — persistent KV check survives cleanupJobs() eviction
    if (getKV('payment:' + paymentSig)) {
      reply.status(409);
      return { error: 'Payment signature already used', paymentSig };
    }
    // Also check in-memory active jobs + queue (catches concurrent requests before KV write)
    for (const [, job] of jobs) {
      if (job.meta?.paymentSig === paymentSig) {
        reply.status(409);
        return { error: 'Payment signature already used', paymentSig };
      }
    }
    for (const q of jobQueue) {
      if (q.meta?.paymentSig === paymentSig) {
        reply.status(409);
        return { error: 'Payment signature already used', paymentSig };
      }
    }

    // Check wallet balance before accepting
    const balanceErr = await checkWalletBalance(actualChunkCount, reply);
    if (balanceErr) return balanceErr;

    const jobId = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    // Check for duplicate by hash (prevent double-inscription of same blob)
    for (const [id, job] of jobs) {
      if (job.manifestHash === hash && job.status === 'writing') {
        return { accepted: false, reason: 'Inscription already in progress for this hash', jobId: id };
      }
    }

    const active = activeJobCount();
    const estimatedSeconds = Math.ceil(actualChunkCount / 15);

    // If at capacity, queue or reject
    if (active >= CAPACITY) {
      if (QUEUE_MAX <= 0 || jobQueue.length >= QUEUE_MAX) {
        reply.status(503);
        return {
          error: 'At capacity and queue full',
          activeJobs: active,
          capacity: CAPACITY,
          queueSize: jobQueue.length,
          hint: INSCRIPTION_MODE === 'hybrid' ? 'Frontend should fall back to marketplace' : 'Try again later',
        };
      }

      // Persist payment sig before queuing to prevent replay after cleanupJobs()
      setKV('payment:' + paymentSig, Date.now().toString());

      // Log direct payment received (queued path)
      logEarning(jobId, 'direct', 'payment_received', actualLamports, paymentSig, {
        chunkCount: actualChunkCount, blobSize: blobBuffer.length,
        payer: payerWallet, solPrice, marginUsd, txCostLamports,
      });

      const directCallbackUrl = `${COORDINATOR_URL}/api/memo-store?action=job-callback`;

      // Persist blob + job record for auto-resume on restart
      storeBlob(hash, blobBuffer);
      saveDirectJob({
        jobId, paymentSig, payerWallet, manifestHash: hash,
        chunkCount: actualChunkCount, blobSize: blobBuffer.length,
        callbackUrl: directCallbackUrl,
      });

      jobQueue.push({
        jobId, blobBuffer, chunkCount: actualChunkCount, hash,
        callbackUrl: directCallbackUrl, meta: { payerWallet, paymentSig, direct: true, creator: payerWallet },
        queuedAt: Date.now(),
      });
      console.log(`[Writer] Direct job ${jobId} queued (position ${jobQueue.length}/${QUEUE_MAX})`);

      reply.status(202);
      return {
        accepted: true, queued: true, jobId, chunkCount: actualChunkCount,
        queuePosition: jobQueue.length, estimatedSeconds: estimatedSeconds + (jobQueue.length * estimatedSeconds),
      };
    }

    // Persist payment sig before starting to prevent replay after cleanupJobs()
    setKV('payment:' + paymentSig, Date.now().toString());

    // Log direct payment received (immediate path)
    logEarning(jobId, 'direct', 'payment_received', actualLamports, paymentSig, {
      chunkCount: actualChunkCount, blobSize: blobBuffer.length,
      payer: payerWallet, solPrice, marginUsd, txCostLamports,
    });

    // Persist blob + job record for auto-resume on restart
    const directCallbackUrl = `${COORDINATOR_URL}/api/memo-store?action=job-callback`;
    storeBlob(hash, blobBuffer);
    saveDirectJob({
      jobId, paymentSig, payerWallet, manifestHash: hash,
      chunkCount: actualChunkCount, blobSize: blobBuffer.length,
      callbackUrl: directCallbackUrl,
    });

    // Start inscription immediately
    processInscription(jobId, blobBuffer, actualChunkCount, hash, directCallbackUrl, { payerWallet, paymentSig, direct: true, creator: payerWallet })
      .then(() => {
        const j = jobs.get(jobId);
        if (j && j.status === 'complete') completeDirectJob(jobId);
        // interrupted/failed jobs stay as 'writing' in DB for resume on next restart
      })
      .catch(err => {
        console.error(`[Writer] Direct job ${jobId} uncaught: ${err.message}`);
        failDirectJob(jobId);
      })
      .finally(() => drainQueue());

    console.log(`[Writer] Direct job accepted: ${jobId} (${actualChunkCount} chunks, payer: ${payerWallet.slice(0, 8)}...)`);

    reply.status(202);
    return {
      accepted: true, queued: false, jobId, chunkCount: actualChunkCount,
      estimatedSeconds, activeJobs: active + 1, capacity: CAPACITY,
    };
  });

  // ── POST /admin/mode — runtime inscription mode switch ──────────────

  app.post('/admin/mode', async (req, reply) => {
    const authErr = requireApiKey(req, reply);
    if (authErr) return authErr;

    const { mode } = req.body || {};
    if (!mode) {
      reply.status(400);
      return { error: 'Missing required field: mode (direct|marketplace|hybrid)' };
    }

    const previousMode = INSCRIPTION_MODE;
    try {
      setInscriptionMode(mode);
    } catch (err) {
      reply.status(400);
      return { error: err.message };
    }

    console.log(`[Writer] Inscription mode changed: ${previousMode} → ${mode}`);
    return { ok: true, mode: INSCRIPTION_MODE, previousMode };
  });

  // ── GET /admin/earnings — operator earnings dashboard ──────────────────

  app.get('/admin/earnings', async (req, reply) => {
    const authErr = requireApiKey(req, reply);
    if (authErr) return authErr;

    const since = parseInt(req.query.since) || 0;
    const summary = getEarningsSummary();
    const recent = getEarningsSince(since || (Date.now() - 30 * 24 * 60 * 60 * 1000), 50);

    const byType = {};
    for (const row of summary) {
      byType[row.type] = { in: row.total_in, out: row.total_out, net: row.net, jobs: row.jobs };
    }
    const totalIn = summary.reduce((s, r) => s + (r.total_in || 0), 0);
    const totalOut = summary.reduce((s, r) => s + (r.total_out || 0), 0);

    return {
      ok: true,
      summary: {
        totalIn, totalOut,
        netProfit: totalIn + totalOut,
        netProfitSol: (totalIn + totalOut) / 1e9,
        byType,
      },
      recent: recent.map(r => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null })),
    };
  });

  // ── Extend /health with writer info ────────────────────────────────────

  app.get('/writer/health', () => {
    const active = activeJobCount();
    const jobSummaries = [];
    for (const [id, job] of jobs) {
      jobSummaries.push({
        jobId: id,
        status: job.status,
        chunksWritten: job.chunksWritten,
        chunksTotal: job.chunksTotal,
      });
    }
    const voucherKp = getVoucherKeypair();
    const voucherWalletAddr = voucherKp.publicKey.toBase58();
    return {
      role: 'writer',
      wallet: walletAddress,
      voucherWallet: voucherWalletAddr !== walletAddress ? voucherWalletAddr : null,
      inscriptionMode: INSCRIPTION_MODE,
      activeJobs: active,
      capacity: CAPACITY,
      queueSize: jobQueue.length,
      queueMax: QUEUE_MAX,
      jobs: jobSummaries,
    };
  });
}
