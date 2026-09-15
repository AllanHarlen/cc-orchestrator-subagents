import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  auditRunCompletion,
  OrchestrationStateError,
  initRun,
  loadRun,
  updateCompletionGate,
  updatePhase,
} from "../skills/orchestrator-multi-agent-development/scripts/lib/orchestration-state.mjs";

const inspectContract = resolve("skills/orchestrator-multi-agent-development/scripts/inspect-contract.mjs");
const roots = [];

function fixture(slug = "phase-four-gates") {
  const root = mkdtempSync(join(process.cwd(), ".tmp-contract-gates-"));
  roots.push(root);
  const artifactDir = join(root, ".orchestrator", "runs", slug);
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, "tasks-classification.md"), [
    "# Tasks", "", "## BE-01 - API", "- category: BACKEND_ONLY", "",
    "## FE-01 - UI", "- category: FRONTEND_ONLY",
  ].join("\n"));
  writeFileSync(join(artifactDir, "waves.md"), "# Waves\n\n## Wave 1\n- BE-01\n- FE-01\n");
  initRun({ projectRoot: root, artifactDir, slug, runId: `${slug}-001` });
  return { root, artifactDir };
}

function inspect(root, artifactDir) {
  const result = spawnSync(process.execPath, [inspectContract, "--root", root, "--dir", artifactDir], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function validContract() {
  return [
    "# Contract Metadata",
    "## Endpoint", "`/api/orders`",
    "## Método HTTP", "`POST`",
    "## Wire Format", "Request: `camelCase`", "Response: `camelCase`",
    "## Request", "```json", "{}", "```",
    "## Response", "status: `confirmado`", "```json", "{}", "```",
    "## Estados de UI", "loading, success e error",
    "## Permissões", "Admin autenticado",
    "## Validações Back-end", "Validar payload",
    "## Validações Front-end", "Validar formulario",
    "## Checklist de Fechamento do Contrato", "- [x] Contrato revisado",
  ].join("\n");
}

test.afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

test("phase 4 derives both new gates from live contracts and a full-stack plan", () => {
  const { root, artifactDir } = fixture();
  assert.equal(loadRun(artifactDir).state.completionGates.contractsInspected.required, false);
  assert.equal(loadRun(artifactDir).state.completionGates.infraSmokeTest.required, true);

  mkdirSync(join(artifactDir, "contracts"), { recursive: true });
  writeFileSync(join(artifactDir, "contracts", "CT-ORDERS.md"), "# Contract Metadata\n## Endpoint\n`/api/orders`\n");
  for (const phase of [1, 2, 3]) updatePhase(artifactDir, phase, "DONE", { projectRoot: root });

  assert.throws(
    () => updatePhase(artifactDir, 4, "DONE", { projectRoot: root }),
    (error) => error instanceof OrchestrationStateError && error.code === "PHASE_GATE_NOT_DONE" && error.details.blockedBy.includes("contractsInspected") && error.details.blockedBy.includes("infraSmokeTest"),
  );
});

test("contractsInspected rejects a persisted invalid contract and accepts a later valid inspection", () => {
  const { root, artifactDir } = fixture("contract-inspection");
  mkdirSync(join(artifactDir, "contracts"), { recursive: true });
  const contract = join(artifactDir, "contracts", "CT-ORDERS.md");
  writeFileSync(contract, "# Contract Metadata\n## Endpoint\n`/api/orders`\n");
  inspect(root, artifactDir);

  assert.throws(
    () => updateCompletionGate(artifactDir, "contractsInspected", "DONE", { projectRoot: root }),
    (error) => error instanceof OrchestrationStateError && error.code === "CONTRACT_INSPECTION_BLOCKED" && error.details.missingContracts.includes("contracts/ct-orders.md"),
  );

  writeFileSync(contract, validContract());
  inspect(root, artifactDir);
  const closed = updateCompletionGate(artifactDir, "contractsInspected", "DONE", { projectRoot: root });
  assert.equal(closed.gate.status, "DONE");
  assert.ok(closed.gate.evidence.some((entry) => entry.startsWith("evidence:intel-inspect-contract-")));

  for (const phase of [1, 2, 3]) updatePhase(artifactDir, phase, "DONE", { projectRoot: root });
  writeFileSync(contract, `${validContract()}\n<!-- changed after inspection -->\n`);
  assert.throws(
    () => updatePhase(artifactDir, 4, "DONE", { projectRoot: root }),
    (error) => error instanceof OrchestrationStateError && error.code === "PHASE_GATE_EVIDENCE_INVALID" && error.details.findings.some((finding) => finding.id === "contractsInspected"),
  );
  assert.ok(auditRunCompletion(artifactDir).invalidGateEvidence.some((finding) => finding.id === "contractsInspected"));
});

test("infraSmokeTest refuses missing, failed and dry-run reports, then accepts a real PASS", () => {
  const { root, artifactDir } = fixture("infra-smoke");
  assert.throws(
    () => updateCompletionGate(artifactDir, "infraSmokeTest", "DONE", { projectRoot: root }),
    (error) => error instanceof OrchestrationStateError && error.code === "INFRA_SMOKE_TEST_MISSING",
  );

  const evidenceDir = join(artifactDir, "evidence");
  for (const report of [
    { status: "PASS", applicable: true },
    { kind: "infra-smoke-test", schemaVersion: 1, status: "FAILED", applicable: true, phase: "STACK_UP" },
    { kind: "infra-smoke-test", schemaVersion: 1, status: "PASS", applicable: true, dryRun: true },
  ]) {
    writeFileSync(join(evidenceDir, "infra-smoke-test.json"), JSON.stringify(report));
    assert.throws(
      () => updateCompletionGate(artifactDir, "infraSmokeTest", "DONE", { projectRoot: root }),
      (error) => error instanceof OrchestrationStateError && error.code === "INFRA_SMOKE_TEST_BLOCKED",
    );
  }

  writeFileSync(join(evidenceDir, "infra-smoke-test.json"), JSON.stringify({ kind: "infra-smoke-test", schemaVersion: 1, status: "PASS", applicable: true, durationMs: 1200 }));
  const closed = updateCompletionGate(artifactDir, "infraSmokeTest", "DONE", { projectRoot: root });
  assert.equal(closed.gate.status, "DONE");
  assert.ok(closed.gate.evidence.includes("file:evidence/infra-smoke-test.json"));
});
