import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  OrchestrationStateError,
  auditRunCompletion,
  initRun,
  loadRun,
  sweepStalledTasks,
  updateCompletionGate,
  updatePhase,
} from "../skills/orchestrator-multi-agent-development/scripts/lib/orchestration-state.mjs";

/**
 * Fixture with both a BACKEND_ONLY and a FRONTEND_ONLY task, so
 * frontendReview/visualAudit/browserE2E compute as `required: true` (see
 * `completionGateRequirements`) — needed to exercise the phase 9 gate below.
 */
function frontendFixture(slug = "phase-run-frontend") {
  const root = mkdtempSync(join(process.cwd(), ".tmp-phase-fe-test-"));
  roots.push(root);
  const artifactDir = join(root, ".orchestration", slug);
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    join(artifactDir, "tasks-classification.md"),
    ["# Tasks", "", "## BE-01 - Endpoint", "- category: BACKEND_ONLY", "", "## FE-01 - Screen", "- category: FRONTEND_ONLY"].join("\n"),
    "utf8",
  );
  writeFileSync(join(artifactDir, "waves.md"), "# Waves\n\n## Wave 1\n- BE-01\n\n## Wave 2\n- FE-01\n", "utf8");
  initRun({ projectRoot: root, artifactDir, slug, runId: `${slug}-001` });
  return { root, artifactDir };
}

/** Closes phases 1-8 (and their own required gates) legitimately, leaving phase 9 open. */
function closeThroughPhase8(root, artifactDir) {
  for (const phase of [1, 2, 3]) updatePhase(artifactDir, phase, "DONE", { projectRoot: root, evidence: `t${phase}` });
  writeFileSync(join(artifactDir, "design-materialization.json"), JSON.stringify({ status: "PASS", applied: true, findings: [] }), "utf8");
  updateCompletionGate(artifactDir, "visualMaterialization", "DONE", { projectRoot: root, evidence: ["file:design-materialization.json"] });
  writeFileSync(join(artifactDir, "evidence", "infra-smoke-test.json"), JSON.stringify({ kind: "infra-smoke-test", schemaVersion: 1, status: "PASS", applicable: true }), "utf8");
  updateCompletionGate(artifactDir, "infraSmokeTest", "DONE", { projectRoot: root });
  updatePhase(artifactDir, 4, "DONE", { projectRoot: root, evidence: "t4" });
  updatePhase(artifactDir, 5, "DONE", { projectRoot: root, evidence: "t5" });
  sweepStalledTasks(artifactDir, { projectRoot: root });
  updateCompletionGate(artifactDir, "monitoring", "DONE", { projectRoot: root, evidence: ["manual"] });
  updatePhase(artifactDir, 6, "DONE", { projectRoot: root, evidence: "t6" });
  updateCompletionGate(artifactDir, "backendReview", "DONE", { projectRoot: root, evidence: ["manual"] });
  updatePhase(artifactDir, 7, "DONE", { projectRoot: root, evidence: "t7" });
  updatePhase(artifactDir, 8, "DONE", { projectRoot: root, evidence: "t8" });
}

/**
 * Generic "close phases 1..maxPhase legitimately" helper: for every phase
 * whose own completion gate(s) are `required`, closes the gate via
 * `updateCompletionGate` (with whatever evidence that gate's own validation
 * demands) before calling `updatePhase(..., "DONE")` — mirrors how the
 * real workflow closes a gate, then the phase (see PHASE_GATE_NOT_DONE
 * below). Not-required gates (e.g. frontendReview on a backend-only
 * fixture) are left alone; `synchronizeCompletionGates` already carries
 * them to N/A. Replaces the pre-fix pattern of blindly looping
 * `updatePhase(phase, "DONE")`, which only worked because updatePhase used
 * to silently force every gate for that phase to DONE too (the exact bug
 * `PHASE_GATE_NOT_DONE`/the sync-loop guard above exist to close).
 */
