# Tasks 004: Advanced Harness

## Dependency Graph

```
T1 (DB schema) ------+----------------------------------------------+
                      |                                              |
               +------+----------+--------------+                   |
               v      v          v              v                   |
            T2 (orch) T5 (eval) T8 (ab-test) T11 (self-coder)      |
               |         |         |              |                 |
               v         v         v              v                 |
            T3 (orch  T6 (eval  T9 (ab-test    T12 (self-coder     |
               server)   API)     server)        API)               |
               |         |         |              |                 |
               v         v         v              v                 |
            T4 (orch  T7 (eval  T10 (ab-test  T13 (self-coder      |
               UI)       UI)      UI)            UI)                |
                                                  |                 |
                                                  v                 |
                                              T14 (MCP hot-reload)  |
                                                  |                 |
                                                  v                 |
                                              T15 (reflection int.) |
                                                  |                 |
                                                  v                 |
                                              T16 + T17 (polish)    |
```

## Stage 1: Data Foundation

### T1: Database Schema Changes
**File:** `lib/db.mjs`
**Depends on:** nothing

- [ ] Add `sub_agent_runs` table (id, parent_conv_id FK, parent_trace_id FK, agent_type, agent_config JSON, input_context, output_result, status, engine_id, input_tokens, output_tokens, estimated_cost, duration_ms, created_at, completed_at)
- [ ] Add `evaluations` table (id, knowledge_id FK, status, trace_ids JSON, scores_without JSON, scores_with JSON, score_delta REAL, judge_reasoning, engine_id, eval_tokens, eval_cost, created_at, completed_at)
- [ ] Add `experiments` table (id, name, surface, status, variant_a JSON, variant_b JSON, conversations_a, conversations_b, feedback_a JSON, feedback_b JSON, min_conversations, winner, created_at, completed_at)
- [ ] Add `experiment_assignments` table (id, experiment_id FK, conv_id FK, variant, created_at)
- [ ] Add `self_coded_tools` table (id, tool_name UNIQUE, description, input_schema JSON, code, origin_reflection_id, origin_pattern, status, test_result, proposed_at, installed_at, created_at)
- [ ] Add `parent_trace_id` column to `traces` table (INTEGER, nullable, references traces(id))
- [ ] Add indexes: idx_sub_agent_parent_conv, idx_sub_agent_status, idx_eval_knowledge, idx_eval_status, idx_experiments_status, idx_exp_assign_conv, idx_self_coded_status
- [ ] Add new evolution_log event types (documented in plan.md)

## Stage 2: Sub-Agent Orchestration

### T2: Orchestrator Module
**File:** `lib/orchestrator.mjs`
**Depends on:** T1

- [ ] Define built-in agent type configs: `AGENT_TYPES` map with system prompt templates, allowed tools, and model overrides for each type (researcher, analyst, coder, reviewer)
- [ ] `shouldDispatch(prompt, config)` -- ask LLM whether task benefits from decomposition (auto mode); return `{use: bool, subtasks: []}`. For explicit mode, parse `/research`, `/analyze`, `/review` commands from prompt
- [ ] `dispatch(prompt, conv, engine, onEvent)` -- orchestrate: decompose --> spawn sub-agents --> collect results --> synthesize
- [ ] `spawnSubAgent(subtask, engine, parentTraceId, onEvent)` -- run a single sub-agent: build system prompt, restrict tools, call engine adapter, capture trace with parent_trace_id, emit sub_agent_* SSE events
- [ ] `synthesizeResults(originalPrompt, subAgentResults, engine, onEvent)` -- send collected sub-agent outputs to main LLM for final synthesis
- [ ] `recordSubAgentRun(data)` -- insert into sub_agent_runs table
- [ ] Support parallel execution with configurable `max_parallel` (use `Promise.allSettled`)
- [ ] Handle sub-agent failures gracefully: if one fails, synthesize from successful ones + note the failure
- [ ] Token budget: each sub-agent limited by `max_tokens_per_agent` config

