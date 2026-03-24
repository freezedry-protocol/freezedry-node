/**
 * config.js — Unified constants for Freeze Dry Node (reader + writer).
 *
 * Every env var has a safe default. Operators only need to set WALLET_KEYPAIR
 * and HELIUS_API_KEY to start inscribing. Everything else is tuning.
 *
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │                      QUICK REFERENCE — RPC Tier Presets                    │
 * ├────────────────────┬──────┬───────────────┬─────────┬─────────────────────┤
 * │ Tier               │ RPS  │ sendTx/sec    │ WORKERS │ ~TPS (single file)  │
 * ├────────────────────┼──────┼───────────────┼─────────┼─────────────────────┤
 * │ Helius Dev $49     │   50 │ 5/sec         │ 1       │ ~5 TPS              │
 * │ Helius Biz $499    │  200 │ 50/sec        │ 3       │ ~47 TPS             │
 * │ Helius Pro $999    │  500 │ 100/sec       │ 6       │ ~94 TPS             │
 * │ Validator (own RPC)│ 5000 │ unlimited     │ 30      │ ~470 TPS            │
 * └────────────────────┴──────┴───────────────┴─────────┴─────────────────────┘
 * KEY INSIGHT: sendTransaction has a SEPARATE rate limit from general RPC.
 * Dev plan: 50 RPS general but only 5 sendTx/sec. This is the TPS ceiling.
 * Pro plan ($999): 100 sendTx/sec = our target upgrade for production speed.
 *
 * DUAL-RPC: Add SEND_RPC_URL_2 (up to _5) for extra sendTransaction keys.
 * writer/rpc.js round-robins sends across all URLs in buildSendPool().
 * HELIUS_RPC_URL_2 only affects rpc-pool.js (claimer/indexer reads).
 * Two Dev keys = 10 sendTx/sec budget → c=10 is safe.
 *
 * Workers parallelize chunk ranges within a single file.
 * Focus mode: all RPS goes to one job at a time (serial FIFO).
 */

// Trim env vars — trailing \n common with copy-paste
export const env = (key) => (process.env[key] || '').trim();

// Safe parseInt/parseFloat — returns defaultVal if env var is missing, empty, or garbage
function safeInt(envVal, defaultVal) {
  const v = parseInt(envVal, 10);
  return isNaN(v) ? defaultVal : v;
}
function safeFloat(envVal, defaultVal) {
  const v = parseFloat(envVal);
  return isNaN(v) ? defaultVal : v;
}

// ── Solana memo constants ───────────────────────────────────────────────
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const MEMO_CHUNK_SIZE = 600;
export const V3_HEADER_SIZE = 15;
export const MEMO_PAYLOAD_SIZE = MEMO_CHUNK_SIZE - V3_HEADER_SIZE; // 585B

// ── Transaction settings ────────────────────────────────────────────────
export const TX_BASE_FEE = 5_000;

// SEND_CONCURRENCY: TXs sent in parallel per worker per batch.
// Default 10: dual-RPC config (2026-03-24) — two Dev keys via SEND_RPC_URL round-robin,
// each key sees ~5 sends/sec. Single-key operators: set to 8 (proven 4.83 TPS, 99% clean).
// Helius Dev sendTx limit = 5/sec PER KEY. c=10 with 2 keys = ~5/key.
export const SEND_CONCURRENCY = safeInt(process.env.SEND_CONCURRENCY, 10);

// BATCH_DELAY_MS: Pause between batches. Controls RPS per worker.
// Default 200ms: empirically tested (2026-03-18) — best balance of speed vs clean sends.
// 400ms was previous default (too conservative). 50ms causes heavy 429s on Helius Dev.
export const BATCH_DELAY_MS = safeInt(process.env.BATCH_DELAY_MS, 200);

// ── Confirm-per-batch settings ──────────────────────────────────────────
export const CONFIRM_WAIT_MS = safeInt(process.env.CONFIRM_WAIT_MS, 2500);
export const CONFIRM_RETRIES = 5;      // re-send attempts per chunk (5 × 2s = 10s window)
export const CONFIRM_RETRY_WAIT = 2000; // wait between re-checks

// ── Pipeline optimization settings ──────────────────────────────────────

// FEE_REFRESH_MS: How often to refresh the priority fee estimate.
// Long jobs (José 15.6MB = 30 min) need fresh fees to avoid TX drops.
export const FEE_REFRESH_MS = safeInt(process.env.FEE_REFRESH_MS, 60000);

// MULTI_JOB_CONCURRENCY: Override per-job send concurrency.
// Default 12 = full speed per job. Was auto-throttling (5-7) before — fixed.
// Only relevant if CAPACITY > 1 (multiple concurrent jobs, legacy mode).
export const MULTI_JOB_CONCURRENCY = safeInt(process.env.MULTI_JOB_CONCURRENCY, 12);

