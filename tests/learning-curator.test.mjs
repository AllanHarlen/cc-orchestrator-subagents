import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  LearningError,
  listLessons,
  listRecipes,
  matchRecipes,
  promoteLessonToRecipe,
  recordRecipeOutcome,
  runLearningPhase,
  setRecipePinned,
  validateLesson,
} from "../skills/orchestrator-multi-agent-development/scripts/lib/learning-recipes.mjs";
import {
  createKnowledgeBackup,
  curateKnowledge,
  curatorStatus,
  rollbackKnowledge,
} from "../skills/orchestrator-multi-agent-development/scripts/lib/knowledge-curator.mjs";
import {
  initRun,
  loadRun,
  sweepStalledTasks,
  updateCompletionGate,
  updatePhase,
  updateTaskStatus,
} from "../skills/orchestrator-multi-agent-development/scripts/lib/orchestration-state.mjs";
import {
  openKnowledgeStore,
  projectKnowledgePaths,
} from "../skills/orchestrator-multi-agent-development/scripts/lib/project-knowledge.mjs";
import { approveReview, waiveApiContract } from "./helpers/review-report.mjs";

const roots = [];

function fixture() {
  const root = mkdtempSync(join(process.cwd(), ".tmp-learning-test-"));
  roots.push(root);
  const artifactDir = join(root, ".orchestration", "learning-run");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, "tasks-classification.md"), [
    "# Tasks",
    "",
    "## BE-01 - Restore dependencies",
    "- category: BACKEND_ONLY",
    "- complexity: medium",
    "- assignedAgent: codex",
    "- validationPlan: `dotnet restore`",
  ].join("\n"), "utf8");
  writeFileSync(join(artifactDir, "waves.md"), "# Waves\n\n## Wave 1\n- BE-01\n", "utf8");
  initRun({ projectRoot: root, artifactDir, slug: "learning-run", runId: "learning-run-001" });
  // assertPhaseTransition (Achado 1) exige todo predecessor fechado antes da
  // Fase 12 poder abrir RUNNING; runLearningPhase() faz exatamente essa
  // chamada internamente. Tambem exige (PHASE_GATE_NOT_DONE) que os gates
  // proprios de cada fase ja estejam fechados: BACKEND_ONLY torna apenas
  // monitoring (sempre required) e backendReview (ha task de back-end)
  // required de verdade; os demais (frontendReview/visualAudit/browserE2E/
  // visualMaterialization) ficam N/A automaticamente.
  for (const phase of [1, 2, 3, 4, 5]) {
    updatePhase(artifactDir, phase, "DONE", { projectRoot: root, evidence: `test:${phase}:DONE` });
  }
  sweepStalledTasks(artifactDir, { projectRoot: root });
  updateCompletionGate(artifactDir, "monitoring", "DONE", { projectRoot: root, evidence: ["manual"] });
  updatePhase(artifactDir, 6, "DONE", { projectRoot: root, evidence: "test:6:DONE" });
  approveReview(artifactDir, "backendReview");
  waiveApiContract(artifactDir, root);
  updateCompletionGate(artifactDir, "backendReview", "DONE", { projectRoot: root, evidence: ["manual"] });
  for (const phase of [7, 8, 9, 9.5]) {
    updatePhase(artifactDir, phase, "DONE", { projectRoot: root, evidence: `test:${phase}:DONE` });
  }
  updateCompletionGate(artifactDir, "reports", "DONE", { projectRoot: root, evidence: ["manual"] });
  updateCompletionGate(artifactDir, "handoff", "DONE", { projectRoot: root, evidence: ["manual"] });
  updatePhase(artifactDir, 10, "DONE", { projectRoot: root, evidence: "test:10:DONE" });
  updateCompletionGate(artifactDir, "delivery", "DONE", { projectRoot: root, evidence: ["manual"] });
  updatePhase(artifactDir, 11, "DONE", { projectRoot: root, evidence: "test:11:DONE" });
  updateTaskStatus(artifactDir, "BE-01", "RUNNING", {
    projectRoot: root,
    executor: "codex",
    sessionId: "session-one",
  });
  updateTaskStatus(artifactDir, "BE-01", "BLOCKED", {
    projectRoot: root,
    reasonCode: "NU1301",
    reason: "NuGet sandbox blocked the registry",
    evidence: "executor:session-one:NU1301",
  });
  return { root, artifactDir };
}

