#!/usr/bin/env node
/**
 * Fase 8.0 — validates the running API against its machine-readable contract (gate
 * `apiContractValidation`). Schemathesis (`st run <schema> --url <base>`) exercises every operation
 * and checks status codes, response schemas, content types and headers against the contract.
 *
 *   node validate-api-contract.mjs --contract contracts/openapi.yaml --base-url http://127.0.0.1:5000 \
 *     --dir .orchestrator/runs/<slug> [--command "<tool> <contract> <url>"] [--dry-run]
 *
 * Writes evidence/api-contract-validation.json (kind api-contract-validation, schemaVersion 1) bound
 * to the contract's sha256; updateCompletionGate refuses DONE unless it is a non-dry-run PASS for the
 * contract on disk. Exit: 0 PASS, 1 FAILED/BLOCKED.
 *
 * Audit finding: the Pensador handoff declared `schemathesis run openapi.yaml` (without --url, so never
 * runnable) and nothing ran it; a 422 where the contract said 409 and a renamed error code only
 * surfaced in the human review (OficinaAI, 2026-09).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { artifactWritePath } from "./lib/artifact-layout.mjs";
import { parseArgs } from "./lib/cli-utils.mjs";

const TIMEOUT_MS = 30 * 60 * 1000;

function onPath(command, spawn) {
  const result = spawn(command, ["--version"], { shell: true, encoding: "utf8", timeout: 60_000 });
  return result.status === 0;
}

/** Tool resolution: explicit command > `st` > `schemathesis` > `uvx schemathesis`. */
export function resolveValidatorCommand({ contract, baseUrl, reportDir, command, spawn = spawnSync }) {
  const quote = (value) => `"${String(value).replaceAll('"', '\\"')}"`;
  if (command) {
    return { tool: "custom", command: command.replaceAll("<contract>", quote(contract)).replaceAll("<url>", quote(baseUrl)) };
  }
  const args = `run ${quote(contract)} --url ${quote(baseUrl)} --report junit --report-dir ${quote(reportDir)}`;
  if (onPath("st", spawn)) return { tool: "schemathesis", command: `st ${args}` };
  if (onPath("schemathesis", spawn)) return { tool: "schemathesis", command: `schemathesis ${args}` };
  if (onPath("uvx", spawn)) return { tool: "schemathesis (uvx)", command: `uvx schemathesis ${args}` };
  return null;
}

export function validateApiContract({
  contract,
  baseUrl,
  runDir,
  projectRoot = process.cwd(),
  command,
  dryRun = false,
  spawn = spawnSync,
  now = new Date().toISOString(),
}) {
  const contractAbsolutePath = resolve(projectRoot, contract ?? "");
  const base = {
    kind: "api-contract-validation",
    schemaVersion: 1,
    contractPath: contract ?? null,
    contractAbsolutePath,
    baseUrl: baseUrl ?? null,
    dryRun,
    generatedAt: now,
  };
  const finish = (report) => {
    if (runDir) {
      const target = artifactWritePath(resolve(runDir), "api-contract-validation.json");
      mkdirSync(dirname(target.path), { recursive: true });
      writeFileSync(target.path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      return { ...report, evidencePath: target.relativePath };
    }
    return report;
  };
  if (!contract || !existsSync(contractAbsolutePath)) {
    return finish({ ...base, status: "BLOCKED", reasonCode: "CONTRACT_NOT_FOUND", message: `Contract not found: ${contract ?? "(no --contract)"}; materialize it into the repository first (materialize-api-contract.mjs)` });
  }
  if (/(?:^|[\\/])\.(?:pensador|orchestrator|orchestration|testador|executor)[\\/]/.test(contractAbsolutePath)) {
    return finish({ ...base, status: "BLOCKED", reasonCode: "CONTRACT_OUTSIDE_REPOSITORY", message: "Validate the copy materialized into the repository, not the coordination folder" });
  }
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    return finish({ ...base, status: "BLOCKED", reasonCode: "BASE_URL_REQUIRED", message: "--base-url of the running API is required (start the stack first, e.g. the Fase 4.3 smoke test)" });
  }
  const contractSha256 = createHash("sha256").update(readFileSync(contractAbsolutePath)).digest("hex");
  const reportDir = runDir ? join(resolve(runDir), "evidence", "schemathesis") : join(projectRoot, "schemathesis-report");
  const resolved = resolveValidatorCommand({ contract: contractAbsolutePath, baseUrl, reportDir, command, spawn });
  if (!resolved) {
    return finish({
      ...base,
      contractSha256,
      status: "BLOCKED",
      reasonCode: "VALIDATOR_UNAVAILABLE",
      message: "Schemathesis not found (st, schemathesis or uvx). Install it (uv tool install schemathesis, or pip install schemathesis) or pass --command",
    });
  }
  if (dryRun) return finish({ ...base, contractSha256, tool: resolved.tool, command: resolved.command, status: "PLANNED" });
  const run = spawn(resolved.command, { shell: true, cwd: projectRoot, encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  // Schemathesis: 0 = every check passed, 1 = a check failed, 2 = aborted (config/schema error).
  const status = run.status === 0 ? "PASS" : run.status === 1 ? "FAILED" : "BLOCKED";
  return finish({
    ...base,
    contractSha256,
    tool: resolved.tool,
    command: resolved.command,
    exitCode: run.status,
    status,
    reasonCode: status === "PASS" ? null : status === "FAILED" ? "CONTRACT_CHECKS_FAILED" : "VALIDATOR_ABORTED",
    reportDir,
    outputTail: output.slice(-6000),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const result = validateApiContract({
    contract: typeof args.contract === "string" ? args.contract : undefined,
    baseUrl: typeof args["base-url"] === "string" ? args["base-url"] : undefined,
    runDir: typeof args.dir === "string" ? args.dir : undefined,
    projectRoot: typeof args.root === "string" ? resolve(args.root) : process.cwd(),
    command: typeof args.command === "string" ? args.command : undefined,
    dryRun: args["dry-run"] === true,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === "PASS" || (result.dryRun && result.status === "PLANNED") ? 0 : 1;
}
