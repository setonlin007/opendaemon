# Spec 003: Self-Evolution

## Problem

OpenDaemon can chat and use tools, but it does not learn. After 100 conversations, it is no better at being the user's specific assistant than it was after 1. Every conversation starts from zero context about the user's preferences, communication style, domain knowledge, and past decisions.

The self-evolution loop (trace, reflect, learn, inject) is the core product differentiator defined in CONSTITUTION.md. Without it, OpenDaemon is just another chat wrapper.

## Goals

1. **Trace** -- Automatically capture structured interaction data: what the user asked, what tools were used, what the outcome was, and (optionally) explicit user feedback (thumbs up/down)
2. **Reflect** -- On-demand analysis of traces using the LLM itself to identify patterns, preferences, and improvement opportunities
3. **Learn** -- Persist extracted knowledge as human-readable Markdown files organized by category, with a SQLite index for efficient lookup
4. **Inject** -- Automatically inject relevant learned knowledge into future conversations as system/context messages
5. **Goals** -- User-defined `data/goals.md` that guides the direction of reflection and learning

## Non-Goals (this phase)

- The daemon writing new code or MCP tools for itself (Phase 3: self_update)
- Sub-agent orchestration for reflection (Phase 3)
- Prompt optimization / A/B testing (Phase 3)
- Vector similarity search (keep it simple -- keyword/tag matching)
- Automatic reflection on a cron schedule (can be added later with existing cron_task)

## User Stories

### US-1: Interaction Tracing

As the daemon operator, I want every interaction automatically recorded as a structured trace, so that there is raw material for the reflection loop.

- Each completed chat turn produces a trace record in DB: conversation_id, user prompt summary, tools used (names + success/failure), response length, duration_ms, engine_id, timestamp
- Tool calls are tracked: which tool, what arguments (summarized), result status
- Tracing is automatic and invisible -- no user action required

### US-2: User Feedback

As a user, I want to give thumbs up/down on assistant responses, so the system knows what worked and what didn't.

- Thumbs up/down buttons on each assistant message
- Feedback stored in DB linked to the message
- Optional text note with feedback

### US-3: Reflection

As the daemon operator, I want to trigger reflection that analyzes recent traces and extracts actionable insights.

- "Reflect" action in the UI triggers reflection
- Reads recent traces (last N days or since last reflection)
- Uses the LLM to analyze and produce structured insights
- Insights presented for user review before saving
- Reflection guided by `data/goals.md` if it exists

#### Reflection Trigger Strategies

Reflection requires an LLM call, so frequency directly impacts cost. Users choose a strategy in config:

| Strategy | Trigger | LLM Calls/Month | Cost Level | Suitable For |
|----------|---------|-----------------|------------|-------------|
| **manual** | Only when user clicks "Reflect" or calls MCP tool | 0 (user-controlled) | Free | Cost-conscious users; getting started |
| **conservative** | Weekly (default: Sunday 02:00) | ~4 | Low | Light users (<50 conversations/week) |
| **balanced** | Daily (default: 02:00) + after 3 cumulative "bad" feedbacks | ~35 | Medium | Regular users; recommended default |
| **aggressive** | After every N conversations (default N=5) + daily | ~60+ | High | Power users who want fastest learning |
| **custom** | User-defined cron expression + threshold rules | Varies | Varies | Advanced users |

Config structure (`config.json`):
```json
{
  "evolution": {
    "reflection_strategy": "balanced",
    "reflection_engine": "claude-opus",
    "reflection_schedule": "daily 02:00",
    "reflection_bad_feedback_threshold": 3,
    "reflection_conversation_threshold": 5,
    "inject_max_tokens": 2000,
    "trace_enabled": true
  }
}
```

Strategy behavior:
- **manual**: No automatic triggers. User uses UI button or `reflect` MCP tool.
- **conservative**: Creates a weekly cron. Analyzes all traces since last reflection.
- **balanced**: Daily cron + event-driven: when cumulative bad feedbacks since last reflection reach threshold, auto-trigger. Resets counter after reflection.
- **aggressive**: Checks after each conversation completes; triggers when N new conversations since last reflection. Also runs daily cron as safety net.
- **custom**: User sets `reflection_schedule` (cron expression) and optionally `reflection_bad_feedback_threshold` and `reflection_conversation_threshold`.

All strategies except **manual** auto-accept insights with confidence >= 0.9 and present the rest for user review next time they open the UI. This avoids blocking on user approval for high-confidence patterns.

### US-4: Knowledge Base

As a user, I want to view, edit, and delete learned knowledge, with full control over what the daemon "remembers."

- Knowledge stored as Markdown files in `data/knowledge/` (one file per category)
- SQLite index table for efficient retrieval
- Browse, edit, delete knowledge in the UI
- Files are human-readable and hand-editable

### US-5: Context Injection

As a user, I want the daemon to automatically use learned knowledge in future conversations.

- Before each chat turn, relevant knowledge entries are retrieved
- Injected as system/context in the prompt for both engine types
- Lightweight: configurable token budget cap (default 2000 tokens)
- User can toggle injection on/off per conversation

### US-6: Goals

As a user, I want to define growth goals so reflection focuses on what matters to me.

- `data/goals.md` is user-editable
- Goals read during reflection to guide analysis
- UI section to view and edit goals

## Key Design Decisions

1. **Markdown + SQLite index** -- CONSTITUTION mandates human-readable, file-based memory. Markdown is source of truth; SQLite index is for retrieval.
2. **No vector search** -- Tag-based matching sufficient for single-user scale. Debuggable, no extra deps.
3. **Tiered reflection strategies** -- Five trigger strategies (manual/conservative/balanced/aggressive/custom) let users trade off learning speed vs LLM cost. Default: balanced (daily + bad-feedback-driven).
4. **System prompt injection** -- Knowledge base is small enough to fit in system prompt. Works identically across both engine types.
5. **Same engine for reflection** -- Reuses existing engine infrastructure. No new config needed.
