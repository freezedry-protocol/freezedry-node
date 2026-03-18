/**
 * server.js — Freeze Dry Node HTTP server
 * Fastify-based API for serving cached artworks + receiving webhooks.
 * Supports ROLE-based startup: "reader", "writer", or "both" (default).
 */

import Fastify from 'fastify';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash, timingSafeEqual } from 'crypto';
import * as db from './db.js';
import { isHydBlob, isOpenMode, extractContentHash, verifyBlobHash, computeBlobHash } from './hyd.js';
import { startIndexer, getIndexerBudget } from './indexer.js';
import { gossipBlob, pullBlob } from './gossip.js';
import { extractPeerHeaders, verifyPeerMessage } from './crypto-auth.js';
// Writer routes loaded dynamically — requires @solana/web3.js which reader-only nodes may not have

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Parse a FREEZEDRY pointer memo string into structured data.
 * Supports v3 (with lastChunkSig), v2, and v1 formats.
 */
function parsePointerMemo(memo) {
  if (!memo || typeof memo !== 'string' || !memo.startsWith('FREEZEDRY:')) return null;
  const parts = memo.split(':');
  // v3: FREEZEDRY:3:sha256:{hex}:{chunks}:{size}:{chunkSize}:{flags}:{inscriber}:{lastChunkSig}
  if (parts[1] === '3' && parts.length >= 10) {
    return {
      version: 3,
      hash: parts[2] + ':' + parts[3],
      chunkCount: parseInt(parts[4], 10),
      blobSize: parseInt(parts[5], 10),
      chunkSize: parseInt(parts[6], 10),
      flags: parts[7],
      inscriber: parts[8],
      lastChunkSig: parts[9],
    };
  }
  if (parts[1] === '2' && parts.length >= 9) {
    return {
      version: 2,
      hash: parts[2] + ':' + parts[3],
      chunkCount: parseInt(parts[4], 10),
      blobSize: parseInt(parts[5], 10),
      chunkSize: parseInt(parts[6], 10),
      flags: parts[7],
      inscriber: parts[8],
      lastChunkSig: null,
    };
  }
  if (parts.length >= 4) {
    return {
      version: 1,
      hash: parts[1] + ':' + parts[2],
      chunkCount: parseInt(parts[3], 10),
      blobSize: parts[4] ? parseInt(parts[4], 10) : null,
      chunkSize: null,
      flags: null,
      inscriber: null,
      lastChunkSig: null,
    };
  }
  return null;
}

// Load .env manually (no dotenv dependency)
function loadEnv() {
  const envPath = join(__dirname, '..', '.env');
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv();

const PORT = parseInt(process.env.PORT || '3100', 10);
const NODE_ID = process.env.NODE_ID || 'freezedry-node';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const ROLE = (process.env.ROLE || 'both').toLowerCase(); // "reader", "writer", or "both"
const startTime = Date.now();

// Blob cache pruning settings (v7)
const BLOB_CACHE_DAYS = parseInt(process.env.BLOB_CACHE_DAYS || '0', 10);
const BLOB_CACHE_MAX_MB = parseInt(process.env.BLOB_CACHE_MAX_MB || '0', 10);
const CDN_URL = process.env.CDN_URL || 'https://cdn.freezedry.art';

const isReader = ROLE === 'reader' || ROLE === 'both';
const isWriter = ROLE === 'writer' || ROLE === 'both';

// ─── Global error handler ───
process.on('unhandledRejection', (err) => {
  console.error('[FATAL] Unhandled rejection:', err);
  process.exit(1);
});

// ─── Startup validation ───
if (!WEBHOOK_SECRET) {
  console.warn('⚠️  WARNING: WEBHOOK_SECRET is empty — /ingest and /webhook/helius are UNPROTECTED.');
  console.warn('   Set WEBHOOK_SECRET in .env to secure your node.');
}
if (!process.env.HELIUS_API_KEY) {
  console.warn('⚠️  WARNING: HELIUS_API_KEY not set — indexer will run in webhook-only mode.');
}

// ─── Rate limiting (in-memory, per-IP) ───
const rateLimits = new Map();
const RATE_WINDOW = 60_000; // 1 minute
const RATE_MAX_READ = 120;  // 120 reads/min
const RATE_MAX_WRITE = 10;  // 10 writes/min

function checkRate(ip, isWrite = false) {
  const now = Date.now();
  const key = `${ip}:${isWrite ? 'w' : 'r'}`;
  const entry = rateLimits.get(key);
  const max = isWrite ? RATE_MAX_WRITE : RATE_MAX_READ;
  if (!entry || now - entry.start > RATE_WINDOW) {
    rateLimits.set(key, { start: now, count: 1 });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

// ─── Gossip rate limiting (per-peer, stricter) ───
// Prevents a rogue peer from spamming notifications or pushes.
const gossipRateLimits = new Map();
const GOSSIP_RATE_WINDOW = 60_000;  // 1 minute
const GOSSIP_RATE_MAX = 30;          // 30 gossip messages/min per peer (enough for burst inscriptions)

function checkGossipRate(peerUrl) {
  const now = Date.now();
  const entry = gossipRateLimits.get(peerUrl);
  if (!entry || now - entry.start > GOSSIP_RATE_WINDOW) {
    gossipRateLimits.set(peerUrl, { start: now, count: 1 });
    return true;
  }
  if (entry.count >= GOSSIP_RATE_MAX) return false;
  entry.count++;
  return true;
}

// ─── Peer trust + strike system ───
// Tracks bad behavior per peer. 3 strikes in 1 hour = banned for 1 hour.
const peerStrikes = new Map(); // peerUrl → { strikes: number, lastStrike: number, bannedUntil: number }
const STRIKE_WINDOW = 3600_000;   // 1 hour
const STRIKE_LIMIT = 3;
const BAN_DURATION = 3600_000;    // banned for 1 hour
const MAX_PEERS = 100;            // cap on total registered peers

function addStrike(peerUrl, reason) {
  const now = Date.now();
  const entry = peerStrikes.get(peerUrl) || { strikes: 0, lastStrike: 0, bannedUntil: 0 };
  // Reset strikes if window expired
  if (now - entry.lastStrike > STRIKE_WINDOW) entry.strikes = 0;
  entry.strikes++;
  entry.lastStrike = now;
  if (entry.strikes >= STRIKE_LIMIT) {
    entry.bannedUntil = now + BAN_DURATION;
    console.warn(`[Security] Peer ${peerUrl} BANNED for ${BAN_DURATION / 60_000}min (reason: ${reason}, strikes: ${entry.strikes})`);
  }
  peerStrikes.set(peerUrl, entry);
}

function isPeerBanned(peerUrl) {
  const entry = peerStrikes.get(peerUrl);
  if (!entry) return false;
  if (Date.now() < entry.bannedUntil) return true;
  return false;
}

// Pending pull tracker — prevents pull amplification (one pull per hash at a time)
const pendingPulls = new Set();

// Clean up rate limit map every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimits) {
    if (now - entry.start > RATE_WINDOW) rateLimits.delete(key);
  }
  for (const [key, entry] of gossipRateLimits) {
    if (now - entry.start > GOSSIP_RATE_WINDOW) gossipRateLimits.delete(key);
  }
  for (const [key, entry] of peerStrikes) {
    if (now - entry.lastStrike > STRIKE_WINDOW && now > entry.bannedUntil) peerStrikes.delete(key);
  }
}, 300_000);