// ── Worker parallelism (NEW) ────────────────────────────────────────────
// WORKERS: How many parallel chunk-range workers to use on a single file.
// Each worker inscribes a different range of chunks simultaneously.
// "auto" (default) = scale based on file size + RPS budget:
//   - < 500 chunks (~300KB):  1 worker (done in <30s, not worth splitting)
//   - 500-2000 chunks:        min(3, RPS_BUDGET) workers
//   - 2000+ chunks:           min(MAX_WORKERS, RPS_BUDGET) workers
//   - RPS_BUDGET = floor(RPS_LIMIT / 20) — each worker uses ~20 RPS (sends + confirms + overhead)
// Set to a number to override: WORKERS=1 (single pipeline, legacy behavior)
//
// ┌──────────────┬─────────┬───────────────────────────────────────────┐
// │ Helius Tier  │ WORKERS │ Effect                                    │
// ├──────────────┼─────────┼───────────────────────────────────────────┤
// │ Dev $49      │ auto→2  │ ~31 TPS, no 429s, clean runs             │
// │ Business $499│ auto→10 │ ~125 TPS, DeGods in 18s, José in 3.7 min │
// │ Pro $999     │ auto→25 │ ~310 TPS, DeGods in 7s, José in 90s      │
// └──────────────┴─────────┴───────────────────────────────────────────┘
export const WORKERS = process.env.WORKERS || '1';
export const MAX_WORKERS = safeInt(process.env.MAX_WORKERS, 30);

// RPS_LIMIT: Your RPC tier's rate limit. Used by auto-workers to calculate
// how many workers fit without exceeding your plan.
// Dev=50, Business=200, Pro=500. Set this to match your Helius tier.
export const RPS_LIMIT = safeInt(process.env.RPS_LIMIT, 50);

// MIN_CHUNKS_PER_WORKER: Don't split files into ranges smaller than this.
// Below this threshold, coordination overhead > time savings.
export const MIN_CHUNKS_PER_WORKER = safeInt(process.env.MIN_CHUNKS_PER_WORKER, 500);

// ── WebSocket confirms ──────────────────────────────────────────────────
// DEFAULT ON. 15.7 TPS proven (4.6x over polling). 0 credits. 100% success.
// Auto-derives WS URL from HELIUS_API_KEY. Set USE_WEBSOCKET=false to opt out.
export const USE_WEBSOCKET = (process.env.USE_WEBSOCKET || 'true').toLowerCase() === 'true';
export const WS_CONFIRM_TIMEOUT_MS = safeInt(process.env.WS_CONFIRM_TIMEOUT_MS, 10000);

// ── Jito bundle settings ────────────────────────────────────────────────
// Opt-in. Saves credits (sends bypass Helius) and guarantees block landing.
export const JITO_ENABLED = (process.env.JITO_ENABLED || 'false').toLowerCase() === 'true';
export const JITO_TIP_LAMPORTS = safeInt(process.env.JITO_TIP_LAMPORTS, 10000); // 0.00001 SOL
export const JITO_BLOCK_ENGINE_URL = env('JITO_BLOCK_ENGINE_URL') || 'https://slc.mainnet.block-engine.jito.wtf';
export const JITO_BUNDLE_SIZE = 5; // max TXs per bundle

// ── Direct inscription settings ──────────────────────────────────────
// INSCRIPTION_MODE: "direct" | "marketplace" | "hybrid" (default)
//   direct     — only accept /inscribe/direct (SOL transfer, no Jobs program)
//   marketplace — only accept /inscribe (existing API_KEY path, marketplace claims)
//   hybrid     — accept both; frontend auto-routes based on capacity
export let INSCRIPTION_MODE = (env('INSCRIPTION_MODE') || 'hybrid').toLowerCase();

// USD-denominated pricing for direct inscription (converted to lamports at quote time)
export const DIRECT_PRICE_PER_MB_USD = safeFloat(process.env.DIRECT_PRICE_PER_MB_USD, 0.50); // $0.50/MB
export const DIRECT_MIN_PRICE_USD = safeFloat(process.env.DIRECT_MIN_PRICE_USD, 1.0);        // $1 floor

// Operator wallet that receives direct payments (defaults to node wallet at runtime)
export const DIRECT_PAYMENT_WALLET = env('DIRECT_PAYMENT_WALLET') || '';

// Coordinator URL for job-callback on completion (Vercel frontend)
export const COORDINATOR_URL = env('COORDINATOR_URL') || 'https://freezedry.art';


// ── SOL price feed (CoinGecko, 5min cache) ──────────────────────────────
let _solPriceCache = { price: 0, ts: 0 };
const SOL_PRICE_CACHE_MS = 5 * 60 * 1000; // 5 minutes
const SOL_PRICE_FALLBACK = 80; // conservative fallback if API is down

export async function fetchSolPrice() {
  if (_solPriceCache.price > 0 && Date.now() - _solPriceCache.ts < SOL_PRICE_CACHE_MS) {
    return _solPriceCache.price;
  }
  try {
    const resp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    if (!resp.ok) throw new Error(`CoinGecko HTTP ${resp.status}`);
    const data = await resp.json();
    const price = data?.solana?.usd;
    if (typeof price === 'number' && price > 1 && price < 10000) {
      _solPriceCache = { price, ts: Date.now() };
      return price;
    }
    console.warn('[config] SOL price out of range:', price);
  } catch (err) {
    console.warn('[config] SOL price fetch failed:', err.message);
  }
  // Return cached if available, otherwise fallback
  return _solPriceCache.price > 0 ? _solPriceCache.price : SOL_PRICE_FALLBACK;
}

