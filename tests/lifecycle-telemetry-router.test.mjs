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
  adaptiveRoutingReport,
  recordRoutingDecision,
  routeModel,
} from "../skills/orchestrator-multi-agent-development/scripts/lib/adaptive-router.mjs";
import { adaptExecutorProbe } from "../skills/orchestrator-multi-agent-development/scripts/lib/executor-adapters.mjs";
import {
  cancelRunLifecycle,
  interruptTaskLifecycle,
  retryTaskLifecycle,
  tickLifecycle,
  watchLifecycle,
} from "../skills/orchestrator-multi-agent-development/scripts/lib/lifecycle-manager.mjs";
import {
  executeExecutorControl,
  ExecutorControlError,
  validateExecutorControlConfig,
} from "../skills/orchestrator-multi-agent-development/scripts/lib/executor-control.mjs";
import {
  initRun,
  loadRun,
  updateTaskStatus,
} from "../skills/orchestrator-multi-agent-development/scripts/lib/orchestration-state.mjs";
import {
  buildOtlpLogExport,
  compactTelemetry,
  readTelemetry,
  recordTelemetry,
  TelemetryError,
} from "../skills/orchestrator-multi-agent-development/scripts/lib/telemetry.mjs";

const roots = [];

function fixture(runId = "lifecycle-run-001") {
  const root = mkdtempSync(join(process.cwd(), ".tmp-lifecycle-test-"));
  roots.push(root);
  const artifactDir = join(root, ".orchestration", "lifecycle-run");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, "tasks-classification.md"), [
    "# Tasks",
    "",
    "## BE-01 - Background task",
    "- category: BACKEND_ONLY",
    "- complexity: medium",
    "- assignedAgent: codex",
    "- validationPlan: `verify`",
  ].join("\n"), "utf8");
  writeFileSync(join(artifactDir, "waves.md"), "# Waves\n\n## Wave 1\n- BE-01\n", "utf8");
  initRun({ projectRoot: root, artifactDir, slug: "lifecycle-run", runId });
  return { root, artifactDir };
}

function controlFixture(root, options = {}) {
  const helper = join(root, "executor-helper.mjs");
  writeFileSync(helper, [
    "const [action, status, identity] = process.argv.slice(2);",
    "const result = { accepted: true, status, executorStatus: status, apiCalls: 2, toolCalls: 4, lastActivityAt: '2026-08-17T12:05:00.000Z' };",
    "if (action === 'dispatch') result.sessionId = identity || 'retry-session';",
    "else result.sessionId = identity;",
    "console.log(JSON.stringify(result));",
  ].join("\n"), "utf8");
  const config = {
    codex: {
      probe: {
        command: process.execPath,
        args: [helper, "probe", options.probeStatus ?? "RUNNING", "{sessionId}"],
      },
      interrupt: {
        command: process.execPath,
        args: [helper, "interrupt", "CANCELLED", "{sessionId}"],
      },
      dispatch: {
        command: process.execPath,
        args: [helper, "dispatch", "RUNNING", "retry-session"],
      },
    },
  };
  const path = join(root, "executor-control.json");
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return path;
}

test.afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

test("lifecycle polls a real control adapter, persists the result first and renews a lease", () => {
  const { root, artifactDir } = fixture();
  updateTaskStatus(artifactDir, "BE-01", "RUNNING", {
    projectRoot: root,
    executor: "codex",
    sessionId: "session-one",
    model: "account-default",
    now: "2026-08-17T12:00:00.000Z",
  });
  const adapterConfig = controlFixture(root);
  const tick = tickLifecycle(artifactDir, {
    projectRoot: root,
    adapterConfig,
    now: "2026-08-17T12:05:00.000Z",
  });
  assert.equal(tick.controlResults[0].ok, true);
  assert.equal(existsSync(tick.controlResults[0].persisted.path), true);
  assert.equal(tick.heartbeats[0].lease.status, "ACTIVE");
  assert.equal(loadRun(artifactDir).state.tasks["BE-01"].status, "RUNNING");
  assert.equal(readTelemetry(root).length, 0, "RUNNING is not a terminal telemetry outcome");
});

