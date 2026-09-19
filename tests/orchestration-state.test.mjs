import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  OrchestrationStateError,
  applyProjectConfigToRun,
  auditRunCompletion,
  findRunDirectory,
  heartbeatTask,
  initRun,
  loadRun,
  parseTaskArtifacts,
  requestRunCancellation,
  reconcileRunAtDirectory,
  resolveTaskScope,
  resumeRunAtDirectory,
  sweepStalledTasks,
  syncRunFromArtifacts,
  updateCompletionGate,
  updatePhase,
  updateRunStatus,
  updateTaskStatus,
  verifyRun,
} from "../skills/orchestrator-multi-agent-development/scripts/lib/orchestration-state.mjs";
import { writeProjectConfig } from "../skills/orchestrator-multi-agent-development/scripts/lib/project-config.mjs";

const temporaryRoots = [];

/** A handoff that passes validateHandoff(): the completion audit now rejects a hand-written `{}`. */
const VALID_HANDOFF = `${JSON.stringify({
  handoffVersion: 1,
  stage: "orchestrador",
  slug: "fixture",
  producer: { plugin: "cc-orchestrador-subagents", version: "4.21.0" },
  artifactRoot: ".orchestration/fixture",
  status: "DONE",
  createdAt: "2026-09-19T10:00:00.000Z",
  updatedAt: "2026-09-19T10:00:00.000Z",
  summary: "Implementacao completa, reviews aprovados, E2E verificado.",
  upstream: null,
  artifacts: [
    { role: "implementation-report", path: "implementation-report.md", required: true },
    { role: "review-final", path: "review-final.md", required: true },
  ],
  nextStage: { consumer: "cc-executor-subagents", entrypoint: "/executor", instructions: "Review plano-vs-entrega e ajustes finos." },
}, null, 2)}\n`;

function fixture(options = {}) {
  const root = mkdtempSync(join(process.cwd(), ".tmp-state-test-"));
  temporaryRoots.push(root);
  const artifactDir = join(root, ".orchestration", options.slug ?? "demo-run");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    join(artifactDir, "tasks-classification.md"),
    [
      "# Tasks",
      "",
      "## BE-01 - Backend endpoint",
      "- category: BACKEND_ONLY",
      "- assignedAgent: codex:codex-rescue",
      "- expectedFiles: `src/output.txt`",
      "",
      "## FE-01 - Frontend screen",
      "- category: FRONTEND_ONLY",
      "- assignedAgent: cc-antigravity-plugin:antigravity-coder",
      "- validationPlan: `npm run build`",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(artifactDir, "waves.md"),
    [
      "# Waves",
      "",
      "## Wave 1",
      "- BE-01",
      "",
      "## Wave 2",
      "- FE-01",
    ].join("\n"),
    "utf8",
  );
  return { root, artifactDir };
}

function writeExpectedBackendFile(root) {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "output.txt"), "done\n", "utf8");
}

function completeRun(root, artifactDir) {
  writeExpectedBackendFile(root);
  for (const taskId of ["BE-01", "FE-01"]) {
    updateTaskStatus(artifactDir, taskId, "RUNNING", { projectRoot: root });
    updateTaskStatus(artifactDir, taskId, "DONE", {
      projectRoot: root,
      evidence: [`executor:${taskId}:DONE`],
    });
  }
  for (const name of [
    "workflow-log.md",
    "subagents-context.md",
    "implementation-report.md",
    "handoff.json",
    "learning-report.md",
    "monitoring.md",
  ]) {
    writeFileSync(join(artifactDir, name), name === "handoff.json" ? VALID_HANDOFF : `# ${name}\n`, "utf8");
  }
  writeFileSync(join(artifactDir, "desktop.png"), "desktop", "utf8");
  writeFileSync(join(artifactDir, "mobile.png"), "mobile", "utf8");
  writeFileSync(join(artifactDir, "ui-evidence.json"), JSON.stringify({
    routes: [{
      route: "/", requirementRef: "RF-001", browserAssertion: "critical UI renders with API data",
      apiEvidence: { real: true, endpoint: "/api/home" },
      viewports: [{ kind: "desktop", screenshot: "desktop.png" }, { kind: "mobile", screenshot: "mobile.png" }],
    }],
    gates: {}, reviews: [],
  }), "utf8");
  writeFileSync(join(artifactDir, "design-materialization.json"), JSON.stringify({
    status: "PASS", applied: true, degraded: false, findings: [], operations: [],
  }), "utf8");
  writeFileSync(join(artifactDir, "evidence", "infra-smoke-test.json"), JSON.stringify({
    kind: "infra-smoke-test", schemaVersion: 1, status: "PASS", applicable: true, durationMs: 1,
  }), "utf8");
  // GATE_MONITORING_REQUIRES_SWEEP: fechar o gate monitoring exige que o
  // sweep de stall tenha rodado ao menos uma vez (lifecycle.lastSweepAt).
  sweepStalledTasks(artifactDir, { projectRoot: root });
  for (const gateId of [
    "monitoring",
    "visualMaterialization",
    "infraSmokeTest",
    "backendReview",
    "frontendReview",
    "browserE2E",
    "visualAudit",
    "reports",
    "handoff",
    "delivery",
    "learning",
  ]) {
    updateCompletionGate(artifactDir, gateId, "DONE", {
      projectRoot: root,
      evidence: [`test:${gateId}:PASS`],
    });
  }
  // assertPhaseTransition (Achado 1) exige que todo predecessor esteja fechado
  // antes de uma fase poder ser marcada DONE — percorra a sequencia inteira em
  // vez de saltar direto para a fase 12.
  for (const phase of [1, 2, 3, 4, 5, 6, 7, 8, 9, 9.5, 10, 11]) {
    updatePhase(artifactDir, phase, "DONE", {
      projectRoot: root,
      evidence: `test:phase:${phase}:DONE`,
    });
  }
  updatePhase(artifactDir, 12, "DONE", {
    projectRoot: root,
    evidence: "test:learning:PASS",
  });
}

function cleanup() {
  while (temporaryRoots.length > 0) {
    const target = temporaryRoots.pop();
    rmSync(target, { recursive: true, force: true });
  }
}

test.afterEach(cleanup);

