# Node Tier Guide — What Each Helius Plan Can Do

> Real numbers, tested. Every RPC call audited across the full stack.
> Use this when someone asks "what can my server handle?"

## Credit Costs (Reference)

| RPC Method | Credits | Example |
|------------|---------|---------|
| Standard (getAccountInfo, gPA, sendTx, getBalance, etc.) | **1** | Job poll, confirm tx |
| getSignatureStatuses (up to 256 sigs per call) | **1** | Batch confirm |
| Enhanced API (v0/addresses/transactions) | **100 per 100 results** | Chain scan |
| DAS API (getAsset, getAssetsByOwner) | **100** | NFT lookup |

## Idle Costs (Node Running 24/7, No Jobs Processing)

These are the background polling costs just for keeping the node alive.

### Indexer (Chain Scan — Safety Net)
With webhooks active, scan runs every 6th poll as a safety check:

| Plan Type | Scan Method | Cost/Check | Checks/Day | Monthly |
|-----------|-------------|------------|------------|---------|
| Free | RPC (gSFA + gTx, stops early) | ~6 credits | 4 | **720** |
| Developer+ | Enhanced API (5 pages max) | ~500 credits | 4 | **60,000** |

> **Optimization note**: We force RPC scan for safety checks even on paid plans (10× cheaper).
> Enhanced API only runs during initial history scan (one-time).

### Marketplace Polling (Claimer + Attester + ZombieSlayer)

| Component | Method | At 60s poll | At 300s poll |
|-----------|--------|-------------|--------------|
| Claimer (fetchOpenJobs) | 1× gPA | 43,800/mo | 8,760/mo |
| Attester (fetchSubmittedJobs) | 1× gPA | 43,800/mo | 8,760/mo |
| ZombieSlayer (every 5min) | 1× gPA + 1× gAI | 17,280/mo | 17,280/mo |
| **Total marketplace** | | **104,880/mo** | **34,800/mo** |

### Total Idle by Role

| Role | Free Plan (300s poll) | Developer (60s poll) |
|------|----------------------|---------------------|
| **Reader-only** (no marketplace) | **720/mo** | **60,000/mo** |
| **Attester-only** (reader + attest) | 9,480/mo | 103,800/mo |
| **Writer + Attester** (full node) | **35,520/mo** | **164,880/mo** |

## Per-Job Inscription Cost

Each inscribed chunk costs ~1 credit (sendTransaction) plus confirmation overhead.

| Blob Size | Chunks | Send | Confirm | Blockhash | Overhead | **Total** |
|----------------------|--------|------|---------|-----------|----------|-----------|
| 100KB | ~171 | 171 | 3 | 6 | 4 | **~184** |
| 500KB | ~855 | 855 | 11 | 29 | 4 | **~899** |
| 1MB | ~1,710 | 1,710 | 21 | 57 | 4 | **~1,792** |
| 2MB | ~3,419 | 3,419 | 41 | 114 | 4 | **~3,578** |
| 5MB (max) | ~8,550 | 8,550 | 101 | 285 | 4 | **~8,940** |

> Overhead = priority fee fetch (2) + pointer memo (1) + chunk zero verify (1)
> Confirm = ceil(chunks/256) × avg 3 retries
> Blockhash = runtime/30s (cached)

## Tier Presets

### Free Plan (1M credits, 10 RPS) — $0/mo

**Best role**: Reader + Attester (index, serve blobs, verify jobs, earn POD)

```
┌─────────────────────────────────────────────────────────┐
│  FREE PLAN BUDGET: 1,000,000 credits/month              │
│                                                         │
│  Idle (reader + marketplace, 300s poll):    35,520      │
│  Available for jobs:                       964,480      │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │  100KB jobs/month:  ~5,242  (175/day)           │    │
│  │  500KB jobs/month:  ~1,073  (36/day)            │    │
│  │  1MB  jobs/month:    ~538   (18/day)            │    │
│  │  5MB  jobs/month:    ~108   (3.6/day)           │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  RPS constraint: 10 sends/sec                           │
│  5MB file inscription time: ~15 min                     │
│  Max concurrent jobs: 1 (recommended)                   │
│  Reader-only idle: 720 credits/mo (0.07% of budget)     │
└─────────────────────────────────────────────────────────┘
```

**Recommended .env:**
```bash
HELIUS_API_KEY=your-free-key
ROLE=both
CREDIT_BUDGET=1000000
POLL_INTERVAL=3600000          # 1hr scan (safety net)
CLAIM_POLL_INTERVAL=300000     # 5min marketplace poll
MAX_FILL_PER_CYCLE=0           # peers only
CAPACITY=1                     # 1 concurrent job
# Replace with discovered peers or bootstrap from coordinator
PEER_NODES=https://peer1.example.com,https://peer2.example.com
GENESIS_SIG=your-genesis-signature
```

**If asked "what can a free server do?":**
> A free node indexes the full artwork catalog, serves blobs to the CDN,
> attests marketplace jobs, and can inscribe ~3-4 5MB files per day or
> ~18 1MB files per day. Reader-only costs almost nothing (720 credits/mo).

