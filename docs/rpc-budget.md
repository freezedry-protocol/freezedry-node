# RPC Credit Budget Guide

> Every Helius plan has a monthly credit limit. Burn it and your node goes dark.
> This guide explains how credits are consumed and how to protect your subscription.
>
> **For tier presets and "what can my server do?" → see [node-tiers.md](node-tiers.md)**

## Helius Plans

| Plan | Credits/Month | RPS | Price | Best For |
|------|--------------|-----|-------|----------|
| Free | 1,000,000 | 10 | $0 | Reader-only, gossip relay |
| Developer | 10,000,000 | 50 | $49/mo | Full node (read + write) |
| Business | 100,000,000 | 200 | $499/mo | High-throughput inscriber |
| Validator (Geyser) | N/A | N/A | Validator costs | Zero RPC, real-time indexing |

## Credit Costs (Helius)

| Method | Credits | Example |
|--------|---------|---------|
| Standard RPC (getTransaction, getAccountInfo, etc.) | 1 | Job status check |
| getProgramAccounts | 1 | Open jobs scan |
| sendTransaction | 1 | Memo inscription |
| Enhanced API (batch parse, address history) | 100 per 100 results | Chain scan (EXPENSIVE) |
| DAS API (getAsset, getAssetsByOwner) | 100 | Membership check |

---

## Node Roles

A FreezeDry node can run one or more roles:

| Role | What It Does | Idle Credits/Month | Needs Helius? |
|------|-------------|-------------------|---------------|
| **Reader** (indexer) | Discovers artworks, serves blobs | ~60K (scan safety net) | Yes (or Geyser) |
| **Writer** (inscriber) | Inscribes artwork to Solana memos | 0 idle, ~1.05 credits/chunk active | Yes |
| **Claimer** (marketplace) | Claims + executes delegated jobs | ~3.5K (polling) | Yes |
| **Attester** (marketplace) | Verifies inscriptions, releases payment | ~3K (polling) | Yes |
| **Gossip relay** | Receives + relays blobs peer-to-peer | 0 | No |
| **POD reporter** | Submits delivery receipts on-chain | ~2K | Yes (devnet) |

---

## Per-Job Inscription Cost

Every chunk = 1 `sendTransaction` + confirmation overhead.
585-byte chunks (MEMO_PAYLOAD_SIZE) of payload per memo.

| File Size | Chunks | Credits (inscribe) | Time @ 50 RPS | Time @ 10 RPS |
|-----------|--------|-------------------|---------------|---------------|
| 100 KB | ~167 | ~185 | ~4 sec | ~17 sec |
| 500 KB | ~833 | ~885 | ~17 sec | ~84 sec |
| 1 MB | ~1,667 | ~1,760 | ~34 sec | ~167 sec |
| 3 MB | ~5,000 | ~5,260 | ~100 sec | ~500 sec |
| 5 MB | ~8,333 | ~8,760 | ~167 sec | ~14 min |

Formula: `credits ≈ chunks × 1.05 + 10`

---

## Tier Presets

**Quick setup:** Set `HELIUS_PLAN=free|developer|business|geyser` in `.env` and the node
auto-configures `CREDIT_BUDGET` and `MARKETPLACE_ENABLED`. Individual env vars still override.

| `HELIUS_PLAN` | `CREDIT_BUDGET` | `MARKETPLACE_ENABLED` | Best For |
|---------------|----------------|----------------------|----------|
| *(omit)* | 10,000,000 | false | Manual config |
| `free` | 1,000,000 | false | Small reader, occasional writer |
| `developer` | 10,000,000 | true | Full marketplace node |
| `business` | 100,000,000 | true | High-volume inscriber |
| `geyser` | 0 | true | Validator (no Helius needed) |

### Tier 0: Gossip-Only (Free, No Helius Key)

**Role**: Blob relay + peer sync. No chain reads or writes.

