import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { loadRun } from "./orchestration-state.mjs";
import { projectKnowledgePaths } from "./project-knowledge.mjs";
import { stableJson } from "./sqlite-store.mjs";

export const TELEMETRY_SCHEMA_VERSION = 1;
const TELEMETRY_EVENT_TYPES = new Set(["task_outcome", "task_attempt_outcome", "routing_decision"]);

const ALLOWED_FIELDS = new Set([
  "schemaVersion",
  "eventId",
  "eventType",
  "occurredAt",
  "runId",
  "taskId",
  "taskType",
  "complexity",
  "executor",
  "model",
  "attempt",
  "startedAt",
  "completedAt",
  "durationMs",
  "activeDurationMs",
  "queueDurationMs",
  "userWaitDurationMs",
  "sessionId",
  "conversationId",
  "usage",
  "usageMissingExecutor",
  "result",
  "reasonCode",
  "errorFingerprint",
  "reviewResult",
  "regressions",
  "validationSummary",
  "filesChangedCount",
  "contractCount",
  "evidenceCount",
  "workspaceId",
  "sessionId",
  "conversationId",
  "usageMissingExecutor",
  "apiCalls",
  "toolCalls",
  "metadata",
]);

const FORBIDDEN_FIELD_PATTERN = /(?:prompt|content|sourceCode|diff|secret|token|password|credential|rawOutput)/i;
const ALLOWED_METADATA_FIELDS = new Set([
  "finalAttempt",
  "sourcePresent",
  "firstPass",
  "source",
  "reason",
  "heuristicBaseline",
  "fidelityFloor",
  "historicalSamples",
  "executorSource",
]);
const ALLOWED_VALIDATION_FIELDS = new Set(["total", "passed", "failed", "skipped", "status"]);
const OPTIONAL_STRING_FIELDS = new Set([
  "taskId",
  "taskType",
  "complexity",
  "executor",
  "model",
  "startedAt",
  "completedAt",
  "result",
  "reasonCode",
  "errorFingerprint",
  "reviewResult",
  "workspaceId",
  "sessionId",
  "conversationId",
  "usageMissingExecutor",
]);
const BOOLEAN_METADATA_FIELDS = new Set(["finalAttempt", "sourcePresent", "firstPass"]);
const STRING_METADATA_FIELDS = new Set([
  "source",
  "reason",
  "heuristicBaseline",
  "fidelityFloor",
  "executorSource",
]);

export class TelemetryError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "TelemetryError";
    this.code = code;
    this.details = details;
  }
}

