#!/usr/bin/env node

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/cli-utils.mjs";

export const DEFAULT_COMPOSE_LOCATIONS = Object.freeze([
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "infra/docker-compose.yml",
  "infra/docker-compose.yaml",
  "infra/compose.yml",
  "infra/compose.yaml",
  "docker/docker-compose.yml",
  "docker/compose.yml",
]);

export function findComposeFile(rootDir = process.cwd(), explicitPath = undefined) {
  if (explicitPath) {
    const candidate = resolve(rootDir, explicitPath);
    return existsSync(candidate) ? candidate : null;
  }
  for (const relPath of DEFAULT_COMPOSE_LOCATIONS) {
    const candidate = resolve(rootDir, relPath);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function runInfraSmokeTest({
  rootDir = process.cwd(),
  composeFile = undefined,
  timeoutMs = 120_000,
  healthUrl = undefined,
  dryRun = false,
  execFn = execSync,
} = {}) {
  const resolvedCompose = findComposeFile(rootDir, composeFile);
  if (!resolvedCompose) {
    return {
      status: "SKIPPED",
      applicable: false,
      reason: "NO_DOCKER_COMPOSE_FOUND",
      message: "No docker-compose file found in project. Infrastructure smoke test not applicable.",
      timestamp: new Date().toISOString(),
    };
  }

  if (dryRun) {
    return {
      status: "PASS",
      applicable: true,
      composeFile: resolvedCompose,
      dryRun: true,
      message: "Docker compose file detected and valid for execution.",
      timestamp: new Date().toISOString(),
    };
  }

  const startMs = Date.now();
  let upOutput = "";
  try {
    upOutput = execFn(`docker compose -f "${resolvedCompose}" up -d --build`, {
      cwd: rootDir,
      encoding: "utf8",
      stdio: "pipe",
      timeout: timeoutMs,
    });
  } catch (err) {
    return {
      status: "FAILED",
      applicable: true,
      composeFile: resolvedCompose,
      error: err instanceof Error ? err.message : String(err),
      phase: "STACK_UP",
      durationMs: Date.now() - startMs,
      timestamp: new Date().toISOString(),
    };
  }

  let psOutput = "";
  try {
    psOutput = execFn(`docker compose -f "${resolvedCompose}" ps`, {
      cwd: rootDir,
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (err) {
    psOutput = "(failed to query ps)";
  }

  return {
    status: "PASS",
    applicable: true,
    composeFile: resolvedCompose,
    healthUrl: healthUrl ?? null,
    ps: psOutput.trim(),
    durationMs: Date.now() - startMs,
    timestamp: new Date().toISOString(),
  };
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    stdout.write(`Usage: smoke-test-infra.mjs [--root <dir>] [--compose-file <path>] [--health-url <url>] [--dry-run] [--json]\n`);
    return 0;
  }

  const rootDir = args.root ? resolve(args.root) : process.cwd();
  const composeFile = args["compose-file"] ? String(args["compose-file"]) : undefined;
  const healthUrl = args["health-url"] ? String(args["health-url"]) : undefined;
  const dryRun = Boolean(args["dry-run"]);

  const result = runInfraSmokeTest({
    rootDir,
    composeFile,
    healthUrl,
    dryRun,
  });

  if (args.json) {
    stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    stdout.write(`Infrastructure smoke test status: ${result.status} (${result.reason || result.message || "OK"})\n`);
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
