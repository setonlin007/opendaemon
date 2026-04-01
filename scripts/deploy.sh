#!/bin/bash
# OpenDaemon deploy script — safe deployment with validation + rollback
# Called by Claude via bash after user confirms deployment.
#
# Flow:
#   1. Pull latest code from git
#   2. Syntax check all JS + Python files
#   3. If valid → delayed pm2 restart (5s delay so Claude can reply)
#   4. After restart → health check
#   5. Write deploy result to conversation as a system message
#   6. If unhealthy → auto-rollback to previous commit
#
# Usage: CONV_ID=<conversation_id> bash scripts/deploy.sh
#   CONV_ID env var is required — the deploy result is written to this conversation.

set -e

cd "$(dirname "$0")/.."
PROJECT_DIR=$(pwd)
DB_PATH="$PROJECT_DIR/data/opendaemon.db"
HEALTH_URL="http://127.0.0.1:3456/api/engines"
PREV_COMMIT=$(git rev-parse --short HEAD)

# ── Helper: write a message to the conversation ──
write_msg() {
  local role="$1"
  local content="$2"
  if [ -z "$CONV_ID" ] || [ ! -f "$DB_PATH" ]; then return; fi
  local now=$(date +%s%3N)  # milliseconds
  sqlite3 "$DB_PATH" "INSERT INTO messages (conv_id, role, content, created_at) VALUES ('$CONV_ID', '$role', '$(echo "$content" | sed "s/'/''/g")', $now);"
  sqlite3 "$DB_PATH" "UPDATE conversations SET updated_at = $now WHERE id = '$CONV_ID';"
}

echo "=== OpenDaemon Deploy ==="
echo "Conversation: ${CONV_ID:-none}"
echo "Current commit: $PREV_COMMIT"

# ── Step 1: Pull latest ──
echo "[1/5] Pulling latest code..."
git pull origin main 2>&1 || { echo "FAILED: git pull failed"; exit 1; }
NEW_COMMIT=$(git rev-parse --short HEAD)
echo "New commit: $NEW_COMMIT"

# Check if server is already running this commit (compare against last deploy, not just git)
RUNNING_BOOT=$(curl -s --max-time 3 "http://127.0.0.1:3456/api/init" 2>/dev/null | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).server_boot||'')}catch{console.log('')}})" 2>/dev/null || echo "")
if [ "$PREV_COMMIT" = "$NEW_COMMIT" ] && [ -n "$RUNNING_BOOT" ]; then
  # Code hasn't changed, but check if server has been restarted since last code change
  echo "Code is up to date. Forcing restart to apply pending changes..."
fi

# ── Step 2: Syntax check ──
echo "[2/5] Validating syntax..."

FAIL=0
FAIL_FILES=""
for f in server.mjs lib/*.mjs; do
  if [ -f "$f" ]; then
    node --check "$f" 2>/dev/null || { FAIL_FILES="$FAIL_FILES $f"; FAIL=1; }
  fi
done

for f in mcp/server.py mcp/tools/*.py mcp/channels/*.py; do
  if [ -f "$f" ]; then
    python3 -c "import ast; ast.parse(open('$f').read())" 2>/dev/null || \
    mcp/.venv/bin/python -c "import ast; ast.parse(open('$f').read())" 2>/dev/null || \
    { FAIL_FILES="$FAIL_FILES $f"; FAIL=1; }
  fi
done

if [ $FAIL -eq 1 ]; then
  echo "FAILED: Syntax errors in:$FAIL_FILES"
  git checkout "$PREV_COMMIT" -- .
  write_msg "assistant" "⚠️ **Deploy failed** — syntax errors in:\`$FAIL_FILES\`. Rolled back to \`$PREV_COMMIT\`."
  echo "Rolled back to $PREV_COMMIT"
  exit 1
fi
echo "All syntax checks passed."

# ── Step 3: Delayed restart ──
echo "[3/5] Scheduling restart in 5 seconds..."
(
  sleep 5
  pm2 restart opendaemon --update-env 2>/dev/null
  sleep 5

  # ── Step 4: Health check ──
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$HEALTH_URL" 2>/dev/null || echo "000")

  if [ "$HTTP_CODE" = "302" ] || [ "$HTTP_CODE" = "200" ]; then
    # ── Step 5a: Success ──
    CHANGES=$(cd "$PROJECT_DIR" && git log --oneline "$PREV_COMMIT..HEAD" 2>/dev/null | head -5)
    write_msg "assistant" "✅ **Deploy succeeded** ($PREV_COMMIT → $NEW_COMMIT)

Changes deployed:
\`\`\`
$CHANGES
\`\`\`
Server is healthy (HTTP $HTTP_CODE)."
    echo "[5/5] Deploy SUCCESS" >> /tmp/opendaemon-deploy.log
  else
    # ── Step 5b: Rollback ──
    cd "$PROJECT_DIR"
    git checkout "$PREV_COMMIT" -- .
    pm2 restart opendaemon --update-env 2>/dev/null
    write_msg "assistant" "❌ **Deploy failed** — health check returned HTTP $HTTP_CODE. Auto-rolled back to \`$PREV_COMMIT\`."
    echo "[5/5] Deploy FAILED, rolled back" >> /tmp/opendaemon-deploy.log
  fi
) &

echo "[4/5] Restart scheduled. Server will restart in ~5 seconds."
echo "DEPLOY_OK"
