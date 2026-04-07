#!/bin/bash
# ──────────────────────────────────────────────────────
# OpenDaemon Installer — macOS / Linux / WSL
# One-line install:
#   curl -fsSL https://raw.githubusercontent.com/setonlin007/opendaemon/main/install.sh | sudo bash
# Installs as the calling user (SUDO_USER), not root.
#
# Options (env vars):
#   PROXY_URL=http://host:port  — set HTTP/HTTPS proxy
#   INSTALL_DIR=/custom/path    — custom install directory
#   BRANCH=main                 — git branch to install
# ──────────────────────────────────────────────────────
set -e

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
info() { echo -e "${CYAN}[·]${NC} $1"; }

# ── Detect platform ──
PLATFORM="unknown"
case "$(uname -s)" in
  Darwin)  PLATFORM="macos" ;;
  Linux)
    if grep -qi microsoft /proc/version 2>/dev/null; then
      PLATFORM="wsl"
    else
      PLATFORM="linux"
    fi
    ;;
  MINGW*|MSYS*|CYGWIN*)
    echo ""
    err "Windows is not supported natively.
    Please install WSL first:
      1. Open PowerShell as Admin
      2. Run:  wsl --install
      3. Restart and open Ubuntu from Start menu
      4. Re-run this script inside WSL"
    ;;
esac

# ── Config ──
REPO="https://github.com/setonlin007/opendaemon.git"
BRANCH="${BRANCH:-main}"
PROXY_URL="${PROXY_URL:-}"
PORT=3456

# Platform-specific defaults — always use current user
CURRENT_USER="$(whoami)"
if [ "$PLATFORM" = "macos" ]; then
  INSTALL_DIR="${INSTALL_DIR:-$HOME/opendaemon}"
  RUN_USER="$CURRENT_USER"
else
  # Use the calling user (via SUDO_USER if available, else whoami)
  if [ -n "$SUDO_USER" ] && [ "$SUDO_USER" != "root" ]; then
    RUN_USER="$SUDO_USER"
    RUN_HOME=$(eval echo "~$SUDO_USER")
  else
    RUN_USER="$CURRENT_USER"
    RUN_HOME="$HOME"
  fi
  INSTALL_DIR="${INSTALL_DIR:-$RUN_HOME/opendaemon}"
fi

echo ""
echo -e "${BOLD}╔══════════════════════════════════════╗${NC}"
echo -e "${BOLD}║       OpenDaemon Installer v0.7      ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════╝${NC}"
echo -e "  Platform: ${CYAN}${PLATFORM}${NC}"
echo ""

