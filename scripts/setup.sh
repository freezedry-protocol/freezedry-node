#!/usr/bin/env bash
#
# setup.sh — Guided setup for a Freeze Dry node.
# Generates keypair, writes .env, starts the node, and registers.
#
# Usage:
#   bash scripts/setup.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"

echo ""
echo "  ============================================"
echo "    Freeze Dry Node — Setup Wizard"
echo "  ============================================"
echo ""

# ─── Step 1: Check prerequisites ───

echo "  [1/9] Checking prerequisites..."

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "  ERROR: Node.js not found. Install from https://nodejs.org (v18+)"
  exit 1
fi
NODE_VER=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_VER" -lt 18 ]; then
  echo "  ERROR: Node.js v18+ required (found v$NODE_VER)"
  exit 1
fi
echo "    Node.js v$(node -v | tr -d 'v') ... OK"

# Check if deps installed
if [ ! -d "$ROOT/node_modules" ]; then
  echo "    Installing dependencies..."
  cd "$ROOT" && npm install --production
fi
echo "    Dependencies ... OK"
echo ""

# ─── Step 2: Choose role ───

echo "  [2/9] Choose your node role:"
echo ""
echo "    1) reader  — Index the chain + serve artwork (no wallet needed)"
echo "    2) writer  — Accept inscription jobs from the coordinator"
echo "    3) both    — Reader + writer (recommended)"
echo ""
read -rp "  Enter 1, 2, or 3 [3]: " ROLE_CHOICE
case "${ROLE_CHOICE:-3}" in
  1) ROLE="reader" ;;
  2) ROLE="writer" ;;
  *) ROLE="both" ;;
esac
echo "    Selected: $ROLE"
echo ""

# ─── Step 3: RPC tier selection ───

echo "  [3/9] RPC Tier — determines capacity, polling, and budget limits"
echo ""
echo "    1) Public (free)         — 5 MB max, 1 job,  60s poll,  100K credits/mo"
echo "    2) Helius Developer      — 20 MB max, 2 jobs, 30s poll,  1M credits/mo"
echo "    3) Helius Business       — 50 MB max, 4 jobs, 15s poll,  5M credits/mo"
echo "    4) Self-hosted (Geyser)  — 100 MB max, 8 jobs, 10s poll, unlimited"
echo ""
read -rp "  Enter 1-4 [1]: " TIER_CHOICE

case "${TIER_CHOICE:-1}" in
  2)
    TIER_NAME="Helius Developer"
    MAX_BLOB_MB=20
    CAPACITY=2
    POLL_INTERVAL=30000
    CREDIT_BUDGET=1000000
    HELIUS_PLAN="developer"
    ;;
  3)
    TIER_NAME="Helius Business"
    MAX_BLOB_MB=50
    CAPACITY=4
    POLL_INTERVAL=15000
    CREDIT_BUDGET=5000000
    HELIUS_PLAN="business"
    ;;
  4)
    TIER_NAME="Self-hosted (Geyser)"
    MAX_BLOB_MB=100
    CAPACITY=8
    POLL_INTERVAL=10000
    CREDIT_BUDGET=0
    HELIUS_PLAN="geyser"
    ;;
  *)
    TIER_NAME="Public (free)"
    MAX_BLOB_MB=5
    CAPACITY=1
    POLL_INTERVAL=60000
    CREDIT_BUDGET=100000
    HELIUS_PLAN="free"
    ;;
esac

echo "    Selected: $TIER_NAME"
echo "      Max blob size:     ${MAX_BLOB_MB} MB"
echo "      Concurrent jobs:   $CAPACITY"
echo "      Poll interval:     $((POLL_INTERVAL / 1000))s"
echo "      Credit budget:     $CREDIT_BUDGET/mo"
echo ""

# Blob cache settings (reader/both roles only)
BLOB_CACHE_DAYS=0
BLOB_CACHE_MAX_MB=0
if [ "$ROLE" = "reader" ] || [ "$ROLE" = "both" ]; then
  echo "    Blob cache settings (reader nodes cache blobs locally):"
  echo ""
  read -rp "    Max cache age in days (0 = keep forever) [7]: " BLOB_CACHE_DAYS
  BLOB_CACHE_DAYS="${BLOB_CACHE_DAYS:-7}"
  read -rp "    Max cache size in MB (0 = unlimited) [500]: " BLOB_CACHE_MAX_MB
  BLOB_CACHE_MAX_MB="${BLOB_CACHE_MAX_MB:-500}"
  echo ""
