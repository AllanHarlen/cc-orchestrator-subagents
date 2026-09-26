import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { renameWithRetry } from "./fs-retry.mjs";
import { validateUiEvidence } from "../validate-ui-evidence.mjs";
import { validateHandoff } from "./handoff-validator.mjs";
import {
  ARTIFACT_LAYOUT_VERSION,
  SUPPORTED_ARTIFACT_LAYOUT_VERSIONS,
  artifactExists,
  artifactTreePath,
  currentRunsRoot,
  ensureArtifactLayout,
  resolveArtifact,
  runRootCandidates,
} from "./artifact-layout.mjs";
import {
  DEFAULT_QUOTA_FALLBACK_CHAIN,
  EXECUTORS,
  EXECUTOR_SOURCE_PROJECT_CONFIG,
  PROJECT_CONFIG_SCHEMA_VERSION,
  ProjectConfigError,
  QUOTA_FALLBACK_FIELD,
  QUOTA_FALLBACK_VALUES,
  ROLES,
  diffProjectConfig,
  diffQuotaFallbackChain,
  projectConfigPath,
  readProjectConfig,
  resolveExecutorForCategory,
} from "./project-config.mjs";

export const STATE_SCHEMA_VERSION = 1;
export const EVENT_SCHEMA_VERSION = 1;

export const TASK_STATUSES = Object.freeze([
  "PENDING",
  "RUNNING",
  "DONE",
  "FAILED",
  "BLOCKED",
  "STALLED",
  "CANCELLED",
  "UNKNOWN",
]);

export const PHASE_STATUSES = Object.freeze([
  "PENDING",
  "RUNNING",
  "DONE",
  "FAILED",
  "BLOCKED",
  "CANCELLED",
  "UNKNOWN",
  // Fase legitimamente pulada — aceito somente para fases cujo completion gate
  // e `waivable` (hoje so 9.5/browserE2E), e somente com `reason`. Ver
  // assertPhaseTransition e updatePhase. Distinto de "nunca rodou" (PENDING):
  // N/A e uma decisao registrada, nao um estado transitorio.
  "N/A",
]);

export const RUN_STATUSES = Object.freeze([
  "PENDING",
  "RUNNING",
  "DONE",
  "FAILED",
  "BLOCKED",
  "STALLED",
  "CANCELLED",
  "UNKNOWN",
  "PARTIAL",
]);

export const GATE_STATUSES = Object.freeze([
  "PENDING",
  "RUNNING",
  "DONE",
  "FAILED",
  "BLOCKED",
  "N/A",
]);

const TASK_STATUS_SET = new Set(TASK_STATUSES);
const PHASE_STATUS_SET = new Set(PHASE_STATUSES);
const RUN_STATUS_SET = new Set(RUN_STATUSES);
const GATE_STATUS_SET = new Set(GATE_STATUSES);
const TERMINAL_TASK_STATUSES = new Set(["DONE", "CANCELLED"]);
const TERMINAL_RUN_STATUSES = new Set(["DONE", "CANCELLED", "PARTIAL"]);
const ACTIVE_RUN_STATUSES = new Set([
  "PENDING",
  "RUNNING",
  "FAILED",
  "BLOCKED",
  "STALLED",
  "UNKNOWN",
]);

const RUN_TRANSITIONS = Object.freeze({
  PENDING: new Set(["RUNNING", "BLOCKED", "CANCELLED", "UNKNOWN"]),
  RUNNING: new Set(["DONE", "FAILED", "BLOCKED", "STALLED", "CANCELLED", "UNKNOWN", "PARTIAL"]),
  DONE: new Set(),
  FAILED: new Set(["RUNNING", "BLOCKED", "CANCELLED", "UNKNOWN", "PARTIAL"]),
  BLOCKED: new Set(["RUNNING", "FAILED", "CANCELLED", "UNKNOWN", "PARTIAL"]),
  STALLED: new Set(["RUNNING", "FAILED", "BLOCKED", "CANCELLED", "UNKNOWN", "PARTIAL"]),
  CANCELLED: new Set(),
  UNKNOWN: new Set(["RUNNING", "FAILED", "BLOCKED", "STALLED", "CANCELLED", "PARTIAL"]),
  PARTIAL: new Set(),
});

export const COMPLETION_GATE_DEFINITIONS = Object.freeze({
  // Achado 2: a fase 6 (monitoring) nunca fechava porque nada exigia
  // evidencia dela — telemetria por task ficou vazia em 33/33 e o sweeper de
  // stall nunca rodou em 3h30. Este gate torna a fase 6 tao obrigatoria
  // quanto qualquer outra: fechar a fase 7 sem fechar a 6 e agora impossivel
  // (assertPhaseTransition), e fechar a 6 sem evidencia tambem
  // (GATE_DONE_REQUIRES_EVIDENCE em updateCompletionGate). Acompanhamento
  // (analise-run-oficina-saas-20260906.md): evidencia por si so nao provava
  // que o monitoramento rodou *durante* a fase, so que algo foi escrito antes
  // de fecha-la — uma wave inteira podia terminar em segundo plano sem que
  // tick/watch/sweep nunca rodasse. updateCompletionGate agora tambem exige
  // `lifecycle.lastSweepAt` presente (GATE_MONITORING_REQUIRES_SWEEP).
  // Achado (analise sessao Codex 2026-09-11): a Fase 4 instruia rodar
  // materialize-visual-handoff.mjs "antes do dispatch" apenas em prosa
  // (references/workflow.md, references/subagent-prompts.md) — nada impedia
  // uma task front-end ser despachada sem o pacote de design/assets ter sido
  // de fato materializado. O sintoma so aparecia depois, de forma indireta e
  // dificil de diagnosticar, no gate visualAudit (imagens quebradas/ausentes
  // sem apontar a causa raiz). Este gate torna a materializacao tao
  // obrigatoria quanto qualquer outra: fechar a fase 5 sem fechar a fase 4
  // e agora impossivel (assertPhaseTransition), e fechar a 4 sem evidencia
  // tambem (GATE_DONE_REQUIRES_EVIDENCE em updateCompletionGate).
  visualMaterialization: { phase: 4, label: "Design package materialization" },
  contractsInspected: { phase: 4, label: "Contract completeness inspection" },
  infraSmokeTest: { phase: 4, label: "Docker/infra early smoke test" },
  monitoring: { phase: 6, label: "Monitoring telemetry" },
  // Audit finding (OficinaAI, 2026-09): the handoff declared prism/schemathesis and nothing ever ran
  // them; 422-vs-409 and error-code divergences only surfaced in the human review. Waivable only with a
  // reason (no machine-readable HTTP contract, e.g. a worker-only back-end).
  apiContractValidation: {
    phase: 8,
    label: "API contract conformance (running API)",
    waivable: true,
    // N/A only for a closed set of reasons, which then mean "not applicable" (no PARTIAL at completion)
    // instead of "verification skipped".
    notApplicableReasons: ["NO_HTTP_API", "NO_MACHINE_READABLE_CONTRACT"],
  },
  backendReview: { phase: 8, label: "Back-end review" },
  frontendReview: { phase: 9, label: "Front-end review" },
  visualAudit: { phase: 9, label: "Semantic UI/UX evidence" },
  browserE2E: { phase: 9.5, label: "Real-browser E2E" },
  requirementsCoverage: { phase: 10, label: "Requirements evidence" },
  reports: { phase: 10, label: "Reports" },
  handoff: { phase: 10, label: "Handoff" },
  delivery: { phase: 11, label: "Delivery" },
  learning: { phase: 12, label: "Learning" },
});

const TASK_TRANSITIONS = Object.freeze({
  PENDING: new Set(["RUNNING", "BLOCKED", "CANCELLED", "UNKNOWN"]),
  RUNNING: new Set(["DONE", "FAILED", "BLOCKED", "STALLED", "CANCELLED", "UNKNOWN"]),
  DONE: new Set(),
  FAILED: new Set(["RUNNING", "BLOCKED", "CANCELLED", "UNKNOWN"]),
  BLOCKED: new Set(["RUNNING", "CANCELLED", "UNKNOWN"]),
  STALLED: new Set(["RUNNING", "FAILED", "BLOCKED", "CANCELLED", "UNKNOWN"]),
  CANCELLED: new Set(),
  UNKNOWN: new Set(["RUNNING", "DONE", "FAILED", "BLOCKED", "STALLED", "CANCELLED"]),
});

const CATEGORY_VALUES = [
  "BACKEND_ONLY",
  "FRONTEND_ONLY",
  "FULLSTACK",
  "DATABASE_ONLY",
  "REVIEW_ONLY",
  "DOCS_ONLY",
];

// O lookahead descarta versao (`gemini-3.5`): sem ele, o nome de modelo AGY presente em
// tasks-classification.md/waves.md seria lido como task e criaria uma entrada fantasma.
// scripts/validate-routing.mjs precisa usar exatamente esta mesma gramatica.
const TASK_ID_SOURCE = "(?:[A-Z]{1,8}-\\d{1,4}(?!\\.\\d)(?:-[A-Z0-9]+)?|T\\d+(?:-[A-Z0-9]+)?)";
const TASK_ID_RE = new RegExp(`\\b${TASK_ID_SOURCE}\\b`, "gi");
const TASK_ID_EXACT_RE = new RegExp(`^${TASK_ID_SOURCE}$`, "i");
// Achado 11: `CT-08` (identificador de contrato, secao "Contratos" da Fase 4
// — `contracts/CT-01.md` .. `CT-NN.md`) casa com a mesma gramatica de task ID
// (`[A-Z]{1,8}-\d{1,4}`) e acabava virando entrada fantasma no namespace de
// `tasks`, com `executor: "agy"` e status `CANCELLED`, reportada em
// `sync.missingFromSource` a cada sync. Prefixos aqui nunca sao lidos como
// task ID, mesmo quando aparecem em `tasks-classification.md`/`waves.md`
// (ex.: numa tabela de rastreamento task -> contrato).
const RESERVED_TASK_ID_PREFIXES = new Set(["CT"]);
const PHASE_NAMES = Object.freeze({
  0: "preflight",
  1: "specification-ingestion",
  2: "task-classification",
  3: "waves",
  4: "contracts-and-design-materialization",
  5: "delegation",
  6: "monitoring",
  7: "integration",
  8: "backend-review",
  9: "frontend-review",
  9.5: "browser-e2e",
  10: "reports-and-handoff",
  11: "delivery",
  12: "learning",
});
const PHASE_SEQUENCE = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 9.5, 10, 11, 12]);

export class OrchestrationStateError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "OrchestrationStateError";
    this.code = code;
    this.details = details;
  }
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function iso(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new OrchestrationStateError("INVALID_TIME", `Invalid timestamp: ${value}`);
  }
  return date.toISOString();
}

function asDate(value = new Date()) {
  return value instanceof Date ? value : new Date(value);
}

function toPosix(value) {
  return value.split(sep).join("/");
}

function safeJsonParse(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new OrchestrationStateError(
      "INVALID_JSON",
      `${label} contains invalid JSON: ${error.message}`,
    );
  }
}

function stateFile(artifactDir) {
  return join(resolve(artifactDir), "state.json");
}

function eventsFile(artifactDir) {
  return join(resolve(artifactDir), "events.jsonl");
}

function lockFile(artifactDir) {
  return join(resolve(artifactDir), ".state.lock");
}

function sleepSync(milliseconds) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function acquireLock(artifactDir, options = {}) {
  const directory = resolve(artifactDir);
  mkdirSync(directory, { recursive: true });
  const path = lockFile(directory);
  const attempts = Number(options.lockAttempts ?? 40);
  const retryMs = Number(options.lockRetryMs ?? 50);
  const staleMs = Number(options.lockStaleMs ?? 120_000);
  const token = randomUUID();

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      const payload = JSON.stringify({
        token,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      });
      writeFileSync(fd, `${payload}\n`, "utf8");
      fsyncSync(fd);
      return { fd, path, token };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;

      try {
        const info = safeJsonParse(readFileSync(path, "utf8"), path);
        const ageMs = Date.now() - new Date(info.acquiredAt).getTime();
        if (ageMs > staleMs && !pidIsAlive(Number(info.pid))) {
          unlinkSync(path);
          continue;
        }
      } catch (readError) {
        if (readError?.code === "ENOENT") continue;
        try {
          const ageMs = Date.now() - statSync(path).mtimeMs;
          if (ageMs > staleMs) {
            unlinkSync(path);
            continue;
          }
        } catch (statError) {
          if (statError?.code === "ENOENT") continue;
        }
      }

      if (attempt < attempts - 1) sleepSync(retryMs);
    }
  }

  throw new OrchestrationStateError(
    "STATE_LOCKED",
    `Could not acquire orchestration state lock: ${path}`,
  );
}

function releaseLock(lock) {
  try {
    closeSync(lock.fd);
  } finally {
    try {
      const current = safeJsonParse(readFileSync(lock.path, "utf8"), lock.path);
      if (current.token === lock.token) unlinkSync(lock.path);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        // A stale lock is safer than deleting a lock now owned by another process.
      }
    }
  }
}

function withLock(artifactDir, callback, options = {}) {
  const lock = acquireLock(artifactDir, options);
  try {
    return callback();
  } finally {
    releaseLock(lock);
  }
}

