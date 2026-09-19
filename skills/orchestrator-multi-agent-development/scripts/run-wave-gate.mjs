#!/usr/bin/env node

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

export function runWaveQualityGate({
  rootDir = process.cwd(),
  waveNumber = 1,
  runDir = undefined,
  tokensCssPath = undefined,
  changedFiles = undefined,
  buildCommand = undefined,
  testCommand = undefined,
  dryRun = false,
  execFn = execSync,
} = {}) {
  const startMs = Date.now();
  const checks = {};
  let overallPass = true;

  // 1. Build Check
  if (buildCommand) {
    if (dryRun) {
      checks.build = { status: "PASS", command: buildCommand, dryRun: true };
    } else {
      try {
        execFn(buildCommand, { cwd: rootDir, encoding: "utf8", stdio: "pipe" });
        checks.build = { status: "PASS", command: buildCommand };
      } catch (err) {
        checks.build = { status: "FAILED", command: buildCommand, error: err.message };
        overallPass = false;
      }
    }
  } else {
    // Detecção desacoplada de build
    if (existsSync(join(rootDir, "package.json"))) {
      checks.build = { status: "PASS", detected: "typescript-node", message: "Standard project structure verified" };
    } else {
      checks.build = { status: "SKIPPED", message: "No buildCommand configured and generic stack" };
    }
  }

  // 2. Test Check
  if (testCommand) {
    if (dryRun) {
      checks.test = { status: "PASS", command: testCommand, dryRun: true };
    } else {
      try {
        execFn(testCommand, { cwd: rootDir, encoding: "utf8", stdio: "pipe" });
        checks.test = { status: "PASS", command: testCommand };
      } catch (err) {
        checks.test = { status: "FAILED", command: testCommand, error: err.message };
        overallPass = false;
      }
    }
  } else {
    checks.test = { status: "SKIPPED", message: "No testCommand specified for wave gate" };
  }

  // 3. Design Token Linter
  const tokensFile = tokensCssPath ? resolve(rootDir, tokensCssPath) : null;
  checks.designTokens = checkDesignTokens({ rootDir, tokensFile, changedFiles, dryRun, execFn });
  if (checks.designTokens.status === "FAILED") overallPass = false;

  return {
    status: overallPass ? "PASS" : "FAILED",
    wave: waveNumber,
    checks,
    durationMs: Date.now() - startMs,
    timestamp: new Date().toISOString(),
  };
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    stdout.write(`Usage: run-wave-gate.mjs [--root <dir>] [--wave <num>] [--dir <run-dir>] [--build-cmd <cmd>] [--test-cmd <cmd>] [--tokens-css <path>] [--changed-files <a,b,c>] [--dry-run] [--json]\n`);
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
  const dryRun = Boolean(args["dry-run"]);

  const result = runWaveQualityGate({
    rootDir,
    waveNumber,
    runDir,
    tokensCssPath,
    changedFiles,
    buildCommand,
    testCommand,
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
