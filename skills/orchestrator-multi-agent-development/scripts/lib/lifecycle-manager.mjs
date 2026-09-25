import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { renameWithRetry } from "./fs-retry.mjs";

import { artifactExists, artifactWritePath } from "./artifact-layout.mjs";
import { adaptProbeSet } from "./executor-adapters.mjs";
import {
  executeExecutorControl,
  persistExecutorControlResult,
  readExecutorControlConfig,
} from "./executor-control.mjs";
import { projectRunHistory } from "./orchestration-history.mjs";
import {
  heartbeatTask,
  loadRun,
  reconcileRunAtDirectory,
  resumeRunAtDirectory,
  sweepStalledTasks,
  requestRunCancellation,
  updateRunStatus,
  updateTaskLease,
  updateTaskStatus,
} from "./orchestration-state.mjs";
import { projectRunTelemetry } from "./telemetry.mjs";

export class LifecycleManagerError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "LifecycleManagerError";
    this.code = code;
    this.details = details;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (error) {
    throw new LifecycleManagerError(
      "INVALID_LIFECYCLE_INPUT",
      `Could not read lifecycle input ${path}: ${error.message}`,
    );
  }
}

function writeAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameWithRetry(temporary, path);
}

function mergeProbeSets(...sets) {
  const tasks = {};
  for (const set of sets.filter(Boolean)) Object.assign(tasks, set.tasks ?? {});
  return { schemaVersion: 1, tasks };
}

function controlContext(task, projectRoot, artifactDir, extra = {}) {
  return {
    taskId: task.id,
    executor: task.executor,
    sessionId: task.sessionId,
    jobId: task.jobId ?? null,
    threadId: task.threadId ?? null,
    conversationId: task.conversationId,
    retryDirective: task.retryDirective,
    attempt: task.attempt,
    projectRoot,
    artifactDir,
    ...extra,
  };
}

function controlledProbes(artifactDir, projectRoot, options) {
  const config = readExecutorControlConfig(options.adapterConfig);
  // A ausencia de configuracao e observavel: nao devemos fingir que um
  // processo desconhecido ainda esta vivo. A reconciliacao o manterá UNKNOWN
  // e pedirá uma probe explícita, em vez de deixar RUNNING eterno.
  if (!config) return { tasks: {}, results: [] };
  const state = loadRun(artifactDir).state;
  const tasks = {};
  const results = [];
  for (const task of Object.values(state.tasks ?? {}).filter((item) =>
    ["RUNNING", "STALLED", "UNKNOWN"].includes(item.status),
  )) {
    try {
      const raw = executeExecutorControl(
        config,
        task.executor,
        "probe",
        controlContext(task, projectRoot, artifactDir),
        { projectRoot },
      );
      const persisted = persistExecutorControlResult(artifactDir, task.id, raw);
      tasks[task.id] = adaptProbeSet({ [task.id]: { ...raw, executor: task.executor } }, {
        executor: task.executor,
      }).tasks[task.id];
      results.push({ taskId: task.id, ok: true, persisted });
    } catch (error) {
      if (error?.code === "EXECUTOR_CONTROL_UNAVAILABLE") {
        results.push({ taskId: task.id, ok: false, code: error.code, message: error.message });
        continue;
      }
      throw error;
    }
  }
  return { tasks, results };
}

function normalizedProbe(artifactDir, projectRoot, options) {
  const sets = [];
  if (options.probeFile) sets.push(readJson(options.probeFile));
  if (options.codexFile) sets.push(adaptProbeSet(readJson(options.codexFile), { executor: "codex" }));
  if (options.agyFile) sets.push(adaptProbeSet(readJson(options.agyFile), { executor: "agy" }));
  const controlled = controlledProbes(artifactDir, projectRoot, options);
  sets.push({ schemaVersion: 1, tasks: controlled.tasks });
  return { probe: mergeProbeSets(...sets), controlResults: controlled.results };
}

