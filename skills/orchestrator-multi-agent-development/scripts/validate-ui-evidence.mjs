#!/usr/bin/env node
/** Terminal UI/UX gate. A commit hash is never accepted as visual evidence. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, required } from "./lib/cli-utils.mjs";

const BLOCKING_FLAGS = [
  "undefinedTokens", "hardcodedDesignValues", "brokenImages", "missingAlt", "emojiIcons",
  "missingNavigation", "previewDivergence", "productionMockFallback", "maskedHttpErrors",
  "authRefreshFailure", "authDeepLinkFailure", "consoleErrors", "networkErrors", "monetaryInconsistency",
];

/**
 * `uiDataMap` (optional, {screens: [...]} — the Pensador's ui-data-map.json,
 * see cc-pensador's scripts/lib/contract-coverage.mjs) sharpens the boolean
 * self-attestation gates above with two mechanical checks a real run
 * (OficinaAI, 2026-09-16) showed a boolean alone cannot catch: the
 * orchestrator itself wrote `gates.productionMockFallback: false` while the
 * entire internal panel actually read from localStorage, because only 4 of
 * the product's screens were ever evidenced and none of those 4 happened to
 * be list screens (where a client-side mock is most likely to hide).
 *
 *   - SCREEN_COVERAGE_INCOMPLETE: every ui-data-map screen (matched to a
 *     route by shared `requirementRef`) must be evidenced — not a
 *     hand-picked subset.
 *   - PERSISTENCE_PROOF_MISSING: a route matching a screen that reads an
 *     entity as `scope: "list"` must carry `route.persistenceProof: true`
 *     (or an object) — the concrete claim being made is "created via the
 *     UI, then verified still present in a FRESH browser context", the one
 *     check that mechanically distinguishes a real API-backed list from a
 *     client-side mock/seed array.
 *   - DOMAIN_ENTITY_IN_CLIENT_STORAGE: `route.storageAudit
 *     .domainEntitiesInClientStorage` (localStorage/sessionStorage/IndexedDB
 *     keys actually inspected in the browser) must be empty — a non-empty
 *     list is exactly the OficinaAI painel-data-context.tsx defect.
 */
/**
 * `route.persistenceProof` must actually assert the two concrete claims the
 * docstring above promises — `true` alone (a bare flag) is accepted as a
 * deliberate shorthand, but an OBJECT form must carry both named booleans
 * set to `true`. An empty `{}`, or an object missing/false-ing either
 * field, satisfies neither: it previously passed this check (`typeof ===
 * "object"` alone was truthy) while proving nothing, defeating the one
 * check meant to mechanically catch a repeat of the exact self-attestation
 * failure this whole cross-check exists to prevent.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isPersistenceProofSatisfied(value) {
  if (value === true) return true;
  if (typeof value !== "object" || value === null) return false;
  return value.createdViaUi === true && value.verifiedInFreshContext === true;
}

/**
 * The three design gates (`undefinedTokens`, `hardcodedDesignValues`, `previewDivergence`) used to be
 * booleans the orchestrator wrote about its own work. A `false` is now only accepted when backed by a
 * MECHANICAL evidence file, referenced by `evidence.designEvidence` (paths relative to the evidence file):
 *   - `tokenLint`: the `checks.designTokens` output of run-wave-gate.mjs (or a whole `--json` run of it)
 *     with status PASS, enabled, and no violations/undefinedTokens — proves the first two gates;
 *   - `previewDiff`: the aggregated output of the runtime design probe / preview comparison, with
 *     `status: "PASS"` and no blocking findings — proves `previewDivergence`.
 * A `true`/positive flag always blocks; an omitted flag with no design evidence is not an attestation
 * (only when the run declares a design system: `evidence.designSystem` or any of the flags being set).
 */
const DESIGN_EVIDENCE_GATES = {
  undefinedTokens: "tokenLint",
  hardcodedDesignValues: "tokenLint",
  previewDivergence: "previewDiff",
};

function readEvidenceFile(baseDir, relPath) {
  if (typeof relPath !== "string" || relPath === "") return { status: "missing" };
  const file = resolve(baseDir, relPath);
  if (!existsSync(file)) return { status: "missing", file };
  try { return { status: "ok", file, value: JSON.parse(readFileSync(file, "utf8")) }; }
  catch { return { status: "invalid", file }; }
}

function tokenLintProblem(value) {
  const check = value?.checks?.designTokens ?? value;
  if (!check || typeof check !== "object") return "not a run-wave-gate designTokens output";
  if (check.enabled !== true) return "design token lint was not enabled (no tokens.css)";
  if (check.status !== "PASS") return `design token lint status is ${check.status ?? "missing"}`;
  if ((check.violations ?? []).length > 0 || (check.undefinedTokens ?? []).length > 0) return "design token lint reports violations";
  if (!Array.isArray(check.filesScanned)) return "design token lint did not record filesScanned";
  return null;
}

function previewDiffProblem(value) {
  if (!value || typeof value !== "object") return "not a probe/preview-diff output";
  const blocking = (value.findings ?? []).filter((item) => item?.blocking === true || ["critical", "high"].includes(item?.severity));
  if (value.status !== "PASS" || blocking.length > 0) return `probe status is ${value.status ?? "missing"}${blocking.length ? ` with ${blocking.length} blocking finding(s)` : ""}`;
  return null;
}

