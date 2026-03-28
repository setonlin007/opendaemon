# Tasks: 001 Platform Foundation

## Dependency Graph

```
T1 (config) ──┐
T2 (db)    ───┤
T3 (auth)  ───┼── T5 (server.mjs) ── T7 (frontend) ── T8 (test)
T4a (claude)──┤
T4b (openai)──┘
T6 (package.json) ── T5
```

## Tasks

### T1: Config Module
**File:** `lib/config.mjs`
**Depends on:** nothing

- [ ] Create `config.example.json` with auth, engines, mcp sections
- [ ] `loadConfig()` reads and caches config.json
- [ ] Validate required fields (auth.password, engines array)
- [ ] Export `getEngineById(id)` helper

### T2: Database Module
**File:** `lib/db.mjs`
**Depends on:** nothing

- [ ] Install better-sqlite3
- [ ] `initDb()` creates tables (conversations, messages) with WAL mode
- [ ] `createConversation(engineId)` → returns conversation object
- [ ] `listConversations()` → sorted by updated_at DESC
- [ ] `getConversation(id)` → single row
- [ ] `deleteConversation(id)` → cascade delete messages
- [ ] `addMessage(convId, role, content, metadata)` → also updates conversation.updated_at
- [ ] `getMessages(convId)` → ordered by id
- [ ] `updateConversationTitle(id, title)`
- [ ] `updateConversationSdkSession(id, sessionId)`
- [ ] Auto-title: first 30 chars of first user message

### T3: Auth Module
**File:** `lib/auth.mjs`
**Depends on:** T1 (config)

- [ ] `createAuth(password)` returns { requireAuth, handleLogin, handleLogout }
- [ ] `handleLogin(req, res)` — timing-safe compare, set signed cookie, 30-day expiry
- [ ] `handleLogout(req, res)` — clear cookie
- [ ] `requireAuth(req, res)` — returns true/false, sends 401 or redirect if not authed
- [ ] Exempt paths: /login.html, /api/login, static assets
- [ ] In-memory token Set (acceptable for single-user)

### T4a: Claude SDK Engine
**File:** `lib/engine-claude.mjs`
**Depends on:** nothing (uses @anthropic-ai/claude-agent-sdk)

- [ ] `streamClaude({ prompt, sdkSessionId, mcpServers, onEvent, abortSignal })`
- [ ] Map SDK events to unified SSE format (system, delta, text, thinking, tool_use, result, etc.)
- [ ] Handle resume via sdkSessionId
- [ ] Return sessionId from result
- [ ] `fetchCommands()` for slash command autocomplete
- [ ] includePartialMessages: true for streaming
- [ ] Handle rate_limit_event
- [ ] Handle errors gracefully (auth, network, abort)

### T4b: OpenAI-Compatible Engine
**File:** `lib/engine-openai.mjs`
**Depends on:** nothing (uses native fetch)

- [ ] `streamOpenAI({ messages, engineConfig, tools, onToolCall, onEvent, abortSignal })`
- [ ] POST to baseUrl/chat/completions with stream: true
- [ ] Parse SSE: `data: {...}` lines, handle `[DONE]`
- [ ] Map to unified events: delta, text, result, error
- [ ] Function calling support:
  - [ ] Accept tools array (OpenAI format)
  - [ ] Detect tool_calls in response
  - [ ] Call onToolCall callback for execution
  - [ ] Send tool results back, continue loop
  - [ ] Max 10 tool-use iterations
- [ ] Handle streaming format variations across providers

### T5: Server Main
**File:** `server.mjs`
**Depends on:** T1, T2, T3, T4a, T4b, T6

- [ ] Import all lib modules
- [ ] Static file serving (public/)
- [ ] Auth middleware on all routes
- [ ] Route: POST /api/login
- [ ] Route: GET /api/logout
- [ ] Route: GET /api/engines
- [ ] Route: GET /api/commands (claude-sdk only)
- [ ] Route: GET /api/conversations
- [ ] Route: POST /api/conversations
- [ ] Route: DELETE /api/conversations/:id
- [ ] Route: GET /api/conversations/:id/messages
- [ ] Route: POST /api/chat — the core:
  - [ ] Look up conversation → get engine config
  - [ ] Save user message to DB
  - [ ] Auto-title if first message
  - [ ] Dispatch to engine adapter
  - [ ] Claude: pass prompt + sdkSessionId + mcpServers → stream → save assistant message → update sdkSession
  - [ ] OpenAI: load full message history from DB → stream with tools → save assistant message
  - [ ] Unified SSE output
- [ ] Graceful error handling on all routes

### T6: Package Setup
**File:** `package.json`
**Depends on:** nothing

- [ ] name: opendaemon
- [ ] type: module
- [ ] dependencies: @anthropic-ai/claude-agent-sdk, better-sqlite3
- [ ] scripts: start, dev
- [ ] npm install

### T7: Frontend
**Files:** `public/index.html`, `public/login.html`
**Depends on:** T5 (needs working API)

- [ ] **login.html**: password input, submit, error display, redirect on success
- [ ] **index.html layout**: sidebar + main chat area
- [ ] **Sidebar**:
  - [ ] Engine selector dropdown (populated from /api/engines)
  - [ ] "+ New Chat" button
  - [ ] Conversation list (grouped by date: Today/Yesterday/Earlier)
  - [ ] Delete button on hover
  - [ ] Active conversation highlight
  - [ ] Engine icon/badge on each conversation
- [ ] **Chat area**:
  - [ ] Header: engine label + status badge
  - [ ] Messages: user bubbles + assistant rendered markdown
  - [ ] Loading indicator (spinner + "Thinking...")
  - [ ] Streaming delta rendering
  - [ ] Tool use blocks (collapsible)
  - [ ] Thinking blocks (collapsible)
  - [ ] Rate limit banner
  - [ ] Error display
- [ ] **Input**:
  - [ ] Textarea with auto-resize
  - [ ] Send / Stop button toggle
  - [ ] Slash command autocomplete (claude-sdk engines only)
  - [ ] Enter to send, Shift+Enter for newline
- [ ] **History replay**: switching conversations loads and renders past messages
- [ ] **Dark theme** (reuse existing CSS variables)
- [ ] **Mobile responsive**

### T8: Integration Test
**Depends on:** T5, T7

- [ ] Start server, verify static files served
- [ ] Test login flow (wrong password → 403, correct → cookie)
- [ ] Test conversation CRUD
- [ ] Test Claude SDK chat (if available)
- [ ] Test OpenAI chat with a real provider
- [ ] Test conversation switching + history replay
- [ ] Test slash command autocomplete

## Implementation Order

1. T6 (package.json) + T1 (config) + T2 (db) — parallel, no deps
2. T3 (auth) — needs config
3. T4a (claude engine) + T4b (openai engine) — parallel, no deps on each other
4. T5 (server.mjs) — wires everything together
5. T7 (frontend) — needs working API
6. T8 (test) — end to end

Estimated: **4-5 days** for a working prototype.
