# Throughput Optimizations — WebSocket + Jito + Pipeline

> WebSocket confirms are DEFAULT ON. Jito is opt-in. Multi-concurrent jobs unlock full RPS utilization.

---

## Quick Reference

| Config | TPS (single job) | TPS (CAPACITY=3, Dev) | Credit Cost/Chunk | Speedup vs baseline |
|--------|-----------------|----------------------|-------------------|-------------------|
| Polling confirms (legacy) | 3.4 | ~10 | ~2.2 | baseline |
| `USE_WEBSOCKET=true` (default) | **15.7 (proven)** | **~47 (projected)** | ~1.0 | 4.6x |
| WS + `JITO_ENABLED=true` | 15.7 + Jito landing | ~47 + Jito landing | ~0.05 | 4.6x + credits |

**Key insight**: WS confirms (15.7 TPS) are the speed win. Jito saves credits and guarantees landing but doesn't increase TPS beyond WS (rate limited to 1 bundle/sec = ~4.5 TPS from Jito path alone). The real TPS unlock is multi-concurrent jobs: CAPACITY=3 on Dev = ~47 TPS using 96% of 50 RPS.

---

## Env Flags

```bash
# Pipeline tuning (all have safe defaults)
SEND_CONCURRENCY=12          # TXs per batch (scale with RPC tier)
BATCH_DELAY_MS=400           # ms between batches
CONFIRM_WAIT_MS=2500         # ms before first confirm check
FEE_REFRESH_MS=60000         # refresh priority fee every 60s
MULTI_JOB_CONCURRENCY=12     # keep full send concurrency per job (was auto-throttling)

# WebSocket confirms — DEFAULT ON (4.6x speedup, free, 100% success rate)
USE_WEBSOCKET=true            # auto-derives WS URL from HELIUS_API_KEY
HELIUS_WS_URL=               # custom WS URL (auto-derived from API key if empty)
WS_CONFIRM_TIMEOUT_MS=10000  # fall back to polling after this

# Jito bundles (5x speedup, costs tips)
JITO_ENABLED=false            # set true to enable
JITO_TIP_LAMPORTS=10000      # tip per bundle (0.00001 SOL default)
JITO_BLOCK_ENGINE_URL=https://mainnet.block-engine.jito.wtf
```

---

## Change 1: WebSocket Confirms (`USE_WEBSOCKET=true`)

### What It Does
Replaces polling `getSignatureStatuses` (2.5s fixed wait) with WebSocket `signatureSubscribe` push notifications (~300-500ms average). **PROVEN: 15.7 TPS on mainnet** (chain-7, 2246 chunks in 143s, 638 WS confirms, 0 timeouts, 100% success rate).

### How It Works
1. Node opens one persistent WebSocket to Helius (`wss://mainnet.helius-rpc.com/?api-key=KEY`)
2. After sending a batch, subscribes to each TX signature via `signatureSubscribe`
3. Helius pushes a notification when the TX confirms (single-shot, auto-cancels)
4. If WS disconnects or times out → falls back to polling (original behavior)
5. Ping keepalive every 30s prevents Helius 10-min inactivity timeout

### Credit Impact
- `signatureSubscribe` does NOT consume Helius credits (WebSocket is separate from HTTP RPC)
- Eliminates `getSignatureStatuses` polling calls (~1 credit each)
- Each chunk drops from ~2.2 credits to ~1.0 credits (send only)
- **50% credit savings**

### Helius WebSocket Limits
| Plan | Max WS Connections | We Use |
|------|-------------------|--------|
| Free | 5 | 1 |
| Developer | 150 | 1 |
| Business | 250 | 1 |
| Professional | 250 | 1 |

No documented per-connection subscription cap. At 50 concurrency = 50 concurrent subscriptions on 1 connection. Well within limits.

### Files
- `src/writer/ws-confirm.js` — WebSocket connection manager, signatureSubscribe, auto-reconnect
- `src/writer/inscribe.js` — WS-first confirm with polling fallback
- `src/config.js` — `USE_WEBSOCKET`, `WS_CONFIRM_TIMEOUT_MS`, `HELIUS_WS_URL`
- `src/server.js` — WS connection init on startup

