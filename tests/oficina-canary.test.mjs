import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const scenario = JSON.parse(readFileSync(new URL("./fixtures/oficina-canary/scenario.json", import.meta.url), "utf8"));

test("OficinaAI canary covers the complete resolved-design delivery surface", () => {
  assert.equal(scenario.openDesignInput, "incomplete");
  assert.equal(scenario.expectedPensadorOutcome, "RESOLVED_PASS");
  assert.equal(scenario.handoffIngestion, "automatic");
  assert.deepEqual(new Set(scenario.routes.map((item) => item.surface)), new Set([
    "home", "services", "parts", "institutional", "admin-login", "dashboard",
  ]));
  assert.deepEqual(new Set(scenario.viewports), new Set(["desktop", "mobile"]));
  assert.deepEqual(new Set(scenario.states), new Set(["empty", "error", "loading", "success"]));
  assert.ok(scenario.journeys.includes("admin-refresh"));
  assert.ok(scenario.journeys.includes("protected-deep-link"));
  assert.equal(scenario.requiredAssertions.brokenImages, 0);
  assert.equal(scenario.requiredAssertions.undefinedTokens, 0);
  assert.equal(scenario.requiredAssertions.emojiIcons, 0);
  assert.equal(scenario.requiredAssertions.silentMockFallback, false);
  assert.equal(scenario.requiredAssertions.realApiEvidence, true);
  assert.equal(scenario.requiredAssertions.doneOnlyAfterAllGates, true);
});
