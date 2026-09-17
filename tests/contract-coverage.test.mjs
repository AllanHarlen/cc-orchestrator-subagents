/**
 * Unit + CLI tests for the screen-to-contract-operation coverage gate
 * (lib/contract-coverage.mjs, validate-contract-coverage.mjs).
 *
 * Real defect this closes: a real run (OficinaAI, 2026-09-16) shipped
 * `openapi.yaml` with 21 operations for 41 RFs — no list endpoint for Ordens
 * de Servico/Clientes/Vendas/Leads — and nothing cross-checked screens
 * against the contract until a browser E2E on the finished build, by which
 * point the front-end had already filled those screens from client-side
 * localStorage. These tests cover the positive path (every screen operation
 * matches a contract operation -> ok: true, gate exits 0), the negative path
 * (a screen with no matching operation is caught, with the exact operation
 * reported) and degradation (no ui-data-map / non-REST format never
 * produces a false failure).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  parseOpenApiOperations,
  normalizeOperationKey,
  parseOperationRef,
  validateContractCoverage,
} from "../skills/orchestrator-multi-agent-development/scripts/lib/contract-coverage.mjs";

const SCRIPT = fileURLToPath(
  new URL("../skills/orchestrator-multi-agent-development/scripts/validate-contract-coverage.mjs", import.meta.url),
);

const SAMPLE_CONTRACT = `paths:
  /ordens-servico:
    post:
      responses:
        '201': { description: Created }
  /ordens-servico/{id}:
    get:
      responses:
        '200': { description: OK }
    put:
      responses:
        '200': { description: OK }
`;

// --- parseOpenApiOperations / normalizeOperationKey / parseOperationRef ----

test("parseOpenApiOperations: extracts every method under every path", () => {
  assert.deepEqual(parseOpenApiOperations(SAMPLE_CONTRACT), [
    { method: "POST", path: "/ordens-servico" },
    { method: "GET", path: "/ordens-servico/{id}" },
    { method: "PUT", path: "/ordens-servico/{id}" },
  ]);
});

test("parseOpenApiOperations: never trips on a schema property literally named after an HTTP method", () => {
  const text = `paths:
  /webhooks:
    post:
      requestBody:
        content:
          application/json:
            schema:
              properties:
                get: { type: string }
                delete: { type: boolean }
      responses:
        '200': { description: OK }
`;
  assert.deepEqual(parseOpenApiOperations(text), [{ method: "POST", path: "/webhooks" }]);
});

test("parseOpenApiOperations: parses JSON OpenAPI documents", () => {
  const doc = JSON.stringify({ paths: { "/veiculos": { get: {}, post: {} } } });
  assert.deepEqual(parseOpenApiOperations(doc), [
    { method: "GET", path: "/veiculos" },
    { method: "POST", path: "/veiculos" },
  ]);
});

test("parseOpenApiOperations: never throws on empty/malformed input", () => {
  assert.deepEqual(parseOpenApiOperations(""), []);
  assert.deepEqual(parseOpenApiOperations(undefined), []);
  assert.deepEqual(parseOpenApiOperations("openapi: 3.1.0\ninfo:\n  title: X\n"), []);
});

test("normalizeOperationKey: generalizes path params regardless of the name used", () => {
  assert.equal(
    normalizeOperationKey("get", "/ordens-servico/{id}"),
    normalizeOperationKey("GET", "/ordens-servico/{orcamentoId}"),
  );
});

test("parseOperationRef: returns null for the scaffold placeholder", () => {
  assert.equal(parseOperationRef("TBD"), null);
  assert.deepEqual(parseOperationRef("GET /ordens-servico/{id}"), { method: "GET", path: "/ordens-servico/{id}" });
});

// --- validateContractCoverage — positive/negative/degradation --------------

test("validateContractCoverage: reproduces the real OficinaAI defect — a list screen with no matching operation is a gap", () => {
  const uiDataMap = {
    screens: [
      { id: "painel-os-kanban", reads: [{ operation: "GET /ordens-servico", scope: "list" }], writes: [] },
      { id: "detalhe-os", reads: [{ operation: "GET /ordens-servico/{id}", scope: "detail" }], writes: [{ operation: "PUT /ordens-servico/{id}" }] },
    ],
  };
  const result = validateContractCoverage(uiDataMap, SAMPLE_CONTRACT);
  assert.equal(result.applicable, true);
  assert.equal(result.ok, false);
  assert.deepEqual(result.gaps, [{ screenId: "painel-os-kanban", operation: "GET /ordens-servico", reason: "NO_MATCHING_CONTRACT_OPERATION" }]);
});

test("validateContractCoverage: passes when every screen operation matches", () => {
  const uiDataMap = { screens: [{ id: "detalhe-os", reads: [{ operation: "GET /ordens-servico/{id}", scope: "detail" }], writes: [] }] };
  const result = validateContractCoverage(uiDataMap, SAMPLE_CONTRACT);
  assert.equal(result.ok, true);
  assert.deepEqual(result.gaps, []);
});

test("validateContractCoverage: degrades to applicable:false for a non-REST format instead of a silent pass", () => {
  const result = validateContractCoverage({ screens: [] }, "", { format: "graphql" });
  assert.equal(result.applicable, false);
  assert.match(result.reason, /CONTRACT_FORMAT_NOT_PARSEABLE/);
});

// --- CLI round-trip ---------------------------------------------------------

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "contract-coverage-cli-test-"));
  roots.push(root);
  return root;
}
test.after(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", windowsHide: true });
}

test("CLI: exits 0 with ok:true when every screen operation matches the contract", () => {
  const dir = fixture();
  const contractFile = join(dir, "openapi.yaml");
  const mapFile = join(dir, "ui-data-map.json");
  writeFileSync(contractFile, SAMPLE_CONTRACT);
  writeFileSync(mapFile, JSON.stringify({ screens: [{ id: "detalhe-os", reads: [{ operation: "GET /ordens-servico/{id}", scope: "detail" }], writes: [] }] }));

  const result = run(["--ui-data-map", mapFile, "--contract", contractFile]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.applicable, true);
});

test("CLI: exits 1 with CONTRACT_COVERAGE_GAP and the exact missing operation when a screen has no matching operation", () => {
  const dir = fixture();
  const contractFile = join(dir, "openapi.yaml");
  const mapFile = join(dir, "ui-data-map.json");
  writeFileSync(contractFile, SAMPLE_CONTRACT);
  writeFileSync(mapFile, JSON.stringify({ screens: [{ id: "painel-os-kanban", reads: [{ operation: "GET /ordens-servico", scope: "list" }], writes: [] }] }));

  const result = run(["--ui-data-map", mapFile, "--contract", contractFile]);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "CONTRACT_COVERAGE_GAP");
  assert.deepEqual(parsed.error.details.gaps, [{ screenId: "painel-os-kanban", operation: "GET /ordens-servico", reason: "NO_MATCHING_CONTRACT_OPERATION" }]);
});

test("CLI: exits 0 (never a false failure) when --ui-data-map is omitted — degrades to not-applicable", () => {
  const dir = fixture();
  const result = run(["--contract", join(dir, "openapi.yaml")]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.applicable, false);
});

test("CLI: exits 0 when the ui-data-map file does not exist — degrades to not-applicable, never a crash", () => {
  const dir = fixture();
  const result = run(["--ui-data-map", join(dir, "does-not-exist.json"), "--contract", join(dir, "openapi.yaml")]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).applicable, false);
});

test("CLI: exits 0 (not-applicable) when --contract is omitted but a ui-data-map exists — never a crash, the gap is surfaced not swallowed", () => {
  const dir = fixture();
  const mapFile = join(dir, "ui-data-map.json");
  writeFileSync(mapFile, JSON.stringify({ screens: [{ id: "s1", reads: [{ operation: "GET /x", scope: "list" }], writes: [] }] }));
  const result = run(["--ui-data-map", mapFile]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.applicable, false);
  assert.match(parsed.reason, /NO_CONTRACT/);
});

test("CLI matches the real OficinaAI openapi.yaml behavior via a fixture mirroring its actual structure", () => {
  // A representative excerpt of the real file's shape (2-space path indent,
  // 4-space method indent, deep response schemas) — the run this gate exists
  // to catch had these 4 operations but no GET /ordens-servico (list).
  const dir = fixture();
  const contractFile = join(dir, "openapi.yaml");
  const mapFile = join(dir, "ui-data-map.json");
  writeFileSync(contractFile, `paths:
  /platform/tenants:
    post:
      responses:
        '201': { description: Created }
  /public/{subdominio}/servicos-fixos:
    get:
      responses:
        '200': { description: OK }
  /ordens-servico/{id}/vistoria-entrada:
    post:
      responses:
        '200': { description: OK }
  /orcamentos/{id}/itens/{itemId}/aprovacao:
    put:
      responses:
        '200': { description: OK }
components:
  schemas: {}
`);
  writeFileSync(mapFile, JSON.stringify({
    screens: [
      { id: "painel-os-kanban", reads: [{ operation: "GET /ordens-servico", scope: "list" }], writes: [] },
      { id: "vistoria", reads: [], writes: [{ operation: "POST /ordens-servico/{id}/vistoria-entrada" }] },
    ],
  }));
  const result = run(["--ui-data-map", mapFile, "--contract", contractFile]);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.error.details.contractOperationCount, 4);
  assert.deepEqual(parsed.error.details.gaps.map((g) => g.screenId), ["painel-os-kanban"]);
});