test("browser E2E and fixed gates cannot be waived", () => {
  const { root, artifactDir } = fixture({ slug: "gate-applicability" });
  initRun({
    projectRoot: root,
    artifactDir,
    slug: "gate-applicability",
    runId: "gate-applicability-001",
  });
  assert.equal(loadRun(artifactDir).state.completionGates.browserE2E.required, true);
  assert.throws(
    () => updateCompletionGate(artifactDir, "backendReview", "N/A", {
      projectRoot: root,
      reason: "attempted fixed gate waiver",
    }),
    (error) => error instanceof OrchestrationStateError &&
      error.code === "REQUIRED_GATE_CANNOT_BE_SKIPPED",
  );
  assert.throws(
    () => updateCompletionGate(artifactDir, "browserE2E", "N/A", {
      projectRoot: root,
      reason: "attempted E2E waiver",
    }),
    (error) => error instanceof OrchestrationStateError && error.code === "REQUIRED_GATE_CANNOT_BE_SKIPPED",
  );
});

test("visualMaterialization is required whenever a FRONTEND_ONLY/FULLSTACK task exists, and DONE requires a PASS design-materialization.json", () => {
  const { root, artifactDir } = fixture({ slug: "visual-materialization" });
  initRun({
    projectRoot: root,
    artifactDir,
    slug: "visual-materialization",
    runId: "visual-materialization-001",
  });
  assert.equal(loadRun(artifactDir).state.completionGates.visualMaterialization.required, true);

  assert.throws(
    () => updateCompletionGate(artifactDir, "visualMaterialization", "DONE", {
      projectRoot: root,
      evidence: ["test:visualMaterialization:DONE"],
    }),
    (error) => error instanceof OrchestrationStateError && error.code === "DESIGN_MATERIALIZATION_MISSING",
    "closing DONE with no design-materialization.json at all must fail",
  );

  writeFileSync(join(artifactDir, "design-materialization.json"), "{not valid json", "utf8");
  assert.throws(
    () => updateCompletionGate(artifactDir, "visualMaterialization", "DONE", {
      projectRoot: root,
      evidence: ["test:visualMaterialization:DONE"],
    }),
    (error) => error instanceof OrchestrationStateError && error.code === "DESIGN_MATERIALIZATION_INVALID",
    "a malformed design-materialization.json must fail, not silently pass",
  );

  writeFileSync(join(artifactDir, "design-materialization.json"), JSON.stringify({
    status: "BLOCKED", applied: false, findings: [{ severity: "critical", code: "REQUIRED_ASSET_MISSING" }],
  }), "utf8");
  assert.throws(
    () => updateCompletionGate(artifactDir, "visualMaterialization", "DONE", {
      projectRoot: root,
      evidence: ["test:visualMaterialization:DONE"],
    }),
    (error) => error instanceof OrchestrationStateError && error.code === "DESIGN_MATERIALIZATION_BLOCKED",
    "a BLOCKED materialization report must not be allowed to close the gate DONE",
  );

  writeFileSync(join(artifactDir, "design-materialization.json"), JSON.stringify({
    status: "PASS", applied: true, findings: [], operations: [],
  }), "utf8");
  const closed = updateCompletionGate(artifactDir, "visualMaterialization", "DONE", {
    projectRoot: root,
    evidence: ["test:visualMaterialization:DONE"],
  });
  assert.equal(closed.state.completionGates.visualMaterialization.status, "DONE");
});

test("initialization creates a valid snapshot and write-ahead event log", () => {
  const { root, artifactDir } = fixture();
  const result = initRun({
    projectRoot: root,
    artifactDir,
    slug: "demo-run",
    runId: "demo-run-20260817-001",
    now: "2026-08-17T12:00:00.000Z",
  });

  assert.equal(result.created, true);
  assert.equal(result.state.revision, 1);
  assert.equal(result.state.tasks["BE-01"].status, "PENDING");
  assert.equal(result.state.tasks["BE-01"].executor, "codex");
  assert.deepEqual(result.state.waves[0], { id: 1, tasks: ["BE-01"] });
  assert.equal(existsSync(join(artifactDir, "state.json")), true);
  assert.equal(existsSync(join(artifactDir, "events.jsonl")), true);
  assert.equal(verifyRun(artifactDir).valid, true);
});

test("event replay repairs a missing snapshot after a simulated crash", () => {
  const { root, artifactDir } = fixture();
  initRun({ projectRoot: root, artifactDir, slug: "demo-run", runId: "run-replay" });
  updatePhase(artifactDir, 1, "DONE", { projectRoot: root });
  unlinkSync(join(artifactDir, "state.json"));

  const replayed = loadRun(artifactDir, { repairSnapshot: true });
  assert.equal(replayed.snapshotRecovered, true);
  assert.equal(replayed.state.phaseStatus, "DONE");
  assert.equal(replayed.state.revision, 2);
  assert.equal(existsSync(join(artifactDir, "state.json")), true);
  assert.equal(verifyRun(artifactDir).valid, true);
});

