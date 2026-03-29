// lib/evolution.mjs — Evolution trigger manager (reflection scheduling)
import { getDb } from "./db.mjs";
import { logEvolution } from "./trace.mjs";

/**
 * Evolution manager — manages reflection trigger strategies.
 *
 * Strategies:
 * - manual:       No automatic triggers
 * - conservative: Weekly cron (Sunday 02:00)
 * - balanced:     Daily cron + bad feedback threshold (default 3)
 * - aggressive:   Per-conversation threshold (default 5) + daily cron
 * - custom:       User-defined schedule + thresholds
 */

let _config = null;
let _reflectionCallback = null; // async (triggerReason) => void

/**
 * Initialize evolution manager.
 * @param {object} config - evolution config section from config.json
 * @param {function} reflectionCallback - async (triggerReason) => void
 */
export function initEvolution(config = {}, reflectionCallback = null) {
  _config = {
    reflection_strategy: config.reflection_strategy || "manual",
    reflection_engine: config.reflection_engine || null,
    reflection_schedule: config.reflection_schedule || null,
    reflection_bad_feedback_threshold: config.reflection_bad_feedback_threshold ?? 3,
    reflection_conversation_threshold: config.reflection_conversation_threshold ?? 5,
    inject_max_tokens: config.inject_max_tokens ?? 2000,
    trace_enabled: config.trace_enabled !== false,
  };
  _reflectionCallback = reflectionCallback;

  console.log(`[evolution] strategy=${_config.reflection_strategy}`);
}

/**
 * Get current evolution config.
 */
export function getEvolutionConfig() {
  return _config || {};
}

/**
 * Called after each chat completes.
 * Increments conversation counter and checks threshold for aggressive strategy.
 */
export function onChatComplete(convId) {
  if (!_config || !_config.trace_enabled) return;

  const strategy = _config.reflection_strategy;
  if (strategy === "manual" || strategy === "conservative") return;

  // Increment conversation counter
  getDb()
    .prepare("UPDATE evolution_state SET conv_since_last = conv_since_last + 1, updated_at = ? WHERE id = 1")
    .run(Date.now());

  if (strategy === "aggressive" || strategy === "custom") {
    const state = getEvolutionState();
    if (state.conv_since_last >= _config.reflection_conversation_threshold) {
      triggerIfCallback("conv_threshold");
    }
  }
}

/**
 * Called when feedback is received.
 * Increments bad feedback counter for balanced/aggressive strategies.
 */
export function onFeedback(msgId, feedback) {
  if (!_config || !_config.trace_enabled) return;
  if (feedback !== "down") return;

  const strategy = _config.reflection_strategy;
  if (strategy === "manual" || strategy === "conservative") return;

  // Increment bad feedback counter
  getDb()
    .prepare("UPDATE evolution_state SET bad_feedback_since_last = bad_feedback_since_last + 1, updated_at = ? WHERE id = 1")
    .run(Date.now());

  const state = getEvolutionState();
  if (state.bad_feedback_since_last >= _config.reflection_bad_feedback_threshold) {
    triggerIfCallback("bad_feedback");
  }
}

/**
 * Get current evolution state (counters, last reflection, etc.).
 */
export function getEvolutionState() {
  const state = getDb()
    .prepare("SELECT * FROM evolution_state WHERE id = 1")
    .get();

  const pendingCount = getDb()
    .prepare("SELECT COUNT(*) as count FROM pending_insights WHERE status = 'pending'")
    .get().count;

  return {
    strategy: _config?.reflection_strategy || "manual",
    last_reflection_at: state?.last_reflection_at || null,
    bad_feedback_since_last: state?.bad_feedback_since_last || 0,
    conv_since_last: state?.conv_since_last || 0,
    pending_insights_count: pendingCount,
  };
}

/**
 * Get evolution log entries.
 */