/** Validate webhook/ingest auth header */
function requireWebhookAuth(req, reply) {
  if (!WEBHOOK_SECRET) {
    // No secret configured — reject all write requests for safety
    reply.status(403);
    return { error: 'WEBHOOK_SECRET not configured — node is in read-only mode' };
  }
  const authHeader = req.headers['authorization'] || '';
  const expected = Buffer.from(WEBHOOK_SECRET);
  const provided = Buffer.from(authHeader);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    reply.status(401);
    return { error: 'Unauthorized' };
  }
  return null; // auth passed
}

const app = Fastify({ logger: true, bodyLimit: 6 * 1024 * 1024 }); // 6 MB — matches /inscribe route limit

// Parse application/octet-stream as raw Buffer (for /upload/:hash PUT)
app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (req, body, done) => {
  done(null, body);
});

// CORS — restrict to our domains + localhost dev
const ALLOWED_ORIGINS = new Set([
  'https://freezedry.art',
  'https://www.freezedry.art',
  'http://localhost:3000',
  'http://localhost:8080',
]);

app.addHook('onRequest', (req, reply, done) => {
  const origin = req.headers.origin || '';
  // Allow our domains, localhost, Vercel previews, wallet in-app browsers
  const allowed = ALLOWED_ORIGINS.has(origin)
    || origin === 'http://localhost' || origin.startsWith('http://localhost:')
    || /^https:\/\/hydrate-[^.]+\.vercel\.app$/.test(origin)
    || origin.endsWith('.phantom.app')
    || origin.endsWith('.backpack.app');
  reply.header('Access-Control-Allow-Origin', allowed ? origin : 'https://freezedry.art');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-FD-Identity, X-FD-Signature, X-FD-Message, X-Gossip-Origin, X-Wallet');
  reply.header('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    reply.status(204).send();
    return;
  }
  done();
});

// ─── Input validation ───

/** Validate hash format: sha256:{64 hex chars} */
function isValidHash(hash) {
  return typeof hash === 'string' && /^sha256:[0-9a-f]{64}$/.test(hash);
}

/** Check if an IP/hostname is private or reserved (SSRF protection) */
function isPrivateHost(host) {
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (host.startsWith('10.')) return true;
  if (host.startsWith('192.168.')) return true;
  if (host.startsWith('169.254.')) return true;  // link-local / cloud metadata
  if (host.startsWith('172.') && /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host.endsWith('.internal') || host.endsWith('.local')) return true;
  return false;
}

/** Check if string is a raw IPv4 address (not a domain) */
function isRawIPv4(host) {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Validate peer URL or endpoint.
 * - https:// → allow any public hostname (existing behavior)
 * - http://  → allow ONLY raw public IPv4 (no domains — prevents DNS rebinding)
 */
function isValidPeerUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const host = u.hostname;

    // Block private/internal IPs for all protocols
    if (isPrivateHost(host)) return false;

    // HTTPS: allow any public hostname
    if (u.protocol === 'https:') return true;

    // HTTP: allow only raw public IPv4 addresses (no domains — prevents DNS rebinding)
    if (u.protocol === 'http:' && isRawIPv4(host)) return true;

    return false;
  } catch (err) {
    console.warn('[Server] URL validation parse error:', err.message);
    return false;
  }
}

/**
 * Validate an ip:port endpoint string.
 * Must be a public IPv4 address with a valid port (1024-65535).
 */
function isValidEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'string') return false;
  const match = endpoint.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)$/);
  if (!match) return false;
  const [, ip, portStr] = match;
  if (isPrivateHost(ip)) return false;
  const port = parseInt(portStr, 10);
  if (port < 1024 || port > 65535) return false;
  return true;
}

/** Convert an ip:port endpoint to an http:// URL for fetching */
function endpointToUrl(endpoint) {
  return `http://${endpoint}`;
}

// ─── Health ───

app.get('/health', async () => {
  const stats = db.getStats();
  const cacheBytes = db.getBlobCacheSize();
  const result = {
    status: 'ok',
    service: 'freezedry-node',
    nodeId: NODE_ID,
    endpoint: process.env.NODE_ENDPOINT || undefined,
    indexed: { artworks: stats.artworks, complete: stats.complete },
    peers: db.listPeers().length,
    blobCache: {
      sizeMB: Math.round(cacheBytes / 1024 / 1024 * 100) / 100,
    },
  };

  // Add identity info (two-wallet system)
  try {
    const { getIdentityKeypair, getHotWallet } = await import('./wallet.js');
    try {
      result.identityPubkey = getIdentityKeypair().publicKey.toBase58();
    } catch (_noKey) { /* identity key not configured — reader-only node */ }
    try {
      result.hotWalletPubkey = getHotWallet().publicKey.toBase58();
    } catch (_noKey) { /* hot wallet not configured — reader-only node */ }
  } catch (_noModule) { /* wallet module not available */ }

  // Add display name if available
  try {
    const { displayName: getDisplayName } = await import('./display-name.js');
    if (result.identityPubkey) {
      result.displayName = getDisplayName(result.identityPubkey);
    }
  } catch (_noModule) { /* display-name module not available */ }

  // Add writer metrics if writer role is active
  if (isWriter) {
    try {
      const { getMetrics } = await import('./writer/metrics.js');
      result.writer = getMetrics();
    } catch (_noModule) { /* metrics module not available */ }
    try {
      const { INSCRIPTION_MODE } = await import('./config.js');
      result.inscriptionMode = INSCRIPTION_MODE;
    } catch (_noModule) { /* config module not available */ }
  }
  return result;
});

