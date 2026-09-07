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

test("N/A on phase 9.5 (browserE2E, waivable) requires a reason but otherwise succeeds", () => {
  const { root, artifactDir } = fixture();
  for (const phase of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    updatePhase(artifactDir, phase, "DONE", { projectRoot: root, evidence: `t${phase}` });
  }
  assert.throws(
    () => updatePhase(artifactDir, 9.5, "N/A", { projectRoot: root }),
    (error) => error instanceof OrchestrationStateError && error.code === "PHASE_WAIVER_REQUIRES_REASON",
  );
  const result = updatePhase(artifactDir, 9.5, "N/A", {
    projectRoot: root,
    reason: "no separate front-end deploy",
  });
  assert.equal(result.state.phaseHistory["9.5"].status, "N/A");
  assert.equal(result.state.completionGates.browserE2E.status, "N/A");
  assert.equal(result.state.completionGates.browserE2E.required, false);
});

test("N/A is rejected on a phase whose gate is not waivable", () => {
  const { root, artifactDir } = fixture();
  for (const phase of [1, 2, 3, 4, 5, 6, 7]) {
    updatePhase(artifactDir, phase, "DONE", { projectRoot: root, evidence: `t${phase}` });
  }
  assert.throws(
    () => updatePhase(artifactDir, 8, "N/A", { projectRoot: root, reason: "skip review" }),
    (error) => error instanceof OrchestrationStateError && error.code === "PHASE_NOT_WAIVABLE",
  );
});

test("an N/A phase counts as closed for a later phase's predecessor check", () => {
  const { root, artifactDir } = fixture();
  for (const phase of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    updatePhase(artifactDir, phase, "DONE", { projectRoot: root, evidence: `t${phase}` });
  }
  updatePhase(artifactDir, 9.5, "N/A", { projectRoot: root, reason: "no separate deploy" });
  // Nao deve lancar: 9.5 fechado como N/A conta como predecessor fechado.
  const result = updatePhase(artifactDir, 10, "DONE", { projectRoot: root, evidence: "t10" });
  assert.equal(result.state.lastSafePhase, 10);
});

test("re-entering a DONE-and-past phase reopens later DONE phases and their gates (Achado 5)", () => {
  const { root, artifactDir } = fixture();
  for (const phase of [1, 2, 3, 4, 5, 6, 7]) {
    updatePhase(artifactDir, phase, "DONE", { projectRoot: root, evidence: `t${phase}` });
  }
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
/* Delegacao de gate ao Testador (secao 2.6)                                   */
/* -------------------------------------------------------------------------- */

function closeThroughPhase9(root, artifactDir) {
  for (const phase of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    updatePhase(artifactDir, phase, "DONE", { projectRoot: root, evidence: `t${phase}` });
  }
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

test("a valid delegation (matching nextStage.consumer) does not block completion", () => {
  const { root, artifactDir } = fixture();
  closeThroughPhase9(root, artifactDir);
  updateCompletionGate(artifactDir, "browserE2E", "N/A", {
    projectRoot: root,
    required: false,
    reason: "PENSADOR_CHAIN_DELEGATED_TO_TESTADOR",
    delegatedTo: "cc-testador-subagents",
  });
  updatePhase(artifactDir, 9.5, "N/A", {
    projectRoot: root,
    reason: "PENSADOR_CHAIN_DELEGATED_TO_TESTADOR",
  });
  for (const name of [
    "workflow-log.md",
    "subagents-context.md",
    "implementation-report.md",
    "learning-report.md",
  ]) {
    writeFileSync(join(artifactDir, name), `# ${name}\n`, "utf8");
  }
  writeFileSync(
    join(artifactDir, "handoff.json"),
    JSON.stringify({ nextStage: { consumer: "cc-testador-subagents", entrypoint: "/testador" } }),
    "utf8",
  );
  sweepStalledTasks(artifactDir, { projectRoot: root });
  for (const gateId of ["monitoring", "backendReview", "frontendReview", "reports", "handoff", "delivery", "learning"]) {
    updateCompletionGate(artifactDir, gateId, "DONE", { projectRoot: root, evidence: [`${gateId}:PASS`] });
  }
  updatePhase(artifactDir, 10, "DONE", { projectRoot: root, evidence: "t10" });
  updatePhase(artifactDir, 11, "DONE", { projectRoot: root, evidence: "t11" });
  updatePhase(artifactDir, 12, "DONE", { projectRoot: root, evidence: "t12" });

  const audit = auditRunCompletion(artifactDir);
  assert.equal(audit.waivedGates.length, 0);
  assert.equal(audit.delegatedGates.length, 1);
  assert.equal(audit.delegatedGates[0].id, "browserE2E");
  assert.equal(audit.delegatedGates[0].valid, true);
  assert.equal(audit.invalidDelegations.length, 0);
});

test("a delegation whose handoff.json points elsewhere is invalid and blocks completion (DELEGATION_WITHOUT_NEXT_STAGE)", () => {
  const { root, artifactDir } = fixture();
  closeThroughPhase9(root, artifactDir);
  updateCompletionGate(artifactDir, "browserE2E", "N/A", {
    projectRoot: root,
    required: false,
    reason: "PENSADOR_CHAIN_DELEGATED_TO_TESTADOR",
    delegatedTo: "cc-testador-subagents",
  });
  updatePhase(artifactDir, 9.5, "N/A", {
    projectRoot: root,
    reason: "PENSADOR_CHAIN_DELEGATED_TO_TESTADOR",
  });
  // Testador nao esta instalado -> nextStage degradou para o Executor.
  writeFileSync(
    join(artifactDir, "handoff.json"),
    JSON.stringify({ nextStage: { consumer: "cc-executor-subagents", entrypoint: "/executor" } }),
    "utf8",
  );

  const audit = auditRunCompletion(artifactDir);
  assert.equal(audit.invalidDelegations.length, 1);
  assert.equal(audit.invalidDelegations[0].id, "browserE2E");
  assert.equal(audit.invalidDelegations[0].code, "DELEGATION_WITHOUT_NEXT_STAGE");
  assert.equal(audit.complete, false);
});

test("a delegation with no handoff.json at all is also invalid (fails closed)", () => {
  const { root, artifactDir } = fixture();
  closeThroughPhase9(root, artifactDir);
  updateCompletionGate(artifactDir, "browserE2E", "N/A", {
    projectRoot: root,
    required: false,
    reason: "PENSADOR_CHAIN_DELEGATED_TO_TESTADOR",
    delegatedTo: "cc-testador-subagents",
  });
  const audit = auditRunCompletion(artifactDir);
  assert.equal(audit.invalidDelegations.length, 1);
  assert.equal(audit.complete, false);
});
