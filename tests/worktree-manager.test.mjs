import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  initRun,
  loadRun,
  updateTaskWorkspace,
} from "../skills/orchestrator-multi-agent-development/scripts/lib/orchestration-state.mjs";
import {
  cleanupTaskWorktree,
  createTaskWorktree,
  integrateTaskWorktree,
  markTaskWorktreeReady,
  planTaskWorktrees,
  recoverTaskWorktrees,
  worktreeStatus,
} from "../skills/orchestrator-multi-agent-development/scripts/lib/worktree-manager.mjs";

const roots = [];

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(" ")} failed`);
  return String(result.stdout).trim();
}

function fixture(options = {}) {
  const root = mkdtempSync(join(process.cwd(), ".tmp-worktree-test-"));
  roots.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "orchestrator-tests@example.invalid");
  git(root, "config", "user.name", "Orchestrator Tests");
  writeFileSync(join(root, "README.md"), "base\n", "utf8");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "base");
  const artifactDir = join(root, ".orchestration", "worktree-run");
  mkdirSync(artifactDir, { recursive: true });
  const shared = options.shared === true;
  writeFileSync(join(artifactDir, "tasks-classification.md"), [
    "# Tasks",
    "",
    "## BE-01 - Backend A",
    "- category: BACKEND_ONLY",
    "- assignedAgent: codex",
    `- allowedPaths: \`${shared ? "src/shared" : "src/a.txt"}\``,
    `- expectedFiles: \`${shared ? "src/shared/a.txt" : "src/a.txt"}\``,
    "- validationPlan: `verify-a`",
    "",
    "## BE-02 - Backend B",
    "- category: BACKEND_ONLY",
    "- assignedAgent: codex",
    `- allowedPaths: \`${shared ? "src/shared" : "src/b.txt"}\``,
    `- expectedFiles: \`${shared ? "src/shared/b.txt" : "src/b.txt"}\``,
    "- validationPlan: `verify-b`",
  ].join("\n"), "utf8");
  writeFileSync(join(artifactDir, "waves.md"), "# Waves\n\n## Wave 1\n- BE-01\n- BE-02\n", "utf8");
  initRun({ projectRoot: root, artifactDir, slug: "worktree-run", runId: "worktree-run-001" });
  return { root, artifactDir };
}

function fixtureNoGit(options = {}) {
  // Fora da arvore do repositorio (cc-orchestrador-subagents e, ele mesmo, um
  // repositorio Git): um diretorio dentro de `process.cwd()` sem `.git`
  // proprio ainda resolveria o Git do repo pai via `git rev-parse
  // --show-toplevel`, o que mascararia o cenario que este teste cobre.
  const root = mkdtempSync(join(tmpdir(), "orchestrator-worktree-nogit-"));
  roots.push(root);
  const artifactDir = join(root, ".orchestration", "worktree-run");
  mkdirSync(artifactDir, { recursive: true });
  const shared = options.shared === true;
  writeFileSync(join(artifactDir, "tasks-classification.md"), [
    "# Tasks",
    "",
    "## BE-01 - Backend A",
    "- category: BACKEND_ONLY",
    "- assignedAgent: codex",
    `- allowedPaths: \`${shared ? "src/shared" : "src/a.txt"}\``,
    `- expectedFiles: \`${shared ? "src/shared/a.txt" : "src/a.txt"}\``,
    "- validationPlan: `verify-a`",
    "",
    "## BE-02 - Backend B",
    "- category: BACKEND_ONLY",
    "- assignedAgent: codex",
    `- allowedPaths: \`${shared ? "src/shared" : "src/b.txt"}\``,
    `- expectedFiles: \`${shared ? "src/shared/b.txt" : "src/b.txt"}\``,
    "- validationPlan: `verify-b`",
  ].join("\n"), "utf8");
  writeFileSync(join(artifactDir, "waves.md"), "# Waves\n\n## Wave 1\n- BE-01\n- BE-02\n", "utf8");
  // Sem `git init`: `root` nao e um repositorio Git, entao `initRun` grava
  // `state.git.available: false` e o planner precisa degradar sem lancar.
  initRun({ projectRoot: root, artifactDir, slug: "worktree-run", runId: "worktree-run-001" });
  return { root, artifactDir };
}

test.afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

test("worktree planner degrades to serialized execution when Git is unavailable", () => {
  const { root, artifactDir } = fixtureNoGit();
  const plan = planTaskWorktrees(root, artifactDir, { wave: 1 });
  assert.deepEqual(plan.parallelEligible, []);
  assert.deepEqual(plan.serialize, ["BE-01", "BE-02"]);
  assert.equal(plan.shared.length, 0);
  for (const task of plan.tasks) {
    assert.equal(task.eligible, false);
    assert.equal(task.reason, "GIT_UNAVAILABLE");
  }
});

test("worktree planner isolates disjoint scopes and serializes shared scopes", () => {
  const isolated = fixture();
  const plan = planTaskWorktrees(isolated.root, isolated.artifactDir, { wave: 1 });
  assert.deepEqual(plan.parallelEligible, ["BE-01", "BE-02"]);
  assert.equal(plan.shared.length, 0);

  const shared = fixture({ shared: true });
  const blocked = planTaskWorktrees(shared.root, shared.artifactDir, { wave: 1 });
  assert.deepEqual(blocked.parallelEligible, []);
  assert.deepEqual(blocked.serialize, ["BE-01", "BE-02"]);
  assert.equal(blocked.shared.length, 1);
});

test("a task worktree is created, recovered, committed, integrated and safely cleaned", () => {
  const { root, artifactDir } = fixture();
  const created = createTaskWorktree(root, artifactDir, "BE-01");
  assert.equal(created.workspace.status, "CREATED");
  assert.equal(existsSync(created.workspace.path), true);

  updateTaskWorkspace(artifactDir, "BE-01", {
    ...created.workspace,
    status: "PLANNED",
  }, { projectRoot: root });
  const recovered = recoverTaskWorktrees(root, artifactDir);
  assert.equal(recovered.recovered[0].workspace.status, "CREATED");

  mkdirSync(join(created.workspace.path, "src"), { recursive: true });
  writeFileSync(join(created.workspace.path, "src", "a.txt"), "task output\n", "utf8");
  git(created.workspace.path, "add", "src/a.txt");
  git(created.workspace.path, "commit", "-m", "implement BE-01");
  const ready = markTaskWorktreeReady(root, artifactDir, "BE-01");
  assert.equal(ready.workspace.status, "READY");

  const integrated = integrateTaskWorktree(root, artifactDir, "BE-01");
  assert.equal(integrated.merged, true);
  assert.equal(existsSync(join(root, "src", "a.txt")), true);
  assert.equal(loadRun(artifactDir).state.tasks["BE-01"].workspace.integrationStatus, "MERGED");

  const cleaned = cleanupTaskWorktree(root, artifactDir, "BE-01");
  assert.equal(cleaned.workspace.status, "CLEANED");
  assert.equal(existsSync(created.workspace.path), false);
  assert.equal(worktreeStatus(root, artifactDir, { taskIds: ["BE-01"] }).worktrees[0].status, "CLEANED");
});
