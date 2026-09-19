import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { renameWithRetry } from "./fs-retry.mjs";

import { artifactTreePath } from "./artifact-layout.mjs";

export class ExecutorControlError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ExecutorControlError";
    this.code = code;
    this.details = details;
  }
}

function redact(value) {
  return String(value ?? "")
    .replace(/(bearer\s+)[a-z0-9._~+\/-]+/gi, "$1[REDACTED]")
    .replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, 20_000);
}

function redactStructured(value, depth = 0) {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => redactStructured(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 500)) {
    output[key] = /token|password|secret|credential|api[_-]?key/i.test(key)
      ? "[REDACTED]"
      : redactStructured(item, depth + 1);
  }
  return output;
}

function replacePlaceholders(value, context) {
  return String(value).replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_match, key) => {
    const replacement = context[key];
    if (replacement == null) {
      throw new ExecutorControlError(
        "EXECUTOR_CONTROL_CONTEXT_MISSING",
        `Executor control action requires {${key}}`,
      );
    }
    return String(replacement);
  });
}

function assertInsideProject(projectRoot, value) {
  const root = resolve(projectRoot);
  const absolute = isAbsolute(value) ? resolve(value) : resolve(root, value);
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new ExecutorControlError(
      "EXECUTOR_CONTROL_CWD_OUTSIDE_PROJECT",
      `Executor control cwd must stay inside project: ${value}`,
    );
  }
  return absolute;
}

const EXECUTOR_KEYS = new Set(["codex", "agy"]);
const ACTION_KEYS = new Set(["probe", "interrupt", "dispatch"]);
const DEFINITION_KEYS = new Set([
  "command",
  "args",
  "cwd",
  "timeoutMs",
  "maxBuffer",
  "auditName",
  "inheritEnv",
]);

export function validateExecutorControlConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new ExecutorControlError(
      "INVALID_EXECUTOR_CONTROL_CONFIG",
      "Executor control configuration must be an object",
    );
  }
  const executors = Object.keys(config);
  if (executors.length === 0 || executors.some((key) => !EXECUTOR_KEYS.has(key))) {
    throw new ExecutorControlError(
      "INVALID_EXECUTOR_CONTROL_CONFIG",
      "Executor control configuration accepts only codex and agy",
    );
  }
  for (const [executor, actions] of Object.entries(config)) {
    if (!actions || typeof actions !== "object" || Array.isArray(actions)) {
      throw new ExecutorControlError(
        "INVALID_EXECUTOR_CONTROL_CONFIG",
        `${executor} control configuration must be an object`,
      );
    }
    const actionEntries = Object.entries(actions);
    if (actionEntries.length === 0 || actionEntries.some(([key]) => !ACTION_KEYS.has(key))) {
      throw new ExecutorControlError(
        "INVALID_EXECUTOR_CONTROL_CONFIG",
        `${executor} accepts only probe, interrupt, and dispatch actions`,
      );
    }
    for (const [action, definition] of actionEntries) {
      if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
        throw new ExecutorControlError(
          "INVALID_EXECUTOR_CONTROL_ACTION",
          `${executor}.${action} must be an object`,
        );
      }
      const unknown = Object.keys(definition).filter((key) => !DEFINITION_KEYS.has(key));
      if (unknown.length > 0) {
        throw new ExecutorControlError(
          "INVALID_EXECUTOR_CONTROL_ACTION",
          `${executor}.${action} contains unsupported fields: ${unknown.join(", ")}`,
        );
      }
      if (
        typeof definition.command !== "string" ||
        !definition.command.trim() ||
        /\{[^}]+\}/.test(definition.command) ||
        !Array.isArray(definition.args) ||
        definition.args.some((value) => typeof value !== "string")
      ) {
        throw new ExecutorControlError(
          "INVALID_EXECUTOR_CONTROL_ACTION",
          `${executor}.${action} requires a fixed command and args:string[]`,
        );
      }
      if (definition.cwd != null && typeof definition.cwd !== "string") {
        throw new ExecutorControlError("INVALID_EXECUTOR_CONTROL_ACTION", `${executor}.${action}.cwd must be a string`);
      }
      if (
        definition.timeoutMs != null &&
        (!Number.isInteger(definition.timeoutMs) ||
          definition.timeoutMs < 1_000 ||
          definition.timeoutMs > 600_000)
      ) {
        throw new ExecutorControlError("INVALID_EXECUTOR_CONTROL_ACTION", `${executor}.${action}.timeoutMs must be between 1000 and 600000`);
      }
      if (
        definition.maxBuffer != null &&
        (!Number.isInteger(definition.maxBuffer) ||
          definition.maxBuffer < 65_536 ||
          definition.maxBuffer > 16_777_216)
      ) {
        throw new ExecutorControlError("INVALID_EXECUTOR_CONTROL_ACTION", `${executor}.${action}.maxBuffer must be between 65536 and 16777216`);
      }
      if (definition.auditName != null && typeof definition.auditName !== "string") {
        throw new ExecutorControlError("INVALID_EXECUTOR_CONTROL_ACTION", `${executor}.${action}.auditName must be a string`);
      }
      if (definition.inheritEnv != null && typeof definition.inheritEnv !== "boolean") {
        throw new ExecutorControlError("INVALID_EXECUTOR_CONTROL_ACTION", `${executor}.${action}.inheritEnv must be boolean`);
      }
    }
  }
  return config;
}

