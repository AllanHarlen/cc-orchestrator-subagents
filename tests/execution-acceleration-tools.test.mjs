import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  generateContractTypes,
  detectProjectEcosystem,
} from "../skills/orchestrator-multi-agent-development/scripts/generate-contract-types.mjs";

import {
  findComposeFile,
  main as smokeTestMain,
  runInfraSmokeTest,
} from "../skills/orchestrator-multi-agent-development/scripts/smoke-test-infra.mjs";

import {
  lintCssForTokens,
  runWaveQualityGate,
} from "../skills/orchestrator-multi-agent-development/scripts/run-wave-gate.mjs";

import {
  buildTraceabilityMatrix,
  renderTraceabilityMatrixMarkdown,
} from "../skills/orchestrator-multi-agent-development/scripts/build-traceability-matrix.mjs";

test("detectProjectEcosystem correctly detects ecosystem without hardcoding", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "eco-test-"));
  assert.equal(detectProjectEcosystem(tempDir), "generic");

  await fs.promises.writeFile(path.join(tempDir, "package.json"), "{}");
  assert.equal(detectProjectEcosystem(tempDir), "typescript-node");

  await fs.promises.rm(tempDir, { recursive: true, force: true });
});

test("generateContractTypes creates types and executes custom or fallback generator", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gen-contract-test-"));
  const contractPath = path.join(tempDir, "openapi.yaml");
  await fs.promises.writeFile(contractPath, "openapi: 3.1.0\ninfo:\n  title: Test API\n  version: 1.0.0\npaths: {}\n");

  const result = generateContractTypes({
    contractPath,
    rootDir: tempDir,
    outputPath: "types/api.ts",
  });

  assert.equal(result.status, "PASS");
  assert.equal(result.outputFile, "types/api.ts");
  assert.ok(fs.existsSync(path.join(tempDir, "types/api.ts")));

  await fs.promises.rm(tempDir, { recursive: true, force: true });
});

test("findComposeFile detects standard docker compose files or returns null", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "compose-test-"));
  assert.equal(findComposeFile(tempDir), null);

  const infraDir = path.join(tempDir, "infra");
  await fs.promises.mkdir(infraDir, { recursive: true });
  await fs.promises.writeFile(path.join(infraDir, "docker-compose.yml"), "version: '3.8'");

  const found = findComposeFile(tempDir);
  assert.ok(found);
  assert.match(found, /infra[\\/]docker-compose\.yml/);

  await fs.promises.rm(tempDir, { recursive: true, force: true });
});

test("runInfraSmokeTest skips cleanly when no compose file is found (language/infra agnostic)", async () => {
  const result = await runInfraSmokeTest({
    rootDir: os.tmpdir(),
    composeFile: "nonexistent-compose.yml",
  });

  assert.equal(result.status, "SKIPPED");
  assert.equal(result.applicable, false);
  assert.equal(result.reason, "NO_DOCKER_COMPOSE_FOUND");
});

test("runInfraSmokeTest passes on dryRun when compose file exists", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "compose-dry-"));
  const composePath = path.join(tempDir, "docker-compose.yml");
  await fs.promises.writeFile(composePath, "services:\n  app:\n    image: node:alpine\n");

  const result = await runInfraSmokeTest({
    rootDir: tempDir,
    dryRun: true,
  });

  assert.equal(result.status, "PASS");
  assert.equal(result.applicable, true);
  assert.equal(result.dryRun, true);

  await fs.promises.rm(tempDir, { recursive: true, force: true });
});