function lifecycleActions(state) {
  const actions = [];
  for (const task of Object.values(state.tasks ?? {})) {
    if (task.status === "RUNNING") {
      actions.push({ taskId: task.id, action: "MONITOR", priority: "normal" });
    } else if (task.status === "STALLED") {
      actions.push({
        taskId: task.id,
        action: task.stall?.graceExpiredAt ? "INTERRUPT_THEN_RECONCILE" : "MONITOR_GRACE",
        priority: task.stall?.graceExpiredAt ? "high" : "normal",
        graceUntil: task.stall?.graceUntil ?? null,
      });
    } else if (task.status === "UNKNOWN") {
      actions.push({
        taskId: task.id,
        action: "PROBE_BEFORE_REEXECUTE",
        priority: "high",
        executor: task.executor,
        sessionId: task.sessionId,
        conversationId: task.conversationId,
      });
    } else if (task.status === "BLOCKED") {
      actions.push({
        taskId: task.id,
        action: "RESOLVE_BLOCKER",
        priority: "high",
        reasonCode: task.reasonCode,
      });
    } else if (task.status === "FAILED") {
      actions.push({
        taskId: task.id,
        action: "INSPECT_PARTIAL_THEN_RETRY",
        priority: "high",
        reasonCode: task.reasonCode,
      });
    }
  }
  return actions;
}

function applyObservedHeartbeats(artifactDir, probe, options) {
  const state = loadRun(artifactDir).state;
  const heartbeats = [];
  for (const [taskId, observation] of Object.entries(probe.tasks ?? {})) {
    const task = state.tasks?.[taskId];
    if (!task || !["RUNNING", "STALLED"].includes(task.status)) continue;
    const status = String(observation.executorStatus ?? "").toUpperCase();
    if (status !== "RUNNING") continue;
    const result = heartbeatTask(artifactDir, taskId, {
      projectRoot: options.projectRoot,
      actor: "lifecycle-manager",
      apiCalls: observation.apiCalls,
      toolCalls: observation.toolCalls,
      currentTool: observation.currentTool,
      inTool: observation.inTool,
      progressToken: observation.lastActivityAt,
      now: observation.lastActivityAt ?? options.now,
    });
    let lease = null;
    const ownerId = task.sessionId ?? task.conversationId ?? `${task.executor ?? "executor"}:${task.id}:${task.attempt}`;
    try {
      const currentLease = loadRun(artifactDir).state.tasks[taskId].lease;
      const active = currentLease?.status === "ACTIVE" && Date.parse(currentLease.expiresAt) > Date.parse(observation.lastActivityAt ?? options.now ?? new Date().toISOString());
      lease = updateTaskLease(artifactDir, taskId, active ? "RENEW" : "ACQUIRE", {
        projectRoot: options.projectRoot,
        ownerId,
        ttlSeconds: options.leaseTtlSeconds,
        actor: "lifecycle-manager",
        now: observation.lastActivityAt ?? options.now,
      }).lease;
    } catch (error) {
      lease = { error: { code: error?.code ?? "LEASE_UPDATE_FAILED", message: error?.message ?? String(error) } };
    }
    heartbeats.push({ taskId, changed: result.changed, lease });
  }
  return heartbeats;
}

function releaseTerminalLeases(artifactDir, projectRoot, now) {
  const state = loadRun(artifactDir).state;
  const released = [];
  for (const task of Object.values(state.tasks ?? {})) {
    if (!["DONE", "FAILED", "BLOCKED", "CANCELLED"].includes(task.status) || task.lease?.status !== "ACTIVE") continue;
    try {
      released.push({
        taskId: task.id,
        lease: updateTaskLease(artifactDir, task.id, "RELEASE", {
          projectRoot,
          ownerId: task.lease.ownerId,
          actor: "lifecycle-manager",
          now,
        }).lease,
      });
    } catch (error) {
      released.push({ taskId: task.id, error: { code: error?.code, message: error?.message } });
    }
  }
  return released;
}

