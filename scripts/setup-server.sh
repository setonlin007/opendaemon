#!/bin/bash
# OpenDaemon Server Setup — run as root on a fresh Ubuntu server
#
# Usage: curl -sL <url> | bash
#   or:  bash scripts/setup-server.sh
#
# What it does:
#   1. Creates 'opendaemon' system user (Claude SDK requires non-root)
#   2. Installs Node.js 20, Python venv, sqlite3, pm2
#   3. Sets up project directory at /home/opendaemon/opendaemon
#   4. Creates Python venv + installs MCP dependencies
#   5. Configures pm2 with proxy env vars + auto-start
#
# Prerequisites:
#   - Ubuntu 22.04+
#   - Root access
#   - Project files already in place (via rsync/git)

set -e

PROJECT_DIR="/home/opendaemon/opendaemon"
PROXY_URL="${PROXY_URL:-}"  # Set externally if needed, e.g. http://host:port

echo "=== OpenDaemon Server Setup ==="

# ── 1. Create user ──
if ! id opendaemon &>/dev/null; then
  useradd -m -s /bin/bash opendaemon
  echo "[setup] Created user: opendaemon"
else
  echo "[setup] User opendaemon already exists"
fi

# ── 2. Install system dependencies ──
echo "[setup] Installing system packages..."
apt-get update -qq
apt-get install -y -qq nodejs npm python3 python3-venv sqlite3 curl git > /dev/null 2>&1 || true

# Install Node.js 20 if not present or wrong version
NODE_MAJOR=$(node --version 2>/dev/null | cut -d. -f1 | tr -d 'v' || echo "0")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "[setup] Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs > /dev/null 2>&1
fi

echo "[setup] Node $(node --version), npm $(npm --version), Python $(python3 --version)"

# ── 3. Install global tools ──
npm list -g pm2 > /dev/null 2>&1 || npm install -g pm2 > /dev/null 2>&1
npm list -g @anthropic-ai/claude-code > /dev/null 2>&1 || npm install -g @anthropic-ai/claude-code > /dev/null 2>&1
echo "[setup] pm2 and claude-code installed"

# ── 4. Setup project ──
if [ ! -d "$PROJECT_DIR" ]; then
  echo "[setup] ERROR: Project not found at $PROJECT_DIR"
  echo "       Please rsync/clone the project first, then re-run this script."
  exit 1
fi

cd "$PROJECT_DIR"

# npm install
if [ ! -d "node_modules" ]; then
  echo "[setup] Installing Node.js dependencies..."
  npm install > /dev/null 2>&1
fi

# Python venv
if [ ! -d "mcp/.venv" ]; then
  echo "[setup] Creating Python venv and installing MCP dependencies..."
  python3 -m venv mcp/.venv
  mcp/.venv/bin/pip install -r mcp/requirements.txt > /dev/null 2>&1
fi

# Data directories
mkdir -p data mcp/data

# Fix ownership
chown -R opendaemon:opendaemon /home/opendaemon

echo "[setup] Project ready at $PROJECT_DIR"

# ── 5. Configure Claude proxy (if needed) ──
if [ -n "$PROXY_URL" ]; then
  mkdir -p /home/opendaemon/.claude
  cat > /home/opendaemon/.claude/settings.json << SETTINGS
{
  "env": {
    "HTTP_PROXY": "$PROXY_URL",
    "HTTPS_PROXY": "$PROXY_URL"
  },
  "skipDangerousModePermissionPrompt": true
}
SETTINGS
  chown -R opendaemon:opendaemon /home/opendaemon/.claude
  echo "[setup] Claude proxy configured: $PROXY_URL"
fi

# ── 6. Fix cookie Secure flag for HTTP access ──
if grep -q "SameSite=Lax; Secure;" "$PROJECT_DIR/lib/auth.mjs" 2>/dev/null; then
  sed -i 's/SameSite=Lax; Secure; Max-Age/SameSite=Lax; Max-Age/' "$PROJECT_DIR/lib/auth.mjs"
  echo "[setup] Removed Secure flag from cookie (for HTTP access)"
fi

# ── 7. Start with pm2 ──
echo "[setup] Starting OpenDaemon..."

# Build pm2 start command with optional proxy
PM2_ENV=""
if [ -n "$PROXY_URL" ]; then
  PM2_ENV="HTTP_PROXY=$PROXY_URL HTTPS_PROXY=$PROXY_URL"
fi

su - opendaemon -c "cd $PROJECT_DIR && $PM2_ENV pm2 start server.mjs --name opendaemon && pm2 save"

# Auto-start on boot
env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u opendaemon --hp /home/opendaemon > /dev/null 2>&1

echo ""
echo "=== Setup Complete ==="
echo "  URL: http://$(hostname -I | awk '{print $1}'):3456"
echo "  User: opendaemon"
echo "  Project: $PROJECT_DIR"
echo "  Config: $PROJECT_DIR/config.json"
echo ""
echo "Next steps:"
echo "  1. Edit config.json (auth password, engines, MCP channels)"
echo "  2. Login to Claude: su - opendaemon -c 'claude'"
echo "  3. Open security group port 3456"