// ─── Artwork metadata ───

app.get('/artwork/:hash', (req, reply) => {
  const ip = req.ip || 'unknown';
  if (!checkRate(ip)) { reply.status(429); return { error: 'Rate limit exceeded' }; }
  if (!isValidHash(req.params.hash)) { reply.status(400); return { error: 'Invalid hash format' }; }
  const artwork = db.getArtwork(req.params.hash);
  if (!artwork) { reply.status(404); return { error: 'Not found' }; }
  return {
    hash: artwork.hash,
    chunkCount: artwork.chunk_count,
    blobSize: artwork.blob_size,
    width: artwork.width,
    height: artwork.height,
    mode: artwork.mode,
    complete: !!artwork.complete,
  };
});

// ─── List artworks ───

app.get('/artworks', (req, reply) => {
  const ip = req.ip || 'unknown';
  if (!checkRate(ip)) { reply.status(429); return { error: 'Rate limit exceeded' }; }
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const offset = parseInt(req.query.offset || '0', 10);
  const artworks = db.listArtworks(limit, offset);
  const stats = db.getStats();
  return {
    artworks: artworks.map(a => ({
      hash: a.hash,
      chunkCount: a.chunk_count,
      blobSize: a.blob_size,
      width: a.width,
      height: a.height,
      mode: a.mode,
      complete: !!a.complete,
    })),
    total: stats.artworks,
  };
});

// ─── Serve cached blob ───

/**
 * Serve cached blob — peer-gated with liveness verification.
 *
 * The metadata (artwork list, pointers, verify) is free — that's the directory.
 * Blob data represents real cost (RPC credits, indexing time, compute).
 * To get blobs, a peer must be:
 *   1. Registered (via /sync/announce)
 *   2. LIVE right now (we ping their /health before serving)
 *
 * This prevents hit-and-run: register, scrape everything, disconnect.
 * If your node isn't reachable, you read the chain yourself.
 *
 * Set BLOB_PUBLIC=true in .env to skip all checks (open cache mode).
 */
const BLOB_PUBLIC = (process.env.BLOB_PUBLIC || 'false') === 'true';

// Cache liveness checks for 5 minutes to avoid hammering peers on every request
const livenessCache = new Map();
const LIVENESS_TTL = 5 * 60 * 1000;

async function isPeerLive(nodeUrl) {
  if (!nodeUrl) return false;
  // Accept both https:// URLs and http:// for IP:port peers
  if (!isValidPeerUrl(nodeUrl)) return false;

  // Check cache first
  const cached = livenessCache.get(nodeUrl);
  if (cached && Date.now() - cached.time < LIVENESS_TTL) return cached.alive;

  // Ping their /health (no redirects — SSRF protection)
  try {
    const resp = await fetch(`${nodeUrl}/health`, { signal: AbortSignal.timeout(5000), redirect: 'manual' });
    const alive = resp.ok;
    livenessCache.set(nodeUrl, { alive, time: Date.now() });
    if (alive) db.upsertPeer(nodeUrl); // refresh last_seen on success
    return alive;
  } catch (err) {
    console.warn(`[Server] liveness check failed for ${nodeUrl}:`, err.message);
    livenessCache.set(nodeUrl, { alive: false, time: Date.now() });
    return false;
  }
}

app.get('/blob/:hash', async (req, reply) => {
  if (!isValidHash(req.params.hash)) { reply.status(400); return { error: 'Invalid hash format' }; }
  if (!BLOB_PUBLIC) {
    // Auth bypass for trusted callers (timing-safe)
    const authHeader = req.headers['authorization'] || '';
    const expected = Buffer.from(WEBHOOK_SECRET || '');
    const provided = Buffer.from(authHeader);
    const isAuthed = WEBHOOK_SECRET && expected.length === provided.length && timingSafeEqual(expected, provided);

    if (!isAuthed) {
      // Must be a registered peer with valid ed25519 identity signature
      const peerHdrs = extractPeerHeaders(req.headers);
      if (!peerHdrs) {
        reply.status(403);
        return {
          error: 'Blob data requires signed peer identity headers',
          hint: 'Include X-FD-Identity, X-FD-Signature, X-FD-Message headers',
        };
      }
      const peerResult = verifyPeerMessage(peerHdrs.identity, peerHdrs.message, peerHdrs.signature);
      if (!peerResult.valid) {
        reply.status(403);
        return { error: `Peer auth failed: ${peerResult.error}` };
      }
      // Verify identity is a known peer
      const peers = db.listPeers();
      const knownPeer = peers.some(p => p.identity_pubkey === peerHdrs.identity || p.url === peerHdrs.identity);
      if (!knownPeer) {
        reply.status(403);
        return { error: 'Unknown peer identity — announce first via /sync/announce' };
      }
    }
  }

  // Only serve complete blobs — partial data wastes bandwidth and fails peer verification
  const artwork = db.getArtwork(req.params.hash);
  if (!artwork || !artwork.complete) {
    // If pruned, proxy from CDN on-demand (don't re-store, don't clear tombstone)
    if (db.isPruned(req.params.hash)) {
      try {
        const cdnResp = await fetch(`${CDN_URL}/blob/${req.params.hash}`, {
          signal: AbortSignal.timeout(15_000),
        });
        if (cdnResp.ok) {
          const cdnBuf = Buffer.from(await cdnResp.arrayBuffer());
          reply.header('Content-Type', 'application/octet-stream');
          reply.header('Content-Length', cdnBuf.length);
          reply.header('X-Source', 'cdn-proxy');
          reply.header('Cache-Control', 'public, max-age=3600');
          return reply.send(cdnBuf);
        }
      } catch (err) {
        console.warn('[Server] CDN proxy failed:', err.message);
      }
    }
    reply.status(404);
    return { error: artwork ? 'Blob incomplete — still indexing' : 'Blob not cached' };
  }

  const blob = db.getBlob(req.params.hash);
  if (!blob) {
    reply.status(404);
    return { error: 'Blob not cached' };
  }
  reply.header('Content-Type', 'application/octet-stream');
  reply.header('Content-Length', blob.length);
  reply.header('Cache-Control', 'public, max-age=31536000, immutable');
  return reply.send(blob);
});

