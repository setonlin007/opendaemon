/**
 * Phase 4: A/B Testing Module
 *
 * Manages experiments that compare two variants of system prompts,
 * injection templates, or reflection prompts. Tracks feedback per
 * variant and auto-decides winners.
 */

import { existsSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import {
  createExperiment as dbCreateExperiment,
  getActiveExperiment,
  updateExperiment,
  listExperiments as dbListExperiments,
  addExperimentAssignment,
  getExperimentAssignment,
} from "./db.mjs";
import { getProjectRoot } from "./config.mjs";

// Valid experiment surfaces
const SURFACES = ["system_prompt", "injection_template", "reflection_prompt"];

/**
 * Create a new A/B experiment.
 *
 * @param {object} data - { name, surface, variantA, variantB, minConversations }
 * @returns {object} Created experiment record
 */
export function createExperiment({ name, surface, variantA, variantB, minConversations = 20 }) {
  try {
    if (!name) throw new Error("Experiment name required");
    if (!SURFACES.includes(surface)) throw new Error(`Invalid surface. Must be one of: ${SURFACES.join(", ")}`);
    if (!variantA || !variantB) throw new Error("Both variantA and variantB are required");

    // Only one active experiment at a time
    const active = getActiveExperiment();
    if (active) throw new Error(`Experiment "${active.name}" is already active. Cancel or complete it first.`);

    return dbCreateExperiment({
      name,
      surface,
      variant_a: variantA,
      variant_b: variantB,
      min_conversations: minConversations,
    });
  } catch (err) {
    console.error("[ab-testing] createExperiment error:", err);
    throw err;
  }
}

/**
 * Assign a conversation to a variant (A or B).
 * Uses alternating assignment for balanced distribution.
 *
 * @param {string} convId - Conversation ID
 * @returns {{ variant: string, content: string }|null} - Assigned variant or null if no experiment
 */
export function assignVariant(convId) {
  try {
    const experiment = getActiveExperiment();
    if (!experiment) return null;

    // Check if already assigned
    const existing = getExperimentAssignment(convId);
    if (existing) {
      const content = existing.variant === "A" ? experiment.variant_a : experiment.variant_b;
      return { variant: existing.variant, content, surface: experiment.surface };
    }

    // Alternating assignment based on total conversation count
    const totalConvs = (experiment.conversations_a || 0) + (experiment.conversations_b || 0);
    const variant = totalConvs % 2 === 0 ? "A" : "B";

    addExperimentAssignment(experiment.id, convId, variant);

    // Update experiment counters
    if (variant === "A") {
      updateExperiment(experiment.id, { conversations_a: (experiment.conversations_a || 0) + 1 });
    } else {
      updateExperiment(experiment.id, { conversations_b: (experiment.conversations_b || 0) + 1 });
    }

    const content = variant === "A" ? experiment.variant_a : experiment.variant_b;
    return { variant, content, surface: experiment.surface };
  } catch (err) {
    console.error("[ab-testing] assignVariant error:", err);
    return null;
  }
}

/**
 * Record feedback for a conversation's experiment assignment.
 *
 * @param {string} convId - Conversation ID
 * @param {string} feedback - "up" or "down"
 */
export function recordFeedback(convId, feedback) {
  try {
    const assignment = getExperimentAssignment(convId);
    if (!assignment) return;

    const experiment = getActiveExperiment();
    if (!experiment || experiment.id !== assignment.experiment_id) return;

    // Update feedback counters
    const feedbackKey = assignment.variant === "A" ? "feedback_a" : "feedback_b";
    const existing = experiment[feedbackKey] ? JSON.parse(experiment[feedbackKey]) : { good: 0, bad: 0 };

    if (feedback === "up") existing.good++;
    else if (feedback === "down") existing.bad++;

    updateExperiment(experiment.id, { [feedbackKey]: existing });

    // Check if experiment should auto-complete
    checkExperimentCompletion(experiment.id);
  } catch (err) {
    console.error("[ab-testing] recordFeedback error:", err);
  }
}

/**
 * Check if an experiment has enough data to auto-decide a winner.
 *
 * @param {number} experimentId
 */
export function checkExperimentCompletion(experimentId) {
  try {
    const experiment = getActiveExperiment();
    if (!experiment || experiment.id !== experimentId) return;

    const minConvs = experiment.min_conversations || 20;
    if ((experiment.conversations_a || 0) < minConvs || (experiment.conversations_b || 0) < minConvs) {
      return; // Not enough data yet
    }

    const feedbackA = experiment.feedback_a ? JSON.parse(experiment.feedback_a) : { good: 0, bad: 0 };
    const feedbackB = experiment.feedback_b ? JSON.parse(experiment.feedback_b) : { good: 0, bad: 0 };

    const totalA = feedbackA.good + feedbackA.bad;
    const totalB = feedbackB.good + feedbackB.bad;

    if (totalA === 0 && totalB === 0) return; // No feedback yet

    const ratioA = totalA > 0 ? feedbackA.good / totalA : 0;
    const ratioB = totalB > 0 ? feedbackB.good / totalB : 0;

    const diff = Math.abs(ratioA - ratioB);
    if (diff >= 0.1) {
      // 10% minimum difference threshold
      const winner = ratioA > ratioB ? "A" : "B";
      decideWinner(experimentId, winner);
    }
  } catch (err) {
    console.error("[ab-testing] checkExperimentCompletion error:", err);
  }
}

/**
 * Manually or automatically decide the winner of an experiment.
 *
 * @param {number} experimentId
 * @param {string} winner - "A" or "B"
 */
export function decideWinner(experimentId, winner) {
  try {
    if (!["A", "B"].includes(winner)) throw new Error("Winner must be 'A' or 'B'");

    // Get experiment to apply winning variant
    const experiments = dbListExperiments("active");
    const experiment = experiments.find((e) => e.id === experimentId);
    if (!experiment) throw new Error("Experiment not found or not active");

    const winningContent = winner === "A" ? experiment.variant_a : experiment.variant_b;

    // Apply the winning variant
    applyVariant(experiment.surface, winningContent);

    updateExperiment(experimentId, {
      status: "completed",
      winner,
      completed_at: Date.now(),
    });

    console.log(`[ab-testing] Experiment "${experiment.name}" completed. Winner: Variant ${winner}`);
  } catch (err) {
    console.error("[ab-testing] decideWinner error:", err);
    throw err;
  }
}

/**
 * Persist the winning variant to override files.
 *
 * @param {string} surface - The surface type
 * @param {string} content - The winning variant content
 */
export function applyVariant(surface, content) {
  try {
    const dataDir = join(getProjectRoot(), "data");
    const fileMap = {
      system_prompt: "system_prompt_override.md",
      injection_template: "injection_template_override.md",
      reflection_prompt: "reflection_prompt_override.md",
    };

    const filename = fileMap[surface];
    if (!filename) throw new Error(`Unknown surface: ${surface}`);

    const filePath = join(dataDir, filename);
    writeFileSync(filePath, content, "utf-8");
    console.log(`[ab-testing] Applied winning variant to ${filePath}`);
  } catch (err) {
    console.error("[ab-testing] applyVariant error:", err);
    throw err;
  }
}

/**
 * Read an override file if it exists.
 *
 * @param {string} surface - The surface type
 * @returns {string|null} - Override content or null
 */
export function getOverride(surface) {
  try {
    const dataDir = join(getProjectRoot(), "data");
    const fileMap = {
      system_prompt: "system_prompt_override.md",
      injection_template: "injection_template_override.md",
      reflection_prompt: "reflection_prompt_override.md",
    };

    const filename = fileMap[surface];
    if (!filename) return null;

    const filePath = join(dataDir, filename);
    if (!existsSync(filePath)) return null;

    return readFileSync(filePath, "utf-8");
  } catch (err) {
    console.error("[ab-testing] getOverride error:", err);
    return null;
  }
}

/**
 * List experiments with optional status filter.
 */
export function listExperiments(status) {
  return dbListExperiments(status);
}

/**
 * Cancel an active experiment.
 *
 * @param {number} experimentId
 */
export function cancelExperiment(experimentId) {
  try {
    updateExperiment(experimentId, {
      status: "cancelled",
      completed_at: Date.now(),
    });
  } catch (err) {
    console.error("[ab-testing] cancelExperiment error:", err);
    throw err;
  }
}