test("watchLifecycle ticks up to maxTicks and reports one onTick record per tick", async () => {
  const { root, artifactDir } = fixture();
  updateTaskStatus(artifactDir, "BE-01", "RUNNING", {
    projectRoot: root,
    executor: "codex",
    sessionId: "session-one",
  });
  const ticks = [];
  const result = await watchLifecycle(artifactDir, {
    projectRoot: root,
    intervalSeconds: 0,
    maxTicks: 3,
    onTick: (tick) => ticks.push(tick),
  });
  assert.equal(result.ticks, 3);
  assert.equal(result.stoppedReason, null);
  assert.equal(ticks.length, 3);
  assert.deepEqual(
    ticks.map((tick) => tick.tick),
    [1, 2, 3],
  );
  // Sem adapter, reconcileRunAtDirectory nao tem autoridade externa para
  // confirmar a task e a rebaixa de RUNNING para UNKNOWN ja no primeiro tick
  // (SKILL.md regra 23: "sem autoridade externa, mantenha UNKNOWN") — watch
  // continua rodando porque UNKNOWN esta em ACTIVE_TASK_STATUSES.
  for (const tick of ticks) {
    assert.equal(typeof tick.ranAt, "string");
    assert.equal(tick.summary.counts.RUNNING, 1);
  }
});

test("watchLifecycle stops early once no task is left active (NO_ACTIVE_TASKS)", async () => {
  const { root, artifactDir } = fixture();
  updateTaskStatus(artifactDir, "BE-01", "RUNNING", {
    projectRoot: root,
    executor: "codex",
    sessionId: "session-one",
  });
  updateTaskStatus(artifactDir, "BE-01", "DONE", {
    projectRoot: root,
    evidence: ["executor:BE-01:DONE"],
  });
  const ticks = [];
  const result = await watchLifecycle(artifactDir, {
    projectRoot: root,
    intervalSeconds: 0,
    maxTicks: 10,
    onTick: (tick) => ticks.push(tick),
  });
  assert.equal(result.stoppedReason, "NO_ACTIVE_TASKS");
  assert.equal(result.ticks, 1);
  assert.equal(ticks.length, 1);
  assert.equal(loadRun(artifactDir).state.lifecycle.lastSweepAt != null, true);
});

test("watchLifecycle with autoStop: false ignores terminal state and always runs maxTicks", async () => {
  const { root, artifactDir } = fixture();
  updateTaskStatus(artifactDir, "BE-01", "RUNNING", {
    projectRoot: root,
    executor: "codex",
    sessionId: "session-one",
  });
  updateTaskStatus(artifactDir, "BE-01", "DONE", {
    projectRoot: root,
    evidence: ["executor:BE-01:DONE"],
  });
  const result = await watchLifecycle(artifactDir, {
    projectRoot: root,
    intervalSeconds: 0,
    maxTicks: 2,
    autoStop: false,
  });
  assert.equal(result.stoppedReason, null);
  assert.equal(result.ticks, 2);
});

test("interrupt and retry require confirmed executor actions and preserve attempt history", () => {
  const { root, artifactDir } = fixture();
  updateTaskStatus(artifactDir, "BE-01", "RUNNING", {
    projectRoot: root,
    executor: "codex",
    sessionId: "session-one",
  });
  assert.throws(
    () => interruptTaskLifecycle(artifactDir, "BE-01", { projectRoot: root }),
    (error) => error.code === "EXECUTOR_CONTROL_REQUIRED",
  );
  const adapterConfig = controlFixture(root);
  const interrupted = interruptTaskLifecycle(artifactDir, "BE-01", {
    projectRoot: root,
    adapterConfig,
  });
  assert.equal(interrupted.task.status, "UNKNOWN");
  assert.ok(interrupted.controlResult.evidence);
  updateTaskStatus(artifactDir, "BE-01", "FAILED", {
    projectRoot: root,
    reasonCode: "EXECUTOR_INTERRUPTED",
  });
  const retried = retryTaskLifecycle(artifactDir, "BE-01", {
    projectRoot: root,
    adapterConfig,
  });
  assert.equal(retried.task.status, "RUNNING");
  assert.equal(retried.task.attempt, 2);
  assert.equal(retried.task.attemptHistory[0].status, "FAILED");
  assert.equal(retried.task.attemptHistory[1].status, "RUNNING");
});

