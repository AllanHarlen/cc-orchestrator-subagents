/**
 * Gaps from the OficinaAI run audit (2026-09), each pinned by a test:
 *  - requirementsCoverage closed DONE on the mere existence of requirements-evidence.json;
 *  - a review gate closed with a REPROVADO report, or before the corrected code was reviewed again;
 *  - phase 5 / task dispatch started before phase 4 closed;
 *  - resume listed recommendations for tasks that were already DONE;
 *  - the OpenAPI contract was never validated against the running API;
 *  - every watch tick wrote events and replayed the whole log.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  OrchestrationStateError,
  initRun,
  loadRun,
  reconcileRunAtDirectory,
  reviewVerdict,
  sweepStalledTasks,
  updateCompletionGate,
  updatePhase,
  updateTaskStatus,
} from "../skills/orchestrator-multi-agent-development/scripts/lib/orchestration-state.mjs";
import { tickLifecycle } from "../skills/orchestrator-multi-agent-development/scripts/lib/lifecycle-manager.mjs";
import { approveReview } from "./helpers/review-report.mjs";

const roots = [];
test.after(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture({ requirementIds = true } = {}) {
  const root = mkdtempSync(join(process.cwd(), ".tmp-audit-gaps-"));
  roots.push(root);
  const artifactDir = join(root, ".orchestration", "demo-run");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, "tasks-classification.md"), [
    "# Tasks",
    "",
    "## BE-01 - Backend endpoint",
    "- category: BACKEND_ONLY",
    "- assignedAgent: codex:codex-rescue",
    "- expectedFiles: `src/output.txt`",
    ...(requirementIds ? ["- requirementIds: RF-01, RNF-02"] : []),
  ].join("\n"), "utf8");
  writeFileSync(join(artifactDir, "waves.md"), "# Waves\n\n## Wave 1\n- BE-01\n", "utf8");
  initRun({ projectRoot: root, artifactDir, slug: "demo-run", runId: `run-${Math.random().toString(36).slice(2)}` });
  return { root, artifactDir };
}

function completeBackendTask(root, artifactDir, now) {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "output.txt"), "ok\n", "utf8");
  updateTaskStatus(artifactDir, "BE-01", "RUNNING", { projectRoot: root, now });
  updateTaskStatus(artifactDir, "BE-01", "DONE", { projectRoot: root, now, evidence: ["executor:BE-01:DONE"] });
}

const code = (expected) => (error) => error instanceof OrchestrationStateError && error.code === expected;

function writeIndex(artifactDir, index) {
  mkdirSync(join(artifactDir, "plan"), { recursive: true });
  writeFileSync(join(artifactDir, "plan", "requirements-index.json"), JSON.stringify({ schemaVersion: 1, ...index }), "utf8");
}

function writeEvidence(artifactDir, requirements) {
  mkdirSync(join(artifactDir, "review"), { recursive: true });
  writeFileSync(join(artifactDir, "review", "requirements-evidence.json"), JSON.stringify({ schemaVersion: 1, requirements }), "utf8");
}

const pass = (id, kind = "code") => ({ id, status: "PASS", evidence: [{ kind, ref: `src/output.txt#${id}` }] });

test("requirementsCoverage refuses DONE until every indexed id and every linked CA has PASS evidence", () => {
  const { root, artifactDir } = fixture();
  writeIndex(artifactDir, {
    requirements: [{ id: "RF-01" }],
    acceptanceCriteria: [{ id: "CA-01", requirementId: "RF-01" }, { id: "CA-02", requirementIds: ["RF-01"] }],
    nonFunctionalRequirements: [{ id: "RNF-02", category: "Desempenho", text: "p95 < 500 ms" }],
    architecturePatterns: [{ id: "ARC-01", pattern: "Repository + UnitOfWork" }],
  });
  // Only CA-01 for RF-01, and ARC-01 (indexed, never claimed by a task) is missing.
  writeEvidence(artifactDir, [
    { requirementId: "RF-01", acceptanceCriteria: [pass("CA-01")], findings: [] },
    { requirementId: "RNF-02", acceptanceCriteria: [pass("RNF-02-VERIFICADO", "test")], findings: [] },
  ]);
  assert.throws(() => updateCompletionGate(artifactDir, "requirementsCoverage", "DONE", { projectRoot: root }), (error) => {
    assert.equal(error.code, "REQUIREMENTS_EVIDENCE_BLOCKED");
    assert.deepEqual(error.details.missingAcceptanceCriteria, [{ requirementId: "RF-01", missing: ["CA-02"] }]);
    assert.deepEqual(error.details.missingRequirementIds, ["ARC-01"]);
    return true;
  });

  writeEvidence(artifactDir, [
    { requirementId: "RF-01", acceptanceCriteria: [pass("CA-01"), pass("CA-02")], findings: [] },
    { requirementId: "RNF-02", acceptanceCriteria: [pass("RNF-02-VERIFICADO", "test")], findings: [] },
    { requirementId: "ARC-01", acceptanceCriteria: [pass("ARC-01-VERIFICADO")], findings: [] },
  ]);
  const closed = updateCompletionGate(artifactDir, "requirementsCoverage", "DONE", { projectRoot: root });
  assert.equal(closed.state.completionGates.requirementsCoverage.status, "DONE");
});

test("a security/privacy/tenant-isolation RNF needs test evidence, not only a code reference", () => {
  const { root, artifactDir } = fixture();
  writeIndex(artifactDir, {
    requirements: [{ id: "RF-01" }],
    acceptanceCriteria: [],
    nonFunctionalRequirements: [{ id: "RNF-02", category: "Segurança", text: "Isolamento por tenant (RLS)" }],
    architecturePatterns: [],
  });
  writeEvidence(artifactDir, [
    { requirementId: "RF-01", acceptanceCriteria: [pass("CA-01")], findings: [] },
    { requirementId: "RNF-02", acceptanceCriteria: [pass("RNF-02-VERIFICADO", "code")], findings: [] },
  ]);
  assert.throws(() => updateCompletionGate(artifactDir, "requirementsCoverage", "DONE", { projectRoot: root }), (error) => {
    assert.deepEqual(error.details.untestedCriticalRequirements, ["RNF-02"]);
    return true;
  });
});

test("review gates close only on an approving verdict newer than every task of their scope", () => {
  assert.equal(reviewVerdict("... achados ...\nDecisao: REPROVADO\n\nApos correcoes: APROVADO_COM_RESSALVAS"), "APROVADO_COM_RESSALVAS");
  assert.equal(reviewVerdict("sem decisao"), null);

  const { root, artifactDir } = fixture({ requirementIds: false });
  completeBackendTask(root, artifactDir, new Date().toISOString());
  assert.throws(() => updateCompletionGate(artifactDir, "backendReview", "DONE", { projectRoot: root }), code("REVIEW_REPORT_MISSING"));

  const report = approveReview(artifactDir, "backendReview", "REPROVADO");
  assert.throws(() => updateCompletionGate(artifactDir, "backendReview", "DONE", { projectRoot: root }), code("REVIEW_REPROVED"));

  writeFileSync(report, "# Review\n\nsem decisao final\n", "utf8");
  assert.throws(() => updateCompletionGate(artifactDir, "backendReview", "DONE", { projectRoot: root }), code("REVIEW_VERDICT_MISSING"));

  // An approval written BEFORE the (corrected) task finished is stale.
  approveReview(artifactDir, "backendReview");
  const past = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(report, past, past);
  assert.throws(() => updateCompletionGate(artifactDir, "backendReview", "DONE", { projectRoot: root }), code("REVIEW_STALE"));

  approveReview(artifactDir, "backendReview");
  assert.equal(updateCompletionGate(artifactDir, "backendReview", "DONE", { projectRoot: root }).state.completionGates.backendReview.status, "DONE");
});

test("task dispatch and phase 5+ wait for phases 1-4 once the run tracks its phases", () => {
  const { root, artifactDir } = fixture({ requirementIds: false });
  updatePhase(artifactDir, 1, "DONE", { projectRoot: root, evidence: "test:1" });
  updatePhase(artifactDir, 2, "RUNNING", { projectRoot: root });
  assert.throws(() => updateTaskStatus(artifactDir, "BE-01", "RUNNING", { projectRoot: root }), code("TASK_DISPATCH_BEFORE_PHASE_4"));
  assert.throws(() => updatePhase(artifactDir, 5, "RUNNING", { projectRoot: root }), code("PHASE_PREREQUISITES_OPEN"));

  for (const phase of [2, 3]) updatePhase(artifactDir, phase, "DONE", { projectRoot: root, evidence: `test:${phase}` });
  updatePhase(artifactDir, 4, "DONE", { projectRoot: root, evidence: "test:4" });
  updatePhase(artifactDir, 5, "RUNNING", { projectRoot: root });
  assert.equal(updateTaskStatus(artifactDir, "BE-01", "RUNNING", { projectRoot: root }).task.status, "RUNNING");
});

test("reconciliation does not re-list recommendations for tasks that are already DONE", () => {
  const { root, artifactDir } = fixture({ requirementIds: false });
  const start = Date.now();
  updateTaskStatus(artifactDir, "BE-01", "RUNNING", { projectRoot: root, now: new Date(start).toISOString() });
  sweepStalledTasks(artifactDir, { projectRoot: root, now: new Date(start + 600_000).toISOString(), staleIdleSeconds: 450 });
  const stalled = reconcileRunAtDirectory(artifactDir, { projectRoot: root, now: new Date(start + 601_000).toISOString() });
  assert.ok(stalled.report.recommendations.some((item) => item.taskId === "BE-01"));

  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "output.txt"), "ok\n", "utf8");
  updateTaskStatus(artifactDir, "BE-01", "RUNNING", { projectRoot: root, now: new Date(start + 602_000).toISOString() });
  updateTaskStatus(artifactDir, "BE-01", "DONE", { projectRoot: root, now: new Date(start + 603_000).toISOString(), evidence: ["executor:BE-01:DONE"] });
  const after = reconcileRunAtDirectory(artifactDir, { projectRoot: root, now: new Date(start + 604_000).toISOString() });
  assert.deepEqual(after.report.recommendations.filter((item) => item.taskId === "BE-01"), []);
});

test("apiContractValidation: N/A only with a listed reason, DONE only with fresh PASS evidence", () => {
  const { root, artifactDir } = fixture({ requirementIds: false });
  assert.throws(
    () => updateCompletionGate(artifactDir, "apiContractValidation", "N/A", { projectRoot: root, required: false, reason: "sem tempo" }),
    code("GATE_WAIVER_REASON_INVALID"),
  );
  assert.throws(() => updateCompletionGate(artifactDir, "apiContractValidation", "DONE", { projectRoot: root }), code("API_CONTRACT_VALIDATION_MISSING"));

  const contract = join(root, "contracts", "openapi.yaml");
  mkdirSync(join(root, "contracts"), { recursive: true });
  writeFileSync(contract, "openapi: 3.1.0\n", "utf8");
  const evidence = (over) => {
    mkdirSync(join(artifactDir, "evidence"), { recursive: true });
    writeFileSync(join(artifactDir, "evidence", "api-contract-validation.json"), JSON.stringify({
      kind: "api-contract-validation", schemaVersion: 1, status: "PASS", dryRun: false,
      contractAbsolutePath: contract, contractSha256: "0".repeat(64), ...over,
    }), "utf8");
  };
  evidence({ status: "FAILED" });
  assert.throws(() => updateCompletionGate(artifactDir, "apiContractValidation", "DONE", { projectRoot: root }), code("API_CONTRACT_VALIDATION_BLOCKED"));
  evidence({});
  assert.throws(() => updateCompletionGate(artifactDir, "apiContractValidation", "DONE", { projectRoot: root }), code("API_CONTRACT_VALIDATION_STALE"));
  const { createHash } = awaitCrypto();
  evidence({ contractSha256: createHash("sha256").update(readFileSync(contract)).digest("hex") });
  assert.equal(updateCompletionGate(artifactDir, "apiContractValidation", "DONE", { projectRoot: root }).state.completionGates.apiContractValidation.status, "DONE");

  const other = fixture({ requirementIds: false });
  const waived = updateCompletionGate(other.artifactDir, "apiContractValidation", "N/A", { projectRoot: other.root, required: false, reason: "NO_HTTP_API: worker sem endpoints" });
  assert.equal(waived.state.completionGates.apiContractValidation.status, "N/A");
});

function awaitCrypto() {
  // node:crypto loaded lazily to keep the imports above focused on the state machine.
  return globalThis.process.getBuiltinModule("node:crypto");
}

test("a quiet watch tick writes no event and skips the observability projections", () => {
  const { root, artifactDir } = fixture({ requirementIds: false });
  updateTaskStatus(artifactDir, "BE-01", "RUNNING", { projectRoot: root });
  const first = tickLifecycle(artifactDir, { projectRoot: root });
  const revision = loadRun(artifactDir).state.revision;
  const second = tickLifecycle(artifactDir, { projectRoot: root });
  assert.equal(first.quiet, false);
  assert.equal(second.quiet, true);
  assert.equal(second.observability.skipped, true);
  assert.equal(loadRun(artifactDir).state.revision, revision, "a quiet tick must not append events");
  assert.ok(loadRun(artifactDir).state.lifecycle.lastSweepAt, "the first sweep is still persisted (monitoring gate evidence)");
});