### Risks
- WebSocket disconnections → mitigated: auto-reconnect + polling fallback
- Memory leak from subscriptions → mitigated: single-shot auto-cancel + timeout cleanup
- Node <21 needs `ws` package → mitigated: falls back gracefully, logs warning

---

## Change 2: Jito Bundle Integration (`JITO_ENABLED=true`)

### What It Does
Groups up to 5 memo TXs into one Jito bundle with a tip. Sent to Jito block engine for guaranteed block inclusion. Eliminates TX drops and retry overhead.

### How It Works
1. Build 5 memo TXs (same as before: CU limit + CU price + memo IX)
2. Add a SOL transfer tip to the **last TX** in the bundle (to a rotating Jito tip address)
3. Send bundle to `https://mainnet.block-engine.jito.wtf/api/v1/bundles`
4. Jito guarantees atomic execution: all 5 land in the same block, or none
5. If Jito rejects → fall back to standard `sendWithRetry` for that group
6. ~90% of Solana slots are Jito-validator slots

### Credit Impact
- `sendBundle` goes to Jito's endpoint, NOT Helius → **0 Helius credits for sends**
- Only `getLatestBlockhash` + `fetchPriorityFee` still use Helius credits
- Each chunk drops from ~2.2 credits to ~0.2 credits
- **90% credit savings**

### Tip Cost
- Default: 10,000 lamports per bundle (0.00001 SOL, ~$0.0013 at $130 SOL)
- 5 TXs per bundle → effective tip: 0.000002 SOL per TX
- Minimum accepted: 1,000 lamports (can lower via `JITO_TIP_LAMPORTS`)

**Cost per job (Guides 4.30 MiB = 7,702 chunks):**
```
7,702 chunks / 5 per bundle = 1,541 bundles
1,541 × 0.00001 SOL = 0.01541 SOL (~$2.00)
Writer earns 5,000/chunk reimburse + 40% of margin (~0.046 SOL = $6.00)
Net after tips: $4.00 — but 5x more jobs/hour
```

### Jito Rate Limits (IMPORTANT — VERIFIED 2026-03-08)

