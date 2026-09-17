import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PROJECT_CONFIG,
  ROLES,
  deriveRequiredCliSet,
  projectConfigPath,
} from "../skills/orchestrator-multi-agent-development/scripts/lib/project-config.mjs";

/**
 * Testes unitarios da CLI `project-config` (Task 7.4).
 *
 * Exercita o script real via `spawnSync`, no mesmo padrao usado por
 * `tests/project-config.property.test.mjs` para `preflight.mjs`: o script
 * chama `executeJsonCli` e sai com codigo de processo, entao a unica forma
 * honesta de testar o contrato e rodar o binario.
 */

const CLI_SCRIPT = fileURLToPath(
  new URL(
    "../skills/orchestrator-multi-agent-development/scripts/project-config.mjs",
    import.meta.url,
  ),
);

const roots = [];

function temporaryProject() {
  const root = mkdtempSync(join(tmpdir(), "project-config-cli-"));
  roots.push(root);
  return root;
}

test.afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

/** Roda a CLI e devolve `{ status, json }`. `json` e `undefined` quando stdout nao parseia. */
function runCli(root, args) {
  const run = spawnSync(process.execPath, [CLI_SCRIPT, ...args], {
    cwd: root,
    encoding: "utf8",
  });
  const raw = run.status === 0 ? run.stdout : run.stderr;
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    json = undefined;
  }
  return { status: run.status, json, stdout: run.stdout, stderr: run.stderr };
}

const VALID_ROLES = Object.freeze({
  "backend-executor": "codex",
  "frontend-executor": "agy",
  "backend-reviewer": "codex",
  "frontend-reviewer": "claude-code",
  // Explicito para nao cair em "sem resposta" (default + default-aplicado) nos
  // testes que nao exercitam especificamente esse campo.
  "quota-fallback-chain": "disabled",
});

function writeArgs(overrides = {}) {
  const flags = { ...VALID_ROLES, ...overrides };
  return Object.entries(flags).flatMap(([flag, value]) => [`--${flag}`, value]);
}

/* -------------------------------------------------------------------------- */
/* show                                                                        */
/* -------------------------------------------------------------------------- */

test("show on an empty project returns the default stack with source default", () => {
  const root = temporaryProject();
  const { status, json } = runCli(root, ["show"]);

  assert.equal(status, 0);
  assert.equal(json.ok, true);
  assert.equal(json.exists, false);
  assert.equal(json.source, "default");
  for (const role of ROLES) assert.equal(json.config[role], DEFAULT_PROJECT_CONFIG[role]);
  assert.deepEqual(json.requiredCliSet.clis, deriveRequiredCliSet(json.config).clis);
  assert.ok(!existsSync(join(root, ".orchestrator")), "show nao deveria criar .orchestrator/");
});

test("show after a write returns source file and the persisted config", () => {
  const root = temporaryProject();
  runCli(root, ["write", ...writeArgs()]);

  const { status, json } = runCli(root, ["show"]);
  assert.equal(status, 0);
  assert.equal(json.exists, true);
  assert.equal(json.source, "file");
  assert.equal(json.config.backendExecutor, "codex");
  assert.equal(json.config.frontendExecutor, "agy");
  assert.equal(json.config.frontendReviewer, "claude-code");
});

/* -------------------------------------------------------------------------- */
/* write                                                                       */
/* -------------------------------------------------------------------------- */

test("write persists the file and reports the diff from the previous (default) config", () => {
  const root = temporaryProject();
  const { status, json } = runCli(root, ["write", ...writeArgs()]);

  assert.equal(status, 0);
  assert.equal(json.ok, true);
  assert.equal(json.config.backendExecutor, "codex");
  assert.equal(json.path.toLowerCase(), projectConfigPath(root).toLowerCase());
  assert.ok(existsSync(json.path), "write deveria persistir o arquivo");

  // O diff reportado e exatamente os papeis que mudaram frente ao default anterior.
  const changedRoles = json.changed.map((entry) => entry.role).sort();
  const expectedChanged = ROLES.filter(
    (role) => DEFAULT_PROJECT_CONFIG[role] !== VALID_ROLES[
      role === "backendExecutor" ? "backend-executor"
        : role === "frontendExecutor" ? "frontend-executor"
          : role === "backendReviewer" ? "backend-reviewer"
            : "frontend-reviewer"
    ],
  ).sort();
  assert.deepEqual(changedRoles, expectedChanged);

  assert.equal(json.previous.exists, false);
  assert.equal(json.previous.source, "default");
});

test("an identical repeat write reports an empty diff", () => {
  const root = temporaryProject();
  runCli(root, ["write", ...writeArgs()]);
  const { status, json } = runCli(root, ["write", ...writeArgs()]);

  assert.equal(status, 0);
  assert.deepEqual(json.changed, []);
  assert.equal(json.previous.exists, true);
  assert.equal(json.previous.source, "file");
});

