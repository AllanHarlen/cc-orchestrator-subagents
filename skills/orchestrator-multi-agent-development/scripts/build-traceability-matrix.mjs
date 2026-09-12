#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { parseArgs, required } from "./lib/cli-utils.mjs";

export function buildTraceabilityMatrix({
  requirementsData,
  stateData,
} = {}) {
  // 1. Extrair requirements
  let requirements = [];
  if (Array.isArray(requirementsData)) {
    requirements = requirementsData;
  } else if (requirementsData && Array.isArray(requirementsData.requirements)) {
    requirements = requirementsData.requirements;
  } else if (requirementsData && typeof requirementsData === "object") {
    requirements = Object.entries(requirementsData).map(([id, val]) => ({
      id,
      ...(typeof val === "object" ? val : { description: String(val) }),
    }));
  }

  // 2. Extrair tasks do state.json
  const tasks = [];
  if (stateData && stateData.tasks && typeof stateData.tasks === "object") {
    if (Array.isArray(stateData.tasks)) {
      tasks.push(...stateData.tasks);
    } else {
      tasks.push(...Object.values(stateData.tasks));
    }
  }

  // 3. Mapear RF -> Tasks cobrindo
  const rfToTasks = new Map();
  for (const task of tasks) {
    const rfIds = Array.isArray(task.requirementIds)
      ? task.requirementIds
      : (task.requirementIds ? [task.requirementIds] : []);

    for (const rf of rfIds) {
      const normalizedRf = String(rf).trim();
      if (!rfToTasks.has(normalizedRf)) rfToTasks.set(normalizedRf, []);
      rfToTasks.get(normalizedRf).push(task);
    }
  }

  // 4. Construir linhas da matriz
  const rows = [];
  for (const req of requirements) {
    const rfId = req.id || req.requirementId || "RF-?";
    const cas = Array.isArray(req.acceptanceCriteria) && req.acceptanceCriteria.length > 0
      ? req.acceptanceCriteria
      : (req.criteria ? req.criteria : ["Geral"]);

    const coveringTasks = rfToTasks.get(rfId) || [];
    const taskIdsStr = coveringTasks.length > 0
      ? coveringTasks.map((t) => t.id || t.taskId).join(", ")
      : "N/A";

    // Evidências
    const allProducedFiles = coveringTasks.flatMap((t) => t.producedFiles || t.files || []);
    const evidenceStr = allProducedFiles.length > 0
      ? allProducedFiles.slice(0, 3).join(", ") + (allProducedFiles.length > 3 ? "..." : "")
      : (coveringTasks.length > 0 ? "Implementado via task " + taskIdsStr : "Pendente de implementação");

    // Status
    const allDone = coveringTasks.length > 0 && coveringTasks.every((t) => t.status === "DONE" || t.phaseStatus === "DONE");
    const anyDone = coveringTasks.some((t) => t.status === "DONE");
    const statusStr = allDone ? "implementado" : (anyDone ? "parcial" : "pendente");

    for (const ca of cas) {
      const caId = typeof ca === "string" ? ca : (ca.id || ca.description || "CA-?");
      rows.push({
        rf: rfId,
        ca: caId,
        tasks: taskIdsStr,
        evidence: evidenceStr,
        status: statusStr,
      });
    }
  }

  return rows;
}

export function renderTraceabilityMatrixMarkdown(rows) {
  const header = [
    "| RF | CA | Task(s) | Evidência (arquivo:linha ou trecho) | Status |",
    "|---|---|---|---|---|",
  ];

  if (!rows || rows.length === 0) {
    return [
      ...header,
      "| N/A | N/A | N/A | Nenhuma rastreabilidade registrada | pendente |",
    ].join("\n");
  }

  const lines = rows.map((r) =>
    `| ${r.rf} | ${r.ca} | ${r.tasks} | ${r.evidence} | ${r.status} |`
  );

  return [...header, ...lines].join("\n");
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    stdout.write(`Usage: build-traceability-matrix.mjs --requirements <path> --state <path> [--output <path>] [--json]\n`);
    return 0;
  }

  const reqPath = required(args, "requirements");
  const statePath = required(args, "state");

  const resolvedReq = resolve(reqPath);
  const resolvedState = resolve(statePath);

  if (!existsSync(resolvedReq)) {
    throw new Error(`Requirements file not found: ${reqPath}`);
  }
  if (!existsSync(resolvedState)) {
    throw new Error(`State file not found: ${statePath}`);
  }

  const reqData = JSON.parse(readFileSync(resolvedReq, "utf8"));
  const stateData = JSON.parse(readFileSync(resolvedState, "utf8"));

  const rows = buildTraceabilityMatrix({
    requirementsData: reqData,
    stateData,
  });

  const markdown = renderTraceabilityMatrixMarkdown(rows);

  if (args.output) {
    writeFileSync(resolve(args.output), markdown, "utf8");
    stdout.write(`Traceability matrix written to ${args.output} (${rows.length} entries)\n`);
  } else if (args.json) {
    stdout.write(JSON.stringify(rows, null, 2) + "\n");
  } else {
    stdout.write(markdown + "\n");
  }

  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exit(1);
    },
  );
}