export function tickLifecycle(artifactDir, options = {}) {
  const directory = resolve(artifactDir);
  const projectRoot = resolve(options.projectRoot ?? join(directory, "..", ".."));
  const { probe, controlResults } = normalizedProbe(directory, projectRoot, options);
  const probePath = artifactWritePath(directory, "lifecycle-probe.json").path;
  mkdirSync(dirname(probePath), { recursive: true });
  // Hermes-style delivery invariant: persist the normalized external result
  // before any state transition or user-facing recommendation consumes it.
  writeAtomic(probePath, probe);

  let heartbeats = [];
  let sweep = null;
  let reconciliation;
  if (options.resume) {
    reconciliation = resumeRunAtDirectory(directory, {
      projectRoot,
      probeFile: probePath,
      actor: "lifecycle-manager",
      now: options.now,
    });
  } else {
    heartbeats = applyObservedHeartbeats(directory, probe, { projectRoot, now: options.now });
    // A tick is a poll: no event when nothing changed (sweep keeps a heartbeat) and no full replay
    // verification of the log (explicit `reconcile`/`resume` still verify). Performance finding: a
    // real run polled every 30 s and each tick replayed the whole 10 MB events.jsonl several times.
    sweep = sweepStalledTasks(directory, {
      projectRoot,
      actor: "lifecycle-manager",
      now: options.now,
      staleIdleSeconds: options.staleIdleSeconds,
      staleInToolSeconds: options.staleInToolSeconds,
      stallGraceSeconds: options.stallGraceSeconds,
      skipIfUnchanged: options.persistEveryTick !== true,
    });
    reconciliation = reconcileRunAtDirectory(directory, {
      projectRoot,
      probeFile: probePath,
      actor: "lifecycle-manager",
      now: options.now,
      verifyReplay: false,
      skipIfUnchanged: options.persistEveryTick !== true,
    });
  }
  const releasedLeases = releaseTerminalLeases(directory, projectRoot, options.now);
  const quiet = !options.resume && sweep?.skipped === true && reconciliation?.skipped === true
    && heartbeats.length === 0 && releasedLeases.length === 0;
  let observability = null;
  if (quiet) {
    // Nothing was persisted: the history/telemetry projections would only recompute the same rows.
    observability = { skipped: true };
  } else {
    try {
      observability = {
        history: projectRunHistory(projectRoot, directory),
        telemetry: projectRunTelemetry(projectRoot, directory),
      };
    } catch (error) {
      observability = {
        error: {
          code: error?.code ?? "OBSERVABILITY_PROJECTION_FAILED",
          message: error?.message ?? String(error),
        },
      };
    }
  }
  return {
    artifactDir: directory,
    probePath,
    probeTasks: Object.keys(probe.tasks ?? {}).length,
    controlResults,
    heartbeats,
    releasedLeases,
    sweep: sweep
      ? { changed: sweep.changed, skipped: sweep.skipped === true, stalled: sweep.stalled, graceExpired: sweep.graceExpired }
      : null,
    quiet,
    summary: reconciliation.summary,
    report: reconciliation.report,
    actions: lifecycleActions(reconciliation.state),
    observability,
  };
}

export function interruptTaskLifecycle(artifactDir, taskId, options = {}) {
  const state = loadRun(artifactDir).state;
  const normalizedTaskId = String(taskId).toUpperCase();
  const task = state.tasks?.[normalizedTaskId];
  if (!task) throw new LifecycleManagerError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
  if (!["RUNNING", "STALLED"].includes(task.status)) {
    throw new LifecycleManagerError(
      "INTERRUPT_NOT_ALLOWED",
      `Task ${normalizedTaskId} is ${task.status}; only RUNNING/STALLED tasks can be interrupted`,
    );
  }
  let persisted = null;
  if (options.adapterConfig) {
    const config = readExecutorControlConfig(options.adapterConfig);
    const raw = executeExecutorControl(
      config,
      task.executor,
      "interrupt",
      controlContext(task, resolve(options.projectRoot ?? join(resolve(artifactDir), "..", "..")), resolve(artifactDir), {
        reason: options.reason ?? "Lifecycle manager interruption",
      }),
      { projectRoot: resolve(options.projectRoot ?? join(resolve(artifactDir), "..", "..")) },
    );
    persisted = persistExecutorControlResult(artifactDir, task.id, raw);
    if (!raw.accepted) {
      throw new LifecycleManagerError(
        "EXECUTOR_INTERRUPT_REJECTED",
        `Executor did not accept interruption for ${normalizedTaskId}`,
        { result: persisted },
      );
    }
  } else if (!options.externalConfirmed) {
    throw new LifecycleManagerError(
      "EXECUTOR_CONTROL_REQUIRED",
      "Provide --adapter-config or explicitly confirm an external interrupt before changing ownership to UNKNOWN",
    );
  }
  const updated = updateTaskStatus(artifactDir, normalizedTaskId, "UNKNOWN", {
    projectRoot: options.projectRoot,
    actor: "lifecycle-manager",
    reasonCode: "INTERRUPT_REQUESTED",
    reason: options.reason ?? "Lifecycle manager requested executor interruption",
    evidence: [options.evidence, persisted?.evidence].filter(Boolean),
  });
  return { ...updated, controlResult: persisted };
}

