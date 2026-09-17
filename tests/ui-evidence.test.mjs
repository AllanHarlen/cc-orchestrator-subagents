import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { validateUiEvidence } from "../skills/orchestrator-multi-agent-development/scripts/validate-ui-evidence.mjs";

const roots = [];
test.afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

function validEvidence() {
  const root = mkdtempSync(join(tmpdir(), "ui-evidence-"));
  roots.push(root);
  writeFileSync(join(root, "desktop.png"), "desktop");
  writeFileSync(join(root, "mobile.png"), "mobile");
  return { root, evidence: {
    routes: [{ route: "/services", requirementRef: "RF-001", browserAssertion: "service cards display API images",
      apiEvidence: { real: true, endpoint: "/api/services" },
      viewports: [{ kind: "desktop", screenshot: "desktop.png" }, { kind: "mobile", screenshot: "mobile.png" }] }],
    gates: {}, reviews: [],
  } };
}

test("accepts semantic desktop/mobile evidence backed by a real API", () => {
  const { root, evidence } = validEvidence();
  assert.equal(validateUiEvidence(evidence, { baseDir: root }).status, "PASS");
});

test("rejects commit-only evidence, mocks, missing screenshots and open high findings", () => {
  const { root, evidence } = validEvidence();
  evidence.routes[0].browserAssertion = "commit abc123";
  evidence.routes[0].apiEvidence.real = false;
  evidence.routes[0].viewports = [{ kind: "desktop", screenshot: "missing.png" }];
  evidence.gates.emojiIcons = 1;
  evidence.reviews = [{ id: "UX-1", severity: "high", status: "open", message: "navigation absent" }];
  const result = validateUiEvidence(evidence, { baseDir: root });
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(new Set(result.findings.map((item) => item.code)), new Set([
    "BROWSER_ASSERTION_MISSING", "REAL_API_EVIDENCE_MISSING", "VIEWPORT_MISSING", "SCREENSHOT_MISSING", "UI_GATE_FAILED", "HIGH_FINDING_OPEN",
  ]));
});

test("rejects a route with domain entities found in browser storage (the OficinaAI painel-data-context defect)", () => {
  const { root, evidence } = validEvidence();
  evidence.routes[0].storageAudit = { domainEntitiesInClientStorage: ["ordens-servico-seed", "clientes-seed"] };
  const result = validateUiEvidence(evidence, { baseDir: root });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.findings.some((f) => f.code === "DOMAIN_ENTITY_IN_CLIENT_STORAGE"));
});

test("ui-data-map cross-check: a screen with no matching evidenced route is a coverage gap", () => {
  const { root, evidence } = validEvidence();
  const uiDataMap = {
    screens: [
      { id: "public-services", requirementRefs: ["RF-001"], reads: [{ operation: "GET /services", scope: "list" }] },
      { id: "painel-os-kanban", requirementRefs: ["RF-009"], reads: [{ operation: "GET /ordens-servico", scope: "list" }] },
    ],
  };
  const result = validateUiEvidence(evidence, { baseDir: root, uiDataMap });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.findings.some((f) => f.code === "SCREEN_COVERAGE_INCOMPLETE" && f.path === "painel-os-kanban"));
});

test("ui-data-map cross-check: a list screen's evidenced route without persistenceProof is blocked", () => {
  const { root, evidence } = validEvidence();
  const uiDataMap = { screens: [{ id: "public-services", requirementRefs: ["RF-001"], reads: [{ operation: "GET /services", scope: "list" }] }] };
  const result = validateUiEvidence(evidence, { baseDir: root, uiDataMap });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.findings.some((f) => f.code === "PERSISTENCE_PROOF_MISSING"));
});

test("ui-data-map cross-check: passes once the matching route carries persistenceProof", () => {
  const { root, evidence } = validEvidence();
  evidence.routes[0].persistenceProof = { createdViaUi: true, verifiedInFreshContext: true };
  const uiDataMap = { screens: [{ id: "public-services", requirementRefs: ["RF-001"], reads: [{ operation: "GET /services", scope: "list" }] }] };
  const result = validateUiEvidence(evidence, { baseDir: root, uiDataMap });
  assert.equal(result.status, "PASS");
});

test("ui-data-map cross-check: a detail-only screen does not require persistenceProof", () => {
  const { root, evidence } = validEvidence();
  const uiDataMap = { screens: [{ id: "public-services", requirementRefs: ["RF-001"], reads: [{ operation: "GET /services/{id}", scope: "detail" }] }] };
  const result = validateUiEvidence(evidence, { baseDir: root, uiDataMap });
  assert.equal(result.status, "PASS");
});

