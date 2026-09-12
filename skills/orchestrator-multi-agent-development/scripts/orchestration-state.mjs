#!/usr/bin/env node

import { readFileSync } from "node:fs";

import {
  OrchestrationStateError,
  applyProjectConfigToRun,
  auditRunCompletion,
  findRunDirectory,
  heartbeatTask,
  initRun,
  inspectProjectConfigDrift,
  reconcileRunAtDirectory,
  requestRunCancellation,
  resolveTaskScope,
  resumeRunAtDirectory,
  statusRun,
  sweepStalledTasks,
  syncRunFromArtifacts,
  updateCompletionGate,
  updatePhase,
  updateRunStatus,
  updateTaskLease,
  updateTaskStatus,
  updateTaskWorkspace,
  verifyRun,
} from "./lib/orchestration-state.mjs";

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      result._.push(token);
      continue;
    }

    const equals = token.indexOf("=");
    const key = token.slice(2, equals === -1 ? undefined : equals);
    let value = equals === -1 ? undefined : token.slice(equals + 1);
    if (value === undefined && argv[index + 1] && !argv[index + 1].startsWith("--")) {
      value = argv[index + 1];
      index += 1;
    }
    if (value === undefined) value = true;

    if (result[key] === undefined) result[key] = value;
    else if (Array.isArray(result[key])) result[key].push(value);
    else result[key] = [result[key], value];
  }
  return result;
}

function required(args, key, fallback = undefined) {
  const value = args[key] ?? fallback;
  if (value === undefined || value === "") {
    throw new OrchestrationStateError("MISSING_ARGUMENT", `Missing required argument --${key}`);
  }
  return value;
}

function number(value, fallback = undefined) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new OrchestrationStateError("INVALID_NUMBER", `Expected a number, received ${value}`);
  }
  return parsed;
}

function bool(value, fallback = undefined) {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (["true", "yes", "1"].includes(String(value).toLowerCase())) return true;
  if (["false", "no", "0"].includes(String(value).toLowerCase())) return false;
  throw new OrchestrationStateError("INVALID_BOOLEAN", `Expected a boolean, received ${value}`);
}

function commonOptions(args) {
  return {
    actor: args.actor ?? "orchestrator",
    projectRoot: args.root ?? process.cwd(),
    probeFile: args["probe-file"],
    now: args.now,
    staleIdleSeconds: number(args["stale-idle-seconds"]),
    staleInToolSeconds: number(args["stale-in-tool-seconds"]),
    stallGraceSeconds: number(args["stall-grace-seconds"]),
  };
}

function taskOptions(args) {
  const validations = args["validations-file"]
    ? JSON.parse(readFileSync(args["validations-file"], "utf8"))
    : undefined;
  // Achado 2: usage/durationSeconds/numTurns/retryDirective/resolvedModel ja
  // eram aceitos por mergeTaskFields (chegavam so pela via lifecycle/
  // reconcile), mas nenhum tinha flag de CLI — a run analisada nunca os
  // gravou porque nao havia como. --started-at/--completed-at (Achado 3)
  // permitem corrigir os extremos usados no calculo de `durationMs` para os
  // timestamps reais das CLIs, em vez do momento em que o orquestrador
  // processou o dispatch/resultado em lote.
  const usage = args["usage-file"]
    ? JSON.parse(readFileSync(args["usage-file"], "utf8"))
    : undefined;
  return {
    ...commonOptions(args),
    executor: args.executor,
    executorSource: args["executor-source"],
    model: args.model,
    complexity: args.complexity,
    sessionId: args["session-id"],
    conversationId: args["conversation-id"],
    resolvedModel: args["resolved-model"],
    codexEffort: args["codex-effort"],
    usage,
    durationSeconds: number(args["duration-seconds"]),
    activeDurationMs: number(args["active-duration-ms"]),
    queueDurationMs: number(args["queue-duration-ms"]),
    userWaitDurationMs: number(args["user-wait-duration-ms"]),
    numTurns: number(args["num-turns"]),
    retryDirective: args["retry-directive"],
    startedAt: args["started-at"],
    completedAt: args["completed-at"],
    activeDurationMs: number(args["active-duration-ms"]),
    queueDurationMs: number(args["queue-duration-ms"]),
    userWaitDurationMs: number(args["user-wait-duration-ms"]),
    commitBefore: args["commit-before"],
    commitAfter: args["commit-after"],
    reasonCode: args["reason-code"],
    reason: args.reason,
    currentTool: args["current-tool"],
    inTool: bool(args["in-tool"]),
    apiCalls: number(args["api-calls"]),
    toolCalls: number(args["tool-calls"]),
    expectedFiles: args["expected-file"],
    producedFiles: args["produced-file"],
    evidence: args.evidence,
    validations,
    reviewResult: args["review-result"],
    regressions: number(args.regressions),
    newAttempt: bool(args["new-attempt"]),
  };
}

