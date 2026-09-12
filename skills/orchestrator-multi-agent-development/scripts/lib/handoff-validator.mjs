/**
 * Handoff envelope validator — Pensador -> Orchestrador -> Executor.
 *
 * `handoff.json` is the "unica ancora de descoberta" (handoff-contract.md
 * section 4): the only signal that distinguishes joint mode from independent
 * mode (section 2). Despite that, no code in any of the three plugin
 * repositories wrote, read, or validated this file — `grep -rn
 * handoffVersion --include=*.mjs --include=*.json` across all three returned
 * zero hits. A producer could silently drift from the contract (as
 * `feature-isolation.md`'s role list already had — missing `api-contract`
 * and `openspec-change`) and no test would catch it until a consumer failed
 * to find an artifact it expected.
 *
 * This module is the CANONICAL, BYTE-IDENTICAL implementation replicated
 * across all three plugins (mirrors `references/handoff-contract.md`'s own
 * byte-identical requirement, section 8) — a consumer validates a handoff
 * from ANY stage (e.g. the Executor validates both the Orchestrador's own
 * handoff and, via `upstream`, the Pensador's), so the full per-stage role
 * vocabulary from handoff-contract.md section 5 has to live in one place
 * regardless of which repo is running the check.
 *
 * Scope: `handoffVersion: 1` — the envelope shape actually in production
 * today (section 4's "Envelope comum"). It intentionally does NOT validate
 * business-logic invariants that belong to the producing stage's own state
 * machine (e.g. whether `status: DONE` is actually earned) — only the
 * envelope's structural and cross-referential correctness: required fields
 * present and correctly typed, `stage`/`status` in their enums, every
 * `artifacts[].role` valid for the declared `stage`, and internal
 * consistency between `stage` and `nextStage`/`upstream`.
 */

/** `HANDOFF_VERSION` this validator understands. A different value degrades — see validateHandoff(). */
export const SUPPORTED_HANDOFF_VERSION = 1;

export const HANDOFF_STAGES = Object.freeze(["pensador", "orchestrador", "testador", "executor"]);

export const HANDOFF_STATUSES = Object.freeze(["DONE", "PARTIAL", "BLOCKED"]);

/**
 * Role vocabulary per stage — verbatim from handoff-contract.md section 5.
 * Keep in lockstep with that file; `test/handoff-validator.test.mjs` pins
 * this list against the table extracted from the doc.
 */
export const HANDOFF_ROLES_BY_STAGE = Object.freeze({
  pensador: Object.freeze([
    "prd",
    "userhistory",
    "architecture",
    "api-contract",
    "communication-contract",
    "design-system",
    "design-system-files",
    "ui-prototype",
    "brand-assets",
    "openspec-change",
    "codebase-memory",
    "project-baseline",
    "requirements-index",
    "shared-agents",
  ]),
  orchestrador: Object.freeze([
    "implementation-report",
    "tasks-classification",
    "waves",
    "api-contracts",
    "review-final",
    "review-frontend",
    "monitoring",
    "workflow-log",
    "subagents-context",
    "openspec-change",
  ]),
  executor: Object.freeze([
    "initial-plan-baseline",
    "execution-brief",
    "plan-vs-output-review",
    "implementation-report",
    "workflow-log",
    "subagents-context",
    "monitoring",
    "screenshots",
  ]),
  testador: Object.freeze([
    "test-plan",
    "coverage-matrix",
    "flow-map",
    "test-report",
    "a11y-report",
    "uiux-report",
    "coverage-report",
    "design-conformance",
    "specs",
    "playwright-report",
    "screenshots",
    "monitoring",
    "workflow-log",
    "subagents-context",
    "implementation-report",
  ]),
});

