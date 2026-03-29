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
| tools_used | TEXT | JSON array: `[{"name":"web_search","success":true,"duration_ms":1200}]` |
| input_tokens | INTEGER | Input/prompt tokens consumed |
| output_tokens | INTEGER | Output/completion tokens consumed |
| estimated_cost | REAL | Estimated cost in USD (based on engine pricing config) |
| response_len | INTEGER | Character count of assistant response |
| duration_ms | INTEGER | Time from user send to response complete |
| feedback | TEXT | "up", "down", or null |
| feedback_note | TEXT | Optional user note |
| injected_knowledge | TEXT | JSON array of knowledge_index IDs injected for this turn |
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
| insights_auto_accepted | INTEGER | Count auto-accepted (confidence >= 0.9) |
| trigger_reason | TEXT | "manual", "schedule", "bad_feedback", "conv_threshold" |
| reflection_tokens | INTEGER | Tokens consumed by the reflection LLM call |
| reflection_cost | REAL | Estimated cost of the reflection call (USD) |
| created_at | INTEGER | Unix ms |

### New table: `evolution_log`

General-purpose event log for the entire evolution system. Designed for dashboards and debugging.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| event_type | TEXT | Event category (see below) |
| event_data | TEXT | JSON payload with event-specific details |
| created_at | INTEGER | Unix ms |

**Event types and their `event_data` payloads:**

| event_type | Fires when | event_data |
|------------|-----------|------------|
| `reflection_triggered` | Reflection starts | `{"trigger":"schedule\|bad_feedback\|conv_threshold\|manual", "trace_count":20, "engine_id":"..."}` |
| `reflection_completed` | Reflection finishes | `{"reflection_id":1, "insights_total":5, "auto_accepted":2, "pending":3, "tokens":1200, "cost":0.03}` |
| `insight_accepted` | User accepts a pending insight | `{"insight_id":1, "category":"preferences", "title":"...", "confidence":0.75}` |
| `insight_rejected` | User rejects a pending insight | `{"insight_id":1, "category":"...", "title":"...", "reason":"..."}` |
| `insight_auto_accepted` | High-confidence auto-accept | `{"insight_id":1, "category":"rules", "confidence":0.95}` |
| `knowledge_created` | New knowledge entry added | `{"knowledge_id":1, "category":"...", "source":"reflection\|manual"}` |
| `knowledge_deleted` | Knowledge entry removed | `{"knowledge_id":1, "category":"...", "title":"..."}` |
| `injection_applied` | Knowledge injected into a chat | `{"conv_id":"abc", "knowledge_ids":[1,3,5], "total_tokens":800}` |
| `feedback_received` | User gives thumbs up/down | `{"msg_id":42, "feedback":"up\|down", "conv_id":"abc", "engine_id":"..."}` |
| `strategy_changed` | Reflection strategy updated | `{"old":"manual", "new":"balanced"}` |
| `counter_reset` | Counters reset after reflection | `{"bad_feedback_count":3, "conv_count":12}` |

**Index:** `idx_evo_log_type_created` on (event_type, created_at) for efficient dashboard queries.

### New table: `evolution_state`

Single-row table to persist evolution counters across restarts.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Always 1 (single row) |
| last_reflection_at | INTEGER | Unix ms of last completed reflection |
| bad_feedback_since_last | INTEGER | Cumulative bad feedbacks since last reflection |
| conv_since_last | INTEGER | Conversations completed since last reflection |
| updated_at | INTEGER | Unix ms |

### Visualization queries (examples for future dashboard)

```sql
-- Daily token spend (chat + reflection)
SELECT date(created_at/1000, 'unixepoch') as day,
       SUM(input_tokens + output_tokens) as total_tokens,
       SUM(estimated_cost) as total_cost
FROM traces GROUP BY day ORDER BY day;

-- Reflection ROI: feedback trend before vs after each reflection
SELECT r.id as reflection_id,
       r.created_at,
       (SELECT COUNT(*) FROM traces t WHERE t.feedback='up' AND t.created_at > r.created_at AND t.created_at < COALESCE((SELECT created_at FROM reflections WHERE id=r.id+1), 9999999999999)) as good_after,
       (SELECT COUNT(*) FROM traces t WHERE t.feedback='down' AND t.created_at > r.created_at AND t.created_at < COALESCE((SELECT created_at FROM reflections WHERE id=r.id+1), 9999999999999)) as bad_after
FROM reflections r;

-- Knowledge growth over time
SELECT date(created_at/1000, 'unixepoch') as day,
       event_type,
       COUNT(*) as count
FROM evolution_log
WHERE event_type IN ('knowledge_created', 'knowledge_deleted')
GROUP BY day, event_type;

-- Injection effectiveness: compare feedback when knowledge was injected vs not
SELECT
  CASE WHEN t.injected_knowledge IS NOT NULL THEN 'with_injection' ELSE 'no_injection' END as mode,
  COUNT(*) as total,
  SUM(CASE WHEN t.feedback='up' THEN 1 ELSE 0 END) as good,
  SUM(CASE WHEN t.feedback='down' THEN 1 ELSE 0 END) as bad
FROM traces t GROUP BY mode;

-- Insight acceptance rate per reflection
SELECT r.id, r.created_at, r.trigger_reason,
       r.insights_accepted, r.insights_auto_accepted,
       (SELECT COUNT(*) FROM pending_insights p WHERE p.reflection_id=r.id AND p.status='rejected') as rejected
FROM reflections r ORDER BY r.created_at;
```

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
  db.mjs                    # MODIFIED: add 6 new tables
  trace.mjs                 # NEW: trace capture + query
  knowledge.mjs             # NEW: knowledge CRUD (Markdown + SQLite)
  injector.mjs              # NEW: build augmented context + injection logging
  reflect.mjs               # NEW: reflection prompt + parsing
  evolution.mjs             # NEW: trigger strategy manager + event logging
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
             "tools_used": [...], "input_tokens": 1500, "output_tokens": 800,
             "estimated_cost": 0.02, "feedback": "up", "duration_ms": 3200,
             "injected_knowledge": [1, 3] }]
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

