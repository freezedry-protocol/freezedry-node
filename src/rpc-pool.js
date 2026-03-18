/**
 * rpc-pool.js — Shared RPC connection pool with round-robin and failover.
 *
 * Used by jobs-cache.js (marketplace polling), indexer.js (chain scanning),
 * and writer/rpc.js (transaction submission) for RPC redundancy.
 *
 * Strategies:
 *   round-robin: rotate through all URLs (default)
 *   failover:    use primary, fall to next on error (60s cooldown)
 */

import { Connection } from '@solana/web3.js';
import { env } from './config.js';

const FAILOVER_COOLDOWN_MS = 60_000; // 60s before retrying a failed URL

/**
 * Create a named connection pool.
 * @param {string} name — Pool name (for logging)
 * @param {string[]} urls — RPC URLs (at least 1)
 * @param {'round-robin'|'failover'} strategy
 */
export function createPool(name, urls, strategy = 'round-robin') {
  if (!urls || urls.length === 0) {
    throw new Error(`rpc-pool(${name}): no URLs provided`);
  }

  const connections = new Map(); // url → Connection
  const failures = new Map();   // url → { failedAt, count }
  let rrIndex = 0;

  function getOrCreateConnection(url) {
    if (!connections.has(url)) {
      connections.set(url, new Connection(url, 'confirmed'));
    }
    return connections.get(url);
  }

  function isAvailable(url) {
    const f = failures.get(url);
    if (!f) return true;
    return (Date.now() - f.failedAt) >= FAILOVER_COOLDOWN_MS;
  }

  function getConnection() {
    if (strategy === 'failover') {
      // Always try primary first, fall through to next available
      for (const url of urls) {
        if (isAvailable(url)) return getOrCreateConnection(url);
      }
      // All failed — force primary (cooldown expired or not)
      return getOrCreateConnection(urls[0]);
    }

    // Round-robin: rotate, skip temporarily failed URLs
    for (let i = 0; i < urls.length; i++) {
      const idx = (rrIndex + i) % urls.length;
      if (isAvailable(urls[idx])) {
        rrIndex = (idx + 1) % urls.length;
        return getOrCreateConnection(urls[idx]);
      }
    }
    // All in cooldown — use next in rotation anyway
    const url = urls[rrIndex % urls.length];
    rrIndex = (rrIndex + 1) % urls.length;
    return getOrCreateConnection(url);
  }

  function getUrl() {
    if (strategy === 'failover') {
      for (const url of urls) {
        if (isAvailable(url)) return url;
      }
      return urls[0];
    }
    for (let i = 0; i < urls.length; i++) {
      const idx = (rrIndex + i) % urls.length;
      if (isAvailable(urls[idx])) {
        rrIndex = (idx + 1) % urls.length;
        return urls[idx];
      }
    }
    const url = urls[rrIndex % urls.length];
    rrIndex = (rrIndex + 1) % urls.length;
    return url;
  }

  function markFailed(url) {
    const existing = failures.get(url) || { failedAt: 0, count: 0 };
    failures.set(url, { failedAt: Date.now(), count: existing.count + 1 });
    const safeUrl = url.replace(/api-key=[^&]+/, 'api-key=***');
    console.warn(`[rpc-pool:${name}] Marked failed: ${safeUrl} (failures: ${existing.count + 1})`);
  }

  function getStats() {
    return {
      name,
      strategy,
      urls: urls.length,
      active: urls.filter(u => isAvailable(u)).length,
      failed: [...failures.entries()]
        .filter(([, f]) => (Date.now() - f.failedAt) < FAILOVER_COOLDOWN_MS)
        .map(([u, f]) => ({
          url: u.replace(/api-key=[^&]+/, 'api-key=***'),
          failedAt: f.failedAt,
          count: f.count,
        })),
    };
  }

  return { getConnection, getUrl, markFailed, getStats };
}

/**
 * Build a pool from env vars with a common prefix.
 * Reads PREFIX, PREFIX_2, PREFIX_3, ... from process.env.
 * @param {string} prefix — env var prefix (e.g. 'JOBS_RPC_URL')
 * @param {string} fallbackUrl — default URL if prefix not set
 * @returns pool instance
 */
/**
 * Get global backup URLs from RPC_BACKUP_URL, RPC_BACKUP_URL_2, etc.
 * These are appended to ALL pools automatically — one env var, all pools get it.
 * Per-pool vars (JOBS_RPC_URL_2, etc.) still work as overrides for fine-grained control.
 */
function getGlobalBackups() {
  const backups = [];
  const primary = env('RPC_BACKUP_URL');
  if (primary) backups.push(primary);
  for (let i = 2; i <= 5; i++) {
    const url = env(`RPC_BACKUP_URL_${i}`);
    if (url) backups.push(url);
  }
  return backups;
}

export function buildPoolFromEnv(prefix, fallbackUrl) {
  const strategy = env('RPC_STRATEGY') || 'round-robin';
  const urls = [];

  // Primary URL
  const primary = env(prefix) || fallbackUrl;
  if (primary) urls.push(primary);

  // Additional URLs: PREFIX_2, PREFIX_3, ... PREFIX_9 (per-pool overrides)
  for (let i = 2; i <= 9; i++) {
    const url = env(`${prefix}_${i}`);
    if (url) urls.push(url);
  }

  // Global backups — shared across all pools if no per-pool overrides set
  // Only add if this pool has no pool-specific backups (avoid duplicates)
  if (urls.length <= 1) {
    const globals = getGlobalBackups();
    for (const g of globals) {
      if (!urls.includes(g)) urls.push(g);
    }
  }

  if (urls.length === 0 && fallbackUrl) {
    urls.push(fallbackUrl);
  }

  return createPool(prefix, urls, strategy);
}
