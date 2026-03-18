/**
 * wallet.js — Keypair loader for Freeze Dry Node.
 *
 * Two-wallet system:
 *   Identity key  — node registration, peer auth, reputation. Never needs SOL.
 *   Hot wallet    — signs memo TXs, pays fees, receives escrow earnings.
 *
 * Env vars (priority order):
 *   IDENTITY_KEYPAIR     → identity key (peer auth, registration)
 *   HOT_WALLET_KEYPAIR   → hot wallet (TX signing, escrow)
 *   WALLET_KEYPAIR       → legacy fallback (used for both if above not set)
 *   VOUCHER_WALLET_KEYPAIR → isolated wallet for voucher TX fees
 *
 * Backward compatible: if only WALLET_KEYPAIR is set, both getIdentityKeypair()
 * and getHotWallet() return the same keypair. Zero behavior change for existing nodes.
 */

import { Keypair } from '@solana/web3.js';
import { env } from './config.js';

let _identityKeypair = null;
let _hotWallet = null;
let _voucherKeypair = null;

/**
 * Get the identity keypair for peer auth and node registration.
 * Falls back to WALLET_KEYPAIR for backward compatibility.
 * @returns {Keypair}
 */
export function getIdentityKeypair() {
  if (_identityKeypair) return _identityKeypair;
  const raw = env('IDENTITY_KEYPAIR') || env('WALLET_KEYPAIR');
  if (!raw) throw new Error('IDENTITY_KEYPAIR or WALLET_KEYPAIR env var required');
  _identityKeypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(raw)));
  return _identityKeypair;
}

/**
 * Get the hot wallet keypair for on-chain TX signing (memos, claims, receipts).
 * Falls back to WALLET_KEYPAIR for backward compatibility.
 * @returns {Keypair}
 */
export function getHotWallet() {
  if (_hotWallet) return _hotWallet;
  const raw = env('HOT_WALLET_KEYPAIR') || env('WALLET_KEYPAIR');
  if (!raw) throw new Error('HOT_WALLET_KEYPAIR or WALLET_KEYPAIR env var required');
  _hotWallet = Keypair.fromSecretKey(new Uint8Array(JSON.parse(raw)));
  return _hotWallet;
}

/**
 * Legacy alias — returns hot wallet.
 * All existing callers (claimer, inscribe, pointer) use this for TX signing.
 * @returns {Keypair}
 */
export function getServerKeypair() {
  return getHotWallet();
}

/**
 * Get the voucher wallet keypair. Falls back to hot wallet if not set.
 * Set VOUCHER_WALLET_KEYPAIR in .env to isolate voucher TX fee spending.
 * @returns {Keypair}
 */
export function getVoucherKeypair() {
  if (_voucherKeypair) return _voucherKeypair;
  const raw = env('VOUCHER_WALLET_KEYPAIR');
  if (!raw) return getHotWallet(); // fallback
  _voucherKeypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(raw)));
  return _voucherKeypair;
}
