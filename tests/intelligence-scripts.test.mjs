import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { initRun, updateTaskStatus } from "../skills/orchestrator-multi-agent-development/scripts/lib/orchestration-state.mjs";

const roots = [];
const scriptsRoot = resolve("skills/orchestrator-multi-agent-development/scripts");

function runScript(name, args, cwd) {
  const result = spawnSync(process.execPath, [join(scriptsRoot, name), ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || `${name} failed`);
  assert.ok(Buffer.byteLength(result.stdout) < 256_000, `${name} output was not compact`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result?.schemaVersion ?? 1, 1);
  return parsed;
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(" ")} failed`);
  return String(result.stdout).trim();
}

function fixture() {
  const root = mkdtempSync(join(process.cwd(), ".tmp-intelligence-test-"));
  roots.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "orchestrator-tests@example.invalid");
  git(root, "config", "user.name", "Orchestrator Tests");
  mkdirSync(join(root, "backend"), { recursive: true });
  mkdirSync(join(root, "frontend"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "fixture",
    type: "module",
    dependencies: { react: "19.0.0", antd: "6.0.0" },
    scripts: { build: "vite build", test: "vitest" },
  }), "utf8");
  writeFileSync(join(root, "backend", "RedirectDto.cs"), [
    "public sealed class RedirectDto {",
    "  public string WhatsAppRedirectUrl { get; set; }",
    "  public int Count { get; set; }",
    "}",
  ].join("\n"), "utf8");
  writeFileSync(join(root, "frontend", "redirect.ts"), [
    "export interface Redirect {",
    "  whatsappRedirectUrl: string;",
    "  count: number;",
    "}",
  ].join("\n"), "utf8");
  writeFileSync(join(root, "payload.json"), '{"id":1,"name":"ok"}\n', "utf8");
  writeFileSync(join(root, "payload.schema.json"), JSON.stringify({
    type: "object",
    required: ["id", "name"],
    additionalProperties: false,
    properties: { id: { type: "integer" }, name: { type: "string" } },
  }), "utf8");
  writeFileSync(join(root, "test-results.xml"), '<testsuite tests="3" failures="1" skipped="0" time="1.2"></testsuite>\n', "utf8");
  writeFileSync(join(root, "contract.md"), "# Incomplete Contract\n\n```json\n{\"id\":1}\n```\n", "utf8");
  git(root, "add", ".");
  git(root, "commit", "-m", "fixture");
  return root;
}

function runFixture(root) {
  const artifactDir = join(root, ".orchestration", "script-run");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, "tasks-classification.md"), [
    "# Tasks",
    "",
    "## FE-01 - Update contract client",
    "- category: FRONTEND_ONLY",
    "- complexity: medium",
    "- assignedAgent: agy",
    "- allowedPaths: `frontend/redirect.ts`",
    "- expectedFiles: `frontend/redirect.ts`",
    "- validationPlan: `npm run build`",
  ].join("\n"), "utf8");
  writeFileSync(join(artifactDir, "waves.md"), "# Waves\n\n## Wave 1\n- FE-01\n", "utf8");
  initRun({ projectRoot: root, artifactDir, slug: "script-run", runId: "script-run-001" });
  return artifactDir;
}

test.afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