export class HandoffValidationError extends Error {
  constructor(code, message, path = null) {
    super(message);
    this.name = "HandoffValidationError";
    this.code = code;
    this.path = path;
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoTimestamp(value) {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

/**
 * Validates a parsed `handoff.json` envelope (any stage). Collects every
 * violation instead of stopping at the first one, so a single CLI run
 * reports the complete list of what a producer needs to fix.
 *
 * @param {unknown} handoff - the parsed JSON content of handoff.json
 * @returns {{ ok: boolean, errors: Array<{ code: string, message: string, path: string|null }> }}
 */
export function validateHandoff(handoff) {
  /** @type {Array<{ code: string, message: string, path: string|null }>} */
  const errors = [];
  const push = (code, message, path = null) => errors.push({ code, message, path });

  if (!isPlainObject(handoff)) {
    push("INVALID_ENVELOPE", "handoff.json must parse to a JSON object", null);
    return { ok: false, errors };
  }

  if (handoff.handoffVersion !== SUPPORTED_HANDOFF_VERSION) {
    push(
      "UNSUPPORTED_HANDOFF_VERSION",
      `handoffVersion ${JSON.stringify(handoff.handoffVersion)} is not supported (expected ${SUPPORTED_HANDOFF_VERSION}) — consumer should degrade to discovery-by-convention (handoff-contract.md section 8)`,
      "handoffVersion",
    );
    // A version mismatch invalidates every field below it in ways this
    // validator cannot reason about (the envelope shape may have changed) —
    // stop here rather than pile on confusing secondary errors.
    return { ok: false, errors };
  }

  if (!HANDOFF_STAGES.includes(handoff.stage)) {
    push(
      "INVALID_STAGE",
      `stage must be one of ${HANDOFF_STAGES.join(", ")}, got ${JSON.stringify(handoff.stage)}`,
      "stage",
    );
  }

  if (!isNonEmptyString(handoff.slug)) {
    push("INVALID_SLUG", "slug must be a non-empty string", "slug");
  }

  if (!isPlainObject(handoff.producer) || !isNonEmptyString(handoff.producer.plugin) || !isNonEmptyString(handoff.producer.version)) {
    push("INVALID_PRODUCER", "producer must be { plugin: string, version: string }", "producer");
  }

  if (!isNonEmptyString(handoff.artifactRoot)) {
    push("INVALID_ARTIFACT_ROOT", "artifactRoot must be a non-empty string", "artifactRoot");
  }

  if (!HANDOFF_STATUSES.includes(handoff.status)) {
    push(
      "INVALID_STATUS",
      `status must be one of ${HANDOFF_STATUSES.join(", ")}, got ${JSON.stringify(handoff.status)}`,
      "status",
    );
  }

  if (!isIsoTimestamp(handoff.createdAt)) {
    push("INVALID_CREATED_AT", "createdAt must be a valid ISO timestamp string", "createdAt");
  }

  if (!isIsoTimestamp(handoff.updatedAt)) {
    push("INVALID_UPDATED_AT", "updatedAt must be a valid ISO timestamp string", "updatedAt");
  }

  if (!isNonEmptyString(handoff.summary)) {
    push("INVALID_SUMMARY", "summary must be a non-empty string", "summary");
  }
  // A BLOCKED/PARTIAL status without an explanatory summary defeats the
  // point of the field (handoff-contract.md section 4: "status: BLOCKED ou
  // PARTIAL deve trazer summary explicando o bloqueio").
  if (["PARTIAL", "BLOCKED"].includes(handoff.status) && isNonEmptyString(handoff.summary) && handoff.summary.trim().length < 10) {
    push(
      "SUMMARY_TOO_SHORT_FOR_NON_DONE_STATUS",
      `status ${handoff.status} requires a summary that actually explains the gap/blocker, got a near-empty string`,
      "summary",
    );
  }

  // Optional structured waiver (WF-010): an accepted-risk record for a
  // PARTIAL/BLOCKED status, distinct from `summary` (a human sentence) —
  // this is the field automation/audits can key on: who accepted the risk,
  // why, what it costs, until when, and what reopens it. Only validated
  // when present; a PARTIAL/BLOCKED handoff without a waiver is still valid
  // (not every gap is a formally accepted risk — some are just open work).
  if (handoff.waiver !== undefined && handoff.waiver !== null) {
    if (!["PARTIAL", "BLOCKED"].includes(handoff.status)) {
      push("WAIVER_REQUIRES_NON_DONE_STATUS", "waiver is only meaningful when status is PARTIAL or BLOCKED", "waiver");
    }
    if (!isPlainObject(handoff.waiver)) {
      push("INVALID_WAIVER", "waiver must be an object", "waiver");
    } else {
      if (!isNonEmptyString(handoff.waiver.owner)) {
        push("INVALID_WAIVER", "waiver.owner must be a non-empty string (who accepted the risk)", "waiver.owner");
      }
      if (!isNonEmptyString(handoff.waiver.motivo)) {
        push("INVALID_WAIVER", "waiver.motivo must be a non-empty string (why the waiver was necessary)", "waiver.motivo");
      }
      if (!isNonEmptyString(handoff.waiver.impacto)) {
        push("INVALID_WAIVER", "waiver.impacto must be a non-empty string (what stays uncovered because of it)", "waiver.impacto");
      }
      if (handoff.waiver.validade !== null && !isNonEmptyString(handoff.waiver.validade)) {
        push("INVALID_WAIVER", "waiver.validade must be an ISO timestamp string or null (no deadline)", "waiver.validade");
      } else if (isNonEmptyString(handoff.waiver.validade) && Number.isNaN(Date.parse(handoff.waiver.validade))) {
        push("INVALID_WAIVER", "waiver.validade must be a valid ISO timestamp string when present", "waiver.validade");
      }
      if (!isNonEmptyString(handoff.waiver.condicaoDeReabertura)) {
        push(
          "INVALID_WAIVER",
          "waiver.condicaoDeReabertura must be a non-empty string (what needs to happen to reopen/revalidate)",
          "waiver.condicaoDeReabertura",
        );
      }
    }
  }

  if (handoff.upstream !== null) {
    if (!isPlainObject(handoff.upstream) || !HANDOFF_STAGES.includes(handoff.upstream.stage) || !isNonEmptyString(handoff.upstream.handoffPath)) {
      push(
        "INVALID_UPSTREAM",
        "upstream must be null or { stage: one of pensador|orchestrador|testador|executor, handoffPath: string }",
        "upstream",
      );
    } else if (handoff.stage === "pensador") {
      push("PENSADOR_CANNOT_HAVE_UPSTREAM", "stage pensador is the first stage in the chain — upstream must be null", "upstream");
    }
  }

  if (!Array.isArray(handoff.artifacts)) {
    push("INVALID_ARTIFACTS", "artifacts must be an array", "artifacts");
  } else {
    const validRoles = HANDOFF_ROLES_BY_STAGE[handoff.stage] ?? null;
    handoff.artifacts.forEach((artifact, index) => {
      const path = `artifacts[${index}]`;
      if (!isPlainObject(artifact)) {
        push("INVALID_ARTIFACT_ENTRY", `${path} must be an object`, path);
        return;
      }
      if (!isNonEmptyString(artifact.role)) {
        push("INVALID_ARTIFACT_ROLE", `${path}.role must be a non-empty string`, `${path}.role`);
      } else if (validRoles && !validRoles.includes(artifact.role)) {
        push(
          "UNKNOWN_ARTIFACT_ROLE",
          `${path}.role ${JSON.stringify(artifact.role)} is not a valid role for stage ${JSON.stringify(handoff.stage)} (accepted: ${validRoles.join(", ")})`,
          `${path}.role`,
        );
      }
      if (!isNonEmptyString(artifact.path)) {
        push("INVALID_ARTIFACT_PATH", `${path}.path must be a non-empty string`, `${path}.path`);
      }
      if (typeof artifact.required !== "boolean") {
        push("INVALID_ARTIFACT_REQUIRED", `${path}.required must be a boolean`, `${path}.required`);
      }
    });
  }

  if (handoff.artifactMode != null) {
    if (!["prd", "spec"].includes(handoff.artifactMode)) {
      push("INVALID_ARTIFACT_MODE", `artifactMode must be "prd" or "spec" when present, got ${JSON.stringify(handoff.artifactMode)}`, "artifactMode");
    }
    if (handoff.stage !== "pensador") {
      push("ARTIFACT_MODE_ONLY_ON_PENSADOR", "artifactMode is only emitted by stage pensador (handoff-contract.md section 4)", "artifactMode");
    }
  }

  if (handoff.nextStage !== null) {
    if (!isPlainObject(handoff.nextStage) || !isNonEmptyString(handoff.nextStage.consumer) || !isNonEmptyString(handoff.nextStage.entrypoint)) {
      push("INVALID_NEXT_STAGE", "nextStage must be null or { consumer: string, entrypoint: string, instructions?: string }", "nextStage");
    }
    if (handoff.stage === "executor") {
      push("EXECUTOR_NEXT_STAGE_SHOULD_BE_NULL", "stage executor is the last stage in the chain — nextStage should normally be null", "nextStage");
    }
  }

  return { ok: errors.length === 0, errors };
}