function closePhasesThrough(root, artifactDir, maxPhase) {
  for (let phase = 1; phase <= maxPhase; phase += 1) {
    const required = (gateId) => loadRun(artifactDir).state.completionGates[gateId]?.required === true;
    if (phase === 4 && required("visualMaterialization")) {
      writeFileSync(join(artifactDir, "design-materialization.json"), JSON.stringify({ status: "PASS", applied: true, findings: [] }), "utf8");
      updateCompletionGate(artifactDir, "visualMaterialization", "DONE", { projectRoot: root, evidence: ["file:design-materialization.json"] });
    }
    if (phase === 4 && required("infraSmokeTest")) {
      writeFileSync(join(artifactDir, "evidence", "infra-smoke-test.json"), JSON.stringify({ kind: "infra-smoke-test", schemaVersion: 1, status: "PASS", applicable: true }), "utf8");
      updateCompletionGate(artifactDir, "infraSmokeTest", "DONE", { projectRoot: root });
    }
    if (phase === 6 && required("monitoring")) {
      sweepStalledTasks(artifactDir, { projectRoot: root });
      updateCompletionGate(artifactDir, "monitoring", "DONE", { projectRoot: root, evidence: ["manual"] });
    }
    if (phase === 8 && required("backendReview")) {
      updateCompletionGate(artifactDir, "backendReview", "DONE", { projectRoot: root, evidence: ["manual"] });
    }
    if (phase === 9) {
      if (required("frontendReview")) {
        updateCompletionGate(artifactDir, "frontendReview", "DONE", { projectRoot: root, evidence: ["manual"] });
      }
      if (required("visualAudit")) {
        writeFileSync(join(artifactDir, "desktop.png"), "fake-png", "utf8");
        writeFileSync(join(artifactDir, "mobile.png"), "fake-png", "utf8");
        writeFileSync(join(artifactDir, "ui-evidence.json"), JSON.stringify({
          routes: [{
            route: "/",
            requirementRef: "RF-1",
            browserAssertion: "home renders the hero heading",
            apiEvidence: { real: true },
            viewports: [
              { kind: "desktop", screenshot: "desktop.png" },
              { kind: "mobile", screenshot: "mobile.png" },
            ],
          }],
        }), "utf8");
        updateCompletionGate(artifactDir, "visualAudit", "DONE", { projectRoot: root, evidence: ["file:ui-evidence.json"] });
      }
    }
    updatePhase(artifactDir, phase, "DONE", { projectRoot: root, evidence: `t${phase}` });
  }
}

/**
 * Cobertura dedicada de `assertPhaseTransition`, da cascata de reabertura
 * (Achado 5) e da delegacao de gate ao Testador (secao 2.6 do plano de
 * ajustes derivado de analise-run-oficina-saas-20260905.md).
 *
 * Antes deste arquivo, a ordem de fase so era exercida indiretamente em
 * `orchestration-state.test.mjs` (os testes de resume). Aqui o alvo e a
 * propria `updatePhase`/`updateCompletionGate`/`auditRunCompletion`.
 */

const roots = [];

function fixture(slug = "phase-run") {
  const root = mkdtempSync(join(process.cwd(), ".tmp-phase-test-"));
  roots.push(root);
  const artifactDir = join(root, ".orchestration", slug);
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    join(artifactDir, "tasks-classification.md"),
    ["# Tasks", "", "## BE-01 - Endpoint", "- category: BACKEND_ONLY"].join("\n"),
    "utf8",
  );
  writeFileSync(join(artifactDir, "waves.md"), "# Waves\n\n## Wave 1\n- BE-01\n", "utf8");
  initRun({ projectRoot: root, artifactDir, slug, runId: `${slug}-001` });
  return { root, artifactDir };
}

test.afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

test("initRun persists a well-formed upstream and rejects a malformed one", () => {
  const root = mkdtempSync(join(process.cwd(), ".tmp-phase-test-"));
  roots.push(root);
  const artifactDir = join(root, ".orchestration", "joint-run");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    join(artifactDir, "tasks-classification.md"),
    ["# Tasks", "", "## BE-01 - Endpoint", "- category: BACKEND_ONLY"].join("\n"),
    "utf8",
  );
  writeFileSync(join(artifactDir, "waves.md"), "# Waves\n\n## Wave 1\n- BE-01\n", "utf8");

  const result = initRun({
    projectRoot: root,
    artifactDir,
    slug: "joint-run",
    runId: "joint-run-001",
    upstream: {
      stage: "pensador",
      slug: "oficina-saas",
      version: 1,
      handoffPath: ".pensador/oficina-saas-v1/handoff.json",
    },
  });
  assert.deepEqual(result.state.upstream, {
    stage: "pensador",
    slug: "oficina-saas",
    version: 1,
    handoffPath: ".pensador/oficina-saas-v1/handoff.json",
  });
  assert.deepEqual(loadRun(artifactDir).state.upstream, result.state.upstream);

  const artifactDir2 = join(root, ".orchestration", "joint-run-bad");
  mkdirSync(artifactDir2, { recursive: true });
  writeFileSync(
    join(artifactDir2, "tasks-classification.md"),
    ["# Tasks", "", "## BE-01 - Endpoint", "- category: BACKEND_ONLY"].join("\n"),
    "utf8",
  );
  writeFileSync(join(artifactDir2, "waves.md"), "# Waves\n\n## Wave 1\n- BE-01\n", "utf8");
  assert.throws(
    () =>
      initRun({
        projectRoot: root,
        artifactDir: artifactDir2,
        slug: "joint-run-bad",
        runId: "joint-run-bad-001",
        upstream: { slug: "no-stage-field" },
      }),
    (error) => error instanceof OrchestrationStateError && error.code === "INVALID_UPSTREAM",
  );
});