| Tier | Bundles/sec | TPS (×5 TX) | How to get |
|------|-----------|------------|-----------|
| Default (no auth) | 1/sec per IP per region | ~5 TPS | Free, no signup |
| UUID auth | up to 5/sec | ~25 TPS | `x-jito-auth` header with UUID API key |
| Custom | Higher | Apply | [Rate Limit Increase Form](https://forms.gle/8jZmKX1KZA71jXp38) |

- Exceeding → HTTP 429 with exponential backoff (1s → 120s). Global rate limit triggers after sustained violation.
- `jito.js` currently throttles to 1.1s between sends (matches default no-auth limit). With UUID auth, can test at 200ms (5/sec).
- UUID API key passed via `x-jito-auth` header or query param.

**LEAD — Third-party Jito access (Solana Vibe Station):**
- solanavibestation.com offers tiered Jito access: Basic (5/sec), Ultra (10/sec), Elite (15/sec)
- **NOT Jito official** — third-party RPC service. Different specs: 4 TX/bundle max, 0.001 SOL min tip.
- Worth evaluating if we need >5/sec without applying for Jito custom limits.
- QuickNode's "Lil' JIT" add-on also provides Jito access — may have different limits.

**TODO:**
- [ ] Get UUID API key from Jito to unlock 5/sec (currently running at 1/sec default)
- [ ] Test `jito.js` at 200ms throttle (5 bundles/sec) with UUID auth
- [ ] Apply for custom rate limit via Jito form (inscription = sustained data writes, not MEV)
- [ ] Evaluate Solana Vibe Station tiers for higher throughput (cost vs benefit)
- [ ] Check QuickNode Lil' JIT integration for alternative access
- [ ] Ask Helius about their Jito integration tier (some RPC providers bundle higher Jito limits)

### Jito Limitations
- No devnet support — Jito block engine only runs on mainnet + testnet
- Max 5 TXs per bundle (protocol limit)
- Bundle expires after next Jito leader slot (~90% of slots are Jito)
- `getBundleStatuses` lookback is 5 minutes
- Global rate limit bans persist ~minutes after violation — must wait for cooldown
- Rate limit is per IP — multiple workers on same server share the limit

### Files
- `src/writer/jito.js` — Bundle builder, tip instruction, Jito block engine client
- `src/writer/inscribe.js` — Jito-aware send path with standard fallback
- `src/config.js` — `JITO_ENABLED`, `JITO_TIP_LAMPORTS`, `JITO_BLOCK_ENGINE_URL`

### Risks
- Non-Jito validator slot (~10%) → bundle rejected → falls back to standard send
- Tip cost → tiny: operator can tune `JITO_TIP_LAMPORTS` or disable entirely
- Atomic execution → if one TX fails CU, whole bundle reverts → CU budget set correctly (350k)

---

## Change 3: Pipeline Improvements (always active)

### 3a. Dynamic Priority Fee Refresh
**Before:** Priority fee fetched ONCE at job start. A 2-hour José job uses stale fee.
**After:** Refreshes every `FEE_REFRESH_MS` (default 60s). Fresh fee = fewer TX drops.

### 3b. Adaptive Blockhash Cache
**Before:** Fixed 20s blockhash cache. At 49 TPS, ~60 TXs share one blockhash near expiry.
**After:** Cache scales with concurrency: `max(5s, 20s - (SEND_CONCURRENCY × 100ms))`
- At concurrency 12: 18.8s (same as before)
- At concurrency 50: 15s
- At concurrency 150: 5s (minimum)

### 3c. Multi-Job Concurrency — Fixed at 12 (was auto-throttling)
**Before:** Auto-scaling reduced concurrency per job (1 job=12, 2 jobs=7, 3+=5). This left 68% of Dev RPS unused.
**After:** `MULTI_JOB_CONCURRENCY=12` (default). Each job gets full 12 concurrency regardless of how many run.
- CAPACITY=1: 12 TXs × 1 job = ~16 RPS (32% of Dev 50 RPS)
- CAPACITY=2: 12 TXs × 2 jobs = ~32 RPS (64% of Dev 50 RPS)
- CAPACITY=3: 12 TXs × 3 jobs = ~48 RPS (96% of Dev 50 RPS)
Safety: set CAPACITY based on RPC tier. Dev=3 max, Business=12, Pro=30.

### 3d. CONFIRM_WAIT_MS Now Env-Configurable
**Before:** Hardcoded 2500ms
**After:** `CONFIRM_WAIT_MS=2500` in env (default unchanged)

---

## Idle vs Active Resource Usage

### Idle (No Active Jobs)

When no job is processing, the node is essentially sleeping:

| Process | Interval | Credits/call | Monthly Credits |
|---------|----------|-------------|-----------------|
| Claimer poll | 30-60s | 1 | ~43,800 |
| Attester poll | 30-60s | 1 | ~43,800 |
| Indexer scan | 1 hour (safety) | ~6 | ~4,320 |
| Job cleanup | 10 min | 0 | 0 |
| Blob pruning | 6 hours | 0 | 0 |
| WS ping (if enabled) | 30s | 0 | 0 |
| **Total idle** | | | **~92K credits/mo** |

**Idle = 0.9% of Developer plan (10M credits)**

### Server Resources at Idle
- CPU: <1%
- RAM: ~30 MB (Node.js baseline)
- Network: ~2 KB/min (polling + WS ping)
- A $6/mo droplet (1 vCPU, 1 GB RAM) handles this effortlessly

### Active (Processing Jobs)

| Metric | Standard | WS Only | WS + CAPACITY=3 | WS + Jito |
|--------|----------|---------|-----------------|-----------|
| TPS | 3.4 | 15.7 (proven) | ~47 (projected) | 15.7 + landing |
| Credits/hr | ~24,000 | ~12,000 | ~2,400 | ~500 |
| CPU | 2-5% | 2-5% | 3-6% | 4-8% |
| RAM (1 job) | ~35 MB | ~40 MB | ~38 MB | ~45 MB |
| RAM (3 jobs) | ~65 MB | ~75 MB | ~70 MB | ~85 MB |
| Network | ~50 KB/s | ~50 KB/s | ~55 KB/s | ~55 KB/s |

### Worst Case (3 concurrent José jobs, WS + Jito)
- RAM: ~124 MB (well within 1 GB droplet)
- CPU: ~8% of 1 vCPU
- Network: ~170 KB/s (~17% of $6 droplet bandwidth)
- Credits/hr: ~1,500 (projected monthly: ~1.08M = 10.8% of Dev plan)

---

## Credit Impact by Optimization

### Why WS + Jito Saves Credits

| Operation | Credits (Standard) | Credits (WS) | Credits (Jito) | Credits (Both) |
|-----------|--------------------|-------------|---------------|----------------|
| sendTransaction | 1 | 1 | 0 (Jito endpoint) | 0 |
| getSignatureStatuses | 1 per 256 sigs × retries | 0 (WS push) | 1 per 256 × retries | 0 |
| getLatestBlockhash | Shared (cached) | Shared | Shared | Shared |
| fetchPriorityFee | 1 per 60s | 1 per 60s | 1 per 60s | 1 per 60s |
| **Per chunk avg** | **~2.2** | **~1.0** | **~0.2** | **~0.05** |

### Monthly Job Capacity (Developer 10M credits)

| Reference Piece | Chunks | Jobs/mo (Standard) | Jobs/mo (WS+Jito) |
|----------------|--------|--------------------|--------------------|
| SMB (2 KB) | 4 | 1.1M | Credits unlimited* |
| Guides (4.30 MiB) | 7,702 | ~590 | ~26,000 |
| José Narciso (15.6 MiB) | 28,007 | ~162 | ~7,100 |

*At WS+Jito, time becomes the bottleneck before credits:

| Reference Piece | Time/job (WS+Jito @49 TPS) | Time-limited/mo |
|----------------|---------------------------|-----------------|
| SMB (2 KB) | <1s | Unlimited |
| Guides (4.30 MiB) | 2.6 min | ~16,600 |
| José Narciso (15.6 MiB) | 9.5 min | ~4,500 |

---

## Operator Tier Guide (with optimizations)

| Setup | TPS | Monthly Cost | Revenue/hr* | Break-even |
|-------|-----|-------------|------------|------------|
| Dev, polling (legacy) | 3.4 | $49 RPC + $6 VPS | ~$6.50/hr | ~8 hrs |
| **Dev + WS, CAPACITY=1** | **15.7** | **$49 + $6** | **~$30/hr** | **~2 hrs** |
| Dev + WS, CAPACITY=3 | ~47 | $49 + $6 | ~$90/hr | ~0.6 hrs |
| Business + WS, CAPACITY=12 | ~125 | $499 + $6 | ~$240/hr | ~2 hrs |
| Pro + WS, CAPACITY=30 | ~310 | $999 + $6 | ~$595/hr | ~1.7 hrs |

*Revenue assumes continuous Guides-size jobs (0.060 SOL escrow, writer gets 5,000/chunk reimburse + 40% of margin)

**Note**: Dev CAPACITY=1 at 15.7 TPS is PROVEN. Higher capacities and tiers are PROJECTED (safe — stays within paid RPS). Jito adds credit savings and landing guarantees on top of any tier.

---

## Implementation Order

```
Phase 1 (shipped, low risk):
  Pipeline improvements — FEE_REFRESH_MS, adaptive blockhash, MULTI_JOB_CONCURRENCY
  Small code changes, no new dependencies, backward compatible

Phase 2 (USE_WEBSOCKET=true):
  WebSocket confirms — new connection type, auto-reconnect
  Deploy behind flag, test on devnet with small job

Phase 3 (JITO_ENABLED=true):
  Jito bundles — new send path, new endpoint
  Deploy behind flag, mainnet only (no Jito devnet)
```

All changes are opt-in. Existing behavior is default. No new npm dependencies required (WebSocket uses native Node 21+ or optional `ws` package).

---

## Test Plan

1. **Phase 1**: Deploy with default flags → verify TPS unchanged → enable `FEE_REFRESH_MS=30000` → verify fee refreshes in logs
2. **Phase 2**: Set `USE_WEBSOCKET=true` → small devnet job (100 chunks) → verify WS confirm logs → measure time-to-confirm
3. **Phase 3**: Set `JITO_ENABLED=true` → mainnet job (Guides size) → verify bundle landing rate → measure TPS
4. **Combined**: Both flags → José-size job → measure end-to-end time → verify credit usage in `/health`
