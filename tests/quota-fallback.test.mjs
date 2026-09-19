import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  initRun,
  loadRun,
  OrchestrationStateError,
} from "../skills/orchestrator-multi-agent-development/scripts/lib/orchestration-state.mjs";
import {
  QUOTA_FALLBACK_CHAIN_ORDER,
  listQuotaHandoffs,
  markQuotaRecoveryChecked,
  recordQuotaHandoff,
  resolveFallbackChain,
} from "../skills/orchestrator-multi-agent-development/scripts/lib/quota-fallback.mjs";

/**
 * Testes do modulo de fallback de cota opt-in (`quotaFallbackChain`), no mesmo
 * padrao de fixture em diretorio temporario ja usado em
 * `tests/worktree-manager.test.mjs`: `resolveFallbackChain` e pura, e
 * `recordQuotaHandoff`/`listQuotaHandoffs`/`markQuotaRecoveryChecked` sao
 * exercitadas sobre uma Run real (state.json + events.jsonl), nunca com mocks.
 */

const roots = [];

function fixture() {
  const root = mkdtempSync(join(process.cwd(), ".tmp-quota-fallback-test-"));
  roots.push(root);
  const artifactDir = join(root, ".orchestration", "quota-run");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, "tasks-classification.md"), [
    "# Tasks",
    "",
    "## BE-01 - Backend A",
    "- category: BACKEND_ONLY",
    "- assignedAgent: codex",
  ].join("\n"), "utf8");
  writeFileSync(join(artifactDir, "waves.md"), "# Waves\n\n## Wave 1\n- BE-01\n", "utf8");
  initRun({ projectRoot: root, artifactDir, slug: "quota-run", runId: "quota-run-001" });
  return { root, artifactDir };
}

test.afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* resolveFallbackChain (pura)                                                 */
/* -------------------------------------------------------------------------- */

test("resolveFallbackChain excludes the original executor and keeps the fixed order claude-code, codex, agy", () => {
  assert.deepEqual(resolveFallbackChain("codex"), ["claude-code", "agy"]);
  assert.deepEqual(resolveFallbackChain("agy"), ["claude-code", "codex"]);
  assert.deepEqual(resolveFallbackChain("claude-code"), ["codex", "agy"]);
});

test("resolveFallbackChain also excludes links already flagged as exhausted in this run", () => {
  assert.deepEqual(resolveFallbackChain("codex", { exhausted: ["agy"] }), ["claude-code"]);
  assert.deepEqual(resolveFallbackChain("codex", { exhausted: ["claude-code", "agy"] }), []);
});

test("resolveFallbackChain normalizes case and whitespace", () => {
  assert.deepEqual(resolveFallbackChain(" Codex "), ["claude-code", "agy"]);
  assert.deepEqual(resolveFallbackChain("codex", { exhausted: [" AGY "] }), ["claude-code"]);
});

test("QUOTA_FALLBACK_CHAIN_ORDER is exactly the fixed chain cited in SKILL.md", () => {
  assert.deepEqual(QUOTA_FALLBACK_CHAIN_ORDER, ["claude-code", "codex", "agy"]);
});

/* -------------------------------------------------------------------------- */
/* recordQuotaHandoff / listQuotaHandoffs                                      */
/* -------------------------------------------------------------------------- */

test("recordQuotaHandoff appends an entry to state.json.quotaHandoffs[] with quotaRecoveryCheck: PENDING by default", () => {
  const { artifactDir } = fixture();

  assert.deepEqual(listQuotaHandoffs(artifactDir), []);

  const result = recordQuotaHandoff(artifactDir, {
    taskId: "BE-01",
    wave: 1,
    fromExecutor: "codex",
    toExecutor: "claude-code",
    reasonCode: "QUOTA_EXHAUSTED",
    chainPosition: 1,
  });

  assert.equal(result.quotaHandoff.taskId, "BE-01");
  assert.equal(result.quotaHandoff.fromExecutor, "codex");
  assert.equal(result.quotaHandoff.toExecutor, "claude-code");
  assert.equal(result.quotaHandoff.reasonCode, "QUOTA_EXHAUSTED");
  assert.equal(result.quotaHandoff.chainPosition, 1);
  assert.equal(result.quotaHandoff.quotaRecoveryCheck, "PENDING");
  assert.ok(result.quotaHandoff.timestamp);

  const listed = listQuotaHandoffs(artifactDir);
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0], result.quotaHandoff);

  const { state } = loadRun(artifactDir);
  assert.deepEqual(state.quotaHandoffs, listed);
});

