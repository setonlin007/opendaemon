# OpenDaemon — Project Guide

> This file is read by Claude Code and other AI agents working on this project. It provides architecture context, conventions, and development rules.

## What is OpenDaemon?

A self-evolving agent harness that grows with the user. It sits on top of LLM engines (Claude SDK, OpenAI-compatible APIs), injects custom capabilities via MCP, and learns from every interaction to improve over time in a user-defined direction.

**Core positioning**: We don't build LLM engines. We build the harness that makes any engine useful in YOUR context. See `CONSTITUTION.md` for principles.

## Tech Stack

- **Runtime**: Node.js 18+ (ES modules)
- **Server**: Native `http` module (no Express, no framework)
- **Database**: SQLite via `better-sqlite3` (synchronous API)
- **Frontend**: Single HTML files, vanilla JS, no build tools
- **Claude engine**: `@anthropic-ai/claude-agent-sdk` (Anthropic's agent harness)
- **OpenAI engine**: Native `fetch` + SSE parsing
- **MCP Server**: Python (planned, for Jarvis capability migration)

## Directory Structure

```
opendaemon/
├── CONSTITUTION.md       # Core principles (non-negotiable)
├── CLAUDE.md             # This file — project guide for AI agents
├── LICENSE               # MIT
├── package.json
├── config.example.json   # Configuration template (committed)
├── config.json           # Actual config with secrets (gitignored)
├── server.mjs            # Main server: routing, auth, engine dispatch
├── lib/
│   ├── config.mjs        # Config loader + validation + cache
│   ├── db.mjs            # SQLite schema + CRUD (conversations, messages)
│   ├── auth.mjs          # Cookie-based auth (HMAC-signed tokens)
│   ├── engine-claude.mjs # Claude Agent SDK adapter
│   └── engine-openai.mjs # OpenAI-compatible adapter (streaming + function calling)
├── public/
│   ├── index.html        # Main UI (sidebar + chat + engine switching)
│   └── login.html        # Login page
├── data/                 # Runtime data (gitignored)
│   └── opendaemon.db     # SQLite database
├── mcp/                  # MCP Server (planned)
└── specs/                # Spec-driven development artifacts
    └── 001-platform-foundation/
        ├── spec.md
        ├── plan.md
        └── tasks.md
```

## Architecture

```
Browser → server.mjs → auth check → route dispatch
                          │
             ┌────────────┼────────────┐
             ▼            ▼            ▼
        /api/chat    /api/conv*    /api/engines
             │
     engine dispatch by conv.engine_id
             │
     ┌───────┴───────┐
     ▼               ▼
engine-claude    engine-openai
  (SDK)         (fetch + SSE)
     │               │
     ▼               ▼
  Claude API     Any OpenAI-compatible API
```

### Engine Types

| Type | Adapter | How it works |
|------|---------|-------------|
| `claude-sdk` | `engine-claude.mjs` | Uses `@anthropic-ai/claude-agent-sdk` `query()`. Full agent with tools, MCP, thinking, sub-agents. Session resume via `sdk_session` in DB. |
| `openai` | `engine-openai.mjs` | Standard OpenAI chat completions API with `stream: true`. Supports function calling with a server-side tool-use loop (max 10 iterations). Messages rebuilt from DB each request. |

### SSE Event Format (unified across all engines)

```
event: system          data: { session_id }
event: delta           data: { text }           # streaming text chunk
event: text            data: { text }           # complete text block
event: thinking        data: { thinking }       # complete thinking block
event: thinking_delta  data: { text }           # streaming thinking chunk
event: tool_use        data: { name, id, input }
event: tool_progress   data: { tool_name, data }
event: result          data: { subtype, usage, result }
event: rate_limit      data: { status, resets_at, utilization }
event: error           data: { message }
event: done            data: {}
```

### Database Schema

```sql
conversations (id TEXT PK, title, engine_id, sdk_session, created_at, updated_at)
messages (id INTEGER PK, conv_id FK, role, content, metadata JSON, created_at)
```

### Config Structure (`config.json`)

```json
{
  "auth": { "password": "..." },
  "engines": [
    { "id": "...", "type": "claude-sdk|openai", "label": "...", "icon": "...",
      "provider": { "baseUrl": "...", "apiKey": "...", "model": "..." } }
  ],
  "mcp": {
    "server-name": { "command": "python", "args": ["mcp/server.py"] }
  }
}
```

## Development Rules

### Code Style

1. **ES modules only** — `import/export`, no `require()`
2. **No frameworks** — native `http`, native `fetch`, vanilla JS frontend
3. **No build tools** — no webpack, no React, no TypeScript compilation
4. **Synchronous SQLite** — `better-sqlite3` sync API, no callbacks/promises for DB
5. **Single HTML files** — all CSS and JS inline in HTML, no separate files

### Adding a New Engine Type

1. Create `lib/engine-{name}.mjs` with a `stream{Name}()` function
2. The function takes `{ ..., onEvent, abortSignal }` and calls `onEvent(type, data)` using the unified SSE format above
3. Add type check in `server.mjs` `handleChat()` dispatch
4. Add config validation in `lib/config.mjs`
5. No frontend changes needed (unified SSE format means it just works)

### Adding a New API Route

1. Add route matching in `server.mjs` request handler
2. Use `readBody(req)` for POST bodies, `json(res, data)` for responses
3. Auth is automatic (middleware runs on all routes)
4. Follow existing pattern: check input → do work → return JSON

### Frontend Conventions

- All state in global variables (no framework state management)
- `esc()` for HTML escaping all user content
- `renderMd()` for markdown → HTML (simple regex, no library)
- `scrollToBottom()` after any content change
- Autocomplete only shown for `claude-sdk` engine type

## Key Design Decisions

1. **Why no Express?** — SSE streaming works better with raw `http`. Express v5 had issues with response lifecycle and SSE. Native HTTP gives full control.

2. **Why synchronous SQLite?** — Single-user app, local DB. Blocking for microseconds is fine. Dramatically simpler code than async sqlite3. Matches the pattern used by web_chat.py in the original Jarvis.

3. **Why single HTML files?** — `CONSTITUTION.md` mandates lightweight deployment. A junior dev should set it up in 10 minutes. No `npm run build`, no transpilation step.

4. **Why server-side tool-use loop for OpenAI?** — Keeps the frontend engine-agnostic. Client only sees unified SSE events regardless of which engine is running.

5. **Claude SDK license restriction** — Anthropic does not allow third-party products to offer claude.ai OAuth login. The `claude-sdk` engine type is optional. OpenAI engines have no such restriction.

## Spec-Driven Development

Major features use SDD (GitHub Spec Kit pattern):
1. Create `specs/{number}-{name}/spec.md` — what and why
2. Create `plan.md` — how (architecture, data model, API contracts)
3. Create `tasks.md` — ordered implementation tasks with dependencies
4. Implement following the task order

Small changes (bug fixes, config additions) skip SDD and go directly to implementation.

## Roadmap Context

- **Phase 0**: Platform foundation (DONE) — multi-engine, auth, sessions, web UI
- **Phase 1**: MCP capability layer — Python MCP Server exposing Jarvis skills
- **Phase 2**: Self-evolution — trace → reflect → learn → inject loop
- **Phase 3**: Advanced harness — sub-agents, evaluator, prompt optimization

## Origins

OpenDaemon evolved from the Jarvis Assistant project (`jarvis-assistant/`). Jarvis was a Python-based personal AI assistant with WeChat/Feishu channels, custom skills, and a unique self_update capability. OpenDaemon keeps Jarvis's unique value (channels, skills, self-modification) while replacing the custom agent engine with production harnesses (Claude SDK, OpenAI API).
