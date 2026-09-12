#!/usr/bin/env node
/** Single authority for the orchestrator's initial preflight and Pensador ingestion. */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ingestPensadorHandoff } from "./lib/pensador-ingest.mjs";
import { parseArgs } from "./lib/cli-utils.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function executePreflight(projectRoot, timeoutMs) {
  try {
    const stdout = execFileSync(process.execPath, [resolve(HERE, "preflight.mjs"), "--json", "--silent"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      windowsHide: true,
    });
    return JSON.parse(stdout);
  } catch (error) {
    const stdout = String(error.stdout ?? "").trim();
    if (stdout) {
      try { return JSON.parse(stdout); } catch { /* fall through */ }
    }
    return {
      status: "failed",
      generatedAt: new Date().toISOString(),
      projectConfig: { source: "default", path: ".orchestrator/project-config.md", requiredCliSet: [] },
      failed: [{ category: "bootstrap", name: "preflight", error: error.message }],
      warnings: [],
    };
  }
}

export function bootstrapOrchestrator(options = {}) {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const preflight = options.preflightReport ?? executePreflight(projectRoot, options.timeoutMs ?? 30_000);
  const projectConfig = preflight.projectConfig ?? {};
  const base = {
    probeId: options.probeId ?? randomUUID(),
    generatedAt: preflight.generatedAt ?? new Date().toISOString(),
    preflight,
    projectConfig: {
      source: projectConfig.source ?? "default",
      path: projectConfig.path ?? ".orchestrator/project-config.md",
      roles: projectConfig.roles ?? null,
      requiredCliSet: projectConfig.requiredCliSet ?? [],
    },
  };

  if (projectConfig.source !== "file") {
    return { ...base, status: "NEEDS_PROJECT_CONFIG", nextAction: "COLLECT_PROJECT_CONFIG", ingestion: null };
  }
  if (preflight.status !== "ok") {
    return { ...base, status: "BLOCKED_DEPENDENCY", nextAction: "REMEDIATE_DEPENDENCY", ingestion: null, blockers: preflight.failed ?? [] };
  }

  const ingestion = ingestPensadorHandoff({ projectRoot, slug: options.slug });
  const ingestionBlock = {
    mode: ingestion.mode,
    slug: ingestion.slug,
    handoffPath: ingestion.pensadorHandoffPath,
    warning: ingestion.warning,
    slugCandidates: ingestion.slugCandidates,
    visualPackage: ingestion.visualPackage ?? null,
  };
  if (ingestion.mode === "ambiguous") return { ...base, status: "AMBIGUOUS_HANDOFF", nextAction: "SELECT_SLUG", ingestion: ingestionBlock };
  if (ingestion.mode === "joint" && ingestion.visualPackage?.blocking) {
    return { ...base, status: "BLOCKED_DEPENDENCY", nextAction: "REPAIR_VISUAL_HANDOFF", ingestion: ingestionBlock, blockers: ingestion.visualPackage.findings };
  }
  if (ingestion.mode === "joint") return { ...base, status: "READY_JOINT", nextAction: "LOAD_WORKFLOW", ingestion: ingestionBlock };
  if (options.hasSpecification) return { ...base, status: "READY_STANDALONE", nextAction: "LOAD_WORKFLOW", ingestion: ingestionBlock };
  return { ...base, status: "NEEDS_SPECIFICATION", nextAction: "REQUEST_SPECIFICATION", ingestion: ingestionBlock };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const result = bootstrapOrchestrator({
    projectRoot: args.root === true ? process.cwd() : args.root,
    slug: args.slug === true ? undefined : args.slug,
    hasSpecification: args["has-specification"] === true || String(args["has-specification"] ?? "").toLowerCase() === "true",
    timeoutMs: args["timeout-ms"] ? Number(args["timeout-ms"]) : undefined,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === "BLOCKED_DEPENDENCY" ? 1 : 0;
}
