/**
 * writer/metrics.js — Lightweight job performance metrics for benchmarking.
 * Tracks per-job stats and rolling averages. Exposed via /health endpoint.
 * No external dependencies. In-memory only (resets on restart).
 */

import {
  USE_WEBSOCKET, JITO_ENABLED, SEND_CONCURRENCY,
  BATCH_DELAY_MS, CONFIRM_WAIT_MS,
} from '../config.js';

// Rolling window of completed job metrics (keep last 100)
const MAX_HISTORY = 100;
const _jobHistory = [];

// Live TPS tracking (sliding window of recent chunk confirms)
const _recentChunks = []; // timestamps of recent chunk confirms
const LIVE_WINDOW_MS = 10_000; // 10s sliding window

// Cumulative counters (since process start)
const _cumulative = {
  startedAt: Date.now(),
  jobsCompleted: 0,
  jobsFailed: 0,
  chunksWritten: 0,
  totalElapsedMs: 0,
  jitoBundlesSent: 0,
  jitoBundlesLanded: 0,
  jitoBundlesFallback: 0,
  wsConfirms: 0,
  wsTimeouts: 0,
  pollingConfirms: 0,
};

/**
 * Record a completed job's metrics.
 */
export function recordJob(jobId, { chunks, elapsedMs, blobSize, mode }) {
  const tps = chunks / (elapsedMs / 1000);
  const entry = {
    jobId,
    chunks,
    elapsedMs,
    tps: Math.round(tps * 100) / 100,
    blobSize,
    mode, // 'standard' | 'ws' | 'jito' | 'ws+jito'
    completedAt: Date.now(),
  };

  _jobHistory.push(entry);
  if (_jobHistory.length > MAX_HISTORY) _jobHistory.shift();

  _cumulative.jobsCompleted++;
  // Note: chunksWritten already incremented live via recordChunkConfirm()
  _cumulative.totalElapsedMs += elapsedMs;
}

export function recordChunkConfirm(count = 1) {
  const now = Date.now();
  for (let i = 0; i < count; i++) _recentChunks.push(now);
  _cumulative.chunksWritten += count;
}

function getLiveTps() {
  const now = Date.now();
  const cutoff = now - LIVE_WINDOW_MS;
  // Prune old entries
  while (_recentChunks.length > 0 && _recentChunks[0] < cutoff) _recentChunks.shift();
  if (_recentChunks.length < 2) return 0;
  const elapsed = (now - _recentChunks[0]) / 1000;
  return elapsed > 0 ? Math.round((_recentChunks.length / elapsed) * 100) / 100 : 0;
}

export function recordJobFailed() {
  _cumulative.jobsFailed++;
}

export function recordJitoBundleSent() { _cumulative.jitoBundlesSent++; }
export function recordJitoBundleLanded() { _cumulative.jitoBundlesLanded++; }
export function recordJitoBundleFallback() { _cumulative.jitoBundlesFallback++; }
export function recordWsConfirm() { _cumulative.wsConfirms++; }
export function recordWsTimeout() { _cumulative.wsTimeouts++; }
export function recordPollingConfirm() { _cumulative.pollingConfirms++; }

/**
 * Get current metrics snapshot for /health endpoint.
 */
export function getMetrics() {
  const uptimeMs = Date.now() - _cumulative.startedAt;
  const avgTps = _cumulative.totalElapsedMs > 0
    ? Math.round((_cumulative.chunksWritten / (_cumulative.totalElapsedMs / 1000)) * 100) / 100
    : 0;

  // Last 10 jobs for quick view
  const recentJobs = _jobHistory.slice(-10).map(j => ({
    jobId: j.jobId.slice(0, 8),
    chunks: j.chunks,
    elapsed: `${Math.round(j.elapsedMs / 1000)}s`,
    tps: j.tps,
    mode: j.mode,
  }));

  // Rolling average TPS (last 10 jobs)
  const last10 = _jobHistory.slice(-10);
  const rollingTps = last10.length > 0
    ? Math.round((last10.reduce((s, j) => s + j.tps, 0) / last10.length) * 100) / 100
    : 0;

  return {
    config: {
      websocket: USE_WEBSOCKET,
      jito: JITO_ENABLED,
      concurrency: SEND_CONCURRENCY,
      batchDelayMs: BATCH_DELAY_MS,
      confirmWaitMs: CONFIRM_WAIT_MS,
    },
    cumulative: {
      uptimeHrs: Math.round(uptimeMs / 3600000 * 10) / 10,
      jobsCompleted: _cumulative.jobsCompleted,
      jobsFailed: _cumulative.jobsFailed,
      chunksWritten: _cumulative.chunksWritten,
      avgTps,
    },
    jito: {
      bundlesSent: _cumulative.jitoBundlesSent,
      bundlesLanded: _cumulative.jitoBundlesLanded,
      bundlesFallback: _cumulative.jitoBundlesFallback,
      landingRate: _cumulative.jitoBundlesSent > 0
        ? `${Math.round((_cumulative.jitoBundlesLanded / _cumulative.jitoBundlesSent) * 100)}%`
        : 'n/a',
    },
    confirms: {
      wsConfirms: _cumulative.wsConfirms,
      wsTimeouts: _cumulative.wsTimeouts,
      pollingConfirms: _cumulative.pollingConfirms,
      wsSuccessRate: (_cumulative.wsConfirms + _cumulative.wsTimeouts) > 0
        ? `${Math.round((_cumulative.wsConfirms / (_cumulative.wsConfirms + _cumulative.wsTimeouts)) * 100)}%`
        : 'n/a',
    },
    liveTps: getLiveTps(),
    rollingTps,
    recentJobs,
  };
}