export function retryTaskLifecycle(artifactDir, taskId, options = {}) {
  const state = loadRun(artifactDir).state;
  const normalizedTaskId = String(taskId).toUpperCase();
  const task = state.tasks?.[normalizedTaskId];
  if (!task) throw new LifecycleManagerError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
  if (!["FAILED", "BLOCKED", "STALLED", "UNKNOWN"].includes(task.status)) {
    throw new LifecycleManagerError(
      "RETRY_NOT_ALLOWED",
      `Task ${normalizedTaskId} is ${task.status}; retry requires FAILED/BLOCKED/STALLED/UNKNOWN`,
    );
  }
  if (["STALLED", "UNKNOWN"].includes(task.status) && !options.confirmedGone) {
    throw new LifecycleManagerError(
      "EXECUTOR_LIVENESS_UNCONFIRMED",
      `Confirm the previous ${task.executor ?? "executor"} session is gone before retrying ${normalizedTaskId}`,
    );
  }
  if (!task.reconciliation && task.status !== "FAILED") {
    throw new LifecycleManagerError(
      "RECONCILIATION_REQUIRED",
      `Task ${normalizedTaskId} must be reconciled before retry`,
    );
  }
  let rawDispatch = null;
  let persisted = null;
  if (options.adapterConfig) {
    const config = readExecutorControlConfig(options.adapterConfig);
    rawDispatch = executeExecutorControl(
      config,
      options.executor ?? task.executor,
      "dispatch",
      controlContext(task, resolve(options.projectRoot ?? join(resolve(artifactDir), "..", "..")), resolve(artifactDir), {
        reason: options.reason ?? "Retry after reconciliation",
      }),
      { projectRoot: resolve(options.projectRoot ?? join(resolve(artifactDir), "..", "..")) },
    );
    persisted = persistExecutorControlResult(artifactDir, task.id, rawDispatch);
    const adapted = adaptProbeSet({ [task.id]: { ...rawDispatch, executor: options.executor ?? task.executor } }, {
      executor: options.executor ?? task.executor,
    }).tasks[task.id];
    if (!rawDispatch.accepted || adapted.executorStatus !== "RUNNING") {
      throw new LifecycleManagerError(
        "EXECUTOR_DISPATCH_UNCONFIRMED",
        `Retry dispatch for ${normalizedTaskId} did not return authoritative RUNNING`,
        { result: persisted, status: adapted.executorStatus },
      );
    }
    options.sessionId = adapted.sessionId ?? options.sessionId;
    options.conversationId = adapted.conversationId ?? options.conversationId;
    options.resolvedModel = adapted.model ?? options.resolvedModel;
  } else if (!options.externalConfirmed) {
    throw new LifecycleManagerError(
      "EXECUTOR_DISPATCH_REQUIRED",
      "Provide --adapter-config or explicitly confirm an external dispatch before marking a retry RUNNING",
    );
  }
  const updated = updateTaskStatus(artifactDir, normalizedTaskId, "RUNNING", {
    projectRoot: options.projectRoot,
    actor: "lifecycle-manager",
    executor: options.executor ?? task.executor,
    sessionId: options.sessionId,
    conversationId: options.conversationId ?? task.conversationId,
    resolvedModel: options.resolvedModel,
    retryDirective: options.retryDirective ?? task.retryDirective,
    reasonCode: null,
    reason: options.reason ?? "Retry after reconciliation",
    evidence: [options.evidence, persisted?.evidence].filter(Boolean),
    newAttempt: true,
  });
  return { ...updated, controlResult: persisted };
}