test("runInfraSmokeTest rejects stopped services and enforces a declared health URL", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "compose-status-"));
  await fs.promises.writeFile(path.join(tempDir, "docker-compose.yml"), "services:\n  app:\n    image: node:alpine\n");
  const stopped = await runInfraSmokeTest({
    rootDir: tempDir,
    execFn: (command) => command.includes(" ps ")
      ? JSON.stringify({ Service: "app", State: "exited", Health: "", ExitCode: 1 })
      : "",
  });
  assert.equal(stopped.status, "FAILED");
  assert.equal(stopped.phase, "STACK_STATUS");

  let psCalls = 0;
  const eventuallyHealthy = await runInfraSmokeTest({
    rootDir: tempDir,
    timeoutMs: 100,
    execFn: (command) => {
      if (!command.includes(" ps ")) return "";
      psCalls += 1;
      return JSON.stringify({ Service: "app", State: "running", Health: psCalls === 1 ? "starting" : "healthy", ExitCode: 0 });
    },
    waitFn: async () => {},
  });
  assert.equal(eventuallyHealthy.status, "PASS");
  assert.equal(psCalls, 2);

  const healthyStack = (command) => command.includes(" ps ")
    ? JSON.stringify({ Service: "app", State: "running", Health: "healthy", ExitCode: 0 })
    : "";
  const unhealthyEndpoint = await runInfraSmokeTest({
    rootDir: tempDir,
    healthUrl: "http://127.0.0.1/health",
    timeoutMs: 1,
    execFn: healthyStack,
    fetchFn: async () => ({ ok: false, status: 503 }),
    waitFn: async () => {},
  });
  assert.equal(unhealthyEndpoint.status, "FAILED");
  assert.equal(unhealthyEndpoint.phase, "HEALTH_CHECK");

  const healthyEndpoint = await runInfraSmokeTest({
    rootDir: tempDir,
    healthUrl: "http://127.0.0.1/health",
    execFn: healthyStack,
    fetchFn: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(healthyEndpoint.status, "PASS");
  assert.equal(healthyEndpoint.health.status, 200);
  await fs.promises.rm(tempDir, { recursive: true, force: true });
});

test("smoke-test-infra CLI main persists its result in the run evidence directory", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "compose-persist-"));
  const runDir = path.join(tempDir, ".orchestrator", "runs", "demo");
  await fs.promises.mkdir(runDir, { recursive: true });
  await fs.promises.writeFile(path.join(tempDir, "docker-compose.yml"), "services:\n  app:\n    image: node:alpine\n");
  let stdout = "";
  const code = await smokeTestMain(
    ["--root", tempDir, "--dir", runDir, "--dry-run", "--json"],
    { stdout: { write: (value) => { stdout += value; } } },
  );
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).status, "PASS");
  const evidence = JSON.parse(await fs.promises.readFile(path.join(runDir, "evidence", "infra-smoke-test.json"), "utf8"));
  assert.equal(evidence.kind, "infra-smoke-test");
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.dryRun, true);
  await fs.promises.rm(tempDir, { recursive: true, force: true });
});

test("lintCssForTokens flags raw hex colors outside token definitions", () => {
  const css = `
    .card {
      color: #333333;
      background: var(--bg-card);
    }
    /* comment with #ff0000 */
    --my-token: #123456;
  `;

  const violations = lintCssForTokens(css, { allowTokenDefinitions: true });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].hex, "#333333");
  assert.equal(violations[0].line, 3);
});

test("runWaveQualityGate runs wave checks and reports status", () => {
  const result = runWaveQualityGate({
    rootDir: process.cwd(),
    waveNumber: 1,
    dryRun: true,
    buildCommand: "echo building",
    testCommand: "echo testing",
  });

  assert.equal(result.status, "PASS");
  assert.equal(result.wave, 1);
  assert.equal(result.checks.build.status, "PASS");
  assert.equal(result.checks.test.status, "PASS");
});

test("buildTraceabilityMatrix cross-references requirements and tasks into markdown", () => {
  const requirementsData = [
    {
      id: "RF-01",
      description: "Autenticação de usuário",
      acceptanceCriteria: ["CA-01: Login com credenciais válidas", "CA-02: Erro em credenciais inválidas"],
    },
    {
      id: "RF-02",
      description: "Catálogo de serviços",
      acceptanceCriteria: ["CA-03: Listar serviços com fotos"],
    },
  ];

  const stateData = {
    tasks: [
      {
        id: "BE-01",
        requirementIds: ["RF-01"],
        status: "DONE",
        producedFiles: ["src/services/auth.ts"],
      },
      {
        id: "FE-01",
        requirementIds: ["RF-01", "RF-02"],
        status: "DONE",
        producedFiles: ["src/pages/Login.tsx", "src/pages/Catalog.tsx"],
      },
    ],
  };

  const rows = buildTraceabilityMatrix({ requirementsData, stateData });
  assert.equal(rows.length, 3);

  const rf01_ca01 = rows.find((r) => r.rf === "RF-01" && r.ca.startsWith("CA-01"));
  assert.ok(rf01_ca01);
  assert.equal(rf01_ca01.status, "implementado");
  assert.ok(rf01_ca01.tasks.includes("BE-01"));
  assert.ok(rf01_ca01.tasks.includes("FE-01"));

  const markdown = renderTraceabilityMatrixMarkdown(rows);
  assert.match(markdown, /RF \| CA \| Task\(s\) \| Evidência/);
  assert.match(markdown, /RF-01 \| CA-01/);
  assert.match(markdown, /implementado/);
});
