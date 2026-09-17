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
