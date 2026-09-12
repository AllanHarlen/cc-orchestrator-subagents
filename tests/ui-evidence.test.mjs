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

