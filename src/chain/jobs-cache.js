/**
 * chain/jobs-cache.js — Shared getProgramAccounts cache for claimer + attester.
 *
 * Both modules poll the same JOBS_PROGRAM_ID with the same discriminator filter.
 * Without this cache, two independent gPA calls cost 2 credits per poll cycle.
 * With cache: 1 credit per cycle (saves ~43,800 credits/month at 60s polling).
 *
 * TTL: 10 seconds. Both claimer and attester poll at CLAIM_POLL_INTERVAL (30-300s),
 * so the first caller fetches fresh data and the second gets it from cache.
 *
 * v7: Uses rpc-pool for dual RPC support. Falls back to next URL on error.
 */

import { env } from '../config.js';
import { buildPoolFromEnv } from '../rpc-pool.js';
import {
  JOBS_PROGRAM_ID, JOB_DISC, parseJobAccount,
} from './tx-builder.js';

let _cache = null;     // { accounts: ParsedJob[], fetchedAt: number }
const CACHE_TTL_MS = 10_000; // 10s — enough for both callers within same cycle

function getDefaultJobsRpcUrl() {
  return env('JOBS_RPC_URL') || env('NODE_REGISTRY_RPC')
    || env('SOLANA_RPC') || 'https://api.mainnet-beta.solana.com';
}

// Build pool once on first import
let _pool = null;
function getPool() {
  if (!_pool) {
    _pool = buildPoolFromEnv('JOBS_RPC_URL', getDefaultJobsRpcUrl());
  }
  return _pool;
}

function getConnection() {
  return getPool().getConnection();
}

/**
 * Fetch ALL job accounts from chain (cached 10s).
 * Retries with next pool URL on error.
 */
async function fetchAllJobsCached() {
  const now = Date.now();
  if (_cache && (now - _cache.fetchedAt) < CACHE_TTL_MS) {
    return _cache.accounts;
  }

  const pool = getPool();
  let lastErr;

  // Try up to pool.getStats().urls times (one attempt per URL)
  const urlCount = pool.getStats().urls;
  for (let attempt = 0; attempt < urlCount; attempt++) {
    const conn = pool.getConnection();
    try {
      const accounts = await conn.getProgramAccounts(JOBS_PROGRAM_ID, {
        filters: [{
          memcmp: { offset: 0, bytes: JOB_DISC.toString('base64'), encoding: 'base64' },
        }],
      });

      const parsed = [];
      for (const { pubkey, account } of accounts) {
        const job = parseJobAccount(pubkey, account.data);
        if (job) parsed.push(job);
      }

      _cache = { accounts: parsed, fetchedAt: Date.now() };
      return parsed;
    } catch (err) {
      lastErr = err;
      // Mark the URL that failed so pool rotates away
      const url = pool.getUrl();
      pool.markFailed(url);
      console.warn(`[jobs-cache] gPA failed, trying next RPC: ${err.message}`);
    }
  }

  throw lastErr || new Error('All RPC URLs exhausted');
}

/**
 * Get open jobs (status === 'open'), sorted FIFO by jobId.
 */
export async function fetchOpenJobs() {
  const all = await fetchAllJobsCached();
  return all
    .filter(j => j.status === 'open')
    .sort((a, b) => a.jobId - b.jobId);
}

/**
 * Get submitted jobs (status === 'submitted').
 */
export async function fetchSubmittedJobs() {
  const all = await fetchAllJobsCached();
  return all.filter(j => j.status === 'submitted');
}

/**
 * Get all jobs (for zombie sweep — checks 'claimed' status).
 */
export async function fetchAllJobs() {
  return fetchAllJobsCached();
}

/**
 * Get the underlying Connection (for callers that need single-account reads).
 */
export { getConnection };

/**
 * Get pool stats for /health endpoint.
 */
export function getPoolStats() {
  return getPool().getStats();
}
