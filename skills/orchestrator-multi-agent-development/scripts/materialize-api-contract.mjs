#!/usr/bin/env node
/**
 * Fase 4.2 — copies the Pensador's machine-readable API contract (role `api-contract`) into the
 * product repository, so type generation, mocks, CI and validate-api-contract.mjs read an in-repo
 * file instead of the hidden coordination folder.
 *
 *   node materialize-api-contract.mjs --handoff .pensador/<slug>-vN/handoff.json [--root .] [--into contracts] [--apply]
 *
 * Audit finding: a real front-end generated its API types with
 * `openapi-typescript ../.pensador/<slug>/openapi.yaml`, so the product could not build without the
 * planning folder (OficinaAI, 2026-09). run-wave-gate.mjs now fails on any such reference
 * (checks.coordinationRefs).
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { parseArgs } from "./lib/cli-utils.mjs";
import { buildArtifactRootResolver } from "./lib/pensador-ingest.mjs";

const COORDINATION_DIR = /(?:^|[\\/])\.(?:pensador|orchestrator|orchestration|testador|executor)(?:[\\/]|$)/;

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function materializeApiContract({ handoffPath, projectRoot = process.cwd(), into = "contracts", apply = false }) {
  const root = resolve(projectRoot);
  const handoffFile = resolve(root, handoffPath);
  if (!existsSync(handoffFile)) return { status: "BLOCKED", reasonCode: "HANDOFF_NOT_FOUND", operations: [] };
  const handoff = JSON.parse(readFileSync(handoffFile, "utf8"));
  const contracts = (handoff.artifacts ?? []).filter((artifact) => artifact?.role === "api-contract");
  if (contracts.length === 0) {
    return { status: "SKIPPED", reasonCode: "NO_API_CONTRACT", message: "The handoff declares no api-contract (Spec mode, or no back-end)", operations: [] };
  }
  const destinationDir = resolve(root, into);
  const rel = relative(root, destinationDir);
  if (rel.startsWith("..") || isAbsolute(rel) || COORDINATION_DIR.test(`/${rel.replaceAll("\\", "/")}/`)) {
    return { status: "BLOCKED", reasonCode: "UNSAFE_TARGET", message: `--into must be a product folder inside the repository, got ${into}`, operations: [] };
  }
  const resolveArtifact = buildArtifactRootResolver(handoff, handoffFile);
  const operations = [];
  const findings = [];
  for (const artifact of contracts) {
    const candidates = [resolveArtifact(artifact.path), resolve(root, artifact.path)];
    const source = candidates.find((candidate) => existsSync(candidate));
    if (!source) {
      findings.push({ severity: "high", code: "API_CONTRACT_MISSING", path: artifact.path });
      continue;
    }
    const destination = join(destinationDir, basename(source));
    const destinationRel = relative(root, destination).replaceAll("\\", "/");
    const declared = typeof artifact.validation?.validate === "string" ? artifact.validation.validate : null;
    // Handoffs before cc-pensador 2.38.0 carry `schemathesis run openapi.yaml`, which has no --url
    // and so can never run against a file schema; normalize it to the runnable form.
    const validate = declared && /^(?:st|schemathesis)\s+run\b/.test(declared) && !/--url\b/.test(declared)
      ? `st run ${destinationRel} --url <base-url>`
      : declared?.replaceAll(basename(source), destinationRel) ?? null;
    operations.push({ source, destination: destinationRel, sha256: sha256(source), validate, applied: apply });
    if (apply) {
      mkdirSync(destinationDir, { recursive: true });
      copyFileSync(source, destination);
    }
  }
  const blocking = findings.some((finding) => finding.severity === "high");
  return {
    status: blocking ? "BLOCKED" : "PASS",
    applied: apply,
    operations,
    findings,
    note: "Generate types, mocks and CI validation from the repository copy; never reference the coordination folder from product code.",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const result = materializeApiContract({
    handoffPath: String(args.handoff ?? ""),
    projectRoot: typeof args.root === "string" ? args.root : process.cwd(),
    into: typeof args.into === "string" ? args.into : "contracts",
    apply: args.apply === true || String(args.apply ?? "").toLowerCase() === "true",
  });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === "BLOCKED" ? 1 : 0;
}