### T3: Sub-Agent Server Integration
**File:** `server.mjs`
**Depends on:** T2

- [ ] Modify `handleChat()`: after injection, call `orchestrator.shouldDispatch()` when dispatch_mode is "auto" or "explicit"
- [ ] If dispatch returns subtasks, call `orchestrator.dispatch()` instead of normal engine call
- [ ] Add new SSE events: `sub_agent_start`, `sub_agent_delta`, `sub_agent_done`
- [ ] Route: GET `/api/sub-agents?conv_id=xxx` -- list sub-agent runs for a conversation
- [ ] Route: GET `/api/orchestrator/config` -- return dispatch mode and agent types
- [ ] Route: PUT `/api/orchestrator/config` -- update dispatch mode
- [ ] Sub-agent traces: pass `parent_trace_id` to `addTrace()` for sub-agent traces
- [ ] Modify `trace.mjs`: `addTrace()` accepts optional `parent_trace_id` parameter

### T4: Sub-Agent UI
**File:** `public/index.html`
**Depends on:** T3

- [ ] Sub-agent activity indicator in chat: show "Sub-agents working..." with expandable details
- [ ] For each sub-agent: show type icon, task description, streaming output (collapsible)
- [ ] Final synthesis clearly marked as "Synthesized from N sub-agent results"
- [ ] Orchestrator settings in sidebar: dispatch mode toggle (auto/explicit/disabled)
- [ ] Handle `sub_agent_start`, `sub_agent_delta`, `sub_agent_done` SSE events in frontend

## Stage 3: Evaluator

### T5: Evaluator Module
**File:** `lib/evaluator.mjs`
**Depends on:** T1

- [ ] `queueEvaluation(knowledgeId)` -- insert into evaluations table with status "queued"; find 3-5 relevant traces by matching knowledge tags against trace prompt_summary
- [ ] `runNextEvaluation(engineConfig)` -- pick oldest queued evaluation, run the full evaluation pipeline:
  - a) For each selected trace, regenerate response WITHOUT the knowledge entry
  - b) Regenerate response WITH the knowledge entry injected
  - c) Send both to judge LLM with structured rubric
  - d) Parse scores, compute delta
  - e) Update evaluation record with results
- [ ] `getEvaluations(filters)` -- query evaluations with status/knowledge_id filters
- [ ] `getEvaluationStats()` -- aggregate: total, passed, failed, pending, avg_delta
- [ ] Judge prompt builder: `buildJudgePrompt(originalPrompt, responseA, responseB)`
- [ ] Score parser: `parseJudgeOutput(text)` -- extract JSON scores from LLM output
- [ ] Background loop: `startEvaluationLoop(interval)` -- run every N ms, pick one queued evaluation, execute it. Respects `evaluator.enabled` config
- [ ] Idle detection: only run evaluation when no active chat is streaming (check a global flag)

### T6: Evaluator API Routes
**File:** `server.mjs`
**Depends on:** T5

- [ ] Route: GET `/api/evaluations` -- list evaluations with filters (status, knowledge_id, limit)
- [ ] Route: GET `/api/evaluations/stats` -- aggregated evaluation stats
- [ ] Route: POST `/api/evaluations/run` -- manually trigger evaluation for a knowledge_id
- [ ] Wire evaluator: after `acceptPendingInsight()` and after auto-accept in `processReflectionResult()`, call `evaluator.queueEvaluation(knowledgeId)`
- [ ] Start evaluation background loop in `startup()` function
- [ ] Modify `evolution.mjs`: expose `isIdle()` flag for evaluator to check

### T7: Evaluator UI
**File:** `public/index.html`
**Depends on:** T6

- [ ] Knowledge browser: add evaluation status badge per entry (verified checkmark / flagged warning / pending clock)
- [ ] Evaluation details modal: show before/after scores, delta, judge reasoning
- [ ] Evaluation stats in evolution panel: verified %, avg improvement, recent evaluations
- [ ] Manual trigger button: "Evaluate" on each knowledge entry

## Stage 4: A/B Testing

