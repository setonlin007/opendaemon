# Plan 004: Advanced Harness

## Architecture

```
User --> server.mjs --> handleChat()
          |
          +-- injector.mjs (with A/B variant selection)
          |
          +-- orchestrator.mjs (NEW) --- should we use sub-agents?
          |         |
          |    +----+------------------+
          |    v                       v
          |  Main agent            Sub-agents (parallel)
          |  (single turn)         +-- researcher (web_search)
          |                        +-- analyst (context-only)
          |                        +-- coder (file tools)
          |                        +-- reviewer (web_search)
          |                             |
          |                        results merge back
          |                             |
          +-- trace.mjs (with sub-agent linking)
          |
          +-- evaluator.mjs (NEW) --- background verification
          |         |
          |    compare before/after on historical traces
          |    judge LLM scores quality
          |    flag or verify knowledge entries
          |
          +-- ab-testing.mjs (NEW) --- experiment management
          |         |
          |    select variant per conversation
          |    track feedback signals
          |    promote winners
          |
          +-- self-coder.mjs (NEW) --- tool generation
                    |
               reflection detects repeating pattern
               proposes tool --> user approves
               generates Python code --> validates --> installs
               hot-reloads MCP server
```

## Data Model

### New table: `sub_agent_runs`

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| parent_conv_id | TEXT FK | Parent conversation ID |
| parent_trace_id | INTEGER FK | Parent trace that spawned this sub-agent |
| agent_type | TEXT | "researcher", "analyst", "coder", "reviewer", "custom" |
| agent_config | TEXT | JSON: system prompt, tools allowed, model override |
| input_context | TEXT | Context/instructions passed to sub-agent |
| output_result | TEXT | Sub-agent's final output |
| status | TEXT | "running", "completed", "failed", "cancelled" |
| engine_id | TEXT | Engine used for this sub-agent |
| input_tokens | INTEGER | Tokens consumed |
| output_tokens | INTEGER | Tokens consumed |
| estimated_cost | REAL | Cost in USD |
| duration_ms | INTEGER | Execution time |
| created_at | INTEGER | Unix ms |
| completed_at | INTEGER | Unix ms |

### New table: `evaluations`

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| knowledge_id | INTEGER FK | References knowledge_index(id) |
| status | TEXT | "queued", "running", "passed", "failed", "error" |
| trace_ids | TEXT | JSON array of trace IDs used for evaluation |
| scores_without | TEXT | JSON: {relevance, accuracy, helpfulness, conciseness} averaged across traces |
| scores_with | TEXT | JSON: same structure, with knowledge injected |
| score_delta | REAL | Overall improvement score (positive = better) |
| judge_reasoning | TEXT | Full judge LLM output |
| engine_id | TEXT | Engine used for evaluation |
| eval_tokens | INTEGER | Tokens consumed by evaluation |
| eval_cost | REAL | Cost in USD |
| created_at | INTEGER | Unix ms |
| completed_at | INTEGER | Unix ms |

### New table: `experiments`

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| name | TEXT | Experiment name (e.g., "system_prompt_tone_v2") |
| surface | TEXT | "system_prompt", "injection_template", "reflection_prompt" |
| status | TEXT | "active", "completed", "cancelled" |
| variant_a | TEXT | JSON: {label, content} -- control |
| variant_b | TEXT | JSON: {label, content} -- challenger |
| conversations_a | INTEGER | Conversations assigned to A |
| conversations_b | INTEGER | Conversations assigned to B |
| feedback_a | TEXT | JSON: {good, bad} |
| feedback_b | TEXT | JSON: {good, bad} |
| min_conversations | INTEGER | Minimum per variant before deciding (default 20) |
| winner | TEXT | "a", "b", or null |
| created_at | INTEGER | Unix ms |
| completed_at | INTEGER | Unix ms |

### New table: `experiment_assignments`

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| experiment_id | INTEGER FK | References experiments(id) |
| conv_id | TEXT FK | Conversation assigned |
| variant | TEXT | "a" or "b" |
| created_at | INTEGER | Unix ms |