test("run cancellation interrupts, reconciles and finalizes only after executor termination", () => {
  const { root, artifactDir } = fixture("cancel-run-001");
  updateTaskStatus(artifactDir, "BE-01", "RUNNING", {
    projectRoot: root,
    executor: "codex",
    sessionId: "session-one",
  });
  const adapterConfig = controlFixture(root, { probeStatus: "CANCELLED" });
  const cancelled = cancelRunLifecycle(artifactDir, {
    projectRoot: root,
    adapterConfig,
    reason: "User requested cancellation",
    finalize: true,
  });
  assert.deepEqual(cancelled.pendingTasks, []);
  assert.equal(loadRun(artifactDir).state.status, "CANCELLED");
  assert.equal(loadRun(artifactDir).state.tasks["BE-01"].status, "CANCELLED");
});

test("executor controls reject open configuration surfaces and command interpolation", () => {
  assert.throws(
    () => validateExecutorControlConfig({
      codex: {
        probe: {
          command: "{untrustedCommand}",
          args: [],
        },
      },
    }),
    (error) => error instanceof ExecutorControlError && error.code === "INVALID_EXECUTOR_CONTROL_ACTION",
  );
  assert.throws(
    () => validateExecutorControlConfig({
      codex: {
        probe: {
          command: process.execPath,
          args: [],
          environment: { SECRET: "value" },
        },
      },
    }),
    (error) => error instanceof ExecutorControlError && error.code === "INVALID_EXECUTOR_CONTROL_ACTION",
  );
});

test("executor controls bound structured output returned to orchestration context", () => {
  const { root } = fixture("bounded-control-run-001");
  const config = {
    codex: {
      probe: {
        command: process.execPath,
        args: [
          "-e",
          "console.log(JSON.stringify({accepted:true,status:'RUNNING',payload:Array.from({length:10},()=>\"x\".repeat(20000))}))",
        ],
      },
    },
  };
  const result = executeExecutorControl(config, "codex", "probe", {}, { projectRoot: root });
  assert.equal(result.accepted, true);
  assert.equal(result.status, "RUNNING");
  assert.equal(result.truncated, true);
  assert.equal("payload" in result, false);
  assert.ok(result.originalBytes > 128 * 1024);
});

function telemetryEvent(index, model, result) {
  return {
    eventId: `adaptive-${model}-${index}`,
    eventType: "task_attempt_outcome",
    occurredAt: `2026-08-${String(10 + index).padStart(2, "0")}T12:00:00.000Z`,
    runId: `run-${model}-${index}`,
    taskId: `FE-${index}`,
    taskType: "FRONTEND_ONLY",
    complexity: "medium",
    executor: "agy",
    model,
    attempt: 1,
    durationMs: model.includes("pro") ? 400_000 : 200_000,
    result,
    reviewResult: result === "DONE" ? "PASS" : "FAIL",
    regressions: result === "DONE" ? 0 : 1,
  };
}

test("adaptive router escalates only with comparable evidence and keeps user overrides authoritative", () => {
  const { root } = fixture("router-run-001");
  for (let index = 0; index < 8; index += 1) {
    recordTelemetry(root, telemetryEvent(index, "gemini-3.5-flash-medium", index < 2 ? "DONE" : "FAILED"));
    recordTelemetry(root, telemetryEvent(index, "gemini-3.1-pro-low", index < 8 ? "DONE" : "FAILED"));
  }
  const context = { taskType: "FRONTEND_ONLY", complexity: "medium", executor: "agy" };
  const decision = routeModel(root, context, { minimumSamples: 5, minimumStratumSamples: 1 });
  assert.equal(decision.source, "adaptive");
  assert.equal(decision.model, "pro-low");
  const recorded = recordRoutingDecision(root, decision, context, {
    runId: "router-run-001",
    taskId: "FE-99",
  });
  assert.equal(recorded.created, true);
  assert.equal(adaptiveRoutingReport(root).samples, 16);

  const override = routeModel(root, { ...context, userModel: "gemini-3.5-flash-high" });
  assert.equal(override.source, "user");
  assert.equal(override.model, "gemini-3.5-flash-high");
});

test("adaptive router accepts dynamic bridge slugs and rejects unsafe multiline overrides", () => {
  const { root } = fixture("router-dynamic-model-001");
  const context = { taskType: "FRONTEND_ONLY", complexity: "medium", executor: "agy" };
  const dynamic = routeModel(root, { ...context, userModel: "gemini-4.2-pro-ultra" });
  assert.equal(dynamic.source, "user");
  assert.equal(dynamic.model, "gemini-4.2-pro-ultra");
  assert.throws(
    () => routeModel(root, { ...context, userModel: "pro-high\n--mode accept-edits" }),
    (error) => error.code === "INVALID_MODEL_OVERRIDE",
  );
  assert.throws(
    () => routeModel(root, { ...context, userModel: "pro-high --mode accept-edits" }),
    (error) => error.code === "INVALID_MODEL_OVERRIDE",
  );
  assert.equal(
    routeModel(root, { ...context, previousFailed: true, previousModel: "improvisation-high" }).model,
    "flash-medium",
  );
});

