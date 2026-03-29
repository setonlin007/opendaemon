#!/bin/bash
# OpenDaemon deploy script — safe deployment with validation + rollback
# Called by Claude via bash after user confirms deployment.
#
# Flow:
#   1. Pull latest code from git
#   2. Syntax check all JS + Python files
#   3. If valid → delayed pm2 restart (5s delay so Claude can reply)
#   4. After restart → health check
#   5. If unhealthy → auto-rollback to previous commit
#
# Usage: bash scripts/deploy.sh

set -e

cd "$(dirname "$0")/.."
PROJECT_DIR=$(pwd)
HEALTH_URL="http://127.0.0.1:3456/api/engines"
PREV_COMMIT=$(git rev-parse HEAD)

echo "=== OpenDaemon Deploy ==="
echo "Current commit: $PREV_COMMIT"

# ── Step 1: Pull latest ──
echo "[1/5] Pulling latest code..."
git pull origin main 2>&1 || { echo "FAILED: git pull failed"; exit 1; }
NEW_COMMIT=$(git rev-parse HEAD)
echo "New commit: $NEW_COMMIT"

if [ "$PREV_COMMIT" = "$NEW_COMMIT" ]; then
  echo "No new changes to deploy."
  exit 0
fi

# ── Step 2: Syntax check ──
echo "[2/5] Validating syntax..."

# Check all JS files
FAIL=0
for f in server.mjs lib/*.mjs; do
  if [ -f "$f" ]; then
    node --check "$f" 2>/dev/null || { echo "SYNTAX ERROR: $f"; FAIL=1; }
  fi
done

# Check all Python files
for f in mcp/server.py mcp/tools/*.py mcp/channels/*.py; do
  if [ -f "$f" ]; then
    python3 -c "import ast; ast.parse(open('$f').read())" 2>/dev/null || \
    mcp/.venv/bin/python -c "import ast; ast.parse(open('$f').read())" 2>/dev/null || \
    { echo "SYNTAX ERROR: $f"; FAIL=1; }
  fi
done

if [ $FAIL -eq 1 ]; then
  echo "FAILED: Syntax errors found. Rolling back..."
  git checkout "$PREV_COMMIT" -- .
  echo "Rolled back to $PREV_COMMIT"
  exit 1
fi
echo "All syntax checks passed."

# ── Step 3: Delayed restart ──
echo "[3/5] Scheduling restart in 5 seconds..."
(
  sleep 5
  pm2 restart opendaemon --update-env 2>/dev/null
  sleep 3

  # ── Step 4: Health check ──
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$HEALTH_URL" 2>/dev/null || echo "000")

  if [ "$HTTP_CODE" = "302" ] || [ "$HTTP_CODE" = "200" ]; then
    echo "[5/5] Health check PASSED (HTTP $HTTP_CODE)" >> /tmp/opendaemon-deploy.log
  else
    # ── Step 5: Rollback ──
    echo "[5/5] Health check FAILED (HTTP $HTTP_CODE), rolling back..." >> /tmp/opendaemon-deploy.log
    cd "$PROJECT_DIR"
    git checkout "$PREV_COMMIT" -- .
    pm2 restart opendaemon --update-env 2>/dev/null
    echo "Rolled back to $PREV_COMMIT" >> /tmp/opendaemon-deploy.log
  fi
) &

echo "[4/5] Restart scheduled. Server will restart in ~5 seconds."
echo "DEPLOY_OK"
