# Plan 001: Platform Foundation

## Architecture

```
┌─ public/index.html ──────────────────────────────────┐
│  Sidebar (conversations + engine selector)            │
│  Chat area (streaming messages + tool blocks)         │
│  Input (autocomplete for slash commands)              │
└──────────┬───────────────────────────────────────────┘
           │ SSE (POST /api/chat)
┌─ server.mjs ─────────────────────────────────────────┐
│  Auth middleware (lib/auth.mjs)                       │
│  Router:                                              │
│    /api/login, /api/logout                            │
│    /api/engines                                       │
│    /api/conversations (CRUD)                          │
│    /api/chat → engine dispatch                        │
│    /api/commands                                      │
│    /* → static files                                  │
│                                                       │
│  Engine dispatch:                                     │
│    type === "claude-sdk" → lib/engine-claude.mjs      │
│    type === "openai"     → lib/engine-openai.mjs      │
└───────────────────────────────────────────────────────┘
           │                        │
  Claude Agent SDK           fetch() to provider API
  (MCP servers injected)     (function calling loop)
```

## Data Model

### conversations
| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | 8-char UUID |
| title | TEXT | Auto-generated from first message |
| engine_id | TEXT | References config.engines[].id |
| sdk_session | TEXT | Claude SDK session_id (nullable) |
| created_at | INTEGER | Unix ms |
| updated_at | INTEGER | Unix ms |

### messages
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| conv_id | TEXT FK | References conversations(id) |
| role | TEXT | "user" / "assistant" |
| content | TEXT | Message text |
| metadata | TEXT | JSON: {tools, thinking, usage} |
| created_at | INTEGER | Unix ms |

## API Contracts

### POST /api/login
```json
Request:  { "password": "xxx" }
Response: { "ok": true }  // + Set-Cookie
Error:    { "error": "wrong password" }  // 403
```

### GET /api/engines
```json
Response: [
  { "id": "claude-opus", "type": "claude-sdk", "label": "Claude Opus" },
  { "id": "kimi-k2", "type": "openai", "label": "Kimi K2" }
]
```

### GET /api/conversations
```json
Response: [
  { "id": "abc123", "title": "...", "engine_id": "claude-opus",
    "created_at": 1711..., "updated_at": 1711... }
]
```

### POST /api/conversations
```json
Request:  { "engine_id": "claude-opus" }
Response: { "id": "abc123", "title": "New Chat", "engine_id": "claude-opus", ... }
```

### DELETE /api/conversations/:id
```json
Response: { "ok": true }
```

### GET /api/conversations/:id/messages
```json
Response: [
  { "id": 1, "role": "user", "content": "...", "metadata": null, "created_at": ... },
  { "id": 2, "role": "assistant", "content": "...", "metadata": "{...}", "created_at": ... }
]
```

### POST /api/chat (SSE)
```json
Request: { "conversation_id": "abc123", "prompt": "hello" }
Response: SSE stream (same events for all engines):
  event: system    data: { "session_id": "..." }
  event: delta     data: { "text": "..." }
  event: text      data: { "text": "..." }
  event: thinking  data: { "thinking": "..." }
  event: tool_use  data: { "name": "...", "input": {...} }
  event: result    data: { "subtype": "success", "usage": {...} }
  event: error     data: { "message": "..." }
  event: done      data: {}
```

### GET /api/commands
```json
Response: {
  "commands": [{ "name": "compact", "description": "..." }],
  "agents": [{ "name": "Explore", "description": "..." }]
}
```

## File Structure

```
opendaemon/
  CONSTITUTION.md
  LICENSE
  package.json
  config.example.json
  server.mjs
  lib/
    config.mjs
    db.mjs
    auth.mjs
    engine-claude.mjs
    engine-openai.mjs
  public/
    index.html
    login.html
  data/               (gitignored, auto-created)
  specs/
```

## Dependencies

```json
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.2.85",
    "better-sqlite3": "^11.0.0"
  }
}
```

No other dependencies. Native `http`, `crypto`, `fs` for everything else.

## Key Design Decisions

1. **No Express** — Native http module. Less magic, less dependency, more control over SSE streaming.

2. **Synchronous SQLite** — better-sqlite3 is sync. For a single-user app with fast local DB, blocking for microseconds is fine. Dramatically simpler code than async sqlite3.

3. **Unified SSE format** — Both engines emit identical event types. Frontend has zero engine-specific branching for rendering.

4. **OpenAI tool-use loop server-side** — The server runs the function calling loop (call API → get tool_calls → execute via MCP → send results back → repeat). Client only sees SSE events. This keeps the frontend simple.

5. **MCP lifecycle** — MCP server processes are spawned per-query for Claude SDK (SDK manages this). For OpenAI engine, the platform manages MCP server lifecycle (spawn on first tool call, reuse within conversation).

## Migration from web-claude

The existing `web-claude/` prototype in jarvis-assistant provides:
- Verified Claude SDK integration (server.mjs)
- Working SSE streaming
- Basic chat UI with slash command autocomplete
- Test confirming Max subscription OAuth works

Code will be adapted (not copied directly) into the new opendaemon structure.
