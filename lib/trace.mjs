// lib/trace.mjs — Trace capture and query for self-evolution
import { getDb } from "./db.mjs";

/**
 * Record a trace after a chat turn completes.
 */
export function addTrace({
  conv_id,
  msg_id,
  engine_id,
  prompt_summary,
  tools_used = [],
  input_tokens = null,
  output_tokens = null,
  estimated_cost = null,
  response_len = 0,
  duration_ms = 0,
  injected_knowledge = null,
  parent_trace_id = null,
}) {
  const now = Date.now();
  const result = getDb()
    .prepare(
      `INSERT INTO traces
        (conv_id, msg_id, engine_id, prompt_summary, tools_used,
         input_tokens, output_tokens, estimated_cost,
         response_len, duration_ms, injected_knowledge, parent_trace_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      conv_id,
      msg_id ?? null,
      engine_id,
      prompt_summary ?? null,
      tools_used.length ? JSON.stringify(tools_used) : null,
      input_tokens,
      output_tokens,
      estimated_cost,
      response_len,
      duration_ms,
      injected_knowledge ? JSON.stringify(injected_knowledge) : null,
      parent_trace_id,
      now
    );

  logEvolution("trace_created", {
    trace_id: result.lastInsertRowid,
    conv_id,
    engine_id,
  });

  return { id: result.lastInsertRowid, created_at: now };
}

/**
 * Update feedback on a trace by message ID.
 */
export function updateTraceFeedback(msgId, feedback, note = null) {
  const trace = getDb()
    .prepare("SELECT id, conv_id, engine_id FROM traces WHERE msg_id = ?")
    .get(msgId);
  if (!trace) return null;

  getDb()
    .prepare("UPDATE traces SET feedback = ?, feedback_note = ? WHERE msg_id = ?")
    .run(feedback, note, msgId);

  logEvolution("feedback_received", {
    msg_id: msgId,
    trace_id: trace.id,
    feedback,
    conv_id: trace.conv_id,
    engine_id: trace.engine_id,
  });

  return { id: trace.id, feedback };
}

/**
 * Query traces with filters.
 */
export function getTraces({ since, until, limit = 50, hasFeedback, engine_id } = {}) {
  const conditions = [];
  const params = [];

  if (since != null) {
    conditions.push("created_at >= ?");
    params.push(since);
  }
  if (until != null) {
    conditions.push("created_at <= ?");
    params.push(until);
  }
  if (hasFeedback === true) {
    conditions.push("feedback IS NOT NULL");
  } else if (hasFeedback === false) {
    conditions.push("feedback IS NULL");
  }
  if (engine_id) {
    conditions.push("engine_id = ?");
    params.push(engine_id);
  }

  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  params.push(limit);

  return getDb()
    .prepare(
      `SELECT id, conv_id, msg_id, engine_id, prompt_summary, tools_used,
              input_tokens, output_tokens, estimated_cost,
              response_len, duration_ms, feedback, feedback_note,
              injected_knowledge, created_at
       FROM traces ${where}
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(...params);
}

/**
 * Aggregate trace statistics.
 */
export function getTraceStats(since = null) {
  const where = since != null ? "WHERE created_at >= ?" : "";
  const params = since != null ? [since] : [];

  const row = getDb()
    .prepare(
      `SELECT
        COUNT(*)                                        AS total,
        SUM(CASE WHEN feedback = 'up'   THEN 1 ELSE 0 END) AS good,
        SUM(CASE WHEN feedback = 'down' THEN 1 ELSE 0 END) AS bad,
        SUM(CASE WHEN feedback IS NULL  THEN 1 ELSE 0 END) AS no_feedback,
        SUM(COALESCE(input_tokens, 0))                 AS total_input_tokens,
        SUM(COALESCE(output_tokens, 0))                AS total_output_tokens,
        SUM(COALESCE(estimated_cost, 0))               AS total_cost,
        AVG(duration_ms)                               AS avg_duration_ms
       FROM traces ${where}`
    )
    .get(...params);

  // Tool frequency
  const traces = getDb()
    .prepare(`SELECT tools_used FROM traces ${where} AND tools_used IS NOT NULL`.replace("AND", where ? "AND" : "WHERE"))
    .all(...params);

  const toolFreq = {};
  for (const t of traces) {
    try {
      const tools = JSON.parse(t.tools_used);
      for (const tool of tools) {
        toolFreq[tool.name] = (toolFreq[tool.name] || 0) + 1;
      }
    } catch {}
  }

  return {
    total: row.total,
    feedback: {
      good: row.good,
      bad: row.bad,
      none: row.no_feedback,
      ratio: row.total > 0 ? row.good / Math.max(row.good + row.bad, 1) : null,
    },
    tokens: {
      input: row.total_input_tokens,
      output: row.total_output_tokens,
      total: row.total_input_tokens + row.total_output_tokens,
    },
    cost: row.total_cost,
    avg_duration_ms: row.avg_duration_ms,
    tool_frequency: toolFreq,
  };
}

/**
 * Get traces since the last reflection (for reflection input).
 */
export function getTracesSinceLastReflection(limit = 100) {
  const state = getDb()
    .prepare("SELECT last_reflection_at FROM evolution_state WHERE id = 1")
    .get();

  const since = state?.last_reflection_at || 0;
  return getTraces({ since, limit });
}

// ── Evolution log helper ──

export function logEvolution(eventType, eventData) {
  getDb()
    .prepare("INSERT INTO evolution_log (event_type, event_data, created_at) VALUES (?, ?, ?)")
    .run(eventType, JSON.stringify(eventData), Date.now());
}