```bash
# .env
# HELIUS_API_KEY=           # omit — no RPC at all
# Replace with discovered peers or bootstrap from coordinator
PEER_NODES=https://peer1.example.com,https://peer2.example.com
CREDIT_BUDGET=0
```

**What it can do:**
- Receive blobs from gossip network
- Serve blobs to CDN and peers via `GET /blob/:hash`
- Participate in gossip propagation
- Register with coordinator (HTTP, no RPC)

**What it can't do:**
- Discover new artworks from chain (no scan)
- Inscribe memos (no sendTransaction)
- Fill incomplete artworks from chain
- Claim or attest marketplace jobs

**Monthly credits: 0**
**Monthly cost: $0 + server**

---

### Tier 1: Free Reader (Free Helius Plan — 1M credits)

**Role**: Indexer + blob server. Discovers artworks, serves to CDN.

```bash
# .env
HELIUS_API_KEY=your-free-key
POLL_INTERVAL=3600000          # 1hr scan (safety net)
CREDIT_BUDGET=1000000          # 1M cap
MAX_FILL_PER_CYCLE=0           # peers only
GENESIS_SIG=5aa34bHQVMFWd3faWG6keuUSs1DQDJqD8RAxytbH1nbSrsCxXSrTtn9voJ7GXVagUcTXRX8eAQmuBWZMScSimNfk
# Replace with discovered peers or bootstrap from coordinator
PEER_NODES=https://peer1.example.com,https://peer2.example.com
```

**What it can do:**
- Discover new artworks from chain (standard RPC, not Enhanced API)
- Serve blobs to CDN and peers
- Participate in gossip
- Register with coordinator

**What it can't do:**
- Inscribe (limited to 10 RPS — too slow for reliable inscription)
- Use Enhanced API (Free plan gets 403)
- Chain fill (disabled, too expensive)

**Monthly idle: ~60K credits (6% of budget)**
**Available for on-demand: ~940K credits**
**Monthly cost: $0 + server**

---

### Tier 2: Paid Reader + Writer (Developer Plan — 10M credits)

**Role**: Full node. Indexes, serves, inscribes, participates in marketplace.

```bash
# .env
HELIUS_API_KEY=your-paid-key
HELIUS_RPC_URL=https://your-dedicated.helius-rpc.com
POLL_INTERVAL=3600000          # 1hr scan
CLAIM_POLL_INTERVAL=60000      # 60s job poll
CREDIT_BUDGET=10000000         # 10M cap
MAX_FILL_PER_CYCLE=0           # peers first
MARKETPLACE_ENABLED=true       # claim + attest jobs
GENESIS_SIG=5aa34bHQVMFWd3faWG6keuUSs1DQDJqD8RAxytbH1nbSrsCxXSrTtn9voJ7GXVagUcTXRX8eAQmuBWZMScSimNfk
# Replace with discovered peers or bootstrap from coordinator
PEER_NODES=https://peer1.example.com,https://peer2.example.com
```

**What it can do:**
- Everything Tier 1 can do, plus:
- Enhanced API scanning (faster discovery)
- Inscribe artworks (50 RPS — 5MB file in ~3 min)
- Claim and execute marketplace jobs
- Attest other nodes' inscriptions
- Auto-release payments on quorum

**Idle: ~67K credits/month (scan + claim + attest polling = 0.67%)**
**Available for jobs: ~9.93M credits**

| Jobs/Day | Avg File Size | Monthly Credits | % of Budget |
|----------|--------------|----------------|-------------|
| 1 | 500 KB | ~94K | 0.9% |
| 5 | 500 KB | ~200K | 2% |
| 5 | 3 MB | ~857K | 8.6% |
| 10 | 1 MB | ~595K | 6% |
| 20 | 1 MB | ~1.12M | 11% |
| 30 | 3 MB | ~4.8M | 48% |

**Can inscribe ~34 five-MB files per day (1,036/month).**
**Monthly cost: $49 + server**

---

### Tier 3: High-Throughput (Business Plan — 100M credits)