// ─── Pin/unpin blobs (protect from pruning) ───
// Galleries can pin specific artwork hashes to keep them cached permanently.
// Auto-inscribed blobs are pinned automatically by the claimer.

app.post('/pin/:hash', (req, reply) => {
  const authErr = requireWebhookAuth(req, reply);
  if (authErr) return authErr;
  if (!isValidHash(req.params.hash)) { reply.status(400); return { error: 'Invalid hash format' }; }
  db.pinBlob(req.params.hash);
  return { ok: true, hash: req.params.hash, pinned: true };
});

app.post('/unpin/:hash', (req, reply) => {
  const authErr = requireWebhookAuth(req, reply);
  if (authErr) return authErr;
  if (!isValidHash(req.params.hash)) { reply.status(400); return { error: 'Invalid hash format' }; }
  db.unpinBlob(req.params.hash);
  return { ok: true, hash: req.params.hash, pinned: false };
});

// ─── Acquire blob by hash (gallery "add to collection" flow) ───
// Fetches a blob from peers/CDN, stores locally, and optionally pins it.
// For galleries: "I want this artwork on my node" — one call does it all.

app.post('/acquire/:hash', async (req, reply) => {
  const authErr = requireWebhookAuth(req, reply);
  if (authErr) return authErr;
  if (!isValidHash(req.params.hash)) { reply.status(400); return { error: 'Invalid hash format' }; }

  const hash = req.params.hash;
  const shouldPin = req.query.pin !== 'false'; // default: pin=true

  // Already have it?
  const existing = db.getArtwork(hash);
  if (existing && existing.complete) {
    if (shouldPin) db.pinBlob(hash);
    return { ok: true, hash, source: 'local', pinned: shouldPin, size: existing.blob_size };
  }

  // Try fetching from: peers → CDN → coordinator
  const sources = [
    ...db.listPeers().map(p => `${p.url}/blob/${hash}`),
    `${CDN_URL}/blob/${hash}`,
    `${process.env.COORDINATOR_URL || 'https://freezedry.art'}/api/fetch-chain?hash=${encodeURIComponent(hash)}&format=blob`,
  ];

  for (const url of sources) {
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
        headers: { 'X-Node-URL': process.env.NODE_URL || '' },
      });
      if (!resp.ok) continue;
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length === 0) continue;

      if (!verifyBlobHash(buf, hash)) continue;

      // Store it
      db.upsertArtwork({
        hash,
        chunkCount: Math.ceil(buf.length / 585),
        blobSize: buf.length,
        width: isHydBlob(buf) ? buf.readUInt16LE(5) : null,
        height: isHydBlob(buf) ? buf.readUInt16LE(7) : null,
        mode: 'open', network: 'mainnet', pointerSig: null, chunks: null,
      });
      db.storeBlob(hash, buf);
      if (shouldPin) db.pinBlob(hash);

      const sourceHost = new URL(url).hostname;
      app.log.info(`[Acquire] Stored ${hash.slice(0, 24)}... (${buf.length}B) from ${sourceHost}, pinned=${shouldPin}`);
      return { ok: true, hash, source: sourceHost, pinned: shouldPin, size: buf.length };
    } catch (err) {
      console.warn('[Server] acquire blob source failed:', err.message);
    }
  }

  reply.status(404);
  return { error: 'Could not fetch blob from any source', hash, triedSources: sources.length };
});

// ─── SHA-256 verification ───

app.get('/verify/:hash', (req, reply) => {
  if (!isValidHash(req.params.hash)) { reply.status(400); return { error: 'Invalid hash format' }; }
  const blob = db.getBlob(req.params.hash);
  if (!blob) return { error: 'Not cached', verified: false };

  // Verify via manifest hash (bytes 17-48 of HYD header), not SHA-256(entire blob).
  // The pointer/work-record hash is the manifest hash — a content hash embedded during .hyd creation.
  const result = { expected: req.params.hash, blobSize: blob.length };
  const openMode = isOpenMode(blob);
  result.verified = verifyBlobHash(blob, req.params.hash);
  result.method = openMode ? 'hyd-header' : 'sha256-full';
  if (openMode) {
    result.manifestHash = 'sha256:' + extractContentHash(blob);
  } else {
    result.computed = computeBlobHash(blob);
  }

  return result;
});

// ─── Blob repair — verify all blobs and re-index corrupt ones ───

app.get('/repair', async (req, reply) => {
  // Auth: webhook secret required (destructive — resets corrupt blobs)
  const authErr = requireWebhookAuth(req, reply);
  if (authErr) return authErr;

  app.log.info('Repair: starting blob verification scan...');
  const result = db.repairCorruptBlobs();
  app.log.info(`Repair: ${result.verified} verified, ${result.corrupt} corrupt (reset), ${result.missing} missing — total ${result.total}`);

  return {
    ok: true,
    ...result,
    message: result.corrupt > 0
      ? `Reset ${result.corrupt} corrupt blob(s) for re-index from chain. Next indexer cycle will refetch.`
      : 'All blobs verified — no corruption found.',
  };
});

// ─── Direct blob upload (browser → node, zero coordinator) ───
// Browser PUTs raw binary blob directly. SHA-256 verified, rate limited.
// Node stores it locally so the claimer has zero-fetch when the job lands.

const UPLOAD_RATE_WINDOW = 3600_000; // 1 hour
const UPLOAD_RATE_MAX = 20;          // 20 uploads/hour per IP
const uploadRateLimits = new Map();

function checkUploadRate(ip) {
  const now = Date.now();
  const entry = uploadRateLimits.get(ip);
  if (!entry || now - entry.start > UPLOAD_RATE_WINDOW) {
    uploadRateLimits.set(ip, { start: now, count: 1 });
    return true;
  }
  if (entry.count >= UPLOAD_RATE_MAX) return false;
  entry.count++;
  return true;
}

// Clean upload rate limits every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of uploadRateLimits) {
    if (now - entry.start > UPLOAD_RATE_WINDOW) uploadRateLimits.delete(key);
  }
}, 600_000);

