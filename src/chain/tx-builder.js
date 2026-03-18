/**
 * chain/tx-builder.js — Build freezedry_jobs program instructions without Anchor.
 *
 * Handles PDA derivation, Borsh serialization, and instruction construction
 * for claim_job, submit_receipt, and attest instructions.
 *
 * Also includes account parsers (ported from packages/jobs/src/client.ts)
 * so nodes can read job/config state directly from chain.
 */

import {
  PublicKey, TransactionInstruction, Transaction,
  ComputeBudgetProgram, SystemProgram,
} from '@solana/web3.js';
import { env } from '../config.js';

// ── Program IDs ──────────────────────────────────────────────────────────────

export const JOBS_PROGRAM_ID = new PublicKey(
  env('JOBS_PROGRAM_ID') || 'AmqBYKYCqpmKoFcgvripCQ3bJC2d8ygWWhcoHtmTvvzx'
);

export const REGISTRY_PROGRAM_ID = new PublicKey(
  env('REGISTRY_PROGRAM_ID') || '6UGJUc28AuCj8a8sjhsVEKbvYHfQECCuJC7i54vk2to'
);

// ── Instruction discriminators (from freezedry_jobs IDL) ─────────────────────

export const IX_CLAIM_JOB        = Buffer.from([9, 160, 5, 231, 116, 123, 198, 14]);
export const IX_SUBMIT_RECEIPT   = Buffer.from([172, 84, 119, 35, 195, 154, 214, 176]);
export const IX_ATTEST           = Buffer.from([83, 148, 120, 119, 144, 139, 117, 160]);
export const IX_CREATE_JOB       = Buffer.from([178, 130, 217, 110, 100, 27, 82, 119]);
export const IX_RELEASE_PAYMENT  = Buffer.from([24, 34, 191, 86, 145, 160, 183, 233]);
export const IX_REFUND_EXPIRED   = Buffer.from([118, 153, 164, 244, 40, 128, 242, 250]);
export const IX_REQUEUE_EXPIRED  = Buffer.from([42, 190, 164, 78, 187, 138, 75, 211]);
export const IX_CLOSE_COMPLETED_JOB = Buffer.from([163, 169, 120, 22, 232, 120, 82, 247]);
export const IX_CLOSE_ATTESTATION   = Buffer.from([249, 84, 133, 23, 48, 175, 252, 221]);

// ── Account discriminators ───────────────────────────────────────────────────

export const CONFIG_DISC = Buffer.from([155, 12, 170, 224, 30, 250, 204, 130]);
export const JOB_DISC    = Buffer.from([91, 16, 162, 5, 45, 210, 125, 65]);
export const ATTEST_DISC = Buffer.from([231, 126, 92, 51, 84, 178, 81, 242]);
export const NODE_DISC   = Buffer.from([125, 166, 18, 146, 195, 127, 86, 220]);

// ── Registry account discriminators ──────────────────────────────────────────

export const REGISTRY_CONFIG_DISC = Buffer.from([23, 118, 10, 246, 173, 231, 243, 156]);

// ── PDA seeds ────────────────────────────────────────────────────────────────

const SEED_CONFIG       = Buffer.from('fd-config');
const SEED_JOB          = Buffer.from('fd-job');
const SEED_ATTEST       = Buffer.from('fd-attest');
const SEED_NODE         = Buffer.from('freeze-node');
const SEED_REG_CONFIG   = Buffer.from('fd-registry-config');

export function deriveConfigPDA(programId = JOBS_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([SEED_CONFIG], programId);
}

export function deriveJobPDA(jobId, programId = JOBS_PROGRAM_ID) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(jobId));
  return PublicKey.findProgramAddressSync([SEED_JOB, buf], programId);
}

export function deriveAttestationPDA(jobId, reader, programId = JOBS_PROGRAM_ID) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(jobId));
  return PublicKey.findProgramAddressSync([SEED_ATTEST, buf, reader.toBuffer()], programId);
}

export function deriveNodePDA(owner, programId = REGISTRY_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([SEED_NODE, owner.toBuffer()], programId);
}

export function deriveRegistryConfigPDA(programId = REGISTRY_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([SEED_REG_CONFIG], programId);
}

