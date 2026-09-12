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

export function validateUiEvidence(evidence, { baseDir = process.cwd() } = {}) {
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
  }
  for (const flag of BLOCKING_FLAGS) {
    const value = evidence.gates?.[flag];
    if (value === true || (typeof value === "number" && value > 0)) add("UI_GATE_FAILED", `${flag} must be false/zero`, `gates.${flag}`);
  }
  for (const review of evidence.reviews ?? []) {
    if (["critical", "high"].includes(review.severity) && review.status !== "resolved") add("HIGH_FINDING_OPEN", review.message ?? "High/critical finding remains open", review.id);
  }
  return { ok: findings.length === 0, status: findings.length === 0 ? "PASS" : "BLOCKED", findings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const file = resolve(required(args, "evidence"));
  const result = validateUiEvidence(JSON.parse(readFileSync(file, "utf8")), { baseDir: dirname(file) });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
