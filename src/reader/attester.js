/**
 * reader/attester.js — On-chain job attestation for reader nodes.
 *
 * Polling loop (runs when MARKETPLACE_ENABLED=true):
 *   1. Poll submitted jobs from freezedry_jobs program
 *   2. For each: check if we already attested (attestation PDA exists)
 *   3. Verify: fetch blob → compute SHA-256 → compare to content_hash
 *   4. Spot-check: read K random chunk memos from chain → compare to blob
 *   5. Attest(true) if both pass, skip on first spot-check failure (second-chance),
 *      Attest(false) on second consecutive failure
 *
 * Blob cascade: blobSource (job PDA) → local cache → writer/peers → CDN → coordinator → chain
 * Spot-check: 2 random chunks verified on-chain (SPOT_CHECK_COUNT). Catches garbage inscriptions.
 *
 * Uses tx-builder.js for instruction construction (no Anchor dependency).
 */

import { PublicKey, TransactionInstruction, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import { createHash } from 'crypto';
import { env, MEMO_PROGRAM_ID, MEMO_PAYLOAD_SIZE } from '../config.js';
import { isHydBlob, isOpenMode, extractContentHash } from '../hyd.js';
import { getServerKeypair } from '../wallet.js';
import {
  JOBS_PROGRAM_ID, REGISTRY_PROGRAM_ID,
  JOB_DISC, deriveConfigPDA, deriveNodePDA, deriveAttestationPDA, deriveJobPDA,
  parseJobAccount, parseConfigAccount, buildAttestIx, buildReleasePaymentIx,
  buildCloseCompletedJobIx, buildCloseAttestationIx, buildSignedTx,
} from '../chain/tx-builder.js';
import {
  fetchSubmittedJobs as cachedFetchSubmittedJobs,
  getConnection as getJobsConnection,
} from '../chain/jobs-cache.js';
import * as db from '../db.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const POLL_INTERVAL = parseInt(env('CLAIM_POLL_INTERVAL') || '30000', 10);

// Track attestations we've made this session (avoid re-checking PDA existence)
const attestedJobIds = new Set();

// Suspect list — jobs where spot-check failed once. Second failure → attest false.
// Map<jobId, { failedAt: number, reason: string }>
const suspectJobs = new Map();

let _running = false;
let _pollTimer = null;
let _attestCount = 0;

// ── RPC connection (shared with claimer via jobs-cache.js) ───────────────────

function getConnection() {
  return getJobsConnection();
}

// ── RPC helpers (lightweight — no full rpc.js dependency for reader) ─────────

function getJobsRpcUrl() {
  return env('JOBS_RPC_URL') || env('NODE_REGISTRY_RPC')
    || env('SOLANA_RPC') || 'https://api.mainnet-beta.solana.com';
}

async function rpcCall(method, params) {
  const url = getJobsRpcUrl();
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`RPC ${method} HTTP ${resp.status}`);
  const json = await resp.json();
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result;
}