export function getEvolutionLog({ type, since, limit = 50 } = {}) {
  const conditions = [];
  const params = [];

  if (type) {
    conditions.push("event_type = ?");
    params.push(type);
  }
  if (since != null) {
    conditions.push("created_at >= ?");
    params.push(since);
  }

  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  params.push(limit);

  return getDb()
    .prepare(`SELECT id, event_type, event_data, created_at FROM evolution_log ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params);
}

/**
 * Get aggregated evolution stats.
 */
export function getEvolutionStats(since = null) {
  const traceWhere = since ? "WHERE created_at >= ?" : "";
  const traceParams = since ? [since] : [];

  // Chat token/cost stats from traces
  const chatStats = getDb()
    .prepare(
      `SELECT
        SUM(COALESCE(input_tokens, 0)) as chat_input_tokens,
        SUM(COALESCE(output_tokens, 0)) as chat_output_tokens,
        SUM(COALESCE(estimated_cost, 0)) as chat_cost,
        SUM(CASE WHEN feedback = 'up' THEN 1 ELSE 0 END) as good,
        SUM(CASE WHEN feedback = 'down' THEN 1 ELSE 0 END) as bad,
        SUM(CASE WHEN feedback IS NULL THEN 1 ELSE 0 END) as no_feedback,
        SUM(CASE WHEN injected_knowledge IS NOT NULL THEN 1 ELSE 0 END) as with_injection,
        SUM(CASE WHEN injected_knowledge IS NULL THEN 1 ELSE 0 END) as without_injection
       FROM traces ${traceWhere}`
    )
    .get(...traceParams);

  // Reflection stats
  const refWhere = since ? "WHERE created_at >= ?" : "";
  const refParams = since ? [since] : [];
  const refStats = getDb()
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(COALESCE(reflection_tokens, 0)) as reflection_tokens,
        SUM(COALESCE(reflection_cost, 0)) as reflection_cost,
        SUM(COALESCE(insights_accepted, 0)) as insights_accepted,
        SUM(COALESCE(insights_auto_accepted, 0)) as insights_auto_accepted
       FROM reflections ${refWhere}`
    )
    .get(...refParams);

  // Knowledge count
  const knowledgeStats = getDb()
    .prepare("SELECT category, COUNT(*) as count FROM knowledge_index GROUP BY category")
    .all();
  const knowledgeByCategory = {};
  let knowledgeTotal = 0;
  for (const row of knowledgeStats) {
    knowledgeByCategory[row.category] = row.count;
    knowledgeTotal += row.count;
  }

  // Injection effectiveness
  const injectionFeedback = getDb()
    .prepare(
      `SELECT
        CASE WHEN injected_knowledge IS NOT NULL THEN 'with' ELSE 'without' END as mode,
        SUM(CASE WHEN feedback = 'up' THEN 1 ELSE 0 END) as good,
        SUM(CASE WHEN feedback = 'down' THEN 1 ELSE 0 END) as bad
       FROM traces ${traceWhere}
       GROUP BY mode`
    )
    .all(...traceParams);

  const injFeedback = { with: { good: 0, bad: 0 }, without: { good: 0, bad: 0 } };
  for (const row of injectionFeedback) {
    injFeedback[row.mode] = { good: row.good, bad: row.bad };
  }

  return {
    tokens: {
      chat_input: chatStats?.chat_input_tokens || 0,
      chat_output: chatStats?.chat_output_tokens || 0,
      reflection: refStats?.reflection_tokens || 0,
    },
    cost: {
      chat: chatStats?.chat_cost || 0,
      reflection: refStats?.reflection_cost || 0,
      total: (chatStats?.chat_cost || 0) + (refStats?.reflection_cost || 0),
    },
    feedback: {
      good: chatStats?.good || 0,
      bad: chatStats?.bad || 0,
      none: chatStats?.no_feedback || 0,
      ratio: (chatStats?.good || 0) / Math.max((chatStats?.good || 0) + (chatStats?.bad || 0), 1),
    },
    reflections: {
      total: refStats?.total || 0,
      insights_accepted: refStats?.insights_accepted || 0,
      insights_auto_accepted: refStats?.insights_auto_accepted || 0,
    },
    knowledge: {
      total: knowledgeTotal,
      by_category: knowledgeByCategory,
    },
    injection: {
      conversations_with: chatStats?.with_injection || 0,
      conversations_without: chatStats?.without_injection || 0,
      feedback_with: injFeedback.with,
      feedback_without: injFeedback.without,
    },
  };
}

// ── Internal ──

function triggerIfCallback(reason) {
  if (!_reflectionCallback) return;

  logEvolution("reflection_triggered", {
    trigger: reason,
    strategy: _config.reflection_strategy,
  });

  // Fire async — don't block the caller
  _reflectionCallback(reason).catch(err => {
    console.error(`[evolution] auto-reflection failed (${reason}):`, err.message);
  });
}
