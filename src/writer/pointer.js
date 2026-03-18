/**
 * writer/pointer.js — Send FREEZEDRY pointer memo to finalize inscription.
 * Extracted from worker/src/completion.js (lines 271-320).
 *
 * v2: Pointer memo sent TO the Config PDA so it appears in Config PDA TX history.
 * This makes all inscriptions discoverable by scanning a single on-chain address.
 * Historical pointers on authority wallet (BbEy...) remain permanent and valid.
 */

import {
  Transaction, TransactionInstruction, PublicKey, ComputeBudgetProgram,
} from '@solana/web3.js';
import { MEMO_PROGRAM_ID, MEMO_CHUNK_SIZE } from '../config.js';
import { getServerKeypair } from '../wallet.js';
import { rpcCall, sendWithRetry, fetchPriorityFee } from './rpc.js';
import { deriveConfigPDA } from '../chain/tx-builder.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Send FREEZEDRY:3: pointer memo.
 * Returns the confirmed pointer signature, or null if TX failed on-chain.
 */
export async function sendPointerMemo(job, keypairOverride) {
  const serverKeypair = keypairOverride || getServerKeypair();
  const payerKey = serverKeypair.publicKey;
  const memoProgramId = new PublicKey(MEMO_PROGRAM_ID);
  const microLamports = await fetchPriorityFee();

  const encFlag = 'o';
  const contentFlag = job.contentType === 'text/html' ? 'H' : 'I';
  const manifestFlag = 'c';
  const flags = `${encFlag}${contentFlag}${manifestFlag}`;
  const inscriber = serverKeypair.publicKey.toBase58().substring(0, 8);
  const lastChunkSig = job.signatures[job.signatures.length - 1] || '';
  const configPDA = deriveConfigPDA()[0].toBase58();
  const pointerData = `FREEZEDRY:3:${job.manifestHash}:${job.chunkCount}:${job.blobSize}:${MEMO_CHUNK_SIZE}:${flags}:${inscriber}:${lastChunkSig}:${configPDA}`;

  const blockhash = (await rpcCall('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: payerKey })
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 }))
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }))
    .add(new TransactionInstruction({
      keys: [
        { pubkey: payerKey, isSigner: true, isWritable: false },
      ],
      programId: memoProgramId,
      data: Buffer.from(pointerData),
    }));
  tx.sign(serverKeypair);
  const rawSig = await sendWithRetry(tx.serialize().toString('base64'));

  // Confirm pointer TX landed on-chain before returning
  // 15 checks × 3s = 45s max wait — mainnet can be slow under congestion
  let pointerSig = null;
  for (let i = 0; i < 15; i++) {
    try {
      const statuses = await rpcCall('getSignatureStatuses', [[rawSig]]);
      const s = statuses?.value?.[0];
      if (s) {
        if (s.err) { console.warn(`[Pointer] TX failed on-chain: ${rawSig.slice(0, 16)}... err=${JSON.stringify(s.err)}`); break; }
        if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') { pointerSig = rawSig; break; }
      }
    } catch (err) { console.warn('[Pointer] status check failed:', err.message); }
    await sleep(3000);
  }

  console.log(`[Pointer] ${pointerData} -> ${pointerSig || 'FAILED (' + rawSig.slice(0, 16) + '...)'}`);
  return pointerSig;
}