test("recovery discards an incomplete final event before appending new history", () => {
  const { root, artifactDir } = fixture();
  initRun({ projectRoot: root, artifactDir, slug: "demo-run", runId: "run-tail-repair" });
  const eventsPath = join(artifactDir, "events.jsonl");
  writeFileSync(eventsPath, '{"eventSchemaVersion":1', { encoding: "utf8", flag: "a" });

  assert.throws(
    () => verifyRun(artifactDir),
    (error) => error instanceof OrchestrationStateError && error.code === "TRUNCATED_EVENT_TAIL",
  );

  updatePhase(artifactDir, 1, "DONE", { projectRoot: root });

  const events = readFileSync(eventsPath, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(events.map((event) => event.revision), [1, 2]);
  assert.equal(verifyRun(artifactDir).valid, true);
});

test("semantic snapshot corruption is rebuilt from durable events", () => {
  const { root, artifactDir } = fixture();
  initRun({ projectRoot: root, artifactDir, slug: "demo-run", runId: "run-invalid-snapshot" });
  writeFileSync(join(artifactDir, "state.json"), '{"schemaVersion":999}\n', "utf8");

  const replayed = loadRun(artifactDir, { repairSnapshot: true });
  assert.equal(replayed.snapshotRecovered, true);
  assert.equal(replayed.state.runId, "run-invalid-snapshot");
  assert.equal(verifyRun(artifactDir).valid, true);
});

test("integrity verification detects valid JSON that diverges from event replay", () => {
  const { root, artifactDir } = fixture();
  initRun({ projectRoot: root, artifactDir, slug: "demo-run", runId: "run-diverged-snapshot" });
  const snapshotPath = join(artifactDir, "state.json");
  const tampered = JSON.parse(readFileSync(snapshotPath, "utf8"));
  tampered.tasks["BE-01"].title = "tampered but schema-valid";
  writeFileSync(snapshotPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");

  assert.throws(
    () => verifyRun(artifactDir),
    (error) => error instanceof OrchestrationStateError && error.code === "SNAPSHOT_DIVERGED",
  );

  const resumed = resumeRunAtDirectory(artifactDir, { projectRoot: root });
  assert.equal(resumed.state.tasks["BE-01"].title, "Backend endpoint");
  assert.equal(verifyRun(artifactDir).valid, true);
});

test("resume converts an interrupted RUNNING task to UNKNOWN, never FAILED", () => {
  const { root, artifactDir } = fixture();
  initRun({ projectRoot: root, artifactDir, slug: "demo-run", runId: "run-unknown" });
  updateTaskStatus(artifactDir, "BE-01", "RUNNING", {
    projectRoot: root,
    executor: "codex",
    sessionId: "codex-session-1",
    now: "2026-08-17T12:00:00.000Z",
  });

  const resumed = resumeRunAtDirectory(artifactDir, {
    projectRoot: root,
    now: "2026-08-17T12:10:00.000Z",
  });

  assert.deepEqual(resumed.unknownTasks, ["BE-01"]);
  assert.equal(resumed.state.tasks["BE-01"].status, "UNKNOWN");
  assert.equal(resumed.state.tasks["BE-01"].reasonCode, "OWNER_SESSION_INTERRUPTED");
  assert.equal(resumed.report.pendingExternalProbes[0].sessionId, "codex-session-1");
  assert.notEqual(resumed.state.tasks["BE-01"].status, "FAILED");
});

test("authoritative executor completion plus local evidence reconciles UNKNOWN to DONE", () => {
  const { root, artifactDir } = fixture();
  initRun({ projectRoot: root, artifactDir, slug: "demo-run", runId: "run-done" });
  updateTaskStatus(artifactDir, "BE-01", "RUNNING", {
    projectRoot: root,
    executor: "codex",
    sessionId: "codex-session-2",
  });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "output.txt"), "done\n", "utf8");
  const probeFile = join(artifactDir, "probe.json");
  writeFileSync(
    probeFile,
    JSON.stringify({
      tasks: {
        "BE-01": {
          executorStatus: "DONE",
          producedFiles: ["src/output.txt"],
          validations: [{ command: "fixture validation", status: "PASS" }],
        },
      },
    }),
    "utf8",
  );

  const resumed = resumeRunAtDirectory(artifactDir, { projectRoot: root, probeFile });
  assert.equal(resumed.state.tasks["BE-01"].status, "DONE");
  assert.equal(resumed.state.tasks["BE-01"].reconciliation.recommendation, "CONTINUE");
});

test("Git or file evidence without executor authority stays UNKNOWN", () => {
  const { root, artifactDir } = fixture();
  initRun({ projectRoot: root, artifactDir, slug: "demo-run", runId: "run-conservative" });
  updateTaskStatus(artifactDir, "BE-01", "RUNNING", { projectRoot: root, executor: "codex" });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "output.txt"), "partial\n", "utf8");

  const resumed = resumeRunAtDirectory(artifactDir, { projectRoot: root });
  const task = resumed.state.tasks["BE-01"];
  assert.equal(task.status, "UNKNOWN");
  assert.equal(task.reconciliation.recommendation, "VERIFY_BEFORE_REEXECUTE");
});

test("stall detection uses progress silence and heartbeat recovers during grace", () => {
  const { root, artifactDir } = fixture();
  initRun({ projectRoot: root, artifactDir, slug: "demo-run", runId: "run-stall" });
  updateTaskStatus(artifactDir, "BE-01", "RUNNING", {
    projectRoot: root,
    now: "2026-08-17T12:00:00.000Z",
  });

  const noProgress = heartbeatTask(artifactDir, "BE-01", {
    now: "2026-08-17T12:03:00.000Z",
  });
  assert.equal(noProgress.changed, false);
  assert.equal(noProgress.task.lastActivityAt, "2026-08-17T12:00:00.000Z");

  const swept = sweepStalledTasks(artifactDir, {
    projectRoot: root,
    now: "2026-08-17T12:07:31.000Z",
    staleIdleSeconds: 450,
    stallGraceSeconds: 120,
  });
  assert.deepEqual(swept.stalled, ["BE-01"]);
  assert.equal(swept.state.tasks["BE-01"].status, "STALLED");
  assert.equal(swept.state.tasks["BE-01"].stall.phase, "idle");

  const resumed = resumeRunAtDirectory(artifactDir, {
    projectRoot: root,
    now: "2026-08-17T12:07:45.000Z",
  });
  assert.equal(
    resumed.report.recommendations.find((item) => item.taskId === "BE-01").action,
    "INTERRUPT_THEN_RECONCILE",
  );

  const heartbeat = heartbeatTask(artifactDir, "BE-01", {
    now: "2026-08-17T12:08:00.000Z",
    apiCalls: 2,
    toolCalls: 3,
  });
  assert.equal(heartbeat.task.status, "RUNNING");
  assert.equal(heartbeat.task.stall.recoveredAt, "2026-08-17T12:08:00.000Z");
});

test("a task-scoped failing validation is concrete FAILED evidence", () => {
  const { root, artifactDir } = fixture();
  initRun({ projectRoot: root, artifactDir, slug: "demo-run", runId: "run-validation-fail" });
  updateTaskStatus(artifactDir, "BE-01", "RUNNING", { projectRoot: root });
  const probeFile = join(artifactDir, "probe.json");
  writeFileSync(
    probeFile,
    JSON.stringify({
      tasks: {
        "BE-01": {
          validations: [{ command: "dotnet test --filter BE-01", status: "FAIL" }],
        },
      },
    }),
    "utf8",
  );

  const resumed = resumeRunAtDirectory(artifactDir, { projectRoot: root, probeFile });
  assert.equal(resumed.state.tasks["BE-01"].status, "FAILED");
  assert.equal(resumed.state.tasks["BE-01"].reconciliation.recommendation, "FIX_OR_REEXECUTE");
});

test("terminal DONE cannot be silently restarted", () => {
  const { root, artifactDir } = fixture();
  initRun({ projectRoot: root, artifactDir, slug: "demo-run", runId: "run-terminal" });
  writeExpectedBackendFile(root);
  updateTaskStatus(artifactDir, "BE-01", "RUNNING", { projectRoot: root });
  updateTaskStatus(artifactDir, "BE-01", "DONE", {
    projectRoot: root,
    evidence: "executor:DONE",
  });

  assert.throws(
    () => updateTaskStatus(artifactDir, "BE-01", "RUNNING", { projectRoot: root }),
    (error) => error instanceof OrchestrationStateError && error.code === "INVALID_TASK_TRANSITION",
  );
});

