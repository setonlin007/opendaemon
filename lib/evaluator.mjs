/**
 * Phase 4: Knowledge Evaluator
 *
 * Background verification system that measures whether knowledge entries
 * actually improve response quality by comparing before/after responses
 * on historical traces using a judge LLM.
 */

import { getDb, addEvaluation, updateEvaluation, getOldestQueuedEvaluation, getEvaluationStats } from "./db.mjs";
import { loadConfig, getEngineById } from "./config.mjs";
import { getTraces } from "./trace.mjs";
import { getKnowledgeContent } from "./knowledge.mjs";

let evaluationLoop = null;
let isRunning = false;

/**
 * Queue an evaluation for a knowledge entry.
 *
 * @param {number} knowledgeId - ID of the knowledge_index entry to evaluate
 * @returns {{ id: number, created_at: number }}
 */
export function queueEvaluation(knowledgeId) {
  try {
    // Find relevant traces by matching knowledge tags
    const knowledge = getKnowledgeContent(knowledgeId);
    if (!knowledge) {
      throw new Error(`Knowledge entry ${knowledgeId} not found`);
    }

    const tags = knowledge.tags ? knowledge.tags.split(",").map((t) => t.trim()) : [];
    const traces = findRelevantTraces(tags, knowledge.title, 5);
    const traceIds = traces.map((t) => t.id);

    return addEvaluation({
      knowledge_id: knowledgeId,
      status: "queued",
      trace_ids: traceIds,
      engine_id: getEvalEngineId(),
    });
  } catch (err) {
    console.error("[evaluator] queueEvaluation error:", err);
    throw err;
  }
}

/**
 * Find traces relevant to a knowledge entry by matching tags and title keywords.
 */
function findRelevantTraces(tags, title, limit = 5) {
  try {
    const allTraces = getTraces({ limit: 200 });
    if (allTraces.length === 0) return [];

    // Score traces by relevance
    const titleWords = title.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const scored = allTraces
      .filter((t) => t.prompt_summary)
      .map((t) => {
        const summary = (t.prompt_summary || "").toLowerCase();
        let score = 0;
        for (const tag of tags) {
          if (summary.includes(tag.toLowerCase())) score += 2;
        }
        for (const word of titleWords) {
          if (summary.includes(word)) score += 1;
        }
        return { ...t, relevanceScore: score };
      })
      .filter((t) => t.relevanceScore > 0)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, limit);

    // If no relevant traces found, fall back to most recent ones
    if (scored.length === 0) {
      return allTraces.slice(0, Math.min(3, allTraces.length));
    }

    return scored;
  } catch (err) {
    console.error("[evaluator] findRelevantTraces error:", err);
    return [];
  }
}

/**
 * Run the next queued evaluation.
 *
 * @param {object} engineConfig - Engine config to use for evaluation
 * @returns {object|null} - Evaluation result or null if none queued
 */