fi

# ─── Step 4: Helius API key ───

echo "  [4/9] Helius RPC key (get one free at https://helius.dev)"
echo ""
EXISTING_KEY=""
if [ -f "$ENV_FILE" ]; then
  EXISTING_KEY=$(grep -oP '(?<=^HELIUS_API_KEY=).+' "$ENV_FILE" 2>/dev/null || true)
fi
if [ -n "$EXISTING_KEY" ] && [ "$EXISTING_KEY" != "your-helius-api-key-here" ]; then
  echo "    Found existing key: ${EXISTING_KEY:0:8}..."
  read -rp "  Keep existing key? [Y/n]: " KEEP_KEY
  if [[ "${KEEP_KEY:-Y}" =~ ^[Yy] ]]; then
    HELIUS_KEY="$EXISTING_KEY"
  else
    read -rp "  Helius API key: " HELIUS_KEY
  fi
else
  read -rp "  Helius API key: " HELIUS_KEY
fi
if [ -z "$HELIUS_KEY" ]; then
  echo "  ERROR: Helius API key is required."
  exit 1
fi
echo ""

# ─── Step 5: Keypairs (two-wallet system) ───
#
# Identity key  — peer auth, reputation, node identity. Never needs SOL.
# Hot wallet    — signs memo TXs, pays fees, receives escrow earnings.
# Legacy: WALLET_KEYPAIR is used for both if IDENTITY/HOT not set.

IDENTITY_KEYPAIR=""
IDENTITY_PUBKEY=""
HOT_WALLET_KEYPAIR=""
HOT_WALLET_PUBKEY=""
WALLET_KEYPAIR=""  # legacy compat

# Helper: generate a Solana keypair, output JSON secret key array
gen_keypair() {
  node -e "
    const { Keypair } = require('@solana/web3.js');
    const kp = Keypair.generate();
    console.log(JSON.stringify(Array.from(kp.secretKey)));
  " 2>/dev/null
}

# Helper: derive pubkey from secret key JSON array
derive_pubkey() {
  node -e "
    const { Keypair } = require('@solana/web3.js');
    try {
      const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(process.argv[1])));
      console.log(kp.publicKey.toBase58());
    } catch { console.log('invalid'); }
  " "$1" 2>/dev/null
}

echo "  [5/9] Node keypairs"
echo ""
echo "    Freeze Dry uses a two-wallet system:"
echo "      Identity key  — your node's identity (peer auth, reputation)"
echo "      Hot wallet    — signs TXs, pays fees, earns escrow"
echo ""

# --- Identity key (always generated/loaded) ---
EXISTING_IDENTITY=""
if [ -f "$ENV_FILE" ]; then
  EXISTING_IDENTITY=$(grep -oP '(?<=^IDENTITY_KEYPAIR=).+' "$ENV_FILE" 2>/dev/null || true)
fi
if [ -n "$EXISTING_IDENTITY" ]; then
  IDENTITY_PUBKEY=$(derive_pubkey "$EXISTING_IDENTITY")
  if [ "$IDENTITY_PUBKEY" = "invalid" ]; then
    echo "    Existing identity key invalid. Generating a new one..."
    EXISTING_IDENTITY=""
  else
    echo "    Found existing identity: $IDENTITY_PUBKEY"
    read -rp "  Keep existing identity key? [Y/n]: " KEEP_IDENTITY
    if [[ "${KEEP_IDENTITY:-Y}" =~ ^[Yy] ]]; then
      IDENTITY_KEYPAIR="$EXISTING_IDENTITY"
    else
      EXISTING_IDENTITY=""
    fi
  fi
fi
if [ -z "$IDENTITY_KEYPAIR" ]; then
  echo "    Generating identity key..."
  IDENTITY_KEYPAIR=$(gen_keypair)
  IDENTITY_PUBKEY=$(derive_pubkey "$IDENTITY_KEYPAIR")
  echo "    Identity: $IDENTITY_PUBKEY"
fi
echo ""

