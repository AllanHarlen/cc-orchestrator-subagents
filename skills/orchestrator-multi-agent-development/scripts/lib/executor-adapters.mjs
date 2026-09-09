const CANONICAL = new Set([
  "PENDING",
  "RUNNING",
  "DONE",
  "FAILED",
  "BLOCKED",
  "STALLED",
  "CANCELLED",
  "UNKNOWN",
  "QUOTA_EXHAUSTED",
  "QUOTA_EXAUSTED",
  "AUTH_REQUIRED",
  "AGY_MISSING",
  "TIMEOUT",
  "NEEDS_SYNC",
]);

const STATUS_ALIASES = new Map([
  ["COMPLETED", "DONE"],
  ["COMPLETE", "DONE"],
  ["SUCCESS", "DONE"],
  ["SUCCEEDED", "DONE"],
  ["IN_PROGRESS", "RUNNING"],
  ["IN PROGRESS", "RUNNING"],
  ["DISPATCHED", "RUNNING"],
  ["QUEUED", "PENDING"],
  ["ERROR", "FAILED"],
  ["TIMED_OUT", "TIMEOUT"],
  ["TIMED OUT", "TIMEOUT"],
  ["STOPPED", "CANCELLED"],
]);

function firstValue(object, keys) {
  for (const key of keys) {
    if (object?.[key] != null) return object[key];
  }
  return null;
}

function bounded(value, max = 2_000) {
  if (value == null) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function statusFromText(text) {
  const explicit = text.match(/(?:^|\n)\s*(?:Status|Estado)\s*:\s*([A-Z_ ]+)/i)?.[1]?.trim().toUpperCase();
  if (explicit) return STATUS_ALIASES.get(explicit) ?? (CANONICAL.has(explicit) ? explicit : null);
  const patterns = [
    [/quota|rate limit|resource exhausted|daily limit/i, "QUOTA_EXHAUSTED"],
    [/auth(?:entication)? required|login required|unauthorized/i, "AUTH_REQUIRED"],
    [/agy.+(?:not found|missing)|command not found.+agy/i, "AGY_MISSING"],
    [/timed? out|timeout/i, "TIMEOUT"],
    [/cancelled|canceled|interrupted/i, "CANCELLED"],
    [/\b(?:failed|failure|error)\b/i, "FAILED"],
  ];
  return patterns.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

function normalizeStatus(raw, text, executor) {
  const explicit = String(raw ?? "").trim().toUpperCase();
  let normalized = STATUS_ALIASES.get(explicit) ?? explicit;
  const textual = statusFromText(text);
  if (executor === "agy" && ["QUOTA_EXHAUSTED", "AUTH_REQUIRED", "AGY_MISSING", "TIMEOUT"].includes(textual)) {
    return textual === "QUOTA_EXHAUSTED" ? "QUOTA_EXAUSTED" : textual;
  }
  if (!CANONICAL.has(normalized)) normalized = textual;
  if (executor === "agy" && normalized === "QUOTA_EXHAUSTED") return "QUOTA_EXAUSTED";
  return normalized && CANONICAL.has(normalized) ? normalized : "UNKNOWN";
}

function normalizeFiles(value) {
  if (value == null) return [];
  const entries = Array.isArray(value) ? value : [value];
  return [...new Set(entries.map((entry) =>
    typeof entry === "string" ? entry : entry?.path,
  ).filter(Boolean).map(String))];
}

function normalizeValidations(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === "string") return { command: entry, status: "UNKNOWN" };
    return {
      command: entry.command ?? entry.name ?? "validation",
      status: String(entry.status ?? (entry.passed === true ? "PASS" : entry.passed === false ? "FAIL" : "UNKNOWN")).toUpperCase(),
      evidenceId: entry.evidenceId ?? entry.evidence_id ?? null,
    };
  });
}