function appendEventDurably(path, event) {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(event)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export { renameWithRetry };

function writeSnapshotAtomically(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.state.${process.pid}.${randomUUID()}.tmp`,
  );
  let fd;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameWithRetry(temporary, path);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // Preserve the original error.
    }
    throw error;
  }
}

function repairIncompleteEventTail(path) {
  if (!existsSync(path)) return false;
  const contents = readFileSync(path);
  if (contents.length === 0 || contents.at(-1) === 0x0a) return false;

  const lastNewline = contents.lastIndexOf(0x0a);
  const tailStart = lastNewline + 1;
  const tail = contents.subarray(tailStart).toString("utf8").trim();
  let keepTail = false;
  if (tail) {
    try {
      JSON.parse(tail);
      keepTail = true;
    } catch {
      // An incomplete final event was never durable and is safe to discard.
    }
  }

  const fd = openSync(path, keepTail ? "a" : "r+");
  try {
    if (keepTail) {
      writeFileSync(fd, "\n", "utf8");
    } else {
      ftruncateSync(fd, tailStart);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

function readEvents(artifactDir) {
  const path = eventsFile(artifactDir);
  if (!existsSync(path)) return { events: [], truncatedTail: false };
  const contents = readFileSync(path, "utf8");
  const lines = contents.split(/\r?\n/);
  const events = [];
  let truncatedTail = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      const isTruncatedTail = index === lines.length - 1 && !contents.endsWith("\n");
      if (isTruncatedTail) {
        truncatedTail = true;
        break;
      }
      throw new OrchestrationStateError(
        "INVALID_JSON",
        `${path}:${index + 1} contains invalid JSON: ${error.message}`,
      );
    }
    if (
      event.eventSchemaVersion !== EVENT_SCHEMA_VERSION ||
      !event.eventId ||
      !Number.isInteger(event.revision) ||
      event.revision < 1 ||
      !event.type
    ) {
      throw new OrchestrationStateError(
        "INVALID_EVENT",
        `${path}:${index + 1} is not a valid orchestration event`,
        { event },
      );
    }
    events.push(event);
  }
  return { events, truncatedTail };
}

function validateTask(taskId, task) {
  if (!TASK_ID_EXACT_RE.test(taskId)) {
    throw new OrchestrationStateError("INVALID_TASK_ID", `Invalid task id: ${taskId}`);
  }
  if (!TASK_STATUS_SET.has(task.status)) {
    throw new OrchestrationStateError(
      "INVALID_TASK_STATUS",
      `Task ${taskId} has invalid status ${task.status}`,
    );
  }
  if (!Number.isInteger(task.attempt) || task.attempt < 0) {
    throw new OrchestrationStateError(
      "INVALID_ATTEMPT",
      `Task ${taskId} has invalid attempt ${task.attempt}`,
    );
  }
  for (const field of ["apiCalls", "toolCalls"]) {
    if (!Number.isInteger(task[field]) || task[field] < 0) {
      throw new OrchestrationStateError(
        "INVALID_ACTIVITY_COUNTER",
        `Task ${taskId} has invalid ${field} ${task[field]}`,
      );
    }
  }
  if (
    task.executorSource != null &&
    (typeof task.executorSource !== "string" || task.executorSource.trim() === "")
  ) {
    throw new OrchestrationStateError(
      "INVALID_EXECUTOR_SOURCE",
      `Task ${taskId} has invalid executorSource ${JSON.stringify(task.executorSource)}`,
    );
  }
}

function validateCompletionGates(gates) {
  if (gates == null) return;
  if (typeof gates !== "object" || Array.isArray(gates)) {
    throw new OrchestrationStateError(
      "INVALID_COMPLETION_GATES",
      "completionGates must be an object",
    );
  }
  for (const [gateId, definition] of Object.entries(COMPLETION_GATE_DEFINITIONS)) {
    const gate = gates[gateId];
    // Legacy runs predate the semantic evidence gate. They remain readable;
    // a new run receives this gate from synchronizeCompletionGates().
    if (!gate && ["requirementsCoverage", "contractsInspected", "infraSmokeTest", "apiContractValidation"].includes(gateId)) continue;
    if (!gate || !GATE_STATUS_SET.has(gate.status)) {
      throw new OrchestrationStateError(
        "INVALID_COMPLETION_GATE",
        `Completion gate ${gateId} is missing or has an invalid status`,
      );
    }
    if (typeof gate.required !== "boolean") {
      throw new OrchestrationStateError(
        "INVALID_COMPLETION_GATE",
        `Completion gate ${gateId} must declare required as a boolean`,
      );
    }
    if (gate.requiredOverride != null && typeof gate.requiredOverride !== "boolean") {
      throw new OrchestrationStateError(
        "INVALID_COMPLETION_GATE",
        `Completion gate ${gateId} has an invalid requiredOverride`,
      );
    }
    if (gate.requiredOverride === false && !definition.waivable) {
      throw new OrchestrationStateError(
        "INVALID_COMPLETION_GATE",
        `Completion gate ${gateId} cannot override required applicability`,
      );
    }
    if (gate.phase !== definition.phase) {
      throw new OrchestrationStateError(
        "INVALID_COMPLETION_GATE",
        `Completion gate ${gateId} must belong to phase ${definition.phase}`,
      );
    }
    if (gate.required && gate.status === "N/A") {
      throw new OrchestrationStateError(
        "INVALID_COMPLETION_GATE",
        `Required completion gate ${gateId} cannot be N/A`,
      );
    }
  }
}

// Snapshot da Project_Config e opcional: Run criada antes da stack configuravel
// nao tem o campo e continua valida (nenhuma migracao de Run existente).
function validateProjectConfigSnapshot(snapshot) {
  if (snapshot == null) return;
  if (typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new OrchestrationStateError(
      "INVALID_PROJECT_CONFIG_SNAPSHOT",
      "state.projectConfig must be an object when present",
    );
  }
  if (typeof snapshot.source !== "string" || snapshot.source === "") {
    throw new OrchestrationStateError(
      "INVALID_PROJECT_CONFIG_SNAPSHOT",
      "state.projectConfig.source must be a non-empty string",
    );
  }
  const roles = snapshot.roles;
  if (roles == null || typeof roles !== "object" || Array.isArray(roles)) {
    throw new OrchestrationStateError(
      "INVALID_PROJECT_CONFIG_SNAPSHOT",
      "state.projectConfig.roles must be an object with the four configured roles",
    );
  }
  for (const role of ROLES) {
    if (!EXECUTOR_SET.has(roles[role])) {
      throw new OrchestrationStateError(
        "INVALID_PROJECT_CONFIG_SNAPSHOT",
        `state.projectConfig.roles.${role} must be one of ${EXECUTORS.join(", ")}`,
        { role, received: roles[role] ?? null, accepted: [...EXECUTORS] },
      );
    }
  }
  // Retrocompativel: snapshot gravado antes desta feature nao tem o campo.
  if (
    snapshot.quotaFallbackChain !== undefined
    && !QUOTA_FALLBACK_VALUES.includes(snapshot.quotaFallbackChain)
  ) {
    throw new OrchestrationStateError(
      "INVALID_PROJECT_CONFIG_SNAPSHOT",
      `state.projectConfig.quotaFallbackChain must be one of ${QUOTA_FALLBACK_VALUES.join(", ")}`,
      { received: snapshot.quotaFallbackChain ?? null, accepted: [...QUOTA_FALLBACK_VALUES] },
    );
  }
}

function assertRunMutable(state, operation = "mutate") {
  if (TERMINAL_RUN_STATUSES.has(state.status)) {
    throw new OrchestrationStateError(
      "RUN_TERMINAL",
      `Run ${state.runId} is ${state.status} and cannot ${operation}`,
      { runId: state.runId, status: state.status, operation },
    );
  }
}

function assertRunTransition(state, nextStatus) {
  if (state.status === nextStatus) return;
  if (!RUN_TRANSITIONS[state.status]?.has(nextStatus)) {
    throw new OrchestrationStateError(
      "INVALID_RUN_TRANSITION",
      `Run ${state.runId} cannot transition from ${state.status} to ${nextStatus}`,
    );
  }
}

/** True quando o `phaseHistory` registra a fase como fechada (DONE ou N/A). */
/** Phase 5 (worktrees + delegation) is where executor work starts. */
const DISPATCH_PHASE = 5;

/**
 * A task may only be dispatched (RUNNING) after phases 1-4 are closed, once the run tracks its phases
 * (any phase beyond 1 recorded — initRun itself opens phase 1). Runs and fixtures that never advance
 * the phase machine keep their behaviour.
 */
function assertDispatchAllowed(state, taskId, normalizedStatus) {
  if (normalizedStatus !== "RUNNING") return;
  const phaseHistory = state.phaseHistory ?? {};
  if (!Object.keys(phaseHistory).some((phase) => Number(phase) > 1)) return;
  const open = PHASE_SEQUENCE.filter((phase) => phase < DISPATCH_PHASE)
    .filter((phase) => !isPhaseClosed(phaseHistory, phase));
  if (open.length > 0) {
    throw new OrchestrationStateError(
      "TASK_DISPATCH_BEFORE_PHASE_4",
      `Task ${taskId} cannot be dispatched while phase(s) ${open.join(", ")} are not DONE or N/A (contracts, design materialization and smoke test come first)`,
      { taskId, blockedBy: open },
    );
  }
}

function isPhaseClosed(phaseHistory, phase) {
  const status = phaseHistory?.[String(phase)]?.status;
  return status === "DONE" || status === "N/A";
}

/**
 * Valida a transicao de uma fase contra `PHASE_SEQUENCE`.
 *
 * Corrige o Achado 1 da run oficina-saas-20260905-001: `updatePhase` aceitava
 * qualquer numero finito e qualquer status, sem checar predecessor. Resultado:
 * `--phase 7 --status DONE` com a fase 5 ainda RUNNING e a fase 6 inexistente
 * foi aceito sem reclamacao, e o `phaseHistory` final mostrou fases 2/3/4/7/10/11
 * fechadas em 0 ms — carimbadas em lote, nao conduzidas.
 *
 * Regras:
 * 1. A fase precisa estar em `PHASE_SEQUENCE`, ou ser `0` (preflight, fora da
 *    sequencia numerada e sem ordenacao a validar).
 * 2. Marcar `DONE` exige que todo predecessor em `PHASE_SEQUENCE` esteja
 *    fechado (`DONE` ou `N/A`) — senao `PHASE_PREDECESSOR_NOT_DONE`.
 * 3. Marcar `RUNNING` exige que nenhum predecessor esteja `RUNNING` — senao
 *    `PHASE_PREDECESSOR_RUNNING`. Voltar a uma fase anterior ja fechada
 *    (o loop de correcao da Fase 7) continua permitido.
 * 4. Marcar `N/A` exige que a fase tenha ao menos um completion gate
 *    `waivable` — senao `PHASE_NOT_WAIVABLE`. A exigencia de `reason` fica a
 *    cargo do chamador (`updatePhase`), que ja aplica a mesma regra ao gate.
 */
function assertPhaseTransition(state, numericPhase, normalizedStatus) {
  if (numericPhase !== 0 && !PHASE_SEQUENCE.includes(numericPhase)) {
    throw new OrchestrationStateError(
      "PHASE_NOT_IN_SEQUENCE",
      `Phase ${numericPhase} is not part of PHASE_SEQUENCE`,
      { phase: numericPhase, sequence: [...PHASE_SEQUENCE] },
    );
  }
  if (numericPhase === 0) return;

  const index = PHASE_SEQUENCE.indexOf(numericPhase);
  const predecessors = PHASE_SEQUENCE.slice(0, index);
  const phaseHistory = state.phaseHistory ?? {};

  if (normalizedStatus === "DONE") {
    const blockedBy = predecessors.filter((phase) => !isPhaseClosed(phaseHistory, phase));
    if (blockedBy.length > 0) {
      throw new OrchestrationStateError(
        "PHASE_PREDECESSOR_NOT_DONE",
        `Phase ${numericPhase} cannot be marked DONE while predecessor phase(s) ${blockedBy.join(", ")} are not DONE or N/A`,
        { phase: numericPhase, blockedBy },
      );
    }

    // A real run (OficinaAI, 2026-09-12) had visualAudit legitimately BLOCKED
    // (VIEWPORT_MISSING) when phase 9 closed DONE anyway: nothing here
    // checked the phase's OWN completion gate(s) before updatePhase's gate
    // sync loop overwrote them to match the phase's new status, silently
    // erasing the block. Mirror the predecessor check above, but against
    // this phase's own required gates instead of earlier phases' — a
    // required gate not yet DONE/N/A means its own validation
    // (updateCompletionGate: evidence, UI findings, materialization, sweep,
    // etc.) never actually ran, so the phase cannot be DONE either.
    const openGates = completionGateForPhase(numericPhase).filter((gateId) => {
      const gate = state.completionGates?.[gateId];
      return gate?.required && !["DONE", "N/A"].includes(gate.status);
    });
    if (openGates.length > 0) {
      throw new OrchestrationStateError(
        "PHASE_GATE_NOT_DONE",
        `Phase ${numericPhase} cannot be marked DONE while its own completion gate(s) ${openGates.join(", ")} are not DONE or N/A`,
        { phase: numericPhase, blockedBy: openGates },
      );
    }
  }

  if (normalizedStatus === "RUNNING" && numericPhase >= DISPATCH_PHASE) {
    // Delegation and everything after it start only once planning, routing and the phase-4
    // contracts/design materialization are closed. Audit finding: a real run (OficinaAI, 2026-09)
    // closed phase 4 twenty-six hours after phase 5 had started — only closing a phase checked
    // its predecessors, never starting one.
    const openPrerequisites = PHASE_SEQUENCE.filter((phase) => phase < DISPATCH_PHASE)
      .filter((phase) => !isPhaseClosed(phaseHistory, phase));
    if (openPrerequisites.length > 0) {
      throw new OrchestrationStateError(
        "PHASE_PREREQUISITES_OPEN",
        `Phase ${numericPhase} cannot start while phase(s) ${openPrerequisites.join(", ")} are not DONE or N/A`,
        { phase: numericPhase, blockedBy: openPrerequisites },
      );
    }
  }

  if (normalizedStatus === "RUNNING") {
    const runningPredecessors = predecessors.filter(
      (phase) => phaseHistory?.[String(phase)]?.status === "RUNNING",
    );
    if (runningPredecessors.length > 0) {
      throw new OrchestrationStateError(
        "PHASE_PREDECESSOR_RUNNING",
        `Phase ${numericPhase} cannot start RUNNING while predecessor phase(s) ${runningPredecessors.join(", ")} are still RUNNING`,
        { phase: numericPhase, runningPredecessors },
      );
    }
  }

  if (normalizedStatus === "N/A") {
    const waivableGates = completionGateForPhase(numericPhase).filter(
      (gateId) => COMPLETION_GATE_DEFINITIONS[gateId]?.waivable,
    );
    // A waivable gate never makes its whole phase skippable: phase 8 holds apiContractValidation
    // (waivable) next to backendReview (required, not waivable) — the review must still run.
    const requiredFixedGates = completionGateForPhase(numericPhase).filter((gateId) =>
      !COMPLETION_GATE_DEFINITIONS[gateId]?.waivable && state.completionGates?.[gateId]?.required);
    if (waivableGates.length === 0 || requiredFixedGates.length > 0) {
      throw new OrchestrationStateError(
        "PHASE_NOT_WAIVABLE",
        requiredFixedGates.length > 0
          ? `Phase ${numericPhase} cannot be marked N/A while its non-waivable gate(s) ${requiredFixedGates.join(", ")} are required`
          : `Phase ${numericPhase} has no waivable completion gate and cannot be marked N/A`,
        { phase: numericPhase, requiredFixedGates },
      );
    }
  }
}

export function validateState(state) {
  if (!state || state.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new OrchestrationStateError(
      "UNSUPPORTED_STATE_SCHEMA",
      `Expected state schema ${STATE_SCHEMA_VERSION}`,
    );
  }
  if (!state.runId || !state.slug || !Number.isInteger(state.revision)) {
    throw new OrchestrationStateError("INVALID_STATE", "state.json is missing run identity fields");
  }
  if (!RUN_STATUS_SET.has(state.status)) {
    throw new OrchestrationStateError(
      "INVALID_RUN_STATUS",
      `Run ${state.runId} has invalid status ${state.status}`,
    );
  }
  if (!PHASE_STATUS_SET.has(state.phaseStatus)) {
    throw new OrchestrationStateError(
      "INVALID_PHASE_STATUS",
      `Run ${state.runId} has invalid phase status ${state.phaseStatus}`,
    );
  }
  for (const [taskId, task] of Object.entries(state.tasks ?? {})) {
    validateTask(taskId, task);
  }
  validateCompletionGates(state.completionGates);
  validateProjectConfigSnapshot(state.projectConfig);
  if (state.quotaHandoffs !== undefined && !Array.isArray(state.quotaHandoffs)) {
    throw new OrchestrationStateError(
      "INVALID_QUOTA_HANDOFFS",
      "state.quotaHandoffs must be an array when present",
    );
  }
  return state;
}

// Sweep e reconcile rodam a cada poll da Fase 6. Gravar o mapa completo de
// tasks em cada um fez 418 de 499 eventos de uma run real ocuparem ~97% de um
// events.jsonl de 10 MB — e todo loadRun le e reaplica o log inteiro. Eles
// agora gravam so as tasks alteradas (`changedTasks`); `tasks` completo segue
// aceito para eventos antigos e quando o conjunto de ids muda.
function taskDeltaPayload(previousTasks, nextTasks) {
  const previous = previousTasks ?? {};
  const next = nextTasks ?? {};
  const previousIds = Object.keys(previous);
  const nextIds = Object.keys(next);
  if (previousIds.length !== nextIds.length || nextIds.some((id) => !Object.hasOwn(previous, id))) {
    return { tasks: next };
  }
  const changedTasks = {};
  for (const id of nextIds) {
    if (JSON.stringify(previous[id]) !== JSON.stringify(next[id])) changedTasks[id] = next[id];
  }
  return { changedTasks };
}

function applyTaskDelta(state, payload) {
  if (payload.tasks) {
    state.tasks = clone(payload.tasks);
    return;
  }
  for (const [taskId, task] of Object.entries(payload.changedTasks ?? {})) {
    state.tasks[taskId] = clone(task);
  }
}

function reduceEvent(previousState, event) {
  let state = previousState == null ? null : clone(previousState);
  const payload = event.payload ?? {};

  switch (event.type) {
    case "RUN_INITIALIZED":
      if (state != null) {
        throw new OrchestrationStateError("DUPLICATE_INIT", "Run is already initialized");
      }
      state = clone(payload.state);
      break;
    case "TASKS_SYNCED":
      state.tasks = clone(payload.tasks);
      state.waves = clone(payload.waves);
      state.currentWave = payload.currentWave;
      state.sync = clone(payload.sync);
      if (payload.completionGates) state.completionGates = clone(payload.completionGates);
      break;
    case "PHASE_UPDATED":
      state.phase = payload.phase;
      state.phaseStatus = payload.phaseStatus;
      state.lastSafePhase = payload.lastSafePhase;
      state.phaseHistory = clone(payload.phaseHistory);
      state.status = payload.runStatus;
      if (payload.completionGates) state.completionGates = clone(payload.completionGates);
      break;
    case "TASK_UPDATED":
    case "TASK_HEARTBEAT":
      state.tasks[payload.taskId] = clone(payload.task);
      state.status = payload.runStatus;
      state.currentWave = payload.currentWave;
      break;
    case "STALL_SWEEP_COMPLETED":
      applyTaskDelta(state, payload);
      state.status = payload.runStatus;
      state.currentWave = payload.currentWave;
      state.lifecycle = clone(payload.lifecycle);
      break;
    case "RUN_RESUMED":
      state.tasks = clone(payload.tasks);
      state.status = payload.runStatus;
      state.currentWave = payload.currentWave;
      state.resume = clone(payload.resume);
      break;
    case "RUN_RECONCILED":
      applyTaskDelta(state, payload);
      state.status = payload.runStatus;
      state.currentWave = payload.currentWave;
      state.repository = clone(payload.repository);
      state.resume = clone(payload.resume);
      break;
    case "RUN_STATUS_UPDATED":
      state.status = payload.runStatus;
      state.statusReason = payload.statusReason ?? null;
      if (payload.cancellation) state.cancellation = clone(payload.cancellation);
      break;
    case "COMPLETION_GATE_UPDATED":
      state.completionGates = clone(payload.completionGates);
      state.status = payload.runStatus;
      break;
    case "TASK_SCOPE_RESOLVED":
    case "TASK_LEASE_UPDATED":
    case "TASK_WORKSPACE_UPDATED":
      state.tasks[payload.taskId] = clone(payload.task);
      state.status = payload.runStatus;
      state.currentWave = payload.currentWave;
      if (payload.sync) state.sync = clone(payload.sync);
      break;
    case "RUN_CANCELLATION_REQUESTED":
      state.tasks = clone(payload.tasks);
      state.status = payload.runStatus;
      state.currentWave = payload.currentWave;
      state.cancellation = clone(payload.cancellation);
      state.resume = clone(payload.resume);
      break;
    case "PROJECT_CONFIG_UPDATED":
      state.tasks = clone(payload.tasks);
      state.projectConfig = clone(payload.projectConfig);
      state.status = payload.runStatus;
      state.currentWave = payload.currentWave;
      break;
    case "QUOTA_HANDOFF_RECORDED":
    case "QUOTA_HANDOFF_UPDATED":
      state.quotaHandoffs = clone(payload.quotaHandoffs);
      break;
    default:
      throw new OrchestrationStateError(
        "UNKNOWN_EVENT_TYPE",
        `Unknown orchestration event type: ${event.type}`,
      );
  }

  state.revision = event.revision;
  state.lastEventId = event.eventId;
  state.updatedAt = event.occurredAt;
  validateState(state);
  return state;
}

function replayEvents(events) {
  let state = null;
  for (const event of events) state = reduceEvent(state, event);
  return state;
}

function loadSnapshot(artifactDir) {
  const path = stateFile(artifactDir);
  if (!existsSync(path)) return { state: null, error: null };
  try {
    return { state: safeJsonParse(readFileSync(path, "utf8"), path), error: null };
  } catch (error) {
    return { state: null, error };
  }
}

export function loadRun(artifactDir, options = {}) {
  const directory = resolve(artifactDir);
  const eventLogPath = eventsFile(directory);
  const eventTailRecovered = options.repairSnapshot
    ? repairIncompleteEventTail(eventLogPath)
    : false;
  const snapshot = loadSnapshot(directory);
  const eventRead = readEvents(directory);
  const events = eventRead.events;

  if (snapshot.state == null && events.length === 0) {
    if (snapshot.error) throw snapshot.error;
    throw new OrchestrationStateError(
      "RUN_NOT_FOUND",
      `No state.json or events.jsonl found in ${directory}`,
    );
  }

  let state = snapshot.state;
  let snapshotError = snapshot.error;
  let snapshotRecovered = snapshot.error != null || state == null;
  let startRevision = 0;

  if (state != null) {
    try {
      validateState(state);
      startRevision = state.revision;
    } catch (error) {
      if (events.length === 0) throw error;
      snapshotError = error;
      snapshotRecovered = true;
      state = null;
    }
  }

  const seenRevisions = new Set();
  let maximumEventRevision = 0;
  let eventRunId = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (seenRevisions.has(event.revision)) {
      throw new OrchestrationStateError(
        "DUPLICATE_EVENT_REVISION",
        `events.jsonl contains revision ${event.revision} more than once`,
      );
    }
    const expectedRevision = index + 1;
    if (event.revision !== expectedRevision) {
      throw new OrchestrationStateError(
        "EVENT_REVISION_GAP",
        `Expected event revision ${expectedRevision}, found ${event.revision}`,
      );
    }
    seenRevisions.add(event.revision);
    maximumEventRevision = Math.max(maximumEventRevision, event.revision);
    eventRunId ??= event.runId;
    if (event.runId !== eventRunId) {
      throw new OrchestrationStateError(
        "RUN_ID_MISMATCH",
        `Event ${event.eventId} belongs to another run`,
      );
    }
    if (index === 0 && event.type !== "RUN_INITIALIZED") {
      throw new OrchestrationStateError(
        "MISSING_INIT_EVENT",
        "events.jsonl must begin with RUN_INITIALIZED",
      );
    }
  }

  if (state != null && state.revision > maximumEventRevision) {
    throw new OrchestrationStateError(
      "SNAPSHOT_AHEAD_OF_LOG",
      `state.json revision ${state.revision} is ahead of events.jsonl revision ${maximumEventRevision}`,
    );
  }

  if (state == null) {
    state = replayEvents(events);
  } else {
    const pending = events.filter((event) => event.revision > startRevision);
    for (let index = 0; index < pending.length; index += 1) {
      const expected = startRevision + index + 1;
      if (pending[index].revision !== expected) {
        throw new OrchestrationStateError(
          "EVENT_REVISION_GAP",
          `Expected event revision ${expected}, found ${pending[index].revision}`,
        );
      }
      if (pending[index].runId !== state.runId) {
        throw new OrchestrationStateError(
          "RUN_ID_MISMATCH",
          `Event ${pending[index].eventId} belongs to another run`,
        );
      }
      state = reduceEvent(state, pending[index]);
      snapshotRecovered = true;
    }
  }

  let snapshotDiverged = false;
  if (options.verifyReplay) {
    const replayed = replayEvents(events);
    if (!isDeepStrictEqual(state, replayed)) {
      state = replayed;
      snapshotRecovered = true;
      snapshotDiverged = true;
    }
  }

  if (options.repairSnapshot && snapshotRecovered) {
    writeSnapshotAtomically(stateFile(directory), state);
  }

  return {
    artifactDir: directory,
    state,
    events,
    snapshotRecovered,
    snapshotError: snapshotError?.message ?? null,
    eventTailRecovered,
    eventTailIncomplete: eventRead.truncatedTail,
    snapshotDiverged,
  };
}

function commitEvent(artifactDir, currentState, type, payload, options = {}) {
  const directory = resolve(artifactDir);
  const occurredAt = iso(options.now);
  const event = {
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    eventId: randomUUID(),
    runId: currentState?.runId ?? payload?.state?.runId,
    revision: (currentState?.revision ?? 0) + 1,
    occurredAt,
    type,
    actor: options.actor ?? "orchestrator",
    payload: clone(payload),
  };

  const nextState = reduceEvent(currentState, event);
  // Write-ahead invariant borrowed from Hermes async delegation: durable result
  // first, snapshot/publication second. A crash in between is repaired by replay.
  appendEventDurably(eventsFile(directory), event);
  writeSnapshotAtomically(stateFile(directory), nextState);
  return { state: nextState, event };
}

function runGit(projectRoot, args, options = {}) {
  try {
    const output = execFileSync("git", args, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeout ?? 10_000,
    });
    return options.preserveLeadingWhitespace ? output.trimEnd() : output.trim();
  } catch (error) {
    if (options.allowFailure) return null;
    throw error;
  }
}

export function inspectGit(projectRoot) {
  const root = resolve(projectRoot);
  const gitRoot = runGit(root, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (!gitRoot) {
    return {
      available: false,
      observedAt: new Date().toISOString(),
      error: "not-a-git-repository",
    };
  }

  const head = runGit(root, ["rev-parse", "HEAD"], { allowFailure: true });
  const branch = runGit(root, ["branch", "--show-current"], { allowFailure: true });
  const porcelain = runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"], {
    allowFailure: true,
    preserveLeadingWhitespace: true,
  });
  const changedFiles = (porcelain ?? "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((path) => path.includes(" -> ") ? path.split(" -> ").at(-1) : path);

  return {
    available: true,
    root: toPosix(relative(root, resolve(gitRoot)) || "."),
    head,
    branch: branch || null,
    dirty: changedFiles.length > 0,
    changedFiles: [...new Set(changedFiles)].sort(),
    observedAt: new Date().toISOString(),
  };
}

function changedFilesSince(projectRoot, commitBefore, currentGit) {
  const files = new Set(currentGit.changedFiles ?? []);
  if (commitBefore && currentGit.available && currentGit.head && commitBefore !== currentGit.head) {
    const committed = runGit(
      projectRoot,
      ["diff", "--name-only", `${commitBefore}..${currentGit.head}`],
      { allowFailure: true },
    );
    for (const path of (committed ?? "").split(/\r?\n/).filter(Boolean)) files.add(path.trim());
  }
  return [...files].sort();
}

function phaseName(phase) {
  return PHASE_NAMES[phase] ?? `phase-${phase}`;
}

function nextSafeResumePhase(lastSafePhase) {
  const completed = Number(lastSafePhase ?? 0);
  return PHASE_SEQUENCE.find((phase) => phase > completed) ?? PHASE_SEQUENCE.at(-1);
}

function normalizeSlug(value) {
  const slug = String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!slug) {
    throw new OrchestrationStateError("INVALID_SLUG", "A non-empty slug is required");
  }
  return slug;
}

function nextRunId(projectRoot, slug, now = new Date()) {
  const date = asDate(now);
  const stamp = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("");
  const prefix = `${slug}-${stamp}-`;
  let maximum = 0;

  // Achado 14: numeracao unica precisa varrer as duas raizes — uma run nova
  // nao pode colidir com o proximo numero de uma run legada em
  // `.orchestration/`, nem vice-versa.
  for (const { root, exists } of runRootCandidates(projectRoot)) {
    if (!exists) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name, "state.json");
      if (!existsSync(path)) continue;
      try {
        const candidate = JSON.parse(readFileSync(path, "utf8"));
        if (String(candidate.runId ?? "").startsWith(prefix)) {
          maximum = Math.max(maximum, Number(candidate.runId.slice(prefix.length)) || 0);
        }
      } catch {
        // A damaged unrelated run must not block initialization of this one.
      }
    }
  }

  return `${prefix}${String(maximum + 1).padStart(3, "0")}`;
}

function uniqueTaskIds(text) {
  const ids = (text.match(TASK_ID_RE) ?? []).map((id) => id.toUpperCase());
  const filtered = ids.filter((id) => !RESERVED_TASK_ID_PREFIXES.has(id.split("-")[0]));
  return [...new Set(filtered)];
}

function extractTaskBlocks(content) {
  const lines = content.split(/\r?\n/);
  const blocks = [];
  let current = null;

  const pushCurrent = () => {
    if (current) blocks.push({ id: current.id, text: current.lines.join("\n") });
    current = null;
  };

  const headingTask = /^\s*#{1,6}\s+(?:task\s+)?([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)\b/i;
  const explicitTask = /^\s*(?:[-*]\s*)?(?:task|id)\s*[:#-]\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)\b/i;

  for (const line of lines) {
    // A task is a record, not an arbitrary mention in prose.  In particular,
    // requirements (US/RF) and contracts (CT) frequently occur in task prose.
    const tableCells = /^\s*\|/.test(line)
      ? line.split("|").map((cell) => cell.trim()).filter(Boolean)
      : null;
    const candidate = tableCells?.[0]?.match(/^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)$/i)?.[1]
      ?? line.match(headingTask)?.[1]
      ?? line.match(explicitTask)?.[1]
      ?? null;
    const id = candidate?.toUpperCase();
    if (!id || !TASK_ID_EXACT_RE.test(id) || RESERVED_TASK_ID_PREFIXES.has(id.split("-")[0])) {
      if (current) current.lines.push(line);
      continue;
    }

    if (tableCells) {
      blocks.push({ id, text: line });
      continue;
    }

    pushCurrent();
    current = { id, lines: [line] };
  }
  pushCurrent();
  return blocks;
}

const EXECUTOR_SET = new Set(EXECUTORS);

function detectExecutor(text) {
  const codex = /\b(?:codex:codex-rescue|codex)\b/i.test(text);
  const agy = /\b(?:cc-antigravity-plugin:antigravity-coder|antigravity|agy)\b/i.test(text);
  if (codex && agy) return "codex+agy";
  if (codex) return "codex";
  if (agy) return "agy";
  return null;
}

// `claude-code` nao aparece na heuristica por mencao de agente (`detectExecutor`),
// entao um artefato de plano que declara o Executor explicitamente
// (`- executor: `claude-code``) precisa ser lido pelo campo, nao pelo texto.
// A heuristica continua valendo para artefato legado que so menciona o agente.
function parseDeclaredExecutor(text) {
  const raw = parseScalarField(text, ["executor"]);
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  return EXECUTOR_SET.has(normalized) ? normalized : null;
}

function parseDeclaredExecutorSource(text) {
  const raw = parseScalarField(text, ["executorSource", "executor source", "origem do executor"]);
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  return normalized === "" ? null : normalized;
}

/**
 * Snapshot da Project_Config gravado no `state.json` (Req 10.1).
 *
 * Guarda apenas o que decide roteamento e revalidacao de ambiente: versao do
 * schema, origem da configuracao, o `updatedAt` do arquivo e os quatro papeis.
 * `defaultsApplied` fica fora de proposito: ele documenta a coleta, nao o
 * roteamento.
 */
function projectConfigSnapshot(config, source) {
  const roles = {};
  for (const role of ROLES) roles[role] = config[role];
  return {
    schemaVersion: Number(config.schemaVersion ?? PROJECT_CONFIG_SCHEMA_VERSION),
    source: source ?? "default",
    updatedAt: config.updatedAt ?? null,
    roles,
    // Campo opt-in (nao um papel de executor): congelado junto dos quatro
    // papeis pela mesma regra de "Estabilidade durante a Run"
    // (project-config.md). Ausente em snapshot legado (Run anterior a esta
    // feature) resolve para o default no drift, nunca para `undefined`.
    quotaFallbackChain: config[QUOTA_FALLBACK_FIELD] ?? DEFAULT_QUOTA_FALLBACK_CHAIN,
  };
}

function invalidProjectConfig(role, received) {
  return new OrchestrationStateError(
    "INVALID_PROJECT_CONFIG",
    `Project config role ${role} must be one of ${EXECUTORS.join(", ")}, received ${JSON.stringify(String(received ?? ""))}`,
    { role, received: received ?? null, accepted: [...EXECUTORS] },
  );
}

/** Normaliza uma Project_Config recebida por opcao (sem tocar o filesystem). */
function normalizeProvidedProjectConfig(input) {
  const roleValues = input.roles ?? input;
  const config = {
    schemaVersion: Number(input.schemaVersion ?? PROJECT_CONFIG_SCHEMA_VERSION),
    updatedAt: input.updatedAt ?? null,
  };
  for (const role of ROLES) {
    const value = String(roleValues?.[role] ?? "").trim().toLowerCase();
    if (!EXECUTOR_SET.has(value)) throw invalidProjectConfig(role, roleValues?.[role]);
    config[role] = value;
  }
  const rawQuotaFallback = input[QUOTA_FALLBACK_FIELD] ?? roleValues?.[QUOTA_FALLBACK_FIELD];
  if (rawQuotaFallback === undefined || rawQuotaFallback === null || String(rawQuotaFallback).trim() === "") {
    config[QUOTA_FALLBACK_FIELD] = DEFAULT_QUOTA_FALLBACK_CHAIN;
  } else {
    const normalized = String(rawQuotaFallback).trim().toLowerCase();
    if (!QUOTA_FALLBACK_VALUES.includes(normalized)) {
      throw new OrchestrationStateError(
        "INVALID_PROJECT_CONFIG",
        `Project config field ${QUOTA_FALLBACK_FIELD} must be one of ${QUOTA_FALLBACK_VALUES.join(", ")}, `
          + `received ${JSON.stringify(String(rawQuotaFallback))}`,
        { field: QUOTA_FALLBACK_FIELD, received: rawQuotaFallback, accepted: [...QUOTA_FALLBACK_VALUES] },
      );
    }
    config[QUOTA_FALLBACK_FIELD] = normalized;
  }
  return { exists: true, source: input.source ?? "provided", path: input.path ?? null, config };
}

/**
 * Resolve a Project_Config de uma Run: `options.projectConfig` tem precedencia
 * sobre o Project_Config_File do projeto.
 *
 * Arquivo existente e invalido bloqueia a operacao com
 * `PROJECT_CONFIG_INVALID`: gravar snapshot a partir de arquivo defeituoso
 * congelaria uma configuracao que o usuario nunca escolheu.
 */
function loadProjectConfigForRun(projectRoot, options = {}) {
  if (options.projectConfig != null && typeof options.projectConfig === "object") {
    return normalizeProvidedProjectConfig(options.projectConfig);
  }
  try {
    return readProjectConfig(projectRoot);
  } catch (error) {
    if (error instanceof ProjectConfigError) {
      throw new OrchestrationStateError(
        "PROJECT_CONFIG_INVALID",
        `Project config file could not be used: ${error.message}`,
        { parserCode: error.code, ...(error.details ?? {}) },
      );
    }
    throw error;
  }
}

/** Leitura tolerante: usada na retomada, onde arquivo invalido nao pode impedir o resume. */
function readProjectConfigForDrift(projectRoot) {
  try {
    const read = readProjectConfig(projectRoot);
    return { ...read, error: null };
  } catch (error) {
    if (error instanceof ProjectConfigError) {
      return {
        exists: true,
        source: "invalid",
        path: error.details?.path ?? projectConfigPath(projectRoot),
        config: null,
        error: { code: error.code, message: error.message },
      };
    }
    throw error;
  }
}

/**
 * Compara o snapshot da Run com o Project_Config_File atual (Req 10.2).
 *
 * Run sem snapshot (criada antes da stack configuravel) devolve
 * `changed: false` e `source: "legacy"`: nao ha configuracao congelada para
 * divergir, e a Run continua legivel. Arquivo atual ilegivel tambem devolve
 * `changed: false`, com `error` preenchido, porque o resume nao pode depender
 * de um arquivo que o usuario ainda vai corrigir.
 */
function computeProjectConfigDrift(state, projectRoot) {
  const snapshot = state.projectConfig ?? null;
  const file = readProjectConfigForDrift(projectRoot);
  const base = {
    path: file.path,
    fileSource: file.source,
    error: file.error,
  };

  if (snapshot == null) {
    return {
      ...base,
      changed: false,
      source: "legacy",
      differences: [],
      snapshotUpdatedAt: null,
      fileUpdatedAt: file.config?.updatedAt ?? null,
      reason: "This run has no project configuration snapshot and is treated as a legacy run",
    };
  }

  if (file.config == null) {
    return {
      ...base,
      changed: false,
      source: snapshot.source ?? "file",
      differences: [],
      snapshotUpdatedAt: snapshot.updatedAt ?? null,
      fileUpdatedAt: null,
      reason: "The current project config file is invalid; the run keeps its snapshot",
    };
  }

  const snapshotQuotaFallback = {
    [QUOTA_FALLBACK_FIELD]: snapshot.quotaFallbackChain ?? DEFAULT_QUOTA_FALLBACK_CHAIN,
  };
  const differences = [
    ...diffProjectConfig(snapshot.roles ?? null, file.config),
    ...diffQuotaFallbackChain(snapshotQuotaFallback, file.config),
  ].map((entry) => ({ ...entry }));
  return {
    ...base,
    changed: differences.length > 0,
    source: file.source,
    differences,
    snapshotUpdatedAt: snapshot.updatedAt ?? null,
    fileUpdatedAt: file.config.updatedAt ?? null,
    snapshotRoles: clone(snapshot.roles ?? null),
    fileRoles: Object.fromEntries(ROLES.map((role) => [role, file.config[role]])),
    reason: differences.length > 0
      ? "The project config file diverges from the snapshot recorded for this run"
      : "The project config file matches the snapshot recorded for this run",
  };
}

/**
 * Executor derivado da categoria da task mais os papeis da Project_Config
 * (Req 7.1 a 7.4).
 *
 * `FULLSTACK` tem duas fatias e por isso pode render dois executores; o registro
 * na Run usa a mesma convencao que a heuristica legada (`codex+agy`) quando as
 * fatias caem em agentes diferentes. Task sem categoria reconhecida devolve
 * `null`: derivar executor a partir de categoria desconhecida seria inventar
 * roteamento.
 */
function deriveTaskExecutor(task, roles) {
  if (!task?.category) return null;
  let resolved;
  try {
    resolved = resolveExecutorForCategory(task.category, roles);
  } catch (error) {
    if (error instanceof ProjectConfigError) return null;
    throw error;
  }
  const executor = resolved.executor
    ?? (resolved.backend === resolved.frontend
      ? resolved.backend
      : `${resolved.backend}+${resolved.frontend}`);
  return { executor, executorSource: EXECUTOR_SOURCE_PROJECT_CONFIG };
}

function blockTitle(block) {
  const first = block.text.split(/\r?\n/)[0] ?? block.id;
  if (/^\s*\|/.test(first)) {
    const cells = first.split("|").map((cell) => cell.trim()).filter(Boolean);
    return cells.find((cell) => cell.toUpperCase() !== block.id) ?? block.id;
  }
  return first
    .replace(/^#{1,6}\s+/, "")
    .replace(new RegExp(`\\b${block.id}\\b`, "i"), "")
    .replace(/^\s*[-:|]+\s*/, "")
    .trim() || block.id;
}

// Valores de campo sem crase (`contractIds: CT-01`, `allowedPaths: backend/**`)
// eram descartados em silencio: numa run real (OficinaAI, 2026-09-21) todas as
// 13 tasks chegaram ao state.json sem contractIds/allowedPaths/expectedFiles/
// validationPlan, o que desligou a validacao de escopo e o planner de worktree
// e impediria o fechamento DONE (tasksWithoutEvidencePlan). Crase continua
// tendo precedencia; sem crase, o valor e dividido pelo separador do campo.
function splitPlainFieldValue(value, separator) {
  return value
    .split(separator)
    .map((item) => item.trim().replace(/[.;]+$/, "").trim())
    .filter((item) => item && !/^(?:n\/a|none|nenhum|nenhuma|-)$/i.test(item));
}

function parseExpectedFiles(text) {
  const lines = text.split(/\r?\n/).filter((line) =>
    /(?:expectedFiles|producedFiles|arquivos esperados|arquivos produzidos)/i.test(line),
  );
  const paths = [];
  for (const line of lines) {
    const backticked = [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    if (backticked.length > 0) {
      paths.push(...backticked);
      continue;
    }
    const field = line.match(/^\s*(?:[-*]\s*)?[^:=|]+[:=]\s*(.+)$/);
    if (field) paths.push(...splitPlainFieldValue(field[1], /[,;]/));
  }
  return [...new Set(paths)];
}

function parseBacktickValues(text, pattern, plainSeparator = /[,;]/) {
  const values = [];
  for (const line of text.split(/\r?\n/)) {
    const field = line.match(/^\s*(?:[-*]\s*)?([^:=|]+)\s*[:=]\s*(.*)$/i);
    if (!field || !pattern.test(field[1].replace(/[`*_]/g, "").trim())) continue;
    const backticked = [...field[2].matchAll(/`([^`]+)`/g)].map((match) => match[1].trim());
    values.push(...(backticked.length > 0
      ? backticked
      : splitPlainFieldValue(field[2], plainSeparator)));
  }
  return [...new Set(values.filter(Boolean))];
}

function parseScalarField(text, names) {
  const matcher = new RegExp(`(?:${names.join("|")})\\s*[:=]\\s*([^\\n|]+)`, "i");
  const match = text.match(matcher);
  return match?.[1]?.replace(/[`*_]/g, "").trim() ?? null;
}

// RF (functional), RNF (non-functional, requirements.json's nonFunctionalRequirements[]) and ARC
// (architecture patterns, requirements.json's architecturePatterns[], synthetic ARC-XX ids) — plus
// US and a domain infix (RF-AUTH-01), matching the Pensador's own RF_ID_SOURCE. Widened together
// with REQUIREMENT_ID_RE in requirements-coverage.mjs, which is what actually enforces coverage;
// this one only needs to agree on which ids a task's declaration can carry into state.json.
const REQUIREMENT_ID_RE = /\b(?:RF|RNF|ARC|US)-(?:[A-Z]+-)?\d+[A-Z]?\b/gi;

function parseRequirementIds(text) {
  const values = [];
  let collecting = false;
  for (const line of text.split(/\r?\n/)) {
    const field = line.match(/^\s*(?:[-*]\s*)?(?:requirementIds|requirement ids|requisitos)\s*[:=]\s*(.*)$/i);
    if (field) {
      collecting = true;
      values.push(...(field[1].match(REQUIREMENT_ID_RE) ?? []));
      continue;
    }
    if (!collecting) continue;
    if (/^\s{2,}(?:[-*]\s*)?/.test(line)) {
      values.push(...(line.match(REQUIREMENT_ID_RE) ?? []));
      continue;
    }
    collecting = false;
  }
  return [...new Set(values.map((value) => value.toUpperCase()))];
}

function parseTaskPlanningMetadata(text) {
  const complexityRaw = parseScalarField(text, ["complexity", "complexidade"]);
  const complexity = complexityRaw
    ? ({ low: "low", baixa: "low", medium: "medium", media: "medium", média: "medium", high: "high", alta: "high", critical: "critical", critica: "critical", crítica: "critical" }[
        complexityRaw.toLowerCase()
      ] ?? complexityRaw.toLowerCase())
    : null;
  const contractRaw = parseScalarField(text, ["contractRequired", "contrato obrigatorio", "contrato obrigatório"]);
  const contractRequired = contractRaw == null
    ? null
    : /^(?:yes|sim|true|required|obrigatorio|obrigatório)$/i.test(contractRaw);
  const model = parseScalarField(text, ["agyModel", "model", "modelo"]);
  const agyEffort = parseScalarField(text, ["agyEffort"]);
  const agyTimeout = parseScalarField(text, ["agyTimeout"]);
  const agyFormat = parseScalarField(text, ["agyFormat"]);
  return {
    complexity,
    contractRequired,
    model,
    agyEffort,
    agyTimeout,
    agyFormat,
    // validationPlan em prosa separa itens por ";" — virgula e comum dentro
    // de um item ("testes de isolamento, rotacao e reuso").
    validationPlan: parseBacktickValues(
      text,
      /(?:validationPlan|validation command|comando de validacao|comando de validação|validacoes|validações)/i,
      /;/,
    ),
    allowedPaths: parseBacktickValues(
      text,
      /(?:allowedPaths|allowed paths|caminhos permitidos|task scope|escopo da task)/i,
    ),
    requirementIds: parseRequirementIds(text),
    contractIds: [...new Set(parseBacktickValues(text, /^(?:contractIds?|contratos?)$/i)
      .flatMap((value) => value.match(/^CT-[A-Z0-9]+(?:-[A-Z0-9]+)*$/i)
        ? [value]
        : value.match(/\bCT-\d+[A-Z0-9]*\b/gi) ?? []))],
  };
}

export function parseTaskArtifacts(artifactDir) {
  const directory = resolve(artifactDir);
  const classificationSource = resolveArtifact(directory, "tasks-classification.md");
  const wavesSource = resolveArtifact(directory, "waves.md");
  const classification = classificationSource
    ? readFileSync(classificationSource.path, "utf8")
    : "";
  const wavesText = wavesSource ? readFileSync(wavesSource.path, "utf8") : "";
  const taskBlocks = extractTaskBlocks(classification);
  const tasks = {};

  for (const block of taskBlocks) {
    const category = CATEGORY_VALUES.find((value) =>
      new RegExp(`\\b${value}\\b`, "i").test(block.text),
    ) ?? null;
    const declaredExecutor = parseDeclaredExecutor(block.text);
    tasks[block.id] = {
      id: block.id,
      title: blockTitle(block),
      category,
      executor: declaredExecutor ?? detectExecutor(block.text),
      executorSource: declaredExecutor
        ? parseDeclaredExecutorSource(block.text) ?? EXECUTOR_SOURCE_PROJECT_CONFIG
        : null,
      expectedFiles: parseExpectedFiles(block.text),
      classificationPresent: true,
      ...parseTaskPlanningMetadata(block.text),
    };
  }

  const waves = [];
  let current = null;
  for (const line of wavesText.split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(?:Wave|Onda)\s+([0-9]+)\b/i);
    if (heading) {
      current = { id: Number(heading[1]), tasks: [] };
      waves.push(current);
    }
    const ids = uniqueTaskIds(line);
    if (ids.length === 0) continue;
    if (!current) {
      current = { id: 1, tasks: [] };
      waves.push(current);
    }
    for (const taskId of ids) {
      if (!current.tasks.includes(taskId)) current.tasks.push(taskId);
      if (!tasks[taskId]) {
        const declaredInWave = parseDeclaredExecutor(line);
        tasks[taskId] = {
          id: taskId,
          title: taskId,
          category: null,
          executor: declaredInWave ?? detectExecutor(line),
          executorSource: declaredInWave
            ? parseDeclaredExecutorSource(line) ?? EXECUTOR_SOURCE_PROJECT_CONFIG
            : null,
          expectedFiles: [],
          classificationPresent: false,
          complexity: null,
          contractRequired: null,
          model: null,
          agyEffort: null,
          agyTimeout: null,
          agyFormat: null,
          validationPlan: [],
          allowedPaths: [],
          requirementIds: [],
          contractIds: [],
        };
      }
    }
  }

  if (waves.length === 0 && Object.keys(tasks).length > 0) {
    waves.push({ id: 1, tasks: Object.keys(tasks) });
  }

  const waveByTask = new Map();
  for (const wave of waves) {
    for (const taskId of wave.tasks) {
      if (!waveByTask.has(taskId)) waveByTask.set(taskId, wave.id);
    }
  }
  // Achado 9: uma task descoberta depois que as ondas ja foram montadas (gap
  // achado na Fase 7, endpoint faltando etc.) ficava com `wave: null` — igual
  // a uma task legitimamente sem onda por falha de classificacao, quando na
  // verdade e um caso bem distinto: ela existe, so nao foi prevista no plano
  // original. `"adhoc"` torna essa origem visivel em vez de indistinguivel
  // de uma lacuna de dados.
  for (const task of Object.values(tasks)) task.wave = waveByTask.get(task.id) ?? "adhoc";

  return {
    tasks,
    waves,
    sources: {
      classification: classificationSource?.relativePath ?? null,
      waves: wavesSource?.relativePath ?? null,
    },
  };
}

function initialTask(metadata, now) {
  return {
    executorSource: null,
    ...clone(metadata),
    status: "PENDING",
    attempt: 0,
    attemptHistory: [],
    sessionId: null,
    jobId: null,
    threadId: null,
    conversationId: null,
    resolvedModel: null,
    // Effort de Codex efetivamente usado (Achado 13), distinto do `agyEffort`
    // planejado que a Fase 2 grava em `plan/tasks-classification.md`. Espelha
    // `resolvedModel` vs `model`: um e a decisao, o outro e o que a CLI de
    // fato reportou ter usado.
    codexEffort: null,
    retryDirective: null,
    usage: null,
    durationSeconds: null,
    numTurns: null,
    commitBefore: null,
    commitAfter: null,
    startedAt: null,
    completedAt: null,
    lastActivityAt: null,
    apiCalls: 0,
    toolCalls: 0,
    currentTool: null,
    inTool: false,
    producedFiles: [],
    validations: [],
    evidence: [],
    reasonCode: null,
    reason: null,
    reconciliation: null,
    sourcePresent: metadata.classificationPresent !== false,
    scopeResolution: null,
    lease: null,
    workspace: null,
    createdAt: now,
    updatedAt: now,
  };
}

function taskCategoryFlags(tasks) {
  const values = Object.values(tasks ?? {}).filter((task) => task.sourcePresent !== false);
  const backend = values.some((task) =>
    ["BACKEND_ONLY", "FULLSTACK", "DATABASE_ONLY"].includes(task.category),
  );
  const frontend = values.some((task) =>
    ["FRONTEND_ONLY", "FULLSTACK"].includes(task.category),
  );
  return { backend, frontend };
}

function contractFiles(artifactDir) {
  if (!artifactDir) return [];
  const directory = artifactTreePath(artifactDir, "contracts").path;
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:md|json)$/i.test(entry.name))
    .map((entry) => join(directory, entry.name));
}

function completionGateRequirements(tasks, artifactDir = null) {
  const { backend, frontend } = taskCategoryFlags(tasks);
  return {
    monitoring: true,
    visualMaterialization: frontend,
    contractsInspected: contractFiles(artifactDir).length > 0,
    infraSmokeTest: backend && frontend,
    apiContractValidation: backend,
    backendReview: backend,
    frontendReview: frontend,
    visualAudit: frontend,
    // Todo front-end exige verificacao em navegador real. A parte mecanicamente decidivel
    // aqui e apenas "existe front-end"; se a topologia nao tiver origens separadas, a
    // dispensa e uma decisao arquitetural que precisa ficar registrada como waiver com
    // motivo (gate --gate browserE2E --status N/A --required false --reason ...), nunca
    // uma derivacao silenciosa por categoria de task.
    browserE2E: frontend,
    // Semantic evidence is mandatory only for PRD-derived plans that declare
    // requirementIds. Spec/legacy plans remain compatible and explicit.
    requirementsCoverage: Object.values(tasks ?? {}).some((task) => (task.requirementIds ?? []).length > 0),
    reports: true,
    handoff: true,
    delivery: true,
    learning: true,
  };
}

function synchronizeCompletionGates(previous, tasks, now, artifactDir = null) {
  const requirements = completionGateRequirements(tasks, artifactDir);
  const gates = {};
  for (const [gateId, definition] of Object.entries(COMPLETION_GATE_DEFINITIONS)) {
    const existing = previous?.[gateId] ?? null;
    const requiredOverride = definition.waivable
      ? existing?.requiredOverride ?? null
      : null;
    const required = requiredOverride == null ? requirements[gateId] : requiredOverride;
    let status = existing?.status ?? (required ? "PENDING" : "N/A");
    if (!required && ["PENDING", "RUNNING", "BLOCKED", "FAILED"].includes(status)) {
      status = "N/A";
    }
    if (required && status === "N/A") status = "PENDING";
    gates[gateId] = {
      id: gateId,
      label: definition.label,
      phase: definition.phase,
      required,
      requiredOverride,
      status,
      evidence: clone(existing?.evidence ?? []),
      reason: existing?.reason ?? null,
      startedAt: existing?.startedAt ?? null,
      completedAt: existing?.completedAt ?? null,
      // So sobrevive ao resync enquanto o gate continuar N/A — se o status
      // recomputado voltou a PENDING (ex.: required override foi removido),
      // a delegacao nao vale mais.
      delegatedTo: status === "N/A" ? existing?.delegatedTo ?? null : null,
      updatedAt: existing?.updatedAt ?? now,
    };
  }
  return gates;
}

function completionGateForPhase(phase) {
  return Object.entries(COMPLETION_GATE_DEFINITIONS)
    .filter(([, definition]) => definition.phase === phase)
    .map(([gateId]) => gateId);
}

function completionGateSummary(gates) {
  return Object.fromEntries(
    Object.entries(gates ?? {}).map(([gateId, gate]) => [gateId, gate.status]),
  );
}

function computeCurrentWave(state) {
  for (const wave of state.waves ?? []) {
    if (
      wave.tasks.some((taskId) => {
        const status = state.tasks?.[taskId]?.status;
        return status && !TERMINAL_TASK_STATUSES.has(status);
      })
    ) {
      return wave.id;
    }
  }
  return state.waves?.at(-1)?.id ?? null;
}

function deriveRunStatus(tasks, fallback = "RUNNING") {
  const values = Object.values(tasks ?? {});
  if (values.length === 0) return fallback;
  for (const status of ["RUNNING", "STALLED", "UNKNOWN", "BLOCKED", "FAILED"] ) {
    if (values.some((task) => task.status === status)) return status;
  }
  // Task aggregation must never close a run. Cancellation and successful
  // completion are explicit run-level protocols with their own gates.
  if (values.every((task) => TERMINAL_TASK_STATUSES.has(task.status))) return fallback;
  if (TERMINAL_RUN_STATUSES.has(fallback)) return fallback;
  return "RUNNING";
}

function runSummary(state) {
  const counts = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0]));
  for (const task of Object.values(state.tasks ?? {})) counts[task.status] += 1;
  return {
    runId: state.runId,
    slug: state.slug,
    status: state.status,
    phase: state.phase,
    phaseStatus: state.phaseStatus,
    lastSafePhase: state.lastSafePhase,
    currentWave: state.currentWave,
    revision: state.revision,
    counts,
    gates: completionGateSummary(state.completionGates),
    updatedAt: state.updatedAt,
  };
}

/**
 * Normaliza `options.upstream` para `{ stage, slug, version, handoffPath } | null`.
 * Formato solto (nao um schema estrito): a run so grava o que a Fase 1 ja
 * resolveu via `ingestPensadorHandoff()`, para consulta posterior — nao e
 * revalidado contra `.pensador/` aqui, e essa releitura seria uma segunda
 * fonte da verdade.
 */
function normalizeUpstream(upstream) {
  if (upstream == null) return null;
  if (typeof upstream !== "object" || Array.isArray(upstream)) {
    throw new OrchestrationStateError("INVALID_UPSTREAM", "upstream must be an object or null");
  }
  const stage = String(upstream.stage ?? "").trim();
  if (!stage) {
    throw new OrchestrationStateError("INVALID_UPSTREAM", "upstream.stage is required");
  }
  return {
    stage,
    slug: upstream.slug != null ? String(upstream.slug) : null,
    version: upstream.version != null ? Number(upstream.version) : null,
    handoffPath: upstream.handoffPath != null ? String(upstream.handoffPath) : null,
  };
}

export function initRun(options) {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const slug = normalizeSlug(options.slug ?? basename(resolve(options.artifactDir ?? "")));
  // Achado 14: toda run nova nasce em `.orchestrator/runs/<slug>/`, nao mais
  // em `.orchestration/<slug>/`. Uma run legada com esse mesmo slug
  // continua sendo encontrada por `findRunDirectory`/`nextRunId` (as duas
  // raizes) — este default so decide onde uma run **nova** e criada.
  const artifactDir = resolve(options.artifactDir ?? join(currentRunsRoot(projectRoot), slug));

  return withLock(artifactDir, () => {
    if (existsSync(stateFile(artifactDir)) || existsSync(eventsFile(artifactDir))) {
      const loaded = loadRun(artifactDir, { repairSnapshot: true });
      if (TERMINAL_RUN_STATUSES.has(loaded.state.status)) {
        throw new OrchestrationStateError(
          "RUN_TERMINAL",
          `Run ${loaded.state.runId} is already ${loaded.state.status}; initialize a new slug/run identity`,
        );
      }
      return { created: false, artifactDir, state: loaded.state, summary: runSummary(loaded.state) };
    }

    const now = iso(options.now);
    const phase = Number(options.phase ?? 1);
    const git = inspectGit(projectRoot);
    const layoutVersion = SUPPORTED_ARTIFACT_LAYOUT_VERSIONS.includes(Number(options.layoutVersion))
      ? Number(options.layoutVersion)
      : ARTIFACT_LAYOUT_VERSION;
    ensureArtifactLayout(artifactDir, layoutVersion);
    const parsed = parseTaskArtifacts(artifactDir);
    const tasks = Object.fromEntries(
      Object.entries(parsed.tasks).map(([taskId, metadata]) => [taskId, initialTask(metadata, now)]),
    );
    const runId = options.runId ?? nextRunId(projectRoot, slug, asDate(options.now));
    const currentWave = parsed.waves[0]?.id ?? null;
    // Req 10.1: a Run congela a Project_Config vigente. `source` distingue
    // configuracao lida do arquivo da configuracao padrao aplicada por ausencia
    // de arquivo, o que e o que o drift do resume precisa para explicar a
    // diferenca ao usuario.
    const resolvedConfig = loadProjectConfigForRun(projectRoot, options);
    const initial = {
      schemaVersion: STATE_SCHEMA_VERSION,
      layoutVersion,
      runId,
      slug,
      projectConfig: projectConfigSnapshot(resolvedConfig.config, resolvedConfig.source),
      artifactRoot: toPosix(relative(projectRoot, artifactDir) || "."),
      status: "RUNNING",
      statusReason: null,
      phase,
      phaseStatus: "RUNNING",
      lastSafePhase: Math.max(0, Number(options.lastSafePhase ?? phase - 1)),
      currentWave,
      tasks,
      waves: parsed.waves,
      completionGates: synchronizeCompletionGates(null, tasks, now, artifactDir),
      phaseHistory: {
        [String(phase)]: {
          name: phaseName(phase),
          status: "RUNNING",
          startedAt: now,
          completedAt: null,
        },
      },
      repository: {
        ...git,
        headAtStart: git.head ?? null,
        dirtyAtStart: git.dirty ?? null,
        lastObservedHead: git.head ?? null,
      },
      sync: {
        lastSyncedAt: now,
        sources: parsed.sources,
        missingFromSource: [],
      },
      lifecycle: {
        staleIdleSeconds: Number(options.staleIdleSeconds ?? 450),
        staleInToolSeconds: Number(options.staleInToolSeconds ?? 1200),
        stallGraceSeconds: Number(options.stallGraceSeconds ?? 120),
        lastSweepAt: null,
      },
      resume: {
        count: 0,
        lastResumedAt: null,
        lastReconciledAt: null,
        resumeFromPhase: phase,
        pendingExternalProbes: [],
        recommendations: [],
      },
      cancellation: {
        requestedAt: null,
        requestedBy: null,
        reason: null,
        pendingExecutorStops: [],
        finalizedAt: null,
      },
      // Modo conjunto: a Fase 1 ja resolveu ingestPensadorHandoff() antes de
      // chamar init — grava o resultado aqui para que fases posteriores (a
      // delegacao da 9.5 acima) e `brain-pensador` (marca de slug consumido)
      // nao precisem reingerir o Pensador para saber de onde a run veio.
      // `null` em modo independente.
      upstream: normalizeUpstream(options.upstream),
      createdAt: now,
      updatedAt: now,
      revision: 0,
      lastEventId: null,
    };

    const committed = commitEvent(
      artifactDir,
      null,
      "RUN_INITIALIZED",
      { state: initial },
      options,
    );
    return {
      created: true,
      artifactDir,
      state: committed.state,
      event: committed.event,
      summary: runSummary(committed.state),
    };
  }, options);
}

export function syncRunFromArtifacts(artifactDir, options = {}) {
  return withLock(artifactDir, () => {
    const loaded = loadRun(artifactDir, { repairSnapshot: true });
    const state = loaded.state;
    assertRunMutable(state, "synchronize task artifacts");
    const parsed = parseTaskArtifacts(artifactDir);
    const now = iso(options.now);
    const nextTasks = {};
    const missingFromSource = [];

    for (const [taskId, metadata] of Object.entries(parsed.tasks)) {
      const previous = state.tasks[taskId];
      const sourcePresent = metadata.classificationPresent !== false;
      if (!sourcePresent) missingFromSource.push(taskId);
      // Task ja despachada mantem o Executor do dispatch (Req 10.5): reconciliacao
      // e telemetria consultam o agente que de fato recebeu a task, e nao o que o
      // artefato de plano passou a declarar depois.
      const dispatched = previous != null && Number(previous.attempt ?? 0) > 0;
      nextTasks[taskId] = previous
        ? {
            ...previous,
            ...clone(metadata),
            executor: dispatched
              ? previous.executor ?? null
              : metadata.executor ?? previous.executor ?? null,
            executorSource: dispatched
              ? previous.executorSource ?? null
              : metadata.executorSource ?? previous.executorSource ?? null,
            expectedFiles: metadata.expectedFiles.length > 0
              ? metadata.expectedFiles
              : previous.expectedFiles ?? [],
            validationPlan: metadata.validationPlan.length > 0
              ? metadata.validationPlan
              : previous.validationPlan ?? [],
            allowedPaths: metadata.allowedPaths.length > 0
              ? metadata.allowedPaths
              : previous.allowedPaths ?? [],
            contractIds: metadata.contractIds.length > 0
              ? metadata.contractIds
              : previous.contractIds ?? [],
            sourcePresent,
            scopeResolution: previous.sourcePresent === false && sourcePresent
              ? {
                  ...(previous.scopeResolution ?? {}),
                  reinstatedAt: now,
                  status: "REINSTATED",
                }
              : previous.scopeResolution ?? null,
            updatedAt: now,
          }
        : initialTask(metadata, now);
    }

    for (const [taskId, previous] of Object.entries(state.tasks)) {
      if (nextTasks[taskId]) continue;
      missingFromSource.push(taskId);
      nextTasks[taskId] = { ...previous, sourcePresent: false, updatedAt: now };
    }

    const draft = { ...state, tasks: nextTasks, waves: parsed.waves };
    const currentWave = computeCurrentWave(draft);
    const sync = {
      lastSyncedAt: now,
      sources: parsed.sources,
      missingFromSource,
    };
    const completionGates = synchronizeCompletionGates(
      state.completionGates,
      nextTasks,
      now,
      artifactDir,
    );
    const committed = commitEvent(
      artifactDir,
      state,
      "TASKS_SYNCED",
      { tasks: nextTasks, waves: parsed.waves, currentWave, sync, completionGates },
      options,
    );
    return {
      artifactDir: resolve(artifactDir),
      state: committed.state,
      event: committed.event,
      summary: runSummary(committed.state),
      missingFromSource,
    };
  }, options);
}

/**
 * Maior fase de `PHASE_SEQUENCE` tal que ela e todas as anteriores estao
 * fechadas (`DONE` ou `N/A`). Substitui o antigo `Math.max(lastSafePhase,
 * numericPhase)` (Achado 1): um salto — fase 7 marcada `DONE` com a fase 5
 * ainda `RUNNING` e a fase 6 inexistente — nao pode mais avancar o ponto de
 * retomada. Com `assertPhaseTransition` bloqueando o salto em si, esta funcao
 * e principalmente a defesa em profundidade para estado herdado de runs
 * anteriores a este fix.
 */
function computeLastSafePhase(phaseHistory) {
  let lastSafe = 0;
  for (const phase of PHASE_SEQUENCE) {
    if (!isPhaseClosed(phaseHistory, phase)) break;
    lastSafe = phase;
  }
  return lastSafe;
}

export function updatePhase(artifactDir, phase, phaseStatus, options = {}) {
  const numericPhase = Number(phase);
  const normalizedStatus = String(phaseStatus).toUpperCase();
  if (!Number.isFinite(numericPhase)) {
    throw new OrchestrationStateError("INVALID_PHASE", `Invalid phase: ${phase}`);
  }
  if (!PHASE_STATUS_SET.has(normalizedStatus)) {
    throw new OrchestrationStateError(
      "INVALID_PHASE_STATUS",
      `Invalid phase status: ${phaseStatus}`,
    );
  }
  if (normalizedStatus === "N/A" && !options.reason) {
    throw new OrchestrationStateError(
      "PHASE_WAIVER_REQUIRES_REASON",
      `Phase ${numericPhase} requires a reason when marked N/A`,
    );
  }

  return withLock(artifactDir, () => {
    const state = loadRun(artifactDir, { repairSnapshot: true }).state;
    assertRunMutable(state, "update a phase");
    const now = iso(options.now);
    const completionGates = synchronizeCompletionGates(
      state.completionGates,
      state.tasks,
      now,
      artifactDir,
    );
    if (normalizedStatus === "DONE") {
      const invalidEvidence = currentGateEvidenceFindings(artifactDir, completionGates, state)
        .filter((finding) => COMPLETION_GATE_DEFINITIONS[finding.id]?.phase === numericPhase);
      if (invalidEvidence.length > 0) {
        throw new OrchestrationStateError(
          "PHASE_GATE_EVIDENCE_INVALID",
          `Phase ${numericPhase} cannot be marked DONE because persisted gate evidence is missing, stale, or invalid`,
          { phase: numericPhase, findings: invalidEvidence },
        );
      }
    }
    assertPhaseTransition({ ...state, completionGates }, numericPhase, normalizedStatus);
    const history = clone(state.phaseHistory ?? {});
    const previous = history[String(numericPhase)] ?? {};
    history[String(numericPhase)] = {
      name: phaseName(numericPhase),
      status: normalizedStatus,
      startedAt: previous.startedAt ?? now,
      completedAt: ["DONE", "N/A"].includes(normalizedStatus) ? now : previous.completedAt ?? null,
      reason: options.reason ?? previous.reason ?? null,
    };

    let runStatus = state.status;
    if (normalizedStatus === "RUNNING" || normalizedStatus === "DONE") runStatus = "RUNNING";
    if (["FAILED", "BLOCKED", "UNKNOWN"].includes(normalizedStatus)) runStatus = normalizedStatus;
    // A cancelled phase is a workflow blocker, not permission to terminally
    // cancel a run while executors may still be active. Use requestRunCancellation.
    if (normalizedStatus === "CANCELLED") runStatus = "BLOCKED";
    assertRunTransition(state, runStatus);

    for (const gateId of completionGateForPhase(numericPhase)) {
      const previousGate = completionGates[gateId];
      if (!previousGate.required && previousGate.status === "N/A") continue;
      // Never let a phase transition silently overwrite a gate that was
      // already explicitly finalized via updateCompletionGate — that call
      // already ran the gate's own validation (evidence, UI findings,
      // materialization report, sweep requirement, etc.); this loop has
      // none of that context. This used to unconditionally overwrite every
      // gate mapped to the phase, which is what let a legitimately BLOCKED
      // visualAudit (see assertPhaseTransition's PHASE_GATE_NOT_DONE above)
      // get silently flipped to DONE the one time that check was bypassed.
      // Remaining reachable case: an untouched, still-PENDING/RUNNING
      // required gate — assertPhaseTransition already refuses a DONE phase
      // transition unless those are closed, so in practice this still only
      // fires for non-DONE phase transitions (RUNNING/FAILED/BLOCKED).
      if (["DONE", "BLOCKED", "FAILED", "N/A"].includes(previousGate.status)) continue;
      const gateStatus = normalizedStatus === "DONE"
        ? "DONE"
        : normalizedStatus === "RUNNING"
          ? "RUNNING"
          : normalizedStatus === "FAILED"
            ? "FAILED"
            : normalizedStatus === "N/A"
              ? "N/A"
              : "BLOCKED";
      completionGates[gateId] = {
        ...previousGate,
        status: gateStatus,
        // N/A so chega aqui quando assertPhaseTransition ja confirmou que o
        // gate e waivable; marca-lo dispensado explicitamente, salvo quando o
        // gate ja carrega `delegatedTo` (setado por `updateCompletionGate`
        // antes desta chamada) — o continue acima ja preserva esse caso.
        requiredOverride: normalizedStatus === "N/A" ? false : previousGate.requiredOverride,
        required: normalizedStatus === "N/A" ? false : previousGate.required,
        startedAt: previousGate.startedAt ?? now,
        completedAt: ["DONE", "N/A"].includes(gateStatus) ? now : null,
        reason: options.reason ?? previousGate.reason ?? null,
        evidence: [
          ...new Set([
            ...(previousGate.evidence ?? []),
            ...(normalizeList(options.evidence) ?? []),
          ]),
        ],
        updatedAt: now,
      };
    }

    // Reabertura em cascata (Achado 5): reentrar numa fase RUNNING reabre toda
    // fase posterior ja DONE — e o gate correspondente — de volta a PENDING.
    // E o caminho de volta que faltava: a Fase 9.5 produz task de implementacao
    // por construcao, mas estava depois das Fases 8/9 sem forma de reabri-las;
    // 8 tasks da run analisada foram entregues depois dos reviews com os gates
    // `backendReview`/`frontendReview` carimbados 1h24 depois, durante a
    // Fase 11. Reentrar na Fase 7 agora reabre 8, 9 e 9.5 automaticamente.
    if (normalizedStatus === "RUNNING") {
      for (const laterPhase of PHASE_SEQUENCE) {
        if (laterPhase <= numericPhase) continue;
        const laterRecord = history[String(laterPhase)];
        if (laterRecord?.status === "DONE") {
          history[String(laterPhase)] = { ...laterRecord, status: "PENDING", completedAt: null };
          for (const gateId of completionGateForPhase(laterPhase)) {
            const gate = completionGates[gateId];
            if (gate?.status === "DONE") {
              completionGates[gateId] = { ...gate, status: "PENDING", completedAt: null, updatedAt: now };
            }
          }
        }
      }
    }

    const lastSafePhase = computeLastSafePhase(history);

    const committed = commitEvent(
      artifactDir,
      state,
      "PHASE_UPDATED",
      {
        phase: numericPhase,
        phaseStatus: normalizedStatus,
        lastSafePhase,
        phaseHistory: history,
        runStatus,
        completionGates,
      },
      options,
    );
    return { state: committed.state, event: committed.event, summary: runSummary(committed.state) };
  }, options);
}

const GATE_ARTIFACT_CANDIDATES = Object.freeze({
  monitoring: [["monitoring.md"]],
  backendReview: [["review-final.md"]],
  frontendReview: [["review-frontend.md"]],
  visualMaterialization: [["design-materialization.json"]],
  infraSmokeTest: [["infra-smoke-test.json"]],
  visualAudit: [["ui-evidence.json"]],
  browserE2E: [["browser-e2e-report.md"], ["e2e-report.md"], ["e2e-verification.md"]],
  requirementsCoverage: [["requirements-evidence.json"]],
  apiContractValidation: [["api-contract-validation.json"]],
  reports: [["workflow-log.md", "subagents-context.md", "implementation-report.md"]],
  handoff: [["handoff.json"]],
  delivery: [],
  learning: [["learning-report.md"]],
});

function gateArtifactEvidence(artifactDir, gateId) {
  const alternatives = GATE_ARTIFACT_CANDIDATES[gateId] ?? [];
  for (const group of alternatives) {
    const checked = group.map((name) => {
      const resolved = resolveArtifact(artifactDir, name);
      return { path: resolved?.relativePath ?? name, exists: resolved != null };
    });
    if (checked.length > 0 && checked.every((entry) => entry.exists)) return checked;
  }
  return [];
}

function normalizedEvidencePath(value) {
  return String(value ?? "").replaceAll("\\", "/").toLowerCase();
}

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function validateContractInspectionEvidence(artifactDir) {
  const contracts = contractFiles(artifactDir);
  if (contracts.length === 0) return [];

  const evidenceDir = artifactTreePath(artifactDir, "evidence").path;
  const reports = existsSync(evidenceDir)
    ? readdirSync(evidenceDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(evidenceDir, entry.name))
      .map((path) => {
        try {
          const parsed = JSON.parse(readFileSync(path, "utf8"));
          return parsed?.kind === "inspect-contract" ? { path, parsed } : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
    : [];

  const inspected = reports.flatMap(({ path, parsed }) =>
    (parsed.details?.contracts ?? []).map((contract) => ({
      ...contract,
      evidenceId: parsed.evidenceId ?? basename(path, ".json"),
    })),
  );
  const missing = contracts.filter((contractPath) => {
    const expected = normalizedEvidencePath(relative(artifactDir, contractPath));
    const expectedSha256 = fileSha256(contractPath);
    return !inspected.some((entry) => {
      const actual = normalizedEvidencePath(entry.path);
      const sameContract = actual === expected || actual.endsWith(`/${expected}`) || expected.endsWith(`/${actual}`);
      const justified = entry.justified === true && String(entry.justification ?? "").trim().length > 0;
      return sameContract && entry.contentSha256 === expectedSha256 && (entry.valid === true || justified);
    });
  });
  if (missing.length > 0) {
    throw new OrchestrationStateError(
      "CONTRACT_INSPECTION_BLOCKED",
      `contractsInspected requires valid persisted inspect-contract evidence for every contract: ${missing.map((path) => basename(path)).join(", ")}`,
      { missingContracts: missing.map((path) => normalizedEvidencePath(relative(artifactDir, path))) },
    );
  }
  return [...new Set(inspected.map((entry) => `evidence:${entry.evidenceId}`))];
}

function validateInfraSmokeTestEvidence(artifactDir) {
  const evidence = resolveArtifact(artifactDir, "infra-smoke-test.json");
  if (!evidence) {
    throw new OrchestrationStateError("INFRA_SMOKE_TEST_MISSING", "infraSmokeTest requires evidence/infra-smoke-test.json");
  }
  let report;
  try {
    report = JSON.parse(readFileSync(evidence.path, "utf8"));
  } catch (error) {
    throw new OrchestrationStateError("INFRA_SMOKE_TEST_INVALID", `Could not parse infra-smoke-test.json: ${error.message}`);
  }
  if (report.kind !== "infra-smoke-test" || report.schemaVersion !== 1 || report.status !== "PASS" || report.applicable !== true || report.dryRun === true) {
    throw new OrchestrationStateError(
      "INFRA_SMOKE_TEST_BLOCKED",
      "infraSmokeTest requires a schemaVersion 1, applicable, non-dry-run smoke-test-infra.mjs result with status PASS",
      report,
    );
  }
  return `file:${evidence.relativePath}`;
}

/** evidence/api-contract-validation.json written by validate-api-contract.mjs (never hand-written). */
function validateApiContractEvidence(artifactDir) {
  const evidence = resolveArtifact(artifactDir, "api-contract-validation.json");
  if (!evidence) {
    throw new OrchestrationStateError("API_CONTRACT_VALIDATION_MISSING", "apiContractValidation requires evidence/api-contract-validation.json (validate-api-contract.mjs)");
  }
  let report;
  try {
    report = JSON.parse(readFileSync(evidence.path, "utf8"));
  } catch (error) {
    throw new OrchestrationStateError("API_CONTRACT_VALIDATION_INVALID", `Could not parse api-contract-validation.json: ${error.message}`);
  }
  if (report.kind !== "api-contract-validation" || report.schemaVersion !== 1 || report.status !== "PASS" || report.dryRun === true) {
    throw new OrchestrationStateError(
      "API_CONTRACT_VALIDATION_BLOCKED",
      "apiContractValidation requires a schemaVersion 1, non-dry-run validate-api-contract.mjs result with status PASS",
      { status: report.status ?? null, reasonCode: report.reasonCode ?? null },
    );
  }
  if (report.contractAbsolutePath && existsSync(report.contractAbsolutePath)
    && fileSha256(report.contractAbsolutePath) !== report.contractSha256) {
    throw new OrchestrationStateError("API_CONTRACT_VALIDATION_STALE", "The API contract changed after it was validated; run validate-api-contract.mjs again");
  }
  return `file:${evidence.relativePath}`;
}

const REVIEW_GATE_SOURCES = Object.freeze({
  backendReview: { artifact: "review-final.md", categories: new Set(["BACKEND_ONLY", "DATABASE_ONLY", "FULLSTACK"]) },
  frontendReview: { artifact: "review-frontend.md", categories: new Set(["FRONTEND_ONLY", "FULLSTACK"]) },
});

/** Final decision of a review report (references/workflow.md 8.4/9.4): the LAST verdict word wins. */
export function reviewVerdict(text) {
  const matches = [...String(text ?? "").matchAll(/\b(APROVADO_COM_RESSALVAS|APROVADO|REPROVADO)\b/g)];
  return matches.length ? matches.at(-1)[1] : null;
}

/**
 * A review gate closes DONE only on an approving verdict that is newer than every task of its scope.
 * Audit finding: a real run (OficinaAI, 2026-09) got REPROVADO in Fase 8, fixed privilege escalation
 * and refresh-token reuse in the correction loop, and nobody reviewed the fixes — the gate only
 * checked that review-final.md existed.
 */
function validateReviewGateEvidence(artifactDir, state, gateId) {
  const source = REVIEW_GATE_SOURCES[gateId];
  const resolved = resolveArtifact(artifactDir, source.artifact);
  if (!resolved) throw new OrchestrationStateError("REVIEW_REPORT_MISSING", `${gateId} requires ${source.artifact}`);
  const verdict = reviewVerdict(readFileSync(resolved.path, "utf8"));
  if (!verdict) {
    throw new OrchestrationStateError("REVIEW_VERDICT_MISSING", `${source.artifact} must end with a decision: APROVADO, APROVADO_COM_RESSALVAS or REPROVADO`);
  }
  if (verdict === "REPROVADO") {
    throw new OrchestrationStateError("REVIEW_REPROVED", `${source.artifact} decision is REPROVADO: run the correction loop (Fase 7) and review again before closing ${gateId}`);
  }
  const reviewedAtMs = statSync(resolved.path).mtimeMs;
  const newer = Object.values(state.tasks ?? {}).filter((task) =>
    task.sourcePresent !== false && source.categories.has(task.category) && task.status === "DONE"
      && Date.parse(task.completedAt ?? "") > reviewedAtMs);
  if (newer.length > 0) {
    throw new OrchestrationStateError(
      "REVIEW_STALE",
      `${source.artifact} predates task(s) ${newer.map((task) => task.id).join(", ")} completed after it; review the corrected code again`,
      { taskIds: newer.map((task) => task.id), reviewedAt: new Date(reviewedAtMs).toISOString() },
    );
  }
  return `file:${resolved.relativePath}`;
}

function currentGateEvidenceFindings(artifactDir, completionGates, state = null) {
  const findings = [];
  for (const gateId of ["contractsInspected", "infraSmokeTest", "apiContractValidation", "backendReview", "frontendReview"]) {
    const gate = completionGates?.[gateId];
    if (!gate?.required || gate.status !== "DONE") continue;
    try {
      if (gateId === "contractsInspected") validateContractInspectionEvidence(artifactDir);
      if (gateId === "infraSmokeTest") validateInfraSmokeTestEvidence(artifactDir);
      if (gateId === "apiContractValidation") validateApiContractEvidence(artifactDir);
      if (REVIEW_GATE_SOURCES[gateId] && state) validateReviewGateEvidence(artifactDir, state, gateId);
    } catch (error) {
      findings.push({
        id: gateId,
        code: error instanceof OrchestrationStateError ? error.code : "GATE_EVIDENCE_INVALID",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return findings;
}

export function updateCompletionGate(artifactDir, gateId, status, options = {}) {
  const normalizedGateId = String(gateId ?? "").trim();
  const normalizedStatus = String(status ?? "").toUpperCase();
  if (!COMPLETION_GATE_DEFINITIONS[normalizedGateId]) {
    throw new OrchestrationStateError(
      "UNKNOWN_COMPLETION_GATE",
      `Unknown completion gate: ${gateId}`,
    );
  }
  if (!GATE_STATUS_SET.has(normalizedStatus)) {
    throw new OrchestrationStateError(
      "INVALID_GATE_STATUS",
      `Invalid completion gate status: ${status}`,
    );
  }

  return withLock(artifactDir, () => {
    const state = loadRun(artifactDir, { repairSnapshot: true }).state;
    assertRunMutable(state, "update a completion gate");
    const now = iso(options.now);
    const completionGates = synchronizeCompletionGates(
      state.completionGates,
      state.tasks,
      now,
      artifactDir,
    );
    const definition = COMPLETION_GATE_DEFINITIONS[normalizedGateId];
    const previous = completionGates[normalizedGateId];
    if (options.required != null && typeof options.required !== "boolean") {
      throw new OrchestrationStateError(
        "INVALID_GATE_APPLICABILITY",
        "Completion gate required override must be a boolean",
      );
    }
    if (options.required != null && !definition.waivable) {
      throw new OrchestrationStateError(
        "GATE_APPLICABILITY_FIXED",
        `Completion gate ${normalizedGateId} derives applicability from task categories`,
      );
    }
    if (normalizedStatus === "N/A" && !options.reason) {
      throw new OrchestrationStateError(
        "GATE_WAIVER_REQUIRES_REASON",
        `Completion gate ${normalizedGateId} requires a reason when marked N/A`,
      );
    }
    if (normalizedStatus === "N/A" && definition.notApplicableReasons
      && !definition.notApplicableReasons.some((code) => String(options.reason).startsWith(code))) {
      throw new OrchestrationStateError(
        "GATE_WAIVER_REASON_INVALID",
        `Completion gate ${normalizedGateId} can only be N/A with a reason starting with ${definition.notApplicableReasons.join(" or ")}`,
      );
    }
    // `delegatedTo`: o gate nao roda aqui porque outro plugin da cadeia assume
    // a verificacao — distinto de um waiver puro, onde a verificacao nao roda
    // em lugar nenhum. So faz sentido junto de N/A e de um gate waivable;
    // `completionAudit` e quem de fato confirma a delegacao contra
    // `report/handoff.json.nextStage.consumer` antes de deixar a run fechar
    // DONE (ver Achado 13 do modo conjunto Pensador -> Testador).
    if (options.delegatedTo != null) {
      if (typeof options.delegatedTo !== "string" || options.delegatedTo.trim() === "") {
        throw new OrchestrationStateError(
          "INVALID_GATE_DELEGATION",
          "Completion gate delegatedTo must be a non-empty string",
        );
      }
      if (normalizedStatus !== "N/A") {
        throw new OrchestrationStateError(
          "INVALID_GATE_DELEGATION",
          `Completion gate ${normalizedGateId} can only be delegated when marked N/A`,
        );
      }
      if (!definition.waivable) {
        throw new OrchestrationStateError(
          "GATE_APPLICABILITY_FIXED",
          `Completion gate ${normalizedGateId} derives applicability from task categories`,
        );
      }
    }
    let requiredOverride = options.required ?? previous.requiredOverride ?? null;
    if (normalizedStatus === "N/A" && previous.required && definition.waivable) {
      requiredOverride = false;
    }
    if (normalizedStatus === "N/A" && previous.required && !definition.waivable) {
      throw new OrchestrationStateError(
        "REQUIRED_GATE_CANNOT_BE_SKIPPED",
        `Completion gate ${normalizedGateId} is required and cannot be N/A`,
      );
    }
    const required = requiredOverride == null ? previous.required : requiredOverride;
    if (normalizedStatus === "N/A" && required) {
      throw new OrchestrationStateError(
        "REQUIRED_GATE_CANNOT_BE_SKIPPED",
        `Completion gate ${normalizedGateId} is required and cannot be N/A`,
      );
    }

    const gateValidatedEvidence = normalizedStatus === "DONE" && normalizedGateId === "contractsInspected"
      ? validateContractInspectionEvidence(artifactDir)
      : normalizedStatus === "DONE" && normalizedGateId === "infraSmokeTest"
        ? [validateInfraSmokeTestEvidence(artifactDir)]
        : [];
    const explicitEvidence = normalizeList(options.evidence) ?? [];
    const artifactEvidence = gateArtifactEvidence(artifactDir, normalizedGateId);
    const evidence = [
      ...new Set([
        ...(previous.evidence ?? []),
        ...gateValidatedEvidence,
        ...explicitEvidence,
        ...artifactEvidence.map((entry) => `file:${entry.path}`),
      ]),
    ];
    if (normalizedGateId === "requirementsCoverage" && normalizedStatus === "DONE") {
      const result = evaluateRequirementsEvidence(artifactDir, state);
      if (!result.valid) {
        throw new OrchestrationStateError(
          "REQUIREMENTS_EVIDENCE_BLOCKED",
          "requirementsCoverage cannot be DONE: requirements-evidence.json must cover every RF/RNF/ARC (tasks and requirements index), every linked CA, with PASS criteria, concrete evidence, no open finding, and test evidence for security/privacy/isolation RNF",
          result,
        );
      }
    }
    if (REVIEW_GATE_SOURCES[normalizedGateId] && normalizedStatus === "DONE") {
      validateReviewGateEvidence(artifactDir, state, normalizedGateId);
    }
    if (normalizedGateId === "apiContractValidation" && normalizedStatus === "DONE") {
      validateApiContractEvidence(artifactDir);
    }
    if (normalizedStatus === "DONE" && evidence.length === 0) {
      throw new OrchestrationStateError(
        "GATE_DONE_REQUIRES_EVIDENCE",
        `Completion gate ${normalizedGateId} cannot be DONE without evidence`,
      );
    }
    if (normalizedGateId === "visualMaterialization" && normalizedStatus === "DONE") {
      const materializationEvidence = resolveArtifact(artifactDir, "design-materialization.json");
      if (!materializationEvidence) {
        throw new OrchestrationStateError("DESIGN_MATERIALIZATION_MISSING", "visualMaterialization requires design-materialization.json");
      }
      let report;
      try {
        report = JSON.parse(readFileSync(materializationEvidence.path, "utf8"));
      } catch (error) {
        throw new OrchestrationStateError("DESIGN_MATERIALIZATION_INVALID", `Could not parse design-materialization.json: ${error.message}`);
      }
      if (report.status !== "PASS") {
        throw new OrchestrationStateError(
          "DESIGN_MATERIALIZATION_BLOCKED",
          "visualMaterialization cannot be DONE while the resolved design package has blocking findings",
          report,
        );
      }
    }
    if (normalizedGateId === "visualAudit" && normalizedStatus === "DONE") {
      const visualEvidence = resolveArtifact(artifactDir, "ui-evidence.json");
      if (!visualEvidence) throw new OrchestrationStateError("UI_EVIDENCE_MISSING", "visualAudit requires ui-evidence.json");
      let result;
      try {
        result = validateUiEvidence(JSON.parse(readFileSync(visualEvidence.path, "utf8")), { baseDir: dirname(visualEvidence.path) });
      } catch (error) {
        throw new OrchestrationStateError("UI_EVIDENCE_INVALID", `Could not validate ui-evidence.json: ${error.message}`);
      }
      if (!result.ok) throw new OrchestrationStateError("UI_EVIDENCE_BLOCKED", "visualAudit cannot be DONE while semantic UI/UX findings remain", result);
    }
    // Acompanhamento estrutural (analise-run-oficina-saas-20260906.md): o gate
    // acima ja exige evidencia para fechar a fase 6, mas nao exige que o
    // monitoramento tenha de fato rodado *durante* ela — uma run pode
    // despachar uma wave e nunca mais chamar tick/watch/sweep, ficando parada
    // com resultados prontos e ninguem sabendo. So a presenca de
    // `lifecycle.lastSweepAt` (nao uma janela de recencia, que seria flaky
    // para waves que fecham rapido) prova que sweepStalledTasks rodou ao
    // menos uma vez nesta run.
    if (normalizedGateId === "monitoring" && normalizedStatus === "DONE" && !state.lifecycle?.lastSweepAt) {
      throw new OrchestrationStateError(
        "GATE_MONITORING_REQUIRES_SWEEP",
        "Completion gate monitoring cannot be DONE before orchestration-lifecycle.mjs tick/watch has run at least once (lifecycle.lastSweepAt is empty)",
      );
    }

    completionGates[normalizedGateId] = {
      ...previous,
      required,
      requiredOverride,
      status: normalizedStatus,
      startedAt: previous.startedAt ?? (normalizedStatus === "PENDING" ? null : now),
      completedAt: ["DONE", "N/A"].includes(normalizedStatus) ? now : null,
      reason: options.reason ?? previous.reason ?? null,
      evidence,
      // Delegacao so sobrevive enquanto o gate estiver N/A; reabrir o gate
      // (RUNNING/PENDING/DONE) limpa a marca — a proxima delegacao precisa ser
      // explicita de novo.
      delegatedTo: normalizedStatus === "N/A" ? (options.delegatedTo ?? previous.delegatedTo ?? null) : null,
      updatedAt: now,
    };
    let runStatus = state.status;
    if (normalizedStatus === "FAILED") runStatus = "FAILED";
    else if (normalizedStatus === "BLOCKED") runStatus = "BLOCKED";
    else if (["RUNNING", "DONE", "N/A"].includes(normalizedStatus)) runStatus = "RUNNING";
    assertRunTransition(state, runStatus);
    const committed = commitEvent(
      artifactDir,
      state,
      "COMPLETION_GATE_UPDATED",
      { gateId: normalizedGateId, completionGates, runStatus },
      options,
    );
    return {
      state: committed.state,
      event: committed.event,
      gate: committed.state.completionGates[normalizedGateId],
      summary: runSummary(committed.state),
    };
  }, options);
}

function ensureTask(state, taskId) {
  const normalized = String(taskId ?? "").toUpperCase();
  if (!TASK_ID_EXACT_RE.test(normalized) || !state.tasks[normalized]) {
    throw new OrchestrationStateError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
  }
  return normalized;
}

function normalizeList(value) {
  if (value == null) return undefined;
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

function mergeTaskFields(previous, status, options, now, git) {
  const task = clone(previous);
  const previousStatus = task.status;
  const sameStatus = previousStatus === status;
  if (!sameStatus && !TASK_TRANSITIONS[previousStatus]?.has(status)) {
    throw new OrchestrationStateError(
      "INVALID_TASK_TRANSITION",
      `Task ${task.id} cannot transition from ${previousStatus} to ${status}`,
    );
  }

  task.status = status;
  task.updatedAt = now;
  if (options.executor !== undefined) task.executor = options.executor;
  // Registro de dispatch uniforme (Req 7.7): `claude-code` grava executor,
  // origem da decisao de roteamento, sessao do subagente, tentativa e estado
  // canonico exatamente como `codex` e `agy`.
  if (options.executorSource !== undefined) task.executorSource = options.executorSource || null;
  if (options.model !== undefined) task.model = options.model || null;
  if (options.complexity !== undefined) task.complexity = options.complexity || null;
  if (options.sessionId !== undefined) task.sessionId = options.sessionId || null;
  if (options.conversationId !== undefined) task.conversationId = options.conversationId || null;
  if (options.jobId !== undefined) task.jobId = options.jobId || null;
  if (options.threadId !== undefined) task.threadId = options.threadId || null;
  if (options.resolvedModel !== undefined) task.resolvedModel = options.resolvedModel || null;
  if (options.codexEffort !== undefined) task.codexEffort = options.codexEffort || null;
  if (options.retryDirective !== undefined) task.retryDirective = options.retryDirective || null;
  if (options.usage !== undefined) task.usage = options.usage ? clone(options.usage) : null;
  if (options.durationSeconds !== undefined) task.durationSeconds = options.durationSeconds ?? null;
  if (options.activeDurationMs !== undefined) task.activeDurationMs = options.activeDurationMs ?? null;
  if (options.queueDurationMs !== undefined) task.queueDurationMs = options.queueDurationMs ?? null;
  if (options.userWaitDurationMs !== undefined) task.userWaitDurationMs = options.userWaitDurationMs ?? null;
  if (options.numTurns !== undefined) task.numTurns = options.numTurns ?? null;
  if (options.reasonCode !== undefined) task.reasonCode = options.reasonCode || null;
  if (options.reason !== undefined) task.reason = options.reason || null;
  if (options.currentTool !== undefined) task.currentTool = options.currentTool || null;
  if (options.inTool !== undefined) task.inTool = Boolean(options.inTool);
  if (options.apiCalls !== undefined) task.apiCalls = Number(options.apiCalls);
  if (options.toolCalls !== undefined) task.toolCalls = Number(options.toolCalls);

  const expectedFiles = normalizeList(options.expectedFiles);
  if (expectedFiles) task.expectedFiles = expectedFiles;
  const producedFiles = normalizeList(options.producedFiles);
  if (producedFiles) task.producedFiles = [...new Set([...(task.producedFiles ?? []), ...producedFiles])];
  const evidence = normalizeList(options.evidence);
  if (evidence) task.evidence = [...new Set([...(task.evidence ?? []), ...evidence])];
  if (Array.isArray(options.validations)) task.validations = clone(options.validations);
  if (options.reviewResult !== undefined) task.reviewResult = options.reviewResult || null;
  if (options.regressions !== undefined) task.regressions = Number(options.regressions);

  if (!Array.isArray(task.attemptHistory)) task.attemptHistory = [];
  if (status === "RUNNING") {
    // Achado 4: um redispatch de verdade — retomada AGY via `--conversation`,
    // troca de executor por cota — chegava como RUNNING -> RUNNING
    // (`sameStatus`), que nunca incrementava `attempt` nem abria uma entrada
    // nova em `attemptHistory`; a run analisada registrou `attempt: 1` em
    // 33/33 tasks com 9 redispatches reais. Uma atualizacao RUNNING que muda
    // executor, sessionId ou conversationId em relacao ao que ja estava
    // gravado so e aceita com `--new-attempt` — sem isso, e um redispatch nao
    // declarado.
    if (sameStatus && options.newAttempt !== true) {
      // So conta como mudanca quando o campo ja tinha um valor gravado e o
      // novo valor diverge — preencher um campo que ainda estava vazio (o
      // caso de `import-executor-telemetry.mjs`, que descobre depois do fato
      // um conversationId/sessionId que o dispatch original nao capturou)
      // e um backfill legitimo, nao um redispatch.
      const executorChanged = options.executor !== undefined && previous.executor != null &&
        options.executor !== previous.executor;
      const sessionChanged = options.sessionId !== undefined && previous.sessionId != null &&
        options.sessionId !== previous.sessionId;
      const conversationChanged = options.conversationId !== undefined && previous.conversationId != null &&
        options.conversationId !== previous.conversationId;
      const jobChanged = options.jobId !== undefined && previous.jobId != null && options.jobId !== previous.jobId;
      const threadChanged = options.threadId !== undefined && previous.threadId != null && options.threadId !== previous.threadId;
      if (executorChanged || sessionChanged || conversationChanged || jobChanged || threadChanged) {
        throw new OrchestrationStateError(
          "ATTEMPT_NOT_DECLARED",
          `Task ${task.id} received a RUNNING update with a different ${
            executorChanged ? "executor" : sessionChanged ? "sessionId" : conversationChanged ? "conversationId" : jobChanged ? "jobId" : "threadId"
          } than the current attempt, without --new-attempt`,
          {
            taskId: task.id,
            previousExecutor: previous.executor ?? null,
            newExecutor: options.executor ?? null,
            previousSessionId: previous.sessionId ?? null,
            newSessionId: options.sessionId ?? null,
            previousConversationId: previous.conversationId ?? null,
            newConversationId: options.conversationId ?? null,
          },
        );
      }
    }
    const recoveringSameAttempt = ["STALLED", "UNKNOWN"].includes(previousStatus) &&
      Number(task.attempt ?? 0) > 0 && options.newAttempt !== true;
    // Um redispatch RUNNING -> RUNNING so incrementa quando declarado
    // explicitamente com --new-attempt (a checagem ATTEMPT_NOT_DECLARED acima
    // ja barra o caso nao declarado). Sem essa clausula, `!sameStatus` sempre
    // seria falso aqui e o attempt nunca avancaria mesmo com --new-attempt.
    const declaredSameStatusAttempt = sameStatus && options.newAttempt === true;
    const newAttempt = declaredSameStatusAttempt || (!sameStatus && !recoveringSameAttempt);
    if (newAttempt && Number(task.attempt ?? 0) > 0) {
      const previousIndex = task.attemptHistory.findIndex((entry) => Number(entry.attempt) === Number(task.attempt));
      if (previousIndex >= 0 && task.attemptHistory[previousIndex].status === "RUNNING") {
        const previousRunning = task.attemptHistory[previousIndex];
        const startedMs = Date.parse(previousRunning.startedAt ?? "");
        const completedMs = Date.parse(now);
        task.attemptHistory[previousIndex] = {
          ...previousRunning,
          status: "UNKNOWN",
          reasonCode: "RETRY_SUPERSEDED_ATTEMPT",
          completedAt: now,
          durationMs: Number.isFinite(startedMs) && Number.isFinite(completedMs) ? Math.max(0, completedMs - startedMs) : null,
        };
      }
    }
    if (newAttempt) task.attempt = Number(task.attempt ?? 0) + 1;
    if (newAttempt) {
      if (options.resolvedModel === undefined) task.resolvedModel = null;
      if (options.usage === undefined) task.usage = null;
      if (options.durationSeconds === undefined) task.durationSeconds = null;
      if (options.numTurns === undefined) task.numTurns = null;
    }
    // Achado 3: `--started-at` deixa o orquestrador corrigir o extremo
    // inicial de `durationMs` para o timestamp real que a CLI (AGY/Codex)
    // reportou, em vez do momento em que o orquestrador processou um lote de
    // dispatches — que e o que produziu durationMs identicos (2-3 ms de
    // diferenca) entre tasks distintas na run analisada.
    task.startedAt = options.startedAt ?? (newAttempt ? now : task.startedAt ?? now);
    task.completedAt = null;
    task.lastActivityAt = now;
    task.commitBefore = options.commitBefore ?? task.commitBefore ?? git.head ?? null;
    task.commitAfter = null;
    task.stall = null;
    task.reconciliation = null;
    const attemptIndex = task.attemptHistory.findIndex((entry) => Number(entry.attempt) === Number(task.attempt));
    const attemptRecord = {
      ...(attemptIndex >= 0 ? task.attemptHistory[attemptIndex] : {}),
      attempt: Number(task.attempt),
      executor: task.executor ?? null,
      executorSource: task.executorSource ?? null,
      model: task.model ?? null,
      status: "RUNNING",
      startedAt: attemptIndex >= 0
        ? task.attemptHistory[attemptIndex].startedAt ?? task.startedAt
        : task.startedAt,
      completedAt: null,
      durationMs: null,
      activeDurationMs: task.activeDurationMs ?? null,
      queueDurationMs: task.queueDurationMs ?? null,
      userWaitDurationMs: task.userWaitDurationMs ?? null,
      reasonCode: null,
      reviewResult: null,
      regressions: 0,
      sessionId: task.sessionId ?? null,
      jobId: task.jobId ?? null,
      threadId: task.threadId ?? null,
      conversationId: task.conversationId ?? null,
      resolvedModel: task.resolvedModel ?? null,
      codexEffort: task.codexEffort ?? null,
      retryDirective: task.retryDirective ?? null,
      usage: task.usage ? clone(task.usage) : null,
      durationSeconds: task.durationSeconds ?? null,
      numTurns: task.numTurns ?? null,
      commitBefore: task.commitBefore ?? null,
      commitAfter: null,
    };
    if (attemptIndex >= 0) task.attemptHistory[attemptIndex] = attemptRecord;
    else task.attemptHistory.push(attemptRecord);
  } else if (status === "DONE") {
    task.completedAt = options.completedAt ?? now;
    task.lastActivityAt = now;
    task.commitAfter = options.commitAfter ?? git.head ?? task.commitAfter ?? null;
  } else if (status === "STALLED") {
    task.stall = {
      ...(task.stall ?? {}),
      detectedAt: now,
      reason: options.reason ?? "No observable progress",
    };
  } else if (status === "UNKNOWN") {
    task.unknownAt = now;
  } else if (["FAILED", "BLOCKED", "CANCELLED"].includes(status)) {
    task.completedAt = status === "BLOCKED" ? null : (options.completedAt ?? now);
  }

  if (["DONE", "FAILED", "BLOCKED", "CANCELLED"].includes(status) && Number(task.attempt ?? 0) > 0) {
    const attemptIndex = task.attemptHistory.findIndex((entry) => Number(entry.attempt) === Number(task.attempt));
    const previousAttempt = attemptIndex >= 0 ? task.attemptHistory[attemptIndex] : {
      attempt: Number(task.attempt),
      executor: task.executor ?? null,
      model: task.model ?? null,
      startedAt: task.startedAt ?? now,
    };
    const completedAt = task.completedAt ?? now;
    const startedMs = Date.parse(previousAttempt.startedAt ?? "");
    const completedMs = Date.parse(completedAt);
    const record = {
      ...previousAttempt,
      executor: task.executor ?? previousAttempt.executor ?? null,
      executorSource: task.executorSource ?? previousAttempt.executorSource ?? null,
      model: task.model ?? previousAttempt.model ?? null,
      resolvedModel: task.resolvedModel ?? previousAttempt.resolvedModel ?? null,
      codexEffort: task.codexEffort ?? previousAttempt.codexEffort ?? null,
      status,
      completedAt,
      durationMs: Number.isFinite(startedMs) && Number.isFinite(completedMs)
        ? Math.max(0, completedMs - startedMs)
        : null,
      activeDurationMs: task.activeDurationMs ?? previousAttempt.activeDurationMs ?? (Number.isFinite(startedMs) && Number.isFinite(completedMs) ? Math.max(0, completedMs - startedMs) : null),
      queueDurationMs: task.queueDurationMs ?? previousAttempt.queueDurationMs ?? 0,
      userWaitDurationMs: task.userWaitDurationMs ?? previousAttempt.userWaitDurationMs ?? 0,
      reasonCode: task.reasonCode ?? null,
      reviewResult: task.reviewResult ?? null,
      regressions: Number(task.regressions ?? 0),
      commitAfter: task.commitAfter ?? null,
      conversationId: task.conversationId ?? previousAttempt.conversationId ?? null,
      retryDirective: task.retryDirective ?? previousAttempt.retryDirective ?? null,
      usage: task.usage ? clone(task.usage) : previousAttempt.usage ?? null,
      durationSeconds: task.durationSeconds ?? previousAttempt.durationSeconds ?? null,
      numTurns: task.numTurns ?? previousAttempt.numTurns ?? null,
    };
    if (attemptIndex >= 0) task.attemptHistory[attemptIndex] = record;
    else task.attemptHistory.push(record);
  }

  return task;
}

function assertTaskDoneEvidence(task, projectRoot, git) {
  const expected = pathEvidence(projectRoot, task.expectedFiles ?? []);
  const missingExpected = expected.filter((entry) => !entry.exists || !entry.insideProject);
  if (missingExpected.length > 0) {
    throw new OrchestrationStateError(
      "TASK_EXPECTED_FILES_MISSING",
      `Task ${task.id} cannot be DONE while expected files are missing`,
      { files: missingExpected },
    );
  }
  const produced = pathEvidence(projectRoot, task.producedFiles ?? []);
  const fileEvidence = [...expected, ...produced].some(
    (entry) => entry.exists && entry.insideProject,
  );
  const validationEvidence = allValidationsPass(task.validations) === true;
  const recordedEvidence = Array.isArray(task.evidence) && task.evidence.length > 0;
  const commitEvidence = Boolean(
    task.commitBefore &&
    (task.commitAfter ?? git.head) &&
    task.commitBefore !== (task.commitAfter ?? git.head),
  );
  if (!fileEvidence && !validationEvidence && !recordedEvidence && !commitEvidence) {
    throw new OrchestrationStateError(
      "TASK_DONE_REQUIRES_EVIDENCE",
      `Task ${task.id} cannot be DONE without produced files, passing validation, commit delta, or recorded executor evidence`,
    );
  }
}

export function updateTaskStatus(artifactDir, taskId, status, options = {}) {
  const normalizedStatus = String(status ?? "").toUpperCase();
  if (!TASK_STATUS_SET.has(normalizedStatus)) {
    throw new OrchestrationStateError(
      "INVALID_TASK_STATUS",
      `Invalid task status: ${status}`,
    );
  }

  return withLock(artifactDir, () => {
    const state = loadRun(artifactDir, { repairSnapshot: true }).state;
    assertRunMutable(state, "update a task");
    const normalizedTaskId = ensureTask(state, taskId);
    if (state.tasks[normalizedTaskId]?.status !== "RUNNING") assertDispatchAllowed(state, normalizedTaskId, normalizedStatus);
    const now = iso(options.now);
    const projectRoot = resolve(options.projectRoot ?? join(resolve(artifactDir), "..", ".."));
    const git = inspectGit(projectRoot);
    const task = mergeTaskFields(
      state.tasks[normalizedTaskId],
      normalizedStatus,
      options,
      now,
      git,
    );
    if (normalizedStatus === "DONE") assertTaskDoneEvidence(task, projectRoot, git);
    const tasks = { ...state.tasks, [normalizedTaskId]: task };
    const draft = { ...state, tasks };
    const runStatus = deriveRunStatus(tasks, state.status);
    const currentWave = computeCurrentWave(draft);
    const committed = commitEvent(
      artifactDir,
      state,
      "TASK_UPDATED",
      { taskId: normalizedTaskId, task, runStatus, currentWave },
      options,
    );
    return {
      state: committed.state,
      event: committed.event,
      task: committed.state.tasks[normalizedTaskId],
      summary: runSummary(committed.state),
    };
  }, options);
}

export function heartbeatTask(artifactDir, taskId, options = {}) {
  return withLock(artifactDir, () => {
    const state = loadRun(artifactDir, { repairSnapshot: true }).state;
    assertRunMutable(state, "record a heartbeat");
    const normalizedTaskId = ensureTask(state, taskId);
    const previous = state.tasks[normalizedTaskId];
    if (!["RUNNING", "STALLED"].includes(previous.status)) {
      throw new OrchestrationStateError(
        "HEARTBEAT_NOT_ALLOWED",
        `Task ${normalizedTaskId} is ${previous.status}; heartbeat requires RUNNING or STALLED`,
      );
    }

    const now = iso(options.now);
    const apiCalls = options.apiCalls === undefined ? previous.apiCalls : Number(options.apiCalls);
    const toolCalls = options.toolCalls === undefined ? previous.toolCalls : Number(options.toolCalls);
    const currentTool = options.currentTool === undefined
      ? previous.currentTool
      : options.currentTool || null;
    const inTool = options.inTool === undefined ? previous.inTool : Boolean(options.inTool);
    const progressToken = options.progressToken === undefined
      ? previous.progressToken ?? null
      : String(options.progressToken);
    const observedProgress =
      (options.apiCalls !== undefined && apiCalls !== previous.apiCalls) ||
      (options.toolCalls !== undefined && toolCalls !== previous.toolCalls) ||
      (options.currentTool !== undefined && currentTool !== previous.currentTool) ||
      (options.inTool !== undefined && inTool !== previous.inTool) ||
      (options.progressToken !== undefined && progressToken !== (previous.progressToken ?? null));

    if (!observedProgress) {
      return {
        changed: false,
        state,
        task: previous,
        summary: runSummary(state),
      };
    }

    const task = {
      ...clone(previous),
      status: "RUNNING",
      lastActivityAt: now,
      updatedAt: now,
      apiCalls,
      toolCalls,
      currentTool,
      inTool,
      progressToken,
      stall: previous.status === "STALLED"
        ? { ...(previous.stall ?? {}), recoveredAt: now }
        : previous.stall ?? null,
    };
    const tasks = { ...state.tasks, [normalizedTaskId]: task };
    const draft = { ...state, tasks };
    const runStatus = deriveRunStatus(tasks, state.status);
    const currentWave = computeCurrentWave(draft);
    const committed = commitEvent(
      artifactDir,
      state,
      "TASK_HEARTBEAT",
      { taskId: normalizedTaskId, task, runStatus, currentWave },
      options,
    );
    return {
      changed: true,
      state: committed.state,
      event: committed.event,
      task: committed.state.tasks[normalizedTaskId],
      summary: runSummary(committed.state),
    };
  }, options);
}

export function sweepStalledTasks(artifactDir, options = {}) {
  return withLock(artifactDir, () => {
    const state = loadRun(artifactDir, { repairSnapshot: true }).state;
    assertRunMutable(state, "sweep stalled tasks");
    const nowDate = asDate(options.now);
    const now = iso(nowDate);
    const idleSeconds = Number(
      options.staleIdleSeconds ?? state.lifecycle?.staleIdleSeconds ?? 450,
    );
    const inToolSeconds = Number(
      options.staleInToolSeconds ?? state.lifecycle?.staleInToolSeconds ?? 1200,
    );
    const graceSeconds = Number(
      options.stallGraceSeconds ?? state.lifecycle?.stallGraceSeconds ?? 120,
    );
    const tasks = clone(state.tasks);
    const stalled = [];
    const graceExpired = [];

    for (const task of Object.values(tasks)) {
      if (task.status === "RUNNING") {
        const last = task.lastActivityAt ?? task.startedAt;
        if (!last) continue;
        const quietSeconds = Math.max(0, (nowDate.getTime() - new Date(last).getTime()) / 1000);
        const thresholdSeconds = task.inTool ? inToolSeconds : idleSeconds;
        if (quietSeconds >= thresholdSeconds) {
          task.status = "STALLED";
          task.updatedAt = now;
          task.stall = {
            detectedAt: now,
            quietSeconds: Math.round(quietSeconds * 100) / 100,
            thresholdSeconds,
            phase: task.inTool ? "in_tool" : "idle",
            graceSeconds,
            graceUntil: new Date(nowDate.getTime() + graceSeconds * 1000).toISOString(),
            recommendation: "INTERRUPT_THEN_RECONCILE",
          };
          stalled.push(task.id);
        }
      } else if (task.status === "STALLED" && task.stall?.graceUntil) {
        if (nowDate.getTime() >= new Date(task.stall.graceUntil).getTime() && !task.stall.graceExpiredAt) {
          task.updatedAt = now;
          task.stall.graceExpiredAt = now;
          task.stall.recommendation = "CANCEL_OR_RETRY_AFTER_RECONCILIATION";
          graceExpired.push(task.id);
        }
      }
    }

    // Achado 2: o sweeper so persistia `lifecycle.lastSweepAt` quando algo
    // mudava — o early-return abaixo (removido) deixava o campo `null` para
    // sempre numa run onde nenhuma task chegou a estagnar, mascarando o fato
    // de que o sweep nunca rodou de nenhuma stall real tambem nao ter
    // acontecido. `lastSweepAt` agora e evidencia de que a Fase 6 de fato
    // varreu tasks — commitEvent roda sempre, mudando task ou nao.
    const changed = stalled.length > 0 || graceExpired.length > 0;
    // Watch ticks (skipIfUnchanged) persist a quiet sweep at most once per heartbeat window: a real
    // run wrote 418 sweep/reconcile events out of 499, 190 of them changing nothing, and every state
    // load re-read them all. lastSweepAt still proves the sweeper ran (monitoring gate).
    const heartbeatMs = Number(options.sweepHeartbeatSeconds ?? 300) * 1000;
    const lastSweepMs = Date.parse(state.lifecycle?.lastSweepAt ?? "");
    const sameThresholds = state.lifecycle?.staleIdleSeconds === idleSeconds
      && state.lifecycle?.staleInToolSeconds === inToolSeconds
      && state.lifecycle?.stallGraceSeconds === graceSeconds;
    if (options.skipIfUnchanged && !changed && sameThresholds && Number.isFinite(lastSweepMs)
      && nowDate.getTime() - lastSweepMs < heartbeatMs) {
      return { changed: false, skipped: true, state, event: null, stalled, graceExpired, summary: runSummary(state) };
    }
    const draft = { ...state, tasks };
    const runStatus = deriveRunStatus(tasks, state.status);
    const currentWave = computeCurrentWave(draft);
    const lifecycle = {
      staleIdleSeconds: idleSeconds,
      staleInToolSeconds: inToolSeconds,
      stallGraceSeconds: graceSeconds,
      lastSweepAt: now,
    };
    const committed = commitEvent(
      artifactDir,
      state,
      "STALL_SWEEP_COMPLETED",
      {
        ...taskDeltaPayload(state.tasks, tasks),
        runStatus,
        currentWave,
        lifecycle,
        stalled,
        graceExpired,
      },
      options,
    );
    return {
      changed,
      state: committed.state,
      event: committed.event,
      stalled,
      graceExpired,
      summary: runSummary(committed.state),
    };
  }, options);
}

function resolveProjectRoot(artifactDir, options) {
  return resolve(options.projectRoot ?? join(resolve(artifactDir), "..", ".."));
}

function pathEvidence(projectRoot, paths) {
  const checked = [];
  for (const path of normalizeList(paths) ?? []) {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(projectRoot, path);
    const rel = relative(projectRoot, absolute);
    const inside = rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
    checked.push({
      path: toPosix(path),
      exists: inside && existsSync(absolute),
      insideProject: inside,
    });
  }
  return checked;
}

function normalizeExternalStatus(probe) {
  const raw = String(
    probe?.executorStatus ?? probe?.sessionStatus ?? probe?.conversationStatus ?? probe?.status ?? "",
  ).toUpperCase();
  const map = {
    COMPLETED: "DONE",
    COMPLETE: "DONE",
    SUCCESS: "DONE",
    SUCCEEDED: "DONE",
    IN_PROGRESS: "RUNNING",
    DISPATCHED: "RUNNING",
    ERROR: "FAILED",
    TIMED_OUT: "FAILED",
    TIMEOUT: "FAILED",
    QUOTA_EXHAUSTED: "BLOCKED",
    QUOTA_EXAUSTED: "BLOCKED",
    AUTH_REQUIRED: "BLOCKED",
    AGY_MISSING: "BLOCKED",
    NEEDS_SYNC: "BLOCKED",
  };
  const normalized = map[raw] ?? raw;
  const status = TASK_STATUS_SET.has(normalized) ? normalized : null;
  const operationalReasonCodes = new Set([
    "QUOTA_EXHAUSTED",
    "QUOTA_EXAUSTED",
    "AUTH_REQUIRED",
    "AGY_MISSING",
    "TIMEOUT",
    "TIMED_OUT",
    "NEEDS_SYNC",
  ]);
  return {
    raw: raw || null,
    status,
    reasonCode: probe?.reasonCode ?? (operationalReasonCodes.has(raw) ? raw : null),
  };
}

function readProbeFile(path) {
  if (!path) return { tasks: {} };
  const parsed = safeJsonParse(readFileSync(resolve(path), "utf8"), resolve(path));
  if (!parsed || typeof parsed.tasks !== "object" || Array.isArray(parsed.tasks)) {
    throw new OrchestrationStateError(
      "INVALID_PROBE_FILE",
      "Probe file must contain an object shaped as { tasks: { <taskId>: {...} } }",
    );
  }
  return parsed;
}

function allValidationsPass(validations) {
  if (!Array.isArray(validations) || validations.length === 0) return null;
  return validations.every((item) => {
    const value = typeof item === "object" ? item.status ?? item.passed : item;
    if (value === true) return true;
    return ["PASS", "PASSED", "SUCCESS", "OK"].includes(String(value).toUpperCase());
  });
}

function reconcileTask(task, probe, projectRoot, git, now) {
  const next = clone(task);
  const previousStatus = next.status;
  if (TERMINAL_TASK_STATUSES.has(next.status)) return next;
  if (probe?.sessionId) next.sessionId = probe.sessionId;
  if (probe?.jobId) next.jobId = probe.jobId;
  if (probe?.threadId) next.threadId = probe.threadId;
  if (probe?.conversationId) next.conversationId = probe.conversationId;
  if (probe?.model) next.resolvedModel = probe.model;
  if (probe?.retryDirective) next.retryDirective = probe.retryDirective;
  if (probe?.usage) next.usage = clone(probe.usage);
  if (probe?.activeDurationMs != null) next.activeDurationMs = probe.activeDurationMs;
  if (probe?.queueDurationMs != null) next.queueDurationMs = probe.queueDurationMs;
  if (probe?.userWaitDurationMs != null) next.userWaitDurationMs = probe.userWaitDurationMs;
  if (probe?.durationSeconds != null) next.durationSeconds = probe.durationSeconds;
  if (probe?.numTurns != null) next.numTurns = probe.numTurns;
  const external = normalizeExternalStatus(probe);
  const externalStatus = external.status;
  const expected = pathEvidence(projectRoot, [
    ...(task.expectedFiles ?? []),
    ...(probe?.expectedFiles ?? []),
  ]);
  const produced = pathEvidence(projectRoot, [
    ...(task.producedFiles ?? []),
    ...(probe?.producedFiles ?? probe?.files ?? []),
  ]);
  const files = [...expected, ...produced].filter(
    (entry, index, array) => array.findIndex((item) => item.path === entry.path) === index,
  );
  const missingExpected = expected.filter((entry) => !entry.exists).map((entry) => entry.path);
  const validations = Array.isArray(probe?.validations)
    ? clone(probe.validations)
    : clone(task.validations ?? []);
  const validationsPass = allValidationsPass(validations);
  const changedFiles = changedFilesSince(projectRoot, task.commitBefore, git);
  const presentFiles = files.filter((entry) => entry.exists && entry.insideProject);
  const commitCorroborated = Boolean(
    probe?.commitAfter && git.available && probe.commitAfter === git.head,
  );
  const localCorroboration = validationsPass === true
    ? "validation"
    : presentFiles.length > 0
      ? "file"
      : commitCorroborated
        ? "commit"
        : null;
  let recommendation = "VERIFY";
  let reason = "No authoritative executor result was observed";

  if (externalStatus === "RUNNING") {
    next.status = "RUNNING";
    next.lastActivityAt = probe.lastActivityAt ?? next.lastActivityAt ?? now;
    recommendation = "MONITOR";
    reason = "Executor reports that the task is still running";
  } else if (validationsPass === false && externalStatus == null) {
    next.status = "FAILED";
    next.completedAt = now;
    next.reasonCode = probe?.reasonCode ?? "VALIDATION_FAILED";
    recommendation = "FIX_OR_REEXECUTE";
    reason = "At least one task-scoped reconciliation validation failed";
  } else if (externalStatus === "DONE") {
    if (validationsPass === false) {
      next.status = "FAILED";
      next.reasonCode = probe?.reasonCode ?? "VALIDATION_FAILED";
      recommendation = "FIX_OR_REEXECUTE";
      reason = "Executor completed, but at least one validation failed";
    } else if (missingExpected.length > 0) {
      next.status = "UNKNOWN";
      recommendation = "VERIFY_OR_REEXECUTE";
      reason = "Executor reports completion, but expected files are missing";
    } else if (localCorroboration == null) {
      next.status = "UNKNOWN";
      recommendation = "COLLECT_LOCAL_EVIDENCE";
      reason = "Executor reports completion, but no local file, passing validation, or commit evidence corroborates it";
    } else {
      next.status = "DONE";
      next.completedAt = probe.completedAt ?? now;
      next.commitAfter = probe.commitAfter ?? git.head ?? next.commitAfter ?? null;
      next.reasonCode = external.reasonCode;
      recommendation = "CONTINUE";
      reason = "Authoritative executor completion is consistent with local evidence";
    }
  } else if (externalStatus === "FAILED") {
    next.status = "FAILED";
    next.completedAt = probe.completedAt ?? now;
    next.reasonCode = external.reasonCode ?? probe?.reasonCode ?? "EXECUTOR_FAILED";
    recommendation = changedFiles.length > 0 ? "INSPECT_PARTIAL_THEN_RETRY" : "REEXECUTE";
    reason = probe.error ?? probe.reason ?? "Executor reports failure";
  } else if (externalStatus === "BLOCKED") {
    next.status = "BLOCKED";
    next.reasonCode = external.reasonCode ?? probe?.reasonCode ?? "EXECUTOR_BLOCKED";
    recommendation = "RESOLVE_BLOCKER";
    reason = probe.error ?? probe.reason ?? "Executor reports an operational blocker";
  } else if (externalStatus === "CANCELLED") {
    next.status = "CANCELLED";
    next.reasonCode = external.reasonCode ?? probe?.reasonCode ?? "EXECUTOR_CANCELLED";
    recommendation = "DO_NOT_REEXECUTE_WITHOUT_USER_INTENT";
    reason = probe.reason ?? "Executor reports cancellation";
  } else if (externalStatus === "STALLED") {
    next.status = "STALLED";
    next.reasonCode = external.reasonCode ?? probe?.reasonCode ?? "EXECUTOR_STALLED";
    recommendation = "INTERRUPT_THEN_RECONCILE";
    reason = probe.reason ?? "Executor reports no progress";
  } else if (next.status === "STALLED") {
    recommendation = next.stall?.graceExpiredAt
      ? "CANCEL_OR_RETRY_AFTER_RECONCILIATION"
      : "INTERRUPT_THEN_RECONCILE";
    reason = "No new progress was observed for a previously stalled task";
  } else if (next.status === "RUNNING") {
    // A missing probe is an absence of observation, not evidence that an
    // executor vanished.  The lifecycle sweeper owns the later RUNNING ->
    // STALLED transition when the heartbeat actually becomes stale.
    recommendation = "MONITOR_UNVERIFIED";
    reason = "No authoritative executor outcome was observed; preserving the last RUNNING state";
  } else if (next.status === "UNKNOWN") {
    next.status = "UNKNOWN";
    if (changedFiles.length > 0 || files.some((entry) => entry.exists)) {
      recommendation = "VERIFY_BEFORE_REEXECUTE";
      reason = "Local changes exist, but there is no authoritative executor outcome";
    } else {
      recommendation = "REEXECUTE_AFTER_CONFIRMING_SESSION_IS_GONE";
      reason = "No executor outcome or local task evidence was found";
    }
  }

  next.validations = validations;
  next.updatedAt = now;
  next.reconciliation = {
    reconciledAt: now,
    externalStatus,
    externalRawStatus: external.raw,
    reasonCode: external.reasonCode ?? next.reasonCode ?? null,
    files,
    missingExpected,
    validationsPass,
    localCorroboration,
    changedFiles,
    recommendation,
    reason,
  };
  if (!Array.isArray(next.attemptHistory)) next.attemptHistory = [];
  if (externalStatus === "RUNNING" && Number(next.attempt ?? 0) === 0) {
    next.attempt = 1;
    next.startedAt = probe?.startedAt ?? now;
  }
  if (Number(next.attempt ?? 0) > 0) {
    const attemptIndex = next.attemptHistory.findIndex((entry) => Number(entry.attempt) === Number(next.attempt));
    const previousAttempt = attemptIndex >= 0 ? next.attemptHistory[attemptIndex] : {
      attempt: Number(next.attempt),
      executor: next.executor ?? null,
      model: next.model ?? null,
      startedAt: next.startedAt ?? probe?.startedAt ?? now,
      sessionId: next.sessionId ?? null,
      conversationId: next.conversationId ?? null,
      resolvedModel: next.resolvedModel ?? null,
      retryDirective: next.retryDirective ?? null,
      usage: next.usage ? clone(next.usage) : null,
      durationSeconds: next.durationSeconds ?? null,
      numTurns: next.numTurns ?? null,
      commitBefore: next.commitBefore ?? null,
    };
    const terminal = ["DONE", "FAILED", "BLOCKED", "CANCELLED"].includes(next.status);
    const completedAt = terminal ? next.completedAt ?? now : null;
    const startedMs = Date.parse(previousAttempt.startedAt ?? "");
    const completedMs = Date.parse(completedAt ?? "");
    const record = {
      ...previousAttempt,
      executor: next.executor ?? previousAttempt.executor ?? null,
      executorSource: next.executorSource ?? previousAttempt.executorSource ?? null,
      model: next.model ?? previousAttempt.model ?? null,
      status: next.status,
      completedAt,
      durationMs: terminal && Number.isFinite(startedMs) && Number.isFinite(completedMs)
        ? Math.max(0, completedMs - startedMs)
        : null,
      activeDurationMs: next.activeDurationMs ?? previousAttempt.activeDurationMs ?? null,
      queueDurationMs: next.queueDurationMs ?? previousAttempt.queueDurationMs ?? 0,
      userWaitDurationMs: next.userWaitDurationMs ?? previousAttempt.userWaitDurationMs ?? 0,
      reasonCode: next.reasonCode ?? null,
      reviewResult: next.reviewResult ?? null,
      regressions: Number(next.regressions ?? 0),
      commitAfter: next.commitAfter ?? null,
      conversationId: next.conversationId ?? previousAttempt.conversationId ?? null,
      resolvedModel: next.resolvedModel ?? previousAttempt.resolvedModel ?? null,
      retryDirective: next.retryDirective ?? previousAttempt.retryDirective ?? null,
      usage: next.usage ? clone(next.usage) : previousAttempt.usage ?? null,
      durationSeconds: next.durationSeconds ?? previousAttempt.durationSeconds ?? null,
      numTurns: next.numTurns ?? previousAttempt.numTurns ?? null,
    };
    if (attemptIndex >= 0) next.attemptHistory[attemptIndex] = record;
    else next.attemptHistory.push(record);
  }
  return next;
}

function reconcileLocked(artifactDir, state, options = {}) {
  const projectRoot = resolveProjectRoot(artifactDir, options);
  const probeSet = readProbeFile(options.probeFile);
  const now = iso(options.now);
  const git = inspectGit(projectRoot);
  const tasks = {};
  const recommendations = [];
  const pendingExternalProbes = [];

  for (const [taskId, task] of Object.entries(state.tasks)) {
    const probe = probeSet.tasks?.[taskId] ?? probeSet.tasks?.[taskId.toLowerCase()] ?? null;
    const reconciledNow = ["UNKNOWN", "RUNNING", "STALLED", "FAILED", "BLOCKED"].includes(task.status) || Boolean(probe);
    if (reconciledNow) {
      tasks[taskId] = reconcileTask(task, probe, projectRoot, git, now);
    } else {
      tasks[taskId] = clone(task);
    }

    // Only this pass's verdicts become recommendations. A DONE task keeps the `reconciliation` it got
    // while it was STALLED; re-listing it made resume tell the operator to interrupt tasks that had
    // long finished (OficinaAI, 2026-09).
    const reconciled = reconciledNow ? tasks[taskId].reconciliation : null;
    if (reconciled && reconciled.recommendation !== "CONTINUE") {
      recommendations.push({
        taskId,
        action: reconciled.recommendation,
        reason: reconciled.reason,
      });
    }
    if (["UNKNOWN", "RUNNING"].includes(tasks[taskId].status) &&
        tasks[taskId].reconciliation?.externalStatus == null) {
      pendingExternalProbes.push({
        taskId,
        // Req 10.5: a consulta de status usa o Executor registrado no dispatch,
        // nunca o Executor que a configuracao atual derivaria agora.
        executor: tasks[taskId].executor,
        executorSource: tasks[taskId].executorSource ?? null,
        sessionId: tasks[taskId].sessionId,
        jobId: tasks[taskId].jobId ?? null,
        threadId: tasks[taskId].threadId ?? null,
        conversationId: tasks[taskId].conversationId,
        required: true,
      });
    }
  }

  const draft = { ...state, tasks };
  const currentWave = computeCurrentWave(draft);
  const runStatus = deriveRunStatus(tasks, state.status);
  const resumeFromPhase = nextSafeResumePhase(state.lastSafePhase);
  const resume = {
    ...(state.resume ?? {}),
    lastReconciledAt: now,
    resumeFromPhase,
    pendingExternalProbes,
    recommendations,
  };
  const repository = {
    ...(state.repository ?? {}),
    ...git,
    lastObservedHead: git.head ?? state.repository?.lastObservedHead ?? null,
  };

  return {
    tasks,
    runStatus,
    currentWave,
    repository,
    resume,
    report: {
      runId: state.runId,
      reconciledAt: now,
      resumeFromPhase,
      resumeFromPhaseName: phaseName(resumeFromPhase),
      currentWave,
      pendingExternalProbes,
      recommendations,
      git,
    },
  };
}

/** A task without the fields a reconciliation pass rewrites on every call (timestamps only). */
function reconciliationStableView(task) {
  if (!task) return task;
  const { updatedAt: _updatedAt, reconciliation, ...rest } = task;
  if (!reconciliation) return rest;
  const { reconciledAt: _reconciledAt, ...stableReconciliation } = reconciliation;
  return { ...rest, reconciliation: stableReconciliation };
}

function reconciliationChanged(state, result) {
  const previousIds = Object.keys(state.tasks ?? {});
  const nextIds = Object.keys(result.tasks ?? {});
  if (previousIds.length !== nextIds.length || nextIds.some((id) => !Object.hasOwn(state.tasks, id))) return true;
  if (nextIds.some((id) => !isDeepStrictEqual(reconciliationStableView(state.tasks[id]), reconciliationStableView(result.tasks[id])))) return true;
  if (state.status !== result.runStatus || !isDeepStrictEqual(state.currentWave, result.currentWave)) return true;
  const { lastReconciledAt: _a, ...previousResume } = state.resume ?? {};
  const { lastReconciledAt: _b, ...nextResume } = result.resume ?? {};
  if (!isDeepStrictEqual(previousResume, nextResume)) return true;
  return state.repository?.head !== result.repository?.head || state.repository?.dirty !== result.repository?.dirty;
}

export function reconcileRunAtDirectory(artifactDir, options = {}) {
  return withLock(artifactDir, () => {
    // Full replay verification is for explicit reconcile/resume; the watch tick passes
    // verifyReplay: false so a poll does not re-reduce the whole event log (performance finding).
    const state = loadRun(artifactDir, { repairSnapshot: true, verifyReplay: options.verifyReplay !== false }).state;
    assertRunMutable(state, "reconcile executors");
    const result = reconcileLocked(artifactDir, state, options);
    if (options.skipIfUnchanged && !reconciliationChanged(state, result)) {
      return { state, event: null, skipped: true, report: result.report, summary: runSummary(state) };
    }
    const committed = commitEvent(
      artifactDir,
      state,
      "RUN_RECONCILED",
      {
        ...taskDeltaPayload(state.tasks, result.tasks),
        runStatus: result.runStatus,
        currentWave: result.currentWave,
        repository: result.repository,
        resume: result.resume,
      },
      options,
    );
    return {
      state: committed.state,
      event: committed.event,
      report: result.report,
      summary: runSummary(committed.state),
    };
  }, options);
}

export function resumeRunAtDirectory(artifactDir, options = {}) {
  return withLock(artifactDir, () => {
    let state = loadRun(artifactDir, { repairSnapshot: true, verifyReplay: true }).state;
    if (TERMINAL_RUN_STATUSES.has(state.status)) {
      throw new OrchestrationStateError(
        "RUN_TERMINAL",
        `Run ${state.runId} is already ${state.status} and cannot be resumed`,
      );
    }
    const now = iso(options.now);
    const tasks = clone(state.tasks);
    const unknownTasks = [];

    for (const task of Object.values(tasks)) {
      if (task.status === "RUNNING") {
        task.status = "UNKNOWN";
        task.unknownAt = now;
        task.updatedAt = now;
        task.reasonCode = "OWNER_SESSION_INTERRUPTED";
        task.reason = "Previous orchestrator session ended without a durable terminal result";
        unknownTasks.push(task.id);
      }
    }

    const draft = { ...state, tasks };
    const currentWave = computeCurrentWave(draft);
    const runStatus = deriveRunStatus(tasks, state.status);
    const resume = {
      ...(state.resume ?? {}),
      count: Number(state.resume?.count ?? 0) + 1,
      lastResumedAt: now,
      resumeFromPhase: nextSafeResumePhase(state.lastSafePhase),
      pendingExternalProbes: [],
      recommendations: [],
    };
    const resumed = commitEvent(
      artifactDir,
      state,
      "RUN_RESUMED",
      { tasks, runStatus, currentWave, resume, unknownTasks },
      options,
    );
    state = resumed.state;

    const reconciled = reconcileLocked(artifactDir, state, options);
    const committed = commitEvent(
      artifactDir,
      state,
      "RUN_RECONCILED",
      {
        ...taskDeltaPayload(state.tasks, reconciled.tasks),
        runStatus: reconciled.runStatus,
        currentWave: reconciled.currentWave,
        repository: reconciled.repository,
        resume: reconciled.resume,
      },
      options,
    );
    // Req 10.2: a retomada compara o snapshot da Run com o Project_Config_File
    // atual. A decisao entre manter o snapshot e adotar a configuracao atual e do
    // usuario (Req 10.3), entao aqui so reportamos a diferenca.
    const projectConfigDrift = computeProjectConfigDrift(
      committed.state,
      resolveProjectRoot(artifactDir, options),
    );
    return {
      state: committed.state,
      events: [resumed.event, committed.event],
      unknownTasks,
      projectConfigDrift,
      report: { ...reconciled.report, projectConfigDrift },
      summary: runSummary(committed.state),
    };
  }, options);
}

/**
 * Adota a Project_Config atual em uma Run em andamento (Req 10.4).
 *
 * Escopo unico suportado: `pending`. Somente task com `status: PENDING` e
 * `attempt: 0` — ou seja, task ainda nao despachada — tem `executor` e
 * `executorSource` reatribuidos a partir da configuracao atual. Task ja
 * despachada entra em `skippedTaskIds` e mantem o Executor do dispatch, que e o
 * Executor que a reconciliacao e a telemetria usam (Req 10.5).
 *
 * A operacao atualiza o snapshot da Run e emite `PROJECT_CONFIG_UPDATED` com
 * `differences`, `appliedTaskIds`, `skippedTaskIds` e o motivo da mudanca.
 *
 * @param {string} artifactDir Diretorio da Run.
 * @param {object} [options] `scope` (`pending`), `projectConfig` (opcional, no
 *   lugar do arquivo), `reason`, `projectRoot`, `now`, `actor`.
 */
export function applyProjectConfigToRun(artifactDir, options = {}) {
  const scope = String(options.scope ?? "pending").toLowerCase();
  if (scope !== "pending") {
    throw new OrchestrationStateError(
      "INVALID_CONFIG_SCOPE",
      `Project config scope must be "pending", received ${options.scope}`,
      { received: options.scope ?? null, accepted: ["pending"] },
    );
  }

  return withLock(artifactDir, () => {
    const state = loadRun(artifactDir, { repairSnapshot: true }).state;
    assertRunMutable(state, "apply a project configuration");
    const projectRoot = resolveProjectRoot(artifactDir, options);
    const resolvedConfig = loadProjectConfigForRun(projectRoot, options);
    const snapshot = projectConfigSnapshot(resolvedConfig.config, resolvedConfig.source);
    const differences = [
      ...diffProjectConfig(state.projectConfig?.roles ?? null, snapshot.roles),
      ...diffQuotaFallbackChain(
        { [QUOTA_FALLBACK_FIELD]: state.projectConfig?.quotaFallbackChain ?? DEFAULT_QUOTA_FALLBACK_CHAIN },
        { [QUOTA_FALLBACK_FIELD]: snapshot.quotaFallbackChain },
      ),
    ].map((entry) => ({ ...entry }));
    const now = iso(options.now);
    const reason = options.reason
      ?? "User adopted the current project configuration for tasks that were not dispatched yet";

    const tasks = {};
    const appliedTaskIds = [];
    const skippedTaskIds = [];
    const skipped = [];
    const changes = [];

    for (const [taskId, task] of Object.entries(state.tasks)) {
      const eligible = task.status === "PENDING" && Number(task.attempt ?? 0) === 0;
      if (!eligible) {
        tasks[taskId] = clone(task);
        skippedTaskIds.push(taskId);
        skipped.push({
          taskId,
          reason: "ALREADY_DISPATCHED",
          status: task.status,
          attempt: Number(task.attempt ?? 0),
          executor: task.executor ?? null,
        });
        continue;
      }

      const derived = deriveTaskExecutor(task, snapshot.roles);
      if (derived == null) {
        tasks[taskId] = clone(task);
        skippedTaskIds.push(taskId);
        skipped.push({
          taskId,
          reason: "CATEGORY_NOT_CLASSIFIED",
          status: task.status,
          attempt: Number(task.attempt ?? 0),
          executor: task.executor ?? null,
        });
        continue;
      }

      const next = clone(task);
      if (next.executor !== derived.executor || next.executorSource !== derived.executorSource) {
        changes.push({
          taskId,
          from: next.executor ?? null,
          to: derived.executor,
          category: next.category ?? null,
        });
      }
      next.executor = derived.executor;
      next.executorSource = derived.executorSource;
      next.updatedAt = now;
      tasks[taskId] = next;
      appliedTaskIds.push(taskId);
    }

    const draft = { ...state, tasks };
    const currentWave = computeCurrentWave(draft);
    const runStatus = deriveRunStatus(tasks, state.status);
    const committed = commitEvent(
      artifactDir,
      state,
      "PROJECT_CONFIG_UPDATED",
      {
        tasks,
        projectConfig: snapshot,
        runStatus,
        currentWave,
        scope,
        reason,
        differences,
        appliedTaskIds,
        skippedTaskIds,
      },
      options,
    );

    return {
      state: committed.state,
      event: committed.event,
      projectConfig: snapshot,
      previousProjectConfig: clone(state.projectConfig ?? null),
      scope,
      reason,
      differences,
      appliedTaskIds,
      skippedTaskIds,
      skipped,
      changes,
      summary: runSummary(committed.state),
    };
  }, options);
}

/**
 * Compara o snapshot da Run com o Project_Config_File atual sem mutar a Run.
 *
 * Insumo do ramo de decisao do `resume` (Req 10.2, 10.3) e do relatorio de
 * status. Run sem snapshot devolve `changed: false` e `source: "legacy"`.
 */
export function inspectProjectConfigDrift(artifactDir, options = {}) {
  const loaded = loadRun(artifactDir);
  return {
    artifactDir: resolve(artifactDir),
    projectConfig: clone(loaded.state.projectConfig ?? null),
    projectConfigDrift: computeProjectConfigDrift(
      loaded.state,
      resolveProjectRoot(artifactDir, options),
    ),
  };
}

export function resolveTaskScope(artifactDir, taskId, decision, options = {}) {
  const normalizedDecision = String(decision ?? "").toUpperCase();
  if (!new Set(["REMOVE", "REINSTATE"]).has(normalizedDecision)) {
    throw new OrchestrationStateError(
      "INVALID_SCOPE_DECISION",
      `Scope decision must be REMOVE or REINSTATE, received ${decision}`,
    );
  }
  if (!options.reason) {
    throw new OrchestrationStateError(
      "SCOPE_DECISION_REQUIRES_REASON",
      "A durable scope decision requires a reason",
    );
  }
  return withLock(artifactDir, () => {
    const state = loadRun(artifactDir, { repairSnapshot: true }).state;
    assertRunMutable(state, "resolve task scope");
    const normalizedTaskId = ensureTask(state, taskId);
    const previous = state.tasks[normalizedTaskId];
    const now = iso(options.now);
    if (normalizedDecision === "REMOVE") {
      if (previous.sourcePresent !== false) {
        throw new OrchestrationStateError(
          "TASK_STILL_PRESENT_IN_SOURCE",
          `Task ${normalizedTaskId} is still present in tasks-classification.md`,
        );
      }
      if (["RUNNING", "STALLED", "UNKNOWN"].includes(previous.status)) {
        throw new OrchestrationStateError(
          "TASK_SCOPE_ACTIVE",
          `Task ${normalizedTaskId} must be interrupted and reconciled before removal`,
        );
      }
    } else if (previous.sourcePresent === false) {
      throw new OrchestrationStateError(
        "TASK_NOT_REINSTATED_IN_SOURCE",
        `Restore task ${normalizedTaskId} in tasks-classification.md and sync before REINSTATE`,
      );
    }

    const task = {
      ...clone(previous),
      status: normalizedDecision === "REMOVE" && previous.status !== "DONE"
        ? "CANCELLED"
        : previous.status,
      completedAt: normalizedDecision === "REMOVE" && previous.status !== "DONE"
        ? now
        : previous.completedAt,
      scopeResolution: {
        status: normalizedDecision === "REMOVE" ? "REMOVED" : "REINSTATED",
        reason: options.reason,
        decidedBy: options.actor ?? "orchestrator",
        decidedAt: now,
      },
      reasonCode: normalizedDecision === "REMOVE"
        ? "SCOPE_REMOVED"
        : previous.reasonCode,
      updatedAt: now,
    };
    const tasks = { ...state.tasks, [normalizedTaskId]: task };
    const currentWave = computeCurrentWave({ ...state, tasks });
    const runStatus = deriveRunStatus(tasks, state.status);
    const sync = {
      ...(state.sync ?? {}),
      scopeResolutions: {
        ...(state.sync?.scopeResolutions ?? {}),
        [normalizedTaskId]: clone(task.scopeResolution),
      },
    };
    const committed = commitEvent(
      artifactDir,
      state,
      "TASK_SCOPE_RESOLVED",
      { taskId: normalizedTaskId, task, runStatus, currentWave, sync },
      options,
    );
    return {
      state: committed.state,
      event: committed.event,
      task: committed.state.tasks[normalizedTaskId],
      summary: runSummary(committed.state),
    };
  }, options);
}

export function updateTaskLease(artifactDir, taskId, action, options = {}) {
  const normalizedAction = String(action ?? "").toUpperCase();
  if (!new Set(["ACQUIRE", "RENEW", "RELEASE"]).has(normalizedAction)) {
    throw new OrchestrationStateError(
      "INVALID_LEASE_ACTION",
      `Lease action must be ACQUIRE, RENEW, or RELEASE; received ${action}`,
    );
  }
  const ownerId = String(options.ownerId ?? "").trim();
  if (!ownerId) {
    throw new OrchestrationStateError("LEASE_OWNER_REQUIRED", "A lease ownerId is required");
  }
  return withLock(artifactDir, () => {
    const state = loadRun(artifactDir, { repairSnapshot: true }).state;
    assertRunMutable(state, `${normalizedAction.toLowerCase()} a task lease`);
    const normalizedTaskId = ensureTask(state, taskId);
    const nowDate = asDate(options.now);
    const now = iso(nowDate);
    const previous = clone(state.tasks[normalizedTaskId]);
    const lease = previous.lease ?? null;
    const leaseActive = lease?.status === "ACTIVE" &&
      new Date(lease.expiresAt).getTime() > nowDate.getTime();

    if (normalizedAction === "ACQUIRE" && leaseActive && lease.ownerId !== ownerId) {
      throw new OrchestrationStateError(
        "TASK_LEASE_HELD",
        `Task ${normalizedTaskId} is leased by ${lease.ownerId}`,
        { lease },
      );
    }
    if (["RENEW", "RELEASE"].includes(normalizedAction) && leaseActive && lease.ownerId !== ownerId) {
      throw new OrchestrationStateError(
        "TASK_LEASE_OWNERSHIP_MISMATCH",
        `Task ${normalizedTaskId} lease belongs to ${lease.ownerId}`,
      );
    }
    if (normalizedAction === "RENEW" && !leaseActive) {
      throw new OrchestrationStateError(
        "TASK_LEASE_EXPIRED",
        `Task ${normalizedTaskId} has no active lease to renew`,
      );
    }

    const ttlSeconds = Math.max(30, Number(options.ttlSeconds ?? 900));
    previous.lease = normalizedAction === "RELEASE"
      ? {
          ...(lease ?? {}),
          ownerId,
          status: "RELEASED",
          releasedAt: now,
          updatedAt: now,
        }
      : {
          ownerId,
          status: "ACTIVE",
          acquiredAt: normalizedAction === "ACQUIRE"
            ? now
            : lease.acquiredAt,
          renewedAt: normalizedAction === "RENEW" ? now : null,
          expiresAt: new Date(nowDate.getTime() + ttlSeconds * 1000).toISOString(),
          ttlSeconds,
          updatedAt: now,
        };
    previous.updatedAt = now;
    const tasks = { ...state.tasks, [normalizedTaskId]: previous };
    const currentWave = computeCurrentWave({ ...state, tasks });
    const runStatus = deriveRunStatus(tasks, state.status);
    const committed = commitEvent(
      artifactDir,
      state,
      "TASK_LEASE_UPDATED",
      { taskId: normalizedTaskId, task: previous, runStatus, currentWave },
      options,
    );
    return {
      state: committed.state,
      event: committed.event,
      lease: committed.state.tasks[normalizedTaskId].lease,
      summary: runSummary(committed.state),
    };
  }, options);
}

const WORKSPACE_STATUSES = new Set([
  "PLANNED",
  "CREATED",
  "RUNNING",
  "READY",
  "INTEGRATING",
  "MERGED",
  "CONFLICT",
  "BLOCKED",
  "CLEANED",
  "UNKNOWN",
]);

export function updateTaskWorkspace(artifactDir, taskId, workspace, options = {}) {
  const status = String(workspace?.status ?? "UNKNOWN").toUpperCase();
  if (!WORKSPACE_STATUSES.has(status)) {
    throw new OrchestrationStateError(
      "INVALID_WORKSPACE_STATUS",
      `Invalid workspace status: ${workspace?.status}`,
    );
  }
  return withLock(artifactDir, () => {
    const state = loadRun(artifactDir, { repairSnapshot: true }).state;
    assertRunMutable(state, "update a task workspace");
    const normalizedTaskId = ensureTask(state, taskId);
    const now = iso(options.now);
    const task = {
      ...clone(state.tasks[normalizedTaskId]),
      workspace: {
        ...(state.tasks[normalizedTaskId].workspace ?? {}),
        ...clone(workspace),
        status,
        updatedAt: now,
      },
      updatedAt: now,
    };
    const tasks = { ...state.tasks, [normalizedTaskId]: task };
    const currentWave = computeCurrentWave({ ...state, tasks });
    const runStatus = deriveRunStatus(tasks, state.status);
    const committed = commitEvent(
      artifactDir,
      state,
      "TASK_WORKSPACE_UPDATED",
      { taskId: normalizedTaskId, task, runStatus, currentWave },
      options,
    );
    return {
      state: committed.state,
      event: committed.event,
      workspace: committed.state.tasks[normalizedTaskId].workspace,
      summary: runSummary(committed.state),
    };
  }, options);
}

/** Estados aceitos para `quotaHandoffs[].quotaRecoveryCheck`. */
export const QUOTA_RECOVERY_CHECK_STATUSES = Object.freeze(["PENDING", "RESTORED"]);
const QUOTA_RECOVERY_CHECK_SET = new Set(QUOTA_RECOVERY_CHECK_STATUSES);

/**
 * Valida e normaliza uma entrada de `state.json.quotaHandoffs[]` (contrato de
 * repasse do fallback de cota opt-in `quotaFallbackChain`).
 *
 * Mesmo formato descrito em `references/project-config.md`/`SKILL.md`:
 * `{ taskId, wave, fromExecutor, toExecutor, reasonCode, chainPosition,
 * timestamp, quotaRecoveryCheck }`. `fromExecutor`/`toExecutor` pertencem ao
 * conjunto `codex`/`agy`/`claude-code` (o mesmo de `EXECUTORS`); `chainPosition`
 * e a posicao (1-based) do elo escolhido na cadeia fixa `claude-code, codex,
 * agy`.
 */
function normalizeQuotaHandoffEntry(entry, { now } = {}) {
  const taskId = String(entry?.taskId ?? "").trim();
  if (!taskId) {
    throw new OrchestrationStateError("INVALID_QUOTA_HANDOFF", "quotaHandoff.taskId is required");
  }
  const fromExecutor = String(entry?.fromExecutor ?? "").trim().toLowerCase();
  if (!EXECUTOR_SET.has(fromExecutor)) {
    throw new OrchestrationStateError(
      "INVALID_QUOTA_HANDOFF",
      `quotaHandoff.fromExecutor must be one of ${EXECUTORS.join(", ")}`,
      { field: "fromExecutor", received: entry?.fromExecutor ?? null },
    );
  }
  const toExecutor = String(entry?.toExecutor ?? "").trim().toLowerCase();
  if (!EXECUTOR_SET.has(toExecutor)) {
    throw new OrchestrationStateError(
      "INVALID_QUOTA_HANDOFF",
      `quotaHandoff.toExecutor must be one of ${EXECUTORS.join(", ")}`,
      { field: "toExecutor", received: entry?.toExecutor ?? null },
    );
  }
  if (fromExecutor === toExecutor) {
    throw new OrchestrationStateError(
      "INVALID_QUOTA_HANDOFF",
      "quotaHandoff.fromExecutor and toExecutor must differ",
    );
  }
  const reasonCode = String(entry?.reasonCode ?? "").trim();
  if (!reasonCode) {
    throw new OrchestrationStateError("INVALID_QUOTA_HANDOFF", "quotaHandoff.reasonCode is required");
  }
  const chainPosition = Number(entry?.chainPosition);
  if (!Number.isInteger(chainPosition) || chainPosition < 1) {
    throw new OrchestrationStateError(
      "INVALID_QUOTA_HANDOFF",
      "quotaHandoff.chainPosition must be a positive integer",
      { field: "chainPosition", received: entry?.chainPosition ?? null },
    );
  }
  const quotaRecoveryCheck = String(entry?.quotaRecoveryCheck ?? "PENDING").toUpperCase();
  if (!QUOTA_RECOVERY_CHECK_SET.has(quotaRecoveryCheck)) {
    throw new OrchestrationStateError(
      "INVALID_QUOTA_HANDOFF",
      `quotaHandoff.quotaRecoveryCheck must be one of ${QUOTA_RECOVERY_CHECK_STATUSES.join(", ")}`,
      { field: "quotaRecoveryCheck", received: entry?.quotaRecoveryCheck ?? null },
    );
  }
  return {
    taskId,
    wave: entry?.wave ?? null,
    fromExecutor,
    toExecutor,
    reasonCode,
    chainPosition,
    timestamp: entry?.timestamp ?? iso(now),
    quotaRecoveryCheck,
  };
}

/**
 * Grava uma entrada em `state.json.quotaHandoffs[]`: o contrato de repasse do
 * fallback de cota opt-in (`quotaFallbackChain`, `Politica de quota` no
 * SKILL.md). Mesmo padrao de `updateTaskWorkspace` — grava uma sub-estrutura
 * do estado sem tocar `events.jsonl` diretamente — mas o repasse nao pertence a
 * uma unica task workspace, entao vive num array proprio no topo do estado.
 *
 * Nunca reabre nem reexecuta a task: apenas registra a troca de Executor para
 * telemetria/auditoria. `scripts/lib/quota-fallback.mjs::recordQuotaHandoff` e
 * a camada fina que os consumidores chamam.
 */
export function appendQuotaHandoff(artifactDir, entry, options = {}) {
  return withLock(artifactDir, () => {
    const state = loadRun(artifactDir, { repairSnapshot: true }).state;
    assertRunMutable(state, "record a quota handoff");
    const normalized = normalizeQuotaHandoffEntry(entry, { now: options.now });
    const quotaHandoffs = [...(state.quotaHandoffs ?? []), normalized];
    const committed = commitEvent(artifactDir, state, "QUOTA_HANDOFF_RECORDED", { quotaHandoffs }, options);
    return {
      state: committed.state,
      event: committed.event,
      quotaHandoff: normalized,
      quotaHandoffs: committed.state.quotaHandoffs,
    };
  }, options);
}

/** Le `state.json.quotaHandoffs[]` sem mutar o estado. */
export function readQuotaHandoffs(artifactDir, options = {}) {
  const { state } = loadRun(artifactDir, options);
  return state.quotaHandoffs ?? [];
}

/**
 * Atualiza `quotaRecoveryCheck` das entradas de `taskId` em `quotaHandoffs[]`
 * (ciclo de monitoramento por heartbeat/sweep, secao "Monitoramento" do plano
 * de fallback de cota). Puramente informativo: nunca reabre nem reexecuta a
 * task, so atualiza o campo de acompanhamento.
 */
export function markQuotaHandoffRecoveryChecked(artifactDir, taskId, status, options = {}) {
  const normalizedStatus = String(status ?? "").toUpperCase();
  if (!QUOTA_RECOVERY_CHECK_SET.has(normalizedStatus)) {
    throw new OrchestrationStateError(
      "INVALID_QUOTA_HANDOFF",
      `quotaRecoveryCheck must be one of ${QUOTA_RECOVERY_CHECK_STATUSES.join(", ")}`,
      { field: "quotaRecoveryCheck", received: status ?? null },
    );
  }
  return withLock(artifactDir, () => {
    const state = loadRun(artifactDir, { repairSnapshot: true }).state;
    const existing = state.quotaHandoffs ?? [];
    let touched = false;
    const quotaHandoffs = existing.map((item) => {
      if (item.taskId !== taskId) return item;
      touched = true;
      return { ...item, quotaRecoveryCheck: normalizedStatus };
    });
    if (!touched) {
      throw new OrchestrationStateError(
        "QUOTA_HANDOFF_NOT_FOUND",
        `No quota handoff recorded for task ${taskId}`,
        { taskId },
      );
    }
    const committed = commitEvent(artifactDir, state, "QUOTA_HANDOFF_UPDATED", { quotaHandoffs }, options);
    return { state: committed.state, event: committed.event, quotaHandoffs: committed.state.quotaHandoffs };
  }, options);
}

export function requestRunCancellation(artifactDir, options = {}) {
  if (!options.reason) {
    throw new OrchestrationStateError(
      "CANCELLATION_REQUIRES_REASON",
      "Run cancellation requires a reason",
    );
  }
  return withLock(artifactDir, () => {
    const state = loadRun(artifactDir, { repairSnapshot: true, verifyReplay: true }).state;
    assertRunMutable(state, "request cancellation");
    const now = iso(options.now);
    const tasks = clone(state.tasks);
    const pendingExecutorStops = [];
    for (const task of Object.values(tasks)) {
      if (["RUNNING", "STALLED", "UNKNOWN"].includes(task.status)) {
        task.status = "UNKNOWN";
        task.unknownAt = now;
        task.reasonCode = "CANCEL_REQUESTED";
        task.reason = options.reason;
        task.updatedAt = now;
        pendingExecutorStops.push({
          taskId: task.id,
          executor: task.executor,
          sessionId: task.sessionId,
          conversationId: task.conversationId,
          action: "INTERRUPT_THEN_RECONCILE",
        });
      } else if (["PENDING", "FAILED", "BLOCKED"].includes(task.status)) {
        task.status = "CANCELLED";
        task.completedAt = now;
        task.reasonCode = "CANCEL_REQUESTED";
        task.reason = options.reason;
        task.updatedAt = now;
      }
    }
    const currentWave = computeCurrentWave({ ...state, tasks });
    const runStatus = pendingExecutorStops.length > 0 ? "UNKNOWN" : "BLOCKED";
    assertRunTransition(state, runStatus);
    const cancellation = {
      requestedAt: state.cancellation?.requestedAt ?? now,
      requestedBy: options.actor ?? "orchestrator",
      reason: options.reason,
      pendingExecutorStops,
      finalizedAt: null,
    };
    const resume = {
      ...(state.resume ?? {}),
      pendingExternalProbes: pendingExecutorStops.map((entry) => ({
        taskId: entry.taskId,
        executor: entry.executor,
        sessionId: entry.sessionId,
        conversationId: entry.conversationId,
        required: true,
        purpose: "cancellation",
      })),
      recommendations: pendingExecutorStops.map((entry) => ({
        taskId: entry.taskId,
        action: entry.action,
        reason: "Cancellation was requested; verify the executor stopped before finalizing",
      })),
    };
    const committed = commitEvent(
      artifactDir,
      state,
      "RUN_CANCELLATION_REQUESTED",
      { tasks, runStatus, currentWave, cancellation, resume },
      options,
    );
    return {
      state: committed.state,
      event: committed.event,
      pendingExecutorStops,
      summary: runSummary(committed.state),
    };
  }, options);
}

export function auditRunCompletion(artifactDir) {
  const state = loadRun(artifactDir, { verifyReplay: true }).state;
  return completionAudit(artifactDir, state);
}

// Non-functional requirements whose category is about security, privacy, tenant isolation or
// compliance need executable proof: a code reference is not enough. Audit finding: a real run
// (OficinaAI, 2026-09) shipped privilege escalation and cross-tenant reads that "had evidence".
const CRITICAL_NFR_CATEGORY = /seguran|security|privac|lgpd|gdpr|isolament|isolation|tenant|autentica|authentica|autoriza|authoriz|complian|conformidade|auditoria/i;

/** plan/requirements-index.json (validate-requirements-coverage.mjs --dir), or null. */
function readRequirementsIndex(artifactDir) {
  const resolved = resolveArtifact(artifactDir, "requirements-index.json");
  if (!resolved) return null;
  try {
    return JSON.parse(readFileSync(resolved.path, "utf8"));
  } catch {
    return null;
  }
}

function requirementsIndexExpectations(index) {
  if (!index) return { ids: [], criteriaByRequirement: new Map(), criticalIds: new Set() };
  const upper = (value) => (typeof value === "string" ? value.toUpperCase() : null);
  const ids = [
    ...(index.requirements ?? []), ...(index.nonFunctionalRequirements ?? []), ...(index.architecturePatterns ?? []),
  ].map((entry) => upper(entry?.id)).filter(Boolean);
  const criteriaByRequirement = new Map();
  for (const criterion of index.acceptanceCriteria ?? []) {
    const criterionId = upper(criterion?.id);
    const owners = Array.isArray(criterion?.requirementIds) && criterion.requirementIds.length
      ? criterion.requirementIds
      : [criterion?.requirementId];
    for (const owner of owners.map(upper).filter(Boolean)) {
      if (!criterionId) continue;
      if (!criteriaByRequirement.has(owner)) criteriaByRequirement.set(owner, new Set());
      criteriaByRequirement.get(owner).add(criterionId);
    }
  }
  const criticalIds = new Set((index.nonFunctionalRequirements ?? [])
    .filter((entry) => CRITICAL_NFR_CATEGORY.test(`${entry?.category ?? ""} ${entry?.text ?? ""}`))
    .map((entry) => upper(entry?.id)).filter(Boolean));
  return { ids, criteriaByRequirement, criticalIds };
}

function requirementsEvidenceAudit(artifactDir, state) {
  const gate = state.completionGates?.requirementsCoverage;
  // A missing gate identifies a run created before 4.10.0. It is not silently
  // promoted to DONE: callers receive PARTIAL as the recommended disposition.
  if (!gate) return { applicable: false, legacy: true, valid: false, reason: "REQUIREMENTS_EVIDENCE_GATE_MISSING" };
  if (!gate.required) return { applicable: false, legacy: false, valid: true, reason: "REQUIREMENTS_EVIDENCE_NOT_APPLICABLE" };
  return evaluateRequirementsEvidence(artifactDir, state);
}

/**
 * Content check of review/requirements-evidence.json. Expected ids are every id a task claims PLUS,
 * when the index snapshot exists, every RF/RNF/ARC the Pensador extracted; an RF entry must carry
 * every CA the PRD links to it; a security/privacy/isolation RNF needs `kind: "test"` evidence.
 * Runs when the gate closes (updateCompletionGate) and again in the completion audit — the gate used
 * to close DONE on the mere existence of the file while the review rejected 7 CAs (OficinaAI).
 */
function evaluateRequirementsEvidence(artifactDir, state) {
  const resolved = resolveArtifact(artifactDir, "requirements-evidence.json");
  if (!resolved) return { applicable: true, legacy: false, valid: false, reason: "REQUIREMENTS_EVIDENCE_MISSING" };
  try {
    const payload = JSON.parse(readFileSync(resolved.path, "utf8"));
    if (payload?.schemaVersion !== 1) {
      return { applicable: true, legacy: false, valid: false, reason: "REQUIREMENTS_EVIDENCE_INVALID_SCHEMA" };
    }
    const index = requirementsIndexExpectations(readRequirementsIndex(artifactDir));
    const expectedRequirementIds = [...new Set([
      ...Object.values(state.tasks ?? {}).flatMap((task) => (task.requirementIds ?? []).map((id) => String(id).toUpperCase())),
      ...index.ids,
    ])].sort();
    const entries = Array.isArray(payload?.requirements) ? payload.requirements : [];
    const seen = new Set();
    const invalid = [];
    const missingAcceptanceCriteria = [];
    const untestedCriticalRequirements = [];
    for (const entry of entries) {
      const requirementId = typeof entry?.requirementId === "string" ? entry.requirementId.toUpperCase() : entry?.requirementId;
      const criteria = Array.isArray(entry?.acceptanceCriteria) ? entry.acceptanceCriteria : [];
      const linked = index.criteriaByRequirement.get(requirementId);
      if (linked) {
        const present = new Set(criteria.map((criterion) => String(criterion?.id ?? "").toUpperCase()));
        const missing = [...linked].filter((id) => !present.has(id));
        if (missing.length > 0) missingAcceptanceCriteria.push({ requirementId, missing });
      }
      if (index.criticalIds.has(requirementId) && !criteria.some((criterion) =>
        Array.isArray(criterion?.evidence) && criterion.evidence.some((evidence) => String(evidence?.kind ?? "").toLowerCase() === "test"))) {
        untestedCriticalRequirements.push(requirementId);
      }
      const duplicate = Boolean(requirementId && seen.has(requirementId));
      if (requirementId && expectedRequirementIds.includes(requirementId)) seen.add(requirementId);
      const hasInvalidCriterion = !Array.isArray(entry?.acceptanceCriteria) ||
        entry.acceptanceCriteria.length === 0 || entry.acceptanceCriteria.some((criterion) =>
          !criterion?.id || criterion.status !== "PASS" || !Array.isArray(criterion.evidence) ||
          criterion.evidence.length === 0 || criterion.evidence.some((evidence) =>
            !evidence || typeof evidence !== "object" || Array.isArray(evidence) ||
            typeof evidence.kind !== "string" || evidence.kind.trim() === "" ||
            typeof evidence.ref !== "string" || evidence.ref.trim() === "",
          ),
        );
      const hasOpenFindings = !Array.isArray(entry?.findings) ||
        entry.findings.some((finding) => finding?.status !== "RESOLVED");
      if (!requirementId || !expectedRequirementIds.includes(requirementId) || duplicate || hasInvalidCriterion || hasOpenFindings) {
        invalid.push(entry);
      }
    }
    const missingRequirementIds = expectedRequirementIds.filter((requirementId) => !seen.has(requirementId));
    return {
      applicable: true,
      legacy: false,
      valid: entries.length > 0 && invalid.length === 0 && missingRequirementIds.length === 0
        && missingAcceptanceCriteria.length === 0 && untestedCriticalRequirements.length === 0,
      invalidRequirementIds: invalid.map((entry) => entry.requirementId),
      missingRequirementIds,
      missingAcceptanceCriteria,
      untestedCriticalRequirements,
    };
  } catch {
    return { applicable: true, legacy: false, valid: false, reason: "REQUIREMENTS_EVIDENCE_INVALID_JSON" };
  }
}

function completionAudit(artifactDir, state) {
  const tasks = Object.values(state.tasks ?? {});
  const unresolvedScope = tasks.filter(
    (task) => task.sourcePresent === false && task.scopeResolution?.status !== "REMOVED",
  );
  const incompleteTasks = tasks.filter((task) => {
    if (task.sourcePresent === false && task.scopeResolution?.status === "REMOVED") {
      return !["DONE", "CANCELLED"].includes(task.status);
    }
    return task.status !== "DONE";
  });
  const pendingWorkspaces = tasks.filter((task) => task.workspace && (
    task.workspace.integrationStatus !== "MERGED" || task.workspace.cleanupStatus !== "CLEANED"
  ));
  const doneParentsWithActiveChildren = tasks.filter((parent) => parent.status === "DONE" && tasks.some((child) =>
    (child.parentTaskId === parent.id || child.parentId === parent.id) && child.status === "RUNNING",
  ));
  const tasksWithoutEvidencePlan = tasks.filter(
    (task) =>
      task.sourcePresent !== false &&
      (task.expectedFiles ?? []).length === 0 &&
      (task.validationPlan ?? []).length === 0,
  );
  const completionGates = synchronizeCompletionGates(
    state.completionGates,
    state.tasks,
    state.updatedAt,
    artifactDir,
  );
  const incompleteGates = Object.values(completionGates).filter((gate) =>
    gate.required ? gate.status !== "DONE" : !["DONE", "N/A"].includes(gate.status),
  );
  const gatesWithoutEvidence = Object.values(completionGates).filter(
    (gate) => gate.status === "DONE" && (gate.evidence ?? []).length === 0,
  );
  const invalidGateEvidence = currentGateEvidenceFindings(artifactDir, completionGates, state);
  // A waivable gate (e.g. browserE2E) explicitly marked N/A via `--required false`
  // still means the corresponding verification never ran — it just did so with a
  // documented reason instead of silently. `incompleteGates` alone can't see this,
  // because a waived gate's status (N/A) already satisfies its own (now false)
  // `required` flag. A run with any waived gate must never self-report `complete:
  // true`: it needs to close as PARTIAL (WORKFLOW.md sec. 14, scenario E), with the
  // waiver surfaced for a human to accept, reject, or unblock instead.
  // Um gate delegado (`delegatedTo` setado — ver updateCompletionGate) e
  // distinto de um waiver puro: a verificacao nao deixou de rodar, ela roda
  // no proximo estagio da cadeia (ex.: Fase 9.5 quando a run e modo conjunto
  // a partir do Pensador e o Testador esta instalado). So conta como
  // legitimamente delegada se `report/handoff.json` de fato apontar
  // `nextStage.consumer` para o mesmo plugin — senao a delegacao e invalida e
  // volta a se comportar como waiver puro (a run fecha PARTIAL, nao DONE).
  const delegatedGates = Object.values(completionGates).filter(
    (gate) => gate.requiredOverride === false && gate.delegatedTo,
  );
  // A gate whose definition lists notApplicableReasons was waived with one of them (enforced in
  // updateCompletionGate): it did not apply, so it does not force PARTIAL like a skipped verification.
  const notApplicableGates = Object.values(completionGates).filter(
    (gate) => gate.requiredOverride === false && !gate.delegatedTo && COMPLETION_GATE_DEFINITIONS[gate.id]?.notApplicableReasons,
  );
  const waivedGates = Object.values(completionGates).filter(
    (gate) => gate.requiredOverride === false && !gate.delegatedTo && !COMPLETION_GATE_DEFINITIONS[gate.id]?.notApplicableReasons,
  );
  const nextStageConsumer = delegatedGates.length > 0
    ? readHandoffNextStageConsumer(artifactDir)
    : null;
  const invalidDelegations = delegatedGates.filter(
    (gate) => gate.delegatedTo !== nextStageConsumer,
  );
  const requiredArtifacts = [
    "workflow-log.md",
    "subagents-context.md",
    "implementation-report.md",
    "handoff.json",
    "learning-report.md",
  ];
  const missingArtifacts = requiredArtifacts.filter(
    (name) => !artifactExists(artifactDir, name),
  );
  const invalidHandoff = handoffValidationFindings(artifactDir);
  const phaseComplete = Number(state.lastSafePhase) >= 12 &&
    Number(state.phase) === 12 &&
    state.phaseStatus === "DONE";
  const requirementsEvidence = requirementsEvidenceAudit(artifactDir, state);
  const complete =
    tasks.length > 0 &&
    phaseComplete &&
    incompleteTasks.length === 0 &&
    pendingWorkspaces.length === 0 &&
    doneParentsWithActiveChildren.length === 0 &&
    tasksWithoutEvidencePlan.length === 0 &&
    unresolvedScope.length === 0 &&
    incompleteGates.length === 0 &&
    gatesWithoutEvidence.length === 0 &&
    invalidGateEvidence.length === 0 &&
    waivedGates.length === 0 &&
    invalidDelegations.length === 0 &&
    missingArtifacts.length === 0 &&
    invalidHandoff.length === 0 &&
    requirementsEvidence.valid;
  return {
    taskCount: tasks.length,
    phaseComplete,
    incompleteTasks: incompleteTasks.map((task) => ({ id: task.id, status: task.status })),
    pendingWorkspaces: pendingWorkspaces.map((task) => ({ id: task.id, integrationStatus: task.workspace.integrationStatus, cleanupStatus: task.workspace.cleanupStatus })),
    doneParentsWithActiveChildren: doneParentsWithActiveChildren.map((task) => task.id),
    tasksWithoutEvidencePlan: tasksWithoutEvidencePlan.map((task) => task.id),
    unresolvedScope: unresolvedScope.map((task) => task.id),
    incompleteGates: incompleteGates.map((gate) => ({ id: gate.id, status: gate.status })),
    gatesWithoutEvidence: gatesWithoutEvidence.map((gate) => gate.id),
    invalidGateEvidence,
    waivedGates: waivedGates.map((gate) => ({ id: gate.id, reason: gate.reason })),
    notApplicableGates: notApplicableGates.map((gate) => ({ id: gate.id, reason: gate.reason })),
    delegatedGates: delegatedGates.map((gate) => ({
      id: gate.id,
      delegatedTo: gate.delegatedTo,
      reason: gate.reason,
      valid: gate.delegatedTo === nextStageConsumer,
    })),
    invalidDelegations: invalidDelegations.map((gate) => ({
      id: gate.id,
      delegatedTo: gate.delegatedTo,
      actualNextStageConsumer: nextStageConsumer,
      code: "DELEGATION_WITHOUT_NEXT_STAGE",
    })),
    missingArtifacts,
    invalidHandoff,
    requirementsEvidence,
    recommendedRunStatus: complete ? "DONE" : "PARTIAL",
    complete,
  };
}

/**
 * Findings de `validateHandoff()` sobre o `handoff.json` da run (vazio quando valido ou ausente —
 * a presenca ja e exigida por `requiredArtifacts`). Um handoff escrito a mao, sem `handoffVersion`,
 * `stage`, `producer`, ... ja foi entregue como concluido numa run real do Pensador; aqui ele
 * impede o `DONE` em vez de deixar o proximo estagio degradar para descoberta por convencao.
 */
function handoffValidationFindings(artifactDir) {
  const resolved = resolveArtifact(artifactDir, "handoff.json");
  if (!resolved) return [];
  try {
    const result = validateHandoff(JSON.parse(readFileSync(resolved.path, "utf8")));
    return result.ok ? [] : (result.errors ?? []).map((error) => ({ code: error.code, path: error.path ?? null }));
  } catch (error) {
    return [{ code: "HANDOFF_NOT_JSON", path: null, message: error.message }];
  }
}

/** Le `nextStage.consumer` de `report/handoff.json`, ou `null` quando o
 * arquivo nao existe ou nao parseia — nesse caso a delegacao fica sem como
 * ser confirmada e `invalidDelegations` a rejeita (falha fechada). */
function readHandoffNextStageConsumer(artifactDir) {
  const resolved = resolveArtifact(artifactDir, "handoff.json");
  if (!resolved) return null;
  try {
    const parsed = JSON.parse(readFileSync(resolved.path, "utf8"));
    return parsed?.nextStage?.consumer ?? null;
  } catch {
    return null;
  }
}

export function updateRunStatus(artifactDir, status, options = {}) {
  const normalizedStatus = String(status ?? "").toUpperCase();
  if (!RUN_STATUS_SET.has(normalizedStatus)) {
    throw new OrchestrationStateError(
      "INVALID_RUN_STATUS",
      `Invalid run status: ${status}`,
    );
  }

  return withLock(artifactDir, () => {
    const state = loadRun(artifactDir, { repairSnapshot: true }).state;
    if (state.status === normalizedStatus && TERMINAL_RUN_STATUSES.has(normalizedStatus)) {
      return { changed: false, state, summary: runSummary(state) };
    }
    assertRunMutable(state, "update run status");
    assertRunTransition(state, normalizedStatus);
    if (normalizedStatus === "DONE") {
      const audit = completionAudit(artifactDir, state);
      if (!audit.complete) {
        throw new OrchestrationStateError(
          "RUN_COMPLETION_GATES_FAILED",
          `Run ${state.runId} cannot be DONE until tasks, scope, Phase 12, gates, evidence, and artifacts are complete`,
          audit,
        );
      }
    }
    let cancellation = state.cancellation ?? null;
    if (normalizedStatus === "CANCELLED") {
      const nonTerminalTasks = Object.values(state.tasks ?? {}).filter(
        (task) => !TERMINAL_TASK_STATUSES.has(task.status),
      );
      if (!cancellation?.requestedAt) {
        throw new OrchestrationStateError(
          "CANCELLATION_NOT_REQUESTED",
          "Request cancellation and reconcile executors before finalizing the run",
        );
      }
      if (nonTerminalTasks.length > 0) {
        throw new OrchestrationStateError(
          "CANCELLATION_NOT_RECONCILED",
          "Run cannot be CANCELLED while tasks remain non-terminal",
          { tasks: nonTerminalTasks.map((task) => ({ id: task.id, status: task.status })) },
        );
      }
      cancellation = {
        ...cancellation,
        pendingExecutorStops: [],
        finalizedAt: iso(options.now),
      };
    }
    const committed = commitEvent(
      artifactDir,
      state,
      "RUN_STATUS_UPDATED",
      {
        runStatus: normalizedStatus,
        statusReason: options.reason ?? null,
        cancellation,
      },
      options,
    );
    return { state: committed.state, event: committed.event, summary: runSummary(committed.state) };
  }, options);
}

export function findRunDirectory(options = {}) {
  if (options.artifactDir) return resolve(options.artifactDir);
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  // Achado 14: uma run pode estar em `.orchestrator/runs/<slug>/` (layout
  // atual) ou `.orchestration/<slug>/` (legado, ainda lido) — varre as duas
  // raizes que existirem no disco antes de decidir RUN_NOT_FOUND.
  const roots = runRootCandidates(projectRoot).filter((candidate) => candidate.exists);
  if (roots.length === 0) {
    throw new OrchestrationStateError(
      "RUN_NOT_FOUND",
      `No .orchestrator/runs or .orchestration directory in ${projectRoot}`,
    );
  }

  const candidates = [];
  for (const { root } of roots) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    if (!existsSync(stateFile(directory)) && !existsSync(eventsFile(directory))) continue;
    const paths = [stateFile(directory), eventsFile(directory)].filter((path) => existsSync(path));
    const modifiedAt = Math.max(...paths.map((path) => statSync(path).mtimeMs));
    let identity = { runId: null, slug: entry.name };
    try {
      if (existsSync(stateFile(directory))) {
        const snapshot = safeJsonParse(readFileSync(stateFile(directory), "utf8"), stateFile(directory));
        identity = {
          runId: snapshot.runId ?? null,
          slug: snapshot.slug ?? entry.name,
        };
      } else if (existsSync(eventsFile(directory))) {
        const firstLine = readFileSync(eventsFile(directory), "utf8").split(/\r?\n/).find(Boolean);
        const firstEvent = firstLine ? JSON.parse(firstLine) : null;
        identity = {
          runId: firstEvent?.runId ?? firstEvent?.payload?.state?.runId ?? null,
          slug: firstEvent?.payload?.state?.slug ?? entry.name,
        };
      }
    } catch {
      // Keep the directory as a candidate. Loading below will surface RUN_CORRUPT
      // instead of silently selecting an older run.
    }
    candidates.push({ directory, identity, modifiedAt });
  }
  }

  const matching = options.runId
    ? candidates.filter((candidate) =>
        candidate.identity.runId === options.runId ||
        candidate.identity.slug === options.runId ||
        basename(candidate.directory) === options.runId,
      )
    : candidates;
  if (matching.length === 0) {
    throw new OrchestrationStateError(
      "RUN_NOT_FOUND",
      options.runId ? `Run not found: ${options.runId}` : "No resumable orchestration run found",
    );
  }
  matching.sort((left, right) => right.modifiedAt - left.modifiedAt);
  const valid = [];
  const corrupt = [];
  for (const candidate of matching) {
    try {
      const state = loadRun(candidate.directory).state;
      valid.push({ ...candidate, state });
      if (options.runId || ACTIVE_RUN_STATUSES.has(state.status)) return candidate.directory;
    } catch (error) {
      const corruptEntry = {
        artifactDir: candidate.directory,
        causeCode: error?.code ?? "INVALID_STATE",
        cause: error?.message ?? String(error),
      };
      // An explicit --runId/slug names one specific run: if that run is
      // corrupt, silently substituting a different one the caller didn't
      // ask for would be worse than failing loudly.
      if (options.runId) {
        throw new OrchestrationStateError(
          "RUN_CORRUPT",
          `Orchestration run at ${candidate.directory} is corrupt; refusing to fall back to an older run`,
          corruptEntry,
        );
      }
      // A general "resume the most recent run" call has no single target —
      // one corrupt archived run must not permanently break resume for the
      // whole project. Skip it and keep looking at older candidates.
      corrupt.push(corruptEntry);
    }
  }
  if (valid.length === 0) {
    throw new OrchestrationStateError(
      "RUN_CORRUPT",
      corrupt.length === 1
        ? `Orchestration run at ${corrupt[0].artifactDir} is corrupt and no other resumable run was found`
        : `All ${corrupt.length} candidate orchestration runs are corrupt`,
      { candidates: corrupt },
    );
  }
  return valid[0].directory;
}

export function verifyRun(artifactDir) {
  const loaded = loadRun(artifactDir, { verifyReplay: true });
  if (loaded.eventTailIncomplete) {
    throw new OrchestrationStateError(
      "TRUNCATED_EVENT_TAIL",
      "events.jsonl ends with an incomplete event; run resume/reconcile to repair it",
    );
  }
  if (loaded.snapshotRecovered) {
    throw new OrchestrationStateError(
      loaded.snapshotDiverged ? "SNAPSHOT_DIVERGED" : "SNAPSHOT_REPAIR_REQUIRED",
      loaded.snapshotDiverged
        ? "state.json differs from deterministic event replay"
        : "state.json is missing, invalid, or behind events.jsonl",
      { snapshotError: loaded.snapshotError },
    );
  }
  const state = loaded.state;
  const events = loaded.events;
  const lastEvent = events.at(-1) ?? null;
  const valid =
    lastEvent != null &&
    lastEvent.revision === state.revision &&
    lastEvent.eventId === state.lastEventId;
  if (!valid) {
    throw new OrchestrationStateError(
      "INTEGRITY_ERROR",
      "state.json does not match the last durable event",
      {
        stateRevision: state.revision,
        eventRevision: lastEvent?.revision ?? null,
        stateLastEventId: state.lastEventId,
        eventId: lastEvent?.eventId ?? null,
      },
    );
  }
  return {
    valid: true,
    artifactDir: resolve(artifactDir),
    snapshotRecovered: loaded.snapshotRecovered,
    eventCount: events.length,
    summary: runSummary(state),
  };
}

export function statusRun(artifactDir) {
  const loaded = loadRun(artifactDir, { verifyReplay: true });
  return {
    artifactDir: resolve(artifactDir),
    summary: runSummary(loaded.state),
    // Run legada nao tem snapshot; `null` e a resposta honesta, e o comando de
    // status segue funcionando sem ele.
    projectConfig: loaded.state.projectConfig ?? null,
    tasks: loaded.state.tasks,
    completionGates: loaded.state.completionGates,
    resume: loaded.state.resume,
    cancellation: loaded.state.cancellation,
    integrity: {
      snapshotRecovered: loaded.snapshotRecovered,
      snapshotDiverged: loaded.snapshotDiverged,
      eventTailIncomplete: loaded.eventTailIncomplete,
      snapshotError: loaded.snapshotError,
    },
  };
}