```bash
# .env
HELIUS_API_KEY=your-business-key
POLL_INTERVAL=3600000
CLAIM_POLL_INTERVAL=30000      # 30s — faster job pickup
CREDIT_BUDGET=100000000
MAX_FILL_PER_CYCLE=0
MARKETPLACE_ENABLED=true
```

**Can inscribe ~377 five-MB files per day (11,301/month).**
**200 RPS — 5MB file in ~42 seconds.**
**Monthly cost: $499 + server**

---

### Tier 4: Validator Node (Geyser Plugin)

**Role**: Direct chain access. Zero external API costs.

```bash
# .env
# HELIUS_API_KEY=            # not needed
GEYSER_ENABLED=true          # future: real-time memo stream
GEYSER_ENDPOINT=ws://localhost:10000
CREDIT_BUDGET=0              # no Helius = no budget
# Replace with discovered peers or bootstrap from coordinator
PEER_NODES=https://peer1.example.com
```

**What it can do:**
- Real-time memo indexing (no polling, no scan)
- Direct chain reads from validator state
- Inscription via validator's own RPC (no rate limit)
- Everything a paid node can do, faster and free

**What it replaces:**
- Safety scan → real-time Geyser push (no polling)
- Chain fill → real-time chunk capture
- Webhook → Geyser IS the webhook
- Enhanced API → direct validator state

**Monthly credits: 0**
**Monthly cost: validator infrastructure only**

> **Note**: Geyser support is marked TODO in the node template. The indexer
> needs a gRPC/WebSocket listener that feeds transactions into the existing
> `processPointerMemo()` pipeline. When implemented, this is the ultimate setup.

---

### Tier 5: Read-Only Validator (RPC Provider)

**Role**: Serves FreezeDry data from validator state. No inscription.

This is the answer for "what about read-only validators?":

```
Validator runs Geyser plugin → captures all FREEZEDRY memo txs in real-time
  → stores in local SQLite → serves via HTTP GET /blob/:hash
  → registered in on-chain PDA registry → CDN discovers and races
  → earns POD (Proof of Delivery) receipts for serving data
```

**Cost to validator**: Zero marginal cost. FreezeDry data is a tiny fraction of
Solana's transaction throughput. The Geyser filter only captures memos from
one server wallet — negligible overhead.

**Value to validator**:
- Strengthens Solana ecosystem (permanent data availability)
- Earns POD rewards (when POD mainnet launches)
- Stake-weighted priority: staked validators get 200ms head start in CDN races
- Preferred-validator slot: if set in RegistryConfig, gets 0ms delay (instant)

**Key points for validators:**
- A read-only validator doesn't inscribe — it just indexes and serves
- Zero API costs, zero credit burn
- Blob storage: ~10MB for current 16 artworks, grows linearly
- SQLite WAL mode — no locks, no contention with validator
- One PDA registration on mainnet (~0.003 SOL rent)
- Heartbeat every 20 min (HTTP to coordinator, not RPC)

---

## Default Safety Mechanisms

All of these are built into the node and active by default:

| Protection | Default | What It Does |
|-----------|---------|-------------|
| `CHAIN_FILL` | `false` | Chain reads disabled — peers/gossip only |
| `CREDIT_BUDGET` | `10,000,000` | Monthly credit cap (circuit breaker at 80%) |
| `MAX_FILL_PER_CYCLE` | `0` | No chain fill attempts per scan cycle |
| `MAX_FILL_ATTEMPTS` | `5` | Give up on artwork after 5 failed peer fetches |
| `POLL_INTERVAL` | `3,600,000` (1 hr) | Scan is safety net only — webhooks are primary |
| `GENESIS_SIG` | Set in .env.example | Prevents backward scan past first inscription |
| 429 backoff | Exponential | 60s → 120s → 240s → ... → 15min max |
| Webhook gating | Automatic | Scan skipped when webhooks active (except every 6th poll) |

**A community node with default settings will NOT burn through credits overnight.**

---

## Where Credits Go (Full Stack)