async function sendAndConfirm(txBase64) {
  const sig = await rpcCall('sendTransaction', [txBase64, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' }]);
  await sleep(2000);
  const status = await rpcCall('getSignatureStatuses', [[sig]]);
  const s = status.value?.[0];
  if (s?.err) throw new Error(`tx failed: ${JSON.stringify(s.err)}`);
  return sig;
}

// ── Fetch submitted jobs (shared cache — saves 1 gPA per poll cycle) ─────────

async function fetchSubmittedJobs() {
  return cachedFetchSubmittedJobs();
}

// ── Check if we already attested a job ───────────────────────────────────────

async function hasAttested(jobId) {
  if (attestedJobIds.has(jobId)) return true;

  const conn = getConnection();
  const keypair = getServerKeypair();
  const [attestPDA] = deriveAttestationPDA(jobId, keypair.publicKey);
  const info = await conn.getAccountInfo(attestPDA);
  if (info) {
    attestedJobIds.add(jobId);
    return true;
  }
  return false;
}

// ── Fetch and verify blob data ───────────────────────────────────────────────

/**
 * Verify a blob's manifest hash matches the expected content hash.
 * For HYD blobs: reads bytes 17-48 (embedded content hash).
 * For non-HYD: falls back to SHA-256(entire blob).
 *
 * Returns { valid: bool, computedHash: string } — hash uses same prefix as expectedHash.
 * The computedHash is sent on-chain so the program can derive validity trustlessly.
 */
function verifyBlobManifest(blob, expectedHash) {
  // Determine if on-chain hash uses prefix
  const prefix = expectedHash.startsWith('sha256:') ? 'sha256:' : '';
  const cleanExpected = expectedHash.replace(/^sha256:/, '');

  let rawHash;
  if (isOpenMode(blob)) {
    rawHash = extractContentHash(blob);
  } else {
    rawHash = createHash('sha256').update(blob).digest('hex');
  }

  const computedHash = prefix + rawHash;
  return { valid: computedHash === expectedHash, computedHash };
}

/**
 * Fetch blob using priority cascade:
 *   1. blobSource URL from job PDA (set at job creation)
 *   2. Local cache
 *   3. Writer node + peer nodes (gossip network)
 *   4. CDN R2 (may have expired after 2 days)
 *   5. Coordinator serve-job-blob
 *   6. Chain reconstruct (last resort, always works)
 *
 * Returns Buffer or null.
 */
async function fetchBlob(job) {
  const hash = job.contentHash;
  const lookupHash = hash.startsWith('sha256:') ? hash : `sha256:${hash}`;
  const tag = hash.replace(/^sha256:/, '').slice(0, 16);

  // 1. blobSource from job PDA (URL set at job creation — often CDN or node URL)
  if (job.blobSource && job.blobSource.startsWith('http')) {
    try {
      const resp = await fetch(job.blobSource, { signal: AbortSignal.timeout(15_000), redirect: 'follow' });
      if (resp.ok) {
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length > 0) {
          console.log(`[Attester] Got blob from blobSource for ${tag}...`);
          return buf;
        }
      }
    } catch (err) { console.warn('[Attester] blobSource fetch failed:', err.message); }
  }

  // 2. Local cache
  const localBlob = db.getBlob(lookupHash);
  if (localBlob) {
    console.log(`[Attester] Got blob from local cache for ${tag}...`);
    return localBlob;
  }

  // 3. Peer nodes (writer is a peer — they definitely have it)
  const peers = db.listPeers();
  for (const peer of peers) {
    try {
      const resp = await fetch(
        `${peer.url}/blob/${encodeURIComponent(lookupHash)}`,
        { signal: AbortSignal.timeout(15_000), redirect: 'manual' }
      );
      if (resp.ok) {
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length > 0) {
          console.log(`[Attester] Got blob from peer ${peer.url} for ${tag}...`);
          return buf;
        }
      }
    } catch (err) { console.warn('[Attester] peer fetch failed:', err.message); }
  }

  // 4. CDN R2 (may have expired after 2 days)
  try {
    const cdnUrl = env('CDN_URL') || 'https://cdn.freezedry.art';
    const resp = await fetch(
      `${cdnUrl}/blob/${lookupHash}`,
      { signal: AbortSignal.timeout(15_000), redirect: 'follow' }
    );
    if (resp.ok) {
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > 0) {
        console.log(`[Attester] Got blob from CDN for ${tag}...`);
        return buf;
      }
    }
  } catch (err) { console.warn('[Attester] CDN fetch failed:', err.message); }

  // 5. Coordinator serve-job-blob
  const coordinatorUrl = env('COORDINATOR_URL') || 'https://freezedry.art';
  try {
    const resp = await fetch(
      `${coordinatorUrl}/api/memo-store?action=serve-job-blob&hash=${encodeURIComponent(lookupHash)}`,
      { signal: AbortSignal.timeout(30_000), redirect: 'follow' }
    );
    if (resp.ok) {
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > 0) {
        console.log(`[Attester] Got blob from coordinator for ${tag}...`);
        return buf;
      }
    }
  } catch (err) {
    console.warn(`[Attester] serve-job-blob failed for ${tag}...: ${err.message}`);
  }

  // 6. Chain reconstruct (last resort)
  try {
    const resp = await fetch(
      `${coordinatorUrl}/api/fetch-chain?hash=${encodeURIComponent(lookupHash)}&format=blob`,
      { signal: AbortSignal.timeout(30_000), redirect: 'manual' }
    );
    if (resp.ok) {
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > 0) {
        console.log(`[Attester] Got blob from chain reconstruct for ${tag}...`);
        return buf;
      }
    }
  } catch (err) {
    console.warn(`[Attester] Chain fetch failed for ${tag}...: ${err.message}`);
  }

  return null; // can't fetch blob from any source
}

