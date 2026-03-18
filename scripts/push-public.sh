#!/bin/bash
# Safe push to public repo — verifies remote URL matches expected repo
# Usage: bash scripts/push-public.sh

set -e

REPO_NAME=$(basename "$(git rev-parse --show-toplevel)")
ORIGIN_URL=$(git remote get-url origin 2>/dev/null)

# Map repo directory to expected public URL
case "$REPO_NAME" in
  freezedry-node)
    EXPECTED="https://github.com/freezedry-protocol/freezedry-node.git"
    ;;
  freezedry-protocol)
    EXPECTED="https://github.com/freezedry-protocol/freezedry-protocol.git"
    ;;
  *)
    echo "Unknown repo: $REPO_NAME — not pushing"
    exit 1
    ;;
esac

if [ "$ORIGIN_URL" != "$EXPECTED" ]; then
  echo "BLOCKED: origin URL mismatch!"
  echo "  Expected: $EXPECTED"
  echo "  Actual:   $ORIGIN_URL"
  echo ""
  echo "Fix: git remote set-url origin $EXPECTED"
  exit 1
fi

echo "Pushing $REPO_NAME to $EXPECTED..."
git push origin main
echo "Done."