### New table: `self_coded_tools`

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| tool_name | TEXT UNIQUE | MCP tool name (snake_case) |
| description | TEXT | Tool description |
| input_schema | TEXT | JSON Schema for tool input |
| code | TEXT | Python source code |
| origin_reflection_id | INTEGER | Reflection that identified the pattern |
| origin_pattern | TEXT | Description of the repeated pattern |
| status | TEXT | "proposed", "approved", "installed", "disabled", "failed" |
| test_result | TEXT | Validation/test output |
| proposed_at | INTEGER | Unix ms |
| installed_at | INTEGER | Unix ms |
| created_at | INTEGER | Unix ms |

### Modified table: `traces`

Add column:

| parent_trace_id | INTEGER | NULL for main agent; references traces(id) for sub-agents |

### Modified table: `evolution_log`

New event types:

| event_type | Fires when | event_data |
|------------|-----------|------------|
| `sub_agent_spawned` | Sub-agent started | `{"parent_conv_id":"...", "agent_type":"researcher", "parent_trace_id":1}` |
| `sub_agent_completed` | Sub-agent finished | `{"run_id":1, "agent_type":"...", "duration_ms":3200, "tokens":1500}` |
| `evaluation_queued` | Knowledge queued for eval | `{"knowledge_id":1, "trace_ids":[2,5,8]}` |
| `evaluation_completed` | Evaluation finished | `{"evaluation_id":1, "knowledge_id":1, "status":"passed", "delta":0.8}` |
| `experiment_created` | New A/B experiment | `{"experiment_id":1, "surface":"system_prompt", "name":"..."}` |
| `experiment_decided` | Experiment winner chosen | `{"experiment_id":1, "winner":"b", "feedback_a":{...}, "feedback_b":{...}}` |
| `tool_proposed` | Self-coded tool proposed | `{"tool_name":"check_server", "origin":"reflection"}` |
| `tool_installed` | Self-coded tool installed | `{"tool_name":"check_server", "tool_id":1}` |
| `tool_disabled` | Self-coded tool disabled | `{"tool_name":"check_server", "reason":"user"}` |

## File Layout (new/modified)

```
lib/
  orchestrator.mjs      # NEW: sub-agent dispatch, parallel execution, result merging
  evaluator.mjs         # NEW: knowledge verification (background judge)
  ab-testing.mjs        # NEW: experiment management, variant selection, feedback tracking
  self-coder.mjs        # NEW: tool proposal, code generation, validation, installation
  db.mjs                # MODIFIED: add 5 new tables, add parent_trace_id to traces
  trace.mjs             # MODIFIED: sub-agent trace support (parent_trace_id)
  injector.mjs          # MODIFIED: apply A/B variant for injection template
  evolution.mjs         # MODIFIED: trigger evaluator after insight acceptance
  reflect.mjs           # MODIFIED: detect self-coding opportunities during reflection

server.mjs              # MODIFIED: orchestrator integration, new API routes
public/index.html       # MODIFIED: sub-agent UI, evaluation dashboard, experiment panel, self-coded tools panel
config.example.json     # MODIFIED: new config sections
```

## API Contracts

### Sub-Agents

Sub-agents are transparent to the chat API. The existing `POST /api/chat` endpoint handles orchestration internally. New SSE events expose sub-agent activity to the frontend:

```
event: sub_agent_start    data: { "run_id": 1, "type": "researcher", "task": "Search for..." }
event: sub_agent_delta    data: { "run_id": 1, "text": "..." }
event: sub_agent_done     data: { "run_id": 1, "result_summary": "Found 3 sources..." }
```

#### GET /api/sub-agents?conv_id=xxx
```json
Response: [{ "id": 1, "agent_type": "researcher", "status": "completed",
             "input_context": "...", "output_result": "...",
             "duration_ms": 3200, "created_at": "..." }]
```