### Node (Polling — Idle)

| Component | Credits/Month | Notes |
|-----------|--------------|-------|
| Scan safety net (1hr, Enhanced) | ~12K | 4 scans/day × 500 credits × 30 days |
| Scan safety net (1hr, Standard) | ~4K | Free plan: getSignaturesForAddress |
| Claimer polling (60s) | ~3.5K | getProgramAccounts every 60s |
| Attester polling (30s) | ~3K | getProgramAccounts every 30s |
| ZombieSlayer (5min) | ~576 | gPA + getAccountInfo every 5 min |
| POD flush (5min) | ~2K | blockhash + sendTransaction |
| **Total idle (all roles, paid)** | **~21K** | 0.2% of Developer plan |

### Node (Per-Job — Active)

| Action | Credits | Notes |
|--------|---------|-------|
| Claim job | ~4 | gPA + blockhash + send + confirm |
| Inscribe (per chunk) | ~1.05 | sendTransaction + confirm overhead |
| Submit receipt | ~3 | blockhash + send + confirm |
| Attest | ~5 | blockhash + send + confirm + getAccountInfo |
| Release payment | ~4 | blockhash + send + confirm + 2× getAccountInfo |
| **Full job (500 chunks)** | **~541** | claim + inscribe + receipt + peer attest |

### Vercel (User-Driven — Per Request)

| Endpoint | Credits | Trigger |
|----------|---------|---------|
| `/api/fetch-chain` (batch parse) | ~800-1,000 | User hydrate (CDN miss + node miss) |
| `/api/fetch-chain` (resolve hash) | ~100-1,000 | Hash → pointer lookup (10 pages max) |
| `/api/rpc` (DAS proxy) | 100 | Browser getAsset/getAssetsByOwner |
| `/api/nodes.js` (PDA discovery) | ~1 | Node registration (gPA cached) |
| `/api/memo-store` (payment verify) | ~8 | getTransaction polling |
| `/api/job-status` (list jobs) | ~1 | gPA with 30s cache |
| `/api/membership` (check) | 100 | DAS getAssetsByOwner |

### CDN (User-Driven — Per Request)

| Action | Credits | Notes |
|--------|---------|-------|
| Node discovery (gPA) | ~1 | 5-min cache — shared across all users |
| Blob fetch from nodes | 0 | HTTP to community nodes |
| SHA-256 verify | 0 | Local compute |
| POD receipt sign | 0 | Local Ed25519 |

---

## Quick Reference: "How many files can I do?"

| Plan | Idle Budget Used | Available | Files/Day (500KB) | Files/Day (5MB) |
|------|-----------------|-----------|-------------------|-----------------|
| Free (1M) | ~60K (6%) | ~940K | ~35 | ~3 |
| Developer (10M) | ~67K (0.7%) | ~9.93M | ~374 | ~37 |
| Business (100M) | ~67K (0.07%) | ~99.9M | ~3,760 | ~380 |
| Validator (Geyser) | 0 | Unlimited | Unlimited* | Unlimited* |

*Limited by validator RPC throughput and Solana TPS, not Helius credits.

> **Note**: Free plan is also RPS-limited (10 req/sec), so inscription throughput
> is ~10 chunks/sec = a 5MB file takes ~14 minutes. Practical limit is 1-3
> large files per hour, not per day, due to RPS gating.

---

## Monitoring

The `/health` endpoint includes RPC budget info:

```json
{
  "rpc": {
    "creditsUsed": 1234,
    "creditsPerHour": 50,
    "projectedMonthly": 36000,
    "budget": 10000000,
    "chainFill": false,
    "consecutive429s": 0,
    "backoffMs": 0,
    "maxFillPerCycle": 0,
    "maxFillAttempts": 5,
    "sessionHours": 2.5
  }
}
```

If `projectedMonthly > budget × 0.8`, the circuit breaker kicks in and skips RPC calls.

**Check your node**: `curl https://your-node.example.com/health | jq .rpc`
