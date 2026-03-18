# Migration: P2P Discovery (Two-Wallet + IP:Port)

Upgrades existing nodes to the new identity system.
**Zero downtime** — all new fields have fallbacks. Nodes keep working during migration.

## Pre-flight

1. **Backup current .env files** (from your local machine):
```bash
# Node 1
ssh -i ~/.ssh/your-key.pem user@node1.example.com \
  "cat /var/lib/freezedry-node/.env" > /tmp/node1-env-backup.txt

# Node 2
ssh -i ~/.ssh/your-key.pem user@node2.example.com \
  "cat /var/lib/freezedry-node/.env" > /tmp/node2-env-backup.txt
```

2. **Generate identity keypairs locally** (one per node):
```bash
# Node 1 identity key
node -e "
  const { Keypair } = require('@solana/web3.js');
  const kp = Keypair.generate();
  console.log('IDENTITY_KEYPAIR=' + JSON.stringify(Array.from(kp.secretKey)));
  console.log('# Identity pubkey: ' + kp.publicKey.toBase58());
" > /tmp/node1-identity.txt

# Node 2 identity key
node -e "
  const { Keypair } = require('@solana/web3.js');
  const kp = Keypair.generate();
  console.log('IDENTITY_KEYPAIR=' + JSON.stringify(Array.from(kp.secretKey)));
  console.log('# Identity pubkey: ' + kp.publicKey.toBase58());
" > /tmp/node2-identity.txt
```

3. **Note the pubkeys** — you'll need them for verification:
```bash
cat /tmp/node1-identity.txt
cat /tmp/node2-identity.txt
```

## Step 1: Deploy Code (both nodes)

```bash
# From your local freezedry-node/ directory
bash scripts/deploy.sh both
```

This deploys the new files (`crypto-auth.js`, `display-name.js`, updated `wallet.js`, `server.js`, etc.) but doesn't change `.env` — nodes restart with existing config and work exactly as before.

## Step 2: Add Identity Keys to .env

### Node 1 (has domain)
```bash
ssh -i ~/.ssh/your-key.pem user@node1.example.com

# Append new vars to .env (existing WALLET_KEYPAIR stays as hot wallet fallback)
sudo tee -a /var/lib/freezedry-node/.env << 'EOF'

# ─── Two-Wallet System (P2P discovery upgrade) ───
# Identity key — peer auth, reputation. Never needs SOL.
IDENTITY_KEYPAIR=<paste from /tmp/node1-identity.txt>
# Hot wallet = existing WALLET_KEYPAIR (no change needed)
# HOT_WALLET_KEYPAIR is optional — falls back to WALLET_KEYPAIR

# ─── P2P Endpoint ───
# Node has a domain, so keep NODE_URL. NODE_ENDPOINT is for IP-only nodes.
# NODE_ENDPOINT=x.x.x.x:3100
EOF

sudo systemctl restart freezedry-node
```

### Node 2 (has domain)
```bash
ssh -i ~/.ssh/your-key.pem user@node2.example.com

sudo tee -a /var/lib/freezedry-node/.env << 'EOF'

# ─── Two-Wallet System (P2P discovery upgrade) ───
IDENTITY_KEYPAIR=<paste from /tmp/node2-identity.txt>

# ─── P2P Endpoint ───
# Node has a domain, so keep NODE_URL. Add endpoint as backup.
NODE_ENDPOINT=x.x.x.x:3100
EOF

sudo systemctl restart freezedry-node
```

## Step 3: Verify

```bash
# Check Node 1 health — should show identityPubkey + displayName
curl -s https://node1.example.com/health | jq '{
  status, identityPubkey, hotWalletPubkey, displayName, endpoint
}'

# Check Node 2 health
curl -s https://node2.example.com/health | jq '{
  status, identityPubkey, hotWalletPubkey, displayName, endpoint
}'

# Verify peer discovery — Node 1 should see Node 2 and vice versa
curl -s https://node1.example.com/nodes | jq '.nodes[] | {url, identityPubkey}'
curl -s https://node2.example.com/nodes | jq '.nodes[] | {url, identityPubkey}'
```

Expected output:
```json
{
  "status": "ok",
  "identityPubkey": "YourIdentityPubkey...",
  "hotWalletPubkey": "YourHotWalletPubkey...",
  "displayName": "swift-fox",
  "endpoint": null
}
```

## Step 4: Deploy Vercel (hydrate)

```bash
# From hydrate/ directory — updates api/nodes.js + leaderboard
vercel --prod --yes
```

Then check the leaderboard at your coordinator's network page — nodes should show display names.

## Step 5: Verify Coordinator Registration

After restart, each node auto-registers with the coordinator on its next poll cycle (up to 1 hour, or restart forces immediate registration).

```bash
# Check coordinator sees both nodes with identity fields
curl -s 'https://freezedry.art/api/nodes?action=list' | jq '.nodes[] | {
  nodeId, nodeUrl, identityPubkey, hotWalletPubkey
}'
```

## Rollback

If anything goes wrong:
1. Remove the new lines from `.env` (`IDENTITY_KEYPAIR`, `NODE_ENDPOINT`)
2. `sudo systemctl restart freezedry-node`
3. Node falls back to `WALLET_KEYPAIR` for everything — zero behavior change

The code is fully backward compatible. Removing the new env vars just means the node won't advertise an identity or display name — everything else works.

## What Changed (for node operators reading this)

| Before | After |
|--------|-------|
| One wallet does everything | Identity key (reputation) + Hot wallet (earning) |
| Must have domain + SSL | IP:port works, domain optional |
| Peers auth via `X-Node-URL` header | Ed25519 signed peer messages (unforgeable) |
| Leaderboard shows hostname | Shows display name (e.g. "swift-fox") |
| Health endpoint: basic stats | Also returns `identityPubkey`, `displayName` |

## Notes

- **If your nodes have domains**, they keep using `NODE_URL`. The `NODE_ENDPOINT` is for community nodes without domains.
- **Existing `WALLET_KEYPAIR`** becomes the hot wallet automatically — no need to set `HOT_WALLET_KEYPAIR` unless you want a separate earning wallet.
- **Identity keys never need SOL**. They're only used for signing peer messages (free, off-chain).
- **Save the identity keypairs securely**. They're tied to your node's reputation on the leaderboard. Losing them means starting fresh.