#### GET /api/orchestrator/config
```json
Response: {
  "dispatch_mode": "auto",
  "agent_types": ["researcher", "analyst", "coder", "reviewer"],
  "custom_agents": [{ "name": "...", "system_prompt": "...", "tools": ["..."] }]
}
```

#### PUT /api/orchestrator/config
```json
Request: { "dispatch_mode": "auto|explicit|disabled" }
Response: { "ok": true }
```

### Evaluator

#### GET /api/evaluations?status=queued&limit=20
```json
Response: [{ "id": 1, "knowledge_id": 5, "status": "passed",
             "score_delta": 0.8, "scores_without": {}, "scores_with": {},
             "created_at": "..." }]
```

#### POST /api/evaluations/run
Manually trigger evaluation for a specific knowledge entry.
```json
Request: { "knowledge_id": 5 }
Response: { "evaluation_id": 1, "status": "queued" }
```

#### GET /api/evaluations/stats
```json
Response: {
  "total": 25, "passed": 18, "failed": 4, "pending": 3,
  "avg_delta": 0.6, "knowledge_verified_pct": 0.72
}
```

### A/B Testing

#### GET /api/experiments
```json
Response: [{ "id": 1, "name": "system_prompt_tone_v2", "surface": "system_prompt",
             "status": "active", "conversations_a": 15, "conversations_b": 12,
             "feedback_a": {"good": 8, "bad": 2}, "feedback_b": {"good": 10, "bad": 1} }]
```

#### POST /api/experiments
```json
Request: {
  "name": "injection_format_bullet_vs_prose",
  "surface": "injection_template",
  "variant_a": { "label": "prose", "content": "..." },
  "variant_b": { "label": "bullets", "content": "..." },
  "min_conversations": 20
}
Response: { "id": 1, "status": "active" }
```

#### POST /api/experiments/:id/decide
Force a winner manually (or system auto-decides when min_conversations reached).
```json
Request: { "winner": "b" }
Response: { "ok": true, "applied": true }
```

#### DELETE /api/experiments/:id
Cancel an active experiment.
```json
Response: { "ok": true }
```

### Self-Coding

#### GET /api/self-coded-tools
```json
Response: [{ "id": 1, "tool_name": "check_server_status",
             "description": "Check server uptime and response time",
             "status": "proposed", "origin_pattern": "User asks about server status daily",
             "proposed_at": "..." }]
```

#### GET /api/self-coded-tools/:id
```json
Response: { "id": 1, "tool_name": "...", "description": "...",
            "input_schema": {}, "code": "...",
            "status": "proposed", "test_result": null }
```

#### POST /api/self-coded-tools/:id/approve
Approve a proposed tool: validate, test, and install.
```json
Response: { "ok": true, "status": "installed", "test_result": "Syntax OK. Dry run passed." }
```

#### POST /api/self-coded-tools/:id/reject
```json
Response: { "ok": true, "status": "rejected" }
```

#### POST /api/self-coded-tools/:id/disable
Disable an installed tool (remove from registry, keep code).
```json
Response: { "ok": true, "status": "disabled" }
```

#### POST /api/self-coded-tools/:id/enable
Re-enable a disabled tool.
```json
Response: { "ok": true, "status": "installed" }
```

## Sub-Agent Orchestration Architecture

```
handleChat() in server.mjs
     |
     v
orchestrator.shouldDispatch(prompt, conv)
     |
     +-- NO --> normal single-agent flow (unchanged)
     |
     +-- YES --> orchestrator.dispatch(prompt, conv, engine)
                    |
                    v
               1. Ask main LLM to decompose task
                  (special orchestration prompt)
                    |
                    v
               2. Parse subtasks: [{type, task, tools_needed}]
                    |
                    v
               3. Spawn sub-agents in parallel
                  Each sub-agent:
                    - Gets tailored system prompt
                    - Gets subset of tools (via MCP filter)
                    - Runs via same engine adapter
                    - Streams results via sub_agent_* SSE events
                    - Records own trace with parent_trace_id
                    |
                    v
               4. Collect results
                    |
                    v
               5. Send results to main LLM for synthesis
                  "Here are the results from your sub-agents: ..."
                    |
                    v
               6. Stream final synthesized response
```