test("reconciliation never regresses a terminal task", () => {
  const { root, artifactDir } = fixture();
  initRun({ projectRoot: root, artifactDir, slug: "demo-run", runId: "run-terminal-probe" });
  writeExpectedBackendFile(root);
  updateTaskStatus(artifactDir, "BE-01", "RUNNING", { projectRoot: root });
  updateTaskStatus(artifactDir, "BE-01", "DONE", {
    projectRoot: root,
    evidence: "executor:DONE",
  });
  const probeFile = join(artifactDir, "probe.json");
  writeFileSync(
    probeFile,
    JSON.stringify({ tasks: { "BE-01": { executorStatus: "RUNNING" } } }),
    "utf8",
  );

  const resumed = resumeRunAtDirectory(artifactDir, { projectRoot: root, probeFile });
  assert.equal(resumed.state.tasks["BE-01"].status, "DONE");
});

test("resume advances past a durably completed phase", () => {
  const { root, artifactDir } = fixture();
  initRun({ projectRoot: root, artifactDir, slug: "demo-run", runId: "run-next-phase" });
  for (const phase of [1, 2, 3]) {
    updatePhase(artifactDir, phase, "DONE", { projectRoot: root, evidence: `test:${phase}:DONE` });
  }
  writeFileSync(join(artifactDir, "design-materialization.json"), JSON.stringify({ status: "PASS", applied: true, findings: [] }), "utf8");
  updateCompletionGate(artifactDir, "visualMaterialization", "DONE", { projectRoot: root, evidence: ["file:design-materialization.json"] });
  writeFileSync(join(artifactDir, "evidence", "infra-smoke-test.json"), JSON.stringify({ kind: "infra-smoke-test", schemaVersion: 1, status: "PASS", applicable: true }), "utf8");
  updateCompletionGate(artifactDir, "infraSmokeTest", "DONE", { projectRoot: root });
  updatePhase(artifactDir, 4, "DONE", { projectRoot: root, evidence: "test:4:DONE" });
  updatePhase(artifactDir, 5, "DONE", { projectRoot: root, evidence: "test:5:DONE" });
  sweepStalledTasks(artifactDir, { projectRoot: root });
  updateCompletionGate(artifactDir, "monitoring", "DONE", { projectRoot: root, evidence: ["manual"] });
  updatePhase(artifactDir, 6, "DONE", { projectRoot: root, evidence: "test:6:DONE" });

  const resumed = resumeRunAtDirectory(artifactDir, { projectRoot: root });
  assert.equal(resumed.report.resumeFromPhase, 7);
});

test("run completion is explicit and refuses incomplete tasks", () => {
  const { root, artifactDir } = fixture();
  initRun({ projectRoot: root, artifactDir, slug: "demo-run", runId: "run-explicit-done" });

  assert.throws(
    () => updateRunStatus(artifactDir, "DONE"),
    (error) => error instanceof OrchestrationStateError && error.code === "RUN_COMPLETION_GATES_FAILED",
  );

  completeRun(root, artifactDir);
  assert.equal(auditRunCompletion(artifactDir).complete, true);
  const completed = updateRunStatus(artifactDir, "DONE");
  assert.equal(completed.state.status, "DONE");
  assert.throws(
    () => resumeRunAtDirectory(artifactDir, { projectRoot: root }),
    (error) => error instanceof OrchestrationStateError && error.code === "RUN_TERMINAL",
  );
});

test("run cannot be DONE with a hand-written handoff.json that fails validateHandoff()", () => {
  const { root, artifactDir } = fixture();
  initRun({ projectRoot: root, artifactDir, slug: "demo-run", runId: "run-invalid-handoff" });
  completeRun(root, artifactDir);
  assert.equal(auditRunCompletion(artifactDir).complete, true);

  // the defect from a real run: no handoffVersion / stage / producer / artifactRoot / summary ...
  writeFileSync(join(artifactDir, "handoff.json"), JSON.stringify({ schemaVersion: "1.0", slug: "demo-run", status: "DONE" }), "utf8");
  const audit = auditRunCompletion(artifactDir);
  assert.equal(audit.complete, false);
  assert.equal(audit.recommendedRunStatus, "PARTIAL");
  assert.ok(audit.invalidHandoff.length > 0);
  assert.throws(
    () => updateRunStatus(artifactDir, "DONE"),
    (error) => error instanceof OrchestrationStateError && error.code === "RUN_COMPLETION_GATES_FAILED" && error.details.invalidHandoff.length > 0,
  );

  writeFileSync(join(artifactDir, "handoff.json"), "{ not json", "utf8");
  assert.equal(auditRunCompletion(artifactDir).invalidHandoff[0].code, "HANDOFF_NOT_JSON");

  writeFileSync(join(artifactDir, "handoff.json"), VALID_HANDOFF, "utf8");
  assert.equal(auditRunCompletion(artifactDir).complete, true);
  assert.equal(updateRunStatus(artifactDir, "DONE").state.status, "DONE");
});

test("sync adds newly classified tasks without deleting durable history", () => {
  const { root, artifactDir } = fixture();
  initRun({ projectRoot: root, artifactDir, slug: "demo-run", runId: "run-sync" });
  const classificationPath = join(artifactDir, "tasks-classification.md");
  writeFileSync(
    classificationPath,
    `${readFileSync(classificationPath, "utf8")}\n## BE-02 - Worker\n- category: BACKEND_ONLY\n- assignedAgent: codex\n`,
    "utf8",
  );

  const synced = syncRunFromArtifacts(artifactDir, { projectRoot: root });
  assert.equal(synced.state.tasks["BE-02"].status, "PENDING");
  assert.equal(synced.state.tasks["BE-01"].sourcePresent, true);
});

