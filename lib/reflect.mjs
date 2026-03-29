// lib/reflect.mjs — Reflection engine: analyze traces, extract insights
import { getDb } from "./db.mjs";
import { getTraces, getTracesSinceLastReflection, logEvolution } from "./trace.mjs";
import { addKnowledge, getAllKnowledgeFormatted } from "./knowledge.mjs";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { getProjectRoot } from "./config.mjs";

const GOALS_PATH = () => join(getProjectRoot(), "data", "goals.md");

const GOALS_TEMPLATE = `# My Daemon Goals

## Communication
- (example) Always respond in Chinese unless I explicitly use English
- (example) Keep responses concise, prefer bullet points over paragraphs

## Technical
- (example) I work primarily with Node.js and Python
- (example) Prefer ES modules over CommonJS

## Personal
- (example) I'm in UTC+8 timezone
- (example) Send urgent notifications to Bark, normal ones to Feishu
`;

/**
 * Load goals.md content, creating template if missing.
 */
export function loadGoals() {
  const goalsPath = GOALS_PATH();
  const dataDir = join(getProjectRoot(), "data");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  if (!existsSync(goalsPath)) {
    writeFileSync(goalsPath, GOALS_TEMPLATE, "utf-8");
    return GOALS_TEMPLATE;
  }
  return readFileSync(goalsPath, "utf-8").trim();
}

/**
 * Save goals.md content.
 */
export function saveGoals(content) {
  const goalsPath = GOALS_PATH();
  const dataDir = join(getProjectRoot(), "data");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  writeFileSync(goalsPath, content, "utf-8");
}

/**
 * Build the reflection prompt from traces, goals, and existing knowledge.
 */
export function buildReflectionPrompt(traces, goals, existingKnowledge) {
  // Format traces for the prompt
  const formattedTraces = traces.map((t, i) => {
    const tools = t.tools_used ? JSON.parse(t.tools_used).map(x => x.name).join(", ") : "none";
    const fb = t.feedback ? ` [feedback: ${t.feedback}${t.feedback_note ? ` — "${t.feedback_note}"` : ""}]` : "";
    return `${i + 1}. [${new Date(t.created_at).toISOString()}] engine=${t.engine_id}\n   Prompt: "${t.prompt_summary}"\n   Tools: ${tools} | Response: ${t.response_len} chars | Duration: ${t.duration_ms}ms${fb}`;
  }).join("\n\n");

  return `You are analyzing interaction traces for an AI assistant to extract learning insights.
Your goal is to identify patterns, preferences, and rules that will help the assistant serve this specific user better in future conversations.

## Growth Goals

${goals || "(No goals defined yet)"}

## Recent Interaction Traces (${traces.length} conversations)

${formattedTraces || "(No traces available)"}

## Current Knowledge Base

${existingKnowledge || "(Empty — this is the first reflection)"}

## Instructions

Analyze the traces above and identify actionable insights. Focus on:
1. **User preferences** — communication style, language, format preferences
2. **Recurring patterns** — repeated questions, common workflows, frequent topics
3. **Domain knowledge** — the user's tech stack, projects, areas of expertise
4. **Rules** — explicit corrections, negative feedback patterns, things to always/never do

Pay special attention to:
- Traces with negative feedback ("down") — what went wrong? What rule should prevent this?
- Traces with positive feedback ("up") — what pattern should be replicated?
- Repeated similar requests — what shortcut or default could help?

For each insight, output it in this exact format (the delimiter lines are important):

---
category: {preferences|patterns|domain|rules}
title: {short description, max 50 chars}
tags: {comma-separated keywords}
confidence: {0.0 to 1.0 — higher means more evidence}
content: {the knowledge to remember, 1-3 sentences}
---

Output between 1 and 10 insights. Quality over quantity — only include insights with real evidence from the traces.
If there is not enough data for meaningful insights, output 0 insights and explain why.`;
}

/**
 * Parse structured insight blocks from LLM reflection output.
 */
