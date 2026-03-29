// lib/injector.mjs — Build augmented context by injecting relevant knowledge
import { searchKnowledge, listKnowledge, getKnowledgeContent } from "./knowledge.mjs";
import { logEvolution } from "./trace.mjs";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getProjectRoot } from "./config.mjs";

// Simple stop words for keyword extraction
const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must",
  "i", "me", "my", "you", "your", "he", "she", "it", "we", "they",
  "this", "that", "these", "those", "what", "which", "who", "whom",
  "and", "or", "but", "if", "then", "else", "when", "where", "how",
  "not", "no", "nor", "so", "too", "very", "just", "about", "above",
  "after", "before", "between", "from", "into", "of", "on", "to", "with",
  "for", "at", "by", "in", "out", "up", "down", "as",
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都",
  "一", "一个", "上", "也", "很", "到", "说", "要", "去", "你",
  "会", "着", "没有", "看", "好", "自己", "这", "他", "她", "它",
  "吗", "吧", "呢", "啊", "哦", "嗯", "把", "被", "让", "给",
  "帮", "帮我", "请", "能", "可以", "什么", "怎么", "怎样", "如何",
]);

/**
 * Extract keywords from user prompt for knowledge matching.
 */
function extractKeywords(prompt) {
  return prompt
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff\s]/g, " ")  // keep alphanumeric + Chinese chars
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));
}

/**
 * Read goals.md content.
 */
export function loadGoals() {
  const goalsPath = join(getProjectRoot(), "data", "goals.md");
  if (!existsSync(goalsPath)) return "";
  return readFileSync(goalsPath, "utf-8").trim();
}

/**
 * Build injected context for a chat turn.
 *
 * Strategy:
 * 1. Always include goals.md (usually short)
 * 2. Always include "rules" entries with confidence >= 0.7
 * 3. Keyword-match other categories by tags/title
 * 4. Enforce token budget
 *
 * @param {string} prompt - User's message
 * @param {object} options
 * @param {number} options.maxTokens - Token budget (default 2000, ~8000 chars)
 * @param {string} options.convId - Conversation ID for logging
 * @returns {{ context: string, knowledgeIds: number[] }}
 */
export function buildInjectedContext(prompt, { maxTokens = 2000, convId = null } = {}) {
  const maxChars = maxTokens * 4; // rough approximation
  const parts = [];
  const knowledgeIds = [];
  let usedChars = 0;

  // 1. Goals (always inject, usually < 500 chars)
  const goals = loadGoals();
  if (goals) {
    const goalsBlock = `## Growth Goals\n\n${goals}`;
    parts.push(goalsBlock);
    usedChars += goalsBlock.length;
  }

  // 2. Rules with high confidence (always inject)
  const rules = listKnowledge("rules");
  for (const rule of rules) {
    if (rule.confidence < 0.7) continue;
    const full = getKnowledgeContent(rule.id);
    if (!full?.content) continue;

    const block = full.content.trim();
    if (usedChars + block.length > maxChars) break;

    parts.push(block);
    usedChars += block.length;
    knowledgeIds.push(rule.id);
  }

  // 3. Keyword-matched entries from other categories
  const keywords = extractKeywords(prompt);
  if (keywords.length > 0) {
    const matches = searchKnowledge(keywords, 10);
    for (const match of matches) {
      // Skip rules already included
      if (knowledgeIds.includes(match.id)) continue;

      const full = getKnowledgeContent(match.id);
      if (!full?.content) continue;

      const block = full.content.trim();
      if (usedChars + block.length > maxChars) break;

      parts.push(block);
      usedChars += block.length;
      knowledgeIds.push(match.id);
    }
  }

  if (!parts.length) return { context: "", knowledgeIds: [] };

  const context = `## Learned Context\n\nThe following knowledge was learned from past interactions. Use it to personalize your responses.\n\n${parts.join("\n\n---\n\n")}`;

  // Log injection event
  if (convId && knowledgeIds.length > 0) {
    logEvolution("injection_applied", {
      conv_id: convId,
      knowledge_ids: knowledgeIds,
      total_chars: usedChars,
      total_tokens_approx: Math.ceil(usedChars / 4),
    });
  }

  return { context, knowledgeIds };
}
