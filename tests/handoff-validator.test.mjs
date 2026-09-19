/**
 * Unit tests for scripts/lib/handoff-validator.mjs.
 *
 * `handoff.json` is the single discovery anchor between the three workflow
 * plugins (handoff-contract.md section 4), and until this validator existed
 * no code anywhere checked that a producer actually wrote one conforming to
 * the contract. These tests cover both directions: a well-formed handoff for
 * each stage validates clean (positive), and each specific contract
 * violation is caught with the right error code (negative) — including the
 * exact drift this validator exists to prevent (an artifact role that is not
 * in the vocabulary for its stage).
 *
 * This is the same suite as cc-pensador's test/handoff-validator.test.js,
 * ported to node:test/node:assert (this repo's test runner) since
 * handoff-validator.mjs itself is byte-identical across all three plugins.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  validateHandoff,
  HANDOFF_ROLES_BY_STAGE,
  HANDOFF_STAGES,
  HANDOFF_STATUSES,
  SUPPORTED_HANDOFF_VERSION,
} from "../skills/orchestrator-multi-agent-development/scripts/lib/handoff-validator.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CONTRACT_PATH = join(REPO_ROOT, "skills/orchestrator-multi-agent-development/references/handoff-contract.md");
const CLI_SCRIPT = resolve(REPO_ROOT, "skills/orchestrator-multi-agent-development/scripts/validate-handoff.mjs");

function validPensadorHandoff(overrides = {}) {
  return {
    handoffVersion: 1,
    stage: "pensador",
    slug: "login-social",
    artifactMode: "prd",
    producer: { plugin: "cc-pensador", version: "2.15.0" },
    artifactRoot: ".pensador/login-social-v1",
    status: "DONE",
    createdAt: "2026-06-18T15:40:00.000Z",
    updatedAt: "2026-06-18T15:40:00.000Z",
    summary: "PRD, arquitetura, contrato de API e baseline do projeto para login social.",
    upstream: null,
    artifacts: [
      { role: "prd", path: "prd.md", required: true, description: "PRD consolidado" },
      { role: "architecture", path: "architecture.md", required: true, description: "Arquitetura alvo" },
      { role: "project-baseline", path: "project-baseline.json", required: true, description: "Baseline maquina-legivel" },
    ],
    nextStage: { consumer: "cc-orchestrador-subagents", entrypoint: "/orchestrador", instructions: "Ingerir os artefatos e implementar o plano." },
    ...overrides,
  };
}

function validOrchestradorHandoff(overrides = {}) {
  return {
    handoffVersion: 1,
    stage: "orchestrador",
    slug: "login-social",
    producer: { plugin: "cc-orchestrador-subagents", version: "3.0.0" },
    artifactRoot: ".orchestration/login-social",
    status: "DONE",
    createdAt: "2026-06-19T10:00:00.000Z",
    updatedAt: "2026-06-19T18:00:00.000Z",
    summary: "Implementacao completa, reviews aprovados, E2E verificado.",
    upstream: { stage: "pensador", handoffPath: ".pensador/login-social-v1/handoff.json" },
    artifacts: [
      { role: "implementation-report", path: "report/implementation-report.md", required: true },
      { role: "review-final", path: "review/review-final.md", required: true },
    ],
    nextStage: { consumer: "cc-executor-subagents", entrypoint: "/executor", instructions: "Review plano-vs-entrega e ajustes finos." },
    ...overrides,
  };
}

function validTestadorHandoff(overrides = {}) {
  return {
    handoffVersion: 1,
    stage: "testador",
    slug: "login-social",
    producer: { plugin: "cc-testador-subagents", version: "1.0.0" },
    artifactRoot: ".testador/login-social/artefatos",
    status: "DONE",
    createdAt: "2026-06-20T08:00:00.000Z",
    updatedAt: "2026-06-20T10:00:00.000Z",
    summary: "Validacao aprovada: 0 achados bloqueantes.",
    upstream: { stage: "orchestrador", handoffPath: ".orchestration/login-social/report/handoff.json" },
    artifacts: [
      { role: "test-report", path: "review/test-report.md", required: true },
      { role: "monitoring", path: "run/monitoring.md", required: true },
    ],
    nextStage: { consumer: "cc-executor-subagents", entrypoint: "/executor" },
    ...overrides,
  };
}

function validExecutorHandoff(overrides = {}) {
  return {
    handoffVersion: 1,
    stage: "executor",
    slug: "login-social",
    producer: { plugin: "cc-executor-subagents", version: "2.4.0" },
    artifactRoot: ".executor/login-social/artefatos",
    status: "DONE",
    createdAt: "2026-06-20T09:00:00.000Z",
    updatedAt: "2026-06-20T11:00:00.000Z",
    summary: "Correcoes aplicadas, review plano-vs-entrega aprovado.",
    upstream: { stage: "orchestrador", handoffPath: ".orchestration/login-social/report/handoff.json" },
    artifacts: [
      { role: "plan-vs-output-review", path: "plan-vs-output-review.md", required: true },
      { role: "implementation-report", path: "report/implementation-report.md", required: true },
    ],
    nextStage: null,
    ...overrides,
  };
}

// --- positive path -----------------------------------------------------

test("accepts a well-formed Pensador handoff", () => {
  const result = validateHandoff(validPensadorHandoff());
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("accepts a well-formed Orchestrador handoff (joint mode, with upstream)", () => {
  assert.equal(validateHandoff(validOrchestradorHandoff()).ok, true);
});

test("accepts a well-formed Orchestrador handoff in independent mode (upstream: null)", () => {
  assert.equal(validateHandoff(validOrchestradorHandoff({ upstream: null })).ok, true);
});

test("accepts a well-formed Executor handoff (terminal stage, nextStage: null)", () => {
  assert.equal(validateHandoff(validExecutorHandoff()).ok, true);
});

test("accepts status PARTIAL/BLOCKED when summary actually explains the gap", () => {
  const result = validateHandoff(
    validOrchestradorHandoff({ status: "PARTIAL", summary: "E2E nao verificado: Playwright MCP indisponivel neste ambiente." }),
  );
  assert.equal(result.ok, true);
});

test("accepts every role declared for each stage in HANDOFF_ROLES_BY_STAGE", () => {
  for (const stage of HANDOFF_STAGES) {
    for (const role of HANDOFF_ROLES_BY_STAGE[stage]) {
      const base = stage === "pensador"
        ? validPensadorHandoff()
        : stage === "orchestrador"
          ? validOrchestradorHandoff()
          : stage === "testador"
            ? validTestadorHandoff()
            : validExecutorHandoff();
      const result = validateHandoff({ ...base, artifacts: [{ role, path: "x", required: true }] });
      assert.equal(result.ok, true, `role ${role} should be valid for stage ${stage}: ${JSON.stringify(result.errors)}`);
    }
  }
});

// --- negative path -------------------------------------------------------

test("rejects a non-object payload", () => {
  const result = validateHandoff("not an object");
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "INVALID_ENVELOPE");
});

test("rejects null", () => {
  assert.equal(validateHandoff(null).ok, false);
});

test("rejects a handoffVersion other than the supported one, and stops there", () => {
  const result = validateHandoff(validPensadorHandoff({ handoffVersion: 2 }));
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, "UNSUPPORTED_HANDOFF_VERSION");
});

test("rejects a stage outside the enum", () => {
  const result = validateHandoff(validPensadorHandoff({ stage: "orquestrador" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === "INVALID_STAGE"));
});

test("rejects an empty slug", () => {
  const result = validateHandoff(validPensadorHandoff({ slug: "" }));
  assert.ok(result.errors.some((e) => e.code === "INVALID_SLUG"));
});

test("rejects a missing producer.version", () => {
  const result = validateHandoff(validPensadorHandoff({ producer: { plugin: "cc-pensador" } }));
  assert.ok(result.errors.some((e) => e.code === "INVALID_PRODUCER"));
});

test("rejects a status outside the enum", () => {
  const result = validateHandoff(validPensadorHandoff({ status: "FINISHED" }));
  assert.ok(result.errors.some((e) => e.code === "INVALID_STATUS"));
});

test("rejects a non-ISO createdAt/updatedAt", () => {
  const result = validateHandoff(validPensadorHandoff({ createdAt: "yesterday" }));
  assert.ok(result.errors.some((e) => e.code === "INVALID_CREATED_AT"));
});

test("rejects an empty summary", () => {
  const result = validateHandoff(validPensadorHandoff({ summary: "" }));
  assert.ok(result.errors.some((e) => e.code === "INVALID_SUMMARY"));
});

test("rejects a PARTIAL/BLOCKED status with a near-empty summary", () => {
  const result = validateHandoff(validOrchestradorHandoff({ status: "BLOCKED", summary: "n/a" }));
  assert.ok(result.errors.some((e) => e.code === "SUMMARY_TOO_SHORT_FOR_NON_DONE_STATUS"));
});

// --- WF-010: structured waiver ---

function validWaiver(overrides = {}) {
  return {
    owner: "Produto",
    motivo: "Achado bloqueante do Testador ainda sem revalidacao",
    impacto: "Entrega segue sem confirmacao de navegador real neste escopo",
    validade: "2026-12-31T00:00:00.000Z",
    condicaoDeReabertura: "Rodar o Testador de novo sobre o mesmo escopo corrigido",
    ...overrides,
  };
}

test("accepts a well-formed waiver on a BLOCKED handoff", () => {
  const result = validateHandoff(validOrchestradorHandoff({ status: "BLOCKED", waiver: validWaiver() }));
  assert.equal(result.ok, true);
});

test("accepts a waiver with validade: null (no deadline)", () => {
  const result = validateHandoff(validOrchestradorHandoff({ status: "PARTIAL", waiver: validWaiver({ validade: null }) }));
  assert.equal(result.ok, true);
});

test("a handoff with no waiver field is still valid (not every PARTIAL/BLOCKED is a formal waiver)", () => {
  const result = validateHandoff(validOrchestradorHandoff({ status: "PARTIAL" }));
  assert.equal(result.ok, true);
});

test("rejects a waiver on a DONE handoff", () => {
  const result = validateHandoff(validOrchestradorHandoff({ status: "DONE", waiver: validWaiver() }));
  assert.ok(result.errors.some((e) => e.code === "WAIVER_REQUIRES_NON_DONE_STATUS"));
});

test("rejects a waiver missing a required field", () => {
  for (const field of ["owner", "motivo", "impacto", "condicaoDeReabertura"]) {
    const waiver = validWaiver();
    delete waiver[field];
    const result = validateHandoff(validOrchestradorHandoff({ status: "BLOCKED", waiver }));
    assert.ok(result.errors.some((e) => e.code === "INVALID_WAIVER" && e.path === `waiver.${field}`), `expected INVALID_WAIVER for missing ${field}`);
  }
});

test("rejects a waiver with an unparseable validade", () => {
  const result = validateHandoff(validOrchestradorHandoff({ status: "BLOCKED", waiver: validWaiver({ validade: "not-a-date" }) }));
  assert.ok(result.errors.some((e) => e.code === "INVALID_WAIVER" && e.path === "waiver.validade"));
});

test("rejects a Pensador handoff with a non-null upstream", () => {
  const result = validateHandoff(validPensadorHandoff({ upstream: { stage: "orchestrador", handoffPath: "x" } }));
  assert.ok(result.errors.some((e) => e.code === "PENSADOR_CANNOT_HAVE_UPSTREAM"));
});

test("rejects an upstream missing handoffPath", () => {
  const result = validateHandoff(validOrchestradorHandoff({ upstream: { stage: "pensador" } }));
  assert.ok(result.errors.some((e) => e.code === "INVALID_UPSTREAM"));
});

test("rejects artifacts that is not an array", () => {
  const result = validateHandoff(validPensadorHandoff({ artifacts: {} }));
  assert.ok(result.errors.some((e) => e.code === "INVALID_ARTIFACTS"));
});

test("rejects an artifact entry missing required", () => {
  const result = validateHandoff(validPensadorHandoff({ artifacts: [{ role: "prd", path: "prd.md" }] }));
  assert.ok(result.errors.some((e) => e.code === "INVALID_ARTIFACT_REQUIRED"));
});

test("rejects an artifact entry missing path", () => {
  const result = validateHandoff(validPensadorHandoff({ artifacts: [{ role: "prd", required: true }] }));
  assert.ok(result.errors.some((e) => e.code === "INVALID_ARTIFACT_PATH"));
});

test("rejects an artifact role not in the vocabulary for the declared stage", () => {
  const result = validateHandoff(validPensadorHandoff({ artifacts: [{ role: "review-final", path: "x", required: true }] }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === "UNKNOWN_ARTIFACT_ROLE"));
});

test("rejects a role valid for the Orchestrador but claimed by an Executor handoff", () => {
  const result = validateHandoff(validExecutorHandoff({ artifacts: [{ role: "tasks-classification", path: "x", required: true }] }));
  assert.ok(result.errors.some((e) => e.code === "UNKNOWN_ARTIFACT_ROLE"));
});

test("rejects artifactMode on a non-Pensador stage", () => {
  const result = validateHandoff(validOrchestradorHandoff({ artifactMode: "prd" }));
  assert.ok(result.errors.some((e) => e.code === "ARTIFACT_MODE_ONLY_ON_PENSADOR"));
});

test("rejects an artifactMode outside prd|spec", () => {
  const result = validateHandoff(validPensadorHandoff({ artifactMode: "markdown" }));
  assert.ok(result.errors.some((e) => e.code === "INVALID_ARTIFACT_MODE"));
});

test("rejects a nextStage missing entrypoint", () => {
  const result = validateHandoff(validPensadorHandoff({ nextStage: { consumer: "cc-orchestrador-subagents" } }));
  assert.ok(result.errors.some((e) => e.code === "INVALID_NEXT_STAGE"));
});

test("flags an Executor handoff with a non-null nextStage", () => {
  const result = validateHandoff(validExecutorHandoff({ nextStage: { consumer: "x", entrypoint: "/y" } }));
  assert.ok(result.errors.some((e) => e.code === "EXECUTOR_NEXT_STAGE_SHOULD_BE_NULL"));
});

test("collects multiple independent errors in one pass", () => {
  const result = validateHandoff(validPensadorHandoff({ slug: "", status: "FINISHED", summary: "" }));
  const codes = result.errors.map((e) => e.code);
  assert.ok(codes.includes("INVALID_SLUG"));
  assert.ok(codes.includes("INVALID_STATUS"));
  assert.ok(codes.includes("INVALID_SUMMARY"));
});

// --- doc alignment ---------------------------------------------------------

function extractStageRoles(contractText, stageHeading) {
  const start = contractText.indexOf(stageHeading);
  assert.ok(start > -1, `heading not found: ${stageHeading}`);
  const rest = contractText.slice(start);
  const nextHeading = rest.indexOf("\n### ", 1);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  return new Set([...section.matchAll(/^\|\s*`([a-z0-9-]+)`\s*\|/gm)].map((m) => m[1]));
}

test("HANDOFF_ROLES_BY_STAGE.pensador matches the contract table", () => {
  const contractText = readFileSync(CONTRACT_PATH, "utf8");
  assert.deepEqual(new Set(HANDOFF_ROLES_BY_STAGE.pensador), extractStageRoles(contractText, "### Pensador (`stage: pensador`)"));
});

test("HANDOFF_ROLES_BY_STAGE.orchestrador matches the contract table", () => {
  const contractText = readFileSync(CONTRACT_PATH, "utf8");
  assert.deepEqual(new Set(HANDOFF_ROLES_BY_STAGE.orchestrador), extractStageRoles(contractText, "### Orchestrador (`stage: orchestrador`)"));
});

test("HANDOFF_ROLES_BY_STAGE.testador matches the contract table", () => {
  const contractText = readFileSync(CONTRACT_PATH, "utf8");
  assert.deepEqual(new Set(HANDOFF_ROLES_BY_STAGE.testador), extractStageRoles(contractText, "### Testador (`stage: testador`)"));
});

test("HANDOFF_ROLES_BY_STAGE.executor matches the contract table", () => {
  const contractText = readFileSync(CONTRACT_PATH, "utf8");
  assert.deepEqual(new Set(HANDOFF_ROLES_BY_STAGE.executor), extractStageRoles(contractText, "### Executor (`stage: executor`)"));
});

test("SUPPORTED_HANDOFF_VERSION is 1 (matches HANDOFF_VERSION in handoff-contract.md)", () => {
  assert.equal(SUPPORTED_HANDOFF_VERSION, 1);
  assert.ok(readFileSync(CONTRACT_PATH, "utf8").includes("`HANDOFF_VERSION = 1`"));
});

test("HANDOFF_STAGES and HANDOFF_STATUSES are frozen", () => {
  assert.ok(Object.isFrozen(HANDOFF_STAGES));
  assert.ok(Object.isFrozen(HANDOFF_STATUSES));
});

// --- CLI round-trip ---------------------------------------------------------

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "handoff-cli-test-"));
  roots.push(root);
  return root;
}
test.after(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

test("CLI: exits 0 and reports ok:true for a valid handoff file", () => {
  const dir = fixture();
  const file = join(dir, "handoff.json");
  writeFileSync(file, JSON.stringify(validPensadorHandoff()));
  const result = spawnSync(process.execPath, [CLI_SCRIPT, "--file", file], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.errors, []);
});

test("CLI: exits 1 and reports the violation for an invalid handoff file", () => {
  const dir = fixture();
  const file = join(dir, "handoff.json");
  writeFileSync(file, JSON.stringify(validPensadorHandoff({ artifacts: [{ role: "review-final", path: "x", required: true }] })));
  const result = spawnSync(process.execPath, [CLI_SCRIPT, "--file", file], { encoding: "utf8" });
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.errors.some((e) => e.code === "UNKNOWN_ARTIFACT_ROLE"));
});

test("CLI: exits 1 with a clear error when --file is missing", () => {
  const result = spawnSync(process.execPath, [CLI_SCRIPT], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).errors[0].code, "MISSING_FILE_ARG");
});

test("CLI: exits 1 with a clear error when the file does not exist", () => {
  const result = spawnSync(process.execPath, [CLI_SCRIPT, "--file", "does/not/exist.json"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).errors[0].code, "FILE_NOT_READABLE");
});

test("CLI: exits 1 with a clear error when the file is not valid JSON", () => {
  const dir = fixture();
  const file = join(dir, "handoff.json");
  writeFileSync(file, "{ not valid json");
  const result = spawnSync(process.execPath, [CLI_SCRIPT, "--file", file], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).errors[0].code, "INVALID_JSON");
});

// Resolved Open Design package fields (handoff-contract.md section 6): every
// plugin's validator must enforce the same semantics.
const resolvedDesignEntry = (overrides = {}) => ({
  role: "design-system-files",
  path: "design-systems/gestuor/resolved/",
  required: true,
  variant: "resolved",
  authoritative: true,
  sourcePath: "design-systems/gestuor/source/",
  materializeInto: "packages/ui/design-systems/gestuor/",
  contractSha256: "a".repeat(64),
  themes: ["light", "dark"],
  designBriefPath: "design-brief.json",
  validation: { status: "PASS", audit: "design-audit.json" },
  ...overrides,
});

test("accepts a resolved design-system-files entry with contractSha256, themes and designBriefPath", () => {
  const result = validateHandoff(validPensadorHandoff({ artifacts: [resolvedDesignEntry()] }));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("accepts contractSha256 null and designBriefPath null on a resolved entry", () => {
  const result = validateHandoff(validPensadorHandoff({ artifacts: [resolvedDesignEntry({ contractSha256: null, designBriefPath: null })] }));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("rejects a malformed contractSha256 on a resolved entry", () => {
  const result = validateHandoff(validPensadorHandoff({ artifacts: [resolvedDesignEntry({ contractSha256: "xyz" })] }));
  assert.ok(result.errors.some((e) => e.code === "INVALID_CONTRACT_SHA256"));
});

test("rejects resolved themes missing dark", () => {
  const result = validateHandoff(validPensadorHandoff({ artifacts: [resolvedDesignEntry({ themes: ["light"] })] }));
  assert.ok(result.errors.some((e) => e.code === "INVALID_DESIGN_THEMES"));
});

test("rejects an empty designBriefPath on a resolved entry", () => {
  const result = validateHandoff(validPensadorHandoff({ artifacts: [resolvedDesignEntry({ designBriefPath: "" })] }));
  assert.ok(result.errors.some((e) => e.code === "INVALID_DESIGN_BRIEF_PATH"));
});

test("the removed ui-prototype role is not a valid Pensador role", () => {
  assert.equal(HANDOFF_ROLES_BY_STAGE.pensador.includes("ui-prototype"), false);
});