function artifactDir(args, options = {}) {
  if (args.dir) return args.dir;
  return findRunDirectory({
    projectRoot: args.root ?? process.cwd(),
    runId: args["run-id"] ?? options.positionalRunId,
  });
}

function help() {
  return {
    name: "orchestration-state",
    purpose: "Durable state machine for cc-orchestrador-subagents",
    commands: {
      init: "init --slug <slug> [--dir .orchestration/<slug>] [--run-id <id>] [--phase 1] [--upstream-stage pensador --upstream-slug <slug> --upstream-version <n> --upstream-handoff-path <path>]",
      sync: "sync --dir .orchestration/<slug>",
      phase: "phase --dir <dir> --phase <n> --status RUNNING|DONE|FAILED|BLOCKED|CANCELLED|UNKNOWN|N/A [--reason <text>] (N/A exige --reason e so vale para fase com gate waivable)",
      gate: "gate --dir <dir> --gate <id> --status PENDING|RUNNING|DONE|FAILED|BLOCKED|N/A [--evidence <id>] [--required true|false for browserE2E] [--delegated-to <plugin>] (--delegated-to so com --status N/A num gate waivable; verificado contra report/handoff.json.nextStage.consumer em completionAudit)",
      task: "task --dir <dir> --task <id> --status <canonical-status> [--executor codex|agy|claude-code] [--executor-source project-config] [--resolved-model <id>] [--codex-effort low|medium|high] [--usage-file <path>] [--duration-seconds <n>] [--num-turns <n>] [--retry-directive <text>] [--started-at <iso>] [--completed-at <iso>] [session/evidence fields]",
      heartbeat: "heartbeat --dir <dir> --task <id> [--api-calls N] [--tool-calls N] [--current-tool name] [--progress-token value]",
      sweep: "sweep --dir <dir> [--stale-idle-seconds 450] [--stale-in-tool-seconds 1200]",
      reconcile: "reconcile --dir <dir> [--probe-file <json>]",
      resume: "resume [runId] [--root <project>] [--probe-file <json>]",
      "project-config-apply": "project-config-apply --dir <dir> --scope pending [--reason <text>] [--root <project>]",
      "project-config-drift": "project-config-drift --dir <dir> [--root <project>]",
      scope: "scope --dir <dir> --task <id> --decision REMOVE|REINSTATE --reason <text>",
      cancel: "cancel --dir <dir> --reason <text> [--finalize]",
      lease: "lease --dir <dir> --task <id> --action ACQUIRE|RENEW|RELEASE --owner-id <id> [--ttl-seconds 900]",
      workspace: "workspace --dir <dir> --task <id> --workspace-id <id> --status <status> [--path/--branch/--base-commit/--head-commit]",
      run: "run --dir <dir> --status PENDING|RUNNING|DONE|FAILED|BLOCKED|STALLED|CANCELLED|UNKNOWN|PARTIAL",
      audit: "audit --dir <dir>",
      status: "status [runId] [--root <project>]",
      verify: "verify --dir <dir>",
    },
    probeFileShape: {
      tasks: {
        "BE-01": {
          executorStatus: "DONE | RUNNING | FAILED | BLOCKED | STALLED | CANCELLED | UNKNOWN",
          lastActivityAt: "ISO-8601",
          producedFiles: ["relative/path"],
          validations: [{ command: "test command", status: "PASS | FAIL" }],
        },
      },
    },
  };
}

