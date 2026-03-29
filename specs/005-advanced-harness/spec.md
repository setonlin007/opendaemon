# Spec 004: Advanced Harness

## Problem

OpenDaemon can learn from interactions (Phase 2), but it remains a single-threaded, single-strategy assistant. It has no way to:

1. **Decompose complex tasks** -- Every user request goes to a single LLM call (or a single tool-use loop). There is no way to farm out specialized subtasks to focused agents with different system prompts, models, or tool sets.
2. **Verify its own improvements** -- The reflection loop produces insights, but there is no automatic verification that accepted insights actually improve response quality. Bad knowledge can silently degrade performance.
3. **Optimize its own prompts** -- System prompts, injection templates, and reflection prompts are hardcoded. There is no mechanism to test variations and converge on what works best for this specific user.
4. **Extend its own capabilities** -- When the daemon identifies a repeated task that could be automated (e.g., "check my server status"), it cannot write a new MCP tool to handle it. The user must manually create tools.

These four gaps represent the difference between a harness that passively applies knowledge and one that actively improves its own architecture. Phase 3 (Advanced Harness) closes this gap.

## Goals

1. **Sub-agents** -- Allow the main conversation to spawn focused sub-agents for specialized subtasks (research, code analysis, data processing), with results flowing back into the parent conversation.
2. **Evaluator** -- Automatically verify that accepted knowledge entries actually improve response quality, by running controlled before/after comparisons on historical traces.
3. **Prompt optimization** -- A/B test prompt variations (system prompt phrasing, injection format, reflection template) and converge on what works best based on feedback signals.
4. **Self-coding** -- The daemon proposes, generates, tests, and installs new MCP tools for itself when it identifies repeated patterns that could be automated.

## Non-Goals (this phase)

- Multi-user support (remains single-user)
- External agent marketplace / tool registry
- Vector similarity search for knowledge (keep tag-based matching)
- Real-time collaboration between sub-agents (sub-agents are independent, results merge back)
- Autonomous deployment of self-coded tools without user approval

## User Stories

### US-1: Sub-Agents for Specialized Subtasks

As a user, I want the daemon to break complex requests into subtasks and dispatch them to specialized sub-agents, so I get better results on multi-step problems.

- User sends a complex prompt (e.g., "Research X, then write a report comparing Y and Z")
- The main agent decides to spawn sub-agents: one for research, one for comparison analysis
- Sub-agents run with tailored system prompts and tool access (e.g., research sub-agent gets web_search; analysis sub-agent gets only the research results)
- Sub-agent results stream back to the user as they complete
- The main agent synthesizes sub-agent outputs into a final response
- Sub-agents are visible in the UI: user can see which sub-agents are running and their individual outputs
- Sub-agent traces are recorded and linked to the parent conversation

**Sub-agent types (built-in):**

| Type | Purpose | Tools | System Prompt Focus |
|------|---------|-------|-------------------|
| `researcher` | Web search + information gathering | web_search | Find authoritative sources, summarize findings |
| `analyst` | Data analysis + comparison | none (context-only) | Structured analysis, tables, pros/cons |
| `coder` | Code generation + review | file system (Claude SDK only) | Clean code, follow conventions, test coverage |
| `reviewer` | Quality check + fact verification | web_search | Verify claims, check consistency, find errors |
| `custom` | User-defined | configurable | User-defined system prompt |

**Dispatch modes:**
- **auto** -- The main LLM decides when sub-agents would help (default)
- **explicit** -- User requests sub-agent dispatch via `/research`, `/analyze`, `/review` commands
- **disabled** -- No sub-agents, all requests handled by main agent

### US-2: Evaluator for Insight Verification

As the daemon operator, I want automatic verification that accepted knowledge actually improves responses, so the knowledge base stays high quality.

- After a knowledge entry is accepted (either auto or manual), the evaluator queues a verification job
- Verification: take 3-5 historical traces where the knowledge would have been relevant, run the LLM twice -- once without the new knowledge, once with -- and compare quality using a judge LLM
- Evaluation results stored in DB with before/after scores
- Knowledge entries that fail evaluation are flagged for review (not auto-deleted)
- Evaluation runs asynchronously during idle periods (not blocking chat)
- Dashboard shows evaluation results: which knowledge entries are verified, which are flagged
- Configurable: users can disable evaluation or adjust strictness

