# Tasks 003: Self-Evolution

## Dependency Graph

```
T1 (DB schema) ---+
                   +-- T3 (trace module) -- T5 (server trace capture) -- T9 (feedback UI)
T2 (knowledge  ----+
    module)        +-- T4 (injector) ---- T6 (engine injection)
                   |
                   +-- T7 (reflection) --+-- T8 (reflection API) --+-- T10 (knowledge/goals/reflect UI)
                                         |                         |
                                         +-- T7b (evolution mgr) --+
```

## Stage 1: Data Foundation

### T1: Database Schema Changes
**File:** `lib/db.mjs`
**Depends on:** nothing

- [x] Add `traces` table (id, conv_id, msg_id, engine_id, prompt_summary, tools_used, input_tokens, output_tokens, estimated_cost, response_len, duration_ms, feedback, feedback_note, injected_knowledge, created_at)
- [x] Add `knowledge_index` table (id, category, title, tags, file_path, line_start, line_end, source_type, confidence, created_at, updated_at)
- [x] Add `reflections` table (id, engine_id, trace_start, trace_end, trace_count, insights_raw, insights_accepted, insights_auto_accepted, trigger_reason, reflection_tokens, reflection_cost, created_at)
- [x] Add `pending_insights` table (id, reflection_id, category, title, tags, content, confidence, status, created_at)
- [x] Add `evolution_log` table (id, event_type, event_data JSON, created_at) — general-purpose event log for all evolution activities
- [x] Add `evolution_state` table (id=1, last_reflection_at, bad_feedback_since_last, conv_since_last, updated_at) — single-row counter persistence
- [x] Add indexes: idx_traces_conv, idx_traces_created, idx_knowledge_tags, idx_knowledge_category, idx_pending_status, idx_evo_log_type_created
- [x] Ensure `addMessage()` returns the inserted message id

### T2: Knowledge Module
**File:** `lib/knowledge.mjs`
**Depends on:** T1

- [x] `initKnowledge()` -- create `data/knowledge/` dir and seed empty category files (preferences.md, patterns.md, domain.md, rules.md)
- [x] `listKnowledge(category?)` -- query knowledge_index, return entries
- [x] `getKnowledgeContent(id)` -- read entry from Markdown file by line range
- [x] `addKnowledge(category, title, tags, content, sourceType, confidence)` -- append to category Markdown file, update index
- [x] `updateKnowledge(id, content?, tags?, confidence?)` -- modify entry in-place in Markdown, update index
- [x] `deleteKnowledge(id)` -- remove from Markdown file and index
- [x] `searchKnowledge(keywords, maxResults)` -- search by tags and title (LIKE queries)

## Stage 2: Trace Capture

### T3: Trace Module
**File:** `lib/trace.mjs`
**Depends on:** T1

- [x] `addTrace({ conv_id, msg_id, engine_id, prompt_summary, tools_used, input_tokens, output_tokens, estimated_cost, response_len, duration_ms, injected_knowledge })` -- insert trace row
- [x] `updateTraceFeedback(msgId, feedback, note)` -- set feedback on trace by msg_id + log `feedback_received` event
- [x] `getTraces({ since?, until?, limit?, hasFeedback? })` -- query with filters
- [x] `getTraceStats(since?)` -- aggregate: total interactions, tool frequency, feedback ratio, token spend, cost

### T4: Injector Module
**File:** `lib/injector.mjs`
**Depends on:** T2

- [x] `buildInjectedContext(prompt, maxTokens)` -- extract keywords, query knowledge, format context
- [x] Always-inject: "rules" entries with confidence >= 0.7
- [x] Keyword-match: other categories by tags
- [x] Token budget enforcement (configurable, default 2000)
- [x] Return empty string if no relevant knowledge

## Stage 3: Chat Flow Integration

### T5: Server Trace Capture
**File:** `server.mjs`
**Depends on:** T3

- [x] Wrap handleClaudeChat and handleOpenAIChat with timing + tool tracking
- [x] After engine completes, call `addTrace()` with captured data
- [x] Ensure addMessage returns message ID for trace linking
- [x] Route: POST `/api/messages/:id/feedback` -- call `updateTraceFeedback()`
- [x] Route: GET `/api/traces` -- call `getTraces()` with query params

### T6: Engine Context Injection
**Files:** `lib/engine-claude.mjs`, `lib/engine-openai.mjs`, `server.mjs`
**Depends on:** T4

- [x] `engine-claude.mjs`: accept `injectedContext` param, append to systemPrompt under `## Learned Context`
- [x] `server.mjs` handleOpenAIChat: prepend system message with injected context
- [x] `server.mjs` handleChat: call `buildInjectedContext(prompt)` before engine dispatch
- [x] Skip injection if `inject_knowledge: false` in request body

## Stage 4: Reflection Engine

### T7: Reflection Module
**File:** `lib/reflect.mjs`
**Depends on:** T2, T3