function execute(argv) {
  const [command = "help", ...rest] = argv;
  const args = parseArgs(rest);
  const common = commonOptions(args);

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      return help();
    case "init": {
      const slug = required(args, "slug", args._[0]);
      const upstreamStage = args["upstream-stage"];
      return initRun({
        ...common,
        slug,
        artifactDir: args.dir,
        runId: args["run-id"],
        phase: number(args.phase, 1),
        lastSafePhase: number(args["last-safe-phase"]),
        upstream: upstreamStage
          ? {
            stage: upstreamStage,
            slug: args["upstream-slug"],
            version: number(args["upstream-version"]),
            handoffPath: args["upstream-handoff-path"],
          }
          : undefined,
      });
    }
    case "sync":
      return syncRunFromArtifacts(artifactDir(args), common);
    case "phase":
      return updatePhase(
        artifactDir(args),
        required(args, "phase"),
        required(args, "status"),
        { ...common, reason: args.reason, evidence: args.evidence },
      );
    case "gate":
      return updateCompletionGate(
        artifactDir(args),
        required(args, "gate"),
        required(args, "status"),
        {
          ...common,
          reason: args.reason,
          evidence: args.evidence,
          required: bool(args.required),
          delegatedTo: args["delegated-to"],
        },
      );
    case "task":
      return updateTaskStatus(
        artifactDir(args),
        required(args, "task"),
        required(args, "status"),
        taskOptions(args),
      );
    case "heartbeat":
      return heartbeatTask(artifactDir(args), required(args, "task"), {
        ...common,
        apiCalls: number(args["api-calls"]),
        toolCalls: number(args["tool-calls"]),
        currentTool: args["current-tool"],
        inTool: bool(args["in-tool"]),
        progressToken: args["progress-token"],
      });
    case "sweep":
      return sweepStalledTasks(artifactDir(args), common);
    case "reconcile":
      return reconcileRunAtDirectory(artifactDir(args), common);
    case "resume": {
      const directory = artifactDir(args, { positionalRunId: args._[0] });
      return { artifactDir: directory, ...resumeRunAtDirectory(directory, common) };
    }
    case "project-config-apply": {
      const directory = artifactDir(args);
      return {
        artifactDir: directory,
        ...applyProjectConfigToRun(directory, {
          ...common,
          scope: args.scope ?? "pending",
          reason: args.reason,
        }),
      };
    }
    case "project-config-drift":
      return inspectProjectConfigDrift(artifactDir(args), common);
    case "scope":
      return resolveTaskScope(
        artifactDir(args),
        required(args, "task"),
        required(args, "decision"),
        { ...common, reason: required(args, "reason") },
      );
    case "cancel":
      if (bool(args.finalize, false)) {
        return updateRunStatus(artifactDir(args), "CANCELLED", {
          ...common,
          reason: args.reason,
        });
      }
      return requestRunCancellation(artifactDir(args), {
        ...common,
        reason: required(args, "reason"),
      });
    case "lease":
      return updateTaskLease(
        artifactDir(args),
        required(args, "task"),
        required(args, "action"),
        {
          ...common,
          ownerId: required(args, "owner-id"),
          ttlSeconds: number(args["ttl-seconds"]),
        },
      );
    case "workspace":
      return updateTaskWorkspace(
        artifactDir(args),
        required(args, "task"),
        {
          workspaceId: required(args, "workspace-id"),
          status: required(args, "status"),
          path: args.path,
          branch: args.branch,
          baseCommit: args["base-commit"],
          headCommit: args["head-commit"],
          integrationCommit: args["integration-commit"],
        },
        common,
      );
    case "run":
      return updateRunStatus(artifactDir(args), required(args, "status"), {
        ...common,
        reason: args.reason,
      });
    case "status": {
      const directory = artifactDir(args, { positionalRunId: args._[0] });
      return statusRun(directory);
    }
    case "audit":
      return { artifactDir: artifactDir(args), audit: auditRunCompletion(artifactDir(args)) };
    case "verify":
      return verifyRun(artifactDir(args));
    default:
      throw new OrchestrationStateError("UNKNOWN_COMMAND", `Unknown command: ${command}`);
  }
}

try {
  const result = execute(process.argv.slice(2));
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
} catch (error) {
  const known = error instanceof OrchestrationStateError;
  console.error(JSON.stringify({
    ok: false,
    error: {
      code: known ? error.code : "UNEXPECTED_ERROR",
      message: error.message,
      details: known ? error.details : undefined,
    },
  }, null, 2));
  process.exit(known && ["RUN_NOT_FOUND", "MISSING_ARGUMENT"].includes(error.code) ? 2 : 1);
}