### Decision prompt for auto-dispatch:

```
Given this user request, decide if it would benefit from sub-agent decomposition.

Sub-agents are useful when:
- The task has 2+ independent subtasks that could run in parallel
- Different subtasks need different expertise (research vs analysis vs coding)
- The task would take >30 seconds as a single query

Respond with JSON:
{
  "use_sub_agents": true/false,
  "reason": "...",
  "subtasks": [
    {"type": "researcher", "task": "...", "context": "..."},
    {"type": "analyst", "task": "...", "context": "..."}
  ]
}

If use_sub_agents is false, respond with {"use_sub_agents": false, "reason": "..."} only.
```

## Evaluator Architecture

```
Knowledge accepted (reflect.mjs)
     |
     v
evaluator.queueEvaluation(knowledgeId)
     |
     v
Background loop (runs every 5 minutes during idle)
     |
     v
evaluator.runNextEvaluation()
     |
     +-- 1. Find relevant historical traces (keyword match on knowledge tags vs trace prompt)
     |      Select 3-5 traces with feedback (prefer traces with "down" feedback)
     |
     +-- 2. For each trace, generate two responses:
     |      a) WITHOUT the new knowledge (baseline)
     |      b) WITH the new knowledge (treatment)
     |      Use the same engine that was used for the original trace
     |
     +-- 3. Judge LLM evaluates both responses:
     |      Score each on: relevance, accuracy, helpfulness, conciseness (1-5)
     |      Provide reasoning
     |
     +-- 4. Compute delta = avg(treatment_scores) - avg(baseline_scores)
     |
     +-- 5. Store result:
            delta > 0 --> "passed" (knowledge verified)
            delta <= 0 --> "failed" (knowledge flagged for review)
```

### Judge prompt template:

```
You are evaluating whether a piece of learned knowledge improves an AI assistant's responses.

## User's Original Request
{trace.prompt_summary}

## Response A (without knowledge)
{response_without}

## Response B (with knowledge)
{response_with}

Score each response on these criteria (1-5):
1. Relevance: How well does the response address the user's request?
2. Accuracy: Is the information factually correct?
3. Helpfulness: How actionable and useful is the response?
4. Conciseness: Is the response appropriately concise?

Output JSON:
{
  "scores_a": {"relevance": X, "accuracy": X, "helpfulness": X, "conciseness": X},
  "scores_b": {"relevance": X, "accuracy": X, "helpfulness": X, "conciseness": X},
  "reasoning": "..."
}
```

## A/B Testing Architecture

```
New conversation created
     |
     v
ab-testing.assignVariant(convId)
     |
     +-- No active experiment --> return null (use defaults)
     |
     +-- Active experiment --> assign to A or B (alternating)
                |
                v
           injector.mjs / engine adapter uses variant content
                |
                v
           On feedback received:
           ab-testing.recordFeedback(convId, feedback)
                |
                v
           Check if experiment has enough data:
           if (conversations_a >= min && conversations_b >= min)
                |
                v
           Auto-decide winner (higher good/total ratio)
                |
                v
           Apply winner:
           - system_prompt --> write to data/system_prompt_override.md
           - injection_template --> write to data/injection_template_override.md
           - reflection_prompt --> write to data/reflection_prompt_override.md
```

## Self-Coding Architecture