export function readExecutorControlConfig(path) {
  if (!path) return null;
  try {
    const config = JSON.parse(readFileSync(resolve(path), "utf8"));
    return validateExecutorControlConfig(config);
  } catch (error) {
    throw new ExecutorControlError(
      "INVALID_EXECUTOR_CONTROL_CONFIG",
      `Could not read executor control config ${path}: ${error.message}`,
    );
  }
}

function parseResult(stdout, fallback) {
  if (!stdout.trim()) return fallback;
  try {
    const parsed = JSON.parse(stdout);
    return parsed && typeof parsed === "object" ? parsed : { ...fallback, output: parsed };
  } catch {
    return { ...fallback, output: redact(stdout) };
  }
}

export function executeExecutorControl(config, executor, action, context, options = {}) {
  validateExecutorControlConfig(config);
  const executorKey = String(executor ?? "").toLowerCase().includes("agy") ||
    String(executor ?? "").toLowerCase().includes("antigravity") ? "agy" : "codex";
  const definition = config?.[executorKey]?.[action];
  if (!definition) {
    throw new ExecutorControlError(
      "EXECUTOR_CONTROL_UNAVAILABLE",
      `No ${action} action is configured for ${executorKey}`,
    );
  }
  if (typeof definition.command !== "string" || !Array.isArray(definition.args ?? [])) {
    throw new ExecutorControlError(
      "INVALID_EXECUTOR_CONTROL_ACTION",
      `${executorKey}.${action} requires command:string and args:string[]`,
    );
  }
  const command = definition.command;
  const args = (definition.args ?? []).map((arg) => replacePlaceholders(arg, context));
  const cwd = assertInsideProject(
    options.projectRoot ?? process.cwd(),
    replacePlaceholders(definition.cwd ?? options.projectRoot ?? process.cwd(), context),
  );
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: Math.max(1_000, Number(definition.timeoutMs ?? options.timeoutMs ?? 30_000)),
    maxBuffer: Math.max(64 * 1024, Number(definition.maxBuffer ?? 2 * 1024 * 1024)),
    env: definition.inheritEnv === false ? {} : process.env,
  });
  const completedAt = new Date().toISOString();
  const fallback = {
    accepted: result.status === 0 && !result.error,
    action,
    executor: executorKey,
    exitCode: result.status,
    signal: result.signal ?? null,
    error: redact(result.error?.message ?? result.stderr),
  };
  const parsed = parseResult(String(result.stdout ?? ""), fallback);
  const redacted = redactStructured({
    ...parsed,
    accepted: parsed.accepted ?? fallback.accepted,
    control: {
      executor: executorKey,
      action,
      command: definition.auditName ?? command.split(/[\\/]/).at(-1),
      startedAt,
      completedAt,
      exitCode: result.status,
      signal: result.signal ?? null,
      stderr: redact(result.stderr),
    },
  });
  const bytes = Buffer.byteLength(JSON.stringify(redacted));
  if (bytes <= 128 * 1024) return redacted;
  return {
    accepted: Boolean(redacted.accepted),
    status: redacted.status ?? "UNKNOWN",
    state: redacted.state ?? null,
    error: redact(redacted.error),
    control: redacted.control,
    truncated: true,
    originalBytes: bytes,
  };
}

export function persistExecutorControlResult(artifactDir, taskId, result) {
  const directory = artifactTreePath(artifactDir, "executor-results").path;
  mkdirSync(directory, { recursive: true });
  const id = `executor-${String(taskId).toLowerCase()}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const path = join(directory, `${id}.json`);
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify({ schemaVersion: 1, id, taskId, result }, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameWithRetry(temporary, path);
  return { id, path, evidence: `executor-result:${id}` };
}