export function parseReflectionOutput(text) {
  const insights = [];
  // Split by --- delimiters
  const blocks = text.split(/^---$/m);

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i].trim();
    if (!block) continue;

    const category = extractField(block, "category");
    const title = extractField(block, "title");
    const tags = extractField(block, "tags");
    const confidence = parseFloat(extractField(block, "confidence") || "0.5");
    const content = extractField(block, "content");

    // Must have at minimum category, title, and content
    if (category && title && content) {
      const validCategories = ["preferences", "patterns", "domain", "rules"];
      insights.push({
        category: validCategories.includes(category) ? category : "patterns",
        title: title.substring(0, 100),
        tags: tags || "",
        confidence: isNaN(confidence) ? 0.5 : Math.max(0, Math.min(1, confidence)),
        content,
      });
    }
  }

  return insights;
}

function extractField(block, fieldName) {
  const regex = new RegExp(`^${fieldName}:\\s*(.+)$`, "mi");
  const match = block.match(regex);
  return match ? match[1].trim() : null;
}

/**
 * Save accepted insights to the knowledge base.
 * Returns count of saved insights.
 */
export function saveAcceptedInsights(insights) {
  let saved = 0;
  for (const insight of insights) {
    try {
      addKnowledge(
        insight.category,
        insight.title,
        insight.tags,
        insight.content,
        "reflection",
        insight.confidence
      );
      saved++;
    } catch (err) {
      console.error(`[reflect] failed to save insight "${insight.title}":`, err.message);
    }
  }
  return saved;
}

/**
 * Save pending insights for user review.
 */
