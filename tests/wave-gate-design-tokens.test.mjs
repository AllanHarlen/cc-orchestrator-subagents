import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  checkDesignTokens,
  lintCssForTokens,
  runWaveQualityGate,
} from "../skills/orchestrator-multi-agent-development/scripts/run-wave-gate.mjs";

const roots = [];
test.afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

function project(files) {
  const root = mkdtempSync(join(tmpdir(), "wave-gate-"));
  roots.push(root);
  writeFileSync(join(root, "tokens.css"), ":root { --accent: #2563eb; --space-2: 8px; --radius-md: 6px; }\n");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

const gate = (root, changedFiles) => runWaveQualityGate({ rootDir: root, dryRun: true, tokensCssPath: "tokens.css", changedFiles });

test("wave gate FAILS a component file with a literal hex color (it used to always PASS)", () => {
  const root = project({ "src/Button.css": ".btn { color: #ff0000; background: var(--accent); }\n" });
  const result = gate(root, ["src/Button.css"]);
  assert.equal(result.status, "FAILED");
  assert.equal(result.checks.designTokens.status, "FAILED");
  assert.equal(result.checks.designTokens.violations[0].kind, "hex");
  assert.equal(result.checks.designTokens.violations[0].file, "src/Button.css");
});

test("wave gate flags px spacing/radius and inline style, but not var() usage or 0/1px", () => {
  const root = project({
    "src/Card.css": ".card { padding: 16px; border-radius: 8px; margin: 0; border: 1px solid var(--accent); gap: var(--space-2); }\n",
    "src/Card.tsx": "export const Card = () => <div style={{ padding: 12 }} />;\n",
    "src/Fine.css": ".fine { margin: 0 auto; border: 1px solid var(--accent); gap: var(--space-2); }\n",
  });
  const result = gate(root, ["src/Card.css", "src/Card.tsx", "src/Fine.css"]);
  const kinds = result.checks.designTokens.violations.map((item) => `${item.file}:${item.kind}`);
  assert.deepEqual(kinds, ["src/Card.css:px", "src/Card.tsx:inline-style"]);
});

test("wave gate reports var(--x) references that no token file defines", () => {
  const root = project({ "src/Nav.css": ".nav { color: var(--accent); background: var(--surface-typo); }\n.x { --local: 1; width: var(--local); }\n" });
  const result = gate(root, ["src/Nav.css"]);
  assert.equal(result.status, "FAILED");
  assert.deepEqual(result.checks.designTokens.undefinedTokens.map((item) => item.token), ["--surface-typo"]);
});

test("wave gate PASSes tokenized files and records what it scanned", () => {
  const root = project({ "src/Ok.css": ".ok { color: var(--accent); padding: var(--space-2); border-radius: var(--radius-md); }\n" });
  const result = gate(root, ["src/Ok.css"]);
  assert.equal(result.status, "PASS");
  assert.equal(result.checks.designTokens.status, "PASS");
  assert.deepEqual(result.checks.designTokens.filesScanned, ["src/Ok.css"]);
});

test("wave gate never lints the design package itself (tokens.css, components.html, preview/, design-systems/)", () => {
  const root = project({
    "design-systems/x/resolved/components.html": "<style>.a{color:#fff;padding:12px}</style>\n",
    "design-systems/x/resolved/preview/app.html": "<style>.a{color:#fff}</style>\n",
  });
  const result = gate(root, ["design-systems/x/resolved/components.html", "design-systems/x/resolved/preview/app.html", "tokens.css"]);
  assert.equal(result.checks.designTokens.status, "PASS");
  assert.deepEqual(result.checks.designTokens.filesScanned, []);
});

test("wave gate lists changed files from git when none are given and skips honestly when it cannot", () => {
  const root = project({ "src/Bad.css": ".b { color: #123456 }\n" });
  const calls = [];
  const execFn = (cmd) => { calls.push(cmd); return cmd.startsWith("git diff") ? "src/Bad.css\n" : ""; };
  const ok = runWaveQualityGate({ rootDir: root, tokensCssPath: "tokens.css", execFn });
  assert.equal(ok.checks.designTokens.status, "FAILED");
  assert.ok(calls.some((cmd) => cmd.startsWith("git diff --name-only")));
  const failing = runWaveQualityGate({ rootDir: root, tokensCssPath: "tokens.css", execFn: () => { throw new Error("not a git repo"); } });
  assert.equal(failing.checks.designTokens.status, "SKIPPED");
  assert.equal(failing.checks.designTokens.reasonCode, "CHANGED_FILES_UNAVAILABLE");
});

test("without tokens.css the design check is an explicit SKIPPED, not a fixed PASS", () => {
  const result = checkDesignTokens({ rootDir: process.cwd(), tokensFile: null, changedFiles: [] });
  assert.equal(result.status, "SKIPPED");
  assert.equal(result.enabled, false);
});

test("lintCssForTokens keeps ignoring comments and token definitions", () => {
  assert.deepEqual(lintCssForTokens("/* #fff */\n--x: #123456;\n// padding: 20px\n"), []);
});