---

### Developer Plan (10M credits, 50 RPS) — $49/mo

**Best role**: Full node (Writer + Attester + Reader)

```
┌─────────────────────────────────────────────────────────┐
│  DEVELOPER PLAN BUDGET: 10,000,000 credits/month        │
│                                                         │
│  Idle (full node, 60s poll):              164,880       │
│  Available for jobs:                    9,835,120       │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │  100KB jobs/month: ~53,452  (1,782/day)         │    │
│  │  500KB jobs/month: ~10,940  (365/day)           │    │
│  │  1MB  jobs/month:   ~5,488  (183/day)           │    │
│  │  5MB  jobs/month:   ~1,100  (37/day)            │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  RPS constraint: 50 sends/sec                           │
│  5MB file inscription time: ~6 min                      │
│  Max concurrent jobs: 3 (recommended)                   │
│  Idle = 1.6% of budget                                  │
└─────────────────────────────────────────────────────────┘
```

**Recommended .env:**
```bash
HELIUS_API_KEY=your-developer-key
HELIUS_RPC_URL=https://your-dedicated-url.helius-rpc.com
ROLE=both
CREDIT_BUDGET=10000000
POLL_INTERVAL=3600000          # 1hr scan (webhooks handle real-time)
CLAIM_POLL_INTERVAL=60000      # 60s marketplace poll
MAX_FILL_PER_CYCLE=0           # peers first
CAPACITY=3                     # 3 concurrent jobs
# Replace with discovered peers or bootstrap from coordinator
PEER_NODES=https://peer1.example.com,https://peer2.example.com
GENESIS_SIG=your-genesis-signature
```

---

### Business Plan (100M credits, 200 RPS) — $499/mo

**Best role**: High-throughput writer hub

```
┌─────────────────────────────────────────────────────────┐
│  BUSINESS PLAN BUDGET: 100,000,000 credits/month        │
│                                                         │
│  Idle (full node, 60s poll):              164,880       │
│  Available for jobs:                   99,835,120       │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │  1MB  jobs/month:  ~55,712  (1,857/day)         │    │
│  │  5MB  jobs/month:  ~11,167  (372/day)           │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  RPS constraint: 200 sends/sec                          │
│  5MB file inscription time: ~2 min                      │
│  Max concurrent jobs: 5+                                │
│  Idle = 0.16% of budget                                 │
└─────────────────────────────────────────────────────────┘
```

**Recommended .env:**
```bash
HELIUS_API_KEY=your-business-key
HELIUS_RPC_URL=https://your-dedicated-url.helius-rpc.com
ROLE=both
CREDIT_BUDGET=100000000
POLL_INTERVAL=3600000
CLAIM_POLL_INTERVAL=30000      # 30s — fast claim
MAX_FILL_PER_CYCLE=0
CAPACITY=5
CHAIN_FILL=true                # can afford chain reads as backup
# Replace with discovered peers or bootstrap from coordinator
PEER_NODES=https://peer1.example.com,https://peer2.example.com
GENESIS_SIG=your-genesis-signature
```

---

### Validator / Geyser Plugin — $0 Helius credits

**Best role**: Source-of-truth reader, high-throughput writer

```
┌─────────────────────────────────────────────────────────┐
│  VALIDATOR NODE — NO HELIUS DEPENDENCY                  │
│                                                         │
│  Chain reads: Direct from validator (0 credits)         │
│  Transaction sends: Local submit (0 credits)            │
│  Throughput: Limited only by validator performance       │
│                                                         │
│  Still recommended:                                     │
│    - Helius as backup send endpoint                     │
│    - Peer sync for blob propagation                     │
│    - Webhook for real-time events (free)                │
│                                                         │
│  Use case: Solana Foundation, large validators who      │
│  want to run FreezeDry as a public good                │
└─────────────────────────────────────────────────────────┘
```

**Recommended .env:**
```bash
# No HELIUS_API_KEY needed — reads from validator directly
GEYSER_ENABLED=true            # future feature
ROLE=both
CREDIT_BUDGET=0                # no Helius = no budget
POLL_INTERVAL=3600000
CLAIM_POLL_INTERVAL=60000
CAPACITY=10                    # validator can handle more
# Replace with discovered peers or bootstrap from coordinator
PEER_NODES=https://peer1.example.com,https://peer2.example.com
```

> **For validators**: A validator running a FreezeDry node uses **zero Helius credits**.
> It reads chain state directly, submits transactions locally, and contributes to the network
> as a high-availability reader. The only cost is the server itself + disk for blob storage.
> A read-only validator (no inscription) just indexes and serves — pure public good.

---

### Gossip-Only Node (No Helius Key) — $0

**Best role**: Pure reader + blob server (POD rewards only)