app.put('/upload/:hash', async (req, reply) => {
  const ip = req.headers['x-real-ip'] || req.ip || 'unknown';
  if (!checkUploadRate(ip)) {
    reply.status(429);
    return { error: 'Upload rate limit exceeded (20/hour)' };
  }

  const hash = req.params.hash;
  if (!isValidHash(hash)) {
    reply.status(400);
    return { error: 'Invalid hash format — expected sha256:{64 hex chars}' };
  }

  // Fastify gives us a raw Buffer when Content-Type is application/octet-stream
  const blobBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
  if (!blobBuf || blobBuf.length === 0) {
    reply.status(400);
    return { error: 'Empty body' };
  }
  if (blobBuf.length > 5 * 1024 * 1024) {
    reply.status(413);
    return { error: `Blob too large (${(blobBuf.length / 1024 / 1024).toFixed(1)}MB). Maximum is 5MB.` };
  }

  const hashMatch = verifyBlobHash(blobBuf, hash);

  if (!hashMatch) {
    reply.status(400);
    return { error: 'SHA-256 mismatch — blob does not match URL hash' };
  }

  // Store blob under the URL hash (canonical) — client now sends manifest hash for HYD blobs.
  // Same pattern as CDN: store under whatever hash the client sent.
  db.upsertArtwork({
    hash: hash,
    chunkCount: Math.ceil(blobBuf.length / 585),
    blobSize: blobBuf.length,
    width: isHydBlob(blobBuf) ? blobBuf.readUInt16LE(5) : null,
    height: isHydBlob(blobBuf) ? blobBuf.readUInt16LE(7) : null,
    mode: 'open',
    network: 'mainnet',
    pointerSig: null,
    chunks: null,
  });
  db.storeBlob(hash, blobBuf);

  app.log.info(`[Upload] Stored blob ${hash.slice(0, 24)}... (${blobBuf.length}B) from ${ip}`);

  return {
    ok: true,
    hash: hash,
    size: blobBuf.length,
    blobSource: `${process.env.NODE_URL || 'http://localhost:3000'}/blob/${hash}`,
  };
});

// ─── Ingest (Vercel push or peer sync) — requires webhook secret ───

app.post('/ingest', async (req, reply) => {
  const authErr = requireWebhookAuth(req, reply);
  if (authErr) return authErr;

  const ip = req.ip || 'unknown';
  if (!checkRate(ip, true)) {
    reply.status(429);
    return { error: 'Rate limit exceeded' };
  }

  const body = req.body;
  if (!body || !body.hash || !body.chunkCount) {
    return { error: 'Missing hash or chunkCount' };
  }

  // Detect full-blob push: single chunk containing the complete blob
  // Use storeBlob() path which cleans old chunks and marks complete atomically
  const isSingleBlobPush = body.chunks && body.chunks.length === 1 && body.chunkCount === 1;
  if (isSingleBlobPush) {
    const blobBuf = Buffer.from(body.chunks[0].data, 'base64');

    const computedHash = computeBlobHash(blobBuf);

    // Use computed hash if it differs from provided (fixes blobHash vs manifestHash confusion)
    const hash = computedHash || body.hash;

    db.upsertArtwork({
      hash,
      chunkCount: Math.ceil(blobBuf.length / 585),
      blobSize: blobBuf.length,
      width: body.width || (isHydBlob(blobBuf) ? blobBuf.readUInt16LE(5) : null),
      height: body.height || (isHydBlob(blobBuf) ? blobBuf.readUInt16LE(7) : null),
      mode: body.mode || 'open',
      network: body.network || 'mainnet',
      pointerSig: body.pointerSig || null,
      chunks: null, // storeBlob handles chunk storage
    });
    db.storeBlob(hash, blobBuf);

    gossipBlob(hash, Math.ceil(blobBuf.length / 585), []).catch(() => {});
    return { ok: true, hash, cached: 1, expected: 1, complete: true };
  }

  // Multi-chunk ingest (original path)
  db.upsertArtwork({
    hash: body.hash,
    chunkCount: body.chunkCount,
    blobSize: body.blobSize || null,
    width: body.width || null,
    height: body.height || null,
    mode: body.mode || 'open',
    network: body.network || 'mainnet',
    pointerSig: body.pointerSig || null,
    chunks: body.chunks || null,
  });

  const cachedCount = db.getChunkCount(body.hash);
  const complete = cachedCount >= body.chunkCount;

  // Gossip to peers when blob is complete
  if (complete) {
    gossipBlob(body.hash, body.chunkCount, []).catch(() => {});
  }

  return {
    ok: true,
    hash: body.hash,
    cached: cachedCount,
    expected: body.chunkCount,
    complete,
  };
});

// ─── Twilight Bark (epidemic blob propagation) ───
// A bark heard around the world — one node gets the blob, barks it to peers,
// they bark it to theirs. Every node in the network knows within minutes.
// Implementation in ./gossip.js (shared with writer/claimer.js)

const NODE_URL = process.env.NODE_URL || '';

// ─── Helius Webhook (real-time push) ───

app.post('/webhook/helius', async (req, reply) => {
  const authErr = requireWebhookAuth(req, reply);
  if (authErr) return authErr;

  const transactions = Array.isArray(req.body) ? req.body : [req.body];
  let processed = 0;

  for (const tx of transactions) {
    try {
      // Helius enhanced format — look for memo instructions
      const sig = tx.signature;
      if (!sig) continue;

      // Check all instructions for memo data
      const instructions = tx.instructions || [];
      for (const ix of instructions) {
        // Memo Program v2: MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr
        if (ix.programId === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr') {
          const memoData = ix.data || '';

          // Pointer memo v1/v2
          if (memoData.startsWith('FREEZEDRY:')) {
            const pointer = parsePointerMemo(memoData);
            if (pointer) {
              db.upsertArtwork({
                hash: pointer.hash,
                chunkCount: pointer.chunkCount,
                blobSize: pointer.blobSize || null,
                width: null,
                height: null,
                mode: 'open',
                network: 'mainnet',
                pointerSig: sig,
                chunks: null,
              });

              app.log.info(`Webhook: discovered pointer for ${pointer.hash} (${pointer.chunkCount} chunks, v${pointer.version})`);
              processed++;
            }
          }
          // Chunk memo: base64-encoded data (not a pointer)
          // These get indexed when we fetch the full artwork via the indexer
        }
      }
    } catch (err) {
      app.log.warn(`Webhook: failed to process tx — ${err.message}`);
    }
  }

  return { ok: true, processed };
});

