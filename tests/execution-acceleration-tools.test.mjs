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

test("runInfraSmokeTest skips cleanly when no compose file is found (language/infra agnostic)", () => {
  const result = runInfraSmokeTest({
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

  const result = runInfraSmokeTest({
    rootDir: tempDir,
    dryRun: true,
  });

  assert.equal(result.status, "PASS");
  assert.equal(result.applicable, true);
  assert.equal(result.dryRun, true);

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
