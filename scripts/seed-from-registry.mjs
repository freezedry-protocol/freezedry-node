#!/usr/bin/env node
/**
 * seed-from-registry.mjs — Recover blobs from Vercel registry
 *
 * Use this to reseed a node's blob cache from the coordinator's registry.
 * Fetches .hyd blobs via their Vercel Blob URLs (no chain reads, no Helius credits).
 *
 * Usage: node scripts/seed-from-registry.mjs [--registry URL]
 */

import * as db from '../src/db.js';

const CHUNK_SIZE = 585;
const REGISTRY = process.argv.includes('--registry')
  ? process.argv[process.argv.indexOf('--registry') + 1]
  : 'https://freezedry.art/api/registry';

async function main() {
  console.log(`Seeding blobs from registry: ${REGISTRY}`);

  // 1. List all artworks from registry
  const listResp = await fetch(`${REGISTRY}?action=list`);
  if (!listResp.ok) {
    console.error('Failed to fetch registry list:', listResp.status);
    process.exit(1);
  }
  const { artworks } = await listResp.json();
  console.log(`Registry has ${artworks.length} artworks\n`);

  let seeded = 0, skipped = 0, failed = 0;

  for (const art of artworks) {
    const shortHash = art.hash.slice(0, 35);

    // Skip if we already have this blob
    const existing = db.getBlob(art.hash);
    if (existing) {
      skipped++;
      continue;
    }

    try {
      // Get full record with blobUrl
      const getResp = await fetch(
        `${REGISTRY}?action=get&hash=${encodeURIComponent(art.hash)}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!getResp.ok) {
        failed++;
        console.log(`  SKIP: ${shortHash} — registry returned ${getResp.status}`);
        continue;
      }

      const rec = await getResp.json();
      if (!rec.blobUrl) {
        failed++;
        console.log(`  SKIP: ${shortHash} — no blobUrl in record`);
        continue;
      }

      // Fetch .hyd blob from Vercel Blob storage
      const blobResp = await fetch(rec.blobUrl, { signal: AbortSignal.timeout(30000) });
      if (!blobResp.ok) {
        failed++;
        console.log(`  FAIL: ${shortHash} — blob fetch returned ${blobResp.status}`);
        continue;
      }

      const buf = Buffer.from(await blobResp.arrayBuffer());
      const isHYD = buf.length >= 49 && buf[0] === 0x48 && buf[1] === 0x59 && buf[2] === 0x44;
      const width = isHYD ? buf.readUInt16LE(5) : (art.width || 0);
      const height = isHYD ? buf.readUInt16LE(7) : (art.height || 0);
      const chunkCount = art.chunkCount || Math.ceil(buf.length / CHUNK_SIZE);

      // Create artwork row FIRST, then store blob (storeBlob marks complete
      // via UPDATE — row must exist or the markComplete is a no-op).
      db.upsertArtwork({
        hash: art.hash,
        chunkCount,
        blobSize: buf.length,
        width,
        height,
        mode: art.mode || 'open',
      });
      db.storeBlob(art.hash, buf);

      seeded++;
      console.log(`  OK: ${shortHash} — ${(buf.length / 1024).toFixed(0)}KB`);
    } catch (e) {
      failed++;
      console.log(`  ERR: ${shortHash} — ${e.message}`);
    }
  }

  console.log(`\nDone: ${seeded} seeded, ${skipped} already had, ${failed} failed`);
}

main().catch(e => { console.error(e); process.exit(1); });