/**
 * Verify blob hash matches job's content_hash.
 * Returns { valid, computedHash, blob } or null if blob unavailable.
 */
async function verifyJobBlob(job) {
  const hash = job.contentHash;
  const blob = await fetchBlob(job);
  if (!blob) return null;

  const result = verifyBlobManifest(blob, hash);
  return { ...result, blob };
}

// ── Spot-check: verify on-chain memo data matches blob ─────────────────────

const SPOT_CHECK_COUNT = 2;

/**
 * Strip Solana RPC's "[byteLen] " prefix from memo fields.
 */
function stripMemoPrefix(memo) {
  const bracketEnd = memo.indexOf('] ');
  return bracketEnd !== -1 ? memo.slice(bracketEnd + 2) : memo;
}

/**
 * Pointer-guided spot-check: verify on-chain memo data matches blob.
 *
 * Strategy: find the FREEZEDRY:3 pointer memo for this job, then use its
 * signature as a cursor to jump directly into the chunk window. The pointer
 * is written AFTER all chunks, so all chunk sigs are immediately older.
 *
 * Cost: 2-3 RPC calls total (find pointer + 1-2 pages of chunks).
 * Works on any RPC tier. No blind pagination.
 *
 * Returns { valid: true, verified, total } on pass,
 *         { valid: false, reason } on mismatch,
 *         null if indeterminate (pointer not found yet / chunks not finalized).
 */