const USAGE_KEY_ALIASES = Object.freeze({
  input_tokens: "inputTokens",
  inputTokens: "inputTokens",
  prompt_tokens: "inputTokens",
  promptTokens: "inputTokens",
  output_tokens: "outputTokens",
  outputTokens: "outputTokens",
  completion_tokens: "outputTokens",
  completionTokens: "outputTokens",
  cache_read_tokens: "cacheReadTokens",
  cacheReadTokens: "cacheReadTokens",
  cached_tokens: "cacheReadTokens",
  cachedTokens: "cacheReadTokens",
  total_tokens: "totalTokens",
  totalTokens: "totalTokens",
});

function normalizeUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage = {};
  for (const [key, raw] of Object.entries(value)) {
    const canonical = USAGE_KEY_ALIASES[key];
    const number = Number(raw);
    if (!canonical || !Number.isFinite(number) || number < 0) continue;
    usage[canonical] = Math.trunc(number);
  }
  if (usage.totalTokens == null && usage.inputTokens != null && usage.outputTokens != null) {
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  }
  return Object.keys(usage).length > 0 ? usage : null;
}

function normalizeRetryDirective(value, conversationId) {
  if (value == null || value === "") return null;
  const directive = String(value).trim();
  if (directive === "--continue") return directive;
  const match = directive.match(/^--conversation\s+([^\s]+)$/);
  if (!match || /[\r\n\0]/.test(match[1])) return null;
  if (conversationId && String(conversationId) !== match[1]) return null;
  return `--conversation ${match[1]}`;
}

function nonNegativeNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function summarizeAgyStream(raw) {
  const events = Array.isArray(raw?.events)
    ? raw.events
    : Array.isArray(raw?.progress_events)
      ? raw.progress_events
      : [];
  if (events.length === 0) return {};
  const init = events.find((event) => event?.event === "init");
  const final = [...events].reverse().find((event) => event?.event === "result" && event.result)?.result;
  const steps = events.filter((event) => event?.event === "step_update");
  const tools = steps
    .map((event) => event.step_update?.tool_info)
    .filter(Boolean);
  const timestamp = [...events].reverse().map((event) =>
    firstValue(event, ["timestamp", "occurredAt", "occurred_at", "updatedAt", "updated_at"]),
  ).find(Boolean);
  return {
    status: final?.status,
    reason: final?.error,
    error: final?.error,
    conversationId: final?.conversation_id ?? init?.conversation_id ?? init?.init?.conversation_id,
    usage: final?.usage,
    durationSeconds: final?.duration_seconds,
    numTurns: final?.num_turns,
    lastActivityAt: timestamp,
    apiCalls: steps.length,
    toolCalls: tools.length,
    currentTool: tools.at(-1)?.name ?? null,
    inTool: tools.length > 0 && !final,
  };
}