# --- Hot wallet (writer/both only) ---
if [ "$ROLE" = "writer" ] || [ "$ROLE" = "both" ]; then
  echo "    Hot wallet — signs memo transactions, receives escrow earnings."
  echo "    This wallet needs SOL (working capital, reimbursed per job)."
  echo ""

  EXISTING_HOT=""
  EXISTING_LEGACY=""
  if [ -f "$ENV_FILE" ]; then
    EXISTING_HOT=$(grep -oP '(?<=^HOT_WALLET_KEYPAIR=).+' "$ENV_FILE" 2>/dev/null || true)
    EXISTING_LEGACY=$(grep -oP '(?<=^WALLET_KEYPAIR=).+' "$ENV_FILE" 2>/dev/null || true)
  fi

  # Try HOT_WALLET_KEYPAIR first, then fall back to legacy WALLET_KEYPAIR
  HOT_EXISTING="${EXISTING_HOT:-$EXISTING_LEGACY}"

  if [ -n "$HOT_EXISTING" ]; then
    HOT_WALLET_PUBKEY=$(derive_pubkey "$HOT_EXISTING")
    if [ "$HOT_WALLET_PUBKEY" = "invalid" ]; then
      echo "    Existing hot wallet invalid."
      HOT_EXISTING=""
    else
      echo "    Found existing hot wallet: $HOT_WALLET_PUBKEY"
      read -rp "  Keep existing hot wallet? [Y/n]: " KEEP_HOT
      if [[ "${KEEP_HOT:-Y}" =~ ^[Yy] ]]; then
        HOT_WALLET_KEYPAIR="$HOT_EXISTING"
      else
        HOT_EXISTING=""
      fi
    fi
  fi

  if [ -z "$HOT_WALLET_KEYPAIR" ]; then
    echo ""
    echo "    Options:"
    echo "      1) Generate a new hot wallet (recommended)"
    echo "      2) Paste an existing keypair (JSON array)"
    echo ""
    read -rp "  Enter 1 or 2 [1]: " KP_CHOICE

    if [ "${KP_CHOICE:-1}" = "2" ]; then
      echo "    Paste your keypair JSON (e.g. [1,2,3,...,64]):"
      read -rp "  > " HOT_WALLET_KEYPAIR
      HOT_WALLET_PUBKEY=$(derive_pubkey "$HOT_WALLET_KEYPAIR")
      if [ "$HOT_WALLET_PUBKEY" = "invalid" ]; then
        echo "  ERROR: Invalid keypair format."
        exit 1
      fi
    else
      echo "    Generating new hot wallet..."
      HOT_WALLET_KEYPAIR=$(gen_keypair)
      HOT_WALLET_PUBKEY=$(derive_pubkey "$HOT_WALLET_KEYPAIR")
      echo ""
      echo "    NEW HOT WALLET: $HOT_WALLET_PUBKEY"
      echo ""
      echo "    IMPORTANT: Fund this wallet with SOL before running inscription jobs."
      echo "    Transfer ~0.1 SOL for testing, ~1 SOL for production workloads."
      echo "    Send SOL to: $HOT_WALLET_PUBKEY"
      echo ""
      echo "    This SOL is working capital — you get reimbursed per chunk from"
      echo "    the job escrow (5,000 lamports/chunk) plus 40% of the margin as profit."
    fi
  fi
  echo ""
else
  echo "  [5/9] Hot wallet ... skipped (reader-only)"
  echo ""
fi

# ─── Step 6: Node identity + network ───

echo "  [6/9] Node identity + network"
echo ""
read -rp "  Node ID (friendly name) [freezedry-node]: " NODE_ID
NODE_ID="${NODE_ID:-freezedry-node}"

read -rp "  Port [3100]: " PORT
PORT="${PORT:-3100}"

echo ""
echo "    How should other nodes reach you?"
echo "      1) IP:port  — No domain needed (recommended for most operators)"
echo "      2) Domain   — HTTPS URL (e.g. https://node.yourdomain.com)"
echo "      3) Skip     — Reader-only, don't accept inbound connections"
echo ""
read -rp "  Enter 1, 2, or 3 [1]: " NET_CHOICE

NODE_URL=""
NODE_ENDPOINT=""
case "${NET_CHOICE:-1}" in
  2)
    read -rp "  Public URL (e.g. https://node.yourdomain.com): " NODE_URL
    NODE_URL="${NODE_URL:-}"
    ;;
  3)
    echo "    Skipping — this node won't accept inbound peer connections."
    ;;
  *)
    echo "    Enter your server's public IP address."
    echo "    (If you're behind NAT, use your external/public IP)"
    read -rp "  Public IP: " PUBLIC_IP
    if [ -n "$PUBLIC_IP" ]; then
      NODE_ENDPOINT="${PUBLIC_IP}:${PORT}"
      echo "    Endpoint: $NODE_ENDPOINT"
    fi
    ;;
esac
echo ""

# ─── Step 7: Write .env ───

