import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

for (const name of ["orchestrator", "orquestrador"]) {
  test(`${name} is manual-only and cannot reintroduce Skill auto-invocation`, () => {
    const command = readFileSync(new URL(`../commands/${name}.md`, import.meta.url), "utf8");
    assert.match(command, /disable-model-invocation:\s*true/);
    assert.doesNotMatch(command, /\bSkill\s*\(/);
    const frontmatter = command.split("---")[1] ?? "";
    assert.doesNotMatch(frontmatter, /\bSkill\b/);
  });
}

test("the internal workflow skill is hidden and remains non-auto-invocable", () => {
  const skill = readFileSync(new URL("../skills/orchestrator-multi-agent-development/SKILL.md", import.meta.url), "utf8");
  const frontmatter = skill.split("---")[1] ?? "";
  assert.match(frontmatter, /disable-model-invocation:\s*true/);
  assert.match(frontmatter, /user-invocable:\s*false/);
});