test("initRun defaults upstream to null in independent mode", () => {
  const { artifactDir } = fixture("independent-run");
  assert.equal(loadRun(artifactDir).state.upstream, null);
});

test("updatePhase rejects a phase number outside PHASE_SEQUENCE", () => {
  const { root, artifactDir } = fixture();
  assert.throws(
    () => updatePhase(artifactDir, 4.5, "DONE", { projectRoot: root }),
    (error) => error instanceof OrchestrationStateError && error.code === "PHASE_NOT_IN_SEQUENCE",
  );
});

test("reproduces the analyzed run's jump: phase 7 DONE with 5 RUNNING and 6 never touched is rejected", () => {
  const { root, artifactDir } = fixture();
  updatePhase(artifactDir, 1, "DONE", { projectRoot: root, evidence: "t1" });
  updatePhase(artifactDir, 2, "DONE", { projectRoot: root, evidence: "t2" });
  updatePhase(artifactDir, 3, "DONE", { projectRoot: root, evidence: "t3" });
  updatePhase(artifactDir, 4, "DONE", { projectRoot: root, evidence: "t4" });
  updatePhase(artifactDir, 5, "RUNNING", { projectRoot: root });
  // Fase 6 nunca foi tocada — exatamente o que aconteceu na run analisada.
  assert.throws(
    () => updatePhase(artifactDir, 7, "DONE", { projectRoot: root, evidence: "t7" }),
    (error) =>
      error instanceof OrchestrationStateError &&
      error.code === "PHASE_PREDECESSOR_NOT_DONE" &&
      error.details.phase === 7 &&
      error.details.blockedBy.includes(5) &&
      error.details.blockedBy.includes(6),
  );
});

test("a phase cannot start RUNNING while an earlier predecessor is still RUNNING", () => {
  const { root, artifactDir } = fixture();
  updatePhase(artifactDir, 1, "RUNNING", { projectRoot: root });
  assert.throws(
    () => updatePhase(artifactDir, 2, "RUNNING", { projectRoot: root }),
    (error) => error instanceof OrchestrationStateError && error.code === "PHASE_PREDECESSOR_RUNNING",
  );
});

test("N/A on phase 9.5 is rejected because browser E2E is mandatory", () => {
  const { root, artifactDir } = fixture();
  closePhasesThrough(root, artifactDir, 9);
  assert.throws(
    () => updatePhase(artifactDir, 9.5, "N/A", { projectRoot: root, reason: "no separate front-end deploy" }),
    (error) => error instanceof OrchestrationStateError && error.code === "PHASE_NOT_WAIVABLE",
  );
});

test("N/A is rejected on a phase whose gate is not waivable", () => {
  const { root, artifactDir } = fixture();
  closePhasesThrough(root, artifactDir, 7);
  assert.throws(
    () => updatePhase(artifactDir, 8, "N/A", { projectRoot: root, reason: "skip review" }),
    (error) => error instanceof OrchestrationStateError && error.code === "PHASE_NOT_WAIVABLE",
  );
});

test("a completed phase 9.5 counts as closed for a later phase's predecessor check", () => {
  const { root, artifactDir } = fixture();
  closePhasesThrough(root, artifactDir, 9);
  updatePhase(artifactDir, 9.5, "DONE", { projectRoot: root, evidence: "browser-e2e:PASS" });
  // reports/handoff are phase 10's own gates (always required) — close them
  // for real so the assertion below is about the predecessor check this
  // test targets, not about phase 10's own PHASE_GATE_NOT_DONE.
  updateCompletionGate(artifactDir, "reports", "DONE", { projectRoot: root, evidence: ["manual"] });
  updateCompletionGate(artifactDir, "handoff", "DONE", { projectRoot: root, evidence: ["manual"] });
  // Nao deve lancar: 9.5 fechado como DONE conta como predecessor fechado.
  const result = updatePhase(artifactDir, 10, "DONE", { projectRoot: root, evidence: "t10" });
  assert.equal(result.state.lastSafePhase, 10);
});