function sha(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function durationMs(start, end) {
  if (!start || !end) return null;
  const value = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function sanitizeEvent(input) {
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key) || FORBIDDEN_FIELD_PATTERN.test(key)) {
      throw new TelemetryError(
        "TELEMETRY_FIELD_FORBIDDEN",
        `Telemetry field is not allowed by the privacy contract: ${key}`,
      );
    }
  }
  const event = {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    eventId: input.eventId ?? randomUUID(),
    eventType: input.eventType ?? "task_outcome",
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    ...input,
  };
  if (!event.runId || !event.eventId || !event.eventType) {
    throw new TelemetryError("INVALID_TELEMETRY_EVENT", "Telemetry requires runId, eventId, and eventType");
  }
  if (event.schemaVersion !== TELEMETRY_SCHEMA_VERSION) {
    throw new TelemetryError(
      "INVALID_TELEMETRY_SCHEMA_VERSION",
      `Telemetry schemaVersion must be ${TELEMETRY_SCHEMA_VERSION}`,
    );
  }
  for (const key of ["eventId", "eventType", "occurredAt", "runId"]) {
    if (typeof event[key] !== "string" || !event[key].trim()) {
      throw new TelemetryError(
        "INVALID_TELEMETRY_STRING",
        `Telemetry ${key} must be a non-empty string`,
      );
    }
  }
  for (const key of OPTIONAL_STRING_FIELDS) {
    if (event[key] != null && typeof event[key] !== "string") {
      throw new TelemetryError(
        "INVALID_TELEMETRY_STRING",
        `Telemetry ${key} must be a string or null`,
      );
    }
  }
  if (!TELEMETRY_EVENT_TYPES.has(event.eventType)) {
    throw new TelemetryError(
      "INVALID_TELEMETRY_EVENT_TYPE",
      `Unsupported telemetry eventType: ${event.eventType}`,
    );
  }
  if (!Number.isFinite(Date.parse(event.occurredAt))) {
    throw new TelemetryError("INVALID_TELEMETRY_TIME", "Telemetry occurredAt must be ISO-8601");
  }
  for (const key of [
    "attempt",
    "durationMs",
    "activeDurationMs",
    "queueDurationMs",
    "userWaitDurationMs",
    "regressions",
    "filesChangedCount",
    "contractCount",
    "evidenceCount",
    "apiCalls",
    "toolCalls",
  ]) {
    if (event[key] != null && (!Number.isInteger(event[key]) || event[key] < 0)) {
      throw new TelemetryError(
        "INVALID_TELEMETRY_NUMBER",
        `Telemetry ${key} must be a non-negative integer`,
      );
    }
  }
  if (event.usage != null) {
    const allowedUsage = new Set(["inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens", "totalProcessedTokens", "totalTokens"]);
    if (typeof event.usage !== "object" || Array.isArray(event.usage)) throw new TelemetryError("INVALID_TELEMETRY_USAGE", "Telemetry usage must be an object or null");
    for (const [key, value] of Object.entries(event.usage)) {
      if (!allowedUsage.has(key) || !Number.isInteger(value) || value < 0) throw new TelemetryError("INVALID_TELEMETRY_USAGE", `Invalid telemetry usage field: ${key}`);
    }
  }
  for (const [key, value] of Object.entries(event)) {
    if (typeof value === "string" && value.length > 512) {
      throw new TelemetryError(
        "TELEMETRY_VALUE_TOO_LONG",
        `Telemetry metadata value exceeds 512 characters: ${key}`,
      );
    }
  }
  if (event.metadata != null) {
    if (typeof event.metadata !== "object" || Array.isArray(event.metadata)) {
      throw new TelemetryError("INVALID_TELEMETRY_METADATA", "Telemetry metadata must be an object");
    }
    for (const [key, value] of Object.entries(event.metadata)) {
      if (!ALLOWED_METADATA_FIELDS.has(key) || FORBIDDEN_FIELD_PATTERN.test(key)) {
        throw new TelemetryError(
          "TELEMETRY_FIELD_FORBIDDEN",
          `Telemetry metadata field is not allowlisted: metadata.${key}`,
        );
      }
      if (value != null && typeof value === "object") {
        throw new TelemetryError(
          "INVALID_TELEMETRY_METADATA",
          `Telemetry metadata must be scalar: metadata.${key}`,
        );
      }
      if (BOOLEAN_METADATA_FIELDS.has(key) && typeof value !== "boolean") {
        throw new TelemetryError(
          "INVALID_TELEMETRY_METADATA",
          `Telemetry metadata.${key} must be boolean`,
        );
      }
      if (STRING_METADATA_FIELDS.has(key) && value != null && typeof value !== "string") {
        throw new TelemetryError(
          "INVALID_TELEMETRY_METADATA",
          `Telemetry metadata.${key} must be a string or null`,
        );
      }
      if (
        key === "historicalSamples" &&
        (!Number.isInteger(value) || value < 0)
      ) {
        throw new TelemetryError(
          "INVALID_TELEMETRY_METADATA",
          "Telemetry metadata.historicalSamples must be a non-negative integer",
        );
      }
      if (typeof value === "string" && value.length > 512) {
        throw new TelemetryError(
          "TELEMETRY_VALUE_TOO_LONG",
          `Telemetry metadata value exceeds 512 characters: metadata.${key}`,
        );
      }
    }
  }
  if (event.validationSummary != null) {
    if (typeof event.validationSummary !== "object" || Array.isArray(event.validationSummary)) {
      throw new TelemetryError(
        "INVALID_VALIDATION_SUMMARY",
        "Telemetry validationSummary must be an object",
      );
    }
    for (const [key, value] of Object.entries(event.validationSummary)) {
      if (!ALLOWED_VALIDATION_FIELDS.has(key) || FORBIDDEN_FIELD_PATTERN.test(key)) {
        throw new TelemetryError(
          "TELEMETRY_FIELD_FORBIDDEN",
          `Telemetry validation field is not allowlisted: validationSummary.${key}`,
        );
      }
      if (key === "status" && typeof value !== "string") {
        throw new TelemetryError(
          "INVALID_VALIDATION_SUMMARY",
          "Telemetry validationSummary.status must be a string",
        );
      }
      if (key === "status" && value.length > 64) {
        throw new TelemetryError(
          "TELEMETRY_VALUE_TOO_LONG",
          "Telemetry validationSummary.status exceeds 64 characters",
        );
      }
      if (
        key !== "status" &&
        (!Number.isInteger(value) || value < 0)
      ) {
        throw new TelemetryError(
          "INVALID_VALIDATION_SUMMARY",
          `Telemetry validationSummary.${key} must be a non-negative integer`,
        );
      }
    }
  }
  return event;
}