test("recordQuotaHandoff persists multiple handoffs across events.jsonl replay", () => {
  const { artifactDir } = fixture();

  recordQuotaHandoff(artifactDir, {
    taskId: "BE-01",
    wave: 1,
    fromExecutor: "codex",
    toExecutor: "claude-code",
    reasonCode: "QUOTA_EXHAUSTED",
    chainPosition: 1,
  });
  recordQuotaHandoff(artifactDir, {
    taskId: "BE-01",
    wave: 1,
    fromExecutor: "claude-code",
    toExecutor: "agy",
    reasonCode: "QUOTA_EXHAUSTED",
    chainPosition: 2,
  });

  const listed = listQuotaHandoffs(artifactDir, { verifyReplay: true });
  assert.equal(listed.length, 2);
  assert.deepEqual(listed.map((entry) => entry.toExecutor), ["claude-code", "agy"]);
  assert.deepEqual(listed.map((entry) => entry.chainPosition), [1, 2]);
});

test("recordQuotaHandoff rejects an entry with fromExecutor === toExecutor or an unknown executor", () => {
  const { artifactDir } = fixture();

  assert.throws(
    () => recordQuotaHandoff(artifactDir, {
      taskId: "BE-01",
      fromExecutor: "codex",
      toExecutor: "codex",
      reasonCode: "QUOTA_EXHAUSTED",
      chainPosition: 1,
    }),
    OrchestrationStateError,
  );

  assert.throws(
    () => recordQuotaHandoff(artifactDir, {
      taskId: "BE-01",
      fromExecutor: "codex",
      toExecutor: "gpt-5",
      reasonCode: "QUOTA_EXHAUSTED",
      chainPosition: 1,
    }),
    OrchestrationStateError,
  );

  assert.deepEqual(listQuotaHandoffs(artifactDir), []);
});

/* -------------------------------------------------------------------------- */
/* markQuotaRecoveryChecked                                                    */
/* -------------------------------------------------------------------------- */

test("markQuotaRecoveryChecked updates quotaRecoveryCheck without reopening or touching the task itself", () => {
  const { artifactDir } = fixture();
  recordQuotaHandoff(artifactDir, {
    taskId: "BE-01",
    wave: 1,
    fromExecutor: "codex",
    toExecutor: "claude-code",
    reasonCode: "QUOTA_EXHAUSTED",
    chainPosition: 1,
  });

  const before = loadRun(artifactDir).state.tasks["BE-01"];
  const updated = markQuotaRecoveryChecked(artifactDir, "BE-01", "RESTORED");
  const after = loadRun(artifactDir).state.tasks["BE-01"];

  assert.equal(updated.quotaHandoffs[0].quotaRecoveryCheck, "RESTORED");
  assert.deepEqual(after, before, "marking the recovery check must never touch the task record");
});

test("markQuotaRecoveryChecked throws when no handoff exists for the task", () => {
  const { artifactDir } = fixture();
  assert.throws(
    () => markQuotaRecoveryChecked(artifactDir, "BE-01", "RESTORED"),
    OrchestrationStateError,
  );
});

test("markQuotaRecoveryChecked rejects an unknown status", () => {
  const { artifactDir } = fixture();
  recordQuotaHandoff(artifactDir, {
    taskId: "BE-01",
    fromExecutor: "codex",
    toExecutor: "claude-code",
    reasonCode: "QUOTA_EXHAUSTED",
    chainPosition: 1,
  });
  assert.throws(
    () => markQuotaRecoveryChecked(artifactDir, "BE-01", "DONE"),
    OrchestrationStateError,
  );
});
