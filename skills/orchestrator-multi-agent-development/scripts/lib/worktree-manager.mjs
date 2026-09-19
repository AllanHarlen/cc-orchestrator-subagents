import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  inspectGit,
  loadRun,
  updateTaskWorkspace,
} from "./orchestration-state.mjs";

export class WorktreeError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "WorktreeError";
    this.code = code;
    this.details = details;
  }
}

function runGit(cwd, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
  });
  const output = String(result.stdout ?? "").trim();
  const error = String(result.stderr ?? "").trim();
  if (result.error || (result.status !== 0 && !options.allowFailure)) {
    throw new WorktreeError(
      options.code ?? "GIT_COMMAND_FAILED",
      error || result.error?.message || `git ${args[0]} exited ${result.status}`,
      { args, status: result.status, stdout: output, stderr: error },
    );
  }
  return { ok: result.status === 0, status: result.status, stdout: output, stderr: error };
}

function assertTaskId(value) {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,80}$/.test(id)) {
    throw new WorktreeError("INVALID_TASK_ID", `Unsafe task ID: ${value}`);
  }
  return id;
}

function normalizeScopePath(projectRoot, value) {
  const raw = String(value ?? "").trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!raw || isAbsolute(raw)) return null;
  const absolute = resolve(projectRoot, raw);
  const rel = relative(resolve(projectRoot), absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`)) return null;
  return rel.split(sep).join("/").replace(/\/+$/, "");
}

function taskScope(projectRoot, task) {
  return [...new Set([
    ...(task.allowedPaths ?? []),
    ...(task.expectedFiles ?? []),
  ].map((path) => normalizeScopePath(projectRoot, path)).filter(Boolean))].sort();
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function overlaps(left, right) {
  const shared = [];
  for (const leftPath of left) {
    for (const rightPath of right) {
      if (pathsOverlap(leftPath, rightPath)) shared.push([leftPath, rightPath]);
    }
  }
  return shared;
}

function waveTaskIds(state, wave) {
  return Object.values(state.tasks ?? {})
    .filter((task) => task.sourcePresent !== false && Number(task.wave) === Number(wave))
    .map((task) => task.id)
    .sort();
}

export function planTaskWorktrees(projectRoot, artifactDir, options = {}) {
  const root = resolve(projectRoot);
  const { state } = loadRun(artifactDir, { verifyReplay: true });
  const requested = options.taskIds?.length
    ? options.taskIds.map(assertTaskId)
    : waveTaskIds(state, options.wave ?? state.currentWave);
  const unknown = requested.filter((id) => !state.tasks[id]);
  if (unknown.length) {
    throw new WorktreeError("TASK_NOT_FOUND", `Unknown task(s): ${unknown.join(", ")}`);
  }
  const git = inspectGit(root);
  if (!git.available) {
    // Git ausente ou diretorio nao e um repositorio Git: degrada silenciosamente
    // para execucao serializada. Nenhum calculo de overlap de escopo faz
    // sentido sem Git, entao nem tenta.
    const tasks = requested.map((id) => ({
      taskId: id,
      wave: state.tasks[id].wave,
      scope: [],
      eligible: false,
      reason: "GIT_UNAVAILABLE",
    }));
    return {
      schemaVersion: 1,
      runId: state.runId,
      wave: options.wave ?? state.currentWave,
      tasks,
      shared: [],
      parallelEligible: [],
      serialize: tasks.map((task) => task.taskId),
    };
  }
  const scopes = Object.fromEntries(requested.map((id) => [id, taskScope(root, state.tasks[id])]));
  const shared = [];
  for (let leftIndex = 0; leftIndex < requested.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < requested.length; rightIndex += 1) {
      const left = requested[leftIndex];
      const right = requested[rightIndex];
      const overlap = overlaps(scopes[left], scopes[right]);
      if (overlap.length) shared.push({ left, right, paths: overlap });
    }
  }
  const conflicts = new Set(shared.flatMap((entry) => [entry.left, entry.right]));
  const tasks = requested.map((id) => {
    const scope = scopes[id];
    const reason = scope.length === 0
      ? "SCOPE_UNKNOWN"
      : conflicts.has(id)
        ? "SHARED_FILES"
        : "ISOLATED_SCOPE";
    return {
      taskId: id,
      wave: state.tasks[id].wave,
      scope,
      eligible: reason === "ISOLATED_SCOPE",
      reason,
    };
  });
  return {
    schemaVersion: 1,
    runId: state.runId,
    wave: options.wave ?? state.currentWave,
    tasks,
    shared,
    parallelEligible: tasks.filter((task) => task.eligible).map((task) => task.taskId),
    serialize: tasks.filter((task) => !task.eligible).map((task) => task.taskId),
  };
}

function parseWorktrees(output) {
  const records = [];
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) records.push(current);
      current = { path: line.slice(9) };
    } else if (current && line.startsWith("HEAD ")) current.head = line.slice(5);
    else if (current && line.startsWith("branch ")) current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (current && line === "bare") current.bare = true;
    else if (current && line === "detached") current.detached = true;
    else if (current && line.startsWith("prunable ")) current.prunable = line.slice(9);
  }
  if (current) records.push(current);
  return records;
}

function listGitWorktrees(projectRoot) {
  return parseWorktrees(runGit(projectRoot, ["worktree", "list", "--porcelain"]).stdout);
}

function safeWorktreeRoot(projectRoot) {
  return join(resolve(projectRoot), ".orchestrator", "worktrees");
}

function assertManagedPath(projectRoot, path) {
  const managed = safeWorktreeRoot(projectRoot);
  const absolute = resolve(path);
  const rel = relative(managed, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new WorktreeError(
      "UNMANAGED_WORKTREE_PATH",
      `Worktree path must be a child of ${managed}`,
    );
  }
  return absolute;
}

function branchName(state, taskId) {
  const run = String(state.runId).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 80);
  const task = taskId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return `orchestrator/${run}/${task}`;
}

function worktreePath(projectRoot, state, taskId) {
  return assertManagedPath(
    projectRoot,
    join(safeWorktreeRoot(projectRoot), String(state.runId), taskId),
  );
}

function taskWorktreeStatus(projectRoot, task) {
  const workspace = task.workspace;
  if (!workspace?.path) return { taskId: task.id, status: "UNPLANNED" };
  if (workspace.status === "CLEANED" && workspace.cleanupStatus === "CLEANED") {
    return {
      taskId: task.id,
      status: "CLEANED",
      path: workspace.path,
      integrationStatus: workspace.integrationStatus,
      cleanupStatus: "CLEANED",
    };
  }
  const path = assertManagedPath(projectRoot, workspace.path);
  const listed = listGitWorktrees(projectRoot)
    .find((entry) => resolve(entry.path).toLowerCase() === path.toLowerCase());
  if (!listed || !existsSync(path)) {
    return { taskId: task.id, status: "UNKNOWN", path, reason: "WORKTREE_MISSING" };
  }
  const head = runGit(path, ["rev-parse", "HEAD"]).stdout;
  const porcelain = runGit(path, ["status", "--porcelain=v1"]).stdout;
  return {
    taskId: task.id,
    status: workspace.status,
    path,
    branch: listed.branch ?? null,
    head,
    dirty: Boolean(porcelain),
    changedFiles: porcelain ? porcelain.split(/\r?\n/).filter(Boolean).length : 0,
    baseCommit: workspace.baseCommit ?? null,
    integrationStatus: workspace.integrationStatus ?? "PENDING",
    cleanupStatus: workspace.cleanupStatus ?? "PENDING",
  };
}

export function createTaskWorktree(projectRoot, artifactDir, taskIdValue, options = {}) {
  const root = resolve(projectRoot);
  const taskId = assertTaskId(taskIdValue);
  const { state } = loadRun(artifactDir, { verifyReplay: true });
  const task = state.tasks?.[taskId];
  if (!task) throw new WorktreeError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
  if (!options.force) {
    const plan = planTaskWorktrees(root, artifactDir, { wave: task.wave });
    const item = plan.tasks.find((entry) => entry.taskId === taskId);
    if (!item?.eligible) {
      throw new WorktreeError(
        "WORKTREE_NOT_ELIGIBLE",
        `Task ${taskId} cannot be isolated safely: ${item?.reason ?? "UNKNOWN"}`,
        { plan },
      );
    }
  }
  const git = inspectGit(root);
  if (!git.available || !git.head) {
    throw new WorktreeError("GIT_UNAVAILABLE", "A Git repository with a valid HEAD is required");
  }
  const path = worktreePath(root, state, taskId);
  const branch = branchName(state, taskId);
  const baseCommit = options.baseCommit ?? task.workspace?.baseCommit ?? git.head;
  updateTaskWorkspace(artifactDir, taskId, {
    status: "PLANNED",
    id: `workspace-${state.runId}-${taskId}`,
    path,
    branch,
    baseCommit,
    integrationStatus: "PENDING",
    cleanupStatus: "PENDING",
  }, { projectRoot: root, actor: options.actor ?? "worktree-manager" });

  mkdirSync(resolve(path, ".."), { recursive: true });
  const existing = listGitWorktrees(root).find((entry) =>
    resolve(entry.path).toLowerCase() === path.toLowerCase() || entry.branch === branch,
  );
  if (!existing) {
    runGit(root, ["worktree", "add", "-b", branch, path, baseCommit], {
      code: "WORKTREE_CREATE_FAILED",
    });
  } else if (resolve(existing.path).toLowerCase() !== path.toLowerCase()) {
    updateTaskWorkspace(artifactDir, taskId, {
      status: "BLOCKED",
      path,
      branch,
      baseCommit,
      integrationStatus: "BLOCKED",
      errorCode: "BRANCH_ALREADY_ATTACHED",
      attachedPath: existing.path,
    }, { projectRoot: root, actor: options.actor ?? "worktree-manager" });
    throw new WorktreeError(
      "BRANCH_ALREADY_ATTACHED",
      `Branch ${branch} is already attached to ${existing.path}`,
    );
  }
  const head = runGit(path, ["rev-parse", "HEAD"]).stdout;
  const updated = updateTaskWorkspace(artifactDir, taskId, {
    status: "CREATED",
    path,
    branch,
    baseCommit,
    head,
    integrationStatus: "PENDING",
    cleanupStatus: "PENDING",
  }, { projectRoot: root, actor: options.actor ?? "worktree-manager" });
  return { taskId, workspace: updated.workspace, recoveredExisting: Boolean(existing) };
}

export function worktreeStatus(projectRoot, artifactDir, options = {}) {
  const root = resolve(projectRoot);
  const { state } = loadRun(artifactDir, { verifyReplay: true });
  const taskIds = options.taskIds?.length ? options.taskIds.map(assertTaskId) : Object.keys(state.tasks ?? {});
  return {
    runId: state.runId,
    worktrees: taskIds.map((id) => {
      if (!state.tasks[id]) throw new WorktreeError("TASK_NOT_FOUND", `Task not found: ${id}`);
      return taskWorktreeStatus(root, state.tasks[id]);
    }),
  };
}

export function markTaskWorktreeReady(projectRoot, artifactDir, taskIdValue, options = {}) {
  const root = resolve(projectRoot);
  const taskId = assertTaskId(taskIdValue);
  const { state } = loadRun(artifactDir, { verifyReplay: true });
  const task = state.tasks?.[taskId];
  if (!task) throw new WorktreeError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
  const status = taskWorktreeStatus(root, task);
  if (status.status === "UNKNOWN" || status.status === "UNPLANNED") {
    throw new WorktreeError("WORKTREE_NOT_FOUND", `No recoverable worktree exists for ${taskId}`);
  }
  if (status.dirty) {
    throw new WorktreeError(
      "WORKTREE_DIRTY",
      `Task ${taskId} must commit its changes before integration`,
      status,
    );
  }
  if (!options.allowEmpty && status.head === status.baseCommit) {
    throw new WorktreeError("WORKTREE_EMPTY", `Task ${taskId} has no commit after its base`);
  }
  const updated = updateTaskWorkspace(artifactDir, taskId, {
    ...task.workspace,
    status: "READY",
    head: status.head,
    integrationStatus: "READY",
  }, { projectRoot: root, actor: options.actor ?? "worktree-manager" });
  return { taskId, workspace: updated.workspace };
}

function currentBranch(projectRoot) {
  return runGit(projectRoot, ["branch", "--show-current"]).stdout;
}

export function integrateTaskWorktree(projectRoot, artifactDir, taskIdValue, options = {}) {
  const root = resolve(projectRoot);
  const taskId = assertTaskId(taskIdValue);
  let { state } = loadRun(artifactDir, { verifyReplay: true });
  let task = state.tasks?.[taskId];
  if (!task?.workspace) throw new WorktreeError("WORKTREE_NOT_FOUND", `No worktree for ${taskId}`);
  const status = taskWorktreeStatus(root, task);
  if (status.dirty) throw new WorktreeError("WORKTREE_DIRTY", `Task worktree ${taskId} is dirty`, status);
  if (!new Set(["READY", "INTEGRATING", "CONFLICT", "MERGED"]).has(task.workspace.status)) {
    throw new WorktreeError(
      "WORKTREE_NOT_READY",
      `Task ${taskId} must be marked READY before integration`,
    );
  }
  const rootGit = inspectGit(root);
  const productiveDirtyFiles = (rootGit.changedFiles ?? []).filter((path) =>
    !path.replaceAll("\\", "/").startsWith(".orchestration/") &&
    !path.replaceAll("\\", "/").startsWith(".orchestrator/"),
  );
  if (productiveDirtyFiles.length > 0) {
    throw new WorktreeError(
      "INTEGRATION_ROOT_DIRTY",
      "Integration requires a clean primary working tree",
      { changedFiles: productiveDirtyFiles },
    );
  }
  const expectedBranch = options.integrationBranch ?? state.git?.branch;
  const branch = currentBranch(root);
  if (expectedBranch && branch !== expectedBranch) {
    throw new WorktreeError(
      "INTEGRATION_BRANCH_MISMATCH",
      `Expected integration branch ${expectedBranch}, found ${branch}`,
    );
  }
  const taskHead = status.head;
  const alreadyMerged = runGit(root, ["merge-base", "--is-ancestor", taskHead, "HEAD"], {
    allowFailure: true,
  }).ok;
  if (alreadyMerged) {
    const integrationHead = runGit(root, ["rev-parse", "HEAD"]).stdout;
    const updated = updateTaskWorkspace(artifactDir, taskId, {
      ...task.workspace,
      status: "MERGED",
      head: taskHead,
      integrationStatus: "MERGED",
      integrationHead,
      conflicts: [],
    }, { projectRoot: root, actor: options.actor ?? "worktree-manager" });
    return { taskId, alreadyMerged: true, workspace: updated.workspace };
  }
  updateTaskWorkspace(artifactDir, taskId, {
    ...task.workspace,
    status: "INTEGRATING",
    head: taskHead,
    integrationStatus: "INTEGRATING",
    integrationBase: rootGit.head,
  }, { projectRoot: root, actor: options.actor ?? "worktree-manager" });
  const merge = runGit(root, [
    "merge",
    "--no-ff",
    task.workspace.branch,
    "-m",
    `Integrate ${state.runId}/${taskId}`,
  ], { allowFailure: true });
  if (!merge.ok) {
    const conflicts = runGit(root, ["diff", "--name-only", "--diff-filter=U"], {
      allowFailure: true,
    }).stdout.split(/\r?\n/).filter(Boolean);
    const updated = updateTaskWorkspace(artifactDir, taskId, {
      ...task.workspace,
      status: "CONFLICT",
      head: taskHead,
      integrationStatus: "CONFLICT",
      conflicts,
      mergeError: merge.stderr,
    }, { projectRoot: root, actor: options.actor ?? "worktree-manager" });
    return { taskId, merged: false, conflicts, workspace: updated.workspace };
  }
  const integrationHead = runGit(root, ["rev-parse", "HEAD"]).stdout;
  const updated = updateTaskWorkspace(artifactDir, taskId, {
    ...task.workspace,
    status: "MERGED",
    head: taskHead,
    integrationStatus: "MERGED",
    integrationHead,
    conflicts: [],
  }, { projectRoot: root, actor: options.actor ?? "worktree-manager" });
  return { taskId, merged: true, workspace: updated.workspace };
}

export function cleanupTaskWorktree(projectRoot, artifactDir, taskIdValue, options = {}) {
  const root = resolve(projectRoot);
  const taskId = assertTaskId(taskIdValue);
  const { state } = loadRun(artifactDir, { verifyReplay: true });
  const task = state.tasks?.[taskId];
  if (!task?.workspace?.path) throw new WorktreeError("WORKTREE_NOT_FOUND", `No worktree for ${taskId}`);
  if (!options.force && task.workspace.integrationStatus !== "MERGED") {
    throw new WorktreeError(
      "WORKTREE_NOT_MERGED",
      `Refusing to clean ${taskId} before successful integration`,
    );
  }
  const path = assertManagedPath(root, task.workspace.path);
  updateTaskWorkspace(artifactDir, taskId, {
    ...task.workspace,
    status: task.workspace.status,
    cleanupStatus: "RUNNING",
  }, { projectRoot: root, actor: options.actor ?? "worktree-manager" });
  const listed = listGitWorktrees(root).find((entry) =>
    resolve(entry.path).toLowerCase() === path.toLowerCase(),
  );
  if (listed) {
    const args = ["worktree", "remove"];
    if (options.force) args.push("--force");
    args.push(path);
    runGit(root, args, { code: "WORKTREE_REMOVE_FAILED" });
  }
  runGit(root, ["worktree", "prune"]);
  if (task.workspace.branch && !options.keepBranch) {
    runGit(root, ["branch", options.force ? "-D" : "-d", task.workspace.branch], {
      code: "WORKTREE_BRANCH_DELETE_FAILED",
    });
  }
  const updated = updateTaskWorkspace(artifactDir, taskId, {
    ...task.workspace,
    status: "CLEANED",
    cleanupStatus: "CLEANED",
    cleanedAt: options.now ?? new Date().toISOString(),
  }, { projectRoot: root, actor: options.actor ?? "worktree-manager" });
  return { taskId, workspace: updated.workspace };
}

export function recoverTaskWorktrees(projectRoot, artifactDir, options = {}) {
  const root = resolve(projectRoot);
  let { state } = loadRun(artifactDir, { verifyReplay: true });
  const recovered = [];
  for (const task of Object.values(state.tasks ?? {}).filter((item) => item.workspace)) {
    if (task.workspace.status === "CLEANED" && task.workspace.cleanupStatus === "CLEANED") {
      recovered.push({ taskId: task.id, observed: { status: "CLEANED" }, workspace: task.workspace });
      continue;
    }
    const observed = taskWorktreeStatus(root, task);
    let next = { ...task.workspace };
    if (observed.status === "UNKNOWN") {
      next = { ...next, status: "UNKNOWN", observedReason: observed.reason };
    } else if (observed.status !== "UNPLANNED") {
      const rootHead = runGit(root, ["rev-parse", "HEAD"]).stdout;
      const merged = observed.head !== next.baseCommit && runGit(root, ["merge-base", "--is-ancestor", observed.head, rootHead], {
        allowFailure: true,
      }).ok;
      next = {
        ...next,
        status: merged ? "MERGED" : next.status === "PLANNED" ? "CREATED" : next.status,
        head: observed.head,
        integrationStatus: merged ? "MERGED" : next.integrationStatus,
        integrationHead: merged ? rootHead : next.integrationHead,
        dirty: observed.dirty,
      };
    }
    const updated = updateTaskWorkspace(artifactDir, task.id, next, {
      projectRoot: root,
      actor: options.actor ?? "worktree-recovery",
    });
    recovered.push({ taskId: task.id, observed, workspace: updated.workspace });
    state = updated.state;
  }
  return { runId: state.runId, recovered };
}
