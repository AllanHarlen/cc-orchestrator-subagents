import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { renameWithRetry } from "./fs-retry.mjs";

import { artifactTreePath } from "./artifact-layout.mjs";
import { loadRun, updateTaskStatus } from "./orchestration-state.mjs";
import { stableJson } from "./sqlite-store.mjs";

const DEFAULT_EXCLUDES = new Set([
  ".git",
  ".orchestrator",
  ".orchestration",
  ".worktrees",
  "node_modules",
  "vendor",
  "bin",
  "obj",
  "dist",
  "build",
  "coverage",
  ".next",
]);

export class IntelligenceError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "IntelligenceError";
    this.code = code;
    this.details = details;
  }
}

export function toPosixPath(value) {
  return value.split(sep).join("/");
}

export function resolveInside(root, value) {
  const absoluteRoot = resolve(root);
  const absolute = isAbsolute(value) ? resolve(value) : resolve(absoluteRoot, value);
  const rel = relative(absoluteRoot, absolute);
  const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
  if (!inside) {
    throw new IntelligenceError(
      "PATH_OUTSIDE_PROJECT",
      `Path resolves outside the project: ${value}`,
    );
  }
  return { absolute, relative: toPosixPath(rel || ".") };
}

export function walkFiles(root, options = {}) {
  const absoluteRoot = resolve(root);
  const maxFiles = Number(options.maxFiles ?? 20_000);
  const maxDepth = Number(options.maxDepth ?? 30);
  const exclude = new Set([...DEFAULT_EXCLUDES, ...(options.exclude ?? [])]);
  const extensions = options.extensions
    ? new Set(options.extensions.map((value) => value.toLowerCase()))
    : null;
  const names = options.names ? new Set(options.names.map((value) => value.toLowerCase())) : null;
  const files = [];
  const stack = [{ path: absoluteRoot, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.depth > maxDepth) continue;
    let entries;
    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(current.path, entry.name);
      if (entry.isDirectory()) {
        if (!exclude.has(entry.name)) stack.push({ path, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (extensions && !extensions.has(extname(entry.name).toLowerCase())) continue;
      if (names && !names.has(entry.name.toLowerCase())) continue;
      files.push({ absolute: path, relative: toPosixPath(relative(absoluteRoot, path)) });
      if (files.length > maxFiles) {
        throw new IntelligenceError(
          "FILE_SCAN_LIMIT",
          `File scan exceeded ${maxFiles} entries; narrow the input paths`,
        );
      }
    }
  }
  return files.sort((left, right) => left.relative.localeCompare(right.relative));
}

export function collectInputFiles(projectRoot, inputs, options = {}) {
  const values = Array.isArray(inputs) ? inputs : [inputs];
  const files = [];
  for (const value of values.filter(Boolean)) {
    const located = resolveInside(projectRoot, value);
    if (!existsSync(located.absolute)) {
      throw new IntelligenceError("INPUT_NOT_FOUND", `Input not found: ${value}`);
    }
    if (statSync(located.absolute).isDirectory()) {
      files.push(...walkFiles(located.absolute, options).map((entry) => ({
        absolute: entry.absolute,
        relative: toPosixPath(relative(resolve(projectRoot), entry.absolute)),
      })));
    } else {
      files.push(located);
    }
  }
  return [...new Map(files.map((file) => [file.absolute, file])).values()]
    .sort((left, right) => left.relative.localeCompare(right.relative));
}

export function readTextBounded(path, maxBytes = 2_000_000) {
  const size = statSync(path).size;
  if (size > maxBytes) {
    throw new IntelligenceError(
      "INPUT_TOO_LARGE",
      `${path} is ${size} bytes; maximum is ${maxBytes}`,
    );
  }
  return readFileSync(path, "utf8");
}

export function intelligenceResult(kind, summary, details = {}, options = {}) {
  const core = {
    schemaVersion: 1,
    kind,
    summary,
    details,
  };
  const hash = createHash("sha256").update(stableJson(core)).digest("hex");
  return {
    ...core,
    evidenceId: options.evidenceId ?? `intel-${kind}-${hash.slice(0, 20)}`,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
  };
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameWithRetry(temporary, path);
}

export function persistIntelligenceEvidence(result, options = {}) {
  if (!options.artifactDir) return null;
  const artifactDir = resolve(options.artifactDir);
  const evidenceDir = artifactTreePath(artifactDir, "evidence").path;
  const path = join(evidenceDir, `${result.evidenceId}.json`);
  writeJsonAtomic(path, result);
  let task = null;
  if (options.taskId) {
    const state = loadRun(artifactDir).state;
    const current = state.tasks?.[String(options.taskId).toUpperCase()];
    if (!current) {
      throw new IntelligenceError("TASK_NOT_FOUND", `Task not found: ${options.taskId}`);
    }
    task = updateTaskStatus(artifactDir, options.taskId, current.status, {
      projectRoot: options.projectRoot,
      evidence: `evidence:${result.evidenceId}`,
      actor: options.actor ?? `intelligence:${result.kind}`,
    }).task;
  }
  return {
    path,
    relativePath: toPosixPath(relative(resolve(options.projectRoot ?? join(artifactDir, "..", "..")), path)),
    taskId: task?.id ?? null,
  };
}

export function findJsonCodeBlocks(markdown) {
  const blocks = [];
  for (const match of markdown.matchAll(/```json\s*([\s\S]*?)```/gi)) {
    try {
      blocks.push({ valid: true, value: JSON.parse(match[1]), raw: match[1] });
    } catch (error) {
      blocks.push({ valid: false, error: error.message, raw: match[1] });
    }
  }
  return blocks;
}

export function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function flattenJsonShape(value, prefix = "$") {
  const entries = [];
  const visit = (current, path) => {
    entries.push({ path, type: jsonType(current) });
    if (Array.isArray(current)) {
      if (current.length > 0) visit(current[0], `${path}[]`);
    } else if (current && typeof current === "object") {
      for (const key of Object.keys(current).sort()) visit(current[key], `${path}.${key}`);
    }
  };
  visit(value, prefix);
  return entries;
}

export function lowerCamel(value) {
  if (!value) return value;
  if (/^[A-Z]{2,}(?:$|[A-Z][a-z])/.test(value)) {
    const match = value.match(/^([A-Z]+)(?=[A-Z][a-z]|$)/);
    const prefix = match?.[1] ?? value[0];
    return `${prefix.toLowerCase()}${value.slice(prefix.length)}`;
  }
  return `${value[0].toLowerCase()}${value.slice(1)}`;
}

export function fileKind(path) {
  const name = basename(path).toLowerCase();
  const extension = extname(name);
  if (extension === ".cs") return "csharp";
  if ([".ts", ".tsx"].includes(extension)) return "typescript";
  if (extension === ".json") return "json";
  if (extension === ".md") return "markdown";
  if (name.endsWith(".csproj")) return "csproj";
  return extension.slice(1) || "unknown";
}