# ══════════════════════════════════════
#  macOS Install
# ══════════════════════════════════════
install_macos() {
  # No root needed on macOS
  if [ "$(id -u)" -eq 0 ]; then
    warn "No need to run as root on macOS. Proceeding..."
  fi

  # Xcode CLI tools (includes git)
  if ! xcode-select -p &>/dev/null; then
    info "Installing Xcode Command Line Tools..."
    xcode-select --install 2>/dev/null || true
    warn "Please complete the Xcode tools popup, then re-run this script."
    exit 0
  fi

  # Homebrew
  if ! command -v brew &>/dev/null; then
    info "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Add brew to PATH for Apple Silicon
    if [ -f /opt/homebrew/bin/brew ]; then
      eval "$(/opt/homebrew/bin/brew shellenv)"
    fi
  fi
  log "Homebrew ready"

  # Node.js
  NODE_MAJOR=$(node --version 2>/dev/null | cut -d. -f1 | tr -d 'v' || echo "0")
  if [ "$NODE_MAJOR" -lt 20 ]; then
    info "Installing Node.js..."
    brew install node > /dev/null 2>&1
  fi

  # Python 3
  if ! command -v python3 &>/dev/null; then
    info "Installing Python 3..."
    brew install python3 > /dev/null 2>&1
  fi

  log "Node $(node --version), Python $(python3 --version 2>&1 | awk '{print $2}')"

  # Global tools
  info "Installing pm2..."
  npm list -g pm2 > /dev/null 2>&1 || npm install -g pm2 2>&1 | tail -1
  install_or_upgrade_claude_code

  # Resolve symlink (workspace may have moved the project)
  REAL_DIR="$(readlink -f "$INSTALL_DIR" 2>/dev/null || echo "$INSTALL_DIR")"

  # Clone or update
  IS_UPDATE=false
  if [ -d "$REAL_DIR/.git" ]; then
    IS_UPDATE=true
    info "Existing install detected, updating..."
    cd "$REAL_DIR"
    git pull origin "$BRANCH"
    log "Updated to latest"
  else
    info "Cloning repository..."
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone --depth 1 -b "$BRANCH" "$REPO" "$INSTALL_DIR"
    log "Cloned to $INSTALL_DIR"
  fi

  cd "$REAL_DIR"

  # Dependencies
  info "Installing Node.js dependencies..."
  npm install --production 2>&1 | tail -1
  sync_sdk_version
  log "Node.js dependencies installed"

  if [ -f "mcp/requirements.txt" ]; then
    if [ ! -d "mcp/.venv" ]; then
      info "Creating Python venv..."
      python3 -m venv mcp/.venv
    fi
    info "Installing Python dependencies..."
    mcp/.venv/bin/pip install -r mcp/requirements.txt 2>&1 | grep -E "^(Collecting|Installing|Successfully)" || true
    log "Python dependencies installed"
  fi

  # Directories & config
  mkdir -p data mcp/data
  generate_config
  init_workspace

  # Proxy
  setup_proxy "$HOME"

  # Start / Restart
  if [ "$IS_UPDATE" = true ] && pm2 describe opendaemon > /dev/null 2>&1; then
    info "Restarting OpenDaemon..."
    pm2 restart opendaemon > /dev/null 2>&1
  else
    info "Starting OpenDaemon..."
    pm2 delete opendaemon 2>/dev/null || true
    cd "$REAL_DIR"
    if [ -n "$PROXY_URL" ]; then
      HTTP_PROXY="$PROXY_URL" HTTPS_PROXY="$PROXY_URL" pm2 start server.mjs --name opendaemon > /dev/null 2>&1
    else
      pm2 start server.mjs --name opendaemon > /dev/null 2>&1
    fi
  fi
  pm2 save > /dev/null 2>&1
  log "OpenDaemon started"

  show_done "localhost"
}