// ── Status enum ──────────────────────────────────────────────────────────────

export const JOB_STATUSES = ['open', 'claimed', 'submitted', 'completed', 'cancelled', 'expired', 'disputed'];

// ── Account parsers ──────────────────────────────────────────────────────────

export function parseJobAccount(pubkey, data) {
  if (data.length < 8 + 8 + 32) return null;
  if (!data.subarray(0, 8).equals(JOB_DISC)) return null;

  let o = 8;
  const jobId = Number(data.readBigUInt64LE(o)); o += 8;
  const creator = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const writer = new PublicKey(data.subarray(o, o + 32)); o += 32;

  const hashLen = data.readUInt32LE(o); o += 4;
  if (hashLen > 256 || o + hashLen > data.length) return null;
  const contentHash = data.subarray(o, o + hashLen).toString('utf8'); o += hashLen;

  const chunkCount = data.readUInt32LE(o); o += 4;
  const escrowLamports = Number(data.readBigUInt64LE(o)); o += 8;
  const statusVal = data[o]; o += 1;
  const status = JOB_STATUSES[statusVal] || 'open';

  const createdAt = Number(data.readBigInt64LE(o)); o += 8;
  const claimedAt = Number(data.readBigInt64LE(o)); o += 8;
  const submittedAt = Number(data.readBigInt64LE(o)); o += 8;
  const completedAt = Number(data.readBigInt64LE(o)); o += 8;

  const attestationCount = data[o]; o += 1;

  const sigLen = data.readUInt32LE(o); o += 4;
  if (sigLen > 256 || o + sigLen > data.length) return null;
  const pointerSig = data.subarray(o, o + sigLen).toString('utf8'); o += sigLen;

  const bump = data[o]; o += 1;

  const referrer = new PublicKey(data.subarray(o, o + 32)); o += 32;

  // v3 fields
  const assignedNode = (o + 32 <= data.length) ? new PublicKey(data.subarray(o, o + 32)) : null;
  if (assignedNode) o += 32;
  const exclusiveUntil = (o + 8 <= data.length) ? Number(data.readBigInt64LE(o)) : 0;
  if (o + 8 <= data.length) o += 8;

  // v4 field: blob_source (String, max 200 chars — URL where claimer fetches blob)
  let blobSource = '';
  if (o + 4 <= data.length) {
    const bsLen = data.readUInt32LE(o); o += 4;
    if (bsLen > 0 && bsLen <= 200 && o + bsLen <= data.length) {
      blobSource = data.subarray(o, o + bsLen).toString('utf8');
      o += bsLen;
    }
  }

  // v6 fields: tx_reimbursement_lamports (u64) + snap fee BPS (4× u16)
  const txReimbursementLamports = (o + 8 <= data.length) ? Number(data.readBigUInt64LE(o)) : 0;
  if (o + 8 <= data.length) o += 8;
  const snapInscriberBps = (o + 2 <= data.length) ? data.readUInt16LE(o) : 0;
  if (o + 2 <= data.length) o += 2;
  const snapIndexerBps = (o + 2 <= data.length) ? data.readUInt16LE(o) : 0;
  if (o + 2 <= data.length) o += 2;
  const snapTreasuryBps = (o + 2 <= data.length) ? data.readUInt16LE(o) : 0;
  if (o + 2 <= data.length) o += 2;
  const snapReferralBps = (o + 2 <= data.length) ? data.readUInt16LE(o) : 0;

  return {
    address: pubkey, jobId, creator, writer,
    contentHash, chunkCount, escrowLamports, status,
    createdAt, claimedAt, submittedAt, completedAt,
    attestationCount, pointerSig, bump, referrer,
    assignedNode, exclusiveUntil, blobSource,
    txReimbursementLamports, snapInscriberBps, snapIndexerBps,
    snapTreasuryBps, snapReferralBps,
  };
}