test("write with an executor outside the allowed set fails naming field, value and accepted set, without touching a prior valid file", () => {
  const root = temporaryProject();
  runCli(root, ["write", ...writeArgs()]);
  const before = readFileSync(projectConfigPath(root), "utf8");

  const { status, json } = runCli(root, ["write", ...writeArgs({ "backend-executor": "gpt-5" })]);

  assert.equal(status, 1);
  assert.equal(json.ok, false);
  assert.equal(json.error.code, "PROJECT_CONFIG_INVALID_VALUE");
  assert.equal(json.error.details.field, "backendExecutor");
  assert.equal(json.error.details.received, "gpt-5");
  assert.ok(json.error.details.accepted.includes("codex"));

  assert.equal(readFileSync(projectConfigPath(root), "utf8"), before, "write invalido nao deveria alterar o arquivo anterior");
});

test("write without a required flag fails with a missing-argument error", () => {
  const root = temporaryProject();
  const args = writeArgs();
  const withoutBackendExecutor = args.filter(
    (_token, index) => !(args[index - 1] === "--backend-executor" || args[index] === "--backend-executor"),
  );

  const { status, json } = runCli(root, ["write", ...withoutBackendExecutor]);
  assert.equal(status, 2);
  assert.equal(json.ok, false);
  assert.equal(json.error.code, "MISSING_ARGUMENT");
  assert.match(json.error.message, /backend-executor/);
});

test("write registers defaultsApplied only for roles left unanswered", () => {
  const root = temporaryProject();
  const args = writeArgs();
  // `--default-applied` sozinho nao supre os flags obrigatorios: a CLI exige
  // os quatro papeis explicitamente e usa `defaultsApplied` so como marca.
  const { status, json } = runCli(root, [
    "write",
    ...args,
    "--default-applied",
    "backendExecutor,frontendReviewer",
  ]);
  assert.equal(status, 0);
  assert.deepEqual(json.config.defaultsApplied, ["backendExecutor", "frontendReviewer"]);
});

/* -------------------------------------------------------------------------- */
/* validate                                                                    */
/* -------------------------------------------------------------------------- */

test("validate on an empty project succeeds with the default config", () => {
  const root = temporaryProject();
  const { status, json } = runCli(root, ["validate"]);
  assert.equal(status, 0);
  assert.equal(json.valid, true);
  assert.equal(json.source, "default");
});

test("validate against a malformed project-config.md reports the parser failure without an uncontrolled crash", () => {
  const root = temporaryProject();
  const path = projectConfigPath(root);
  mkdirSync(join(root, ".orchestrator"), { recursive: true });
  writeFileSync(path, "not a project config at all\n", "utf8");

  const { status, json } = runCli(root, ["validate"]);
  assert.equal(status, 1);
  assert.equal(json.ok, false);
  assert.equal(json.error.code, "PROJECT_CONFIG_UNPARSEABLE");

  // O arquivo invalido continua intacto: validate nunca escreve.
  assert.equal(readFileSync(path, "utf8"), "not a project config at all\n");
});

/* -------------------------------------------------------------------------- */
/* required-clis                                                              */
/* -------------------------------------------------------------------------- */

test("required-clis matches the derivation for a written config", () => {
  const root = temporaryProject();
  runCli(root, ["write", ...writeArgs({ "backend-executor": "codex", "frontend-executor": "agy" })]);

  const { status, json } = runCli(root, ["required-clis"]);
  assert.equal(status, 0);
  assert.equal(json.source, "file");
  assert.deepEqual([...json.requiredCliSet.clis], ["codex", "agy"]);
  assert.equal(json.requiredCliSet.codex, true);
  assert.equal(json.requiredCliSet.agy, true);
});

test("required-clis on an all-claude-code project derives an empty CLI set", () => {
  const root = temporaryProject();
  runCli(root, [
    "write",
    "--backend-executor",
    "claude-code",
    "--frontend-executor",
    "claude-code",
    "--backend-reviewer",
    "claude-code",
    "--frontend-reviewer",
    "claude-code",
  ]);

  const { json } = runCli(root, ["required-clis"]);
  assert.deepEqual([...json.requiredCliSet.clis], []);
  assert.equal(json.requiredCliSet.codex, false);
  assert.equal(json.requiredCliSet.agy, false);
});

/* -------------------------------------------------------------------------- */
/* Isolamento de Run (Req 6.8, 6.9)                                           */
/* -------------------------------------------------------------------------- */

test("no subcommand ever creates .orchestration/, regardless of outcome", () => {
  const root = temporaryProject();
  runCli(root, ["show"]);
  runCli(root, ["write", ...writeArgs()]);
  runCli(root, ["validate"]);
  runCli(root, ["required-clis"]);
  runCli(root, ["write", ...writeArgs({ "backend-executor": "not-a-real-executor" })]);

  assert.ok(!existsSync(join(root, ".orchestration")), "nenhum subcomando deveria criar .orchestration/");
});
