# FreezeDry Node

A lightweight indexer and cache node for the [FreezeDry Protocol](https://github.com/freezedry-protocol/freezedry-protocol) — on-chain art storage on Solana.

Nodes scan the Solana blockchain for `FREEZEDRY:` pointer memos, fetch the associated chunk data, and serve reconstructed artwork blobs over HTTP. The chain is the source of truth; nodes are a discovery and caching layer.

**Full app**: [freezedry.art](https://freezedry.art) — managed inscriptions, NFT minting, and fast hydration.

## Prerequisites

- **Node.js v18+** — [nodejs.org](https://nodejs.org)
- **Helius API key** — Free at [helius.dev](https://helius.dev) (sign up → Dashboard → API Keys → copy)

Writer/marketplace nodes also need:
- **Solana CLI** (optional) — `sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"` for wallet management
- **Public domain + HTTPS** — for peer network participation (e.g. `node.yourdomain.com` with reverse proxy)

## 5-Minute Setup

### Option A: Guided setup (recommended)

```bash
git clone https://github.com/freezedry-protocol/freezedry-node.git
cd freezedry-node
npm run setup
npm start
```

The setup wizard walks you through role selection, Helius key, wallet, node identity, and on-chain registration. It generates `.env` with safe defaults, a secure `WEBHOOK_SECRET`, and handles peer discovery automatically.

### Option B: Manual setup

```bash
git clone https://github.com/freezedry-protocol/freezedry-node.git
cd freezedry-node
npm install
cp .env.example .env
# Edit .env — at minimum set HELIUS_API_KEY and generate WEBHOOK_SECRET:
#   openssl rand -hex 32
npm start

# Writer nodes: register on-chain to claim jobs (requires funded wallet)
node scripts/register-onchain.mjs
```

### Required configuration

| Variable | Required | What it is | Where to get it |
|----------|----------|------------|-----------------|
| `HELIUS_API_KEY` | Yes | Solana RPC access | [helius.dev](https://helius.dev) (free tier works) |
| `WEBHOOK_SECRET` | Yes | Auth for write endpoints | `openssl rand -hex 32` (setup.sh generates this) |
| `IDENTITY_KEYPAIR` | For peers | Ed25519 identity key (JSON array) | setup.sh generates one |
| `HOT_WALLET_KEYPAIR` | For writer | Solana keypair for TX signing | setup.sh generates one |
| `NODE_URL` | For peers | Your node's public https URL | Your domain + reverse proxy |
| `NODE_ENDPOINT` | For peers | IP:port for domain-free nodes | Your public IP + port (e.g. `203.0.113.5:3100`) |

**Legacy**: `WALLET_KEYPAIR` still works — used for both identity and hot wallet if the separate keys aren't set.

### Verify it's working

After `npm start`, you should see:

```
FreezeDry Node (my-freezedry-node) listening on :3100
Indexer: starting (poll every 120s, wallet: 6ao3hnvK...)
Indexer: seeded N artworks from registry
```

Check health:

```bash
curl http://localhost:3100/health
# {"status":"ok","indexed":{"artworks":19,"complete":19},"peers":2,"identityPubkey":"AbCd...","displayName":"Brave Tiger"}
```

The node seeds existing artworks from the registry on startup, then begins scanning the chain for new ones. Blobs are fetched from peers first (free, instant HTTP) before falling back to chain reads.

## Choosing a Role

| Role | What it does | Helius plan | Wallet needed? |
|------|-------------|-------------|----------------|
| **reader** | Index chain + serve artwork to peers | Free works | No |
| **writer** | Accept inscription jobs, earn fees | Developer+ | Yes (funded) |
| **both** | Reader + writer (default) | Developer+ | Yes (funded) |

Reader-only is the simplest way to help the network. No wallet, no SOL, just a Helius key.

## Writer Economics — How You Earn

Your wallet needs SOL as **working capital** to send memo transactions. This SOL is not spent — you get reimbursed from the job escrow when the inscription completes.

### How a Job Flows to Your Node

```
1. Artist uploads artwork on freezedry.art
2. Artist pays escrow → Job PDA created on-chain
3. Coordinator assigns job → your node claims it
4. Your node inscribes chunks as Solana memo TXs (uses your SOL as working capital)
5. Attester node verifies the inscription is correct
6. On-chain program releases escrow → your wallet gets paid
```

Your SOL comes back plus profit. The escrow reimburses your TX costs and pays you 40% of the margin.

### Per-Job Earnings

Every chunk your node inscribes earns two payments:

| Payment | Amount | What it is |
|---------|--------|------------|
| **TX reimbursement** | 5,000 lamports/chunk | Covers your actual Solana TX fee |
| **Margin (40%)** | 1,000 lamports/chunk | Your profit |
| **Total per chunk** | **6,000 lamports** | What hits your wallet |

### Earnings by File Size

| File Size | Chunks | Artist Pays | You Earn | Your Profit |
|-----------|--------|-------------|----------|-------------|
| 500 KB | 876 | 0.01539 SOL ($2.00) | 0.00878 SOL | $0.57 |
| 1 MB | 1,793 | 0.01539 SOL ($2.00) | 0.01153 SOL | $0.33 |
| 5 MB | 8,962 | 0.06722 SOL ($8.74) | 0.05377 SOL | $1.16 |
| 10 MB | 17,924 | 0.13443 SOL ($17.48) | 0.10754 SOL | $2.33 |
| 15 MB | 26,886 | 0.20165 SOL ($26.21) | 0.16132 SOL | $3.49 |

*Prices at $130/SOL. Smaller files hit the $2.00 minimum floor — higher margin per chunk.*

### Monthly Projections

| Jobs/Day | Avg Size | Monthly Earnings | RPC Tier Needed |
|----------|----------|-----------------|-----------------|
| 10 | 5 MB | 2.69 SOL ($349) | Helius Dev ($49/mo) |
| 50 | 5 MB | 13.44 SOL ($1,747) | Helius Dev ($49/mo) |
| 100 | 5 MB | 26.88 SOL ($3,494) | Helius Business ($499/mo) |
| 100 | 10 MB | 53.88 SOL ($7,004) | Helius Business ($499/mo) |

*Your only cost is the Helius RPC plan. SOL working capital is reimbursed per job.*

### How Much SOL Do I Need?

| Workload | Recommended SOL | Why |
|----------|----------------|-----|
| Testing | 0.1 SOL | A few small jobs |
| Light (1-5 jobs/day) | 0.5 SOL | Buffer for concurrent jobs |
| Production (10+ jobs/day) | 1-2 SOL | Multiple concurrent inscriptions |

Your working capital recycles — each completed job reimburses the SOL used, so you don't need enough for all jobs upfront.

### Full Fee Split

For transparency, here's where the entire escrow goes:

```
Escrow per chunk: 7,500 lamports
├── TX Reimbursement (to writer):     5,000 lamports  ← covers your costs
└── Margin:                           2,500 lamports  ← split by BPS
    ├── Writer (40%):                 1,000 lamports  ← your profit
    ├── Attester (10%):                 250 lamports
    ├── Treasury (30%):                 750 lamports
    └── Referral (20%):                 500 lamports
```

No referrer → referral share goes to treasury.

## How It Works

```
Solana Chain                    Your Node                    Peers / CDN
    |                              |                           |
    |--- FREEZEDRY: pointer ------>| discover artwork           |
    |--- chunk memos ------------->| fetch & cache chunks       |
    |                              |                           |
    |                              |<-- GET /artwork/:hash ----| metadata
    |                              |<-- GET /blob/:hash -------| cached blob (peers only)
    |                              |<-- GET /verify/:hash -----| SHA-256 proof
```

**Discovery**: The indexer polls for the configured `SERVER_WALLET`'s memo transactions, looking for `FREEZEDRY:` pointers. Each pointer contains a hash, chunk count, and blob size. Paginated — handles artworks with thousands of chunks.

**Caching**: Once a pointer is found, the node fetches all chunk transactions (paginated beyond API limits), strips memo headers, and stores the raw data in SQLite.

**Peer Sync**: Before reading from chain, the node tries peers first. Peer blob downloads are instant HTTP — no RPC credits needed. All peer-to-peer requests are authenticated with ed25519 signed messages.

**Serving**: Peers request blobs via HTTP. Only **complete** blobs are served — partial data is never sent.

## API Endpoints

### Public (no auth)

| Endpoint | Method | Returns |
|----------|--------|---------|
| `/health` | GET | Node status, indexed artwork count, peer count |
| `/artwork/:hash` | GET | Artwork metadata (dimensions, mode, chunk count, complete status) |
| `/artworks?limit=50&offset=0` | GET | List indexed artworks |
| `/verify/:hash` | GET | SHA-256 verification of stored blob |

### Peer-gated (signed identity required)

| Endpoint | Method | How to access |
|----------|--------|---------------|
| `/blob/:hash` | GET | Ed25519 signed identity headers (`X-FD-Identity`, `X-FD-Signature`, `X-FD-Message`) |
| `/sync/list` | GET | Same — lists available artworks for sync |
| `/sync/chunks/:hash` | GET | Same — base64 blob for peer sync |
| `/nodes` | GET | Same — list known peers (gossip discovery) |

### Protected (require `WEBHOOK_SECRET`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/ingest` | POST | Push artwork metadata (coordinator → node) |
| `/webhook/helius` | POST | Receive real-time Helius webhook pushes |

### Peer discovery (public, rate-limited + liveness-verified)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/sync/announce` | POST | Register a peer node URL (must be https, public IP, reachable) |

## Peer Network

Nodes discover each other and sync blobs without using RPC credits. All peer communication is authenticated with ed25519 signed messages — no shared secrets.

### Identity System (Two-Wallet)

Each node has two keypairs:

| Key | Purpose | Needs SOL? |
|-----|---------|-----------|
| **Identity key** | Peer authentication, reputation, display name | No |
| **Hot wallet** | Signs Solana memo TXs, pays fees, earns escrow | Yes (writer only) |

Separate keys = separate risk. If the hot wallet is compromised, identity and reputation are untouched.

### Discovery

Your node finds peers automatically through three layers:

1. **Coordinator** — On startup, your node registers with `freezedry.art` and gets a list of all active peers. No config needed.
2. **On-chain registry** — If the coordinator is unavailable, your node queries Solana directly for registered node PDAs. Fully permissionless.
3. **Gossip** — Every ~20 minutes, nodes exchange peer lists to discover new nodes organically.

You don't need to configure peers manually. Just start your node and it connects.

### Setup

```bash
# In .env — choose one connectivity method:

# Option A: Domain (requires HTTPS reverse proxy)
NODE_URL=https://node.yourdomain.com

# Option B: IP:port (no domain needed — simplest setup)
NODE_ENDPOINT=203.0.113.5:3100

# Optional: add known peers for faster initial sync
# PEER_NODES=https://peer1.example.com,http://198.51.100.10:3100
```

### How Peer Auth Works

Every peer-to-peer request includes three HTTP headers:

| Header | Contents |
|--------|----------|
| `X-FD-Identity` | Node's public key (base58) |
| `X-FD-Message` | `FreezeDry:peer:{action}:{timestamp}:{nonce}` |
| `X-FD-Signature` | Ed25519 signature of the message |

The receiving node verifies:
1. **Signature validity** — only the private key holder could have signed this
2. **Timestamp freshness** — must be within 5 minutes (prevents replay of old messages)
3. **Nonce uniqueness** — random nonce prevents exact replay within the freshness window
4. **Known identity** — the signing pubkey must be a registered peer

### How Peer Sync Works

```
Your Node                          Peer Node
    |                                  |
    |--- POST /sync/announce --------->| signed identity + endpoint
    |         (peer verifies signature)
    |<-- POST /sync/announce ----------| signed identity + endpoint (bidirectional)
    |                                  |
    |--- GET /blob/:hash ------------->| complete blob (signed request)
    |    (peer sync — no RPC needed)   |
```

1. **Announce** — Node sends its identity pubkey, endpoint, and signed auth headers. Receiving node verifies the ed25519 signature matches the claimed identity
2. **Bidirectional** — Your node announces back automatically
3. **Parallel fill** — When filling incomplete artworks, tries peers first (instant HTTP). Falls back to chain reads only if no peer has the data
4. **Gossip** — Every ~20 minutes, nodes exchange peer lists to discover new nodes
5. **Coordinator** — Nodes also register with `freezedry.art` for centralized discovery (optional, bootstrapping convenience)

### Display Names

Each node gets a deterministic display name from its identity pubkey (SHA-256 hash → adjective + animal). Example: `Brave Tiger`, `Silent Falcon`. These are cosmetic — the pubkey is the real identity.

### Security

- **Ed25519 identity auth**: All peer requests require cryptographic proof of identity. No shared passwords.
- **Nonce replay protection**: Each signed message includes a random nonce. Replayed messages are rejected.
- **SSRF protection**: Private IPs (`10.x`, `192.168.x`, `169.254.x`, `127.x`, `::1`), `.internal`/`.local` hostnames, and IPv6 private ranges blocked
- **HTTP IP-only**: Plain HTTP allowed only for raw public IPv4 addresses (prevents DNS rebinding)
- **Rate limiting**: 10 announce requests/min per IP
- **Peer-gated data**: Blob data requires signed identity from a known peer — no unauthenticated scraping
- **Complete blobs only**: Partial/incomplete data is never served to peers
- **Minimal exposure**: `/health` returns status + counts + identity pubkey. No memory, uptime, keys, or internal details

## Helius Plan Auto-Detection

The node auto-detects your Helius plan on startup:

- **Free key**: Uses standard RPC (`getSignaturesForAddress` + `getTransaction`). Works fine, slightly slower.
- **Paid key (Developer+)**: Uses Enhanced API. ~50x cheaper in credits, faster indexing.

Override with `USE_ENHANCED_API=true|false` in `.env` if needed.

## Architecture

```
freezedry-node/
  src/
    server.js      — Fastify HTTP server + endpoints
    indexer.js     — Chain scanner + peer sync + gossip
    db.js          — SQLite storage (better-sqlite3, WAL mode)
    config.js      — Protocol constants
    wallet.js      — Two-wallet keypair loader (identity + hot wallet)
    crypto-auth.js — Ed25519 signing + verification for peer auth
    display-name.js — Deterministic display names from identity pubkey
  scripts/
    setup.sh       — Interactive setup wizard (two-wallet generation)
    register.js    — Manual PDA registration
  .env.example     — Configuration template
```

**Database**: SQLite via `better-sqlite3` with WAL mode for concurrent reads. Created automatically on first run. This is a cache — delete it to re-index from chain.

**Dependencies**: 3 runtime deps: `fastify`, `better-sqlite3`, `@solana/web3.js` (optional — reader-only nodes work without it).

## Production Deployment

### Reverse proxy (nginx)

```nginx
server {
    listen 443 ssl;
    server_name node.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # Forward identity auth headers for peer-to-peer communication
        proxy_set_header X-FD-Identity $http_x_fd_identity;
        proxy_set_header X-FD-Signature $http_x_fd_signature;
        proxy_set_header X-FD-Message $http_x_fd_message;
    }
}
```

### systemd service

```ini
[Unit]
Description=FreezeDry Node
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/freezedry-node
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
MemoryMax=512M
MemoryHigh=400M

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable freezedry-node
sudo systemctl start freezedry-node
```

### Docker

```bash
docker compose up -d
docker compose logs -f
```

### Helius Webhook (real-time indexing)

Instead of polling every 2 minutes, configure a Helius webhook for instant indexing:

1. Go to [Helius Dashboard](https://dashboard.helius.dev) > Webhooks
2. Create webhook watching the `SERVER_WALLET` address
3. Set URL to `https://node.yourdomain.com/webhook/helius`
4. Set auth header to your `WEBHOOK_SECRET`
5. Select "Enhanced" format

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `better-sqlite3` build fails | Install build tools: `apt install python3 make g++` (or use Docker) |
| Port 3100 already in use | Change `PORT` in `.env` or stop the other process |
| 0 artworks after startup | Check `HELIUS_API_KEY` is valid. The node seeds from registry first, then scans chain. |
| Node can't find peers | Ensure `PEER_NODES` is set (setup.sh adds defaults). Check network connectivity. |
| Peer auth fails | Check `IDENTITY_KEYPAIR` is set. Verify identity pubkey matches what the peer expects. |
| Registration fails | Ensure `NODE_URL` or `NODE_ENDPOINT` is publicly reachable. The coordinator verifies your signature. |
| No display name | Set `IDENTITY_KEYPAIR` — display names derive from the identity pubkey. |
| High credit usage | Lower `POLL_INTERVAL` (default 1hr is safe). Keep `CHAIN_FILL=false`. See `docs/rpc-budget.md`. |

## Related

- [Free Tools](https://freezedry.art/tools) — RPC calculator, standalone inscriber, embed widget, and more
- [freezedry-protocol](https://github.com/freezedry-protocol/freezedry-protocol) — SDK packages + Anchor programs
- [freezedry.art](https://freezedry.art) — Full app with managed infrastructure

## License

MIT
