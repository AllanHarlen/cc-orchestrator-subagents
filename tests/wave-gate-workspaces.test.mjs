import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  detectWorkspaces,
  findCoordinationReferences,
  findLongLines,
  runWaveQualityGate,
} from "../skills/orchestrator-multi-agent-development/scripts/run-wave-gate.mjs";
import { resolveValidatorCommand, validateApiContract } from "../skills/orchestrator-multi-agent-development/scripts/validate-api-contract.mjs";
import { materializeApiContract } from "../skills/orchestrator-multi-agent-development/scripts/materialize-api-contract.mjs";

const roots = [];
test.after(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function project(files) {
  const root = mkdtempSync(join(tmpdir(), "wave-ws-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), typeof content === "string" ? content : JSON.stringify(content));
  }
  return root;
}

// The layout of a real run (OficinaAI, 2026-09): .NET back-end + Next front-end, no root package.json.
const MONOREPO = {
  "backend/App.sln": "",
  "backend/src/Api/Api.csproj": "<Project />",
  "backend/tests/Api.Tests/Api.Tests.csproj": "<Project />",
  "frontend/package.json": { scripts: { build: "next build", test: "vitest run" } },
  "frontend/pnpm-lock.yaml": "",
};

test("detects each workspace of a monorepo with its own build and test commands", () => {
  const root = project(MONOREPO);
  const workspaces = detectWorkspaces(root);
  assert.deepEqual(workspaces.map(({ dir, stack, build, test: testCmd }) => ({ dir, stack, build, test: testCmd })), [
    { dir: "backend", stack: "dotnet", build: 'dotnet build "App.sln" --nologo -v q', test: 'dotnet test "App.sln" --nologo -v q' },
    { dir: "frontend", stack: "node", build: "pnpm run build", test: "pnpm run test" },
  ]);
});

test("the gate runs every workspace and never reports a build PASS it did not run", () => {
  const root = project(MONOREPO);
  const calls = [];
  const execFn = (command, options) => {
    calls.push({ command, cwd: options?.cwd });
    if (command.startsWith("git ")) return "";
    if (command === "pnpm run test") throw Object.assign(new Error("1 failed"), { stdout: "FAIL src/app.test.ts" });
    return "";
  };
  const result = runWaveQualityGate({ rootDir: root, execFn });
  assert.equal(result.checks.build.status, "PASS");
  assert.deepEqual(result.checks.build.workspaces.map((item) => [item.dir, item.status]), [["backend", "PASS"], ["frontend", "PASS"]]);
  assert.equal(result.checks.test.status, "FAILED");
  assert.equal(result.status, "FAILED");
  assert.ok(calls.some((call) => call.command.startsWith("dotnet build") && call.cwd.endsWith("backend")));

  // A package.json without scripts used to be reported as build PASS ("typescript-node") without running anything.
  const bare = project({ "package.json": { name: "x" } });
  const skipped = runWaveQualityGate({ rootDir: bare, changedFiles: [], execFn: () => "" });
  assert.equal(skipped.checks.build.status, "SKIPPED");
  assert.equal(skipped.checks.build.reasonCode, "NO_BUILD_TARGET");
});

test("a workspace without tests is surfaced every wave", () => {
  const root = project({ "frontend/package.json": { scripts: { build: "vite build", test: "echo \"Error: no test specified\" && exit 1" } } });
  const result = runWaveQualityGate({ rootDir: root, dryRun: true, changedFiles: [] });
  assert.deepEqual(result.checks.test.untestedWorkspaces, [{ dir: "frontend", stack: "node" }]);
});

test("long lines in changed source files fail the format check; generated code and URLs are exempt", () => {
  const long = `app.MapPost("/quotes", async (Db db) => { ${"var x = 1; ".repeat(30)}});`;
  const root = project({
    "backend/src/Api/QuoteEndpoints.cs": `namespace Api;\n${long}\n`,
    "backend/src/Migrations/20260901_Init.cs": `${long}\n`,
    "frontend/src/links.ts": `export const DOCS = "https://example.com/${"a".repeat(260)}";\n`,
  });
  const files = ["backend/src/Api/QuoteEndpoints.cs", "backend/src/Migrations/20260901_Init.cs", "frontend/src/links.ts"];
  assert.deepEqual(findLongLines(files, { rootDir: root }).map((item) => [item.file, item.line]), [["backend/src/Api/QuoteEndpoints.cs", 2]]);
  const result = runWaveQualityGate({ rootDir: root, dryRun: true, changedFiles: files });
  assert.equal(result.checks.format.status, "FAILED");
});

test("product code may not read the coordination folders", () => {
  const root = project({
    "frontend/package.json": { scripts: { build: "next build", "gen:api": "openapi-typescript ../.pensador/loja-v1/openapi.yaml -o src/schema.d.ts" } },
    "docs/NOTES.md": "see .pensador/loja-v1/prd.md",
  });
  const references = findCoordinationReferences(["frontend/package.json", "docs/NOTES.md"], { rootDir: root });
  assert.deepEqual(references.map((item) => item.file), ["frontend/package.json"]);
  // Scanned even when the manifest is not in this wave's diff.
  const result = runWaveQualityGate({ rootDir: root, dryRun: true, changedFiles: [] });
  assert.equal(result.checks.coordinationRefs.status, "FAILED");
});

test("materialize-api-contract copies the contract into the repo and makes the validate command runnable", () => {
  const root = project({
    ".pensador/loja-v1/openapi.yaml": "openapi: 3.1.0\n",
    ".pensador/loja-v1/handoff.json": {
      artifactRoot: ".pensador/loja-v1",
      artifacts: [{ role: "api-contract", path: "openapi.yaml", validation: { validate: "schemathesis run openapi.yaml" } }],
    },
  });
  const dry = materializeApiContract({ handoffPath: ".pensador/loja-v1/handoff.json", projectRoot: root });
  assert.equal(dry.status, "PASS");
  assert.equal(dry.operations[0].destination, "contracts/openapi.yaml");
  assert.equal(dry.operations[0].validate, "st run contracts/openapi.yaml --url <base-url>");
  assert.equal(existsSync(join(root, "contracts", "openapi.yaml")), false);
  materializeApiContract({ handoffPath: ".pensador/loja-v1/handoff.json", projectRoot: root, apply: true });
  assert.equal(readFileSync(join(root, "contracts", "openapi.yaml"), "utf8"), "openapi: 3.1.0\n");
  assert.equal(materializeApiContract({ handoffPath: ".pensador/loja-v1/handoff.json", projectRoot: root, into: ".pensador/x" }).reasonCode, "UNSAFE_TARGET");
});

test("validate-api-contract runs schemathesis against the running API and binds the evidence to the contract", () => {
  const root = project({ "contracts/openapi.yaml": "openapi: 3.1.0\n", ".pensador/x/openapi.yaml": "openapi: 3.1.0\n" });
  const runDir = join(root, ".orchestrator", "runs", "demo");
  const commands = [];
  const spawn = (exitCode, available = ["st"]) => (command, argsOrOptions) => {
    if (Array.isArray(argsOrOptions)) return { status: available.includes(command) ? 0 : 1 };
    commands.push(command);
    return { status: exitCode, stdout: exitCode === 1 ? "status_code_conformance: 422 not documented" : "", stderr: "" };
  };

  assert.equal(validateApiContract({ contract: ".pensador/x/openapi.yaml", baseUrl: "http://127.0.0.1:5000", projectRoot: root, spawn: spawn(0) }).reasonCode, "CONTRACT_OUTSIDE_REPOSITORY");
  assert.equal(validateApiContract({ contract: "contracts/openapi.yaml", projectRoot: root, spawn: spawn(0) }).reasonCode, "BASE_URL_REQUIRED");
  assert.equal(validateApiContract({ contract: "contracts/openapi.yaml", baseUrl: "http://127.0.0.1:5000", projectRoot: root, spawn: spawn(0, []) }).reasonCode, "VALIDATOR_UNAVAILABLE");

  const failed = validateApiContract({ contract: "contracts/openapi.yaml", baseUrl: "http://127.0.0.1:5000", runDir, projectRoot: root, spawn: spawn(1) });
  assert.equal(failed.status, "FAILED");
  assert.match(commands.at(-1), /^st run ".*openapi\.yaml" --url "http:\/\/127\.0\.0\.1:5000" --report junit/);
  const passed = validateApiContract({ contract: "contracts/openapi.yaml", baseUrl: "http://127.0.0.1:5000", runDir, projectRoot: root, spawn: spawn(0) });
  assert.equal(passed.status, "PASS");
  const stored = JSON.parse(readFileSync(join(runDir, "evidence", "api-contract-validation.json"), "utf8"));
  assert.equal(stored.kind, "api-contract-validation");
  assert.equal(stored.contractSha256.length, 64);
  assert.equal(validateApiContract({ contract: "contracts/openapi.yaml", baseUrl: "http://x", projectRoot: root, spawn: spawn(2) }).status, "BLOCKED");

  const custom = resolveValidatorCommand({ contract: "c.yaml", baseUrl: "http://x", reportDir: "r", command: "my-tool <contract> <url>" });
  assert.equal(custom.command, 'my-tool "c.yaml" "http://x"');
});
