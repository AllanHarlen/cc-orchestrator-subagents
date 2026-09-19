import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, relative, sep, join, resolve } from "node:path";
import { renameWithRetry } from "./fs-retry.mjs";

import { artifactWritePath, resolveArtifact } from "./artifact-layout.mjs";
import {
  findDurableRunEvent,
  openKnowledgeStore,
  projectKnowledgePaths,
} from "./project-knowledge.mjs";
import {
  loadRun,
  updateCompletionGate,
  updatePhase,
} from "./orchestration-state.mjs";
import { plainRow, plainRows, sha256, stableJson, withTransaction } from "./sqlite-store.mjs";

const OPERATIONAL_RECIPES = new Map([
  ["NU1301", {
    confidence: 0.98,
    problem: "Dependency restore is blocked by the executor network sandbox",
    rule: "Do not spend retries on an unchanged network sandbox; classify the task as BLOCKED and request dependency restoration outside the sandbox.",
    action: { retries: 0, classify: "BLOCKED", requireUserAction: true },
  }],
  ["QUOTA_EXHAUSTED", {
    confidence: 0.99,
    problem: "Codex quota is exhausted",
    rule: "Do not retry until quota state changes; preserve partial work and classify as BLOCKED.",
    action: { retries: 0, classify: "BLOCKED" },
  }],
  ["QUOTA_EXAUSTED", {
    confidence: 0.99,
    problem: "AGY quota is exhausted",
    rule: "Preserve the raw AGY quota status and use only the documented safe fallback.",
    action: { retries: 0, classify: "BLOCKED", preserveRawStatus: true },
  }],
  ["AUTH_REQUIRED", {
    confidence: 0.99,
    problem: "Executor authentication requires interactive user action",
    rule: "Classify as BLOCKED and request one interactive authentication before retrying.",
    action: { retries: 0, classify: "BLOCKED", requireUserAction: true },
  }],
  ["AGY_MISSING", {
    confidence: 0.99,
    problem: "The AGY executable is unavailable",
    rule: "Classify as BLOCKED and provide installation remediation; do not silently reroute implementation.",
    action: { retries: 0, classify: "BLOCKED", requireUserAction: true },
  }],
  ["TIMEOUT", {
    confidence: 0.9,
    problem: "Executor timed out",
    rule: "Inspect activity and partial output before deciding whether to split, extend, or retry the task.",
    action: { reconcile: true, inspectActivity: true, automaticRetry: false },
  }],
]);

const REVIEW_PATTERNS = [
  {
    id: "cors-cross-origin",
    pattern: /\bCORS\b|cross[- ]origin/i,
    problem: "Build-level checks did not prove cross-origin browser integration",
    rule: "Require real-browser E2E and verify preflight/network behavior when front-end and API use separate origins.",
    trigger: { frontendBackendSeparateOrigins: true },
    action: { requirePlaywrightE2E: true },
    confidence: 0.95,
  },
  {
    id: "tenant-host-resolution",
    pattern: /tenant.+host|host.+tenant|tenant_required/i,
    problem: "Tenant resolution differs between synthetic requests and the browser origin",
    rule: "Verify tenant/host resolution from the real browser origin rather than relying on a manually supplied Host header.",
    trigger: { multiTenantHostResolution: true },
    action: { requireBrowserHostValidation: true },
    confidence: 0.95,
  },
  {
    id: "api-casing",
    pattern: /casing|camelCase|PascalCase|whatsAppRedirectUrl|whatsappRedirectUrl/i,
    problem: "Wire-format field casing can diverge between API serialization and TypeScript consumers",
    rule: "Run deterministic API/UI field comparison and validate a real payload before approval.",
    trigger: { apiUiContract: true },
    action: { requireWireFormatValidation: true },
    confidence: 0.94,
  },
];

export class LearningError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "LearningError";
    this.code = code;
    this.details = details;
  }
}

function assertRecipeId(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,100}$/.test(normalized)) {
    throw new LearningError(
      "INVALID_RECIPE_ID",
      "Recipe IDs must contain only lowercase letters, numbers, dots, underscores, or hyphens",
    );
  }
  return normalized;
}

function atomicWrite(path, content) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, "utf8");
  renameWithRetry(temporary, path);
}

