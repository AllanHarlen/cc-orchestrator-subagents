import assert from "node:assert/strict";
import test from "node:test";

import { renameWithRetry } from "../skills/orchestrator-multi-agent-development/scripts/lib/fs-retry.mjs";

function failing(code, times) {
  let calls = 0;
  const rename = () => {
    calls += 1;
    if (calls <= times) throw Object.assign(new Error(`${code}: simulated`), { code });
  };
  return { rename, calls: () => calls };
}

const noSleep = { sleep: () => {} };

test("renameWithRetry recovers from a transient EPERM (the Windows lock flake)", () => {
  for (const code of ["EPERM", "EBUSY", "EACCES"]) {
    const probe = failing(code, 3);
    const used = renameWithRetry("a", "b", { ...noSleep, rename: probe.rename });
    assert.equal(used, 4, code);
    assert.equal(probe.calls(), 4, code);
  }
});

test("renameWithRetry gives up after the attempt budget and rethrows the original error", () => {
  const probe = failing("EPERM", 100);
  assert.throws(
    () => renameWithRetry("a", "b", { ...noSleep, rename: probe.rename, attempts: 5 }),
    (error) => error.code === "EPERM",
  );
  assert.equal(probe.calls(), 5);
});

test("renameWithRetry does not retry non-transient errors", () => {
  const probe = failing("ENOENT", 100);
  assert.throws(
    () => renameWithRetry("a", "b", { ...noSleep, rename: probe.rename }),
    (error) => error.code === "ENOENT",
  );
  assert.equal(probe.calls(), 1);
});

test("renameWithRetry backs off with a capped delay", () => {
  const delays = [];
  const probe = failing("EPERM", 20);
  assert.throws(() =>
    renameWithRetry("a", "b", {
      rename: probe.rename,
      sleep: (ms) => delays.push(ms),
      attempts: 15,
      baseMs: 10,
    }),
  );
  assert.equal(delays.length, 14);
  assert.equal(delays[0], 10);
  assert.ok(delays.every((ms) => ms <= 100));
});