echo "  [7/9] Writing configuration..."

cat > "$ENV_FILE" << ENVEOF
# Freeze Dry Node — Configuration
# Generated by setup.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")

# ─── Role ───
ROLE=$ROLE

# ─── Helius RPC ───
HELIUS_API_KEY=$HELIUS_KEY
HELIUS_PLAN=$HELIUS_PLAN

# ─── RPC Tier Preset ($TIER_NAME) ───
MAX_BLOB_MB=$MAX_BLOB_MB
CAPACITY=$CAPACITY
CREDIT_BUDGET=$CREDIT_BUDGET

# ─── Node Identity ───
NODE_ID=$NODE_ID
PORT=$PORT
ENVEOF

# Network identity
if [ -n "$NODE_URL" ]; then
  echo "NODE_URL=$NODE_URL" >> "$ENV_FILE"
fi
if [ -n "$NODE_ENDPOINT" ]; then
  echo "NODE_ENDPOINT=$NODE_ENDPOINT" >> "$ENV_FILE"
fi

# Two-wallet system: identity + hot wallet
echo "" >> "$ENV_FILE"
echo "# ─── Keypairs (two-wallet system) ───" >> "$ENV_FILE"
echo "IDENTITY_KEYPAIR=$IDENTITY_KEYPAIR" >> "$ENV_FILE"
if [ -n "$HOT_WALLET_KEYPAIR" ]; then
  echo "HOT_WALLET_KEYPAIR=$HOT_WALLET_KEYPAIR" >> "$ENV_FILE"
fi
# Legacy compat: WALLET_KEYPAIR still works if IDENTITY/HOT not set
if [ -n "$HOT_WALLET_KEYPAIR" ]; then
  echo "WALLET_KEYPAIR=$HOT_WALLET_KEYPAIR" >> "$ENV_FILE"
elif [ -n "$IDENTITY_KEYPAIR" ]; then
  echo "WALLET_KEYPAIR=$IDENTITY_KEYPAIR" >> "$ENV_FILE"
fi

# Blob cache settings
if [ "$BLOB_CACHE_DAYS" != "0" ] || [ "$BLOB_CACHE_MAX_MB" != "0" ]; then
  echo "" >> "$ENV_FILE"
  echo "# ─── Blob Cache (pruning) ───" >> "$ENV_FILE"
  echo "BLOB_CACHE_DAYS=$BLOB_CACHE_DAYS" >> "$ENV_FILE"
  echo "BLOB_CACHE_MAX_MB=$BLOB_CACHE_MAX_MB" >> "$ENV_FILE"
fi

# Generate WEBHOOK_SECRET for peer sync authentication
WEBHOOK_SECRET=$(openssl rand -hex 32)
echo "" >> "$ENV_FILE"
echo "# ─── Security ───" >> "$ENV_FILE"
echo "WEBHOOK_SECRET=$WEBHOOK_SECRET" >> "$ENV_FILE"

# Add discovery + network defaults
cat >> "$ENV_FILE" << ENVEOF

# ─── Discovery ───
SERVER_WALLET=  # Set to the inscriber wallet you want to index
REGISTRY_URL=https://freezedry.art/api/registry
COORDINATOR_URL=https://freezedry.art

# ─── Peer Network ───
# Peers are discovered automatically via the coordinator at COORDINATOR_URL.
# You can optionally add known peers here for faster bootstrap (comma-separated URLs).
PEER_NODES=

# ─── Budget Protection ───
POLL_INTERVAL=$POLL_INTERVAL
MAX_FILL_PER_CYCLE=0
MAX_FILL_ATTEMPTS=5

# First Freeze Dry inscription — prevents scanning older history on first run
GENESIS_SIG=5aa34bHQVMFWd3faWG6keuUSs1DQDJqD8RAxytbH1nbSrsCxXSrTtn9voJ7GXVagUcTXRX8eAQmuBWZMScSimNfk

# Jobs marketplace
JOBS_PROGRAM_ID=AmqBYKYCqpmKoFcgvripCQ3bJC2d8ygWWhcoHtmTvvzx

# ─── Performance ───
# WebSocket confirms: default ON (4.6x speedup, 0 extra credits)
# Auto-derives WS URL from HELIUS_API_KEY. No extra config needed.
USE_WEBSOCKET=true
ENVEOF

echo "    .env written to: $ENV_FILE"
echo ""

# ─── Step 8: Display name ───

echo "  [8/9] Generating display name..."