async function spotCheckOnChain(job, blob) {
  const hash = job.contentHash;
  const hash8 = hash.replace(/^sha256:/, '').slice(0, 8);

  // Split blob into expected chunks (same as writer does)
  const expectedChunks = [];
  for (let off = 0; off < blob.length; off += MEMO_PAYLOAD_SIZE) {
    expectedChunks.push(blob.slice(off, Math.min(off + MEMO_PAYLOAD_SIZE, blob.length)));
  }
  const totalChunks = expectedChunks.length;
  if (totalChunks === 0) return { valid: false, reason: 'empty blob' };

  // Pick K random chunk indices
  const checkCount = Math.min(SPOT_CHECK_COUNT, totalChunks);
  const indices = new Set();
  while (indices.size < checkCount) {
    indices.add(Math.floor(Math.random() * totalChunks));
  }

  const writerAddr = job.writer.toBase58();
  const chunkPrefix = `FD:${hash8}:`;
  // Pointer memo always includes sha256: prefix, but on-chain contentHash may not
  const cleanHash = hash.replace(/^sha256:/, '');
  const pointerPrefix = `FREEZEDRY:3:sha256:${cleanHash}`;

  // Step 1: Find the pointer memo — scan recent sigs (pointer is near the top)
  let pointerSig = null;
  let scanCursor = undefined;
  for (let page = 0; page < 3 && !pointerSig; page++) {
    let sigs;
    try {
      const params = { limit: 1000, commitment: 'finalized' };
      if (scanCursor) params.before = scanCursor;
      sigs = await rpcCall('getSignaturesForAddress', [writerAddr, params]);
    } catch (err) {
      console.warn(`[Attester] Spot-check: can't fetch writer sigs: ${err.message}`);
      return null;
    }
    if (!sigs || sigs.length === 0) {
      if (page === 0) {
        console.warn(`[Attester] Spot-check: no sigs for writer ${writerAddr.slice(0, 8)}...`);
        return null;
      }
      break;
    }

    for (const s of sigs) {
      if (!s.memo) continue;
      const memo = stripMemoPrefix(s.memo);
      if (memo.startsWith(pointerPrefix)) {
        pointerSig = s.signature;
        break;
      }
    }
    scanCursor = sigs[sigs.length - 1].signature;
    if (sigs.length < 1000) break;
  }

  if (!pointerSig) {
    console.log(`[Attester] Spot-check ${hash8}: pointer memo not found yet, will retry`);
    return null; // pointer not finalized yet
  }

  // Step 2: Fetch chunk sigs starting right before the pointer (chunks are older)
  // Paginate up to 2 pages from the pointer — chunks are right there.
  const foundChunks = new Map();
  let chunkCursor = pointerSig;

  for (let page = 0; page < 2 && foundChunks.size < checkCount; page++) {
    let sigs;
    try {
      sigs = await rpcCall('getSignaturesForAddress', [
        writerAddr,
        { limit: 1000, before: chunkCursor, commitment: 'finalized' },
      ]);
    } catch (err) {
      console.warn(`[Attester] Spot-check: chunk fetch failed (page ${page}): ${err.message}`);
      break;
    }
    if (!sigs || sigs.length === 0) break;

    let foundAnyForJob = false;
    for (const s of sigs) {
      if (foundChunks.size >= checkCount) break;
      if (!s.memo) continue;
      const memo = stripMemoPrefix(s.memo);

      if (!memo.startsWith(chunkPrefix)) {
        // If we've been finding chunks and hit a non-matching memo,
        // we've passed the chunk window — stop early
        if (foundAnyForJob) continue; // skip non-chunk sigs interspersed
        continue;
      }
      foundAnyForJob = true;

      const rest = memo.slice(chunkPrefix.length);
      const nextColon = rest.indexOf(':');
      if (nextColon === -1) continue;

      const idx = parseInt(rest.slice(0, nextColon), 10);
      if (isNaN(idx) || !indices.has(idx)) continue;
      if (foundChunks.has(idx)) continue;

      try {
        const decoded = Buffer.from(rest.slice(nextColon + 1), 'base64');
        foundChunks.set(idx, decoded);
      } catch (err) {
        console.warn('[Attester] base64 decode failed for chunk', idx, err.message);
        foundChunks.set(idx, null);
      }
    }

    chunkCursor = sigs[sigs.length - 1].signature;
    if (sigs.length < 1000) break;
  }

  // Verify found chunks match expected data
  let verified = 0;
  let mismatched = 0;
  let notFound = 0;

  for (const idx of indices) {
    if (!foundChunks.has(idx)) {
      notFound++;
      continue;
    }
    const onChain = foundChunks.get(idx);
    const expected = expectedChunks[idx];
    if (!onChain || !expected || !onChain.equals(expected)) {
      mismatched++;
      console.warn(`[Attester] Spot-check MISMATCH chunk ${idx}/${totalChunks} for ${hash8}`);
    } else {
      verified++;
    }
  }

  console.log(`[Attester] Spot-check ${hash8}: ${verified} verified, ${mismatched} mismatched, ${notFound} not found (of ${checkCount} sampled, pointer-guided)`);

  if (mismatched > 0) {
    return { valid: false, reason: `${mismatched}/${checkCount} chunks failed on-chain verification` };
  }

  if (verified === 0 && notFound === checkCount) {
    return null; // indeterminate — chunks may not be finalized yet
  }

  return { valid: true, verified, total: checkCount };
}

// ── Attest on-chain ──────────────────────────────────────────────────────────

