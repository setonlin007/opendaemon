# OpenDaemon

A self-evolving agent harness that grows with you.

It sits on top of LLM engines (Claude SDK, OpenAI-compatible APIs), injects custom capabilities via MCP, and learns from every interaction to improve over time.

**Not a chatbot, not a framework** — a lightweight infrastructure layer that becomes increasingly specialized in your domain.

## Features

- **Multi-engine** — Claude Agent SDK, OpenAI-compatible APIs (GPT-4, Kimi K2, Gemini, etc.)
- **Self-evolution** — Trace capture → reflection → knowledge consolidation → behavior improvement
- **MCP capability layer** — Web search, messaging (Bark/Feishu/WeChat), cron tasks, reminders
- **Sub-agent orchestration** — Decompose complex tasks into parallel specialized agents
- **Single-process deployment** — `node server.mjs`, no Docker, no complex infrastructure
- **Zero-build frontend** — Single HTML file, vanilla JS, no build tools

## Quick Install

One line:

```bash
curl -fsSL https://raw.githubusercontent.com/setonlin007/opendaemon/main/install.sh | sudo bash
```

With proxy:

```bash
curl -fsSL https://raw.githubusercontent.com/setonlin007/opendaemon/main/install.sh | PROXY_URL=http://host:port sudo -E bash
```

### Supported Platforms

| Platform | Notes |
|----------|-------|
| **macOS** | Homebrew, current user, `~/opendaemon` |
| **Ubuntu / Debian** | apt, creates `opendaemon` user |
| **CentOS / RHEL** | yum, creates `opendaemon` user |
| **Windows** | Via WSL (Windows Subsystem for Linux) |

### Requirements

- Node.js 20+
- Python 3.8+
- Git

The installer handles all dependencies automatically.

### Update

Run the same install command again — it auto-detects existing installs, pulls latest code, updates dependencies, and restarts the service:

```bash
curl -fsSL https://raw.githubusercontent.com/setonlin007/opendaemon/main/install.sh | bash
```

Your config, data, and knowledge are preserved.

## Manual Install

```bash
git clone https://github.com/setonlin007/opendaemon.git
cd opendaemon
npm install
python3 -m venv mcp/.venv
mcp/.venv/bin/pip install -r mcp/requirements.txt
```

Create `config.json`:

```json
{
  "auth": {
    "password": "your-password"
  },
  "engines": {
    "claude": {
      "provider": "claude-code"
    }
  }
}
```

Start:

```bash
node server.mjs
# or with pm2:
pm2 start server.mjs --name opendaemon
```

Visit `http://localhost:3456`

## Configuration

All config lives in `config.json`:

```json
{
  "auth": { "password": "..." },
  "server": { "host": "0.0.0.0", "port": 3456 },
  "engines": {
    "claude": {
      "provider": "claude-code"
    },
    "kimi": {
      "provider": "openai",
      "baseUrl": "https://api.moonshot.cn/v1",
      "apiKey": "sk-...",
      "model": "kimi-k2"
    }
  },
  "mcp": {
    "opendaemon": {
      "command": "mcp/.venv/bin/python",
      "args": ["mcp/server.py"],
      "channels": {
        "bark": { "type": "bark", "key": "...", "server": "https://api.day.app" },
        "feishu": { "type": "feishu", "app_id": "...", "app_secret": "..." }
      }
    }
  }
}
```

### Engines

| Type | Provider | Example |
|------|----------|---------|
| Claude Agent SDK | `claude-code` | Claude Opus, Sonnet |
| OpenAI-compatible | `openai` | GPT-4, Kimi K2, Gemini, DeepSeek |

### MCP Channels

| Channel | Use |
|---------|-----|
| Bark | iOS push notifications |
| Feishu | Feishu/Lark bot messages |
| WeChat | WeChat HTTP gateway |

## How Self-Evolution Works

```
User interaction → Trace captured → Reflection analyzes patterns
→ Knowledge extracted → Injected into future conversations
→ Daemon becomes smarter over time
```

1. **Traces** — Every interaction logs tokens, tools used, timing, cost, and user feedback (thumbs up/down)
2. **Reflection** — Periodic analysis extracts patterns, rules, and insights
3. **Knowledge** — Stored as human-readable Markdown files, auto-injected into prompts
4. **Goals** — User-defined `data/goals.md` guides what the daemon should learn

Evolution trigger strategies: manual, conservative (weekly), balanced (daily), aggressive (per-conversation).

## Project Structure

```
opendaemon/
├── server.mjs              # Main server
├── config.json             # Configuration
├── install.sh              # One-line installer
├── lib/                    # Backend modules
│   ├── engine-claude.mjs   # Claude Agent SDK adapter
│   ├── engine-openai.mjs   # OpenAI-compatible adapter
│   ├── mcp-manager.mjs     # MCP subprocess manager
│   ├── knowledge.mjs       # Knowledge CRUD
│   ├── reflect.mjs         # Reflection engine
│   ├── evolution.mjs       # Evolution strategies
│   ├── orchestrator.mjs    # Sub-agent orchestration
│   ├── self-coder.mjs      # Auto tool generation
│   └── ...
├── public/                 # Web UI (single HTML)
├── mcp/                    # Python MCP server
│   ├── server.py           # MCP entry point
│   ├── channels/           # Messaging (Bark, Feishu, WeChat)
│   └── tools/              # Web search, notify, cron, etc.
├── data/                   # Runtime data (gitignored)
│   ├── opendaemon.db       # SQLite database
│   ├── goals.md            # Growth goals
│   └── knowledge/          # Learned knowledge
└── scripts/                # Deploy & setup
```

## Tech Stack

- **Backend**: Node.js, native HTTP, SQLite (better-sqlite3)
- **Frontend**: Vanilla JS, single HTML file, no build step
- **MCP**: Python, stdio transport, JSON-RPC
- **AI SDKs**: `@anthropic-ai/claude-agent-sdk`, `@openai/agents`

## License

MIT