DISPLAY_NAME=""
if [ -n "$IDENTITY_PUBKEY" ]; then
  DISPLAY_NAME=$(node -e "
    const crypto = require('crypto');
    const ADJ=['swift','bright','calm','dark','eager','fair','glad','bold','keen','warm','wild','wise','cool','deep','fast','firm','free','gold','gray','green','lean','loud','mild','neat','pale','pure','rare','rich','safe','soft','tall','thin','true','vast','aged','blue','cold','dry','dull','flat','full','hard','high','hot','kind','late','long','lost','low','new','odd','old','raw','red','sad','shy','sly','tan','top','wet','able','bare','busy','cozy','dear','easy','even','fine','good','half','idle','just','lazy','live','lone','mere','nice','open','pert','real','ripe','rude','sick','slim','snug','sore','sure','tame','tidy','tiny','trim','ugly','used','void','wary','weak','wide','worn','zero','zany'];
    const ANI=['fox','owl','elk','ant','bee','cat','cow','dog','eel','fly','gnu','hen','jay','koi','lynx','moth','newt','oryx','puma','ram','seal','toad','vole','wasp','wren','yak','bass','bear','boar','bull','carp','clam','colt','crab','crow','dart','deer','dove','duck','fawn','frog','goat','gull','hare','hawk','ibis','kite','lark','lion','mink','mole','mule','pike','quail','rook','slug','swan','tern','tick','wolf','worm','finch','crane','eagle','egret','gecko','goose','grouse','horse','heron','koala','lemur','llama','moose','mouse','otter','panda','perch','robin','shark','sheep','skunk','sloth','snail','snake','squid','stork','swift','tiger','trout','viper','whale','bison','camel','coral','dingo','drake','ferret','hyena','raven'];
    const h=crypto.createHash('sha256').update('$IDENTITY_PUBKEY').digest();
    console.log(ADJ[h.readUInt16LE(0)%ADJ.length]+'-'+ANI[h.readUInt16LE(2)%ANI.length]);
  " 2>/dev/null || echo "unknown-node")
fi

# ─── Summary ───

echo "  ============================================"
echo "    Setup Complete!"
echo "  ============================================"
echo ""
echo "    Role:       $ROLE"
echo "    RPC Tier:   $TIER_NAME"
echo "    Node ID:    $NODE_ID"
echo "    Port:       $PORT"
if [ -n "$DISPLAY_NAME" ]; then
  echo "    Name:       $DISPLAY_NAME"
fi
if [ -n "$IDENTITY_PUBKEY" ]; then
  echo "    Identity:   $IDENTITY_PUBKEY"
fi
if [ -n "$HOT_WALLET_PUBKEY" ]; then
  echo "    Hot Wallet: $HOT_WALLET_PUBKEY"
fi
if [ -n "$NODE_URL" ]; then
  echo "    Public URL: $NODE_URL"
fi
if [ -n "$NODE_ENDPOINT" ]; then
  echo "    Endpoint:   $NODE_ENDPOINT"
fi
echo ""
echo "    Tier Settings:"
echo "      Max blob size:     ${MAX_BLOB_MB} MB"
echo "      Concurrent jobs:   $CAPACITY"
echo "      Poll interval:     $((POLL_INTERVAL / 1000))s"
echo "      Credit budget:     $CREDIT_BUDGET/mo"
if [ "$BLOB_CACHE_DAYS" != "0" ] || [ "$BLOB_CACHE_MAX_MB" != "0" ]; then
  echo "      Blob cache age:   ${BLOB_CACHE_DAYS} days"
  echo "      Blob cache max:   ${BLOB_CACHE_MAX_MB} MB"
fi
echo ""

# SOL balance recommendations (informational only)
if [ "$ROLE" = "writer" ] || [ "$ROLE" = "both" ]; then
  echo "  ─── SOL Balance Guide ($TIER_NAME) ───"
  echo ""
  echo "    Each inscription job costs ~0.005-0.02 SOL in TX fees"
  echo "    (depends on chunk count + priority fees)."
  echo ""
  echo "    YOU GET REIMBURSED: When a job completes, the on-chain escrow"
  echo "    pays you back 5,000 lamports/chunk (covers your TX costs) PLUS"
  echo "    40% of the margin as profit. Your SOL is working capital, not spent."
  echo ""
  case "${TIER_CHOICE:-1}" in
    2)
      echo "    With $CAPACITY concurrent jobs at up to ${MAX_BLOB_MB}MB each:"
      echo "      Minimum recommended:  ~0.5 SOL"
      echo "      Comfortable buffer:   ~1.0 SOL"
      echo "      Heavy workload:       ~2.0 SOL"
      echo ""
      echo "    Example: 5x 20MB jobs = ~1,700 chunks = ~0.17 SOL in fees"
      ;;
    3)
      echo "    With $CAPACITY concurrent jobs at up to ${MAX_BLOB_MB}MB each:"
      echo "      Minimum recommended:  ~1.0 SOL"
      echo "      Comfortable buffer:   ~3.0 SOL"
      echo "      Heavy workload:       ~5.0 SOL"
      echo ""
      echo "    Example: 5x 50MB jobs = ~4,275 chunks = ~0.43 SOL in fees"
      ;;
    4)
      echo "    With $CAPACITY concurrent jobs at up to ${MAX_BLOB_MB}MB each:"
      echo "      Minimum recommended:  ~2.0 SOL"
      echo "      Comfortable buffer:   ~5.0 SOL"
      echo "      Heavy workload:       ~10.0 SOL"
      echo ""
      echo "    Example: 5x 100MB jobs = ~8,550 chunks = ~0.86 SOL in fees"
      ;;
    *)
      echo "    With $CAPACITY concurrent job at up to ${MAX_BLOB_MB}MB:"
      echo "      Minimum recommended:  ~0.1 SOL"
      echo "      Comfortable buffer:   ~0.5 SOL"
      echo ""
      echo "    Example: 5x 5MB jobs = ~428 chunks = ~0.04 SOL in fees"
      ;;
  esac
  echo ""
  echo "    Note: The wallet pre-check in the claimer will skip jobs"
  echo "    if your balance is too low, so your SOL is never at risk."
  echo ""