async function attestJob(job, computedHash) {
  const keypair = getServerKeypair();
  const readerPubkey = keypair.publicKey;

  const [configPDA] = deriveConfigPDA();
  const [nodePDA] = deriveNodePDA(readerPubkey);
  const [attestPDA] = deriveAttestationPDA(job.jobId, readerPubkey);
  const jobPDA = job.address;

  const ix = buildAttestIx(jobPDA, configPDA, attestPDA, nodePDA, readerPubkey, computedHash);

  const blockhash = (await rpcCall('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
  const txBase64 = buildSignedTx(ix, blockhash, keypair);
  const sig = await sendAndConfirm(txBase64);

  attestedJobIds.add(job.jobId);
  _attestCount++;

  const isValid = computedHash === job.contentHash;
  console.log(`[Attester] Attested job #${job.jobId} — valid: ${isValid}, hash: ${computedHash.slice(0, 20)}..., tx: ${sig}`);
  return sig;
}

/**
 * After attestation, check if quorum is met and auto-release payment.
 * release_payment is permissionless — any signer can call it once quorum is reached.
 */
async function tryReleasePayment(job) {
  const conn = getConnection();
  const keypair = getServerKeypair();

  // Re-read job to get fresh attestation_count
  const info = await conn.getAccountInfo(job.address);
  if (!info) return;
  const freshJob = parseJobAccount(job.address, info.data);
  if (!freshJob || freshJob.status !== 'submitted') return;

  // Read config for min_attestations + treasury
  const [configPDA] = deriveConfigPDA();
  const configInfo = await conn.getAccountInfo(configPDA);
  if (!configInfo) return;
  const config = parseConfigAccount(configPDA, configInfo.data);
  if (!config) return;

  if (freshJob.attestationCount < config.minAttestations) return;

  // Quorum met — release payment + send receipt memo to creator
  // This node is both the attester (earns 10%) and the TX signer
  const [attestationPDA] = deriveAttestationPDA(freshJob.jobId, keypair.publicKey);
  const releaseIx = buildReleasePaymentIx(
    job.address, configPDA,
    freshJob.writer,         // inscriber gets their share
    config.treasury,         // treasury
    freshJob.referrer,       // referrer
    attestationPDA,          // attestation PDA (proves who verified)
    keypair.publicKey,       // attester wallet (earns attester fee)
    keypair.publicKey,       // signer (permissionless)
  );

  // Receipt memo — lands in creator's TX history for permanent discoverability
  // Note: Memo program requires all accounts in keys[] to be signers.
  // We don't have the creator's keypair, so pass empty keys (memo signed by fee payer only).
  const receiptData = `FREEZEDRY:RECEIPT:${freshJob.contentHash}:${freshJob.jobId}:${freshJob.chunkCount || 0}`;
  const memoProgramId = new PublicKey(MEMO_PROGRAM_ID);
  const receiptIx = new TransactionInstruction({
    programId: memoProgramId,
    keys: [],
    data: Buffer.from(receiptData),
  });

  const blockhash = (await rpcCall('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: keypair.publicKey })
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }))
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }))
    .add(releaseIx)
    .add(receiptIx);
  tx.sign(keypair);
  const txBase64 = tx.serialize().toString('base64');
  const sig = await sendAndConfirm(txBase64);
  console.log(`[Attester] Auto-released payment for job #${freshJob.jobId} + receipt memo to ${freshJob.creator.toBase58().slice(0, 8)}... — tx: ${sig}`);

  // Record on-chain attester payout (program already split 10% to our wallet)
  try {
    const reimbursement = (freshJob.chunkCount || 0) * 5000;
    const margin = Number(freshJob.escrowLamports) - reimbursement;
    const attesterShare = Math.floor(margin * 1000 / 10000);
    db.logEarning(freshJob.jobId.toString(), 'attester', 'escrow_released',
      attesterShare, sig,
      { escrow: Number(freshJob.escrowLamports), chunks: freshJob.chunkCount }
    );
  } catch (err) {
    console.warn('[Attester] Earnings log failed:', err.message);
  }
}

/**
 * After release_payment moves job to Completed, auto-close the PDA to reclaim rent.
 * Permissionless — any signer can close. Rent returns to job.creator (server wallet).
 */
