#!/usr/bin/env node

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/cli-utils.mjs";

const SPACE_RADIUS_PROPS = "(?:padding|margin|gap|row-gap|column-gap|border-radius|inset|top|right|bottom|left)(?:-[a-z-]+)?";
const PX_DECLARATION = new RegExp(`(?:^|[\\s;{])(${SPACE_RADIUS_PROPS})\\s*:\\s*([^;{}]*)`, "i");
const INLINE_STYLE_PROPS = /(?:padding|margin|gap|rowGap|columnGap|borderRadius)\w*\s*:\s*['"]?-?\d*\.?\d+(?:px)?['"]?/;
const DESIGN_FILE_EXTENSIONS = /\.(?:css|scss|sass|less|html?|vue|svelte|jsx|tsx|astro)$/i;
const EXTERNAL_TOKEN_PREFIXES = ["--tw-", "--radix-", "--rsbuild", "--vite", "--next", "--font-geist"];

function stripVarCalls(text) {
  let previous;
  let current = text;
  do {
    previous = current;
    current = current.replace(/var\([^()]*\)/g, "0");
  } while (current !== previous);
  return current;
}

/**
 * Design-token linter for component/style files. Reports, per line:
 *   - `hex`: raw hex colors (a hex inside `var(--x, #fff)` counts: fallbacks defeat the contract);
 *   - `px`: literal px (other than 0/1px) on spacing/radius properties outside `var(...)`;
 *   - `inline-style`: JSX `style={{ padding: 12, borderRadius: 8 }}` with numeric/px spacing or radius.
 * Inline styles are also structurally unable to express :hover/:focus (see subagent-prompts.md).
 */
export function lintCssForTokens(content, { allowTokenDefinitions = true } = {}) {
  const violations = [];
  const lines = content.split(/\r?\n/);

  lines.forEach((line, index) => {
    // Ignora comentarios
    const trimmed = line.trim();
    if (trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("//")) return;
    // Se permitir definicoes de tokens (ex: --cor-primaria: #123456)
    if (allowTokenDefinitions && trimmed.startsWith("--")) return;

    const hexPattern = /#([0-9a-fA-F]{3,8})\b/g;
    let match;
    while ((match = hexPattern.exec(line)) !== null) {
      violations.push({ kind: "hex", line: index + 1, hex: match[0], snippet: trimmed });
    }

    const declaration = PX_DECLARATION.exec(line);
    if (declaration) {
      const value = stripVarCalls(declaration[2]);
      const literal = /(?:^|[^\w.-])(\d*\.?\d+)px\b/g;
      let px;
      while ((px = literal.exec(value)) !== null) {
        if (Number(px[1]) <= 1) continue;
        violations.push({ kind: "px", line: index + 1, property: declaration[1], value: `${px[1]}px`, snippet: trimmed });
        break;
      }
    }

    const inline = /style=\{\{([^}]*)\}?/.exec(line);
    if (inline) {
      const literalSpacing = INLINE_STYLE_PROPS.exec(inline[1]);
      if (literalSpacing && !/:\s*['"]?0(?:px)?['"]?$/.test(literalSpacing[0].trim())) {
        violations.push({ kind: "inline-style", line: index + 1, value: literalSpacing[0].trim(), snippet: trimmed });
      }
    }
  });

  return violations;
}

/** Custom properties defined (`--x:`) in a text, and the `var(--x)` names it references. */
export function collectTokenUsage(content) {
  const defined = new Set();
  const referenced = [];
  for (const match of content.matchAll(/(?:^|[\s;{(])(--[\w-]+)\s*:/g)) defined.add(match[1]);
  content.split(/\r?\n/).forEach((line, index) => {
    const pattern = /var\(\s*(--[\w-]+)/g;
    let match;
    while ((match = pattern.exec(line)) !== null) referenced.push({ name: match[1], line: index + 1 });
  });
  return { defined, referenced };
}

function isDesignPackageFile(relPath) {
  const normalized = relPath.replace(/\\/g, "/");
  return /(?:^|\/)design-systems\//.test(normalized)
    || /(?:^|\/)(?:tokens\.css|components\.html)$/.test(normalized)
    || /(?:^|\/)preview\//.test(normalized);
}

function listChangedFiles(rootDir, execFn) {
  const run = (cmd) => String(execFn(cmd, { cwd: rootDir, encoding: "utf8", stdio: "pipe" }))
    .split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  return [...new Set([...run("git diff --name-only HEAD"), ...run("git ls-files --others --exclude-standard")])];
}

/**
 * Real design-token check of a wave: lints every changed front-end file (never the design package
 * itself) and reports `var(--x)` references that no token file defines. The status is never a fixed
 * PASS: without a tokens.css or a way to list the changed files it is an explicit SKIPPED.
 */
export function checkDesignTokens({ rootDir, tokensFile, changedFiles, dryRun = false, execFn = execSync }) {
  const empty = { filesScanned: [], violations: [], undefinedTokens: [] };
  if (!tokensFile || !existsSync(tokensFile)) {
    return { status: "SKIPPED", enabled: false, message: "No tokens.css configured (--tokens-css); design token lint did not run", ...empty };
  }
  let files = changedFiles;
  if (!files) {
    if (dryRun) return { status: "SKIPPED", enabled: true, message: "dry-run without changedFiles; nothing to lint", ...empty };
    try { files = listChangedFiles(rootDir, execFn); }
    catch (err) {
      return { status: "SKIPPED", enabled: true, reasonCode: "CHANGED_FILES_UNAVAILABLE", message: `Could not list changed files (${err.message}); pass --changed-files`, ...empty };
    }
  }
  const targets = files.filter((file) => DESIGN_FILE_EXTENSIONS.test(file) && !isDesignPackageFile(file) && resolve(rootDir, file) !== tokensFile);
  const defined = collectTokenUsage(readFileSync(tokensFile, "utf8")).defined;
  const contents = [];
  for (const file of targets) {
    const absolute = resolve(rootDir, file);
    if (!existsSync(absolute)) continue;
    const content = readFileSync(absolute, "utf8");
    contents.push({ file, content });
    for (const name of collectTokenUsage(content).defined) defined.add(name);
  }
  const violations = [];
  const undefinedTokens = [];
  for (const { file, content } of contents) {
    for (const violation of lintCssForTokens(content)) violations.push({ file, ...violation });
    for (const ref of collectTokenUsage(content).referenced) {
      if (defined.has(ref.name) || EXTERNAL_TOKEN_PREFIXES.some((prefix) => ref.name.startsWith(prefix))) continue;
      undefinedTokens.push({ file, line: ref.line, token: ref.name });
    }
  }
  const failed = violations.length > 0 || undefinedTokens.length > 0;
  return { status: failed ? "FAILED" : "PASS", enabled: true, filesScanned: contents.map((item) => item.file), violations, undefinedTokens };
}

/* ------------------------------------------------------------------ workspaces (monorepo aware) */

const WORKSPACE_SKIP_DIRS = new Set([
  "node_modules", "bin", "obj", "dist", "build", "out", "target", "vendor", "coverage", "__pycache__", "venv",
]);
const COMMAND_TIMEOUT_MS = 15 * 60 * 1000;

function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function listDir(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function nodePackageManager(dir) {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun";
  return "npm";
}

function hasTestProject(dir, depth = 0) {
  for (const entry of listDir(dir)) {
    if (entry.isFile() && /test/i.test(entry.name) && entry.name.endsWith(".csproj")) return true;
    if (entry.isDirectory() && depth < 3 && !WORKSPACE_SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")
      && hasTestProject(join(dir, entry.name), depth + 1)) return true;
  }
  return false;
}

/**
 * Buildable units of the project, top-down to `maxDepth`: a Node package (build/test scripts), a .NET
 * solution (or project outside any solution), Go, Rust and Python modules. A monorepo such as
 * `backend/` (.NET) + `frontend/` (Next) yields one workspace each. Audit finding: the gate used to
 * report build/test as SKIPPED ("generic stack") for exactly that layout, and PASS for any project
 * with a package.json at the root without running anything.
 */
export function detectWorkspaces(rootDir, { maxDepth = 2 } = {}) {
  const root = resolve(rootDir);
  const workspaces = [];
  const dotnetRoots = [];
  let rootNodeWorkspaces = false;
  const visit = (dir, depth) => {
    const entries = listDir(dir);
    const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    const rel = relative(root, dir).replaceAll("\\", "/") || ".";
    if (files.has("package.json") && !(rootNodeWorkspaces && rel !== ".")) {
      const pkg = readJsonSafe(join(dir, "package.json")) ?? {};
      if (rel === "." && pkg.workspaces) rootNodeWorkspaces = true;
      const scripts = pkg.scripts ?? {};
      const pm = nodePackageManager(dir);
      const realTest = typeof scripts.test === "string" && !/no test specified/i.test(scripts.test);
      workspaces.push({
        dir: rel,
        stack: "node",
        build: scripts.build ? `${pm} run build` : null,
        test: realTest ? `${pm} run test` : null,
        prettier: Boolean(pkg.prettier || pkg.devDependencies?.prettier || pkg.dependencies?.prettier
          || [...files].some((name) => /^\.prettierrc|^prettier\.config\./.test(name))),
      });
    }
    const insideDotnet = dotnetRoots.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`) || prefix === ".");
    if (!insideDotnet) {
      const solution = [...files].find((name) => /\.slnx?$/i.test(name));
      const project = [...files].find((name) => name.endsWith(".csproj"));
      const entry = solution ?? project;
      if (entry) {
        dotnetRoots.push(rel);
        workspaces.push({
          dir: rel,
          stack: "dotnet",
          entry,
          build: `dotnet build "${entry}" --nologo -v q`,
          test: hasTestProject(dir) ? `dotnet test "${entry}" --nologo -v q` : null,
        });
      }
    }
    if (files.has("go.mod")) workspaces.push({ dir: rel, stack: "go", build: "go build ./...", test: "go test ./..." });
    if (files.has("Cargo.toml")) workspaces.push({ dir: rel, stack: "rust", build: "cargo build", test: "cargo test" });
    if (files.has("pyproject.toml") || files.has("requirements.txt")) {
      const tests = existsSync(join(dir, "tests")) || existsSync(join(dir, "test"));
      workspaces.push({ dir: rel, stack: "python", build: null, test: tests ? "python -m pytest -q" : null });
    }
    if (depth >= maxDepth) return;
    for (const entry of entries) {
      if (entry.isDirectory() && !WORKSPACE_SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
        visit(join(dir, entry.name), depth + 1);
      }
    }
  };
  visit(root, 0);
  return workspaces;
}

function runCommand(execFn, command, cwd) {
  try {
    execFn(command, { cwd, encoding: "utf8", stdio: "pipe", timeout: COMMAND_TIMEOUT_MS, env: { ...process.env, CI: "true" } });
    return { status: "PASS" };
  } catch (err) {
    const output = `${err?.stderr ?? ""}${err?.stdout ?? ""}${err?.message ?? ""}`;
    if (err?.code === "ENOENT" || /not recognized as an internal or external command|command not found|No such file or directory/i.test(output)) {
      return { status: "SKIPPED", reasonCode: "TOOL_UNAVAILABLE", error: String(err?.message ?? err).slice(0, 2000) };
    }
    return { status: "FAILED", error: String(output || err).slice(-4000) };
  }
}

/** build or test across every detected workspace; never a PASS that did not run something. */
function runWorkspaceStep({ step, explicitCommand, rootDir, workspaces, dryRun, execFn }) {
  if (explicitCommand) {
    if (dryRun) return { status: "PASS", command: explicitCommand, dryRun: true };
    const outcome = runCommand(execFn, explicitCommand, rootDir);
    return { ...outcome, command: explicitCommand };
  }
  const planned = workspaces.filter((workspace) => workspace[step]).map((workspace) => ({ dir: workspace.dir, stack: workspace.stack, command: workspace[step] }));
  if (planned.length === 0) {
    return {
      status: "SKIPPED",
      reasonCode: workspaces.length === 0 ? "NO_WORKSPACE_DETECTED" : `NO_${step.toUpperCase()}_TARGET`,
      message: workspaces.length === 0
        ? `No buildable workspace detected (package.json, .sln/.csproj, go.mod, Cargo.toml, pyproject.toml up to depth 2); pass --${step}-cmd`
        : `Detected workspaces declare no ${step} command; pass --${step}-cmd`,
      workspaces: [],
    };
  }
  if (dryRun) return { status: "PASS", dryRun: true, workspaces: planned.map((item) => ({ ...item, status: "PLANNED" })) };
  const results = planned.map((item) => ({ ...item, ...runCommand(execFn, item.command, resolve(rootDir, item.dir)) }));
  const status = results.some((item) => item.status === "FAILED")
    ? "FAILED"
    : results.some((item) => item.status === "PASS") ? "PASS" : "SKIPPED";
  return { status, workspaces: results };
}

/* ------------------------------------------------------------------ format */

const CODE_FILE = /\.(?:cs|ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|vue|svelte|css|scss)$/i;
const GENERATED_FILE = /(?:\.min\.|\.designer\.cs$|\.g\.cs$|\.g\.i\.cs$|(?:^|\/)(?:migrations|generated|__generated__|dist|build|obj|bin)\/|\.d\.ts$)/i;
const LONG_LINE_EXEMPT = /https?:\/\/|data:[a-z]+\/|^\s*(?:import|export)\s.*\sfrom\s|^\s*d="M|^\s*(?:\/\/|\/\*|\*|#)/;

/**
 * Long-line check on changed source files: one-line handlers of 300+ characters passed build, lint
 * and review in a real run (OficinaAI, 2026-09, about a third of the endpoint lines above 200 chars).
 * URLs, data URIs, imports, SVG paths and comments are exempt; generated code is skipped.
 */
export function findLongLines(files, { rootDir, maxLineLength = 200, readFile = (path) => readFileSync(path, "utf8") } = {}) {
  const violations = [];
  for (const file of files) {
    const normalized = file.replaceAll("\\", "/");
    if (!CODE_FILE.test(normalized) || GENERATED_FILE.test(normalized) || isDesignPackageFile(normalized)) continue;
    const absolute = resolve(rootDir, file);
    if (!existsSync(absolute)) continue;
    readFile(absolute).split(/\r?\n/).forEach((line, index) => {
      if (line.length > maxLineLength && !LONG_LINE_EXEMPT.test(line)) {
        violations.push({ file: normalized, line: index + 1, length: line.length });
      }
    });
  }
  return violations;
}

function checkFormat({ rootDir, workspaces, changedFiles, dryRun, execFn, maxLineLength }) {
  const longLines = findLongLines(changedFiles, { rootDir, maxLineLength });
  const formatters = [];
  if (!dryRun) {
    for (const workspace of workspaces) {
      const prefix = workspace.dir === "." ? "" : `${workspace.dir}/`;
      const own = changedFiles.map((file) => file.replaceAll("\\", "/")).filter((file) => file.startsWith(prefix))
        .map((file) => file.slice(prefix.length));
      if (workspace.stack === "dotnet") {
        const csFiles = own.filter((file) => file.endsWith(".cs") && !GENERATED_FILE.test(file));
        if (csFiles.length === 0) continue;
        const command = `dotnet format "${workspace.entry}" whitespace --verify-no-changes -v q --include ${csFiles.map((file) => `"${file}"`).join(" ")}`;
        formatters.push({ dir: workspace.dir, tool: "dotnet format", command, ...runCommand(execFn, command, resolve(rootDir, workspace.dir)) });
      } else if (workspace.stack === "node" && workspace.prettier) {
        const targets = own.filter((file) => /\.(?:[cm]?[jt]sx?|css|scss|json|vue|svelte)$/i.test(file) && !GENERATED_FILE.test(file));
        if (targets.length === 0) continue;
        const command = `npx --no-install prettier --check ${targets.map((file) => `"${file}"`).join(" ")}`;
        formatters.push({ dir: workspace.dir, tool: "prettier", command, ...runCommand(execFn, command, resolve(rootDir, workspace.dir)) });
      }
    }
  }
  const failed = longLines.length > 0 || formatters.some((item) => item.status === "FAILED");
  return { status: failed ? "FAILED" : "PASS", maxLineLength, longLines, formatters };
}

/* ------------------------------------------------------------------ coordination folders */

const COORDINATION_REFERENCE = /(?:^|[^\w.-])\.(?:pensador|orchestrator|orchestration|testador|executor)[\\/]/;
const COORDINATION_SCAN_EXEMPT = /(?:\.md$|(?:^|\/)\.gitignore$|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$|^\.(?:pensador|orchestrator|orchestration|testador|executor)\/)/i;

/**
 * Product code and build config must not read the workflow's hidden coordination folders: a real
 * front-end generated its API types from `../.pensador/<slug>/openapi.yaml`, so the product could not
 * build without the planning folder. The contract belongs in the repository (materialize-api-contract.mjs).
 */
export function findCoordinationReferences(files, { rootDir, readFile = (path) => readFileSync(path, "utf8") } = {}) {
  const references = [];
  for (const file of files) {
    const normalized = file.replaceAll("\\", "/");
    if (COORDINATION_SCAN_EXEMPT.test(normalized) || isDesignPackageFile(normalized)) continue;
    const absolute = resolve(rootDir, file);
    if (!existsSync(absolute)) continue;
    let content;
    try { content = readFile(absolute); } catch { continue; }
    content.split(/\r?\n/).forEach((line, index) => {
      if (COORDINATION_REFERENCE.test(line)) references.push({ file: normalized, line: index + 1, snippet: line.trim().slice(0, 200) });
    });
  }
  return references;
}

/* ------------------------------------------------------------------ gate */

export function runWaveQualityGate({
  rootDir = process.cwd(),
  waveNumber = 1,
  runDir = undefined,
  tokensCssPath = undefined,
  changedFiles = undefined,
  buildCommand = undefined,
  testCommand = undefined,
  maxLineLength = 200,
  dryRun = false,
  execFn = execSync,
} = {}) {
  const startMs = Date.now();
  const checks = {};
  const workspaces = detectWorkspaces(rootDir);

  checks.build = runWorkspaceStep({ step: "build", explicitCommand: buildCommand, rootDir, workspaces, dryRun, execFn });
  checks.test = runWorkspaceStep({ step: "test", explicitCommand: testCommand, rootDir, workspaces, dryRun, execFn });
  // Informative: a buildable workspace with no test command (a real front-end shipped with zero
  // tests while the PRD required Vitest/Playwright/axe — that requirement is enforced as ARC-XX
  // evidence in Fase 10; here it is surfaced every wave).
  checks.test.untestedWorkspaces = workspaces.filter((workspace) => workspace.build && !workspace.test)
    .map(({ dir, stack }) => ({ dir, stack }));

  const tokensFile = tokensCssPath ? resolve(rootDir, tokensCssPath) : null;
  checks.designTokens = checkDesignTokens({ rootDir, tokensFile, changedFiles, dryRun, execFn });

  let files = changedFiles;
  let changedFilesReason = null;
  if (!files) {
    try { files = listChangedFiles(rootDir, execFn); }
    catch (err) { files = []; changedFilesReason = `Could not list changed files (${err.message}); pass --changed-files`; }
  }
  checks.format = changedFilesReason
    ? { status: "SKIPPED", reasonCode: "CHANGED_FILES_UNAVAILABLE", message: changedFilesReason }
    : checkFormat({ rootDir, workspaces, changedFiles: files, dryRun, execFn, maxLineLength });

  const manifests = workspaces.filter((workspace) => workspace.stack === "node")
    .map((workspace) => (workspace.dir === "." ? "package.json" : `${workspace.dir}/package.json`));
  const references = findCoordinationReferences([...new Set([...files, ...manifests])], { rootDir });
  checks.coordinationRefs = { status: references.length ? "FAILED" : "PASS", references };

  const overallPass = !Object.values(checks).some((check) => check.status === "FAILED");
  return {
    status: overallPass ? "PASS" : "FAILED",
    wave: waveNumber,
    runDir: runDir ?? null,
    workspaces: workspaces.map(({ dir, stack }) => ({ dir, stack })),
    checks,
    durationMs: Date.now() - startMs,
    timestamp: new Date().toISOString(),
  };
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    stdout.write(`Usage: run-wave-gate.mjs [--root <dir>] [--wave <num>] [--dir <run-dir>] [--build-cmd <cmd>] [--test-cmd <cmd>] [--tokens-css <path>] [--changed-files <a,b,c>] [--max-line-length 200] [--dry-run] [--json]\n`);
    return 0;
  }

  const rootDir = args.root ? resolve(args.root) : process.cwd();
  const waveNumber = args.wave ? Number(args.wave) : 1;
  const runDir = args.dir ? String(args.dir) : undefined;
  const tokensCssPath = args["tokens-css"] ? String(args["tokens-css"]) : undefined;
  const changedFiles = args["changed-files"]
    ? String(args["changed-files"]).split(",").map((item) => item.trim()).filter(Boolean)
    : undefined;
  const buildCommand = args["build-cmd"] ? String(args["build-cmd"]) : undefined;
  const testCommand = args["test-cmd"] ? String(args["test-cmd"]) : undefined;
  const maxLineLength = args["max-line-length"] ? Number(args["max-line-length"]) : 200;
  const dryRun = Boolean(args["dry-run"]);

  const result = runWaveQualityGate({
    rootDir,
    waveNumber,
    runDir,
    tokensCssPath,
    changedFiles,
    buildCommand,
    testCommand,
    maxLineLength,
    dryRun,
  });

  if (args.json) {
    stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    stdout.write(`Wave ${waveNumber} Quality Gate: ${result.status}\n`);
  }

  return result.status === "FAILED" ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exit(1);
    },
  );
}