# ══════════════════════════════════════
#  Linux / WSL Install
# ══════════════════════════════════════
install_linux() {
  if [ "$(id -u)" -ne 0 ]; then
    err "Please run as root:  curl ... | sudo bash"
  fi

  if [ "$PLATFORM" = "wsl" ]; then
    log "WSL detected — installing as Linux"
  fi

  log "Installing as user: $RUN_USER"

  # Detect distro
  PKG_MGR="apt"
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    case "$ID" in
      ubuntu|debian) PKG_MGR="apt" ;;
      centos|rhel|rocky|alma|fedora) PKG_MGR="yum" ;;
      *) warn "Unknown distro: $ID — trying apt..." ;;
    esac
  fi

  # System packages
  info "Installing system packages..."
  if [ "$PKG_MGR" = "apt" ]; then
    apt-get update -qq > /dev/null 2>&1
    apt-get install -y -qq python3 python3-venv sqlite3 curl git > /dev/null 2>&1 || true
  else
    yum install -y -q python3 sqlite curl git > /dev/null 2>&1 || true
  fi

  # Node.js 20
  NODE_MAJOR=$(node --version 2>/dev/null | cut -d. -f1 | tr -d 'v' || echo "0")
  if [ "$NODE_MAJOR" -lt 20 ]; then
    info "Installing Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
    if [ "$PKG_MGR" = "apt" ]; then
      apt-get install -y -qq nodejs > /dev/null 2>&1
    else
      yum install -y -q nodejs > /dev/null 2>&1
    fi
  fi
  log "Node $(node --version), Python $(python3 --version 2>&1 | awk '{print $2}')"

  # Global tools
  info "Installing pm2..."
  npm list -g pm2 > /dev/null 2>&1 || npm install -g pm2 2>&1 | tail -1
  install_or_upgrade_claude_code

  # Resolve symlink
  REAL_DIR="$(readlink -f "$INSTALL_DIR" 2>/dev/null || echo "$INSTALL_DIR")"

  # Clone or update
  IS_UPDATE=false
  if [ -d "$REAL_DIR/.git" ]; then
    IS_UPDATE=true
    info "Existing install detected, updating..."
    cd "$REAL_DIR"
    run_as_user "cd $REAL_DIR && git pull origin $BRANCH"
    log "Updated to latest"
  else
    info "Cloning repository..."
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone --depth 1 -b "$BRANCH" "$REPO" "$INSTALL_DIR"
    chown -R "$RUN_USER":"$RUN_USER" "$INSTALL_DIR"
    log "Cloned to $INSTALL_DIR"
  fi

  cd "$REAL_DIR"

  # Dependencies
  info "Installing Node.js dependencies..."
  npm install --production 2>&1 | tail -1
  sync_sdk_version
  log "Node.js dependencies installed"

  if [ -f "mcp/requirements.txt" ]; then
    if [ ! -d "mcp/.venv" ]; then
      info "Creating Python venv..."
      python3 -m venv mcp/.venv
    fi
    info "Installing Python dependencies..."
    mcp/.venv/bin/pip install -r mcp/requirements.txt 2>&1 | grep -E "^(Collecting|Installing|Successfully)" || true
    log "Python dependencies installed"
  fi

  # Directories & config
  mkdir -p data mcp/data
  generate_config
  init_workspace

  # Fix ownership
  chown -R "$RUN_USER":"$RUN_USER" "$REAL_DIR"
  chown -R "$RUN_USER":"$RUN_USER" "$(dirname "$REAL_DIR")"

  # Proxy
  setup_proxy "$RUN_HOME"

  # Start / Restart
  PM2_ENV=""
  if [ -n "$PROXY_URL" ]; then
    PM2_ENV="HTTP_PROXY=$PROXY_URL HTTPS_PROXY=$PROXY_URL"
  fi
  if [ "$IS_UPDATE" = true ]; then
    info "Restarting OpenDaemon..."
    run_as_user "pm2 restart opendaemon && pm2 save" > /dev/null 2>&1
  else
    info "Starting OpenDaemon..."
    run_as_user "pm2 delete opendaemon 2>/dev/null; cd $REAL_DIR && $PM2_ENV pm2 start server.mjs --name opendaemon && pm2 save" > /dev/null 2>&1
  fi
  log "OpenDaemon started"

  # Auto-start on boot (skip on WSL — no systemd usually)
  if [ "$PLATFORM" != "wsl" ]; then
    env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u "$RUN_USER" --hp "$RUN_HOME" > /dev/null 2>&1 || true
  fi

  IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
  show_done "$IP"
}

# ══════════════════════════════════════
#  Shared functions
# ══════════════════════════════════════

# Run command as RUN_USER (use su only if current user differs)
run_as_user() {
  if [ "$(whoami)" = "$RUN_USER" ]; then
    bash -c "$1"
  else
    su - "$RUN_USER" -c "$1"
  fi
}

install_or_upgrade_claude_code() {
  # Claude Code CLI is optional — OAuth login is handled by OpenDaemon web UI
  if command -v claude &>/dev/null; then
    local CURRENT_CLI=$(claude --version 2>/dev/null | head -1 | awk '{print $1}')
    info "Found Claude Code CLI $CURRENT_CLI, upgrading..."
    npm install -g @anthropic-ai/claude-code@latest 2>&1 | tail -1
    local NEW_CLI=$(claude --version 2>/dev/null | head -1 | awk '{print $1}')
    log "Claude Code CLI $NEW_CLI"
  else
    info "Claude Code CLI not installed — skipping (login via web UI)"
    log "Claude Code CLI: not required"
  fi
}