function insideProject(projectRoot, source) {
  const absolute = resolve(projectRoot, source);
  const rel = relative(resolve(projectRoot), absolute);
  return {
    absolute,
    inside: rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`)),
  };
}

function lessonId(sourceRun, key, value) {
  return `lesson-${sourceRun}-${sha256(`${key}\0${stableJson(value)}`).slice(0, 16)}`;
}

function evidenceForTask(events, taskId) {
  return events
    .filter((event) =>
      event.payload?.taskId === taskId || event.payload?.task?.id === taskId,
    )
    .map((event) => `event:${event.eventId}`)
    .slice(-5);
}

function artifactEvidence(directory, fileName) {
  const resolved = resolveArtifact(directory, fileName);
  if (!resolved) return null;
  return `file:${resolved.relativePath}:sha256:${sha256(readFileSync(resolved.path)).slice(0, 20)}`;
}

export function analyzeRunLearning(artifactDir) {
  const directory = resolve(artifactDir);
  const loaded = loadRun(directory, { verifyReplay: true });
  const { state, events } = loaded;
  const candidates = [];
  for (const task of Object.values(state.tasks ?? {})) {
    const recipe = OPERATIONAL_RECIPES.get(task.reasonCode);
    if (recipe) {
      const trigger = { error: task.reasonCode, executor: task.executor ?? "unknown" };
      candidates.push({
        id: lessonId(state.runId, `operational:${task.id}`, trigger),
        sourceRun: state.runId,
        status: "CANDIDATE",
        confidence: recipe.confidence,
        reusePotential: "high",
        trigger,
        problem: recipe.problem,
        rule: recipe.rule,
        action: recipe.action,
        evidence: evidenceForTask(events, task.id),
      });
    }
    if (task.status === "DONE" && Number(task.attempt ?? 0) > 1) {
      const trigger = {
        taskType: task.category ?? "unknown",
        complexity: task.complexity ?? "unknown",
        executor: task.executor ?? "unknown",
      };
      candidates.push({
        id: lessonId(state.runId, `retry-success:${task.id}`, trigger),
        sourceRun: state.runId,
        status: "CANDIDATE",
        confidence: 0.85,
        reusePotential: "medium",
        trigger,
        problem: `The first ${Number(task.attempt) - 1} attempt(s) did not complete successfully`,
        rule: "Use the successful retry evidence to refine task splitting or model routing; do not generalize until repeated.",
        action: { observeForAdaptiveRouting: true, successfulAttempt: Number(task.attempt) },
        evidence: evidenceForTask(events, task.id),
      });
    }
  }

  for (const fileName of [
    "review-final.md",
    "review-frontend.md",
    "browser-e2e-report.md",
    "e2e-report.md",
    "e2e-verification.md",
  ]) {
    const path = join(directory, fileName);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8");
    for (const pattern of REVIEW_PATTERNS.filter((entry) => entry.pattern.test(content))) {
      candidates.push({
        id: lessonId(state.runId, `${pattern.id}:${fileName}`, pattern.trigger),
        sourceRun: state.runId,
        status: "CANDIDATE",
        confidence: pattern.confidence,
        reusePotential: "high",
        trigger: pattern.trigger,
        problem: pattern.problem,
        rule: pattern.rule,
        action: pattern.action,
        evidence: [artifactEvidence(directory, fileName)].filter(Boolean),
      });
    }
  }
  const unique = [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()];
  return { state, events, candidates: unique };
}

function upsertLessons(projectRoot, candidates, now = new Date().toISOString()) {
  const { db } = openKnowledgeStore(projectRoot);
  try {
    return withTransaction(db, () => {
      for (const candidate of candidates) {
        db.prepare(`
          INSERT INTO lessons(
            id, source_run, status, confidence, reuse_potential, trigger_json,
            problem, rule_text, evidence_json, created_at, updated_at, action_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            confidence=excluded.confidence,
            reuse_potential=excluded.reuse_potential,
            trigger_json=excluded.trigger_json,
            problem=excluded.problem,
            rule_text=excluded.rule_text,
            evidence_json=excluded.evidence_json,
            action_json=excluded.action_json,
            updated_at=excluded.updated_at
        `).run(
          candidate.id,
          candidate.sourceRun,
          candidate.status,
          candidate.confidence,
          candidate.reusePotential,
          stableJson(candidate.trigger),
          candidate.problem,
          candidate.rule,
          stableJson(candidate.evidence),
          now,
          now,
          stableJson(candidate.action ?? {}),
        );
      }
      return candidates.length;
    });
  } finally {
    db.close();
  }
}

function renderLearningReport(state, candidates) {
  const lines = [
    `# Learning Report — ${state.runId}`,
    "",
    "> Deterministic Phase 12 output. Candidates do not modify SKILL.md and are not active recipes until independently validated.",
    "",
    "## Summary",
    "",
    `- candidates: ${candidates.length}`,
    `- high reuse potential: ${candidates.filter((item) => item.reusePotential === "high").length}`,
    `- automatically promoted: 0`,
    "",
  ];
  if (candidates.length === 0) {
    lines.push("_No reusable lesson candidate was supported by this run's durable evidence._", "");
  }
  for (const candidate of candidates) {
    lines.push(`## ${candidate.id}`, "");
    lines.push(`- status: ${candidate.status}`);
    lines.push(`- confidence: ${candidate.confidence}`);
    lines.push(`- reuse potential: ${candidate.reusePotential}`);
    lines.push(`- trigger: \`${stableJson(candidate.trigger)}\``);
    lines.push(`- problem: ${candidate.problem}`);
    lines.push(`- rule: ${candidate.rule}`);
    lines.push(`- action: \`${stableJson(candidate.action)}\``);
    lines.push(`- evidence: ${candidate.evidence.length ? candidate.evidence.map((item) => `\`${item}\``).join(", ") : "none"}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function runLearningPhase(projectRoot, artifactDir, options = {}) {
  const root = resolve(projectRoot);
  const directory = resolve(artifactDir);
  updatePhase(directory, 12, "RUNNING", {
    projectRoot: root,
    actor: "learning-engine",
    reason: "Analyze durable run outcomes",
  });
  const analysis = analyzeRunLearning(directory);
  const now = options.now ?? new Date().toISOString();
  const persisted = upsertLessons(root, analysis.candidates, now);
  const report = artifactWritePath(directory, "learning-report.md", analysis.state.layoutVersion);
  const reportPath = report.path;
  mkdirSync(dirname(reportPath), { recursive: true });
  atomicWrite(reportPath, renderLearningReport(analysis.state, analysis.candidates));
  const reportEvidence = `file:${report.relativePath}:sha256:${sha256(readFileSync(reportPath)).slice(0, 20)}`;
  updateCompletionGate(directory, "learning", "DONE", {
    projectRoot: root,
    actor: "learning-engine",
    evidence: reportEvidence,
  });
  const phase = updatePhase(directory, 12, "DONE", {
    projectRoot: root,
    actor: "learning-engine",
    evidence: reportEvidence,
  });
  return {
    runId: analysis.state.runId,
    reportPath,
    candidates: analysis.candidates,
    persisted,
    phase: phase.state.phaseStatus,
  };
}

function shapeLesson(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceRun: row.source_run,
    status: row.status,
    confidence: Number(row.confidence),
    reusePotential: row.reuse_potential,
    trigger: JSON.parse(row.trigger_json),
    problem: row.problem,
    rule: row.rule_text,
    evidence: JSON.parse(row.evidence_json),
    action: JSON.parse(row.action_json ?? "{}"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    validatedAt: row.validated_at,
    validatedBy: row.validated_by,
    validationEvidence: row.validation_evidence_json
      ? JSON.parse(row.validation_evidence_json)
      : null,
  };
}

export function listLessons(projectRoot, options = {}) {
  const { db } = openKnowledgeStore(projectRoot);
  try {
    const rows = options.status
      ? plainRows(db.prepare("SELECT * FROM lessons WHERE status=? ORDER BY confidence DESC, created_at DESC")
          .all(String(options.status).toUpperCase()))
      : plainRows(db.prepare("SELECT * FROM lessons ORDER BY created_at DESC").all());
    return rows.map(shapeLesson);
  } finally {
    db.close();
  }
}

function validateLessonEvidence(projectRoot, evidence, sourceRun = null) {
  const type = String(evidence?.type ?? "").toUpperCase();
  if (!["USER", "TEST", "CONTRACT", "RUN_EVENT"].includes(type)) {
    throw new LearningError(
      "INVALID_LESSON_VALIDATION",
      "Lesson validation evidence must be USER, TEST, CONTRACT, or RUN_EVENT",
    );
  }
  if (!evidence.source) {
    throw new LearningError("LESSON_VALIDATION_SOURCE_REQUIRED", "Lesson validation requires a source");
  }
  if (type === "TEST" && !["PASS", "PASSED", "SUCCESS", "OK"].includes(String(evidence.status).toUpperCase())) {
    throw new LearningError("LESSON_TEST_NOT_PASSING", "Test validation evidence must pass");
  }
  if (type === "CONTRACT") {
    const contract = insideProject(projectRoot, evidence.source);
    if (!contract.inside || !existsSync(contract.absolute)) {
      throw new LearningError("LESSON_CONTRACT_NOT_FOUND", `Contract not found inside project: ${evidence.source}`);
    }
  }
  if (type === "RUN_EVENT") {
    const { event } = findDurableRunEvent(projectRoot, evidence.source, evidence.runId ?? null);
    if (!event) {
      throw new LearningError(
        "LESSON_RUN_EVENT_NOT_FOUND",
        `Durable validation event was not found: ${evidence.source}`,
      );
    }
    if (sourceRun && event.runId === sourceRun) {
      throw new LearningError(
        "LESSON_RUN_EVENT_NOT_INDEPENDENT",
        "A RUN_EVENT validation must come from a different run than the candidate lesson",
      );
    }
    return {
      ...evidence,
      type,
      source: `event:${event.runId}:${event.eventId}`,
      runId: event.runId,
      validatedAt: new Date().toISOString(),
    };
  }
  return { ...evidence, type, validatedAt: new Date().toISOString() };
}

export function validateLesson(projectRoot, lessonIdValue, evidence, options = {}) {
  const { db } = openKnowledgeStore(projectRoot);
  try {
    const lesson = shapeLesson(plainRow(db.prepare("SELECT * FROM lessons WHERE id=?").get(lessonIdValue)));
    if (!lesson) throw new LearningError("LESSON_NOT_FOUND", `Candidate lesson not found: ${lessonIdValue}`);
    const validated = validateLessonEvidence(projectRoot, evidence, lesson.sourceRun);
    const now = options.now ?? new Date().toISOString();
    const result = db.prepare(`
      UPDATE lessons SET status='VALIDATED', validated_at=?, validated_by=?,
        validation_evidence_json=?, updated_at=? WHERE id=? AND status IN ('CANDIDATE', 'VALIDATED')
    `).run(
      now,
      options.actor ?? validated.type,
      stableJson(validated),
      now,
      lessonIdValue,
    );
    if (Number(result.changes) === 0) {
      throw new LearningError("LESSON_NOT_FOUND", `Candidate lesson not found: ${lessonIdValue}`);
    }
    return shapeLesson(plainRow(db.prepare("SELECT * FROM lessons WHERE id=?").get(lessonIdValue)));
  } finally {
    db.close();
  }
}

function recipeMarkdown(recipe) {
  return `---
id: ${recipe.id}
version: ${recipe.version}
status: ${recipe.status}
confidence: ${recipe.confidence}
sourceRun: ${recipe.sourceRun}
---

# ${recipe.id}

## Trigger

\`\`\`json
${JSON.stringify(recipe.trigger, null, 2)}
\`\`\`

## Action

\`\`\`json
${JSON.stringify(recipe.action, null, 2)}
\`\`\`

## Reason

${recipe.reason}

## Evidence

${recipe.evidence.map((item) => `- ${item}`).join("\n")}
`;
}

function shapeRecipe(row) {
  if (!row) return null;
  return {
    id: row.id,
    version: Number(row.version),
    status: row.status,
    pinned: Boolean(row.pinned),
    needsReview: Boolean(row.needs_review),
    confidence: Number(row.confidence),
    trigger: JSON.parse(row.trigger_json),
    action: JSON.parse(row.action_json),
    reason: row.reason,
    sourceRun: row.source_run,
    evidence: JSON.parse(row.evidence_json),
    useCount: Number(row.use_count),
    successCount: Number(row.success_count),
    failureCount: Number(row.failure_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    archivedAt: row.archived_at,
  };
}

export function promoteLessonToRecipe(projectRoot, lessonIdValue, options = {}) {
  const paths = projectKnowledgePaths(projectRoot);
  const { db } = openKnowledgeStore(projectRoot);
  try {
    const lesson = shapeLesson(plainRow(db.prepare("SELECT * FROM lessons WHERE id=?").get(lessonIdValue)));
    if (!lesson) throw new LearningError("LESSON_NOT_FOUND", `Lesson not found: ${lessonIdValue}`);
    if (lesson.status !== "VALIDATED") {
      throw new LearningError("LESSON_NOT_VALIDATED", "Only independently validated lessons can become recipes");
    }
    const minimum = Number(options.minimumConfidence ?? 0.8);
    if (Number(lesson.confidence) < minimum || lesson.evidence.length === 0) {
      throw new LearningError(
        "LESSON_EVIDENCE_INSUFFICIENT",
        `Recipe promotion requires confidence >= ${minimum} and durable evidence`,
      );
    }
    const recipeId = assertRecipeId(
      options.recipeId ?? `recipe-${sha256(`${stableJson(lesson.trigger)}\0${lesson.rule}`).slice(0, 20)}`,
    );
    const existing = shapeRecipe(plainRow(db.prepare("SELECT * FROM recipes WHERE id=?").get(recipeId)));
    const version = (existing?.version ?? 0) + 1;
    const now = options.now ?? new Date().toISOString();
    const recipe = {
      id: recipeId,
      version,
      status: "ACTIVE",
      pinned: existing?.pinned ?? false,
      needsReview: false,
      confidence: Number(lesson.confidence),
      trigger: lesson.trigger,
      action: lesson.action,
      reason: lesson.rule,
      sourceRun: lesson.sourceRun,
      evidence: [...lesson.evidence, `validation:${stableJson(lesson.validationEvidence)}`],
      useCount: existing?.useCount ?? 0,
      successCount: existing?.successCount ?? 0,
      failureCount: existing?.failureCount ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: existing?.lastUsedAt ?? null,
      archivedAt: null,
    };
    withTransaction(db, () => {
      db.prepare(`
        INSERT INTO recipes(
          id, version, status, pinned, confidence, trigger_json, action_json,
          reason, source_run, evidence_json, use_count, success_count,
          failure_count, created_at, updated_at, last_used_at, archived_at, needs_review
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          version=excluded.version,
          status=excluded.status,
          confidence=excluded.confidence,
          trigger_json=excluded.trigger_json,
          action_json=excluded.action_json,
          reason=excluded.reason,
          source_run=excluded.source_run,
          evidence_json=excluded.evidence_json,
          updated_at=excluded.updated_at,
          archived_at=NULL,
          needs_review=0
      `).run(
        recipe.id,
        recipe.version,
        recipe.status,
        recipe.pinned ? 1 : 0,
        recipe.confidence,
        stableJson(recipe.trigger),
        stableJson(recipe.action),
        recipe.reason,
        recipe.sourceRun,
        stableJson(recipe.evidence),
        recipe.useCount,
        recipe.successCount,
        recipe.failureCount,
        recipe.createdAt,
        recipe.updatedAt,
        recipe.lastUsedAt,
        recipe.archivedAt,
        0,
      );
      db.prepare("UPDATE lessons SET status='PROMOTED', updated_at=? WHERE id=?")
        .run(now, lessonIdValue);
    });
    mkdirSync(paths.learnedDir, { recursive: true });
    if (existing) {
      const versionsDir = join(paths.learnedDir, ".versions");
      mkdirSync(versionsDir, { recursive: true });
      const currentPath = join(paths.learnedDir, `${recipe.id}.md`);
      if (existsSync(currentPath)) {
        atomicWrite(
          join(versionsDir, `${recipe.id}.v${existing.version}.md`),
          readFileSync(currentPath, "utf8"),
        );
      }
    }
    atomicWrite(join(paths.learnedDir, `${recipe.id}.md`), `${recipeMarkdown(recipe).trimEnd()}\n`);
    return recipe;
  } finally {
    db.close();
  }
}

export function listRecipes(projectRoot, options = {}) {
  const { db } = openKnowledgeStore(projectRoot);
  try {
    const rows = options.status
      ? plainRows(db.prepare("SELECT * FROM recipes WHERE status=? ORDER BY pinned DESC, confidence DESC")
          .all(String(options.status).toUpperCase()))
      : plainRows(db.prepare("SELECT * FROM recipes ORDER BY pinned DESC, status, confidence DESC").all());
    return rows.map(shapeRecipe);
  } finally {
    db.close();
  }
}

function triggerMatches(trigger, context) {
  for (const [key, expected] of Object.entries(trigger)) {
    const actual = context[key];
    if (actual == null) return false;
    if (key === "error") {
      if (!String(actual).toLowerCase().includes(String(expected).toLowerCase())) return false;
    } else if (Array.isArray(expected)) {
      if (!expected.map(String).includes(String(actual))) return false;
    } else if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
      return false;
    }
  }
  return true;
}

export function matchRecipes(projectRoot, context, options = {}) {
  const recipes = listRecipes(projectRoot, { status: "ACTIVE" })
    .filter((recipe) => !recipe.needsReview && triggerMatches(recipe.trigger, context));
  return recipes.map((recipe) => ({
    ...recipe,
    historicalSuccessRate: recipe.useCount > 0 ? recipe.successCount / recipe.useCount : null,
    score: recipe.confidence * ((recipe.successCount + 1) / (recipe.useCount + 2)),
  })).sort((left, right) => right.score - left.score).slice(0, Number(options.limit ?? 10));
}

export function recordRecipeOutcome(projectRoot, recipeId, outcome, options = {}) {
  recipeId = assertRecipeId(recipeId);
  const normalized = String(outcome).toUpperCase();
  if (!new Set(["SUCCESS", "FAILED"]).has(normalized)) {
    throw new LearningError("INVALID_RECIPE_OUTCOME", "Recipe outcome must be SUCCESS or FAILED");
  }
  const { db } = openKnowledgeStore(projectRoot);
  try {
    const now = options.now ?? new Date().toISOString();
    return withTransaction(db, () => {
      const existing = plainRow(db.prepare("SELECT id FROM recipes WHERE id=?").get(recipeId));
      if (!existing) throw new LearningError("RECIPE_NOT_FOUND", `Recipe not found: ${recipeId}`);
      db.prepare(`
        INSERT INTO recipe_usage(id, recipe_id, run_id, task_id, outcome, occurred_at, evidence_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        `usage-${randomUUID()}`,
        recipeId,
        options.runId ?? null,
        options.taskId ?? null,
        normalized,
        now,
        stableJson(options.evidence ?? []),
      );
      db.prepare(`
        UPDATE recipes SET
          use_count=use_count+1,
          success_count=success_count+?,
          failure_count=failure_count+?,
          last_used_at=?,
          updated_at=?
        WHERE id=?
      `).run(normalized === "SUCCESS" ? 1 : 0, normalized === "FAILED" ? 1 : 0, now, now, recipeId);
      return shapeRecipe(plainRow(db.prepare("SELECT * FROM recipes WHERE id=?").get(recipeId)));
    });
  } finally {
    db.close();
  }
}

export function setRecipePinned(projectRoot, recipeId, pinned, options = {}) {
  recipeId = assertRecipeId(recipeId);
  const { db } = openKnowledgeStore(projectRoot);
  try {
    const result = db.prepare("UPDATE recipes SET pinned=?, updated_at=? WHERE id=?")
      .run(pinned ? 1 : 0, options.now ?? new Date().toISOString(), recipeId);
    if (Number(result.changes) === 0) throw new LearningError("RECIPE_NOT_FOUND", `Recipe not found: ${recipeId}`);
    return shapeRecipe(plainRow(db.prepare("SELECT * FROM recipes WHERE id=?").get(recipeId)));
  } finally {
    db.close();
  }
}

export function archiveRecipe(projectRoot, recipeId, options = {}) {
  recipeId = assertRecipeId(recipeId);
  const paths = projectKnowledgePaths(projectRoot);
  const { db } = openKnowledgeStore(projectRoot);
  try {
    const recipe = shapeRecipe(plainRow(db.prepare("SELECT * FROM recipes WHERE id=?").get(recipeId)));
    if (!recipe) throw new LearningError("RECIPE_NOT_FOUND", `Recipe not found: ${recipeId}`);
    if (recipe.pinned && !options.explicit) {
      throw new LearningError("RECIPE_PINNED", `Pinned recipe ${recipeId} cannot be auto-archived`);
    }
    const now = options.now ?? new Date().toISOString();
    db.prepare("UPDATE recipes SET status='ARCHIVED', archived_at=?, updated_at=? WHERE id=?")
      .run(now, now, recipeId);
    const source = join(paths.learnedDir, `${recipeId}.md`);
    if (existsSync(source)) {
      mkdirSync(paths.archiveDir, { recursive: true });
      renameSync(source, join(paths.archiveDir, `${basename(recipeId)}.md`));
    }
    return shapeRecipe(plainRow(db.prepare("SELECT * FROM recipes WHERE id=?").get(recipeId)));
  } finally {
    db.close();
  }
}
