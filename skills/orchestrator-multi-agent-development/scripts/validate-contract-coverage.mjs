#!/usr/bin/env node
/**
 * CLI: screen-to-contract-operation coverage gate (see lib/contract-coverage.mjs).
 *
 * Usage:
 *   node validate-contract-coverage.mjs --ui-data-map <ui-data-map.json> --contract <openapi.yaml> [--format rest]
 *
 * Run in Fase 4, right after the api-contract is confirmed present
 * (joint mode: ingested from the Pensador handoff; independent mode: the
 * Orchestrador's own contract) and before any front-end task is dispatched —
 * catching a screen with no backing operation here is far cheaper than
 * discovering it in Fase 9.5's browser E2E, after the front-end has already
 * filled the gap with client-side storage (the exact defect a real run
 * shipped: OficinaAI, 2026-09-16, 41 RFs against 21 openapi.yaml
 * operations).
 *
 * `--ui-data-map` may be absent (backend-only project, or a Pensador handoff
 * from before this role existed) — degrades to `applicable: false` rather
 * than a false failure; the CLI still exits 0 in that case, since there is
 * nothing this gate can check.
 *
 * Exit code: 0 when `applicable: false` OR `ok: true`; 1 when `applicable:
 * true` and at least one screen operation has no matching contract
 * operation (`ok: false`, non-empty `gaps`).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { executeJsonCli, readJsonFile } from "./lib/cli-utils.mjs";
import { validateContractCoverage } from "./lib/contract-coverage.mjs";

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      args[key] = argv[i + 1] ?? true;
      if (typeof args[key] === "string") i += 1;
    }
  }

  let uiDataMap = null;
  if (args["ui-data-map"]) {
    try {
      uiDataMap = readJsonFile(args["ui-data-map"]);
    } catch (error) {
      if (error.code !== "INVALID_JSON_FILE") throw error;
    }
  }
  if (!uiDataMap) {
    return { applicable: false, format: args.format ?? "rest", reason: "NO_UI_DATA_MAP: no --ui-data-map provided or file unreadable — nothing to cross-check (backend-only project, or upstream handoff predates the ui-data-map role)." };
  }

  if (!args.contract) {
    return { applicable: false, format: args.format ?? "rest", reason: "NO_CONTRACT: --contract is required once a ui-data-map exists — a front-end with screens and no contract to check against is itself a gap, but this gate cannot report it without a file to read." };
  }
  const contractText = readFileSync(resolve(args.contract), "utf8");

  const coverage = validateContractCoverage(uiDataMap, contractText, { format: args.format ?? "rest" });
  if (coverage.applicable && !coverage.ok) {
    const error = new Error(
      `${coverage.gaps.length} screen operation(s) have no matching contract operation: `
        + `${coverage.gaps.map((gap) => `${gap.screenId} -> ${gap.operation}`).join("; ")}. `
        + `Every screen the ui-data-map declares must read/write a REAL operation from the contract — never client-side storage.`,
    );
    error.code = "CONTRACT_COVERAGE_GAP";
    error.details = coverage;
    throw error;
  }

  return coverage;
}

executeJsonCli(main);