test.afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

test("Phase 12 persists candidates but never promotes them automatically", () => {
  const { root, artifactDir } = fixture();
  const result = runLearningPhase(root, artifactDir, { now: "2026-08-17T12:00:00.000Z" });
  assert.equal(result.persisted, 1);
  assert.equal(result.candidates[0].status, "CANDIDATE");
  const reportPath = join(artifactDir, "learning", "learning-report.md");
  assert.equal(existsSync(reportPath), true, "layout 2 grava o learning-report em learning/");
  assert.match(readFileSync(reportPath, "utf8"), /automatically promoted: 0/);
  assert.equal(loadRun(artifactDir).state.layoutVersion, 2);
  assert.match(
    loadRun(artifactDir).state.completionGates.learning.evidence.join(" "),
    /learning\/learning-report\.md/,
  );
  assert.equal(loadRun(artifactDir).state.phase, 12);
  assert.equal(loadRun(artifactDir).state.completionGates.learning.status, "DONE");
  assert.equal(listRecipes(root).length, 0);
});

test("a validated lesson becomes a deterministic recipe with measured outcomes", () => {
  const { root, artifactDir } = fixture();
  runLearningPhase(root, artifactDir);
  const candidate = listLessons(root, { status: "CANDIDATE" })[0];
  assert.throws(
    () => promoteLessonToRecipe(root, candidate.id, { recipeId: "nuget-sandbox" }),
    (error) => error instanceof LearningError && error.code === "LESSON_NOT_VALIDATED",
  );
  validateLesson(root, candidate.id, {
    type: "USER",
    source: "user-confirmed-network-sandbox-policy",
  }, { actor: "user" });
  const recipe = promoteLessonToRecipe(root, candidate.id, { recipeId: "nuget-sandbox" });
  assert.equal(recipe.status, "ACTIVE");
  assert.equal(existsSync(join(projectKnowledgePaths(root).learnedDir, "nuget-sandbox.md")), true);
  const matches = matchRecipes(root, { error: "Restore failed with NU1301", executor: "codex" });
  assert.deepEqual(matches.map((item) => item.id), ["nuget-sandbox"]);
  const used = recordRecipeOutcome(root, "nuget-sandbox", "SUCCESS", {
    runId: "another-run",
    taskId: "BE-02",
    evidence: ["test:restore-policy:PASS"],
  });
  assert.equal(used.useCount, 1);
  assert.equal(used.successCount, 1);
});

test("RUN_EVENT lesson validation must exist and come from an independent run", () => {
  const { root, artifactDir } = fixture();
  runLearningPhase(root, artifactDir);
  const candidate = listLessons(root, { status: "CANDIDATE" })[0];
  const sourceEvent = JSON.parse(
    readFileSync(join(artifactDir, "events.jsonl"), "utf8").trim().split(/\r?\n/)[0],
  );
  assert.throws(
    () => validateLesson(root, candidate.id, {
      type: "RUN_EVENT",
      source: `event:${sourceEvent.eventId}`,
    }),
    (error) => error instanceof LearningError &&
      error.code === "LESSON_RUN_EVENT_NOT_INDEPENDENT",
  );

  const independentDir = join(root, ".orchestration", "independent-run");
  mkdirSync(independentDir, { recursive: true });
  writeFileSync(join(independentDir, "tasks-classification.md"), "# Tasks\n", "utf8");
  writeFileSync(join(independentDir, "waves.md"), "# Waves\n", "utf8");
  initRun({
    projectRoot: root,
    artifactDir: independentDir,
    slug: "independent-run",
    runId: "independent-run-001",
  });
  const independentEvent = JSON.parse(
    readFileSync(join(independentDir, "events.jsonl"), "utf8").trim().split(/\r?\n/)[0],
  );
  const validated = validateLesson(root, candidate.id, {
    type: "RUN_EVENT",
    source: `event:${independentEvent.eventId}`,
  });
  assert.equal(validated.status, "VALIDATED");
  assert.equal(validated.validationEvidence.runId, "independent-run-001");
});