test("AGY adapter preserves structured bridge 4.0 metadata and validates retry directives", () => {
  const probe = adaptExecutorProbe("agy", {
    status: "QUOTA_EXAUSTED",
    reason: "capacity",
    conversation_id: "conversation-42",
    model: "gemini-3.5-flash-high",
    retry: "--conversation conversation-42",
    usage: {
      input_tokens: 120,
      output_tokens: 30,
      cache_read_tokens: 10,
      ignored_text: "must-not-persist",
    },
    duration_seconds: 12.5,
    num_turns: 3,
  });
  assert.equal(probe.executorStatus, "QUOTA_EXAUSTED");
  assert.equal(probe.conversationId, "conversation-42");
  assert.equal(probe.retryDirective, "--conversation conversation-42");
  assert.deepEqual(probe.usage, {
    inputTokens: 120,
    outputTokens: 30,
    cacheReadTokens: 10,
    totalTokens: 150,
  });
  assert.equal(probe.durationSeconds, 12.5);
  assert.equal(probe.numTurns, 3);
  assert.equal(probe.adapter.version, 2);

  const unsafe = adaptExecutorProbe("agy", {
    status: "QUOTA_EXAUSTED",
    conversation_id: "conversation-42",
    retry: "--conversation another-id",
  });
  assert.equal(unsafe.retryDirective, null);
});

test("AGY adapter turns stream-json events into observable heartbeat counters", () => {
  const probe = adaptExecutorProbe("agy", {
    events: [
      { event: "init", conversation_id: "conversation-stream", timestamp: "2026-08-20T12:00:00.000Z" },
      { event: "step_update", timestamp: "2026-08-20T12:00:01.000Z", step_update: { tool_info: { name: "run_command" } } },
      { event: "step_update", timestamp: "2026-08-20T12:00:02.000Z", step_update: { subagent_info: { conversation_id: "sub-1" } } },
    ],
    status: "RUNNING",
  });
  assert.equal(probe.executorStatus, "RUNNING");
  assert.equal(probe.conversationId, "conversation-stream");
  assert.equal(probe.apiCalls, 2);
  assert.equal(probe.toolCalls, 1);
  assert.equal(probe.currentTool, "run_command");
  assert.equal(probe.inTool, true);
  assert.equal(probe.lastActivityAt, "2026-08-20T12:00:02.000Z");

  const completed = adaptExecutorProbe("agy", {
    events: [{
      event: "result",
      result: {
        status: "SUCCESS",
        conversation_id: "conversation-stream",
        duration_seconds: 8,
        num_turns: 2,
        usage: { input_tokens: 9, output_tokens: 4 },
      },
    }],
  });
  assert.equal(completed.executorStatus, "DONE");
  assert.equal(completed.inTool, false);
  assert.equal(completed.durationSeconds, 8);
  assert.equal(completed.numTurns, 2);
  assert.equal(completed.usage.totalTokens, 13);

  const quota = adaptExecutorProbe("agy", {
    events: [{
      event: "result",
      result: { status: "ERROR", error: "resource exhausted", conversation_id: "conversation-stream" },
    }],
  });
  assert.equal(quota.executorStatus, "QUOTA_EXAUSTED");
  assert.equal(quota.reasonCode, "QUOTA_EXAUSTED");
});