function appendDurably(path, event) {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(event)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readTelemetry(projectRoot) {
  const path = projectKnowledgePaths(projectRoot).telemetryFile;
  if (!existsSync(path)) return [];
  const events = [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    try {
      events.push(JSON.parse(lines[index]));
    } catch (error) {
      throw new TelemetryError(
        "INVALID_TELEMETRY_LOG",
        `${path}:${index + 1} contains invalid JSON: ${error.message}`,
      );
    }
  }
  return events;
}

// `existingIds`, when passed, lets a caller that records many events in a
// loop (see `projectRunTelemetry`) hoist the dedup Set out of the loop
// instead of re-reading and re-parsing the entire telemetry log on every
// single call — without it, N events cost O(N^2) instead of O(N). The Set
// is mutated in place (the new eventId is added on a successful append) so
// the next call in the same loop sees it. A single ad hoc call (no
// `existingIds`) keeps the original behavior: read fresh every time.
export function recordTelemetry(projectRoot, input, existingIds = null) {
  const event = sanitizeEvent(input);
  const path = projectKnowledgePaths(projectRoot).telemetryFile;
  const existing = existingIds ?? new Set(readTelemetry(projectRoot).map((entry) => entry.eventId));
  if (existing.has(event.eventId)) return { created: false, event, path };
  appendDurably(path, event);
  existing.add(event.eventId);
  return { created: true, event, path };
}

function validationSummary(task) {
  const values = task.validations ?? [];
  return {
    total: values.length,
    passed: values.filter((item) =>
      ["PASS", "PASSED", "SUCCESS", "OK"].includes(String(item.status ?? item.passed).toUpperCase()),
    ).length,
    failed: values.filter((item) =>
      ["FAIL", "FAILED", "ERROR"].includes(String(item.status ?? item.passed).toUpperCase()),
    ).length,
  };
}

export function projectRunTelemetry(projectRoot, artifactDir) {
  const state = loadRun(resolve(artifactDir), { verifyReplay: true }).state;
  // Hoisted once instead of recomputed by every recordTelemetry call below —
  // see the comment on recordTelemetry's `existingIds` parameter.
  const existingIds = new Set(readTelemetry(projectRoot).map((entry) => entry.eventId));
  const projected = [];
  for (const task of Object.values(state.tasks ?? {})) {
    for (const attempt of task.attemptHistory ?? []) {
      const attemptResult = attempt.status ?? "UNKNOWN";
      if (!["DONE", "FAILED", "BLOCKED", "CANCELLED"].includes(attemptResult)) continue;
      const attemptEventId = `tel-attempt-${sha(`${state.runId}\0${task.id}\0${attempt.attempt}\0${attemptResult}\0${attempt.completedAt ?? attempt.startedAt}`).slice(0, 24)}`;
      projected.push(recordTelemetry(projectRoot, {
        eventId: attemptEventId,
        eventType: "task_attempt_outcome",
        occurredAt: attempt.completedAt ?? attempt.startedAt ?? task.updatedAt,
        runId: state.runId,
        taskId: task.id,
        taskType: task.category ?? null,
        complexity: task.complexity ?? null,
        executor: attempt.executor ?? task.executor ?? null,
        model: attempt.model ?? task.model ?? null,
        attempt: Number(attempt.attempt ?? 0),
        startedAt: attempt.startedAt ?? null,
        completedAt: attempt.completedAt ?? null,
        durationMs: Number.isFinite(attempt.durationMs) ? Number(attempt.durationMs) : null,
        activeDurationMs: Number.isFinite(attempt.activeDurationMs) ? Number(attempt.activeDurationMs) : null,
        queueDurationMs: Number.isFinite(attempt.queueDurationMs) ? Number(attempt.queueDurationMs) : 0,
        userWaitDurationMs: Number.isFinite(attempt.userWaitDurationMs) ? Number(attempt.userWaitDurationMs) : 0,
        sessionId: attempt.sessionId ?? null,
        conversationId: attempt.conversationId ?? null,
        usage: attempt.usage ?? null,
        usageMissingExecutor: attempt.usage ? null : (attempt.executor ?? task.executor ?? "unknown"),
        result: attemptResult,
        reasonCode: attempt.reasonCode ?? null,
        errorFingerprint: attempt.reasonCode ? sha(String(attempt.reasonCode).toLowerCase()) : null,
        reviewResult: attempt.reviewResult ?? null,
        regressions: Number(attempt.regressions ?? 0),
        validationSummary: { total: 0, passed: 0, failed: 0 },
        filesChangedCount: 0,
        contractCount: Number(task.contractIds?.length ?? 0),
        evidenceCount: Number(task.evidence?.length ?? 0),
        workspaceId: task.workspace?.id ?? task.workspace?.workspaceId ?? null,
        apiCalls: Number(task.apiCalls ?? 0),
        toolCalls: Number(task.toolCalls ?? 0),
        metadata: {
          finalAttempt: Number(attempt.attempt) === Number(task.attempt),
          executorSource: attempt.executorSource ?? task.executorSource ?? null,
        },
      }, existingIds));
    }
    const result = task.status;
    // Telemetry is an outcome ledger. Reconciliation updates are useful in
    // events.jsonl, but emitting PENDING/RUNNING/UNKNOWN snapshots here makes
    // every harmless sweep look like a new task result.
    if (!["DONE", "FAILED", "BLOCKED", "CANCELLED"].includes(result)) continue;
    const reason = task.reasonCode ?? task.reconciliation?.reason ?? null;
    const completedAt = task.completedAt ?? task.attemptHistory?.findLast?.((entry) =>
      Number(entry.attempt) === Number(task.attempt),
    )?.completedAt ?? null;
    const eventId = `tel-${sha(`${state.runId}\0${task.id}\0${task.attempt}\0${result}\0${completedAt ?? "pending"}`).slice(0, 24)}`;
    projected.push(recordTelemetry(projectRoot, {
      eventId,
      eventType: "task_outcome",
      occurredAt: completedAt ?? task.updatedAt,
      runId: state.runId,
      taskId: task.id,
      taskType: task.category ?? null,
      complexity: task.complexity ?? null,
      executor: task.executor ?? null,
      model: task.model ?? null,
      attempt: Number(task.attempt ?? 0),
      startedAt: task.startedAt ?? null,
      completedAt,
      durationMs: durationMs(task.startedAt, completedAt),
      result,
      reasonCode: task.reasonCode ?? null,
      errorFingerprint: reason ? sha(String(reason).toLowerCase().replace(/\d+/g, "#")) : null,
      reviewResult: task.reviewResult ?? null,
      regressions: Number(task.regressions ?? 0),
      validationSummary: validationSummary(task),
      filesChangedCount: Number(task.reconciliation?.changedFiles?.length ?? 0),
      contractCount: Number(task.contractIds?.length ?? 0),
      evidenceCount: Number(task.evidence?.length ?? 0),
      workspaceId: task.workspace?.id ?? task.workspace?.workspaceId ?? null,
      apiCalls: Number(task.apiCalls ?? 0),
      toolCalls: Number(task.toolCalls ?? 0),
      metadata: {
        firstPass: Number(task.attempt ?? 0) === 1,
        sourcePresent: task.sourcePresent !== false,
        executorSource: task.executorSource ?? null,
      },
    }, existingIds));
  }
  return {
    runId: state.runId,
    events: projected.length,
    created: projected.filter((entry) => entry.created).length,
    duplicates: projected.filter((entry) => !entry.created).length,
  };
}

function aggregate(events, keys) {
  const groups = new Map();
  for (const event of events.filter((entry) => entry.eventType === "task_outcome")) {
    const id = keys.map((key) => event[key] ?? "unknown").join("|");
    if (!groups.has(id)) {
      groups.set(id, {
        dimensions: Object.fromEntries(keys.map((key) => [key, event[key] ?? null])),
        tasks: 0,
        successes: 0,
        firstPassSuccesses: 0,
        reviewFailures: 0,
        regressions: 0,
        durationTotalMs: 0,
        durationSamples: 0,
      });
    }
    const group = groups.get(id);
    group.tasks += 1;
    const success = event.result === "DONE" && !["FAIL", "FAILED"].includes(event.reviewResult);
    if (success) group.successes += 1;
    if (success && Number(event.attempt) === 1) group.firstPassSuccesses += 1;
    if (["FAIL", "FAILED"].includes(event.reviewResult)) group.reviewFailures += 1;
    group.regressions += Number(event.regressions ?? 0);
    if (Number.isFinite(event.durationMs)) {
      group.durationTotalMs += Number(event.durationMs);
      group.durationSamples += 1;
    }
  }
  return [...groups.values()].map((group) => ({
    ...group.dimensions,
    tasks: group.tasks,
    successRate: group.tasks ? group.successes / group.tasks : null,
    firstPassSuccessRate: group.tasks ? group.firstPassSuccesses / group.tasks : null,
    reviewFailureRate: group.tasks ? group.reviewFailures / group.tasks : null,
    averageDurationMs: group.durationSamples
      ? Math.round(group.durationTotalMs / group.durationSamples)
      : null,
    regressions: group.regressions,
  })).sort((left, right) => right.tasks - left.tasks || stableJson(left).localeCompare(stableJson(right)));
}

export function telemetryReport(projectRoot, options = {}) {
  const events = readTelemetry(projectRoot);
  const outcomes = events.filter((entry) => entry.eventType === "task_outcome");
  return {
    path: projectKnowledgePaths(projectRoot).telemetryFile,
    eventCount: events.length,
    taskOutcomes: outcomes.length,
    byExecutor: aggregate(outcomes, ["executor"]),
    byModel: aggregate(outcomes, ["executor", "model"]),
    byTaskType: aggregate(outcomes, ["taskType", "complexity"]),
    detailed: options.detailed
      ? aggregate(outcomes, ["taskType", "complexity", "executor", "model"])
      : undefined,
  };
}

function atomicTelemetryWrite(path, events) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    const content = events.map((event) => JSON.stringify(event)).join("\n") +
      (events.length ? "\n" : "");
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

export function compactTelemetry(projectRoot, options = {}) {
  const paths = projectKnowledgePaths(projectRoot);
  const events = readTelemetry(projectRoot);
  const now = Date.parse(options.now ?? new Date().toISOString());
  const retentionDays = Math.max(1, Number(options.retentionDays ?? 365));
  const cutoff = now - retentionDays * 86_400_000;
  const deduplicated = [...new Map(events.map((event) => [event.eventId, event])).values()];
  const kept = deduplicated.filter((event) => {
    const time = Date.parse(event.occurredAt ?? "");
    return !Number.isFinite(time) || time >= cutoff;
  });
  const result = {
    dryRun: options.dryRun !== false,
    path: paths.telemetryFile,
    retentionDays,
    before: events.length,
    after: kept.length,
    duplicatesRemoved: events.length - deduplicated.length,
    expiredRemoved: deduplicated.length - kept.length,
    backup: null,
  };
  if (result.dryRun || result.before === result.after) return result;
  const backupDir = join(paths.orchestratorRoot, "backups", "telemetry");
  mkdirSync(backupDir, { recursive: true });
  const stamp = (options.now ?? new Date().toISOString()).replace(/[:.]/g, "-");
  const backup = join(backupDir, `telemetry-${stamp}-${randomUUID().slice(0, 8)}.jsonl`);
  if (existsSync(paths.telemetryFile)) copyFileSync(paths.telemetryFile, backup);
  atomicTelemetryWrite(paths.telemetryFile, kept);
  result.backup = backup;
  return result;
}

function otlpValue(value) {
  if (typeof value === "boolean") return { boolValue: value };
  if (Number.isInteger(value)) return { intValue: String(value) };
  if (typeof value === "number") return { doubleValue: value };
  if (typeof value === "object") return { stringValue: stableJson(value) };
  return { stringValue: String(value) };
}

function severity(event) {
  if (["FAILED", "BLOCKED"].includes(event.result)) {
    return { severityNumber: 17, severityText: "ERROR" };
  }
  if (["STALLED", "UNKNOWN"].includes(event.result)) {
    return { severityNumber: 13, severityText: "WARN" };
  }
  return { severityNumber: 9, severityText: "INFO" };
}

function epochNanoseconds(value, fallbackMilliseconds = 0) {
  const parsed = Date.parse(value ?? "");
  const milliseconds = Number.isFinite(parsed)
    ? Math.max(0, Math.trunc(parsed))
    : Math.max(0, Math.trunc(fallbackMilliseconds));
  return String(BigInt(milliseconds) * 1_000_000n);
}

export function buildOtlpLogExport(projectRoot, options = {}) {
  const events = readTelemetry(projectRoot);
  const since = options.since ? Date.parse(options.since) : null;
  const selected = events.filter((event) => {
    const time = Date.parse(event.occurredAt ?? "");
    return since == null || !Number.isFinite(time) || time >= since;
  }).slice(-Math.max(1, Number(options.limit ?? 10_000)));
  return {
    resourceLogs: [{
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: options.serviceName ?? "cc-orchestrador-subagents" } },
          { key: "telemetry.sdk.language", value: { stringValue: "nodejs" } },
          { key: "orchestrator.privacy", value: { stringValue: "metadata-only" } },
        ],
      },
      scopeLogs: [{
        scope: { name: "orchestrator.telemetry", version: "1" },
        logRecords: selected.map((event) => ({
          timeUnixNano: epochNanoseconds(event.occurredAt),
          observedTimeUnixNano: epochNanoseconds(null, Date.now()),
          ...severity(event),
          body: { stringValue: event.eventType },
          attributes: Object.entries(event)
            .filter(([key, value]) =>
              !["schemaVersion", "eventType", "occurredAt", "metadata"].includes(key) && value != null,
            )
            .map(([key, value]) => ({ key: `orchestrator.${key}`, value: otlpValue(value) })),
        })),
      }],
    }],
  };
}