### GET /api/evolution/log?type=reflection_completed&since=TIMESTAMP&limit=50
```json
Response: [{ "id": 1, "event_type": "reflection_completed",
             "event_data": { "reflection_id": 1, "insights_total": 5,
               "auto_accepted": 2, "pending": 3, "tokens": 1200, "cost": 0.03 },
             "created_at": 1711670400000 }]
```

### GET /api/evolution/stats?since=TIMESTAMP
```json
Response: {
  "period": { "since": 1709078400000, "until": 1711756800000 },
  "tokens": { "chat_input": 45000, "chat_output": 32000, "reflection": 8000, "total": 85000 },
  "cost": { "chat": 1.20, "reflection": 0.15, "total": 1.35 },
  "feedback": { "good": 42, "bad": 8, "none": 150, "ratio": 0.84 },
  "reflections": { "total": 12, "insights_produced": 35, "insights_accepted": 28, "acceptance_rate": 0.80 },
  "knowledge": { "total_entries": 28, "by_category": { "preferences": 8, "patterns": 7, "domain": 9, "rules": 4 } },
  "injection": { "conversations_with": 120, "conversations_without": 30, "feedback_with": { "good": 38, "bad": 4 }, "feedback_without": { "good": 4, "bad": 4 } }
}
```

## Reflection Trigger Architecture

```
                         config.evolution.reflection_strategy
                                      │
                    ┌─────────────────┼─────────────────────┐
                    ▼                 ▼                     ▼
               Schedule-based    Event-based            Manual
               (cron trigger)   (threshold check)    (UI / MCP tool)
                    │                 │                     │
                    │      ┌──────────┴──────────┐         │
                    │      ▼                     ▼         │
                    │  bad_feedback_count   conv_count      │
                    │  >= threshold?        >= threshold?   │
                    │      │                     │         │
                    └──────┴─────────────────────┴─────────┘
                                      │
                                      ▼
                              triggerReflection()
                                      │
                        ┌─────────────┴─────────────┐
                        ▼                           ▼
                 confidence >= 0.9            confidence < 0.9
                 auto-accept                 queue for review
                        │                           │
                        ▼                           ▼
                 knowledge/*.md              pending_insights
                                            (shown in UI next visit)
```

### New module: `lib/evolution.mjs`

Manages reflection trigger logic:

```javascript
// Called on server start
initEvolution(config)
  → if strategy != "manual": register cron via existing cron_task infra
  → load counters (bad_feedback_since_last, conv_since_last) from DB

// Called after each chat completes (in server.mjs handleChat)
onChatComplete(convId)
  → if strategy == "aggressive": increment conv counter, check threshold

// Called when feedback received
onFeedback(msgId, feedback)
  → if feedback == "down" && strategy in ["balanced", "aggressive", "custom"]:
      increment bad_feedback counter, check threshold

// Core
triggerReflection(engineId)
  → load traces since last reflection
  → load goals.md
  → call LLM via existing engine
  → parse insights
  → auto-accept high confidence, queue rest
  → reset counters
  → record in reflections table
```

### New table addition: `pending_insights`

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| reflection_id | INTEGER FK | References reflections(id) |
| category | TEXT | preferences/patterns/domain/rules |
| title | TEXT | Short description |
| tags | TEXT | Comma-separated |
| content | TEXT | The insight content |
| confidence | REAL | 0.0-1.0 |
| status | TEXT | "pending", "accepted", "rejected" |
| created_at | INTEGER | Unix ms |

### New API routes for strategy management

#### GET /api/evolution/status
```json
Response: {
  "strategy": "balanced",
  "last_reflection": 1711670400000,
  "traces_since_last": 15,
  "bad_feedbacks_since_last": 2,
  "pending_insights_count": 3,
  "next_scheduled": "2026-03-30T02:00:00+08:00"
}
```

#### GET /api/evolution/pending
```json
Response: [{ "id": 1, "category": "preferences", "title": "...",
             "content": "...", "confidence": 0.75 }]
```

#### POST /api/evolution/pending/:id/accept
```json
Response: { "ok": true }
```

#### POST /api/evolution/pending/:id/reject
```json
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