fi

# ─── Step 9: On-chain registration (writer/both only) ───

if [ "$ROLE" = "writer" ] || [ "$ROLE" = "both" ]; then
  PEER_URL="${NODE_URL:-}"
  if [ -z "$PEER_URL" ] && [ -n "$NODE_ENDPOINT" ]; then
    PEER_URL="http://${NODE_ENDPOINT}"
  fi

  if [ -n "$PEER_URL" ] && [ -n "$HOT_WALLET_KEYPAIR" ]; then
    echo "  [9/9] On-chain registration"
    echo ""
    echo "    Writer nodes need an on-chain Node PDA to claim jobs from the"
    echo "    marketplace. This costs ~0.005 SOL (PDA rent + TX fee)."
    echo ""
    echo "    Your hot wallet ($HOT_WALLET_PUBKEY) needs SOL first."
    echo "    If it's already funded, you can register now."
    echo ""
    read -rp "  Register on-chain now? [y/N]: " REG_CHOICE
    if [[ "${REG_CHOICE:-N}" =~ ^[Yy] ]]; then
      echo ""
      echo "    Registering..."
      node scripts/register-onchain.mjs 2>&1 | sed 's/^/    /'
      REG_EXIT=$?
      if [ $REG_EXIT -ne 0 ]; then
        echo ""
        echo "    Registration failed — probably needs funding first."
        echo "    Fund the wallet and run later:"
        echo "      node scripts/register-onchain.mjs"
      fi
      echo ""
    else
      echo ""
      echo "    Skipped. Register later after funding your hot wallet:"
      echo "      node scripts/register-onchain.mjs"
      echo ""
    fi
  fi
fi

echo "  ─── Next Steps ───"
echo ""
echo "    1. Start the node:"
echo "       npm start"
echo ""
if [ -n "$HOT_WALLET_PUBKEY" ]; then
  echo "    2. Fund the hot wallet with SOL:"
  echo "       solana transfer $HOT_WALLET_PUBKEY 0.1 --url mainnet-beta"
  echo ""
  echo "    3. Register on-chain (if not done above):"
  echo "       node scripts/register-onchain.mjs"
  echo ""
  echo "    4. Check health:"
  echo "       curl http://localhost:$PORT/health"
  echo ""
  echo "    Your node auto-discovers peers on startup via the on-chain registry"
  echo "    and coordinator. No manual peer configuration needed."
else
  echo "    2. Check health:"
  echo "       curl http://localhost:$PORT/health"
  echo ""
  echo "    Reader nodes auto-discover peers on startup. No further setup needed."
fi
echo ""
echo "  ─── Docker (alternative) ───"
echo ""
echo "    docker compose up -d"
echo "    docker compose logs -f"
echo ""