test("project, contract, API/UI, wire-format and test-result inspections are deterministic", () => {
  const root = fixture();
  const project = runScript("inspect-project.mjs", ["--root", root, "--persist-knowledge"], root);
  assert.deepEqual(project.result.summary.frameworks, ["React", "Ant Design"]);
  assert.equal(project.knowledge.errors.length, 0);

  const contract = runScript("inspect-contract.mjs", ["--root", root, "--path", "contract.md"], root);
  assert.equal(contract.result.summary.invalid, 1);
  assert.match(contract.result.details.contracts[0].contentSha256, /^[a-f0-9]{64}$/);

  const apiUi = runScript("inspect-api-ui.mjs", [
    "--root", root,
    "--backend", "backend",
    "--frontend", "frontend",
  ], root);
  assert.equal(apiUi.result.summary.contractsChecked, 1);
  assert.equal(apiUi.result.summary.casingMismatches, 1);

  const wire = runScript("validate-wire-format.mjs", [
    "--root", root,
    "--payload", "payload.json",
    "--schema", "payload.schema.json",
  ], root);
  assert.equal(wire.result.summary.valid, true);

  const tests = runScript("collect-test-results.mjs", ["--root", root, "--input", "test-results.xml"], root);
  assert.equal(tests.result.summary.status, "FAIL");
  assert.equal(tests.result.summary.total, 3);
});

test("only valid contracts and passing collected tests can persist knowledge", () => {
  const root = fixture();
  writeFileSync(join(root, "valid-contract.md"), [
    "# Contract",
    "",
    "## Contract Metadata",
    "Status: `Confirmado`",
    "",
    "## Endpoint",
    "`/api/items`",
    "",
    "## Metodo HTTP",
    "`GET`",
    "",
    "## Wire Format",
    "Request: `camelCase`",
    "Response: `camelCase`",
    "",
    "## Request",
    "```json",
    "{\"id\":1}",
    "```",
    "",
    "## Response",
    "```json",
    "{\"id\":1,\"name\":\"item\"}",
    "```",
    "",
    "## Estados de UI",
    "loading, success, empty, error",
    "",
    "## Permissoes",
    "authenticated",
    "",
    "## Validacoes Back-end",
    "contract serializer",
    "",
    "## Validacoes Front-end",
    "TypeScript consumer confirmed",
    "",
    "## Checklist de Fechamento do Contrato",
    "- [x] payload real conferido",
  ].join("\n"), "utf8");
  writeFileSync(
    join(root, "passing-results.xml"),
    '<testsuite tests="3" failures="0" skipped="0" time="1.2"></testsuite>\n',
    "utf8",
  );
  const contract = runScript("inspect-contract.mjs", [
    "--root", root,
    "--path", "valid-contract.md",
    "--persist-knowledge",
  ], root);
  assert.equal(contract.result.summary.valid, 1);
  assert.equal(contract.knowledge.facts.length, 1);
  const tests = runScript("collect-test-results.mjs", [
    "--root", root,
    "--input", "passing-results.xml",
    "--persist-knowledge",
    "--command", "npm test",
  ], root);
  assert.equal(tests.result.summary.status, "PASS");
  assert.equal(tests.knowledge.fact.fact.status, "VALIDATED");
});

test("diff, task-scope and run reconciliation scripts produce bounded evidence", () => {
  const root = fixture();
  const artifactDir = runFixture(root);
  updateTaskStatus(artifactDir, "FE-01", "RUNNING", {
    projectRoot: root,
    executor: "agy",
    conversationId: "conversation-one",
  });
  writeFileSync(join(root, "frontend", "redirect.ts"), [
    "export interface Redirect {",
    "  whatsappRedirectUrl: string;",
    "  count: number;",
    "  enabled: boolean;",
    "}",
  ].join("\n"), "utf8");
  const diff = runScript("inspect-diff.mjs", ["--root", root], root);
  assert.equal(diff.result.summary.filesChanged, 1);

  const scope = runScript("validate-task-scope.mjs", [
    "--root", root,
    "--dir", artifactDir,
    "--task", "FE-01",
  ], root);
  assert.equal(scope.result.summary.valid, true, JSON.stringify(scope.result, null, 2));
  assert.deepEqual(scope.result.details.outOfScope, []);

  const reconcile = runScript("reconcile-run.mjs", ["--root", root, "--dir", artifactDir], root);
  assert.equal(reconcile.result.summary.integrityValid, true);
  assert.equal(reconcile.result.summary.pendingExternalProbes, 1);
});
