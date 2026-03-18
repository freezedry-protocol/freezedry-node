#!/usr/bin/env node
/**
 * register-onchain.mjs — Register this node on the Solana registry program.
 *
 * Required for Jobs marketplace (claim_job + attest both verify NodeAccount PDA).
 * Node wallet signs + pays ~0.003 SOL PDA rent.
 *
 * Usage: node scripts/register-onchain.mjs
 *   Reads WALLET_KEYPAIR, NODE_ID, NODE_URL, HELIUS_API_KEY from .env
 */

import { Keypair, Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env manually (no dotenv dependency)
function loadEnv() {
  // Try DATA_DIR first (production), then repo .env
  const paths = [
    process.env.DATA_DIR ? join(process.env.DATA_DIR, '.env') : null,
    join(__dirname, '..', '.env'),
  ].filter(Boolean);

  for (const p of paths) {
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
    break;
  }
}
loadEnv();

const REGISTRY_PROGRAM = new PublicKey(
  process.env.REGISTRY_PROGRAM_ID || '6UGJUc28AuCj8a8sjhsVEKbvYHfQECCuJC7i54vk2to'
);

async function main() {
  // Parse wallet
  const raw = (process.env.WALLET_KEYPAIR || '').trim();
  if (!raw) {
    console.error('WALLET_KEYPAIR not set in .env');
    process.exit(1);
  }
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));

  const nodeId = process.env.NODE_ID || 'freezedry-node';
  // Accept NODE_URL (domain) or NODE_ENDPOINT (ip:port)
  const endpoint = process.env.NODE_ENDPOINT || '';
  const nodeUrl = process.env.NODE_URL || (endpoint ? `http://${endpoint}` : '');
  if (!nodeUrl) {
    console.error('NODE_URL or NODE_ENDPOINT not set in .env');
    process.exit(1);
  }

  const rpcKey = process.env.HELIUS_API_KEY;
  const rpcUrl = process.env.JOBS_RPC_URL || (rpcKey
    ? `https://mainnet.helius-rpc.com/?api-key=${rpcKey}`
    : 'https://api.mainnet-beta.solana.com');

  const conn = new Connection(rpcUrl, 'confirmed');

  // Derive NodeAccount PDA
  const [nodePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('freeze-node'), kp.publicKey.toBuffer()],
    REGISTRY_PROGRAM
  );

  console.log(`\n  On-Chain Node Registration`);
  console.log(`  Registry:  ${REGISTRY_PROGRAM.toBase58()}`);
  console.log(`  Wallet:    ${kp.publicKey.toBase58()}`);
  console.log(`  NodePDA:   ${nodePDA.toBase58()}`);
  console.log(`  Node ID:   ${nodeId}`);
  console.log(`  URL:       ${nodeUrl}`);
  console.log(`  Role:      Both (2)\n`);

  // Check if already registered
  const existing = await conn.getAccountInfo(nodePDA);
  if (existing) {
    console.log('  Already registered on-chain. Done.\n');
    process.exit(0);
  }

  // Check balance
  const balance = await conn.getBalance(kp.publicKey);
  const balSOL = balance / 1e9;
  console.log(`  Balance:   ${balSOL.toFixed(6)} SOL`);
  if (balance < 5_000_000) { // ~0.005 SOL minimum
    console.error('  Insufficient balance. Need at least 0.005 SOL for PDA rent + TX fee.');
    process.exit(1);
  }

  // Build register_node instruction
  // Anchor discriminator: sha256("global:register_node")[0..8]
  const discriminator = Buffer.from([34, 206, 182, 33, 207, 202, 234, 188]);

  const nodeIdBuf = Buffer.from(nodeId);
  const urlBuf = Buffer.from(nodeUrl);
  const role = 2; // Both

  const data = Buffer.alloc(8 + 4 + nodeIdBuf.length + 4 + urlBuf.length + 1);
  let offset = 0;
  discriminator.copy(data, offset); offset += 8;
  data.writeUInt32LE(nodeIdBuf.length, offset); offset += 4;
  nodeIdBuf.copy(data, offset); offset += nodeIdBuf.length;
  data.writeUInt32LE(urlBuf.length, offset); offset += 4;
  urlBuf.copy(data, offset); offset += urlBuf.length;
  data.writeUInt8(role, offset); offset += 1;

  const ix = new TransactionInstruction({
    programId: REGISTRY_PROGRAM,
    keys: [
      { pubkey: nodePDA, isSigner: false, isWritable: true },
      { pubkey: kp.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: data.slice(0, offset),
  });

  const { blockhash } = await conn.getLatestBlockhash();
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: kp.publicKey })
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 }))
    .add(ix);
  tx.sign(kp);

  console.log('  Sending register_node TX...');
  const sig = await conn.sendRawTransaction(tx.serialize());
  console.log(`  TX: ${sig}`);

  const conf = await conn.confirmTransaction(sig, 'confirmed');
  if (conf.value.err) {
    console.error('  TX failed:', JSON.stringify(conf.value.err));
    process.exit(1);
  }
  console.log('  Confirmed.');

  // Verify
  const info = await conn.getAccountInfo(nodePDA);
  if (info) {
    console.log(`  Registered on-chain (${info.data.length} bytes PDA)\n`);
  } else {
    console.error('  WARNING: TX confirmed but PDA not found. Check explorer.\n');
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