export function parseConfigAccount(pubkey, data) {
  if (data.length < 8 + 32) return null;
  if (!data.subarray(0, 8).equals(CONFIG_DISC)) return null;

  let o = 8;
  const authority = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const treasury = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const registryProgram = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const inscriberFeeBps = data.readUInt16LE(o); o += 2;
  const indexerFeeBps = data.readUInt16LE(o); o += 2;
  const treasuryFeeBps = data.readUInt16LE(o); o += 2;
  const referralFeeBps = data.readUInt16LE(o); o += 2;
  const minAttestations = data[o]; o += 1;
  const jobExpirySeconds = Number(data.readBigInt64LE(o)); o += 8;
  const totalJobsCreated = Number(data.readBigUInt64LE(o)); o += 8;
  const totalJobsCompleted = Number(data.readBigUInt64LE(o)); o += 8;
  const bump = data[o]; o += 1;

  // v3 fields
  const minEscrowLamports = (o + 8 <= data.length) ? Number(data.readBigUInt64LE(o)) : 0; o += 8;
  const defaultExclusiveWindow = (o + 4 <= data.length) ? data.readUInt32LE(o) : 0; o += 4;
  const maxExclusiveWindow = (o + 4 <= data.length) ? data.readUInt32LE(o) : 0; o += 4;

  // v6 field
  const baseTxFeeLamports = (o + 8 <= data.length) ? Number(data.readBigUInt64LE(o)) : 0;

  return {
    address: pubkey, authority, treasury, registryProgram,
    inscriberFeeBps, indexerFeeBps, treasuryFeeBps, referralFeeBps,
    minAttestations, jobExpirySeconds,
    totalJobsCreated, totalJobsCompleted, bump,
    minEscrowLamports, defaultExclusiveWindow, maxExclusiveWindow,
    baseTxFeeLamports,
  };
}

// ── Registry account parsers ─────────────────────────────────────────────────

/**
 * Parse a NodeAccount PDA from the registry program.
 * Layout: 8 disc + 32 wallet + (4+nodeId) + (4+url) + 1 role
 *         + 8 registeredAt + 8 lastHeartbeat + 1 isActive
 *         + 8 artworksIndexed + 8 artworksComplete + 1 bump
 *         + 8 verifiedStake + 32 stakeVoter + 8 stakeVerifiedAt + 16 reserved2
 */
export function parseNodeAccount(pubkey, data) {
  if (data.length < 8 + 32) return null;
  if (!data.subarray(0, 8).equals(NODE_DISC)) return null;

  let o = 8;
  const wallet = new PublicKey(data.subarray(o, o + 32)); o += 32;

  const nodeIdLen = data.readUInt32LE(o); o += 4;
  if (nodeIdLen > 64 || o + nodeIdLen > data.length) return null;
  const nodeId = data.subarray(o, o + nodeIdLen).toString('utf8'); o += nodeIdLen;

  const urlLen = data.readUInt32LE(o); o += 4;
  if (urlLen > 256 || o + urlLen > data.length) return null;
  const url = data.subarray(o, o + urlLen).toString('utf8'); o += urlLen;

  const ROLE_MAP = ['reader', 'writer', 'both'];
  const role = ROLE_MAP[data[o]] || 'reader'; o += 1;

  const registeredAt = Number(data.readBigInt64LE(o)); o += 8;
  const lastHeartbeat = Number(data.readBigInt64LE(o)); o += 8;
  const isActive = data[o] === 1; o += 1;
  const artworksIndexed = Number(data.readBigUInt64LE(o)); o += 8;
  const artworksComplete = Number(data.readBigUInt64LE(o)); o += 8;
  const bump = data[o]; o += 1;

  // Stake verification fields (v2) — zeros = unverified
  let verifiedStake = 0;
  let stakeVoter = PublicKey.default;
  let stakeVerifiedAt = 0;

  if (o + 48 <= data.length) {
    verifiedStake = Number(data.readBigUInt64LE(o)); o += 8;
    stakeVoter = new PublicKey(data.subarray(o, o + 32)); o += 32;
    stakeVerifiedAt = Number(data.readBigInt64LE(o)); o += 8;
  }

  return {
    address: pubkey, wallet, nodeId, url, role,
    registeredAt, lastHeartbeat, isActive,
    artworksIndexed, artworksComplete, bump,
    verifiedStake, stakeVoter, stakeVerifiedAt,
  };
}

