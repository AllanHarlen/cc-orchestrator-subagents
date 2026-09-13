import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("../skills/orchestrator-multi-agent-development/scripts/check-prompt-budget.mjs", import.meta.url),
);

function run(args, input) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    windowsHide: true,
    input,
    maxBuffer: 2 * 1024 * 1024,
  });
}

test("check-prompt-budget --agent agy approves a prompt under the limit", () => {
  const result = run(["--agent", "agy", "--stdin"], "a".repeat(100));
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.agent, "agy");
  assert.equal(parsed.chars, 100);
  assert.equal(parsed.advisory, true);
  assert.equal(parsed.suggestedSplits, 1);
});

test("check-prompt-budget --agent agy never fails on an over-limit prompt (advisory since bridge 4.4.0 stdin transport, exit 0)", () => {
  const result = run(["--agent", "agy", "--stdin"], "a".repeat(24_001));
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.agent, "agy");
  assert.equal(parsed.advisory, true);
  assert.equal(parsed.ok, false, "ok still reports whether the prompt is within the indicative budget");
  assert.equal(parsed.overBy, 1);
  assert.equal(parsed.suggestedSplits, 2);
});

test("check-prompt-budget --agent codex never fails on an over-limit prompt (advisory, exit 0)", () => {
  const result = run(["--agent", "codex", "--stdin"], "a".repeat(24_001));
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.agent, "codex");
  assert.equal(parsed.advisory, true);
  assert.equal(parsed.ok, false, "ok still reports whether the prompt is within budget");
  assert.equal(parsed.overBy, 1);
  assert.equal(parsed.suggestedSplits, 2);
});

test("check-prompt-budget --agent codex approves a prompt under the limit", () => {
  const result = run(["--agent", "codex", "--stdin"], "a".repeat(100));
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.advisory, true);
});

test("check-prompt-budget rejects an unsupported --agent value", () => {
  const result = run(["--agent", "bogus", "--stdin"], "short");
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout || result.stderr);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "UNSUPPORTED_AGENT");
});

test("check-prompt-budget requires --agent", () => {
  const result = run(["--stdin"], "short");
  assert.equal(result.status, 2, "MISSING_ARGUMENT maps to exit 2 in this skill's cli-utils contract");
  const parsed = JSON.parse(result.stdout || result.stderr);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "MISSING_ARGUMENT");
});

test("check-prompt-budget reads from --file when --stdin is not passed", () => {
  const path = join(process.cwd(), ".tmp-check-prompt-budget-file.txt");
  spawnSync(process.execPath, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(path)}, "x".repeat(50))`]);
  try {
    const result = run(["--agent", "agy", "--file", path]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.chars, 50);
  } finally {
    spawnSync(process.execPath, ["-e", `require("node:fs").rmSync(${JSON.stringify(path)}, { force: true })`]);
  }
});