// ─── Peer Sync endpoints ───

/**
 * Check if the requesting node is a registered active peer.
 * Three auth paths (checked in order):
 *   1. WEBHOOK_SECRET (shared secret — trusted internal nodes)
 *   2. X-FD-Identity + X-FD-Signature (ed25519 signed peer message)
 *   3. X-Node-URL (legacy — peer must be in registered list)
 */
function requireActivePeer(req, reply) {
  // Path 1: Shared secret (timing-safe) — trusted callers
  const authHeader = req.headers['authorization'] || '';
  const expected = Buffer.from(WEBHOOK_SECRET || '');
  const provided = Buffer.from(authHeader);
  if (WEBHOOK_SECRET && expected.length === provided.length && timingSafeEqual(expected, provided)) {
    return true;
  }

  // Path 2: Ed25519 identity signature — permissionless peer auth
  const peerHdrs = extractPeerHeaders(req.headers);
  if (peerHdrs) {
    const result = verifyPeerMessage(peerHdrs.identity, peerHdrs.message, peerHdrs.signature);
    if (result.valid) {
      // Verify identity is a known peer (by identity pubkey or URL)
      const peers = db.listPeers();
      const knownPeer = peers.some(p => p.identity_pubkey === peerHdrs.identity || p.url === peerHdrs.identity);
      if (knownPeer) {
        if (isPeerBanned(peerHdrs.identity)) { reply.status(403); return false; }
        return true;
      }
    }
  }

  // No valid auth path — reject
  reply.status(403);
  return false;
}

app.get('/sync/list', (req, reply) => {
  if (requireActivePeer(req, reply) === false) {
    return { error: 'Peer sync requires active peer registration. Use /sync/announce first.' };
  }
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
  const offset = parseInt(req.query.offset || '0', 10);
  const artworks = db.listArtworks(limit, offset);
  return {
    artworks: artworks.map(a => ({
      hash: a.hash,
      chunkCount: a.chunk_count,
      complete: !!a.complete,
    })),
  };
});

app.get('/sync/chunks/:hash', (req, reply) => {
  if (requireActivePeer(req, reply) === false) {
    return { error: 'Peer sync requires active peer registration. Use /sync/announce first.' };
  }
  if (!isValidHash(req.params.hash)) { reply.status(400); return { error: 'Invalid hash format' }; }

  // Only serve complete blobs (same check as /blob/:hash)
  const artwork = db.getArtwork(req.params.hash);
  if (!artwork || !artwork.complete) {
    reply.status(404);
    return { error: artwork ? 'Blob incomplete' : 'Not cached' };
  }
  const blob = db.getBlob(req.params.hash);
  if (!blob) { reply.status(404); return { error: 'Not cached' }; }
  return {
    hash: req.params.hash,
    data: blob.toString('base64'),
    size: blob.length,
  };
});

// List known peers — peer-gated to prevent network enumeration
app.get('/nodes', (req, reply) => {
  const ip = req.ip || 'unknown';
  if (!checkRate(ip)) { reply.status(429); return { error: 'Rate limit exceeded' }; }
  if (requireActivePeer(req, reply) === false) {
    return { error: 'Peer list requires active peer registration' };
  }
  const peers = db.listPeers();
  return {
    nodeId: NODE_ID,
    count: peers.length,
    nodes: peers.map(p => ({
      url: p.url,
      identityPubkey: p.identity_pubkey || undefined,
      hotWalletPubkey: p.hot_wallet_pubkey || undefined,
    })),
  };
});