test("Curator quarantines deterministic trigger contradictions before matching", () => {
  const { root, artifactDir } = fixture();
  runLearningPhase(root, artifactDir);
  const lesson = listLessons(root)[0];
  validateLesson(root, lesson.id, { type: "USER", source: "approved" });
  promoteLessonToRecipe(root, lesson.id, { recipeId: "nuget-sandbox" });
  const { db } = openKnowledgeStore(root);
  try {
    db.prepare(`
      INSERT INTO recipes(
        id, version, status, pinned, confidence, trigger_json, action_json,
        reason, source_run, evidence_json, use_count, success_count,
        failure_count, created_at, updated_at, last_used_at, archived_at, needs_review
      )
      SELECT 'nuget-conflicting', version, status, pinned, confidence, trigger_json,
        '{"classify":"FAILED","retries":1}', reason, source_run, evidence_json,
        use_count, success_count, failure_count, created_at, updated_at,
        last_used_at, archived_at, 0
      FROM recipes WHERE id='nuget-sandbox'
    `).run();
  } finally {
    db.close();
  }
  const preview = curatorStatus(root);
  assert.equal(preview.counts.contradictions, 1);
  const applied = curateKnowledge(root, { dryRun: false });
  assert.equal(applied.contradictionIds.length, 2);
  assert.equal(curatorStatus(root).counts.needsReview, 2);
  assert.deepEqual(matchRecipes(root, { error: "NU1301", executor: "codex" }), []);
});

test("Curator is dry-run by default, respects pinning, archives without deletion and can rollback", () => {
  const { root, artifactDir } = fixture();
  runLearningPhase(root, artifactDir);
  const lesson = listLessons(root)[0];
  validateLesson(root, lesson.id, { type: "USER", source: "approved" });
  promoteLessonToRecipe(root, lesson.id, { recipeId: "nuget-sandbox", now: "2026-01-01T00:00:00.000Z" });
  setRecipePinned(root, "nuget-sandbox", true, { now: "2026-01-01T00:00:00.000Z" });

  const dry = curateKnowledge(root, {
    now: "2027-01-01T00:00:00.000Z",
    staleDays: 30,
    archiveDays: 60,
  });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.transitions.length, 0);
  assert.equal(listRecipes(root)[0].status, "ACTIVE");

  setRecipePinned(root, "nuget-sandbox", false, { now: "2026-01-01T00:00:00.000Z" });
  const stale = curateKnowledge(root, {
    dryRun: false,
    now: "2027-01-01T00:00:00.000Z",
    staleDays: 30,
    archiveDays: 60,
  });
  assert.ok(stale.backup.id);
  assert.equal(listRecipes(root)[0].status, "STALE");
  const stableBackup = createKnowledgeBackup(root, { reason: "before-archive" });
  curateKnowledge(root, {
    dryRun: false,
    now: "2028-01-01T00:00:00.000Z",
    staleDays: 30,
    archiveDays: 60,
  });
  assert.equal(listRecipes(root)[0].status, "ARCHIVED");
  assert.equal(existsSync(join(projectKnowledgePaths(root).archiveDir, "nuget-sandbox.md")), true);

  const preview = rollbackKnowledge(root, stableBackup.id);
  assert.equal(preview.dryRun, true);
  rollbackKnowledge(root, stableBackup.id, { dryRun: false, now: "2028-01-02T00:00:00.000Z" });
  assert.equal(listRecipes(root)[0].status, "STALE");
  assert.equal(existsSync(join(projectKnowledgePaths(root).learnedDir, "nuget-sandbox.md")), true);
  assert.equal(curatorStatus(root).counts.total, 1);
});
