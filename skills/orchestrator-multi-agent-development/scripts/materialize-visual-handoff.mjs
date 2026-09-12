#!/usr/bin/env node
/** Validates and optionally materializes only authoritative resolved design packages. */
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { inspectVisualHandoff } from "./lib/pensador-ingest.mjs";
import { parseArgs, required } from "./lib/cli-utils.mjs";

function within(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function targetPath(projectRoot, requested) {
  const target = resolve(projectRoot, requested);
  if (!within(projectRoot, target)) {
    const error = new Error(`Materialization target escapes project root: ${requested}`);
    error.code = "UNSAFE_MATERIALIZATION_TARGET";
    throw error;
  }
  return target;
}

export function materializeVisualHandoff({ projectRoot = process.cwd(), handoffPath, apply = false }) {
  const root = resolve(projectRoot);
  const handoffFile = resolve(handoffPath);
  const handoff = JSON.parse(readFileSync(handoffFile, "utf8"));
  const inspection = inspectVisualHandoff(handoff, handoffFile);
  if (inspection.blocking) return { status: "BLOCKED", applied: false, findings: inspection.findings, operations: [] };

  const operations = [];
  for (const pkg of inspection.packages) {
    if (pkg.variant !== "resolved" || !pkg.authoritative) {
      operations.push({ type: "legacy-review", source: pkg.packageRoot, applied: false });
      continue;
    }
    const destination = targetPath(root, pkg.materializeInto);
    operations.push({ type: "design-package", source: pkg.packageRoot, destination, applied: apply });
    if (apply) {
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(pkg.packageRoot, destination, { recursive: true, force: true });
    }
    for (const asset of pkg.assets) {
      const source = resolve(pkg.packageRoot, "assets", asset.file);
      const assetDestination = targetPath(root, asset.materializeInto);
      operations.push({ type: "asset", id: asset.id, source, destination: assetDestination, seedBindings: asset.seedBindings ?? [], applied: apply });
      if (apply) {
        if (!existsSync(source)) continue;
        mkdirSync(dirname(assetDestination), { recursive: true });
        cpSync(source, assetDestination, { force: true });
      }
    }
  }
  return { status: "PASS", applied: apply, degraded: inspection.degraded, findings: inspection.findings, operations };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const result = materializeVisualHandoff({
    projectRoot: args.root === true ? process.cwd() : (args.root ?? process.cwd()),
    handoffPath: required(args, "handoff"),
    apply: args.apply === true || String(args.apply ?? "").toLowerCase() === "true",
  });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === "PASS" ? 0 : 1;
}