sync_sdk_version() {
  # After npm install, ensure SDK matches latest CLI
  info "Syncing claude-agent-sdk to latest..."
  npm install @anthropic-ai/claude-agent-sdk@latest 2>&1 | tail -1
  log "SDK synced"
}

init_workspace() {
  local WS_HOME
  if [ "$PLATFORM" = "macos" ]; then
    WS_HOME="$HOME/workspace"
  else
    WS_HOME="$RUN_HOME/workspace"
  fi

  if [ -d "$WS_HOME" ]; then
    log "Workspace already exists at $WS_HOME"
    return
  fi

  info "Initializing workspace..."
  mkdir -p "$WS_HOME/projects" "$WS_HOME/artifacts"

  # Move project into workspace/projects if not already there
  local PROJECT_NAME
  PROJECT_NAME=$(basename "$INSTALL_DIR")
  if [ ! -d "$WS_HOME/projects/$PROJECT_NAME" ]; then
    mv "$INSTALL_DIR" "$WS_HOME/projects/$PROJECT_NAME"
    ln -s "$WS_HOME/projects/$PROJECT_NAME" "$INSTALL_DIR"
  fi

  # Create .workspace.json
  cat > "$WS_HOME/.workspace.json" << WSJSON
{
  "version": 1,
  "projects": {
    "$PROJECT_NAME": {
      "path": "projects/$PROJECT_NAME",
      "type": "node",
      "description": "OpenDaemon agent platform"
    }
  },
  "artifacts_path": "artifacts"
}
WSJSON

  if [ "$PLATFORM" != "macos" ]; then
    chown -R "$RUN_USER":"$RUN_USER" "$WS_HOME"
  fi

  log "Workspace initialized at $WS_HOME"
}

generate_config() {
  if [ ! -f "config.json" ]; then
    cat > config.json << CONF
{
  "auth": {
    "password": "change-me"
  },
  "engines": {
    "claude": {
      "provider": "claude-code"
    }
  }
}
CONF
    log "config.json created — setup wizard will guide you on first visit"
  else
    log "config.json already exists, skipping"
  fi
}

setup_proxy() {
  local HOME_DIR="$1"
  if [ -n "$PROXY_URL" ]; then
    mkdir -p "$HOME_DIR/.claude"
    cat > "$HOME_DIR/.claude/settings.json" << SETTINGS
{
  "env": {
    "HTTP_PROXY": "$PROXY_URL",
    "HTTPS_PROXY": "$PROXY_URL"
  },
  "skipDangerousModePermissionPrompt": true
}
SETTINGS
    if [ "$PLATFORM" != "macos" ] && [ "$(whoami)" != "$RUN_USER" ]; then
      chown -R "$RUN_USER":"$RUN_USER" "$HOME_DIR/.claude"
    fi
    log "Proxy configured: $PROXY_URL"
  fi
}

show_done() {
  local IP="$1"

  echo ""
  echo -e "${BOLD}╔══════════════════════════════════════╗${NC}"
  echo -e "${BOLD}║        Installation Complete!         ║${NC}"
  echo -e "${BOLD}╚══════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  ${CYAN}Project:${NC}   ${INSTALL_DIR}"
  echo -e "  ${CYAN}Config:${NC}    ${INSTALL_DIR}/config.json"
  echo ""
  echo -e "  ${YELLOW}Next steps:${NC}"
  echo -e "    1. Open ${BOLD}http://${IP}:${PORT}${NC} — setup wizard will guide you"
  echo -e "       (includes Claude account login, no extra tools needed)"
  if [ "$PLATFORM" != "macos" ]; then
    echo -e "    2. Open firewall port ${PORT} if needed"
  fi
  echo ""
}

# ── Run ──
case "$PLATFORM" in
  macos)       install_macos ;;
  linux|wsl)   install_linux ;;
  *)           err "Unsupported platform: $PLATFORM" ;;
esac
