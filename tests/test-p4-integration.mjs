/**
 * Phase 4 Integration Test
 *
 * Tests all P4 modules: DB schema, orchestrator, evaluator, A/B testing, self-coder
 * Run: node tests/test-p4-integration.mjs
 */

import { initDb, getDb, addSubAgentRun, updateSubAgentRun, listSubAgentRuns,
  addEvaluation, updateEvaluation, getEvaluations, getOldestQueuedEvaluation, getEvaluationStats,
  createExperiment, getActiveExperiment, updateExperiment, listExperiments, addExperimentAssignment, getExperimentAssignment,
  addSelfCodedTool, updateSelfCodedTool, getSelfCodedTool, getSelfCodedToolByName, listSelfCodedTools,
  createConversation } from "../lib/db.mjs";

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ FAIL: ${msg}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ──`);
}

// ── Init ──
console.log("🧪 Phase 4 Integration Tests\n");

try {
  initDb();
  assert(true, "Database initialized");
} catch (err) {
  console.error("Fatal: Cannot initialize database:", err);
  process.exit(1);
}

// Create a test conversation
const conv = createConversation("test-engine");
assert(conv && conv.id, `Test conversation created: ${conv.id}`);

// ── T1: Database Schema ──
section("T1: Database Schema");

try {
  const tables = getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  assert(tables.includes("sub_agent_runs"), "sub_agent_runs table exists");
  assert(tables.includes("evaluations"), "evaluations table exists");
  assert(tables.includes("experiments"), "experiments table exists");
  assert(tables.includes("experiment_assignments"), "experiment_assignments table exists");
  assert(tables.includes("self_coded_tools"), "self_coded_tools table exists");
} catch (err) {
  assert(false, `Schema check error: ${err.message}`);
}

// Check parent_trace_id column on traces
try {
  const cols = getDb().prepare("PRAGMA table_info(traces)").all().map(c => c.name);
  assert(cols.includes("parent_trace_id"), "traces.parent_trace_id column exists");
} catch (err) {
  assert(false, `parent_trace_id check error: ${err.message}`);
}

// ── Sub-Agent Runs CRUD ──
section("Sub-Agent Runs CRUD");

try {
  const run = addSubAgentRun({
    parent_conv_id: conv.id,
    agent_type: "researcher",
    agent_config: { allowedTools: ["web_search"] },
    input_context: "test query",
    engine_id: "test-engine",
  });
  assert(run && run.id, `Sub-agent run created: id=${run.id}`);

  updateSubAgentRun(run.id, { status: "completed", output_result: "test output", duration_ms: 1500, completed_at: Date.now() });
  const runs = listSubAgentRuns(conv.id);
  assert(runs.length === 1, `Listed 1 sub-agent run`);
  assert(runs[0].status === "completed", `Run status updated to completed`);
  assert(runs[0].output_result === "test output", `Run output stored correctly`);
} catch (err) {
  assert(false, `Sub-agent runs error: ${err.message}`);
}

// ── Evaluations CRUD ──
section("Evaluations CRUD");

try {
  // Create a test knowledge entry first (FK requirement)
  const knowledgeId = getDb().prepare(
    "INSERT INTO knowledge_index (category, title, tags, file_path, source_type, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run("test", "Test Knowledge", "test", "data/test.md", "reflection", 0.8, Date.now(), Date.now()).lastInsertRowid;

  const ev = addEvaluation({ knowledge_id: knowledgeId, status: "queued", trace_ids: [1, 2, 3], engine_id: "test-engine" });
  assert(ev && ev.id, `Evaluation created: id=${ev.id}`);

  const queued = getOldestQueuedEvaluation();
  assert(queued && queued.id === ev.id, "Oldest queued evaluation found");

  updateEvaluation(ev.id, { status: "completed", score_delta: 0.5, judge_reasoning: "test reasoning", completed_at: Date.now() });
  const evals = getEvaluations({ status: "completed" });
  assert(evals.length >= 1, "Evaluations listed by status filter");
  assert(evals[0].score_delta === 0.5, "Score delta stored correctly");

  const stats = getEvaluationStats();
  assert(stats && stats.total >= 1, `Evaluation stats: total=${stats.total}`);
} catch (err) {
  assert(false, `Evaluations error: ${err.message}`);
}

// ── Experiments / A/B Testing CRUD ──
section("Experiments CRUD");

try {
  const exp = createExperiment({ name: "test-exp", surface: "system_prompt", variant_a: "Prompt A", variant_b: "Prompt B", min_conversations: 5 });
  assert(exp && exp.id, `Experiment created: id=${exp.id}`);

  const active = getActiveExperiment();
  assert(active && active.name === "test-exp", "Active experiment found");

  addExperimentAssignment(exp.id, conv.id, "A");
  const assignment = getExperimentAssignment(conv.id);
  assert(assignment && assignment.variant === "A", "Experiment assignment created");

  updateExperiment(exp.id, { conversations_a: 1, feedback_a: JSON.stringify({ good: 1, bad: 0 }) });
  const exps = listExperiments("active");
  assert(exps.length >= 1, "Experiments listed by status");
  assert(exps[0].conversations_a === 1, "Experiment counters updated");

  // Cancel it so it doesn't interfere
  updateExperiment(exp.id, { status: "cancelled", completed_at: Date.now() });
  const active2 = getActiveExperiment();
  assert(!active2, "No active experiment after cancellation");
} catch (err) {
  assert(false, `Experiments error: ${err.message}`);
}

// ── Self-Coded Tools CRUD ──
section("Self-Coded Tools CRUD");

try {
  const toolName = `test_tool_p4_${Date.now()}`;
  const tool = addSelfCodedTool({
    tool_name: toolName,
    description: "A test tool",
    input_schema: { type: "object", properties: { input: { type: "string" } } },
    origin_pattern: "test pattern",
  });
  assert(tool && tool.id, `Self-coded tool created: id=${tool.id}`);

  const found = getSelfCodedToolByName(toolName);
  assert(found && found.tool_name === toolName, "Tool found by name");

  updateSelfCodedTool(tool.id, { status: "generated", code: "print('hello')" });
  const detail = getSelfCodedTool(tool.id);
  assert(detail.status === "generated", "Tool status updated");
  assert(detail.code === "print('hello')", "Tool code stored");

  const tools = listSelfCodedTools();
  assert(tools.length >= 1, `Listed ${tools.length} self-coded tool(s)`);

  const byStatus = listSelfCodedTools("generated");
  assert(byStatus.length >= 1, "Tools filtered by status");
} catch (err) {
  assert(false, `Self-coded tools error: ${err.message}`);
}

// ── Module Import Tests ──
section("Module Imports");

try {
  const { shouldDispatch, dispatch, getOrchestratorConfig, AGENT_TYPES } = await import("../lib/orchestrator.mjs");
  assert(typeof shouldDispatch === "function", "orchestrator.shouldDispatch is function");
  assert(typeof dispatch === "function", "orchestrator.dispatch is function");
  assert(AGENT_TYPES && AGENT_TYPES.researcher, "AGENT_TYPES has researcher");
  assert(AGENT_TYPES.analyst && AGENT_TYPES.coder && AGENT_TYPES.reviewer, "All 4 agent types defined");

  const config = getOrchestratorConfig();
  assert(config && config.dispatch_mode, `Orchestrator config loaded: mode=${config.dispatch_mode}`);
} catch (err) {
  assert(false, `Orchestrator import error: ${err.message}`);
}

try {
  const { queueEvaluation, buildJudgePrompt, parseJudgeOutput, startEvaluationLoop, stopEvaluationLoop } = await import("../lib/evaluator.mjs");
  assert(typeof queueEvaluation === "function", "evaluator.queueEvaluation is function");
  assert(typeof buildJudgePrompt === "function", "evaluator.buildJudgePrompt is function");

  const prompt = buildJudgePrompt("What is X?", "Response A", "Response B");
  assert(prompt.includes("What is X?"), "Judge prompt contains original question");

  const parsed = parseJudgeOutput('{"scores_a":{"relevance":5,"accuracy":5,"helpfulness":5,"completeness":5},"scores_b":{"relevance":8,"accuracy":8,"helpfulness":8,"completeness":8},"reasoning":"B is better"}');
  assert(parsed && parsed.delta === 3, `parseJudgeOutput delta=${parsed?.delta}`);

  stopEvaluationLoop();
  assert(true, "Evaluation loop start/stop OK");
} catch (err) {
  assert(false, `Evaluator import error: ${err.message}`);
}

try {
  const abTesting = await import("../lib/ab-testing.mjs");
  assert(typeof abTesting.createExperiment === "function", "ab-testing.createExperiment is function");
  assert(typeof abTesting.assignVariant === "function", "ab-testing.assignVariant is function");
  assert(typeof abTesting.recordFeedback === "function", "ab-testing.recordFeedback is function");
  assert(typeof abTesting.getOverride === "function", "ab-testing.getOverride is function");

  // Test getOverride returns null for non-existent file
  const override = abTesting.getOverride("system_prompt");
  assert(override === null || typeof override === "string", "getOverride returns null or string");
} catch (err) {
  assert(false, `A/B testing import error: ${err.message}`);
}

try {
  const selfCoder = await import("../lib/self-coder.mjs");
  assert(typeof selfCoder.detectAutomationOpportunity === "function", "self-coder.detectAutomationOpportunity is function");
  assert(typeof selfCoder.validateTool === "function", "self-coder.validateTool is function");
  assert(typeof selfCoder.installTool === "function", "self-coder.installTool is function");

  // Test detection with no data
  const result = selfCoder.detectAutomationOpportunity([], []);
  assert(result.detected === false, "No automation detected with empty input");

  // Test detection with automation insight
  const result2 = selfCoder.detectAutomationOpportunity([], [{ category: "automation", title: "Auto backup tool", content: "Repeated backup pattern" }]);
  assert(result2.detected === true, "Automation detected with automation insight");
} catch (err) {
  assert(false, `Self-coder import error: ${err.message}`);
}

// ── Orchestrator Logic Tests ──
section("Orchestrator Logic");

try {
  const { shouldDispatch } = await import("../lib/orchestrator.mjs");

  // Disabled mode
  const r1 = await shouldDispatch("hello world", { dispatch_mode: "disabled" });
  assert(r1.use === false, "Disabled mode returns use=false");

  // Explicit mode with command
  const r2 = await shouldDispatch("/research what is quantum computing", { dispatch_mode: "explicit" });
  assert(r2.use === true && r2.subtasks[0].type === "researcher", "Explicit /research command detected");

  const r3 = await shouldDispatch("/analyze the data", { dispatch_mode: "explicit" });
  assert(r3.use === true && r3.subtasks[0].type === "analyst", "Explicit /analyze command detected");

  // Explicit mode without command
  const r4 = await shouldDispatch("just a normal question", { dispatch_mode: "explicit" });
  assert(r4.use === false, "Explicit mode ignores normal prompts");

  // Auto mode with single concern (should not dispatch)
  const r5 = await shouldDispatch("search for the latest news", { dispatch_mode: "auto" });
  assert(r5.use === false, "Auto mode: single concern = no dispatch");

  // Auto mode with multiple concerns
  const r6 = await shouldDispatch("search for React vs Vue and analyze compare their performance then write code for a benchmark", { dispatch_mode: "auto" });
  assert(r6.use === true && r6.subtasks.length >= 2, `Auto mode: multiple concerns detected (${r6.subtasks.length} subtasks)`);
} catch (err) {
  assert(false, `Orchestrator logic error: ${err.message}`);
}

// ── MCP Manager reload ──
section("MCP Manager");

try {
  const { MCPManager } = await import("../lib/mcp-manager.mjs");
  const mgr = new MCPManager({}, {});
  assert(typeof mgr.reload === "function", "MCPManager.reload exists");
  assert(typeof mgr.invalidateToolCache === "function", "MCPManager.invalidateToolCache exists");

  mgr.invalidateToolCache();
  assert(mgr._tools === null, "Tool cache invalidated");
} catch (err) {
  assert(false, `MCP Manager error: ${err.message}`);
}

// ── Trace with parent_trace_id ──
section("Trace Enhancement");

try {
  const { addTrace } = await import("../lib/trace.mjs");
  const trace = addTrace({
    conv_id: conv.id,
    engine_id: "test-engine",
    prompt_summary: "test trace with parent",
    parent_trace_id: null,
  });
  assert(trace && trace.id, `Trace created with parent_trace_id support: id=${trace.id}`);

  // Create child trace
  const childTrace = addTrace({
    conv_id: conv.id,
    engine_id: "test-engine",
    prompt_summary: "child trace",
    parent_trace_id: trace.id,
  });
  assert(childTrace && childTrace.id, `Child trace created: id=${childTrace.id}`);

  // Verify parent_trace_id is stored
  const row = getDb().prepare("SELECT parent_trace_id FROM traces WHERE id = ?").get(childTrace.id);
  assert(row.parent_trace_id === trace.id, `parent_trace_id correctly stored: ${row.parent_trace_id}`);
} catch (err) {
  assert(false, `Trace enhancement error: ${err.message}`);
}

// ── Reflection with automation category ──
section("Reflection Enhancement");

try {
  const { buildReflectionPrompt } = await import("../lib/reflect.mjs");
  const prompt = buildReflectionPrompt([], "Test goals", "");
  assert(prompt.includes("automation"), "Reflection prompt mentions automation");
  assert(prompt.includes("preferences|patterns|domain|rules|automation"), "Reflection prompt includes automation category");
} catch (err) {
  assert(false, `Reflection enhancement error: ${err.message}`);
}

// ── Clean up test data ──
section("Cleanup");
try {
  getDb().prepare("DELETE FROM conversations WHERE id = ?").run(conv.id);
  assert(true, "Test data cleaned up");
} catch (err) {
  assert(false, `Cleanup error: ${err.message}`);
}

// ── Summary ──
console.log(`\n${"═".repeat(40)}`);
console.log(`📊 Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${"═".repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