export function adaptExecutorProbe(executor, rawInput, options = {}) {
  const normalizedExecutor = String(executor ?? "").toLowerCase();
  if (!new Set(["codex", "agy"]).has(normalizedExecutor)) {
    const error = new Error(`Unsupported executor adapter: ${executor}`);
    error.code = "UNSUPPORTED_EXECUTOR_ADAPTER";
    throw error;
  }
  const raw = typeof rawInput === "string" ? { output: rawInput } : (rawInput ?? {});
  const stream = normalizedExecutor === "agy" ? summarizeAgyStream(raw) : {};
  const text = [
    raw.output,
    raw.result,
    raw.message,
    raw.reason,
    raw.error,
    raw.summary,
    stream.error,
  ].map((value) => bounded(value)).filter(Boolean).join("\n");
  const status = normalizeStatus(
    firstValue(raw, ["executorStatus", "status", "state", "resultStatus", "result_status"]) ?? stream.status,
    text,
    normalizedExecutor,
  );
  const reasonCode = [
    "QUOTA_EXHAUSTED",
    "QUOTA_EXAUSTED",
    "AUTH_REQUIRED",
    "AGY_MISSING",
    "TIMEOUT",
    "NEEDS_SYNC",
  ].includes(status) ? status : firstValue(raw, ["reasonCode", "reason_code"]);
  // A sessao Claude que disparou um trabalho, o job local do companion e a
  // thread Codex sao identidades diferentes.  Tratar todas como `sessionId`
  // impedia uma retomada precisa depois de reiniciar o processo pai.
  const sessionId = firstValue(raw, ["sessionId", "session_id"]);
  const jobId = normalizedExecutor === "codex"
    ? firstValue(raw, ["jobId", "job_id", "taskId", "task_id"])
    : null;
  const threadId = normalizedExecutor === "codex"
    ? firstValue(raw, ["threadId", "thread_id", "codexThreadId", "codex_thread_id"])
    : null;
  const conversationId = normalizedExecutor === "agy"
    ? firstValue(raw, ["conversationId", "conversation_id", "sessionId", "session_id"]) ?? stream.conversationId
    : null;
  const rawApiCalls = firstValue(raw, ["apiCalls", "api_calls"]) ?? stream.apiCalls;
  const rawToolCalls = firstValue(raw, ["toolCalls", "tool_calls"]) ?? stream.toolCalls;
  const retryDirective = normalizedExecutor === "agy"
    ? normalizeRetryDirective(firstValue(raw, ["retryDirective", "retry_directive", "retry"]), conversationId)
    : null;
  const probe = {
    executorStatus: status,
    reasonCode: reasonCode ?? null,
    reason: bounded(firstValue(raw, ["reason", "message", "summary"]) ?? stream.reason ?? text),
    error: bounded(firstValue(raw, ["error", "stderr"]) ?? stream.error),
    sessionId,
    jobId,
    threadId,
    conversationId,
    model: firstValue(raw, ["model", "modelName", "model_name"]),
    retryDirective,
    usage: normalizedExecutor === "agy" ? normalizeUsage(raw.usage ?? stream.usage) : null,
    durationSeconds: normalizedExecutor === "agy"
      ? nonNegativeNumber(firstValue(raw, ["durationSeconds", "duration_seconds"]) ?? stream.durationSeconds)
      : null,
    numTurns: normalizedExecutor === "agy"
      ? nonNegativeNumber(firstValue(raw, ["numTurns", "num_turns"]) ?? stream.numTurns)
      : null,
    lastActivityAt: firstValue(raw, ["lastActivityAt", "last_activity_at", "updatedAt", "updated_at"]) ?? stream.lastActivityAt,
    completedAt: firstValue(raw, ["completedAt", "completed_at", "finishedAt", "finished_at"]),
    apiCalls: rawApiCalls == null ? undefined : Number(rawApiCalls),
    toolCalls: rawToolCalls == null ? undefined : Number(rawToolCalls),
    currentTool: firstValue(raw, ["currentTool", "current_tool"]) ?? stream.currentTool,
    inTool: firstValue(raw, ["inTool", "in_tool"]) ?? stream.inTool,
    producedFiles: normalizeFiles(firstValue(raw, ["producedFiles", "produced_files", "files", "changedFiles"])),
    validations: normalizeValidations(firstValue(raw, ["validations", "checks", "tests"])),
    commitAfter: firstValue(raw, ["commitAfter", "commit_after", "commit", "head"]),
    adapter: {
      executor: normalizedExecutor,
      version: 2,
      authoritative: Boolean(options.authoritative ?? raw.authoritative ?? status !== "UNKNOWN"),
      rawStatus: firstValue(raw, ["executorStatus", "status", "state", "resultStatus", "result_status"]),
    },
  };
  if (status === "UNKNOWN") {
    probe.reasonCode = probe.reasonCode ?? "EXECUTOR_STATUS_UNKNOWN";
    probe.adapter.authoritative = false;
  }
  return probe;
}

export function adaptProbeSet(input, options = {}) {
  if (!input || typeof input !== "object") {
    const error = new Error("Executor input must be an object");
    error.code = "INVALID_EXECUTOR_INPUT";
    throw error;
  }
  const tasks = {};
  const source = input.tasks ?? input;
  for (const [taskId, raw] of Object.entries(source)) {
    const executor = raw.executor ?? options.executor;
    tasks[String(taskId).toUpperCase()] = adaptExecutorProbe(executor, raw, options);
  }
  return { schemaVersion: 1, tasks };
}
