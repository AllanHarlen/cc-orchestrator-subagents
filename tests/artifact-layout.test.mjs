import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  ARTIFACT_LAYOUT_VERSION,
  artifactRelativePath,
  artifactTreeRelativePath,
  detectArtifactLayout,
  resolveArtifact,
} from "../skills/orchestrator-multi-agent-development/scripts/lib/artifact-layout.mjs";
import {
  auditRunCompletion,
  initRun,
  loadRun,
  updateCompletionGate,
} from "../skills/orchestrator-multi-agent-development/scripts/lib/orchestration-state.mjs";

const roots = [];

const CLASSIFICATION = [
  "# Classificacao",
  "",
  "## BE-01 - Endpoint de usuarios",
  "- categoria: `BACKEND_ONLY`",
  "- assignedAgent: `codex:codex-rescue`",
  "- expectedFiles: `backend/src/Api/Users/UsersController.cs`",
  "- validationPlan: `dotnet build`",
].join("\n");

const WAVES = "# Waves\n\n## Wave 1\n- BE-01\n";

function fixture({ plan = "v2" } = {}) {
  const root = mkdtempSync(join(process.cwd(), ".tmp-layout-test-"));
  roots.push(root);
  const artifactDir = join(root, ".orchestration", "layout-run");
  const planDir = plan === "v2" ? join(artifactDir, "plan") : artifactDir;
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(planDir, "tasks-classification.md"), CLASSIFICATION, "utf8");
  writeFileSync(join(planDir, "waves.md"), WAVES, "utf8");
  initRun({ projectRoot: root, artifactDir, slug: "layout-run", runId: "layout-run-001" });
  return { root, artifactDir };
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("a new run declares layout 2 and keeps run identity at the directory root", () => {
  const { artifactDir } = fixture();
  const state = loadRun(artifactDir).state;

  assert.equal(state.layoutVersion, ARTIFACT_LAYOUT_VERSION);
  assert.equal(existsSync(join(artifactDir, "state.json")), true);
  assert.equal(existsSync(join(artifactDir, "events.jsonl")), true);
  for (const directory of ["plan", "contracts", "run", "review", "report", "evidence", "learning"]) {
    assert.equal(existsSync(join(artifactDir, directory)), true, `${directory}/ deve existir`);
  }
});

test("the plan directory is the parsed source of tasks and waves in layout 2", () => {
  const { artifactDir } = fixture();
  const state = loadRun(artifactDir).state;

  assert.equal(state.tasks["BE-01"].category, "BACKEND_ONLY");
  assert.equal(state.currentWave, 1);
  assert.equal(state.sync.sources.classification, "plan/tasks-classification.md");
  assert.equal(state.sync.sources.waves, "plan/waves.md");
});

test("a plan left at the run root stays readable and is reported at its real path", () => {
  const { artifactDir } = fixture({ plan: "v1" });
  const state = loadRun(artifactDir).state;

  assert.equal(state.tasks["BE-01"].category, "BACKEND_ONLY");
  assert.equal(state.sync.sources.classification, "tasks-classification.md");
  assert.equal(state.sync.sources.waves, "waves.md");
});

test("gate and audit artifact resolution follows the layout that actually holds the file", () => {
  const { artifactDir } = fixture();

  writeFileSync(join(artifactDir, "review", "review-final.md"), "# Review\nAPROVADO\n", "utf8");
  const gate = updateCompletionGate(artifactDir, "backendReview", "DONE").state
    .completionGates.backendReview;
  assert.ok(
    gate.evidence.includes("file:review/review-final.md"),
    `evidencia do gate deveria apontar review/: ${gate.evidence.join(", ")}`,
  );

  // Um artefato deixado na raiz continua satisfazendo o gate correspondente.
  writeFileSync(join(artifactDir, "workflow-log.md"), "# Log\n", "utf8");
  writeFileSync(join(artifactDir, "report", "subagents-context.md"), "# Ctx\n", "utf8");
  writeFileSync(join(artifactDir, "report", "implementation-report.md"), "# Impl\n", "utf8");
  const reports = updateCompletionGate(artifactDir, "reports", "DONE").state
    .completionGates.reports;
  assert.ok(reports.evidence.includes("file:workflow-log.md"));
  assert.ok(reports.evidence.includes("file:report/implementation-report.md"));

  const audit = auditRunCompletion(artifactDir);
  assert.ok(
    audit.missingArtifacts.includes("handoff.json"),
    "handoff.json ausente nos dois layouts deve continuar faltando",
  );
  assert.equal(audit.missingArtifacts.includes("workflow-log.md"), false);
  assert.equal(audit.missingArtifacts.includes("implementation-report.md"), false);
});

test("layout mapping and detection are explicit about which version they describe", () => {
  assert.equal(artifactRelativePath("review-final.md", 2), "review/review-final.md");
  assert.equal(artifactRelativePath("requirements-evidence.json", 2), "review/requirements-evidence.json");
  assert.equal(artifactRelativePath("review-final.md", 1), "review-final.md");
  assert.equal(artifactRelativePath("state.json", 2), "state.json");
  assert.equal(artifactRelativePath("events.jsonl", 2), "events.jsonl");
  assert.equal(artifactTreeRelativePath("executor-results", 2), "run/executor-results");
  assert.equal(artifactTreeRelativePath("executor-results", 1), "executor-results");

  const probe = mkdtempSync(join(process.cwd(), ".tmp-layout-probe-"));
  roots.push(probe);
  assert.equal(detectArtifactLayout(probe), 2, "diretorio novo usa o layout corrente");
  writeFileSync(join(probe, "events.jsonl"), "", "utf8");
  assert.equal(
    detectArtifactLayout(probe),
    1,
    "run em andamento sem snapshot legivel nao e reorganizada",
  );
  writeFileSync(join(probe, "state.json"), JSON.stringify({ runId: "x" }), "utf8");
  assert.equal(detectArtifactLayout(probe), 1, "snapshot sem layoutVersion e layout 1");
  writeFileSync(join(probe, "state.json"), JSON.stringify({ runId: "x", layoutVersion: 2 }), "utf8");
  assert.equal(detectArtifactLayout(probe), 2);
});

test("an artifact already written in the legacy place is not duplicated by the new layout", () => {
  const { artifactDir } = fixture();
  writeFileSync(join(artifactDir, "monitoring.md"), "# Monitoring\n", "utf8");

  const resolved = resolveArtifact(artifactDir, "monitoring.md");
  assert.equal(resolved.relativePath, "monitoring.md");
  assert.equal(existsSync(join(artifactDir, "run", "monitoring.md")), false);
});