/** Convert USD to lamports at current SOL price */
export function usdToLamports(usd, solPrice) {
  return Math.ceil((usd / solPrice) * 1e9);
}

/** Runtime mode switch (no restart required). */
export function setInscriptionMode(mode) {
  const valid = ['direct', 'marketplace', 'hybrid'];
  if (!valid.includes(mode)) throw new Error(`Invalid mode: ${mode}. Must be: ${valid.join(', ')}`);
  INSCRIPTION_MODE = mode;
}

// ── Blob size limits ────────────────────────────────────────────────────
// Two separate limits: direct (user pre-pays) vs marketplace (node fronts TX fees).
// Set in .env per node. bodyLimit derives from the larger of the two.
//
// Direct: user's SOL is in hot wallet before inscription starts. Safe to go big.
// Marketplace: node pays TX fees upfront, gets reimbursed via release_payment. Needs working capital.
//
// Presets by tier:
//   Free/Public:  MAX_DIRECT_BLOB_MB=5   MAX_MARKETPLACE_BLOB_MB=5
//   Dev $49:      MAX_DIRECT_BLOB_MB=15  MAX_MARKETPLACE_BLOB_MB=5
//   Biz $499:     MAX_DIRECT_BLOB_MB=50  MAX_MARKETPLACE_BLOB_MB=20
//   Pro $999:     MAX_DIRECT_BLOB_MB=100 MAX_MARKETPLACE_BLOB_MB=50
export const MAX_DIRECT_BLOB_MB = safeInt(process.env.MAX_DIRECT_BLOB_MB, safeInt(process.env.MAX_BLOB_MB, 15));
export const MAX_MARKETPLACE_BLOB_MB = safeInt(process.env.MAX_MARKETPLACE_BLOB_MB, safeInt(process.env.MAX_BLOB_MB, 5));
export const MAX_DIRECT_BLOB_BYTES = MAX_DIRECT_BLOB_MB * 1024 * 1024;
export const MAX_MARKETPLACE_BLOB_BYTES = MAX_MARKETPLACE_BLOB_MB * 1024 * 1024;
// Legacy alias — largest of the two, used by bodyLimit and upload endpoint
export const MAX_BLOB_BYTES = Math.max(MAX_DIRECT_BLOB_BYTES, MAX_MARKETPLACE_BLOB_BYTES);
export const MAX_BLOB_MB = Math.max(MAX_DIRECT_BLOB_MB, MAX_MARKETPLACE_BLOB_MB);
export const BODY_LIMIT_BYTES = Math.ceil(MAX_BLOB_BYTES * 1.4); // base64 encoding + JSON overhead

// ── Writer settings ─────────────────────────────────────────────────────
export const PROGRESS_SAVE_INTERVAL = 150; // save progress every N chunks
// Hard kill timer — safety net, not a throttle. Set high to never lose a paid job.
// 15MB @ ~9.5 TPS = ~47 min, 50MB @ ~9.5 TPS = ~155 min. Default 4 hours covers all tiers.
export const MAX_JOB_RUNTIME_MS = safeInt(process.env.MAX_JOB_RUNTIME_MS, 4 * 60 * 60 * 1000);

// ── Quote / cost settings ───────────────────────────────────────────────
// 5000 = on-chain baseTxFeeLamports in Jobs Config PDA (v3 — actual Solana TX cost)
export const BASE_CHUNK_COST_LAMPORTS = safeInt(process.env.BASE_CHUNK_COST_LAMPORTS, 5000);
// Frontend sends 7500/chunk. Margin = 2500/chunk, split 40/10/30/20 (writer/attester/treasury/referrer)
export const PARTNER_MARGIN_MULTIPLIER = safeFloat(process.env.PARTNER_MARGIN_MULTIPLIER, 1.5);

// ── Startup config log — print resolved values so operators can verify ────
console.log('[Config] Resolved:', JSON.stringify({
  SEND_CONCURRENCY, BATCH_DELAY_MS, CONFIRM_WAIT_MS, FEE_REFRESH_MS,
  MULTI_JOB_CONCURRENCY, WORKERS, MAX_WORKERS, RPS_LIMIT, MIN_CHUNKS_PER_WORKER,
  USE_WEBSOCKET, WS_CONFIRM_TIMEOUT_MS, JITO_ENABLED, JITO_TIP_LAMPORTS,
  INSCRIPTION_MODE, DIRECT_PRICE_PER_MB_USD, DIRECT_MIN_PRICE_USD,
  BASE_CHUNK_COST_LAMPORTS, PARTNER_MARGIN_MULTIPLIER,
  MAX_DIRECT_BLOB_MB, MAX_MARKETPLACE_BLOB_MB, BODY_LIMIT_BYTES, MAX_JOB_RUNTIME_MS,
}));