/**
 * Parse a RegistryConfig PDA from the registry program.
 * Layout: 8 disc + 32 authority + 32 preferredValidator + 1 bump + 64 reserved
 */
export function parseRegistryConfig(pubkey, data) {
  if (data.length < 8 + 32 + 32 + 1) return null;
  if (!data.subarray(0, 8).equals(REGISTRY_CONFIG_DISC)) return null;
  let o = 8;
  const authority = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const preferredValidator = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const bump = data[o];

  return { address: pubkey, authority, preferredValidator, bump };
}

// ── Registry instruction discriminators ─────────────────────────────────────
// These will be filled from IDL after the first build.
// verify_stake discriminator: sha256("global:verify_stake")[0..8]
export const IX_VERIFY_STAKE = Buffer.from([53, 180, 26, 222, 13, 252, 231, 35]);

/**
 * Build verify_stake instruction for the registry program.
 * Accounts: node (writable), stake_account, owner (signer)
 */
export function buildVerifyStakeIx(nodePDA, stakeAccountPubkey, ownerPubkey) {
  return new TransactionInstruction({
    programId: REGISTRY_PROGRAM_ID,
    keys: [
      { pubkey: nodePDA,             isSigner: false, isWritable: true },
      { pubkey: stakeAccountPubkey,  isSigner: false, isWritable: false },
      { pubkey: ownerPubkey,         isSigner: true,  isWritable: false },
    ],
    data: IX_VERIFY_STAKE,
  });
}

// ── Instruction builders ─────────────────────────────────────────────────────

/**
 * Build claim_job instruction.
 * Accounts: job (writable), config, node_account, registry_config, writer (signer, writable)
 * No args — just the discriminator.
 */
export function buildClaimJobIx(jobPDA, configPDA, nodePDA, registryConfigPDA, writerPubkey) {
  return new TransactionInstruction({
    programId: JOBS_PROGRAM_ID,
    keys: [
      { pubkey: jobPDA,              isSigner: false, isWritable: true },
      { pubkey: configPDA,           isSigner: false, isWritable: false },
      { pubkey: nodePDA,             isSigner: false, isWritable: false },
      { pubkey: registryConfigPDA,   isSigner: false, isWritable: false },
      { pubkey: writerPubkey,        isSigner: true,  isWritable: true },
    ],
    data: IX_CLAIM_JOB,
  });
}

/**
 * Build submit_receipt instruction.
 * Accounts: job (writable), writer (signer)
 * Args: pointer_sig (string: 4-byte LE len + UTF-8)
 */
export function buildSubmitReceiptIx(jobPDA, writerPubkey, pointerSig) {
  const sigBytes = Buffer.from(pointerSig, 'utf8');
  const data = Buffer.alloc(8 + 4 + sigBytes.length);
  let off = 0;
  IX_SUBMIT_RECEIPT.copy(data, off); off += 8;
  data.writeUInt32LE(sigBytes.length, off); off += 4;
  sigBytes.copy(data, off);

  return new TransactionInstruction({
    programId: JOBS_PROGRAM_ID,
    keys: [
      { pubkey: jobPDA,       isSigner: false, isWritable: true },
      { pubkey: writerPubkey, isSigner: true,  isWritable: false },
    ],
    data,
  });
}

/**
 * Build attest instruction (v6 — hash-verified).
 * Accounts: job (writable), config, attestation (writable, init), node_account, reader (signer, writable), system_program
 * Args: computed_hash (String: 4-byte LE length + UTF-8, e.g. "sha256:abcdef...")
 */
