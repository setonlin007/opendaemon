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
- **MCP Server**: Python `mcp` SDK (stdio transport, Jarvis skill migration)

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
│   ├── config.mjs        # Config loader + validation + cache (incl. P3 sections)
│   ├── db.mjs            # SQLite schema + CRUD (conversations, messages, traces, knowledge, evolution, sub_agent_runs, evaluations, experiments, self_coded_tools)
│   ├── auth.mjs          # Cookie-based auth (HMAC-signed tokens)
│   ├── engine-claude.mjs # Claude Agent SDK adapter (accepts injected context)
│   ├── engine-openai.mjs # OpenAI-compatible adapter (streaming + function calling)
│   ├── mcp-manager.mjs   # Long-running MCP subprocess manager (JSON-RPC over stdio) + hot-reload
│   ├── trace.mjs         # Trace capture + query + evolution_log helper (sub-agent trace linking)
│   ├── knowledge.mjs     # Knowledge CRUD (Markdown files + SQLite index)
│   ├── injector.mjs      # Build augmented context from knowledge for injection (A/B override support)
│   ├── reflect.mjs       # Reflection engine: build prompt, parse insights, manage pending (evaluator + self-coder integration)
│   ├── evolution.mjs     # Evolution trigger manager (strategy-based reflection scheduling)
│   ├── orchestrator.mjs  # Sub-agent orchestration: decompose, dispatch, synthesize (Phase 3)
│   ├── evaluator.mjs     # Knowledge evaluation: before/after quality scoring (Phase 3)
│   ├── ab-testing.mjs    # A/B testing: experiment management, variant selection (Phase 3)
│   └── self-coder.mjs    # Self-coding: tool proposal, generation, validation, installation (Phase 3)
├── public/
│   ├── index.html        # Main UI (sidebar + chat + engine switching)
│   └── login.html        # Login page
├── data/                 # Runtime data (gitignored)
│   └── opendaemon.db     # SQLite database
├── mcp/                  # Python MCP Server
│   ├── server.py         # MCP entry point (stdio transport)
│   ├── requirements.txt  # Python dependencies
│   ├── channels/         # Messaging channel abstraction
│   │   ├── base.py       # Channel ABC (send + health_check)
│   │   ├── bark.py       # Bark iOS push notifications
│   │   ├── feishu.py     # Feishu Bot REST API
│   │   └── wechat.py     # WeChat HTTP bridge
│   ├── tools/            # MCP tool implementations
│   │   ├── web_search.py # DuckDuckGo search
│   │   ├── send_message.py # Unified message sending
│   │   ├── notify.py     # Bark push notifications
│   │   ├── reminder.py   # One-time scheduled reminders
│   │   └── cron_task.py  # Periodic scheduled tasks
│   └── data/             # Runtime data (gitignored)
├── data/                 # Runtime data (gitignored)
│   ├── opendaemon.db     # SQLite database
│   ├── goals.md          # User-defined growth goals (guides reflection)
│   ├── system_prompt_override.md    # A/B testing: system prompt variant override
│   ├── injection_template_override.md # A/B testing: injection template variant override
│   ├── reflection_prompt_override.md  # A/B testing: reflection prompt variant override
│   └── knowledge/        # Human-readable learned knowledge (Markdown)
│       ├── preferences.md
│       ├── patterns.md
│       ├── domain.md
│       └── rules.md
└── specs/                # Spec-driven development artifacts
    ├── 001-platform-foundation/
    ├── 002-mcp-capability-layer/
    ├── 003-self-evolution/
    ├── 004-file-upload/
    └── 005-advanced-harness/
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
   │    ┌──────────┘
   │    ▼
   │  MCPManager ──── JSON-RPC stdio ────┐
   │                                      │
   └── native MCP ───────────────────────┤
                                          ▼
                                   mcp/server.py (Python)
                                          │
                          ┌───────┬───────┼───────┬──────────┐
                          ▼       ▼       ▼       ▼          ▼
                     web_search send_msg notify reminder  cron_task
                          │       │       │       │          │
                          ▼       ▼       ▼       ▼          ▼
                     DuckDuckGo  Channels Bark  Timer+JSON  Scheduler+JSON
                              (WeChat/Feishu/Bark)
```

### Advanced Harness (Phase 3)

```
Sub-Agent Orchestration:
  User prompt → orchestrator.shouldDispatch() (auto/explicit/disabled)
       → if multi-task: decompose → spawn sub-agents in parallel
       → each sub-agent: tailored system prompt + restricted tools + own trace
       → collect results → synthesize into final response
  Agent types: researcher (🔍), analyst (📊), coder (💻), reviewer (🔎)

Knowledge Evaluation:
  Knowledge accepted → evaluator.queueEvaluation()
       → background: find relevant traces → generate response with/without knowledge
       → judge LLM scores (relevance, accuracy, helpfulness, conciseness)
       → delta > 0 → "passed" | delta ≤ 0 → "failed" (flagged for review)

A/B Testing:
  Create experiment → assign variant per conversation (alternating)
       → track feedback per variant → auto-decide winner at threshold
       → apply winner to override file (system_prompt / injection_template / reflection_prompt)

Self-Coding:
  Reflection detects repeated pattern → propose MCP tool
       → user approves → generate Python code → validate syntax → install
       → hot-reload MCP server → tool available in next conversation
```

### Self-Evolution Loop (Phase 2)

```
Chat Flow (augmented):
  User prompt → injector.mjs (load goals + match knowledge) → augmented system prompt
       → engine → response + SSE stream
       → trace.mjs (capture tokens, tools, timing → traces table)
       → evolution.mjs (increment counters, check thresholds)