test("re-entering a DONE-and-past phase reopens later DONE phases and their gates (Achado 5)", () => {
  const { root, artifactDir } = fixture();
  closePhasesThrough(root, artifactDir, 7);
  updateCompletionGate(artifactDir, "backendReview", "DONE", {
    projectRoot: root,
    evidence: ["review:PASS"],
  });
  updatePhase(artifactDir, 8, "DONE", { projectRoot: root, evidence: "t8" });
  updatePhase(artifactDir, 9, "DONE", { projectRoot: root, evidence: "t9" });

  let state = loadRun(artifactDir).state;
  assert.equal(state.phaseHistory["8"].status, "DONE");
  assert.equal(state.completionGates.backendReview.status, "DONE");

  // A Fase 9.5 encontrou um defeito de integracao real e forca a volta a 7.
  const reopened = updatePhase(artifactDir, 7, "RUNNING", { projectRoot: root });
  assert.equal(reopened.state.phaseHistory["8"].status, "PENDING");
  assert.equal(reopened.state.phaseHistory["9"].status, "PENDING");
  assert.equal(reopened.state.completionGates.backendReview.status, "PENDING");
  // lastSafePhase recua: 8 e 9 nao estao mais fechados.
  assert.equal(reopened.state.lastSafePhase, 6);

  // E o caminho de volta funciona de verdade: pode fechar 8 e 9 de novo.
  updateCompletionGate(artifactDir, "backendReview", "DONE", {
    projectRoot: root,
    evidence: ["review:PASS:2"],
  });
  updatePhase(artifactDir, 7, "DONE", { projectRoot: root, evidence: "t7-again" });
  updatePhase(artifactDir, 8, "DONE", { projectRoot: root, evidence: "t8-again" });
  state = loadRun(artifactDir).state;
  assert.equal(state.phaseHistory["8"].status, "DONE");
});

test("lastSafePhase never advances past a jump, only past a truly closed prefix", () => {
  const { root, artifactDir } = fixture();
  updatePhase(artifactDir, 1, "DONE", { projectRoot: root, evidence: "t1" });
  updatePhase(artifactDir, 2, "DONE", { projectRoot: root, evidence: "t2" });
  const result = updatePhase(artifactDir, 3, "RUNNING", { projectRoot: root });
  assert.equal(result.state.lastSafePhase, 2);
});

/* -------------------------------------------------------------------------- */
/* PHASE_GATE_NOT_DONE — phase close nao pode mais pisar num gate proprio     */
/* aberto (bug real: OficinaAI, 2026-09-12, visualAudit BLOCKED virou DONE    */
/* silenciosamente ao fechar a fase 9)                                        */
/* -------------------------------------------------------------------------- */

test("updatePhase refuses to close a phase DONE while its own gate is legitimately BLOCKED, and does not touch the gate", () => {
  const { root, artifactDir } = frontendFixture();
  closePhasesThrough(root, artifactDir, 8);
  updateCompletionGate(artifactDir, "frontendReview", "DONE", { projectRoot: root, evidence: ["manual"] });
  updateCompletionGate(artifactDir, "visualAudit", "BLOCKED", { projectRoot: root, reason: "VIEWPORT_MISSING: claude-in-chrome resize did not change the screenshot dimensions" });

  assert.throws(
    () => updatePhase(artifactDir, 9, "DONE", { projectRoot: root, evidence: "t9" }),
    (error) =>
      error instanceof OrchestrationStateError &&
      error.code === "PHASE_GATE_NOT_DONE" &&
      error.details.phase === 9 &&
      error.details.blockedBy.includes("visualAudit"),
  );

  // The exact regression: visualAudit must still read BLOCKED afterwards,
  // not have been silently overwritten to DONE by the phase-close attempt.
  const gate = loadRun(artifactDir).state.completionGates.visualAudit;
  assert.equal(gate.status, "BLOCKED");
  assert.equal(gate.reason, "VIEWPORT_MISSING: claude-in-chrome resize did not change the screenshot dimensions");
});

test("updatePhase succeeds once the phase's own gate is legitimately closed DONE", () => {
  const { root, artifactDir } = frontendFixture();
  closePhasesThrough(root, artifactDir, 9);
  const state = loadRun(artifactDir).state;
  assert.equal(state.completionGates.visualAudit.status, "DONE");
  assert.equal(state.completionGates.frontendReview.status, "DONE");
  assert.equal(state.phaseHistory["9"].status, "DONE");
});