test("task parsing preserves split task suffixes as independent lifecycle entries", () => {
  const { root, artifactDir } = fixture();
  const classificationPath = join(artifactDir, "tasks-classification.md");
  const wavesPath = join(artifactDir, "waves.md");
  writeFileSync(
    classificationPath,
    `${readFileSync(classificationPath, "utf8")}\n## FE-02-A - First prompt slice\n- category: FRONTEND_ONLY\n\n## FE-02-B - Second prompt slice\n- category: FRONTEND_ONLY\n`,
    "utf8",
  );
  writeFileSync(
    wavesPath,
    `${readFileSync(wavesPath, "utf8")}\n## Wave 3\n- FE-02-A\n- FE-02-B\n`,
    "utf8",
  );

  const initialized = initRun({
    projectRoot: root,
    artifactDir,
    slug: "demo-run",
    runId: "run-split-tasks",
  });
  assert.equal(initialized.state.tasks["FE-02-A"].status, "PENDING");
  assert.equal(initialized.state.tasks["FE-02-B"].status, "PENDING");
  assert.deepEqual(initialized.state.waves.at(-1).tasks, ["FE-02-A", "FE-02-B"]);
});

test("root CLI wrapper performs an end-to-end resume", () => {
  const { root, artifactDir } = fixture();
  const cli = join(process.cwd(), "scripts", "orchestration-state.mjs");
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };

  run("init", "--slug", "demo-run", "--dir", artifactDir, "--run-id", "run-cli-resume");
  run(
    "task",
    "--dir",
    artifactDir,
    "--task",
    "BE-01",
    "--status",
    "RUNNING",
    "--executor",
    "codex",
    "--session-id",
    "cli-session",
  );
  const resumed = run("resume", "run-cli-resume", "--root", root);
  assert.equal(resumed.state.tasks["BE-01"].status, "UNKNOWN");
  assert.equal(resumed.report.pendingExternalProbes[0].sessionId, "cli-session");
});

test("an empty Phase 1 run cannot become DONE", () => {
  const { root, artifactDir } = fixture();
  writeFileSync(join(artifactDir, "tasks-classification.md"), "# Tasks\n", "utf8");
  writeFileSync(join(artifactDir, "waves.md"), "# Waves\n", "utf8");
  initRun({ projectRoot: root, artifactDir, slug: "demo-run", runId: "run-empty" });

  assert.throws(
    () => updateRunStatus(artifactDir, "DONE"),
    (error) =>
      error instanceof OrchestrationStateError &&
      error.code === "RUN_COMPLETION_GATES_FAILED" &&
      error.details.taskCount === 0,
  );
});

test("terminal run identity rejects phase mutation and init reuse", () => {
  const { root, artifactDir } = fixture();
  initRun({ projectRoot: root, artifactDir, slug: "demo-run", runId: "run-global-terminal" });
  completeRun(root, artifactDir);
  updateRunStatus(artifactDir, "DONE");

  assert.throws(
    () => updatePhase(artifactDir, 6, "RUNNING", { projectRoot: root }),
    (error) => error instanceof OrchestrationStateError && error.code === "RUN_TERMINAL",
  );
  assert.throws(
    () => initRun({ projectRoot: root, artifactDir, slug: "demo-run" }),
    (error) => error instanceof OrchestrationStateError && error.code === "RUN_TERMINAL",
  );
});

test("a task removed from classification blocks completion until scope is resolved", () => {
  const { root, artifactDir } = fixture();
  initRun({ projectRoot: root, artifactDir, slug: "demo-run", runId: "run-scope" });
  writeFileSync(
    join(artifactDir, "tasks-classification.md"),
    [
      "# Tasks",
      "",
      "## BE-01 - Backend endpoint",
      "- category: BACKEND_ONLY",
      "- assignedAgent: codex",
      "- expectedFiles: `src/output.txt`",
    ].join("\n"),
    "utf8",
  );
  const synced = syncRunFromArtifacts(artifactDir, { projectRoot: root });
  assert.deepEqual(synced.missingFromSource, ["FE-01"]);
  assert.deepEqual(auditRunCompletion(artifactDir).unresolvedScope, ["FE-01"]);

  const resolved = resolveTaskScope(artifactDir, "FE-01", "REMOVE", {
    projectRoot: root,
    reason: "User removed the feature from the authoritative specification",
  });
  assert.equal(resolved.task.status, "CANCELLED");
  assert.equal(resolved.task.scopeResolution.status, "REMOVED");
  assert.deepEqual(auditRunCompletion(artifactDir).unresolvedScope, []);
});

test("a targeted lookup for a corrupt run throws RUN_CORRUPT rather than silently substituting another run", () => {
  const { root, artifactDir } = fixture({ slug: "older-run" });
  initRun({ projectRoot: root, artifactDir, slug: "older-run", runId: "older-run-id" });
  const corruptDir = join(root, ".orchestration", "newest-run");
  mkdirSync(corruptDir, { recursive: true });
  const corruptState = join(corruptDir, "state.json");
  writeFileSync(corruptState, "{ not-json\n", "utf8");
  const future = new Date(Date.now() + 60_000);
  utimesSync(corruptState, future, future);

  assert.throws(
    () => findRunDirectory({ projectRoot: root, runId: "newest-run" }),
    (error) => error instanceof OrchestrationStateError && error.code === "RUN_CORRUPT",
  );
});

// N-17: an automatic "resume the most recent run" lookup (no explicit runId)
// has no single named target — one corrupt archived run must not
// permanently break `/orchestrator resume` for the whole project. It should
// skip the corrupt candidate and fall back to the next resumable run.
test("automatic lookup skips a corrupt newest run and falls back to an older resumable run", () => {
  const { root, artifactDir } = fixture({ slug: "older-run" });
  initRun({ projectRoot: root, artifactDir, slug: "older-run", runId: "older-run-id" });
  const corruptDir = join(root, ".orchestration", "newest-run");
  mkdirSync(corruptDir, { recursive: true });
  const corruptState = join(corruptDir, "state.json");
  writeFileSync(corruptState, "{ not-json\n", "utf8");
  const future = new Date(Date.now() + 60_000);
  utimesSync(corruptState, future, future);

  const found = findRunDirectory({ projectRoot: root });
  assert.equal(found, artifactDir, "must fall back to the older, non-corrupt run");
});

// When every candidate is corrupt, automatic lookup still fails loudly —
// there is nothing to fall back to.
test("automatic lookup throws RUN_CORRUPT when every candidate run is corrupt", () => {
  const { root } = fixture({ slug: "only-run" });
  const corruptDir = join(root, ".orchestration", "only-run");
  mkdirSync(corruptDir, { recursive: true });
  writeFileSync(join(corruptDir, "state.json"), "{ not-json\n", "utf8");

  assert.throws(
    () => findRunDirectory({ projectRoot: root }),
    (error) => error instanceof OrchestrationStateError && error.code === "RUN_CORRUPT",
  );
});

