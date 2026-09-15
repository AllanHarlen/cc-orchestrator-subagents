#!/usr/bin/env node

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/cli-utils.mjs";
import { artifactTreePath } from "./lib/artifact-layout.mjs";

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

export function parseComposePs(output) {
  const text = String(output ?? "").trim();
  if (!text) return [];
  const parsed = text.startsWith("[")
    ? JSON.parse(text)
    : text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function probeHealthUrl(url, timeoutMs, fetchFn, waitFn) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "Health endpoint did not return a successful response";
  let attempts = 0;
  do {
    attempts += 1;
    const remaining = Math.max(1, deadline - Date.now());
    try {
      const response = await fetchFn(url, { signal: AbortSignal.timeout(Math.min(5_000, remaining)) });
      if (response.ok) return { ok: true, status: response.status, attempts };
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() < deadline) await waitFn(Math.min(1_000, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  return { ok: false, error: lastError, attempts };
}

export async function runInfraSmokeTest({
  rootDir = process.cwd(),
  composeFile = undefined,
  timeoutMs = 120_000,
  healthUrl = undefined,
  dryRun = false,
  execFn = execSync,
  fetchFn = globalThis.fetch,
  waitFn = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
} = {}) {
  const base = { kind: "infra-smoke-test", schemaVersion: 1 };
  const resolvedCompose = findComposeFile(rootDir, composeFile);
  if (!resolvedCompose) {
    return {
      ...base,
      status: "SKIPPED",
      applicable: false,
      reason: "NO_DOCKER_COMPOSE_FOUND",
      message: "No docker-compose file found in project. Infrastructure smoke test not applicable.",
      timestamp: new Date().toISOString(),
    };
  }

  if (dryRun) {
    return {
      ...base,
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
      ...base,
      status: "FAILED",
      applicable: true,
      composeFile: resolvedCompose,
      error: err instanceof Error ? err.message : String(err),
      phase: "STACK_UP",
      durationMs: Date.now() - startMs,
      timestamp: new Date().toISOString(),
    };
  }

  const statusDeadline = Date.now() + timeoutMs;
  let services = [];
  let unhealthy = [];
  while (true) {
    let psOutput;
    try {
      psOutput = execFn(`docker compose -f "${resolvedCompose}" ps --all --format json`, {
        cwd: rootDir,
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (err) {
      return {
        ...base,
        status: "FAILED",
        applicable: true,
        composeFile: resolvedCompose,
        error: err instanceof Error ? err.message : String(err),
        phase: "STACK_STATUS",
        durationMs: Date.now() - startMs,
        timestamp: new Date().toISOString(),
      };
    }

    try {
      services = parseComposePs(psOutput);
    } catch (error) {
      return {
        ...base,
        status: "FAILED",
        applicable: true,
        composeFile: resolvedCompose,
        error: `Invalid docker compose ps JSON: ${error instanceof Error ? error.message : String(error)}`,
        phase: "STACK_STATUS",
        durationMs: Date.now() - startMs,
        timestamp: new Date().toISOString(),
      };
    }
    unhealthy = services.filter((service) =>
      String(service.State ?? "").toLowerCase() !== "running" ||
      (String(service.Health ?? "").trim() !== "" && String(service.Health).toLowerCase() !== "healthy"),
    );
    if (services.length > 0 && unhealthy.length === 0) break;

    const terminalFailure = unhealthy.some((service) =>
      ["dead", "exited", "paused", "removing"].includes(String(service.State ?? "").toLowerCase()) ||
      String(service.Health ?? "").toLowerCase() === "unhealthy",
    );
    if (terminalFailure || Date.now() >= statusDeadline) {
      return {
        ...base,
        status: "FAILED",
        applicable: true,
        composeFile: resolvedCompose,
        phase: "STACK_STATUS",
        services,
        unhealthyServices: unhealthy.map((service) => service.Service ?? service.Name ?? "unknown"),
        error: services.length === 0 ? "docker compose ps returned no services" : "One or more Compose services are not running and healthy",
        durationMs: Date.now() - startMs,
        timestamp: new Date().toISOString(),
      };
    }
    await waitFn(Math.min(1_000, Math.max(1, statusDeadline - Date.now())));
  }

  let health = null;
  if (healthUrl) {
    health = await probeHealthUrl(healthUrl, timeoutMs, fetchFn, waitFn);
    if (!health.ok) {
      return {
        ...base,
        status: "FAILED",
        applicable: true,
        composeFile: resolvedCompose,
        healthUrl,
        health,
        phase: "HEALTH_CHECK",
        error: `Health check failed: ${health.error}`,
        durationMs: Date.now() - startMs,
        timestamp: new Date().toISOString(),
      };
    }
  }

  return {
    ...base,
    status: "PASS",
    applicable: true,
    composeFile: resolvedCompose,
    healthUrl: healthUrl ?? null,
    health,
    services,
    durationMs: Date.now() - startMs,
    timestamp: new Date().toISOString(),
  };
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    stdout.write(`Usage: smoke-test-infra.mjs [--root <dir>] [--dir <run-dir>] [--compose-file <path>] [--health-url <url>] [--timeout <seconds>] [--dry-run] [--json]\n`);
    return 0;
  }

  const rootDir = args.root ? resolve(args.root) : process.cwd();
  const composeFile = args["compose-file"] ? String(args["compose-file"]) : undefined;
  const healthUrl = args["health-url"] ? String(args["health-url"]) : undefined;
  const timeoutSeconds = Number(args.timeout ?? 120);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error(`--timeout must be a positive number of seconds, got ${JSON.stringify(args.timeout)}`);
  }
  const dryRun = Boolean(args["dry-run"]);

  const result = await runInfraSmokeTest({
    rootDir,
    composeFile,
    healthUrl,
    timeoutMs: timeoutSeconds * 1000,
    dryRun,
  });

  if (args.dir) {
    const evidenceDir = artifactTreePath(resolve(args.dir), "evidence").path;
    mkdirSync(evidenceDir, { recursive: true });
    const output = join(evidenceDir, "infra-smoke-test.json");
    const temporary = `${output}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    renameSync(temporary, output);
  }

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