test("updatePhase does not downgrade an already-DONE gate when the phase itself is later marked BLOCKED", () => {
  const { root, artifactDir } = frontendFixture();
  closePhasesThrough(root, artifactDir, 9);
  assert.equal(loadRun(artifactDir).state.completionGates.visualAudit.status, "DONE");

  updatePhase(artifactDir, 9, "BLOCKED", { projectRoot: root, reason: "unrelated integration defect found in 9.5" });
  // visualAudit itself was never re-opened or re-run; the phase going
  // BLOCKED for an unrelated reason must not silently downgrade it.
  assert.equal(loadRun(artifactDir).state.completionGates.visualAudit.status, "DONE");
});

/* -------------------------------------------------------------------------- */
/* Delegacao de gate ao Testador (secao 2.6)                                   */
/* -------------------------------------------------------------------------- */

function closeThroughPhase9(root, artifactDir) {
  closePhasesThrough(root, artifactDir, 9);
}

test("updateCompletionGate accepts delegatedTo only alongside N/A on a waivable gate", () => {
  const { root, artifactDir } = fixture();
  assert.throws(
    () =>
      updateCompletionGate(artifactDir, "browserE2E", "PENDING", {
        projectRoot: root,
        delegatedTo: "cc-testador-subagents",
      }),
    (error) => error instanceof OrchestrationStateError && error.code === "INVALID_GATE_DELEGATION",
  );
  assert.throws(
    () =>
      updateCompletionGate(artifactDir, "backendReview", "N/A", {
        projectRoot: root,
        required: false,
        reason: "x",
        delegatedTo: "cc-testador-subagents",
      }),
    (error) => error instanceof OrchestrationStateError && error.code === "GATE_APPLICABILITY_FIXED",
  );
});

test("updateCompletionGate refuses to close monitoring as DONE before any sweep ran", () => {
  const { root, artifactDir } = fixture();
  assert.throws(
    () =>
      updateCompletionGate(artifactDir, "monitoring", "DONE", {
        projectRoot: root,
        evidence: ["run/monitoring.md"],
      }),
    (error) => error instanceof OrchestrationStateError && error.code === "GATE_MONITORING_REQUIRES_SWEEP",
  );
  assert.equal(loadRun(artifactDir).state.lifecycle?.lastSweepAt, null);

  sweepStalledTasks(artifactDir, { projectRoot: root });
  const closed = updateCompletionGate(artifactDir, "monitoring", "DONE", {
    projectRoot: root,
    evidence: ["run/monitoring.md"],
  });
  assert.equal(closed.state.completionGates.monitoring.status, "DONE");
});

test("browser E2E cannot be delegated as N/A", () => {
  const { root, artifactDir } = fixture();
  closeThroughPhase9(root, artifactDir);
  assert.throws(
    () => updateCompletionGate(artifactDir, "browserE2E", "N/A", {
      projectRoot: root,
      required: false,
      reason: "PENSADOR_CHAIN_DELEGATED_TO_TESTADOR",
      delegatedTo: "cc-testador-subagents",
    }),
    (error) => error instanceof OrchestrationStateError && error.code === "GATE_APPLICABILITY_FIXED",
  );
});

test("browser E2E refuses delegation even when a downstream handoff exists", () => {
  const { root, artifactDir } = fixture();
  closeThroughPhase9(root, artifactDir);
  writeFileSync(
    join(artifactDir, "handoff.json"),
    JSON.stringify({ nextStage: { consumer: "cc-executor-subagents", entrypoint: "/executor" } }),
    "utf8",
  );

  assert.throws(
    () => updateCompletionGate(artifactDir, "browserE2E", "N/A", { projectRoot: root, required: false, reason: "delegated", delegatedTo: "cc-testador-subagents" }),
    (error) => error instanceof OrchestrationStateError && error.code === "GATE_APPLICABILITY_FIXED",
  );
});

test("browser E2E refuses delegation with no handoff", () => {
  const { root, artifactDir } = fixture();
  closeThroughPhase9(root, artifactDir);
  assert.throws(
    () => updateCompletionGate(artifactDir, "browserE2E", "N/A", { projectRoot: root, required: false, reason: "delegated", delegatedTo: "cc-testador-subagents" }),
    (error) => error instanceof OrchestrationStateError && error.code === "GATE_APPLICABILITY_FIXED",
  );
});