test("cancellation must interrupt and reconcile active executors before finalization", () => {
  const { root, artifactDir } = fixture();
  initRun({ projectRoot: root, artifactDir, slug: "demo-run", runId: "run-cancel" });
  updateTaskStatus(artifactDir, "BE-01", "RUNNING", {
    projectRoot: root,
    executor: "codex",
    sessionId: "cancel-session",
  });
  const requested = requestRunCancellation(artifactDir, {
    projectRoot: root,
    reason: "User cancelled the run",
  });
  assert.equal(requested.state.status, "UNKNOWN");
  assert.equal(requested.state.tasks["BE-01"].status, "UNKNOWN");
  assert.equal(requested.state.tasks["FE-01"].status, "CANCELLED");
  assert.equal(requested.pendingExecutorStops[0].sessionId, "cancel-session");
  assert.throws(
    () => updateRunStatus(artifactDir, "CANCELLED", { reason: "too early" }),
    (error) => error instanceof OrchestrationStateError && error.code === "CANCELLATION_NOT_RECONCILED",
  );

  updateTaskStatus(artifactDir, "BE-01", "CANCELLED", {
    projectRoot: root,
    reasonCode: "EXECUTOR_CANCELLED",
    reason: "Codex session confirmed stopped",
  });
  const finalized = updateRunStatus(artifactDir, "CANCELLED", { reason: "Cancellation reconciled" });
  assert.equal(finalized.state.status, "CANCELLED");
  assert.ok(finalized.state.cancellation.finalizedAt);
});

test("external DONE without local corroboration remains UNKNOWN", () => {
  const { root, artifactDir } = fixture();
  initRun({ projectRoot: root, artifactDir, slug: "demo-run", runId: "run-no-corroboration" });
  updateTaskStatus(artifactDir, "FE-01", "RUNNING", {
    projectRoot: root,
    executor: "agy",
    conversationId: "agy-no-evidence",
  });
  const probeFile = join(artifactDir, "probe-no-evidence.json");
  writeFileSync(
    probeFile,
    JSON.stringify({ tasks: { "FE-01": { executorStatus: "DONE" } } }),
    "utf8",
  );
  const resumed = resumeRunAtDirectory(artifactDir, { projectRoot: root, probeFile });
  const task = resumed.state.tasks["FE-01"];
  assert.equal(task.status, "UNKNOWN");
  assert.equal(task.reconciliation.recommendation, "COLLECT_LOCAL_EVIDENCE");
  assert.equal(task.reconciliation.localCorroboration, null);
});

test("executor operational reason codes survive canonical status mapping", () => {
  const { root, artifactDir } = fixture();
  initRun({ projectRoot: root, artifactDir, slug: "demo-run", runId: "run-reason-code" });
  updateTaskStatus(artifactDir, "FE-01", "RUNNING", {
    projectRoot: root,
    executor: "agy",
  });
  const probeFile = join(artifactDir, "probe-quota.json");
  writeFileSync(
    probeFile,
    JSON.stringify({ tasks: { "FE-01": { executorStatus: "QUOTA_EXHAUSTED" } } }),
    "utf8",
  );
  const resumed = resumeRunAtDirectory(artifactDir, { projectRoot: root, probeFile });
  assert.equal(resumed.state.tasks["FE-01"].status, "BLOCKED");
  assert.equal(resumed.state.tasks["FE-01"].reasonCode, "QUOTA_EXHAUSTED");
  assert.equal(
    resumed.state.tasks["FE-01"].reconciliation.externalRawStatus,
    "QUOTA_EXHAUSTED",
  );
});

test("resume follows the explicit phase sequence after browser E2E", () => {
  const { root, artifactDir } = fixture();
  initRun({ projectRoot: root, artifactDir, slug: "demo-run", runId: "run-phase-sequence" });
  for (const phase of [1, 2, 3]) {
    updatePhase(artifactDir, phase, "DONE", { projectRoot: root, evidence: `test:${phase}:DONE` });
  }
  writeFileSync(join(artifactDir, "design-materialization.json"), JSON.stringify({ status: "PASS", applied: true, findings: [] }), "utf8");
  updateCompletionGate(artifactDir, "visualMaterialization", "DONE", { projectRoot: root, evidence: ["file:design-materialization.json"] });
  writeFileSync(join(artifactDir, "evidence", "infra-smoke-test.json"), JSON.stringify({ kind: "infra-smoke-test", schemaVersion: 1, status: "PASS", applicable: true }), "utf8");
  updateCompletionGate(artifactDir, "infraSmokeTest", "DONE", { projectRoot: root });
  updatePhase(artifactDir, 4, "DONE", { projectRoot: root, evidence: "test:4:DONE" });
  updatePhase(artifactDir, 5, "DONE", { projectRoot: root, evidence: "test:5:DONE" });
  sweepStalledTasks(artifactDir, { projectRoot: root });
  updateCompletionGate(artifactDir, "monitoring", "DONE", { projectRoot: root, evidence: ["manual"] });
  updatePhase(artifactDir, 6, "DONE", { projectRoot: root, evidence: "test:6:DONE" });
  updateCompletionGate(artifactDir, "backendReview", "DONE", { projectRoot: root, evidence: ["manual"] });
  updatePhase(artifactDir, 7, "DONE", { projectRoot: root, evidence: "test:7:DONE" });
  updatePhase(artifactDir, 8, "DONE", { projectRoot: root, evidence: "test:8:DONE" });
  updateCompletionGate(artifactDir, "frontendReview", "DONE", { projectRoot: root, evidence: ["manual"] });
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
  updatePhase(artifactDir, 9, "DONE", { projectRoot: root, evidence: "test:9:DONE" });
  updateCompletionGate(artifactDir, "browserE2E", "DONE", { projectRoot: root, evidence: ["browser:e2e:PASS"] });
  updatePhase(artifactDir, 9.5, "DONE", {
    projectRoot: root,
    evidence: "browser:e2e:PASS",
  });
  const resumed = resumeRunAtDirectory(artifactDir, { projectRoot: root });
  assert.equal(resumed.report.resumeFromPhase, 10);
});

/* -------------------------------------------------------------------------- */
/* Snapshot e drift da Project_Config na Run (task 9.6)                        */
/* -------------------------------------------------------------------------- */

