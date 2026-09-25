#!/usr/bin/env node
/**
 * CLI: RF/CA requirements coverage gate (see lib/requirements-coverage.mjs).
 *
 * Usage:
 *   node validate-requirements-coverage.mjs --requirements <requirements.json> --tasks <plan/tasks-classification.md>
 *
 * Run in Fase 2 (right after tasks-classification.md is drafted, to catch a
 * dropped requirement before delegation) and again in Fase 7 (before closing
 * the traceability matrix in implementation-report.md section 13 — see
 * references/workflow.md). `--requirements` may point at a Pensador
 * `requirements.json` (role `requirements-index`, PRD mode only); a missing
 * or Spec-mode handoff degrades to `applicable: false` rather than a false
 * failure — the CLI still exits 0 in that case, since there is nothing this
 * gate can check.
 *
 * Exit code: 0 when `applicable: false` OR `complete: true`; 1 when
 * `applicable: true` and at least one requirement has zero task coverage
 * (`ok: false`, non-empty `uncoveredRequirementIds`).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { artifactWritePath } from "./lib/artifact-layout.mjs";
import { executeJsonCli, readJsonFile, required } from "./lib/cli-utils.mjs";
import { computeRequirementsCoverage } from "./lib/requirements-coverage.mjs";

/**
 * `--dir <run>` snapshots the index into plan/requirements-index.json. The Fase 10 evidence audit
 * (orchestration-state.mjs) then checks requirements-evidence.json against the Pensador's own ids
 * and CA links, not only against whatever ids the tasks happened to claim.
 */
function snapshotIndex(runDir, index) {
  const target = artifactWritePath(resolve(runDir), "requirements-index.json");
  mkdirSync(dirname(target.path), { recursive: true });
  const pick = (key) => (Array.isArray(index?.[key]) ? index[key] : []);
  writeFileSync(target.path, `${JSON.stringify({
    schemaVersion: 1,
    requirements: pick("requirements"),
    acceptanceCriteria: pick("acceptanceCriteria"),
    nonFunctionalRequirements: pick("nonFunctionalRequirements"),
    architecturePatterns: pick("architecturePatterns"),
  }, null, 2)}\n`, "utf8");
  return target.relativePath;
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      args[key] = argv[i + 1] ?? true;
      if (typeof args[key] === "string") i += 1;
    }
  }

  const requirementsPath = required(args, "requirements");
  const tasksPath = required(args, "tasks");

  let requirementsIndex = null;
  try {
    requirementsIndex = readJsonFile(requirementsPath);
  } catch (error) {
    // A missing requirements.json is a legitimate degradation (Spec mode, or
    // a handoff produced before this role existed) — never a hard failure.
    if (error.code !== "INVALID_JSON_FILE") throw error;
  }

  const tasksMarkdown = readFileSync(resolve(tasksPath), "utf8");
  const coverage = computeRequirementsCoverage(requirementsIndex, tasksMarkdown);
  if (typeof args.dir === "string" && requirementsIndex) {
    coverage.indexSnapshot = snapshotIndex(args.dir, requirementsIndex);
  }

  if (coverage.applicable && !coverage.complete) {
    const error = new Error(
      `${coverage.uncoveredRequirementIds.length} of ${coverage.totalRequirements} requirement(s) have no task covering them: `
        + `${coverage.uncoveredRequirementIds.join(", ")}. Every RF/RNF/ARC id the Pensador extracted must be claimed by at least `
        + `one task's requirementIds before the run can close DONE (WORKFLOW.md: "o Orchestrador é obrigado a atender todos os critérios de aceite").`,
    );
    error.code = "REQUIREMENTS_NOT_COVERED";
    error.details = coverage;
    throw error;
  }

  return coverage;
}

executeJsonCli(main);