```
┌─────────────────────────────────────────────────────────┐
│  GOSSIP-ONLY NODE — ZERO RPC CREDITS                    │
│                                                         │
│  Discovery: Registry backfill from coordinator (HTTP)   │
│  Blob fill: Peer-to-peer gossip only                    │
│  Chain reads: None                                      │
│  Writes: None (cannot inscribe)                         │
│                                                         │
│  Monthly burn: 0 Helius credits                         │
│  Earns: POD receipts for serving blobs via CDN          │
│                                                         │
│  This is the LOWEST cost node. Perfect for:             │
│    - Community members who want to help                 │
│    - Raspberry Pi / small VPS deployments               │
│    - Testing before committing to a Helius plan         │
└─────────────────────────────────────────────────────────┘
```

**Recommended .env:**
```bash
# HELIUS_API_KEY=              # omit = gossip-only
ROLE=reader
CREDIT_BUDGET=0
# Replace with discovered peers or bootstrap from coordinator
PEER_NODES=https://peer1.example.com,https://peer2.example.com
GENESIS_SIG=your-genesis-signature
```

---

## Role Comparison

| Role | Helius? | Credits/mo (idle) | Earns | Inscribes? |
|------|---------|-------------------|-------|------------|
| **Gossip reader** | No | 0 | POD only | No |
| **Reader + indexer** | Free OK | 720 | POD | No |
| **Attester** | Free OK | 9,480 | Attest fees (10% of margin) | No |
| **Writer** | Free OK | 35,520 | 5,000/chunk reimburse + 40% of margin | Yes |
| **Full node** | Dev+ best | 164,880 | Both | Yes |
| **Validator** | No | 0 | Both + staking | Yes |

## What Burns Credits (Complete Inventory)

### Idle Background Polling

| Source | Method | Credits/call | Default Interval | Monthly |
|--------|--------|-------------|-----------------|---------|
| Indexer scan (Enhanced) | Enhanced API | 100/page | 6hr safety | 60,000 |
| Indexer scan (RPC) | gSFA + gTx | ~6 | 6hr safety | 720 |
| Claimer poll | getProgramAccounts | 1 | 60s | 43,800 |
| Attester poll | getProgramAccounts | 1 | 60s | 43,800 |
| ZombieSlayer | gPA + getAccountInfo | 2 | 5min | 17,280 |
| Stake check (startup) | getAccountInfo ×2 | 2 | Once | 2 |
| Auto-register | HTTP (no RPC) | 0 | 10 polls | 0 |
| POD flush | getLatestBlockhash + sendTx | ~6 | 5min | 51,840 |

### Per-Job (Active Work)

| Operation | Method | Credits | When |
|-----------|--------|---------|------|
| Send chunk | sendTransaction | 1 each | Per chunk |
| Confirm batch | getSignatureStatuses | 1 each | Per 256 chunks |
| Blockhash | getLatestBlockhash | 1 each | Every 30s (cached) |
| Priority fee | getRecentPrioritizationFees | 1 | Per job start |
| Pointer memo | sendTransaction | 1 | Per job end |
| Verify chunk 0 | getTransaction | 1 | Per job end |
| Attest job | getLatestBlockhash + sendTx + getSigStatus | 3 | Per attestation |
| Release payment | getAccountInfo ×2 + send + confirm | 5 | Per job completion |

### Vercel API (User-Triggered, Not Node)

| Endpoint | Method | Credits | Trigger |
|----------|--------|---------|---------|
| /api/fetch-chain (batch parse) | Enhanced API | ~800/artwork | User hydrate |
| /api/fetch-chain (hash resolve) | Enhanced API | ~1,000 max | Hash lookup |
| /api/rpc (DAS proxy) | getAsset | 100 | Browser NFT view |
| /api/rpc (DAS proxy) | getAssetsByOwner | 100 | Gallery load |
| /api/nodes (PDA discovery) | getProgramAccounts | 1 | Node list (cached 60s) |
| CDN worker (PDA discovery) | getProgramAccounts | 1 | Blob request (cached 5min) |

## Circuit Breaker

The node tracks credit usage and projects monthly burn. If projected monthly exceeds
80% of `CREDIT_BUDGET`, RPC calls are skipped until the rate drops.

```
projected = (credits_used / hours_running) × 720
if projected > budget × 0.8 → skip RPC, log warning
```

On 429 rate limits: exponential backoff (60s → 120s → 240s → ... → 15min cap).

## Key Design Principles

1. **Gossip first, chain last.** Blobs propagate peer-to-peer for free.
   Chain reads are the expensive last resort.

2. **Webhooks replace polling.** Once Helius webhook delivers an event,
   the node doesn't need to scan for it. Safety scan = backup only.

3. **Budget-aware defaults.** Every `.env.example` preset is safe.
   A new node can't accidentally burn a month of credits in one night.

4. **Tier-appropriate polling.** Free plan polls every 5 min (jobs arrive slowly).
   Developer polls every 60s. Business polls every 30s.

5. **Delegation works at every tier.** A free-plan node can still inscribe
   marketplace jobs — just fewer per day. The economics still work because
   the node earns fees on each job it completes.