```
Reflection detects repeated pattern
     |
     v
reflect.mjs identifies "automation_opportunity"
     (new insight category: "automation")
     |
     v
self-coder.proposeTool(pattern, traces)
     |
     +-- 1. Generate tool proposal via LLM:
     |      - tool_name (snake_case)
     |      - description
     |      - input_schema (JSON Schema)
     |      - implementation plan
     |
     +-- 2. Save to self_coded_tools table (status: "proposed")
     |
     +-- 3. Notify user (UI badge + optional Bark notification)
     |
     +-- (await user approval)

User approves (POST /api/self-coded-tools/:id/approve)
     |
     v
self-coder.installTool(toolId)
     |
     +-- 1. Generate Python code via LLM:
     |      - Follow exact pattern from existing tools
     |      - Include Tool schema, handler function, imports
     |
     +-- 2. Validate:
     |      a) Python syntax check: python -c "import ast; ast.parse(open(f).read())"
     |      b) Schema validation: ensure Tool and handler match
     |      c) Dry run: import the module, call handler with test input
     |
     +-- 3. Write to mcp/tools/{name}.py
     |
     +-- 4. Update mcp/tools/__init__.py (add import + registration)
     |
     +-- 5. Hot-reload MCP server:
     |      mcpManager.stop() --> mcpManager.start()
     |
     +-- 6. Update status to "installed", log event
```

### Self-coding prompt template:

```
Generate a Python MCP tool following this exact pattern:

## Existing tool example (web_search.py):
{web_search.py contents}

## Tool to generate:
Name: {tool_name}
Description: {description}
Input Schema: {input_schema}
Implementation plan: {plan}

Requirements:
1. Import from mcp.types: Tool, TextContent
2. Define a Tool schema as {TOOL_NAME}_TOOL
3. Define async handler: handle_{tool_name}(arguments: dict, **kwargs) -> list[TextContent]
4. Handler receives `channels` kwarg for messaging
5. Return list of TextContent
6. Handle errors gracefully with try/except
7. No external dependencies beyond what's in requirements.txt
```

## Config Changes

```json
{
  "evolution": {
    "...existing...": "...",

    "sub_agents": {
      "dispatch_mode": "auto",
      "max_parallel": 3,
      "max_tokens_per_agent": 4000,
      "custom_agents": []
    },

    "evaluator": {
      "enabled": true,
      "eval_engine": null,
      "traces_per_eval": 3,
      "auto_flag_threshold": 0.0,
      "check_interval_ms": 300000
    },

    "ab_testing": {
      "enabled": true,
      "min_conversations_per_variant": 20
    },

    "self_coding": {
      "enabled": false,
      "auto_propose": true,
      "require_approval": true
    }
  }
}
```

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Sub-agents increase cost significantly | Configurable max_parallel and max_tokens_per_agent; auto-dispatch can be disabled |
| Evaluator consumes LLM calls for every knowledge entry | Rate-limit: max 5 evaluations per day; run during idle only |
| A/B testing too slow at single-user scale | Low min_conversations default (20); manual override available |
| Self-coded tools have bugs or security issues | Syntax validation + dry-run + user approval required; sandboxed to mcp/tools/ |
| Sub-agent results inconsistent across engine types | Standardized orchestration prompt; engine-specific optimizations as optional |
| Evaluator judges poorly | Structured rubric reduces bias; user can override evaluation results |
| MCP hot-reload disrupts active conversations | Only reload during idle; queue reload if conversation is active |

## Dependencies Between Features

```
                    +---------------------+
                    |  DB Schema (shared)  |
                    +----------+----------+
                               |
              +----------------+----------+----------------+
              v                v          v                v
        Sub-Agents       Evaluator    A/B Testing    Self-Coding
              |                |          |                |
              |                |          |                |
              |          +-----+          |           (needs MCP
              |          v                |            manager)
              |    (needs knowledge.mjs   |                |
              |     and trace.mjs)        |                |
              |                           |                |
              +---------------------------+----------------+
                                          |
                                     (A/B testing needs
                                      injector.mjs and
                                      feedback from traces)
```

- **Sub-agents** are independent; can be built first
- **Evaluator** depends on existing knowledge + trace infrastructure (already built in P2)
- **A/B testing** depends on existing feedback pipeline (already built in P2)
- **Self-coding** depends on MCP manager + knowledge of tool patterns; most complex feature
- All four share the DB schema changes, which must come first