export function savePendingInsights(reflectionId, insights) {
  const now = Date.now();
  const stmt = getDb().prepare(
    `INSERT INTO pending_insights (reflection_id, category, title, tags, content, confidence, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
  );

  for (const insight of insights) {
    stmt.run(reflectionId, insight.category, insight.title, insight.tags, insight.content, insight.confidence, now);
  }
}

/**
 * Get pending insights.
 */
export function getPendingInsights(status = "pending") {
  return getDb()
    .prepare("SELECT * FROM pending_insights WHERE status = ? ORDER BY confidence DESC, created_at DESC")
    .all(status);
}

/**
 * Accept a pending insight — move to knowledge base.
 */
export function acceptPendingInsight(id) {
  const insight = getDb().prepare("SELECT * FROM pending_insights WHERE id = ? AND status = 'pending'").get(id);
  if (!insight) return null;

  addKnowledge(insight.category, insight.title, insight.tags, insight.content, "reflection", insight.confidence);
  getDb().prepare("UPDATE pending_insights SET status = 'accepted' WHERE id = ?").run(id);

  // Update reflection accepted count
  getDb().prepare("UPDATE reflections SET insights_accepted = insights_accepted + 1 WHERE id = ?").run(insight.reflection_id);

  logEvolution("insight_accepted", {
    insight_id: id,
    category: insight.category,
    title: insight.title,
    confidence: insight.confidence,
  });

  return { id, accepted: true };
}

/**
 * Reject a pending insight.
 */
export function rejectPendingInsight(id) {
  const insight = getDb().prepare("SELECT * FROM pending_insights WHERE id = ? AND status = 'pending'").get(id);
  if (!insight) return null;

  getDb().prepare("UPDATE pending_insights SET status = 'rejected' WHERE id = ?").run(id);

  logEvolution("insight_rejected", {
    insight_id: id,
    category: insight.category,
    title: insight.title,
  });

  return { id, rejected: true };
}

/**
 * Create a reflection record in the database.
 */
export function createReflection({ engineId, traceStart, traceEnd, traceCount, insightsRaw, insightsAccepted = 0, insightsAutoAccepted = 0, triggerReason, reflectionTokens = null, reflectionCost = null }) {
  const now = Date.now();
  const result = getDb()
    .prepare(
      `INSERT INTO reflections (engine_id, trace_start, trace_end, trace_count, insights_raw, insights_accepted, insights_auto_accepted, trigger_reason, reflection_tokens, reflection_cost, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(engineId, traceStart, traceEnd, traceCount, insightsRaw, insightsAccepted, insightsAutoAccepted, triggerReason, reflectionTokens, reflectionCost, now);

  return { id: result.lastInsertRowid, created_at: now };
}

/**
 * Run a complete reflection cycle.
 * 1. Load traces since last reflection
 * 2. Build reflection prompt
 * 3. Return prompt (caller sends to LLM and passes output back)
 * 4. Parse insights, auto-accept high confidence, queue rest
 *
 * This is a two-phase process:
 * - Phase 1: prepareReflection() returns the prompt
 * - Phase 2: processReflectionResult() handles the LLM output
 */
export function prepareReflection(traceLimit = 100, since = null) {
  const traces = since != null
    ? getTraces({ since, limit: traceLimit })
    : getTracesSinceLastReflection(traceLimit);
  const goals = loadGoals();
  const existingKnowledge = getAllKnowledgeFormatted();
  const prompt = buildReflectionPrompt(traces, goals, existingKnowledge);

  // Summary for preview
  const badCount = traces.filter(t => t.feedback === 'down').length;
  const goodCount = traces.filter(t => t.feedback === 'up').length;
  const totalTokens = traces.reduce((s, t) => s + (t.input_tokens || 0) + (t.output_tokens || 0), 0);

  return {
    prompt,
    traceCount: traces.length,
    traceStart: traces.length > 0 ? traces[traces.length - 1].created_at : null,
    traceEnd: traces.length > 0 ? traces[0].created_at : null,
    summary: {
      total: traces.length,
      good_feedback: goodCount,
      bad_feedback: badCount,
      no_feedback: traces.length - goodCount - badCount,
      total_tokens: totalTokens,
    },
  };
}

/**
 * Get reflection history.
 */
export function getReflectionHistory(limit = 20) {
  return getDb()
    .prepare(
      `SELECT id, engine_id, trace_count, insights_accepted, insights_auto_accepted,
              trigger_reason, reflection_tokens, reflection_cost, created_at
       FROM reflections ORDER BY created_at DESC LIMIT ?`
    )
    .all(limit);
}

/**
 * Process LLM reflection output.
 * @param {string} llmOutput - Full text output from LLM
 * @param {object} meta - { engineId, traceStart, traceEnd, traceCount, triggerReason, tokens, cost }
 * @returns {{ reflectionId, insights, autoAccepted, pending }}
 */
export function processReflectionResult(llmOutput, { engineId, traceStart, traceEnd, traceCount, triggerReason = "manual", tokens = null, cost = null }) {
  const insights = parseReflectionOutput(llmOutput);

  const AUTO_ACCEPT_THRESHOLD = 0.9;
  const autoAccept = insights.filter(i => i.confidence >= AUTO_ACCEPT_THRESHOLD);
  const pending = insights.filter(i => i.confidence < AUTO_ACCEPT_THRESHOLD);

  // Create reflection record
  const reflection = createReflection({
    engineId,
    traceStart,
    traceEnd,
    traceCount,
    insightsRaw: llmOutput,
    insightsAccepted: autoAccept.length,
    insightsAutoAccepted: autoAccept.length,
    triggerReason,
    reflectionTokens: tokens,
    reflectionCost: cost,
  });

  // Auto-accept high confidence insights
  const savedCount = saveAcceptedInsights(autoAccept);
  for (const insight of autoAccept) {
    logEvolution("insight_auto_accepted", {
      reflection_id: reflection.id,
      category: insight.category,
      title: insight.title,
      confidence: insight.confidence,
    });
  }

  // Save pending insights for user review
  if (pending.length > 0) {
    savePendingInsights(reflection.id, pending);
  }

  // Update evolution state
  getDb()
    .prepare("UPDATE evolution_state SET last_reflection_at = ?, bad_feedback_since_last = 0, conv_since_last = 0, updated_at = ? WHERE id = 1")
    .run(Date.now(), Date.now());

  logEvolution("reflection_completed", {
    reflection_id: reflection.id,
    insights_total: insights.length,
    auto_accepted: autoAccept.length,
    pending: pending.length,
    tokens,
    cost,
  });

  return {
    reflectionId: reflection.id,
    insights,
    autoAccepted: autoAccept.length,
    pending: pending.length,
  };
}