### T8: A/B Testing Module
**File:** `lib/ab-testing.mjs`
**Depends on:** T1

- [ ] `createExperiment(name, surface, variantA, variantB, minConversations)` -- insert into experiments table
- [ ] `getActiveExperiment()` -- return the currently active experiment (only one at a time)
- [ ] `assignVariant(convId)` -- for active experiment, assign conversation to A or B (alternating); insert into experiment_assignments; return variant content or null if no experiment
- [ ] `recordFeedback(convId, feedback)` -- look up assignment, increment experiment feedback counters
- [ ] `checkExperimentCompletion(experimentId)` -- if both variants have >= min_conversations, auto-decide winner based on good/(good+bad) ratio with minimum 10% difference
- [ ] `decideWinner(experimentId, winner)` -- mark experiment completed, apply winning variant
- [ ] `applyVariant(surface, content)` -- persist winning variant:
  - "system_prompt": write to `data/system_prompt_override.md`
  - "injection_template": write to `data/injection_template_override.md`
  - "reflection_prompt": write to `data/reflection_prompt_override.md`
- [ ] `listExperiments(status)` -- query experiments with optional status filter
- [ ] `cancelExperiment(experimentId)` -- set status to cancelled

### T9: A/B Testing Server Integration
**File:** `server.mjs`, `lib/injector.mjs`, `lib/engine-claude.mjs`, `lib/reflect.mjs`
**Depends on:** T8

- [ ] `server.mjs` handleChat: call `assignVariant(convId)` before building injected context
- [ ] `injector.mjs`: check for injection template override file; if exists, use it instead of hardcoded template
- [ ] `engine-claude.mjs`: check for system prompt override file; if exists, prepend to systemPrompt
- [ ] `reflect.mjs`: check for reflection prompt override file; if exists, use it in `buildReflectionPrompt()`
- [ ] Wire feedback: in feedback route, call `ab-testing.recordFeedback(convId, feedback)` after `onFeedback()`
- [ ] Routes: GET `/api/experiments` -- list all experiments
- [ ] Route: POST `/api/experiments` -- create new experiment
- [ ] Route: POST `/api/experiments/:id/decide` -- manually decide winner
- [ ] Route: DELETE `/api/experiments/:id` -- cancel experiment

### T10: A/B Testing UI
**File:** `public/index.html`
**Depends on:** T9

- [ ] Experiments panel (in evolution/settings area): list active and past experiments
- [ ] Create experiment form: select surface, enter two variants, set min conversations
- [ ] Active experiment indicator: show current variant assignment in chat header (subtle)
- [ ] Results visualization: side-by-side feedback comparison (good/bad counts, ratio)
- [ ] Manual decide button with confirmation

## Stage 5: Self-Coding

### T11: Self-Coder Module
**File:** `lib/self-coder.mjs`
**Depends on:** T1

- [ ] `detectAutomationOpportunity(traces, insights)` -- analyze reflection insights for patterns that suggest a new tool (e.g., repeated similar requests, manual multi-step workflows)
- [ ] `proposeTool(pattern, traces, engineConfig)` -- ask LLM to design a tool: name, description, input_schema, implementation plan. Save to self_coded_tools (status: "proposed")
- [ ] `generateToolCode(toolId, engineConfig)` -- ask LLM to write the Python implementation following existing tool patterns. Provide web_search.py as example
- [ ] `validateTool(toolId)` -- multi-step validation:
  a) Python syntax check via `python -c "import ast; ast.parse(...)"`
  b) Import check: ensure module imports successfully
  c) Schema check: verify Tool and handler exist with correct signatures
- [ ] `installTool(toolId)` -- write code to `mcp/tools/{name}.py`, update `mcp/tools/__init__.py` (append import + registration), record installation
- [ ] `disableTool(toolId)` -- remove from `__init__.py` registry (keep file), update status
- [ ] `enableTool(toolId)` -- re-add to `__init__.py` registry, update status
- [ ] `listSelfCodedTools(status)` -- query self_coded_tools table
- [ ] `getToolDetail(toolId)` -- return full detail including code