// Announce a peer — validated via URL/endpoint format check + liveness ping.
// Accepts both legacy (url only) and new format (endpoint + identityPubkey).
// Bidirectional: when a peer announces, we announce back if we have NODE_URL/NODE_ENDPOINT.
app.post('/sync/announce', async (req, reply) => {
  const ip = req.headers['x-real-ip'] || req.ip;
  if (!checkRate(ip, true)) {
    reply.status(429);
    return { error: 'Rate limited' };
  }

  const { url, endpoint, identityPubkey, hotWalletPubkey } = req.body || {};

  // Must have either a URL or endpoint
  const peerUrl = url || (endpoint ? endpointToUrl(endpoint) : null);
  if (!peerUrl) {
    reply.status(400);
    return { error: 'Missing url or endpoint' };
  }

  // Validate: URL format check (SSRF protection)
  if (url && !isValidPeerUrl(url)) {
    reply.status(400);
    return { error: 'Invalid peer URL — must be https:// (or http:// with public IPv4)' };
  }
  if (endpoint && !isValidEndpoint(endpoint)) {
    reply.status(400);
    return { error: 'Invalid endpoint — must be public IPv4:port (1024-65535)' };
  }

  // If identity is claimed, verify it matches the signed headers (prevents impersonation)
  const peerHdrs = extractPeerHeaders(req.headers);
  let verifiedIdentity = null;
  if (peerHdrs) {
    const sigResult = verifyPeerMessage(peerHdrs.identity, peerHdrs.message, peerHdrs.signature, 'sync-announce');
    if (sigResult.valid) {
      verifiedIdentity = peerHdrs.identity;
      // Claimed identity must match signed identity
      if (identityPubkey && identityPubkey !== verifiedIdentity) {
        reply.status(403);
        return { error: 'Identity mismatch — claimed pubkey does not match signed identity' };
      }
    }
  }

  // Verify the peer is actually running before registering
  const healthUrl = url || endpointToUrl(endpoint);
  const live = await isPeerLive(healthUrl);
  if (!live) {
    reply.status(400);
    return { error: 'Peer not reachable — must be a live Freeze Dry node' };
  }

  // Cap total peers to prevent peer-flood attacks
  const existingPeers = db.listPeers();
  const isExisting = existingPeers.some(p => p.url === peerUrl || (identityPubkey && p.identity_pubkey === identityPubkey));
  if (!isExisting && existingPeers.length >= MAX_PEERS) {
    reply.status(400);
    return { error: `Peer limit reached (${MAX_PEERS}) — remove stale peers first` };
  }

  // Only store identity if cryptographically verified (prevents impersonation)
  const storedIdentity = verifiedIdentity || null;
  db.upsertPeer(peerUrl, storedIdentity, hotWalletPubkey || null);

  // Bidirectional: announce back to the peer (with identity if available)
  const myUrl = NODE_URL || (process.env.NODE_ENDPOINT ? endpointToUrl(process.env.NODE_ENDPOINT) : null);
  if (myUrl && peerUrl !== myUrl) {
    let myIdentity = null, myHotWallet = null, authHeaders = {};
    try {
      const { getIdentityKeypair, getHotWallet } = await import('./wallet.js');
      const { buildPeerHeaders } = await import('./crypto-auth.js');
      myIdentity = getIdentityKeypair().publicKey.toBase58();
      myHotWallet = getHotWallet().publicKey.toBase58();
      authHeaders = buildPeerHeaders(getIdentityKeypair(), 'sync-announce');
    } catch (err) { app.log.warn(`Announce back: identity load failed — ${err.message}`); }
    try {
      await fetch(`${peerUrl}/sync/announce`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({
          url: NODE_URL || undefined,
          endpoint: process.env.NODE_ENDPOINT || undefined,
          identityPubkey: myIdentity,
          hotWalletPubkey: myHotWallet,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) { app.log.warn(`Announce back to ${peerUrl} failed — ${err.message}`); }
  }

  return { ok: true, registered: peerUrl };
});

// ─── Manifest sync (peer-to-peer bootstrap) ───
// New or recovering nodes ask a peer for all artwork metadata in one request.
// No blobs — just the index. Blobs fill lazily via gossip + CDN proxy.
//
// GET /sync/manifest          → full dump (all artworks)
// GET /sync/manifest?since=X  → delta (only new since timestamp)

app.get('/sync/manifest', (req, reply) => {
  if (requireActivePeer(req, reply) === false) {
    return { error: 'Manifest sync requires active peer registration. Use /sync/announce first.' };
  }

  const since = parseInt(req.query.since || '0', 10);
  const manifest = db.getManifest(since);

  reply.header('Content-Type', 'application/json');
  reply.header('Cache-Control', 'no-cache');
  return {
    nodeId: NODE_ID,
    since,
    count: manifest.count,
    latest: manifest.latest,
    artworks: manifest.artworks,
  };
});

// ─── Gossip notify receiver (v7 — lightweight hash-only notifications) ───
// Peer says "I have hash X" (~200 bytes). We decide whether to pull the blob.
// Then we notify 2 more peers. Logarithmic spread, bandwidth only where needed.

app.post('/sync/notify', async (req, reply) => {
  if (requireActivePeer(req, reply) === false) {
    return { error: 'Gossip notify requires active peer registration. Use /sync/announce first.' };
  }

  // Identify sender: prefer identity pubkey, fall back to X-Node-URL
  const peerInfo = extractPeerHeaders(req.headers);
  const senderUrl = (peerInfo && peerInfo.identity) || req.headers['x-node-url'] || '';

  // Gossip rate limit — per-peer, prevents notification spam
  if (!checkGossipRate(senderUrl || req.ip)) {
    addStrike(senderUrl, 'gossip-rate-exceeded');
    reply.status(429);
    return { error: 'Gossip rate limit exceeded' };
  }

  const { hash, chunkCount, size, sourceUrl } = req.body || {};
  if (!hash) { reply.status(400); return { error: 'Missing hash' }; }
  if (!isValidHash(hash)) {
    addStrike(senderUrl, 'invalid-hash');
    reply.status(400);
    return { error: 'Invalid hash format' };
  }

  // Already have it? ACK but don't pull
  const existing = db.getArtwork(hash);
  if (existing && existing.complete) {
    return { status: 'already-complete', hash };
  }

  // Pruned? ACK but don't pull or re-store
  if (db.isPruned(hash)) {
    return { status: 'pruned-tombstone', hash };
  }

  // Dedup: if we're already pulling this hash, don't start another pull
  if (pendingPulls.has(hash)) {
    return { status: 'pull-in-progress', hash };
  }

  // ACK immediately — pull happens in background (don't block the notifier)
  const incomingOrigins = (req.headers['x-gossip-origin'] || '').split(',').filter(Boolean);
  const allOrigins = [...new Set([...incomingOrigins, senderUrl].filter(Boolean))];

  // Background: pull blob from source, then notify 2 more peers
  pendingPulls.add(hash);
  (async () => {
    try {
      const pulled = await pullBlob(hash, sourceUrl || senderUrl, chunkCount || 0);
      if (pulled) {
        const nodeUrl = process.env.NODE_URL || '';
        if (nodeUrl) allOrigins.push(nodeUrl);
        gossipBlob(hash, chunkCount || 0, allOrigins, size || 0).catch(() => {});
      }
    } catch (err) {
      app.log.warn(`Gossip: pull failed for ${hash.slice(0, 20)}... — ${err.message}`);
    } finally {
      pendingPulls.delete(hash);
    }
  })();

  return { status: 'notified', hash };
});

// ─── Gossip push receiver (v6 backward compat — full blob push) ───
// Kept for v6 nodes that haven't upgraded yet. Accepts full blob in body.
// v7 nodes use /sync/notify instead (hash-only, pull on demand).

app.post('/sync/push', async (req, reply) => {
  if (requireActivePeer(req, reply) === false) {
    return { error: 'Gossip push requires active peer registration. Use /sync/announce first.' };
  }

  const pushPeerInfo = extractPeerHeaders(req.headers);
  const senderUrl = (pushPeerInfo && pushPeerInfo.identity) || req.headers['x-node-url'] || req.ip || '';

  // Gossip rate limit
  if (!checkGossipRate(senderUrl)) {
    addStrike(senderUrl, 'gossip-push-rate-exceeded');
    reply.status(429);
    return { error: 'Gossip rate limit exceeded' };
  }

  const { hash, chunkCount, data, size } = req.body || {};
  if (!hash || !chunkCount || !data) {
    reply.status(400);
    return { error: 'Missing hash, chunkCount, or data' };
  }
  if (!isValidHash(hash)) {
    addStrike(senderUrl, 'invalid-hash-push');
    reply.status(400);
    return { error: 'Invalid hash format' };
  }

  // Short-circuit: already have this blob complete
  const existing = db.getArtwork(hash);
  if (existing && existing.complete) {
    return { status: 'already-complete', hash };
  }

  // Anti-loop: if this blob was pruned, ACK but don't re-store
  if (db.isPruned(hash)) {
    return { status: 'pruned-tombstone', hash };
  }

  // Decode and verify integrity
  const blobBuf = Buffer.from(data, 'base64');
  const hashMatch = verifyBlobHash(blobBuf, hash);
  if (!hashMatch) {
    addStrike(senderUrl, 'hash-mismatch-push');
    reply.status(400);
    return { error: 'Hash mismatch — blob integrity check failed', expected: hash.slice(0, 24) };
  }

  // Store the blob
  db.upsertArtwork({
    hash, chunkCount, blobSize: size || blobBuf.length,
    width: null, height: null, mode: 'open', network: 'mainnet',
    pointerSig: null, chunks: null,
  });
  db.storeBlob(hash, blobBuf);

  app.log.info(`Gossip(v6-compat): received ${hash.slice(0, 20)}... (${blobBuf.length}B) from peer`);

  // Forward as v7 notification (not full push — prevent bandwidth cascade)
  const incomingOrigins = (req.headers['x-gossip-origin'] || '').split(',').filter(Boolean);
  const allOrigins = [...new Set([...incomingOrigins, senderUrl].filter(Boolean))];
  gossipBlob(hash, chunkCount, allOrigins, blobBuf.length).catch(() => {});

  return { status: 'accepted', hash };
});

// ─── Marketplace status route ───

// HELIUS_PLAN auto-enables marketplace for developer+ tiers
const _planPresets = { free: false, developer: true, business: true, geyser: true };
const _planKey = (process.env.HELIUS_PLAN || '').toLowerCase();
const _planDefault = _planPresets[_planKey] ?? false;
const MARKETPLACE_ENABLED = process.env.MARKETPLACE_ENABLED
  ? process.env.MARKETPLACE_ENABLED === 'true'
  : _planDefault;
let _claimerStatus = null;
let _attesterStatus = null;

app.get('/marketplace/status', () => {
  return {
    enabled: MARKETPLACE_ENABLED,
    claimer: _claimerStatus ? _claimerStatus() : null,
    attester: _attesterStatus ? _attesterStatus() : null,
  };
});

// ─── Marketplace queue monitoring ───

app.get('/marketplace/queue', () => {
  if (!MARKETPLACE_ENABLED || !_claimerStatus) {
    return { error: 'Marketplace not enabled on this node' };
  }
  const status = _claimerStatus();
  const q = status.queue || { depth: 0, oldestJobId: null, oldestJobAge: 0, staleCount: 0, snapshotAt: 0 };

  // Human-readable age
  let oldestAgeHuman = 'n/a';
  if (q.oldestJobAge > 0) {
    const h = Math.floor(q.oldestJobAge / 3600);
    const m = Math.floor((q.oldestJobAge % 3600) / 60);
    oldestAgeHuman = h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  return {
    depth: q.depth,
    oldestJob: q.oldestJobId ? {
      jobId: q.oldestJobId,
      ageSeconds: q.oldestJobAge,
      ageHuman: oldestAgeHuman,
    } : null,
    staleCount: q.staleCount,
    activeClaims: status.activeClaims,
    maxCapacity: status.maxConcurrent,
    snapshotAt: q.snapshotAt ? new Date(q.snapshotAt).toISOString() : null,
  };
});

// ─── Start ───

async function start() {
  try {
    // Register writer routes before listening (if writer role)
    if (isWriter) {
      try {
        const { registerWriterRoutes } = await import('./writer/routes.js');
        registerWriterRoutes(app);
        // Initialize WebSocket connection for fast confirms (if enabled)
        const { USE_WEBSOCKET } = await import('./config.js');
        if (USE_WEBSOCKET) {
          const heliusKey = process.env.HELIUS_API_KEY;
          const customWs = process.env.HELIUS_WS_URL;
          if (!heliusKey && !customWs) {
            app.log.warn('USE_WEBSOCKET=true but no HELIUS_API_KEY or HELIUS_WS_URL set — WS confirms will use public endpoint (slower). Set HELIUS_API_KEY for best performance.');
          }
          const { initWsConnection } = await import('./writer/ws-confirm.js');
          initWsConnection();
          app.log.info('WebSocket confirms enabled');
        }
      } catch (err) {
        console.warn(`Writer routes unavailable (${err.message}) — running in reader-only mode`);
      }
    }

    const HOST = process.env.BIND_HOST || '127.0.0.1';
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`Freeze Dry Node (${NODE_ID}) listening on :${PORT} [role=${ROLE}]`);

    // Start the chain indexer (if reader role)
    if (isReader) {
      startIndexer(app.log);
    }

    // Start blob cache pruning sweep (every 6 hours, if configured)
    if (BLOB_CACHE_DAYS > 0 || BLOB_CACHE_MAX_MB > 0) {
      app.log.info(`Pruning: enabled (maxAge=${BLOB_CACHE_DAYS}d, maxSize=${BLOB_CACHE_MAX_MB}MB) — sweep every 6h`);
      setInterval(() => {
        try {
          const result = db.pruneStaleBlobsLRU(BLOB_CACHE_DAYS, BLOB_CACHE_MAX_MB);
          if (result.evicted > 0) {
            app.log.info(`Pruning: evicted ${result.evicted} blob(s), freed ${(result.freedBytes / 1024 / 1024).toFixed(1)}MB`);
          }
        } catch (err) {
          app.log.warn(`Pruning: sweep error — ${err.message}`);
        }
      }, 6 * 60 * 60 * 1000); // 6 hours
    }

    // Start marketplace claimer/attester (if enabled)
    if (MARKETPLACE_ENABLED) {
      if (isWriter) {
        try {
          const { startClaimer, getClaimerStatus } = await import('./writer/claimer.js');
          startClaimer();
          _claimerStatus = getClaimerStatus;
        } catch (err) {
          console.warn(`Marketplace claimer unavailable (${err.message})`);
        }
      }
      if (isReader) {
        try {
          const { startAttester, getAttesterStatus } = await import('./reader/attester.js');
          startAttester();
          _attesterStatus = getAttesterStatus;
        } catch (err) {
          console.warn(`Marketplace attester unavailable (${err.message})`);
        }
      }
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