async function tryCloseCompletedJob(job) {
  const conn = getConnection();
  const keypair = getServerKeypair();

  // Re-read job to confirm it's Completed (release_payment just ran)
  const info = await conn.getAccountInfo(job.address);
  if (!info) return; // already closed
  const freshJob = parseJobAccount(job.address, info.data);
  if (!freshJob || freshJob.status !== 'completed') return;

  const ix = buildCloseCompletedJobIx(job.address, freshJob.creator, keypair.publicKey);
  const blockhash = (await rpcCall('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
  const txBase64 = buildSignedTx(ix, blockhash, keypair);
  const sig = await sendAndConfirm(txBase64);
  console.log(`[Attester] Closed completed job #${freshJob.jobId} — rent to ${freshJob.creator.toBase58().slice(0, 8)}... tx: ${sig}`);
}

/**
 * After job completion + close, auto-close our attestation PDA to reclaim rent.
 * Permissionless — rent returns to reader (us).
 */
async function tryCloseAttestation(job) {
  const keypair = getServerKeypair();
  const [attestPDA] = deriveAttestationPDA(job.jobId, keypair.publicKey);
  const conn = getConnection();

  // Check if attestation PDA still exists
  const info = await conn.getAccountInfo(attestPDA);
  if (!info) return; // already closed

  const [jobPDA] = deriveJobPDA(job.jobId);
  const ix = buildCloseAttestationIx(attestPDA, jobPDA, keypair.publicKey, keypair.publicKey, job.jobId);
  const blockhash = (await rpcCall('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
  const txBase64 = buildSignedTx(ix, blockhash, keypair);
  const sig = await sendAndConfirm(txBase64);
  console.log(`[Attester] Closed attestation PDA for job #${job.jobId} — rent reclaimed, tx: ${sig}`);
}

// ── Main polling loop ────────────────────────────────────────────────────────

async function pollAndAttest() {
  if (!_running) return;

  try {
    const submittedJobs = await fetchSubmittedJobs();
    if (submittedJobs.length === 0) return;

    for (const job of submittedJobs) {
      // If already attested, retry release/close in case it failed last time
      const already = await hasAttested(job.jobId);
      if (already) {
        // Job still "submitted" means release_payment never completed
        if (job.status === 'submitted') {
          try {
            await tryReleasePayment(job);
            try { await tryCloseAttestation(job); } catch (err) { console.warn(`[Attester] closeAttestation for job #${job.jobId}:`, err.message); }
            try { await tryCloseCompletedJob(job); } catch (err) { console.warn(`[Attester] closeCompletedJob for job #${job.jobId}:`, err.message); }
          } catch (retryErr) {
            if (!retryErr.message.includes('already')) {
              console.log(`[Attester] Release retry for job #${job.jobId}: ${retryErr.message}`);
            }
          }
        }
        continue;
      }

      // Skip if writer is us (self-attestation is rejected on-chain anyway)
      const keypair = getServerKeypair();
      if (job.writer.equals(keypair.publicKey)) {
        console.log(`[Attester] Skipping job #${job.jobId} — we are the writer (self-attestation)`);
        attestedJobIds.add(job.jobId); // don't check again
        continue;
      }

      // Verify blob integrity — returns { valid, computedHash, blob } or null
      const result = await verifyJobBlob(job);
      if (result === null) {
        console.log(`[Attester] Job #${job.jobId} — blob unavailable, skipping`);
        continue;
      }

      // If blob hash doesn't match, attest false immediately (no spot-check needed)
      if (!result.valid) {
        try {
          await attestJob(job, result.computedHash);
          console.warn(`[Attester] Job #${job.jobId} — blob hash MISMATCH, attested false`);
        } catch (err) {
          if (err.message.includes('already in use') || err.message.includes('AlreadyAttested')) {
            attestedJobIds.add(job.jobId);
          } else {
            console.error(`[Attester] Failed to attest job #${job.jobId}: ${err.message}`);
          }
        }
        await sleep(1000);
        continue;
      }

      // Blob hash matches — now spot-check on-chain memo data against the blob
      const spotResult = await spotCheckOnChain(job, result.blob);
      if (spotResult === null) {
        // Indeterminate — can't read chain or chunks not finalized yet. Try next cycle.
        console.log(`[Attester] Job #${job.jobId} — spot-check indeterminate, will retry`);
        continue;
      }

      if (!spotResult.valid) {
        // On-chain data doesn't match blob — is this the first or second failure?
        if (!suspectJobs.has(job.jobId)) {
          // First failure — add to suspect list, give second chance
          suspectJobs.set(job.jobId, { failedAt: Date.now(), reason: spotResult.reason });
          console.warn(`[Attester] Job #${job.jobId} — spot-check FAILED (first chance): ${spotResult.reason}`);
          continue;
        }

        // Second failure — confirmed bad. Attest false to requeue.
        console.warn(`[Attester] Job #${job.jobId} — spot-check FAILED TWICE: ${spotResult.reason}. Attesting false.`);
        suspectJobs.delete(job.jobId);
        // Send a poison hash (flip last char) so program sees mismatch → attest(false) → auto-requeue
        const poisonHash = result.computedHash.slice(0, -1) + (result.computedHash.endsWith('0') ? '1' : '0');
        try {
          await attestJob(job, poisonHash);
        } catch (err) {
          if (err.message.includes('already in use') || err.message.includes('AlreadyAttested')) {
            attestedJobIds.add(job.jobId);
          } else {
            console.error(`[Attester] Failed to attest-false job #${job.jobId}: ${err.message}`);
          }
        }
        await sleep(1000);
        continue;
      }

      // Both blob hash and spot-check passed — clear suspect if it was there
      if (suspectJobs.has(job.jobId)) {
        console.log(`[Attester] Job #${job.jobId} — spot-check passed on retry, clearing suspect`);
        suspectJobs.delete(job.jobId);
      }

      // Attest with correct hash (program derives valid on-chain)
      try {
        await attestJob(job, result.computedHash);

        // After successful attestation, try to release payment if quorum met
        try {
          await tryReleasePayment(job);

          // After release_payment succeeds, close attestation PDA first (needs job PDA alive),
          // then close the completed job PDA itself
          try {
            await tryCloseAttestation(job);
          } catch (err) { console.warn('[Attester] closeAttestation cleanup failed:', err.message); }
          try {
            await tryCloseCompletedJob(job);
          } catch (closeErr) {
            if (!closeErr.message.includes('not found')) {
              console.log(`[Attester] Auto-close skipped for job #${job.jobId}: ${closeErr.message}`);
            }
          }
        } catch (releaseErr) {
          // Non-fatal — release may have already happened or will be retried
          if (!releaseErr.message.includes('already')) {
            console.log(`[Attester] Auto-release skipped for job #${job.jobId}: ${releaseErr.message}`);
          }
        }
      } catch (err) {
        // AlreadyAttested error means PDA exists — mark and move on
        if (err.message.includes('already in use') || err.message.includes('AlreadyAttested')) {
          attestedJobIds.add(job.jobId);
          continue;
        }
        console.error(`[Attester] Failed to attest job #${job.jobId}: ${err.message}`);
      }

      // Small delay between attestations to avoid RPC rate limits
      await sleep(1000);
    }
  } catch (err) {
    console.error(`[Attester] Poll error: ${err.message}`);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export function startAttester() {
  if (_running) return;
  _running = true;

  console.log(`[Attester] Starting marketplace attester (poll every ${POLL_INTERVAL / 1000}s)`);

  // Initial poll after a short delay
  setTimeout(() => {
    pollAndAttest();
    _pollTimer = setInterval(pollAndAttest, POLL_INTERVAL);
  }, 8000); // stagger from claimer's 5s delay
}

export function stopAttester() {
  _running = false;
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  console.log('[Attester] Stopped');
}

export function getAttesterStatus() {
  // Clean up old suspects (expired jobs won't come back — 3 hour TTL)
  const suspectTtl = 3 * 60 * 60 * 1000;
  for (const [jobId, info] of suspectJobs) {
    if (Date.now() - info.failedAt > suspectTtl) suspectJobs.delete(jobId);
  }

  return {
    running: _running,
    pollIntervalMs: POLL_INTERVAL,
    totalAttestations: _attestCount,
    sessionAttestedJobs: attestedJobIds.size,
    suspectJobs: suspectJobs.size,
  };
}