Reflection Flow (on-demand or scheduled):
  reflect.mjs (load traces + goals + existing knowledge)
       → build reflection prompt → send to LLM
       → parse insights → auto-accept (confidence ≥ 0.9) or queue for review
       → write to knowledge/*.md + knowledge_index table
       → log to evolution_log table

Trigger Strategies:
  manual → user clicks "Reflect" button
  conservative → weekly cron
  balanced → daily cron + bad feedback threshold (default 3)
  aggressive → per-conversation threshold (default 5) + daily cron
  custom → user-defined schedule + thresholds
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
-- Phase 0
conversations (id TEXT PK, title, engine_id, sdk_session, created_at, updated_at)
messages (id INTEGER PK, conv_id FK, role, content, metadata JSON, created_at)

-- Phase 2: Self-Evolution
traces (id INTEGER PK, conv_id FK, msg_id FK, engine_id, prompt_summary, tools_used JSON, input_tokens, output_tokens, estimated_cost, response_len, duration_ms, feedback, feedback_note, injected_knowledge JSON, parent_trace_id INTEGER, created_at)
knowledge_index (id INTEGER PK, category, title, tags, file_path, line_start, line_end, source_type, confidence, created_at, updated_at)
reflections (id INTEGER PK, engine_id, trace_start, trace_end, trace_count, insights_raw, insights_accepted, insights_auto_accepted, trigger_reason, reflection_tokens, reflection_cost, created_at)
pending_insights (id INTEGER PK, reflection_id FK, category, title, tags, content, confidence, status, created_at)
evolution_log (id INTEGER PK, event_type, event_data JSON, created_at)
evolution_state (id=1, last_reflection_at, bad_feedback_since_last, conv_since_last, updated_at)

-- Phase 3: Advanced Harness
sub_agent_runs (id INTEGER PK, parent_conv_id FK, parent_trace_id FK, agent_type, agent_config JSON, input_context, output_result, status, engine_id, input_tokens, output_tokens, estimated_cost, duration_ms, created_at, completed_at)
evaluations (id INTEGER PK, knowledge_id FK, status, trace_ids JSON, scores_without JSON, scores_with JSON, score_delta REAL, judge_reasoning, engine_id, eval_tokens, eval_cost, created_at, completed_at)
experiments (id INTEGER PK, name, surface, status, variant_a JSON, variant_b JSON, conversations_a, conversations_b, feedback_a JSON, feedback_b JSON, min_conversations, winner, created_at, completed_at)
experiment_assignments (id INTEGER PK, experiment_id FK, conv_id FK, variant, created_at)
self_coded_tools (id INTEGER PK, tool_name UNIQUE, description, input_schema JSON, code, origin_reflection_id, origin_pattern, status, test_result, proposed_at, installed_at, created_at)
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
    "opendaemon": {
      "command": "python", "args": ["mcp/server.py"],
      "channels": {
        "bark":   { "type": "bark",   "key": "...", "server": "https://api.day.app" },
        "feishu": { "type": "feishu", "app_id": "cli_xxx", "app_secret": "xxx", "target_map": {} },
        "wechat": { "type": "wechat", "sender_url": "http://WINDOWS_IP:5679" }
      }
    }
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

### Adding a New MCP Tool

1. Create `mcp/tools/{name}.py` with a `Tool` schema and `handle_{name}()` async function
2. Register in `mcp/tools/__init__.py` (add to `ALL_TOOLS` and `TOOL_HANDLERS`)
3. Tool receives `arguments: dict` and `channels: dict` kwargs
4. Returns `list[TextContent]`
5. No server.mjs changes needed (tools auto-discovered via MCP `tools/list`)

### Adding a New Channel Type

1. Create `mcp/channels/{name}.py` implementing `Channel` base class
2. Implement `send(target, content) -> bool`
3. Register in `mcp/channels/__init__.py` `CHANNEL_TYPES`
4. Add config in `config.json` under `mcp.opendaemon.channels`

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

6. **Why long-running MCP process?** — Reminder timers and cron scheduler live in the MCP Server process memory. If we spawned per-call, these would be lost. MCPManager (`lib/mcp-manager.mjs`) keeps the Python process alive and communicates via stdin/stdout JSON-RPC.

7. **Why channels config inside MCP config?** — Channels are only used by MCP tools (send_message, notify, reminder, cron). Keeping them under `mcp.opendaemon.channels` avoids config sprawl and makes it clear they're MCP Server concerns.

## Spec-Driven Development

Major features use SDD (GitHub Spec Kit pattern):
1. Create `specs/{number}-{name}/spec.md` — what and why
2. Create `plan.md` — how (architecture, data model, API contracts)
3. Create `tasks.md` — ordered implementation tasks with dependencies
4. Implement following the task order

Small changes (bug fixes, config additions) skip SDD and go directly to implementation.

## Roadmap Context

- **Phase 0**: Platform foundation (DONE) — multi-engine, auth, sessions, web UI
- **Phase 1**: MCP capability layer (DONE) — Python MCP Server with web_search, send_message, notify, reminder, cron_task
- **Phase 2**: Self-evolution (DONE) — trace capture, knowledge base (Markdown + SQLite), context injection, reflection engine, evolution trigger strategies (manual/conservative/balanced/aggressive/custom), feedback UI, knowledge/goals/reflect panel
- **Phase 3**: Advanced harness (DONE) — sub-agent orchestration, knowledge evaluator, A/B prompt testing, self-coding MCP tools
- **Phase 4**: TBD

## Origins

OpenDaemon evolved from the Jarvis Assistant project (`jarvis-assistant/`). Jarvis was a Python-based personal AI assistant with WeChat/Feishu channels, custom skills, and a unique self_update capability. OpenDaemon keeps Jarvis's unique value (channels, skills, self-modification) while replacing the custom agent engine with production harnesses (Claude SDK, OpenAI API).
