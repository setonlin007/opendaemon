# Tasks 003: Self-Evolution

## Dependency Graph

```
T1 (DB schema) ---+
                   +-- T3 (trace module) -- T5 (server trace capture) -- T9 (feedback UI)
T2 (knowledge  ----+
    module)        +-- T4 (injector) ---- T6 (engine injection)
                   |
                   +-- T7 (reflection) -- T8 (reflection API) -- T10 (knowledge/goals/reflect UI)
```

## Stage 1: Data Foundation

### T1: Database Schema Changes
**File:** `lib/db.mjs`
**Depends on:** nothing

- [ ] Add `traces` table (id, conv_id, msg_id, engine_id, prompt_summary, tools_used, response_len, duration_ms, feedback, feedback_note, created_at)
- [ ] Add `knowledge_index` table (id, category, title, tags, file_path, line_start, line_end, source_type, confidence, created_at, updated_at)
- [ ] Add `reflections` table (id, engine_id, trace_start, trace_end, trace_count, insights_raw, insights_accepted, created_at)
- [ ] Add indexes: idx_traces_conv, idx_traces_created, idx_knowledge_tags, idx_knowledge_category
- [ ] Ensure `addMessage()` returns the inserted message id

### T2: Knowledge Module
**File:** `lib/knowledge.mjs`
**Depends on:** T1

- [ ] `initKnowledge()` -- create `data/knowledge/` dir and seed empty category files (preferences.md, patterns.md, domain.md, rules.md)
- [ ] `listKnowledge(category?)` -- query knowledge_index, return entries
- [ ] `getKnowledgeContent(id)` -- read entry from Markdown file by line range
- [ ] `addKnowledge(category, title, tags, content, sourceType, confidence)` -- append to category Markdown file, update index
- [ ] `updateKnowledge(id, content?, tags?, confidence?)` -- modify entry in-place in Markdown, update index
- [ ] `deleteKnowledge(id)` -- remove from Markdown file and index
- [ ] `searchKnowledge(keywords, maxResults)` -- search by tags and title (LIKE queries)

## Stage 2: Trace Capture

### T3: Trace Module
**File:** `lib/trace.mjs`
**Depends on:** T1

- [ ] `addTrace({ conv_id, msg_id, engine_id, prompt_summary, tools_used, response_len, duration_ms })` -- insert trace row
- [ ] `updateTraceFeedback(msgId, feedback, note)` -- set feedback on trace by msg_id
- [ ] `getTraces({ since?, until?, limit?, hasFeedback? })` -- query with filters
- [ ] `getTraceStats(since?)` -- aggregate: total interactions, tool frequency, feedback ratio

### T4: Injector Module
**File:** `lib/injector.mjs`
**Depends on:** T2

- [ ] `buildInjectedContext(prompt, maxTokens)` -- extract keywords, query knowledge, format context
- [ ] Always-inject: "rules" entries with confidence >= 0.7
- [ ] Keyword-match: other categories by tags
- [ ] Token budget enforcement (configurable, default 2000)
- [ ] Return empty string if no relevant knowledge

## Stage 3: Chat Flow Integration

### T5: Server Trace Capture
**File:** `server.mjs`
**Depends on:** T3

- [ ] Wrap handleClaudeChat and handleOpenAIChat with timing + tool tracking
- [ ] After engine completes, call `addTrace()` with captured data
- [ ] Ensure addMessage returns message ID for trace linking
- [ ] Route: POST `/api/messages/:id/feedback` -- call `updateTraceFeedback()`
- [ ] Route: GET `/api/traces` -- call `getTraces()` with query params

### T6: Engine Context Injection
**Files:** `lib/engine-claude.mjs`, `lib/engine-openai.mjs`, `server.mjs`
**Depends on:** T4

- [ ] `engine-claude.mjs`: accept `injectedContext` param, append to systemPrompt under `## Learned Context`
- [ ] `server.mjs` handleOpenAIChat: prepend system message with injected context
- [ ] `server.mjs` handleChat: call `buildInjectedContext(prompt)` before engine dispatch
- [ ] Skip injection if `inject_knowledge: false` in request body

## Stage 4: Reflection Engine

### T7: Reflection Module
**File:** `lib/reflect.mjs`
**Depends on:** T2, T3

- [ ] `buildReflectionPrompt(traces, goals, existingKnowledge)` -- construct analysis prompt
- [ ] `parseReflectionOutput(text)` -- extract structured insight blocks from LLM output
- [ ] `saveAcceptedInsights(insights)` -- call knowledge.addKnowledge for each
- [ ] Goals loading: read `data/goals.md` (create template if missing)

### T8: Reflection API Routes
**File:** `server.mjs`
**Depends on:** T7

- [ ] Route: POST `/api/reflect` -- load traces, goals, stream LLM reflection, parse insights
- [ ] Route: POST `/api/reflect/:id/accept` -- save accepted insights to knowledge
- [ ] Route: GET `/api/goals` -- read data/goals.md
- [ ] Route: PUT `/api/goals` -- write data/goals.md

## Stage 5: Frontend

### T9: Feedback UI
**File:** `public/index.html`
**Depends on:** T5

- [ ] Thumbs up/down buttons below each assistant message
- [ ] POST `/api/messages/:id/feedback` on click
- [ ] Visual highlight when active
- [ ] Works for both streamed and history-loaded messages
- [ ] Message ID available in frontend (carry in SSE `result` event)

### T10: Knowledge, Goals & Reflect UI
**File:** `public/index.html`
**Depends on:** T8

- [ ] Knowledge Browser panel (sidebar section or modal)
  - [ ] List entries grouped by category
  - [ ] Expand/collapse content per entry
  - [ ] Delete and edit per entry
- [ ] Goals editor: textarea from GET /api/goals, save via PUT
- [ ] Reflect button: trigger POST /api/reflect, show streaming output, accept/reject insights
- [ ] Injection toggle in chat header, persisted in localStorage

## Stage 6: Polish

### T11: Init & Config
**Depends on:** all above

- [ ] Create default `data/goals.md` template on first server start
- [ ] Add `evolution` config section to `config.example.json` (inject_max_tokens, trace_enabled)
- [ ] Config validation for evolution section

### T12: Documentation
**Depends on:** all above

- [ ] Update `CLAUDE.md` with Phase 2 architecture, new files, new routes
- [ ] Update tasks.md checkboxes as implementation proceeds

## Implementation Order

1. **T1** (DB schema) -- foundation
2. **T2** (knowledge) + **T3** (trace) -- parallel
3. **T4** (injector) -- depends on T2
4. **T5** (server trace) + **T6** (engine injection) -- parallel
5. **T7** (reflection module) -- depends on T2 + T3
6. **T8** (reflection API) -- depends on T7
7. **T9** (feedback UI) -- depends on T5
8. **T10** (knowledge/goals/reflect UI) -- depends on T8
9. **T11** + **T12** (polish) -- depends on all

Estimated: **5-7 days**