**Evaluation criteria (scored 1-5 by judge LLM):**
- Relevance: Does the knowledge improve answer relevance?
- Accuracy: Does the injected knowledge lead to factually correct responses?
- Helpfulness: Is the response more actionable with the knowledge?
- Conciseness: Does the knowledge avoid unnecessary verbosity?

### US-3: Prompt Optimization / A/B Testing

As the daemon operator, I want the system to test variations of its prompts and converge on what works best for me.

- Prompt variants defined for: system prompt phrasing, injection template format, reflection prompt structure
- A/B testing framework: randomly assign variant per conversation, track feedback
- After N conversations per variant (configurable, default 20), compare feedback ratios
- Winning variant auto-promoted; losing variant retired
- All variants and results visible in the UI
- Manual override: user can force a specific variant
- Experiments are sequential (only one active experiment at a time to avoid confounding)

**Optimizable prompt surfaces:**
1. **System prompt tone** -- e.g., "You are a helpful assistant" vs "You are a concise technical advisor"
2. **Injection template** -- how learned knowledge is formatted in the context (bullet points vs prose vs structured blocks)
3. **Reflection prompt** -- how traces are presented to the LLM for insight extraction

### US-4: Self-Coding -- Daemon Writes New MCP Tools

As a user, I want the daemon to propose and create new MCP tools for itself when it notices repeated tasks that could be automated.

- The daemon identifies repeated patterns during reflection (e.g., "user asks me to check server status every morning")
- It proposes a new MCP tool: name, description, input schema, implementation plan
- User reviews and approves the proposal
- The daemon generates the Python tool code following the existing MCP tool conventions
- Code is syntax-validated and tested with a dry-run
- On approval, the tool is installed to `mcp/tools/`, registered in `__init__.py`, and the MCP server is hot-reloaded
- New tool appears in the next conversation's tool list
- All self-coded tools are tracked in the DB with their origin, code, and status

**Safety constraints:**
- Self-coded tools MUST follow the existing tool pattern (Tool schema + handler function)
- Self-coded tools MUST be syntax-validated before installation
- Self-coded tools CANNOT modify existing tools or core files
- Self-coded tools are sandboxed to the `mcp/tools/` directory
- User MUST approve before installation (no auto-install)
- Self-coded tools are tagged in the DB as `source: self_coded` for audit
- Rollback: any self-coded tool can be disabled/deleted via UI

## Key Design Decisions

1. **Sub-agents via lightweight orchestration, not Claude SDK native agents** -- Claude SDK has native sub-agent support, but it only works with Claude. For engine-agnostic sub-agents, we implement a lightweight orchestration layer in server.mjs that works with both engine types. Claude SDK native agents can be used as an optimization when the engine is `claude-sdk`.

2. **Evaluator uses the same LLM as reflection** -- No separate evaluation model needed. The judge prompt is separate from the generation prompt, avoiding self-evaluation bias by using a structured rubric.

3. **A/B testing is sequential, not parallel** -- Only one experiment runs at a time. This avoids confounding variables and keeps the system simple. At single-user scale, parallel experiments would take too long to reach significance anyway.

4. **Self-coding targets Python MCP tools only** -- The existing MCP tool pattern (Python + mcp SDK) is well-structured and safe to generate into. We do NOT allow self-coding of JavaScript server modules, engine adapters, or frontend code.

5. **No auto-install for self-coded tools** -- CONSTITUTION mandates user control. Every self-coded tool requires explicit approval. The daemon proposes; the user decides.

6. **Sub-agent traces linked to parent** -- Sub-agent interactions generate their own traces with a `parent_trace_id` link, enabling full audit of what sub-agents did and how their outputs contributed to the final response.

7. **Evaluator is eventually-consistent** -- Evaluation runs asynchronously. Knowledge is usable immediately after acceptance; evaluation happens in the background. If evaluation fails, knowledge is flagged but not removed (user decides).
