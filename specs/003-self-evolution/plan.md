# Plan 003: Self-Evolution

## Architecture

```
                    +--- data/goals.md (user-defined)
                    |
User --> server.mjs --> INJECT: load relevant knowledge
              |              |
              |         build augmented system prompt
              |              |
              v              v
         engine adapter (with injected context)
              |
              v
         response + trace capture
              |
              +-->  traces table (SQLite)
              |
              +-->  user feedback (optional)
                        |
                        v
                   REFLECT (on-demand)
                        |
                   reads traces + goals.md
                        |
                   LLM analysis
                        |
                   user review
                        |
                        v
                   LEARN: save to knowledge/
                   update knowledge_index table
```

## Data Model

### New table: `traces`

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| conv_id | TEXT FK | References conversations(id) |
| msg_id | INTEGER FK | References messages(id) -- the assistant message |
| engine_id | TEXT | Engine used |
| prompt_summary | TEXT | First 200 chars of user prompt |
| tools_used | TEXT | JSON array: `[{"name":"web_search","success":true}]` |
| response_len | INTEGER | Character count of assistant response |
| duration_ms | INTEGER | Time from user send to response complete |
| feedback | TEXT | "up", "down", or null |
| feedback_note | TEXT | Optional user note |
| created_at | INTEGER | Unix ms |

### New table: `knowledge_index`

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| category | TEXT | "preferences", "patterns", "domain", "rules" |
| title | TEXT | Short description |
| tags | TEXT | Comma-separated tags |
| file_path | TEXT | Relative path under data/knowledge/ |
| line_start | INTEGER | Start line in Markdown file |
| line_end | INTEGER | End line in Markdown file |
| source_type | TEXT | "reflection", "manual", "feedback" |
| confidence | REAL | 0.0 to 1.0 |
| created_at | INTEGER | Unix ms |
| updated_at | INTEGER | Unix ms |

### New table: `reflections`

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| engine_id | TEXT | Engine used for reflection |
| trace_start | INTEGER | Start of trace window (Unix ms) |
| trace_end | INTEGER | End of trace window (Unix ms) |
| trace_count | INTEGER | Traces analyzed |
| insights_raw | TEXT | Full LLM reflection output |
| insights_accepted | INTEGER | Count of accepted insights |
| created_at | INTEGER | Unix ms |

## File Layout (new/modified)

```
data/
  goals.md                  # NEW: user-defined growth goals
  knowledge/                # NEW: human-readable knowledge store
    preferences.md
    patterns.md
    domain.md
    rules.md

lib/
  db.mjs                    # MODIFIED: add 3 new tables
  trace.mjs                 # NEW: trace capture + query
  knowledge.mjs             # NEW: knowledge CRUD (Markdown + SQLite)
  injector.mjs              # NEW: build augmented context
  reflect.mjs               # NEW: reflection prompt + parsing
  engine-claude.mjs         # MODIFIED: accept injected context
  engine-openai.mjs         # MODIFIED: accept injected context

server.mjs                  # MODIFIED: new routes, trace capture, injection
public/index.html           # MODIFIED: feedback, knowledge panel, goals, reflect UI
```

## API Contracts

### POST /api/messages/:id/feedback
```json
Request:  { "feedback": "up"|"down", "note": "optional" }
Response: { "ok": true }
```

### GET /api/traces?since=TIMESTAMP&limit=50
```json
Response: [{ "id": 1, "conv_id": "abc", "prompt_summary": "...",
             "tools_used": [...], "feedback": "up", "duration_ms": 3200 }]
```

### POST /api/reflect
```json
Request:  { "engine_id": "claude-opus", "since": TIMESTAMP, "limit": 100 }
Response: SSE stream:
  event: delta    data: { "text": "..." }
  event: insight  data: { "category": "...", "title": "...", "content": "...", "tags": [...] }
  event: done     data: { "reflection_id": 1, "insight_count": 5 }
```

### POST /api/reflect/:id/accept
```json
Request:  { "insights": [0, 1, 3] }
Response: { "ok": true, "saved": 3 }
```

### GET /api/knowledge
```json
Response: [{ "id": 1, "category": "preferences", "title": "...",
             "tags": "style,format", "confidence": 0.8 }]
```

### PUT /api/knowledge/:id
```json
Request:  { "content": "...", "tags": "...", "confidence": 0.8 }
Response: { "ok": true }
```

### DELETE /api/knowledge/:id
```json
Response: { "ok": true }
```

### GET /api/goals
```json
Response: { "content": "# My Goals\n..." }
```

### PUT /api/goals
```json
Request:  { "content": "# My Goals\n..." }
Response: { "ok": true }
```

## Injection Strategy

1. Extract keywords from user prompt (split + filter stop words)
2. Query `knowledge_index` by tags matching keywords
3. Always include "rules" category entries with confidence >= 0.7
4. Read relevant sections from Markdown files
5. Trim to token budget (configurable, default 2000 tokens, approx chars/4)
6. **Claude SDK**: append to systemPrompt under `## Learned Context`
7. **OpenAI**: prepend system message with injected context

## Reflection Prompt Template

```
You are analyzing interaction traces for an AI assistant to extract learning insights.

## Growth Goals
{goals.md content}

## Recent Traces
{formatted traces with feedback}

## Current Knowledge
{existing knowledge entries, summarized}

## Instructions
Analyze traces and identify:
1. User preferences (communication style, format, language)
2. Recurring patterns (repeated questions, common workflows)
3. Domain knowledge (frequent topics)
4. Rules (explicit corrections, negative feedback)

For each insight, output:
---
category: {preferences|patterns|domain|rules}
title: {short description}
tags: {comma-separated}
confidence: {0.0-1.0}
content: {the knowledge to remember}
---
```

## Knowledge File Format

Example `data/knowledge/preferences.md`:
```markdown
# Preferences

## Prefers concise answers
_Tags: style, format | Confidence: 0.8 | Source: reflection | Updated: 2026-03-29_

User prefers brief, direct answers. Get straight to the point.

## Prefers Chinese for casual chat
_Tags: language | Confidence: 0.7 | Source: reflection | Updated: 2026-03-29_

When user writes in Chinese, respond in Chinese. Technical docs in English.
```

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Low-quality insights | User reviews all insights before accepting |
| Prompt bloat from injection | Strict token budget; configurable; per-conversation toggle |
| Markdown edit breaks index | Rebuild-index command; index is secondary |
| Traces grow indefinitely | Optional cleanup for traces older than N days |
| Reflection prompt too long | Limit trace count; summarize traces; configurable |