export async function exportTelemetryOtlp(projectRoot, options = {}) {
  if (!options.endpoint) {
    throw new TelemetryError("OTLP_ENDPOINT_REQUIRED", "OTLP export requires an explicit endpoint");
  }
  const endpoint = new URL(options.endpoint);
  if (!new Set(["https:", "http:"]).has(endpoint.protocol)) {
    throw new TelemetryError("INVALID_OTLP_ENDPOINT", "OTLP endpoint must use HTTP or HTTPS");
  }
  if (
    endpoint.protocol === "http:" &&
    !["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname) &&
    !options.allowInsecure
  ) {
    throw new TelemetryError(
      "INSECURE_OTLP_ENDPOINT",
      "Non-local OTLP HTTP export requires explicit allowInsecure=true",
    );
  }
  const payload = buildOtlpLogExport(projectRoot, options);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(Math.max(1_000, Number(options.timeoutMs ?? 30_000))),
  });
  const body = (await response.text()).slice(0, 2_000);
  if (!response.ok) {
    throw new TelemetryError(
      "OTLP_EXPORT_FAILED",
      `OTLP endpoint returned ${response.status}`,
      { status: response.status, body },
    );
  }
  return {
    endpoint: endpoint.toString(),
    status: response.status,
    exported: payload.resourceLogs[0].scopeLogs[0].logRecords.length,
    response: body,
  };
}