test("initRun grava um snapshot da Project_Config vigente, igual ao arquivo", () => {
  const { root, artifactDir } = fixture();
  writeProjectConfig(root, {
    backendExecutor: "codex",
    frontendExecutor: "claude-code",
    backendReviewer: "agy",
    frontendReviewer: "claude-code",
  });

  const init = initRun({ projectRoot: root, artifactDir, slug: "demo-run", runId: "run-snapshot" });

  assert.equal(init.state.projectConfig.source, "file");
  assert.equal(init.state.projectConfig.roles.backendExecutor, "codex");
  assert.equal(init.state.projectConfig.roles.frontendExecutor, "claude-code");
  assert.equal(init.state.projectConfig.roles.backendReviewer, "agy");
  assert.equal(init.state.projectConfig.roles.frontendReviewer, "claude-code");
  assert.equal(typeof init.state.projectConfig.updatedAt, "string");

  // O snapshot sobrevive a uma releitura da Run a partir do disco.
  const reloaded = loadRun(artifactDir).state;
  assert.deepEqual(reloaded.projectConfig, init.state.projectConfig);
});

test("resume reporta drift exatamente nos papeis que mudaram entre o snapshot e o arquivo atual", () => {
  const { root, artifactDir } = fixture();
  writeProjectConfig(root, {
    backendExecutor: "codex",
    frontendExecutor: "agy",
    backendReviewer: "codex",
    frontendReviewer: "agy",
  });
  initRun({ projectRoot: root, artifactDir, slug: "demo-run", runId: "run-drift" });

  // Regrava o arquivo com dois papeis diferentes do snapshot.
  writeProjectConfig(root, {
    backendExecutor: "claude-code",
    frontendExecutor: "agy",
    backendReviewer: "claude-code",
    frontendReviewer: "agy",
  });

  const resumed = resumeRunAtDirectory(artifactDir, { projectRoot: root });
  assert.equal(resumed.projectConfigDrift.changed, true);
  assert.equal(resumed.projectConfigDrift.source, "file");
  assert.deepEqual(
    resumed.projectConfigDrift.differences.map((entry) => entry.role).sort(),
    ["backendExecutor", "backendReviewer"],
  );
  for (const entry of resumed.projectConfigDrift.differences) {
    assert.equal(entry.to, "claude-code");
  }
});

test("adotar a configuracao atual preserva o executor de uma task ja despachada e reatribui so as pendentes", () => {
  const { root, artifactDir } = fixture();
  writeProjectConfig(root, {
    backendExecutor: "codex",
    frontendExecutor: "agy",
    backendReviewer: "codex",
    frontendReviewer: "agy",
  });
  initRun({ projectRoot: root, artifactDir, slug: "demo-run", runId: "run-apply-scope" });

  // BE-01 ja foi despachado com um Executor proprio, distinto do que a nova
  // configuracao derivaria; FE-01 continua PENDING/attempt 0.
  updateTaskStatus(artifactDir, "BE-01", "RUNNING", {
    projectRoot: root,
    executor: "codex",
    executorSource: "manual-dispatch",
    sessionId: "be-01-session",
  });

  writeProjectConfig(root, {
    backendExecutor: "claude-code",
    frontendExecutor: "claude-code",
    backendReviewer: "codex",
    frontendReviewer: "agy",
  });

  const applied = applyProjectConfigToRun(artifactDir, { projectRoot: root, scope: "pending" });

  // Task despachada preserva o Executor do dispatch e entra em skippedTaskIds.
  assert.equal(applied.state.tasks["BE-01"].executor, "codex");
  assert.equal(applied.state.tasks["BE-01"].executorSource, "manual-dispatch");
  assert.ok(applied.skippedTaskIds.includes("BE-01"));
  assert.ok(!applied.appliedTaskIds.includes("BE-01"));

  // Task ainda pendente adota a nova configuracao.
  assert.equal(applied.state.tasks["FE-01"].executor, "claude-code");
  assert.equal(applied.state.tasks["FE-01"].executorSource, "project-config");
  assert.ok(applied.appliedTaskIds.includes("FE-01"));

  // O evento registrado nomeia o motivo da mudanca (Req 10.4), e o snapshot da
  // Run passa a refletir a configuracao adotada.
  assert.equal(applied.event.type, "PROJECT_CONFIG_UPDATED");
  assert.ok(String(applied.reason ?? "").trim() !== "");
  assert.equal(applied.state.projectConfig.roles.frontendExecutor, "claude-code");
});