- [x] `buildReflectionPrompt(traces, goals, existingKnowledge)` -- construct analysis prompt
- [x] `parseReflectionOutput(text)` -- extract structured insight blocks from LLM output
- [x] `saveAcceptedInsights(insights)` -- call knowledge.addKnowledge for each
- [x] `savePendingInsights(reflectionId, insights)` -- write to pending_insights table
- [x] Auto-accept logic: confidence >= 0.9 → save directly; else → pending
- [x] Goals loading: read `data/goals.md` (create template if missing)

### T7b: Evolution Manager
**File:** `lib/evolution.mjs`
**Depends on:** T7, T3

Manages reflection trigger strategies (manual / conservative / balanced / aggressive / custom).

- [x] `initEvolution(config)` -- read strategy from config, set up scheduled triggers
- [x] `onChatComplete(convId)` -- increment conv counter; check threshold (aggressive mode)
- [x] `onFeedback(msgId, feedback)` -- increment bad feedback counter; check threshold (balanced/aggressive)
- [x] `triggerReflection(engineId)` -- orchestrate: load traces → call reflect → dispatch insights → reset counters → log events
- [x] `logEvolution(eventType, eventData)` -- write to evolution_log table (used by all modules)
- [x] Counter persistence: store `last_reflection_at`, `bad_feedback_since_last`, `conv_since_last` in `evolution_state` SQLite table
- [x] Schedule-based triggers: register cron via existing cron_task infrastructure
  - conservative: weekly (default Sunday 02:00)
  - balanced: daily (default 02:00)
  - aggressive: daily + per-conversation check
  - custom: user-defined cron expression
- [x] `getEvolutionStatus()` -- return strategy, counters, last reflection, next scheduled, pending count

### T8: Reflection & Evolution API Routes
**File:** `server.mjs`
**Depends on:** T7, T7b

- [x] Route: POST `/api/reflect` -- load traces, goals, stream LLM reflection, parse insights
- [x] Route: POST `/api/reflect/:id/accept` -- save accepted insights to knowledge
- [x] Route: GET `/api/goals` -- read data/goals.md
- [x] Route: PUT `/api/goals` -- write data/goals.md
- [x] Route: GET `/api/evolution/status` -- return strategy, counters, pending count
- [x] Route: GET `/api/evolution/pending` -- list pending insights
- [x] Route: POST `/api/evolution/pending/:id/accept` -- accept a pending insight
- [x] Route: POST `/api/evolution/pending/:id/reject` -- reject a pending insight
- [x] Route: GET `/api/evolution/log?type=&since=&limit=` -- query evolution_log with filters
- [x] Route: GET `/api/evolution/stats` -- aggregated stats (token spend, cost trend, feedback ratio, knowledge growth)
- [x] Wire `onChatComplete()` into handleChat completion path
- [x] Wire `onFeedback()` into feedback route

## Stage 5: Frontend

### T9: Feedback UI
**File:** `public/index.html`
**Depends on:** T5

- [x] Thumbs up/down buttons below each assistant message
- [x] POST `/api/messages/:id/feedback` on click
- [x] Visual highlight when active
- [x] Works for both streamed and history-loaded messages
- [x] Message ID available in frontend (carry in SSE `result` event)

### T10: Knowledge, Goals & Reflect UI
**File:** `public/index.html`
**Depends on:** T8

- [x] Knowledge Browser panel (sidebar section or modal)
  - [x] List entries grouped by category
  - [x] Expand/collapse content per entry
  - [x] Delete and edit per entry
- [x] Goals editor: textarea from GET /api/goals, save via PUT
- [x] Reflect button: trigger POST /api/reflect, show streaming output, accept/reject insights
- [x] Injection toggle in chat header, persisted in localStorage

## Stage 6: Polish

### T11: Init & Config
**Depends on:** all above

- [x] Create default `data/goals.md` template on first server start
- [x] Add `evolution` config section to `config.example.json`:
  - `reflection_strategy`: "manual" | "conservative" | "balanced" | "aggressive" | "custom" (default: "balanced")
  - `reflection_engine`: engine_id to use for reflection (default: first configured engine)
  - `reflection_schedule`: cron expression for custom strategy
  - `reflection_bad_feedback_threshold`: integer (default: 3)
  - `reflection_conversation_threshold`: integer (default: 5)
  - `inject_max_tokens`: integer (default: 2000)
  - `trace_enabled`: boolean (default: true)
- [x] Config validation for evolution section

### T12: Documentation
**Depends on:** all above

- [x] Update `CLAUDE.md` with Phase 2 architecture, new files, new routes
- [x] Update tasks.md checkboxes as implementation proceeds

## Implementation Order

1. **T1** (DB schema) -- foundation, includes pending_insights + evolution_state tables
2. **T2** (knowledge) + **T3** (trace) -- parallel
3. **T4** (injector) -- depends on T2
4. **T5** (server trace) + **T6** (engine injection) -- parallel
5. **T7** (reflection module) -- depends on T2 + T3
6. **T7b** (evolution manager) -- depends on T7 + T3
7. **T8** (reflection + evolution API) -- depends on T7 + T7b
8. **T9** (feedback UI) -- depends on T5
9. **T10** (knowledge/goals/reflect/pending UI) -- depends on T8
10. **T11** + **T12** (polish) -- depends on all

Estimated: **6-8 days**