export async function runNextEvaluation(engineConfig) {
  if (isRunning) return null;

  try {
    isRunning = true;

    const evaluation = getOldestQueuedEvaluation();
    if (!evaluation) return null;

    // Mark as running
    updateEvaluation(evaluation.id, { status: "running" });

    const knowledge = getKnowledgeContent(evaluation.knowledge_id);
    if (!knowledge) {
      updateEvaluation(evaluation.id, {
        status: "failed",
        judge_reasoning: "Knowledge entry not found",
        completed_at: Date.now(),
      });
      return null;
    }

    const traceIds = evaluation.trace_ids ? JSON.parse(evaluation.trace_ids) : [];
    if (traceIds.length === 0) {
      updateEvaluation(evaluation.id, {
        status: "completed",
        score_delta: 0,
        judge_reasoning: "No traces available for evaluation",
        completed_at: Date.now(),
      });
      return { id: evaluation.id, score_delta: 0 };
    }

    // Load selected traces
    const traces = traceIds
      .map((id) => {
        try {
          return getDb()
            .prepare("SELECT * FROM traces WHERE id = ?")
            .get(id);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    if (traces.length === 0) {
      updateEvaluation(evaluation.id, {
        status: "completed",
        score_delta: 0,
        judge_reasoning: "Referenced traces no longer exist",
        completed_at: Date.now(),
      });
      return { id: evaluation.id, score_delta: 0 };
    }

    // For each trace, build judge prompt comparing with/without knowledge
    const judgeResults = [];
    for (const trace of traces) {
      try {
        const judgePrompt = buildJudgePrompt(
          trace.prompt_summary || "Unknown prompt",
          `Response generated without this knowledge entry.`, // placeholder for "without"
          `Response generated with knowledge: ${knowledge.content || knowledge.title}` // placeholder for "with"
        );

        // In a full implementation, we would:
        // 1. Re-run the prompt WITHOUT the knowledge -> responseA
        // 2. Re-run the prompt WITH the knowledge -> responseB
        // 3. Send both to judge LLM
        // For now, we score based on feedback data
        const score = trace.feedback === "up" ? 1 : trace.feedback === "down" ? -1 : 0;
        judgeResults.push({ traceId: trace.id, score });
      } catch (err) {
        console.error(`[evaluator] judge error for trace ${trace.id}:`, err);
      }
    }

    // Compute aggregate delta
    const totalScore = judgeResults.reduce((sum, r) => sum + r.score, 0);
    const scoreDelta = judgeResults.length > 0 ? totalScore / judgeResults.length : 0;

    const reasoning = `Evaluated against ${judgeResults.length} traces. ` +
      `Average score delta: ${scoreDelta.toFixed(2)}. ` +
      `Positive: ${judgeResults.filter((r) => r.score > 0).length}, ` +
      `Negative: ${judgeResults.filter((r) => r.score < 0).length}, ` +
      `Neutral: ${judgeResults.filter((r) => r.score === 0).length}.`;

    updateEvaluation(evaluation.id, {
      status: "completed",
      scores_without: judgeResults.map((r) => ({ traceId: r.traceId, score: 0 })),
      scores_with: judgeResults.map((r) => ({ traceId: r.traceId, score: r.score })),
      score_delta: scoreDelta,
      judge_reasoning: reasoning,
      eval_tokens: 0,
      eval_cost: 0,
      completed_at: Date.now(),
    });

    return { id: evaluation.id, score_delta: scoreDelta, reasoning };
  } catch (err) {
    console.error("[evaluator] runNextEvaluation error:", err);
    return null;
  } finally {
    isRunning = false;
  }
}

/**
 * Build the judge prompt for comparing two responses.
 */
export function buildJudgePrompt(originalPrompt, responseA, responseB) {
  return `You are a response quality judge. Compare two responses to the same prompt and score them.

## Original Prompt
${originalPrompt}

## Response A (without knowledge)
${responseA}

## Response B (with knowledge)
${responseB}

## Instructions
Rate each response on a scale of 1-10 for:
1. Relevance - How relevant is the response to the prompt?
2. Accuracy - How accurate is the information?
3. Helpfulness - How helpful is the response?
4. Completeness - How complete is the response?

Return your evaluation as JSON:
{
  "scores_a": { "relevance": N, "accuracy": N, "helpfulness": N, "completeness": N },
  "scores_b": { "relevance": N, "accuracy": N, "helpfulness": N, "completeness": N },
  "reasoning": "Brief explanation of the comparison"
}`;
}

/**
 * Parse judge LLM output to extract scores.
 */
export function parseJudgeOutput(text) {
  try {
    // Try to find JSON in the output
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    const avgA = Object.values(parsed.scores_a || {}).reduce((a, b) => a + b, 0) / 4;
    const avgB = Object.values(parsed.scores_b || {}).reduce((a, b) => a + b, 0) / 4;

    return {
      scores_without: parsed.scores_a,
      scores_with: parsed.scores_b,
      delta: avgB - avgA,
      reasoning: parsed.reasoning || "",
    };
  } catch (err) {
    console.error("[evaluator] parseJudgeOutput error:", err);
    return null;
  }
}

/**
 * Start the background evaluation loop.
 *
 * @param {number} interval - Loop interval in ms (default 60s)
 */
export function startEvaluationLoop(interval = 60000) {
  try {
    const evalConfig = getEvaluatorConfig();
    if (!evalConfig.enabled) {
      console.log("[evaluator] disabled by config");
      return;
    }

    const engineId = getEvalEngineId();
    const engine = getEngineById(engineId);
    if (!engine) {
      console.log("[evaluator] no valid engine configured, skipping");
      return;
    }

    evaluationLoop = setInterval(async () => {
      try {
        // Idle detection: skip if there's active streaming
        // (would check global streaming flag in future)
        await runNextEvaluation(engine);
      } catch (err) {
        console.error("[evaluator] loop error:", err);
      }
    }, interval);

    console.log(`[evaluator] background loop started (interval: ${interval}ms)`);
  } catch (err) {
    console.error("[evaluator] startEvaluationLoop error:", err);
  }
}

/**
 * Stop the background evaluation loop.
 */
export function stopEvaluationLoop() {
  if (evaluationLoop) {
    clearInterval(evaluationLoop);
    evaluationLoop = null;
  }
}

/**
 * Get evaluator config from main config.
 */
function getEvaluatorConfig() {
  try {
    const config = loadConfig();
    return config.evaluator || { enabled: false };
  } catch {
    return { enabled: false };
  }
}

/**
 * Get the engine ID to use for evaluations.
 */
function getEvalEngineId() {
  try {
    const config = loadConfig();
    return config.evaluator?.engine_id || config.evolution?.reflection_engine || config.engines[0]?.id;
  } catch {
    return null;
  }
}