export function buildAttestIx(jobPDA, configPDA, attestPDA, nodePDA, readerPubkey, computedHash) {
  const hashBytes = Buffer.from(computedHash, 'utf8');
  const data = Buffer.alloc(8 + 4 + hashBytes.length);
  IX_ATTEST.copy(data, 0);
  data.writeUInt32LE(hashBytes.length, 8);
  hashBytes.copy(data, 12);

  return new TransactionInstruction({
    programId: JOBS_PROGRAM_ID,
    keys: [
      { pubkey: jobPDA,       isSigner: false, isWritable: true },
      { pubkey: configPDA,    isSigner: false, isWritable: false },
      { pubkey: attestPDA,    isSigner: false, isWritable: true },
      { pubkey: nodePDA,      isSigner: false, isWritable: false },
      { pubkey: readerPubkey, isSigner: true,  isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Build create_job instruction (v3).
 * Accounts: config (writable), job (writable), creator (signer, writable), system_program, referrer_account
 * Args: content_hash (string), chunk_count (u32), escrow_amount (u64), referrer (Pubkey),
 *        assigned_node (Pubkey, default=zeros for open marketplace), exclusive_window (u32, 0=use config default)
 */
export function buildCreateJobIx(configPDA, jobPDA, creatorPubkey, contentHash, chunkCount, escrowAmount, referrerPubkey, assignedNodePubkey, exclusiveWindow, treasuryPubkey, blobSource = '') {
  const hashBytes = Buffer.from(contentHash, 'utf8');
  const blobSourceBytes = Buffer.from(blobSource, 'utf8');
  // v4: 7 args — hash(str) + chunkCount(u32) + escrow(u64) + referrer(pk) + assignedNode(pk) + window(u32) + blob_source(str)
  const data = Buffer.alloc(8 + 4 + hashBytes.length + 4 + 8 + 32 + 32 + 4 + 4 + blobSourceBytes.length);
  let off = 0;
  IX_CREATE_JOB.copy(data, off); off += 8;
  // String: 4-byte LE length + UTF-8
  data.writeUInt32LE(hashBytes.length, off); off += 4;
  hashBytes.copy(data, off); off += hashBytes.length;
  // u32 chunk_count
  data.writeUInt32LE(chunkCount, off); off += 4;
  // u64 escrow_amount
  data.writeBigUInt64LE(BigInt(escrowAmount), off); off += 8;
  // Pubkey referrer (32 bytes)
  referrerPubkey.toBuffer().copy(data, off); off += 32;
  // Pubkey assigned_node (32 bytes) — default all zeros = open marketplace
  const nodeBuf = assignedNodePubkey ? assignedNodePubkey.toBuffer() : Buffer.alloc(32);
  nodeBuf.copy(data, off); off += 32;
  // u32 exclusive_window — 0 = use config default
  data.writeUInt32LE(exclusiveWindow || 0, off); off += 4;
  // String blob_source — URL where claimer fetches blob
  data.writeUInt32LE(blobSourceBytes.length, off); off += 4;
  blobSourceBytes.copy(data, off);

  // Derive referrer PDA (5th account) — placeholder when no external referrer
  const SEED_REFERRER = Buffer.from('fd-referrer');
  const isDefaultOrTreasury = referrerPubkey.equals(PublicKey.default) ||
    (treasuryPubkey && referrerPubkey.equals(treasuryPubkey));
  const referrerAccountPubkey = isDefaultOrTreasury
    ? SystemProgram.programId
    : PublicKey.findProgramAddressSync([SEED_REFERRER, referrerPubkey.toBuffer()], JOBS_PROGRAM_ID)[0];

  return new TransactionInstruction({
    programId: JOBS_PROGRAM_ID,
    keys: [
      { pubkey: configPDA,     isSigner: false, isWritable: true },
      { pubkey: jobPDA,        isSigner: false, isWritable: true },
      { pubkey: creatorPubkey, isSigner: true,  isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: referrerAccountPubkey, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Build release_payment instruction (permissionless).
 * v2: Now includes attestation PDA + attester wallet for attester fee payment.
 * Accounts: job, config, inscriber, treasury, referrer, attestation, attester, signer
 * No args — just the discriminator.
 */
export function buildReleasePaymentIx(jobPDA, configPDA, inscriberPubkey, treasuryPubkey, referrerPubkey, attestationPDA, attesterPubkey, signerPubkey) {
  return new TransactionInstruction({
    programId: JOBS_PROGRAM_ID,
    keys: [
      { pubkey: jobPDA,           isSigner: false, isWritable: true },
      { pubkey: configPDA,        isSigner: false, isWritable: true },
      { pubkey: inscriberPubkey,  isSigner: false, isWritable: true },
      { pubkey: treasuryPubkey,   isSigner: false, isWritable: true },
      { pubkey: referrerPubkey,   isSigner: false, isWritable: true },
      { pubkey: attestationPDA,   isSigner: false, isWritable: false },
      { pubkey: attesterPubkey,   isSigner: false, isWritable: true },
      { pubkey: signerPubkey,     isSigner: true,  isWritable: false },
    ],
    data: IX_RELEASE_PAYMENT,
  });
}

/**
 * Build refund_expired instruction (permissionless — ZombieSlayer).
 * Refunds escrow+rent to creator for jobs stuck as Open or Claimed past expiry.
 * Accounts: job (writable, close→creator), config, creator (writable), signer
 * No args — just the discriminator.
 */
export function buildRefundExpiredIx(jobPDA, configPDA, creatorPubkey, signerPubkey) {
  return new TransactionInstruction({
    programId: JOBS_PROGRAM_ID,
    keys: [
      { pubkey: jobPDA,         isSigner: false, isWritable: true },
      { pubkey: configPDA,      isSigner: false, isWritable: false },
      { pubkey: creatorPubkey,  isSigner: false, isWritable: true },
      { pubkey: signerPubkey,   isSigner: true,  isWritable: false },
    ],
    data: IX_REFUND_EXPIRED,
  });
}

/**
 * Build requeue_expired instruction (permissionless — ZombieSlayer).
 * Resets a stale Claimed job back to Open so another writer can pick it up.
 * Claim timeout = job_expiry_seconds / 2 (checked on-chain).
 * Accounts: job (writable), config, signer
 * No args — just the discriminator.
 */
export function buildRequeueExpiredIx(jobPDA, configPDA, signerPubkey) {
  return new TransactionInstruction({
    programId: JOBS_PROGRAM_ID,
    keys: [
      { pubkey: jobPDA,        isSigner: false, isWritable: true },
      { pubkey: configPDA,     isSigner: false, isWritable: false },
      { pubkey: signerPubkey,  isSigner: true,  isWritable: false },
    ],
    data: IX_REQUEUE_EXPIRED,
  });
}

/**
 * Build close_completed_job instruction (permissionless).
 * Closes a Completed job PDA — rent returns to creator. Any signer can call.
 * Accounts: job (writable, close→creator), creator (writable), signer
 * No args — just the discriminator.
 */
export function buildCloseCompletedJobIx(jobPDA, creatorPubkey, signerPubkey) {
  return new TransactionInstruction({
    programId: JOBS_PROGRAM_ID,
    keys: [
      { pubkey: jobPDA,         isSigner: false, isWritable: true },
      { pubkey: creatorPubkey,  isSigner: false, isWritable: true },
      { pubkey: signerPubkey,   isSigner: true,  isWritable: false },
    ],
    data: IX_CLOSE_COMPLETED_JOB,
  });
}

/**
 * Build close_attestation instruction (permissionless — v6).
 * Closes an attestation PDA for a finished job. Rent returns to reader.
 * Accounts: attestation (writable, close→reader), job, reader (writable), signer
 * Args: job_id (u64)
 */
export function buildCloseAttestationIx(attestPDA, jobPDA, readerPubkey, signerPubkey, jobId) {
  const data = Buffer.alloc(8 + 8);
  IX_CLOSE_ATTESTATION.copy(data, 0);
  data.writeBigUInt64LE(BigInt(jobId), 8);

  return new TransactionInstruction({
    programId: JOBS_PROGRAM_ID,
    keys: [
      { pubkey: attestPDA,     isSigner: false, isWritable: true },
      { pubkey: jobPDA,        isSigner: false, isWritable: false },
      { pubkey: readerPubkey,  isSigner: false, isWritable: true },
      { pubkey: signerPubkey,  isSigner: true,  isWritable: false },
    ],
    data,
  });
}

/**
 * Wrap an instruction into a signed transaction with priority fees.
 * Returns the serialized base64-encoded transaction.
 */
export function buildSignedTx(instruction, blockhash, keypair, microLamports = 10_000) {
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: keypair.publicKey })
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }))
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }))
    .add(instruction);
  tx.sign(keypair);
  return tx.serialize().toString('base64');
}
