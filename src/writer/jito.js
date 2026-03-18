/**
 * writer/jito.js — Jito bundle support for Freeze Dry inscription.
 * Groups up to 5 TXs into one Jito bundle with a tip for guaranteed block inclusion.
 * Eliminates TX drops and retry overhead = 5x throughput multiplier.
 *
 * Requires: JITO_ENABLED=true in env
 * Cost: JITO_TIP_LAMPORTS per bundle (default 10,000 = 0.00001 SOL)
 */

import {
  Transaction, TransactionInstruction, PublicKey, ComputeBudgetProgram,
  SystemProgram,
} from '@solana/web3.js';
import { JITO_BLOCK_ENGINE_URL, JITO_TIP_LAMPORTS } from '../config.js';

// Base58 encoder (no extra dependency — alphabet matches Bitcoin/Solana)
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Encode(buffer) {
  const bytes = [...buffer];
  let result = '';
  let num = 0n;
  for (const byte of bytes) num = num * 256n + BigInt(byte);
  while (num > 0n) { result = BASE58_ALPHABET[Number(num % 58n)] + result; num /= 58n; }
  for (const byte of bytes) { if (byte === 0) result = '1' + result; else break; }
  return result;
}

/**
 * Extract the base58 TX signature from a signed web3.js Transaction.
 */
export function getTxSignature(tx) {
  const sigBuf = tx.signatures[0]?.signature || tx.signature;
  if (!sigBuf) throw new Error('Transaction not signed');
  return base58Encode(Buffer.from(sigBuf));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Rate limiter — Jito free tier allows ~2 bundles/sec, back off on 429
let _lastBundleSentAt = 0;
let _throttleMs = 600; // start at 600ms, grows on 429
async function throttle() {
  const elapsed = Date.now() - _lastBundleSentAt;
  if (elapsed < _throttleMs) await sleep(_throttleMs - elapsed);
  _lastBundleSentAt = Date.now();
}
function throttleBackoff() { _throttleMs = Math.min(_throttleMs * 2, 10000); }
function throttleReset() { _throttleMs = 600; }

// Jito tip addresses — rotate per bundle to distribute load
// Source: https://jito-foundation.gitbook.io/mev/mev-payment-and-distribution/on-chain-addresses
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];
let tipIndex = 0;

function getNextTipAccount() {
  return new PublicKey(JITO_TIP_ACCOUNTS[tipIndex++ % JITO_TIP_ACCOUNTS.length]);
}

/**
 * Add a Jito tip instruction to a transaction.
 * Transfers JITO_TIP_LAMPORTS to a rotating tip account.
 */
export function addTipInstruction(tx, payerKey) {
  tx.add(SystemProgram.transfer({
    fromPubkey: payerKey,
    toPubkey: getNextTipAccount(),
    lamports: JITO_TIP_LAMPORTS,
  }));
  return tx;
}

/**
 * Send a bundle of serialized transactions to Jito block engine.
 * Returns bundle ID on success.
 * Throws on rejection (caller should fall back to standard send).
 *
 * @param {string[]} serializedTxs - array of base58-encoded serialized transactions
 * @returns {string} bundleId
 */
export async function sendBundle(serializedTxs) {
  const url = `${JITO_BLOCK_ENGINE_URL}/api/v1/bundles`;
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    await throttle();

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendBundle',
        params: [serializedTxs, { encoding: 'base64' }],
      }),
    });

    if (resp.status === 429) {
      throttleBackoff();
      const wait = _throttleMs * (attempt + 1);
      console.warn(`[Jito] 429 rate limited — backing off ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(wait);
      continue;
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Jito sendBundle: HTTP ${resp.status} — ${text.slice(0, 200)}`);
    }

    const data = await resp.json();
    if (data.error) {
      // Rate limit errors come as JSON too (code -32097)
      if (data.error.code === -32097) {
        throttleBackoff();
        const wait = _throttleMs * (attempt + 1);
        console.warn(`[Jito] Rate limited (-32097) — backing off ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(wait);
        continue;
      }
      throw new Error(`Jito sendBundle: ${JSON.stringify(data.error).slice(0, 200)}`);
    }

    throttleReset(); // success — reset backoff
    return data.result; // bundle ID
  }

  throw new Error('Jito sendBundle: rate limited after retries');
}

/**
 * Check the status of a Jito bundle.
 * @param {string} bundleId
 * @returns {object} status result
 */
export async function getBundleStatus(bundleId) {
  const url = `${JITO_BLOCK_ENGINE_URL}/api/v1/bundles`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getBundleStatuses',
      params: [[bundleId]],
    }),
  });

  if (!resp.ok) return null;
  const data = await resp.json();
  return data.result?.value?.[0] || null;
}

/**
 * Send a bundle and wait for it to land (or fail).
 * Returns { landed: true, signatures } or { landed: false, error }.
 *
 * @param {string[]} serializedTxs - base58-encoded serialized transactions
 * @param {number} [timeoutMs=15000] - how long to wait for landing
 */
export async function sendBundleAndConfirm(serializedTxs, timeoutMs = 15000) {
  let bundleId;
  try {
    bundleId = await sendBundle(serializedTxs);
  } catch (err) {
    return { landed: false, error: err.message };
  }

  // Poll for bundle status
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(2000);
    try {
      const status = await getBundleStatus(bundleId);
      if (!status) continue;

      // Jito statuses: Invalid, Failed, Landed
      if (status.confirmation_status === 'confirmed' || status.confirmation_status === 'finalized') {
        return { landed: true, bundleId, transactions: status.transactions || [] };
      }
      // Bundle was processed but the status tells us something
      if (status.err) {
        return { landed: false, error: `Bundle error: ${JSON.stringify(status.err)}`, bundleId };
      }
    } catch (err) {
      console.warn('[Jito] Bundle status check failed:', err.message);
    }
  }

  return { landed: false, error: 'Bundle status timeout', bundleId };
}
