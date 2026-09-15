/**
 * Unit + CLI tests for the RF/CA requirements coverage gate
 * (lib/requirements-coverage.mjs, validate-requirements-coverage.mjs).
 *
 * Audit finding this closes: `completionAudit()` in orchestration-state.mjs
 * has no field connecting a task to the `RF`/`CA` it implements — a
 * requirement dropped while extracting tasks from the PRD (Fase 1.2) is
 * invisible to every deterministic check downstream. These tests cover the
 * positive path (every requirement covered -> complete: true, gate exits 0)
 * and the negative path (a dropped requirement is caught, with the exact
 * id reported; degradation when requirements.json is absent/inapplicable
 * never produces a false failure).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  computeRequirementsCoverage,
  extractCoveredRequirementIds,
} from "../skills/orchestrator-multi-agent-development/scripts/lib/requirements-coverage.mjs";

const SCRIPT = fileURLToPath(
  new URL("../skills/orchestrator-multi-agent-development/scripts/validate-requirements-coverage.mjs", import.meta.url),
);

const SAMPLE_REQUIREMENTS_INDEX = {
  requirements: [
    { id: "RF-01", text: "O sistema DEVE permitir criar reserva.", priority: "Must" },
    { id: "RF-02", text: "O sistema DEVE impedir reserva sem centro de custo.", priority: "Must" },
    { id: "RF-03", text: "O sistema DEVE notificar por e-mail.", priority: "Should" },
  ],
  acceptanceCriteria: [
    { id: "CA-01", requirementId: "RF-01", criterion: "..." },
    { id: "CA-02", requirementId: "RF-02", criterion: "..." },
    { id: "CA-03", requirementId: "RF-03", criterion: "..." },
  ],
  warnings: [],
};

const FULL_COVERAGE_TASKS_MD = `
## Task BE-01
- categoria: BACKEND_ONLY
- requirementIds: RF-01, RF-02

## Task FE-01
- categoria: FRONTEND_ONLY
- requirementIds: RF-03
`;

const PARTIAL_COVERAGE_TASKS_MD = `
## Task BE-01
- categoria: BACKEND_ONLY
- requirementIds: RF-01
`;

// --- extractCoveredRequirementIds -----------------------------------------

test("extractCoveredRequirementIds: collects RF ids from every requirementIds field, across multiple tasks", () => {
  const covered = extractCoveredRequirementIds(FULL_COVERAGE_TASKS_MD);
  assert.deepEqual([...covered].sort(), ["RF-01", "RF-02", "RF-03"]);
});

test("extractCoveredRequirementIds: accepts bracketed list syntax", () => {
  const covered = extractCoveredRequirementIds("requirementIds: [RF-01, RF-02]");
  assert.deepEqual([...covered].sort(), ["RF-01", "RF-02"]);
});

test("extractCoveredRequirementIds: accepts domain-qualified RF ids without losing legacy ids", () => {
  const covered = extractCoveredRequirementIds("requirementIds: RF-01, RF-PLAT-01, rf-auth-06");
  assert.deepEqual([...covered], ["RF-01", "RF-PLAT-01", "RF-AUTH-06"]);
});

test("extractCoveredRequirementIds: accepts an alphabetic suffix on a domain RF id", () => {
  const covered = extractCoveredRequirementIds("requirementIds: RF-OS-02, rf-os-02a");
  assert.deepEqual([...covered], ["RF-OS-02", "RF-OS-02A"]);
});

test("extractCoveredRequirementIds: accepts requirementIds: with = separator", () => {
  const covered = extractCoveredRequirementIds("requirementIds = RF-05");
  assert.deepEqual([...covered], ["RF-05"]);
});

test("extractCoveredRequirementIds: returns an empty set for text with no requirementIds field", () => {
  assert.equal(extractCoveredRequirementIds("no such field here, just prose about RF-01").size, 0);
});

test("extractCoveredRequirementIds: never throws on non-string input", () => {
  assert.doesNotThrow(() => extractCoveredRequirementIds(undefined));
  assert.equal(extractCoveredRequirementIds(null).size, 0);
});

// --- computeRequirementsCoverage — positive path --------------------------

test("computeRequirementsCoverage: complete when every RF has at least one covering task", () => {
  const coverage = computeRequirementsCoverage(SAMPLE_REQUIREMENTS_INDEX, FULL_COVERAGE_TASKS_MD);
  assert.equal(coverage.applicable, true);
  assert.equal(coverage.complete, true);
  assert.equal(coverage.totalRequirements, 3);
  assert.deepEqual(coverage.uncoveredRequirementIds, []);
  assert.deepEqual([...coverage.coveredRequirementIds].sort(), ["RF-01", "RF-02", "RF-03"]);
});

test("computeRequirementsCoverage: compares domain-qualified ids case-insensitively", () => {
  const coverage = computeRequirementsCoverage(
    { requirements: [{ id: "RF-PLAT-01" }, { id: "RF-AUTH-06" }] },
    "requirementIds: rf-plat-01, RF-AUTH-06",
  );
  assert.equal(coverage.complete, true);
  assert.deepEqual(coverage.coveredRequirementIds, ["RF-PLAT-01", "RF-AUTH-06"]);
});

test("computeRequirementsCoverage: degrades (applicable: false, complete: true) when requirementsIndex is null — Spec mode / old handoff", () => {
  const coverage = computeRequirementsCoverage(null, FULL_COVERAGE_TASKS_MD);
  assert.equal(coverage.applicable, false);
  assert.equal(coverage.complete, true);
  assert.equal(coverage.totalRequirements, 0);
});

test("computeRequirementsCoverage: degrades when requirementsIndex.requirements is missing/malformed", () => {
  assert.equal(computeRequirementsCoverage({}, FULL_COVERAGE_TASKS_MD).applicable, false);
  assert.equal(computeRequirementsCoverage({ requirements: "not an array" }, FULL_COVERAGE_TASKS_MD).applicable, false);
});

// --- computeRequirementsCoverage — negative path (the bug this closes) ---

test("computeRequirementsCoverage: reports the exact dropped requirement id when a task extraction misses one", () => {
  const coverage = computeRequirementsCoverage(SAMPLE_REQUIREMENTS_INDEX, PARTIAL_COVERAGE_TASKS_MD);
  assert.equal(coverage.applicable, true);
  assert.equal(coverage.complete, false);
  assert.deepEqual(coverage.uncoveredRequirementIds, ["RF-02", "RF-03"]);
  assert.deepEqual(coverage.coveredRequirementIds, ["RF-01"]);
});

test("computeRequirementsCoverage: no tasks at all -> every requirement uncovered", () => {
  const coverage = computeRequirementsCoverage(SAMPLE_REQUIREMENTS_INDEX, "no tasks here");
  assert.equal(coverage.complete, false);
  assert.deepEqual(coverage.uncoveredRequirementIds, ["RF-01", "RF-02", "RF-03"]);
});

test("computeRequirementsCoverage: a task referencing an unrelated RF id does not count toward coverage", () => {
  const coverage = computeRequirementsCoverage(SAMPLE_REQUIREMENTS_INDEX, "## Task X\n- requirementIds: RF-99");
  assert.deepEqual(coverage.uncoveredRequirementIds, ["RF-01", "RF-02", "RF-03"]);
});

// --- CLI round-trip ---------------------------------------------------------

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "req-coverage-cli-test-"));
  roots.push(root);
  return root;
}
test.after(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", windowsHide: true });
}

test("CLI: exits 0 with complete: true when every requirement is covered", () => {
  const dir = fixture();
  const reqFile = join(dir, "requirements.json");
  const tasksFile = join(dir, "tasks-classification.md");
  writeFileSync(reqFile, JSON.stringify(SAMPLE_REQUIREMENTS_INDEX));
  writeFileSync(tasksFile, FULL_COVERAGE_TASKS_MD);

  const result = run(["--requirements", reqFile, "--tasks", tasksFile]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.complete, true);
});

test("CLI: exits 1 with REQUIREMENTS_NOT_COVERED and the dropped id when coverage is incomplete", () => {
  const dir = fixture();
  const reqFile = join(dir, "requirements.json");
  const tasksFile = join(dir, "tasks-classification.md");
  writeFileSync(reqFile, JSON.stringify(SAMPLE_REQUIREMENTS_INDEX));
  writeFileSync(tasksFile, PARTIAL_COVERAGE_TASKS_MD);

  const result = run(["--requirements", reqFile, "--tasks", tasksFile]);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "REQUIREMENTS_NOT_COVERED");
  assert.deepEqual(parsed.error.details.uncoveredRequirementIds, ["RF-02", "RF-03"]);
});

test("CLI: exits 0 (never a false failure) when requirements.json does not exist — degrades to not-applicable", () => {
  const dir = fixture();
  const tasksFile = join(dir, "tasks-classification.md");
  writeFileSync(tasksFile, PARTIAL_COVERAGE_TASKS_MD);

  const result = run(["--requirements", join(dir, "does-not-exist.json"), "--tasks", tasksFile]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.applicable, false);
  assert.equal(parsed.complete, true);
});

test("CLI: exits with MISSING_ARGUMENT when --requirements is omitted", () => {
  const dir = fixture();
  const tasksFile = join(dir, "tasks-classification.md");
  writeFileSync(tasksFile, FULL_COVERAGE_TASKS_MD);
  const result = run(["--tasks", tasksFile]);
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stderr).error.code, "MISSING_ARGUMENT");
});

test("CLI: exits with MISSING_ARGUMENT when --tasks is omitted", () => {
  const dir = fixture();
  const reqFile = join(dir, "requirements.json");
  writeFileSync(reqFile, JSON.stringify(SAMPLE_REQUIREMENTS_INDEX));
  const result = run(["--requirements", reqFile]);
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stderr).error.code, "MISSING_ARGUMENT");
});
