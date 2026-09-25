#!/usr/bin/env node
/** Validates and optionally materializes only authoritative resolved design packages. */
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { inspectVisualHandoff } from "./lib/pensador-ingest.mjs";
import { parseArgs, required } from "./lib/cli-utils.mjs";

/**
 * Files of the resolved package the product consumes. Audit finding: copying the whole package put
 * preview HTML, provenance and audit files inside `frontend/src/styles` of a real app (OficinaAI,
 * 2026-09), and the preview's `.grid` scaffolding leaked into the product CSS.
 */
export const PRODUCT_PACKAGE_FILES = Object.freeze([
  "design-contract.json",
  "tokens.css",
  "components.css",
  "tailwind-v4.css",
  "design-tokens.json",
  "DESIGN.md",
  "USAGE.md",
  "manifest.json",
  "components.manifest.json",
  "assets/manifest.json",
]);

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
    // Only what the product imports or reads goes into the code tree; the visual reference
    // (components.html, preview/) and the audit trail stay in the Pensador package, whose path is
    // reported as `referenceRoot` for prompts, the bridge's --design-system and the Fase 9 checks.
    const productFiles = PRODUCT_PACKAGE_FILES.filter((file) => existsSync(join(pkg.packageRoot, file)));
    operations.push({ type: "design-package", source: pkg.packageRoot, destination, referenceRoot: pkg.packageRoot, files: productFiles, applied: apply });
    if (apply) {
      for (const file of productFiles) {
        mkdirSync(dirname(join(destination, file)), { recursive: true });
        cpSync(join(pkg.packageRoot, file), join(destination, file), { force: true });
      }
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