function verifyDesignEvidence(evidence, baseDir, add) {
  const gates = evidence.gates ?? {};
  const attested = Object.keys(DESIGN_EVIDENCE_GATES).filter((flag) => gates[flag] === false || gates[flag] === 0);
  if (!evidence.designSystem && attested.length === 0 && !evidence.designEvidence) return;
  const needed = new Set(Object.keys(DESIGN_EVIDENCE_GATES).map((flag) => DESIGN_EVIDENCE_GATES[flag]));
  for (const kind of needed) {
    const ref = evidence.designEvidence?.[kind];
    const read = readEvidenceFile(baseDir, ref);
    const flags = Object.keys(DESIGN_EVIDENCE_GATES).filter((flag) => DESIGN_EVIDENCE_GATES[flag] === kind);
    if (read.status === "missing") { add("DESIGN_EVIDENCE_MISSING", `designEvidence.${kind} must point to an existing mechanical evidence file (gates ${flags.join("/")} cannot be self-attested)`, `designEvidence.${kind}`); continue; }
    if (read.status === "invalid") { add("DESIGN_EVIDENCE_INVALID", `designEvidence.${kind} is not valid JSON`, `designEvidence.${kind}`); continue; }
    const problem = kind === "tokenLint" ? tokenLintProblem(read.value) : previewDiffProblem(read.value);
    if (problem) add("DESIGN_EVIDENCE_FAILED", `designEvidence.${kind}: ${problem}`, `designEvidence.${kind}`);
  }
}

export function validateUiEvidence(evidence, { baseDir = process.cwd(), uiDataMap = null } = {}) {
  const findings = [];
  const add = (code, message, path = null) => findings.push({ severity: "high", code, message, path });
  if (!Array.isArray(evidence.routes) || evidence.routes.length === 0) add("ROUTES_MISSING", "At least one critical route must be evidenced", "routes");
  for (const route of evidence.routes ?? []) {
    if (!route.route || !route.requirementRef) add("ROUTE_TRACEABILITY_MISSING", "Route and requirementRef are mandatory", route.route);
    if (!route.browserAssertion || /^commit\b/i.test(route.browserAssertion)) add("BROWSER_ASSERTION_MISSING", "A semantic browser assertion is required", route.route);
    if (!route.apiEvidence || route.apiEvidence.real !== true) add("REAL_API_EVIDENCE_MISSING", "Displayed data must be traced to a real API response", route.route);
    const viewports = new Set((route.viewports ?? []).map((item) => item.kind));
    for (const kind of ["desktop", "mobile"]) if (!viewports.has(kind)) add("VIEWPORT_MISSING", `${kind} evidence is required`, route.route);
    for (const viewport of route.viewports ?? []) {
      const screenshot = viewport.screenshot ? resolve(baseDir, viewport.screenshot) : null;
      if (!screenshot || !existsSync(screenshot)) add("SCREENSHOT_MISSING", `Screenshot is missing for ${viewport.kind}`, route.route);
    }
    const domainEntitiesInClientStorage = route.storageAudit?.domainEntitiesInClientStorage;
    if (Array.isArray(domainEntitiesInClientStorage) && domainEntitiesInClientStorage.length > 0) {
      add("DOMAIN_ENTITY_IN_CLIENT_STORAGE", `Domain entities found in browser storage: ${domainEntitiesInClientStorage.join(", ")}`, route.route);
    }
  }
  for (const flag of BLOCKING_FLAGS) {
    const value = evidence.gates?.[flag];
    if (value === true || (typeof value === "number" && value > 0)) add("UI_GATE_FAILED", `${flag} must be false/zero`, `gates.${flag}`);
  }
  verifyDesignEvidence(evidence, baseDir, add);
  for (const review of evidence.reviews ?? []) {
    if (["critical", "high"].includes(review.severity) && review.status !== "resolved") add("HIGH_FINDING_OPEN", review.message ?? "High/critical finding remains open", review.id);
  }

  if (uiDataMap && Array.isArray(uiDataMap.screens)) {
    const routesByRequirementRef = new Map();
    for (const route of evidence.routes ?? []) {
      if (route.requirementRef) routesByRequirementRef.set(route.requirementRef, route);
    }
    for (const screen of uiDataMap.screens) {
      const refs = Array.isArray(screen.requirementRefs) ? screen.requirementRefs : [];
      const matchedRoute = refs.map((ref) => routesByRequirementRef.get(ref)).find(Boolean);
      if (!matchedRoute) {
        add("SCREEN_COVERAGE_INCOMPLETE", `ui-data-map screen "${screen.id}" (${refs.join(", ") || "no requirementRefs"}) has no matching evidenced route`, screen.id);
        continue;
      }
      const hasListRead = Array.isArray(screen.reads) && screen.reads.some((read) => read?.scope === "list");
      if (hasListRead && !isPersistenceProofSatisfied(matchedRoute.persistenceProof)) {
        add("PERSISTENCE_PROOF_MISSING", `screen "${screen.id}" reads a list but route "${matchedRoute.route}" carries no persistenceProof (create via UI, verify in a fresh browser context)`, matchedRoute.route);
      }
    }
  }

  return { ok: findings.length === 0, status: findings.length === 0 ? "PASS" : "BLOCKED", findings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const file = resolve(required(args, "evidence"));
  const uiDataMap = args["ui-data-map"] ? JSON.parse(readFileSync(resolve(args["ui-data-map"]), "utf8")) : null;
  const result = validateUiEvidence(JSON.parse(readFileSync(file, "utf8")), { baseDir: dirname(file), uiDataMap });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