export function cancelRunLifecycle(artifactDir, options = {}) {
  const directory = resolve(artifactDir);
  const projectRoot = resolve(options.projectRoot ?? join(directory, "..", ".."));
  const before = loadRun(directory).state;
  const active = Object.values(before.tasks ?? {}).filter((task) =>
    ["RUNNING", "STALLED", "UNKNOWN"].includes(task.status),
  );
  const requested = requestRunCancellation(directory, {
    projectRoot,
    actor: "lifecycle-manager",
    reason: options.reason,
    now: options.now,
  });
  const interrupts = [];
  for (const task of active) {
    if (!options.adapterConfig && !options.externalConfirmed) {
      interrupts.push({ taskId: task.id, accepted: false, code: "EXECUTOR_CONTROL_REQUIRED" });
      continue;
    }
    try {
      let persisted = null;
      if (options.adapterConfig) {
        const raw = executeExecutorControl(
          readExecutorControlConfig(options.adapterConfig),
          task.executor,
          "interrupt",
          controlContext(task, projectRoot, directory, { reason: options.reason }),
          { projectRoot },
        );
        persisted = persistExecutorControlResult(directory, task.id, raw);
        if (!raw.accepted) throw new Error("interrupt rejected");
      }
      interrupts.push({ taskId: task.id, accepted: true, persisted });
    } catch (error) {
      interrupts.push({ taskId: task.id, accepted: false, code: error?.code, message: error?.message });
    }
  }
  let reconciliation = null;
  // Sempre persiste ao menos uma reconciliacao de cancelamento/reinicio. Isto
  // torna a retomada idempotente mesmo quando o watcher anterior morreu.
  reconciliation = tickLifecycle(directory, { ...options, projectRoot, resume: false });
  const after = loadRun(directory).state;
  const nonTerminal = Object.values(after.tasks ?? {}).filter((task) =>
    !["DONE", "FAILED", "BLOCKED", "CANCELLED"].includes(task.status),
  );
  let finalization = null;
  if (options.finalize && nonTerminal.length === 0) {
    finalization = updateRunStatus(directory, "CANCELLED", {
      projectRoot,
      actor: "lifecycle-manager",
      reason: options.reason,
      now: options.now,
    });
  }
  return {
    requested: requested.summary,
    interrupts,
    reconciliation,
    pendingTasks: nonTerminal.map((task) => ({ id: task.id, status: task.status })),
    finalization: finalization?.summary ?? null,
  };
}

// Tasks a watch loop still needs to keep an eye on. Once none of these remain
// (or the run itself reached a terminal status), further ticks would just
// reconfirm nothing changed — stop instead of running unattended forever.
const ACTIVE_TASK_STATUSES = new Set(["RUNNING", "STALLED", "UNKNOWN"]);
const TERMINAL_RUN_STATUSES = new Set(["DONE", "CANCELLED", "PARTIAL"]);

function watchStopReason(summary) {
  if (!summary) return null;
  if (TERMINAL_RUN_STATUSES.has(summary.status)) return "RUN_TERMINAL";
  const hasActiveTask = Object.entries(summary.counts ?? {}).some(
    ([status, count]) => ACTIVE_TASK_STATUSES.has(status) && count > 0,
  );
  return hasActiveTask ? null : "NO_ACTIVE_TASKS";
}

export async function watchLifecycle(artifactDir, options = {}) {
  const baseIntervalMs = Math.max(1_000, Number(options.intervalSeconds ?? 30) * 1000);
  // Quiet ticks back off exponentially up to maxIntervalSeconds (default 120 s, never below the
  // base); any change resets to the base interval. Stall thresholds are minutes (450 s idle), so a
  // two-minute ceiling cannot hide a STALLED transition for long.
  const maxIntervalMs = Math.max(baseIntervalMs, Number(options.maxIntervalSeconds ?? 120) * 1000);
  let intervalMs = baseIntervalMs;
  const maxTicks = options.maxTicks == null ? Number.POSITIVE_INFINITY : Math.max(1, Number(options.maxTicks));
  const autoStop = options.autoStop !== false;
  const results = [];
  let stoppedReason = null;
  for (let index = 0; index < maxTicks; index += 1) {
    if (autoStop && TERMINAL_RUN_STATUSES.has(loadRun(artifactDir).state.status)) {
      stoppedReason = "RUN_TERMINAL";
      break;
    }
    const result = tickLifecycle(artifactDir, options);
    results.push(result);
    if (typeof options.onTick === "function") {
      options.onTick({
        tick: index + 1,
        ranAt: new Date().toISOString(),
        summary: result.summary,
        sweep: result.sweep,
        actions: result.actions,
      });
    }
    if (autoStop) {
      stoppedReason = watchStopReason(result.summary);
      if (stoppedReason) break;
    }
    if (index + 1 >= maxTicks) break;
    intervalMs = result.quiet ? Math.min(intervalMs * 2, maxIntervalMs) : baseIntervalMs;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  return {
    ticks: results.length,
    last: results.at(-1),
    stoppedReason,
    results: options.includeAll ? results : undefined,
  };
}

export function lifecycleProbeExists(artifactDir) {
  return artifactExists(artifactDir, "lifecycle-probe.json");
}
