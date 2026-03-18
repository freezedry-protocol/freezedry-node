#!/usr/bin/env node
/**
 * pull-collection.mjs — Download all images from a Solana NFT collection
 * Uses Helius DAS API (getAssetsByGroup) to fetch metadata, then downloads images.
 *
 * Usage:
 *   node scripts/pull-collection.mjs <collection_address> [--out ./collection-images] [--limit 100]
 *
 * Examples:
 *   # Pull all SMB Gen2
 *   node scripts/pull-collection.mjs SMBtHCCC6RYRutFEPb4gZqeBLUZbMNhRKaMKZZoPkWJ
 *
 *   # Pull first 50 from any collection
 *   node scripts/pull-collection.mjs <address> --limit 50
 *
 * Requires: HELIUS_API_KEY in .env or environment
 */

import { readFileSync, mkdirSync, createWriteStream, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Parse args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (!args[0] || args[0] === '--help') {
  console.log('Usage: node scripts/pull-collection.mjs <collection_address> [--out ./dir] [--limit N] [--concurrency N]');
  console.log('\nKnown collections:');
  console.log('  SMB Gen2:    SMBtHCCC6RYRutFEPb4gZqeBLUZbMNhRKaMKZZoPkWJ');
  console.log('  DeGods:      6XxjKYFbcndh2gDcsUrmZgVEsoDGXMXUfMXY9WMraiEh');
  console.log('  Mad Lads:    J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w');
  console.log('  y00ts:       4mKSoDDqApmF1DqXvVTSL6tu2e7Z9kGnnMDhTSFLCB4h');
  process.exit(0);
}

const collectionAddress = args[0];
const outIdx = args.indexOf('--out');
const outDir = outIdx !== -1 ? args[outIdx + 1] : `./collection-${collectionAddress.slice(0, 8)}`;
const limitIdx = args.indexOf('--limit');
const maxImages = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;
const concIdx = args.indexOf('--concurrency');
const concurrency = concIdx !== -1 ? parseInt(args[concIdx + 1], 10) : 5;
const useCreator = args.includes('--creator'); // Use getAssetsByCreator instead of getAssetsByGroup

// ── Load API key ────────────────────────────────────────────────────────
let apiKey = process.env.HELIUS_API_KEY;
if (!apiKey) {
  try {
    const envFile = readFileSync(join(__dirname, '..', '.env'), 'utf8');
    const match = envFile.match(/^HELIUS_API_KEY=(.+)$/m);
    if (match) apiKey = match[1].trim();
  } catch { /* no .env */ }
}
if (!apiKey) {
  console.error('Error: HELIUS_API_KEY not found in env or .env file');
  process.exit(1);
}

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

// ── Fetch all assets via DAS ────────────────────────────────────────────
async function fetchAssets(address, page = 1, pageSize = 1000) {
  const method = useCreator ? 'getAssetsByCreator' : 'getAssetsByGroup';
  const params = useCreator
    ? { creatorAddress: address, page, limit: pageSize }
    : { groupKey: 'collection', groupValue: address, page, limit: pageSize };

  const resp = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: `page-${page}`, method, params }),
  });

  if (!resp.ok) {
    throw new Error(`DAS API error: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json();
  if (data.error) {
    throw new Error(`DAS error: ${data.error.message || JSON.stringify(data.error)}`);
  }

  return data.result;
}

// ── Download image ──────────────────────────────────────────────────────
async function downloadImage(url, filepath) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!resp.ok) return false;

  const contentType = resp.headers.get('content-type') || '';
  let ext = '.png';
  if (contentType.includes('jpeg') || contentType.includes('jpg')) ext = '.jpg';
  else if (contentType.includes('gif')) ext = '.gif';
  else if (contentType.includes('webp')) ext = '.webp';
  else if (contentType.includes('avif')) ext = '.avif';
  else if (contentType.includes('svg')) ext = '.svg';

  const finalPath = filepath.replace(/\.[^.]+$/, ext);
  const buffer = Buffer.from(await resp.arrayBuffer());
  const { writeFileSync } = await import('fs');
  writeFileSync(finalPath, buffer);
  return { path: finalPath, bytes: buffer.length };
}

// ── Concurrent download pool ────────────────────────────────────────────
async function downloadPool(tasks, poolSize) {
  let idx = 0;
  let completed = 0;
  let failed = 0;
  let totalBytes = 0;
  const total = tasks.length;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      const { name, url, filepath } = tasks[i];
      try {
        const result = await downloadImage(url, filepath);
        if (result) {
          completed++;
          totalBytes += result.bytes;
          if (completed % 25 === 0 || completed === total) {
            console.log(`  [${completed}/${total}] ${(totalBytes / 1024 / 1024).toFixed(1)} MB downloaded`);
          }
        } else {
          failed++;
          console.warn(`  SKIP ${name}: download failed`);
        }
      } catch (err) {
        failed++;
        console.warn(`  SKIP ${name}: ${err.message}`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(poolSize, tasks.length) }, () => worker());
  await Promise.all(workers);
  return { completed, failed, totalBytes };
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nPulling collection: ${collectionAddress}`);
  console.log(`Output: ${outDir}`);
  console.log(`Limit: ${maxImages === Infinity ? 'all' : maxImages}`);
  console.log(`Concurrency: ${concurrency}\n`);

  mkdirSync(outDir, { recursive: true });

  // Paginate through all assets
  let page = 1;
  let allAssets = [];
  const pageSize = 1000;

  while (true) {
    console.log(`Fetching page ${page}...`);
    const result = await fetchAssets(collectionAddress, page, pageSize);
    const items = result.items || [];

    if (items.length === 0) break;
    allAssets = allAssets.concat(items);
    console.log(`  Got ${items.length} assets (total: ${allAssets.length})`);

    if (allAssets.length >= maxImages) {
      allAssets = allAssets.slice(0, maxImages);
      break;
    }
    if (items.length < pageSize) break;
    page++;

    // Small delay between pages to respect rate limits
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\nTotal assets found: ${allAssets.length}`);

  // Build download tasks
  const tasks = [];
  for (const asset of allAssets) {
    const imageUrl = asset.content?.links?.image;
    if (!imageUrl) {
      console.warn(`  SKIP ${asset.id}: no image URL`);
      continue;
    }

    // Use NFT name or index for filename
    const name = (asset.content?.metadata?.name || asset.id).replace(/[^a-zA-Z0-9_#-]/g, '_');
    const filepath = join(outDir, `${name}.png`); // extension will be corrected on download

    // Skip if already downloaded
    if (existsSync(filepath) || existsSync(filepath.replace('.png', '.jpg')) || existsSync(filepath.replace('.png', '.webp'))) {
      continue;
    }

    tasks.push({ name, url: imageUrl, filepath });
  }

  if (tasks.length === 0) {
    console.log('All images already downloaded (or no images found).');
    return;
  }

  console.log(`Downloading ${tasks.length} images (${allAssets.length - tasks.length} already exist)...\n`);
  const start = Date.now();
  const { completed, failed, totalBytes } = await downloadPool(tasks, concurrency);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`\nDone in ${elapsed}s`);
  console.log(`  Downloaded: ${completed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total size: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  Output: ${outDir}`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