test("AGY lifecycle dispatch reuses the exact persisted conversation retry directive", () => {
  const { root, artifactDir } = fixture("agy-retry-001");
  updateTaskStatus(artifactDir, "BE-01", "RUNNING", {
    projectRoot: root,
    executor: "agy",
    conversationId: "conversation-42",
    retryDirective: "--conversation conversation-42",
  });
  updateTaskStatus(artifactDir, "BE-01", "FAILED", {
    projectRoot: root,
    reasonCode: "QUOTA_EXAUSTED",
    reason: "capacity",
  });

  const helper = join(root, "agy-retry-helper.mjs");
  writeFileSync(helper, [
    "const [retryDirective] = process.argv.slice(2);",
    "console.log(JSON.stringify({ accepted: true, status: 'RUNNING', conversationId: 'conversation-42', receivedRetry: retryDirective }));",
  ].join("\n"), "utf8");
  const adapterConfig = join(root, "agy-retry-control.json");
  writeFileSync(adapterConfig, JSON.stringify({
    agy: {
      dispatch: {
        command: process.execPath,
        args: [helper, "{retryDirective}"],
      },
    },
  }), "utf8");

  const retried = retryTaskLifecycle(artifactDir, "BE-01", {
    projectRoot: root,
    adapterConfig,
  });
  const persisted = JSON.parse(readFileSync(retried.controlResult.path, "utf8"));
  assert.equal(persisted.result.receivedRetry, "--conversation conversation-42");
  assert.equal(retried.task.conversationId, "conversation-42");
  assert.equal(retried.task.retryDirective, "--conversation conversation-42");
  assert.equal(retried.task.attempt, 2);
});

test("telemetry rejects user content fields by contract", () => {
  const { root } = fixture("privacy-run-001");
  assert.throws(
    () => recordTelemetry(root, {
      runId: "privacy-run-001",
      eventType: "task_outcome",
      prompt: "sensitive source",
    }),
    (error) => error instanceof TelemetryError && error.code === "TELEMETRY_FIELD_FORBIDDEN",
  );
  assert.throws(
    () => recordTelemetry(root, {
      runId: "privacy-run-001",
      eventType: "task_outcome",
      metadata: { nested: { rawOutput: "sensitive" } },
    }),
    (error) => error instanceof TelemetryError && error.code === "TELEMETRY_FIELD_FORBIDDEN",
  );
  assert.throws(
    () => recordTelemetry(root, {
      runId: "privacy-run-001",
      eventType: "task_outcome",
      metadata: { note: "an arbitrary value is not metadata allowlisted by contract" },
    }),
    (error) => error instanceof TelemetryError && error.code === "TELEMETRY_FIELD_FORBIDDEN",
  );
  assert.throws(
    () => recordTelemetry(root, {
      runId: "privacy-run-001",
      eventType: "task_outcome",
      validationSummary: { total: 1, sourceCode: "sensitive" },
    }),
    (error) => error instanceof TelemetryError && error.code === "TELEMETRY_FIELD_FORBIDDEN",
  );
  assert.throws(
    () => recordTelemetry(root, {
      runId: { nested: { sourceCode: "sensitive" } },
      eventType: "task_outcome",
    }),
    (error) => error instanceof TelemetryError && error.code === "INVALID_TELEMETRY_STRING",
  );
  assert.throws(
    () => recordTelemetry(root, {
      runId: "privacy-run-001",
      eventType: "task_outcome",
      metadata: { firstPass: "source text disguised as a flag" },
    }),
    (error) => error instanceof TelemetryError && error.code === "INVALID_TELEMETRY_METADATA",
  );
  assert.throws(
    () => recordTelemetry(root, {
      runId: "privacy-run-001",
      eventType: "task_outcome",
      validationSummary: { total: -1 },
    }),
    (error) => error instanceof TelemetryError && error.code === "INVALID_VALIDATION_SUMMARY",
  );
});

test("telemetry retention is recoverable and OTLP output stays metadata-only", () => {
  const { root } = fixture("retention-run-001");
  recordTelemetry(root, {
    eventId: "old-event",
    eventType: "task_outcome",
    occurredAt: "2020-01-01T00:00:00.000Z",
    runId: "retention-run-001",
    taskId: "BE-01",
    result: "DONE",
  });
  recordTelemetry(root, {
    eventId: "new-event",
    eventType: "task_outcome",
    occurredAt: "2026-08-17T00:00:00.000Z",
    runId: "retention-run-001",
    taskId: "BE-02",
    result: "FAILED",
  });
  const preview = compactTelemetry(root, {
    now: "2026-08-18T00:00:00.000Z",
    retentionDays: 365,
  });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.after, 1);
  const applied = compactTelemetry(root, {
    now: "2026-08-18T00:00:00.000Z",
    retentionDays: 365,
    dryRun: false,
  });
  assert.ok(existsSync(applied.backup));
  assert.deepEqual(readTelemetry(root).map((event) => event.eventId), ["new-event"]);
  const payload = JSON.stringify(buildOtlpLogExport(root));
  assert.match(payload, /orchestrator\.taskId/);
  assert.doesNotMatch(payload, /prompt|rawOutput|sourceCode/);
});