test("uma Run legada sem snapshot de Project_Config continua legivel, com drift changed: false e source legacy", () => {
  const { root, artifactDir } = fixture();
  initRun({ projectRoot: root, artifactDir, slug: "demo-run", runId: "run-legacy" });

  // Simula uma Run gravada antes desta feature: nem o snapshot (state.json) nem
  // o evento RUN_INITIALIZED durável (events.jsonl) carregam `projectConfig`,
  // como um write-ahead log legado teria. Editar so o state.json nao bastaria:
  // `repairSnapshot`/`verifyReplay` reconstroem o estado a partir do payload do
  // evento, entao os dois precisam concordar.
  const statePath = join(artifactDir, "state.json");
  const eventsPath = join(artifactDir, "events.jsonl");

  const legacyState = JSON.parse(readFileSync(statePath, "utf8"));
  delete legacyState.projectConfig;
  writeFileSync(statePath, JSON.stringify(legacyState, null, 2), "utf8");

  const eventLines = readFileSync(eventsPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(eventLines[0].type, "RUN_INITIALIZED");
  delete eventLines[0].payload.state.projectConfig;
  writeFileSync(eventsPath, `${eventLines.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

  const reloaded = loadRun(artifactDir, { repairSnapshot: true, verifyReplay: true }).state;
  assert.equal(reloaded.projectConfig, undefined);

  const resumed = resumeRunAtDirectory(artifactDir, { projectRoot: root });
  assert.equal(resumed.projectConfigDrift.changed, false);
  assert.equal(resumed.projectConfigDrift.source, "legacy");
  assert.deepEqual(resumed.projectConfigDrift.differences, []);
  assert.equal(resumed.projectConfigDrift.snapshotUpdatedAt, null);
});

test("estado AGY persiste parametros de planejamento e metadados estruturados por tentativa", () => {
  const { root, artifactDir } = fixture({ slug: "agy-bridge-metadata" });
  const classificationPath = join(artifactDir, "tasks-classification.md");
  const classification = readFileSync(classificationPath, "utf8").replace(
    "- validationPlan: `npm run build`",
    [
      "- validationPlan: `npm run build`",
      "- agyModel: `flash-high`",
      "- agyEffort: `medium`",
      "- agyTimeout: `5m`",
      "- agyFormat: `stream-json`",
    ].join("\n"),
  );
  writeFileSync(classificationPath, classification, "utf8");
  initRun({ projectRoot: root, artifactDir, slug: "agy-bridge-metadata", runId: "agy-meta-001" });

  const planned = loadRun(artifactDir).state.tasks["FE-01"];
  assert.equal(planned.model, "flash-high");
  assert.equal(planned.agyEffort, "medium");
  assert.equal(planned.agyTimeout, "5m");
  assert.equal(planned.agyFormat, "stream-json");

  updateTaskStatus(artifactDir, "FE-01", "RUNNING", {
    projectRoot: root,
    executor: "agy",
    conversationId: "conversation-42",
  });
  const probePath = join(root, "agy-probe.json");
  writeFileSync(probePath, JSON.stringify({
    schemaVersion: 1,
    tasks: {
      "FE-01": {
        executorStatus: "BLOCKED",
        reasonCode: "QUOTA_EXAUSTED",
        reason: "capacity",
        conversationId: "conversation-42",
        model: "gemini-4.2-flash-high",
        retryDirective: "--conversation conversation-42",
        usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
        durationSeconds: 12.5,
        numTurns: 3,
        adapter: { executor: "agy", version: 2, authoritative: true },
      },
    },
  }), "utf8");
  reconcileRunAtDirectory(artifactDir, { projectRoot: root, probeFile: probePath });

  const blocked = loadRun(artifactDir).state.tasks["FE-01"];
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.resolvedModel, "gemini-4.2-flash-high");
  assert.equal(blocked.retryDirective, "--conversation conversation-42");
  assert.deepEqual(blocked.usage, { inputTokens: 120, outputTokens: 30, totalTokens: 150 });
  assert.equal(blocked.durationSeconds, 12.5);
  assert.equal(blocked.numTurns, 3);
  assert.equal(blocked.attemptHistory[0].resolvedModel, "gemini-4.2-flash-high");

  updateTaskStatus(artifactDir, "FE-01", "RUNNING", {
    projectRoot: root,
    executor: "agy",
    conversationId: blocked.conversationId,
    retryDirective: blocked.retryDirective,
    newAttempt: true,
  });
  const retried = loadRun(artifactDir).state.tasks["FE-01"];
  assert.equal(retried.attempt, 2);
  assert.equal(retried.conversationId, "conversation-42");
  assert.equal(retried.retryDirective, "--conversation conversation-42");
  assert.equal(retried.resolvedModel, null);
  assert.equal(retried.usage, null);
  assert.equal(retried.attemptHistory[0].resolvedModel, "gemini-4.2-flash-high");
});

test("task parsing ignores prose requirements and accepts only structural task records", () => {
  const root = mkdtempSync(join(process.cwd(), ".tmp-parser-regression-"));
  temporaryRoots.push(root);
  writeFileSync(join(root, "tasks-classification.md"), [
    "# Plano",
    "A task deve atender `US-01` e o contrato `CT-01-auth`.",
    "## V2 migration notes",
    "Esta secao nao e uma task.",
    "## BE-01 Entrega real",
    "- requirementIds: US-01, RF-01",
    "  - RF-02",
    "- contractIds: `CT-01-auth`, `openapi.yaml`, `FE-01`",
    "## Task FE-01 Tela real",
    "- validationPlan: `npm run build`",
  ].join("\n"), "utf8");
  writeFileSync(join(root, "waves.md"), "# Wave 1\n- BE-01\n- FE-01\n", "utf8");
  const parsed = parseTaskArtifacts(root);
  assert.deepEqual(Object.keys(parsed.tasks).sort(), ["BE-01", "FE-01"]);
  assert.deepEqual(parsed.tasks["BE-01"].requirementIds, ["US-01", "RF-01", "RF-02"]);
  assert.deepEqual(parsed.tasks["BE-01"].contractIds, ["CT-01-auth"]);
});

test("requirements evidence uses the review layout and covers every task requirement", () => {
  const { root, artifactDir } = fixture({ slug: "requirements-evidence" });
  writeFileSync(join(artifactDir, "tasks-classification.md"), [
    "# Tasks",
    "",
    "## BE-01 - Requirement implementation",
    "- category: BACKEND_ONLY",
    "- validationPlan: `verify`",
    "- requirementIds: RF-99",
  ].join("\n"), "utf8");
  writeFileSync(join(artifactDir, "waves.md"), "# Waves\n\n## Wave 1\n- BE-01\n", "utf8");
  initRun({ projectRoot: root, artifactDir, slug: "requirements-evidence", runId: "requirements-evidence-001" });

  const evidencePath = join(artifactDir, "review", "requirements-evidence.json");
  writeFileSync(evidencePath, JSON.stringify({
    schemaVersion: 1,
    requirements: [{
      requirementId: "RF-01",
      acceptanceCriteria: [{ id: "CA-01", status: "PASS", evidence: [null] }],
      findings: [],
    }],
  }), "utf8");
  let audit = auditRunCompletion(artifactDir).requirementsEvidence;
  assert.equal(audit.valid, false);
  assert.deepEqual(audit.missingRequirementIds, ["RF-99"]);

  writeFileSync(evidencePath, JSON.stringify({
    schemaVersion: 1,
    requirements: [{
      requirementId: "RF-99",
      acceptanceCriteria: [{
        id: "CA-99",
        status: "PASS",
        evidence: [{ kind: "code", ref: "src/example.mjs:42" }],
      }],
      findings: [],
    }],
  }), "utf8");
  const gate = updateCompletionGate(artifactDir, "requirementsCoverage", "DONE", { projectRoot: root }).gate;
  assert.ok(gate.evidence.includes("file:review/requirements-evidence.json"));
  audit = auditRunCompletion(artifactDir).requirementsEvidence;
  assert.equal(audit.valid, true);
});

test("PARTIAL runs are terminal and cannot be resumed", () => {
  const { root, artifactDir } = fixture({ slug: "partial-terminal" });
  initRun({ projectRoot: root, artifactDir, slug: "partial-terminal", runId: "partial-terminal-001" });
  updateRunStatus(artifactDir, "PARTIAL", { projectRoot: root, reason: "Evidence is incomplete" });
  assert.throws(
    () => resumeRunAtDirectory(artifactDir, { projectRoot: root }),
    (error) => error instanceof OrchestrationStateError && error.code === "RUN_TERMINAL",
  );
});