### T12: Self-Coder API Routes
**File:** `server.mjs`
**Depends on:** T11

- [ ] Route: GET `/api/self-coded-tools` -- list all self-coded tools
- [ ] Route: GET `/api/self-coded-tools/:id` -- get tool detail with code
- [ ] Route: POST `/api/self-coded-tools/:id/approve` -- validate + install tool
- [ ] Route: POST `/api/self-coded-tools/:id/reject` -- reject proposed tool
- [ ] Route: POST `/api/self-coded-tools/:id/disable` -- disable installed tool
- [ ] Route: POST `/api/self-coded-tools/:id/enable` -- re-enable disabled tool
- [ ] Wire into reflection: in `processReflectionResult()`, if insight category is "automation", call `self-coder.detectAutomationOpportunity()`

### T13: Self-Coder UI
**File:** `public/index.html`
**Depends on:** T12

- [ ] Self-coded tools panel (in evolution area): list tools with status badges (proposed/installed/disabled)
- [ ] Proposed tool card: show name, description, pattern origin, approve/reject buttons
- [ ] Installed tool card: show name, description, usage count (from traces), disable button
- [ ] Code viewer: expandable code block showing the generated Python
- [ ] Notification badge when new tool is proposed

### T14: MCP Hot-Reload
**File:** `lib/mcp-manager.mjs`
**Depends on:** T11

- [ ] `MCPManager.reload()` -- gracefully stop and restart the MCP subprocess without losing pending requests (wait for active calls to complete, then restart)
- [ ] `MCPManager.invalidateToolCache()` -- clear cached tool list so next `listTools()` re-fetches
- [ ] Wire into self-coder install: after `installTool()`, call `mcpManager.reload()`
- [ ] Guard: don't reload while a chat is actively using MCP tools (check global streaming flag)

## Stage 6: Reflection Integration

### T15: Reflection Enhancements
**File:** `lib/reflect.mjs`
**Depends on:** T5, T8, T11

- [ ] Add new insight category "automation" for self-coding opportunities
- [ ] Modify reflection prompt to ask: "Are there repeated patterns that could be automated with a new tool?"
- [ ] After processing reflection results, route "automation" insights to self-coder.detectAutomationOpportunity()
- [ ] Add A/B experiment awareness: if reflection prompt is under experiment, use experimental variant

## Stage 7: Polish

### T16: Config & Init
**Depends on:** all above

- [ ] Add `sub_agents` config section to `config.example.json`
- [ ] Add `evaluator` config section to `config.example.json`
- [ ] Add `ab_testing` config section to `config.example.json`
- [ ] Add `self_coding` config section to `config.example.json`
- [ ] Config validation for all new sections in `lib/config.mjs`
- [ ] Graceful defaults: all P4 features disabled by default except sub-agents (auto mode)
- [ ] Create `data/system_prompt_override.md`, `data/injection_template_override.md`, `data/reflection_prompt_override.md` template files

### T17: Documentation
**Depends on:** all above

- [ ] Update `CLAUDE.md`: Phase 3 architecture, new files, new routes, new config sections
- [ ] Update roadmap: Phase 3 --> DONE, add Phase 4 placeholder
- [ ] Update tasks.md checkboxes as implementation proceeds

## Implementation Order

1. **T1** (DB schema) -- foundation for all features
2. **T2** (orchestrator module) -- sub-agents core logic
3. **T3** (sub-agent server) + **T5** (evaluator module) -- parallel
4. **T4** (sub-agent UI) + **T6** (evaluator API) -- parallel
5. **T7** (evaluator UI) + **T8** (A/B testing module) -- parallel
6. **T9** (A/B testing server) + **T11** (self-coder module) -- parallel
7. **T10** (A/B testing UI) + **T12** (self-coder API) -- parallel
8. **T13** (self-coder UI) + **T14** (MCP hot-reload) -- parallel
9. **T15** (reflection integration) -- ties everything together
10. **T16** + **T17** (polish + docs)

**Estimated: 12-16 days**
