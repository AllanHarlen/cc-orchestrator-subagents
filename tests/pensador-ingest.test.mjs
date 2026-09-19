/**
 * Ingestao do handoff do Pensador (WF-011): descobre `.pensador/<slug>-vN/`,
 * escolhe a maior versao por slug, detecta ambiguidade entre slugs
 * distintos, cai para o fallback legado `.pensador-progress.json`, e
 * degrada para modo independente quando nada valida.
 *
 * Antes desta implementacao, esse algoritmo existia so como prosa em
 * `references/workflow.md` secao 1.0 — nenhum codigo o executava.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  ingestPensadorHandoff,
  inspectDataContractArtifacts,
  inspectVisualHandoff,
  listPensadorHandoffs,
} from "../skills/orchestrator-multi-agent-development/scripts/lib/pensador-ingest.mjs";
import { initRun } from "../skills/orchestrator-multi-agent-development/scripts/lib/orchestration-state.mjs";

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pensador-ingest-test-"));
  roots.push(root);
  return root;
}
test.afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

function writeJson(path, data) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data, null, 2), "utf8");
}

function baseHandoff(slug, status = "DONE") {
  return {
    handoffVersion: 1,
    stage: "pensador",
    slug,
    producer: { plugin: "cc-pensador", version: "1.0.0" },
    artifactRoot: `.pensador/${slug}-v1`,
    status,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    summary: "pensador done",
    upstream: null,
    artifacts: [],
    nextStage: null,
  };
}

test("returns standalone mode when no .pensador/ directory exists", () => {
  const root = fixture();
  const result = ingestPensadorHandoff({ projectRoot: root });
  assert.equal(result.mode, "standalone");
  assert.ok(result.warning);
});

test("detects joint mode from a single slug/version handoff.json", () => {
  const root = fixture();
  writeJson(join(root, ".pensador/login-social-v1/handoff.json"), baseHandoff("login-social"));

  const result = ingestPensadorHandoff({ projectRoot: root });
  assert.equal(result.mode, "joint");
  assert.equal(result.slug, "login-social");
  assert.equal(result.version, 1);
  assert.ok(result.pensadorHandoff);
});

test("picks the highest version among several -vN directories for the same slug", () => {
  const root = fixture();
  writeJson(join(root, ".pensador/checkout-v1/handoff.json"), baseHandoff("checkout"));
  writeJson(join(root, ".pensador/checkout-v3/handoff.json"), baseHandoff("checkout"));
  writeJson(join(root, ".pensador/checkout-v2/handoff.json"), baseHandoff("checkout"));

  const result = ingestPensadorHandoff({ projectRoot: root });
  assert.equal(result.mode, "joint");
  assert.equal(result.version, 3);
});

test("returns ambiguous mode when multiple distinct slugs exist without an explicit slug", () => {
  const root = fixture();
  writeJson(join(root, ".pensador/login-social-v1/handoff.json"), baseHandoff("login-social"));
  writeJson(join(root, ".pensador/checkout-v1/handoff.json"), baseHandoff("checkout"));

  const result = ingestPensadorHandoff({ projectRoot: root });
  assert.equal(result.mode, "ambiguous");
  assert.deepEqual([...result.slugCandidates].sort(), ["checkout", "login-social"]);
});

test("an explicit slug selects that slug even when other slugs exist", () => {
  const root = fixture();
  writeJson(join(root, ".pensador/login-social-v1/handoff.json"), baseHandoff("login-social"));
  writeJson(join(root, ".pensador/checkout-v1/handoff.json"), baseHandoff("checkout"));

  const result = ingestPensadorHandoff({ projectRoot: root, slug: "checkout" });
  assert.equal(result.mode, "joint");
  assert.equal(result.slug, "checkout");
});

test("an explicit slug with no matching directory degrades to standalone", () => {
  const root = fixture();
  writeJson(join(root, ".pensador/login-social-v1/handoff.json"), baseHandoff("login-social"));

  const result = ingestPensadorHandoff({ projectRoot: root, slug: "does-not-exist" });
  assert.equal(result.mode, "standalone");
});

test("falls back to legacy .pensador-progress.json when handoff.json is absent", () => {
  const root = fixture();
  writeJson(join(root, ".pensador/login-social-v1/.pensador-progress.json"), {
    checkpointVersion: 2,
    artifacts: [{ kind: "prd", path: "prd.md" }],
  });

  const result = ingestPensadorHandoff({ projectRoot: root, slug: "login-social" });
  assert.equal(result.mode, "joint");
  assert.ok(result.legacyProgress);
  assert.equal(result.pensadorHandoff, null);
  assert.match(result.warning, /legacy/i);
});

// N-14-style regression: a corrupt v2 handoff.json must not mask a usable
// legacy fallback in the same versioned directory.
test("falls back to legacy progress when handoff.json is present but corrupt", () => {
  const root = fixture();
  writeJson(join(root, ".pensador/login-social-v1/handoff.json"), "{ not valid json");
  writeJson(join(root, ".pensador/login-social-v1/.pensador-progress.json"), {
    checkpointVersion: 2,
    artifacts: [{ kind: "prd", path: "prd.md" }],
  });

  const result = ingestPensadorHandoff({ projectRoot: root, slug: "login-social" });
  assert.equal(result.mode, "joint");
  assert.ok(result.legacyProgress);
});

test("degrades to standalone when handoff.json is invalid and no legacy fallback exists", () => {
  const root = fixture();
  writeJson(join(root, ".pensador/login-social-v1/handoff.json"), "{ not valid json");

  const result = ingestPensadorHandoff({ projectRoot: root, slug: "login-social" });
  assert.equal(result.mode, "standalone");
  assert.ok(result.invalidHandoff);
});

test("degrades to standalone when handoff has an unsupported handoffVersion and no legacy fallback exists", () => {
  const root = fixture();
  writeJson(join(root, ".pensador/login-social-v1/handoff.json"), {
    handoffVersion: 99,
    stage: "pensador",
    slug: "login-social",
  });

  const result = ingestPensadorHandoff({ projectRoot: root, slug: "login-social" });
  assert.equal(result.mode, "standalone");
});

/* -------------------------------------------------------------------------- */
/* listPensadorHandoffs (subcomando /orquestrador brain-pensador)              */
/* -------------------------------------------------------------------------- */

test("listPensadorHandoffs: empty when .pensador/ does not exist", () => {
  const root = fixture();
  assert.deepEqual(listPensadorHandoffs({ projectRoot: root }), []);
});

test("listPensadorHandoffs: one row per slug, using the highest -vN", () => {
  const root = fixture();
  writeJson(join(root, ".pensador/oficina-v1/handoff.json"), baseHandoff("oficina", "DONE"));
  writeJson(join(root, ".pensador/oficina-v2/handoff.json"), {
    ...baseHandoff("oficina", "DONE"),
    artifactRoot: ".pensador/oficina-v2",
  });

  const rows = listPensadorHandoffs({ projectRoot: root });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].slug, "oficina");
  assert.equal(rows[0].latestVersion, 2);
  assert.deepEqual(rows[0].versions, [2, 1]);
  assert.equal(rows[0].artifactRoot, ".pensador/oficina-v2");
  assert.equal(rows[0].handoffPath, ".pensador/oficina-v2/handoff.json");
  assert.equal(rows[0].handoffValid, true);
});

test("listPensadorHandoffs: exposes status, summary, deliverable and design-system presence", () => {
  const root = fixture();
  const handoff = {
    ...baseHandoff("locadora", "PARTIAL"),
    artifactMode: "spec",
    summary: "US-13 (checkout publico) nao gera venda real.",
    artifacts: [
      { role: "prd", path: "prd.md", required: true },
      { role: "design-system-files", path: "design-systems/professional/", required: false },
    ],
  };
  writeJson(join(root, ".pensador/locadora-v1/handoff.json"), handoff);

  const [row] = listPensadorHandoffs({ projectRoot: root });
  assert.equal(row.status, "PARTIAL");
  assert.equal(row.summary, "US-13 (checkout publico) nao gera venda real.");
  assert.equal(row.deliverable, "spec");
  assert.equal(row.hasDesignSystem, true);
});

test("listPensadorHandoffs: a slug with an invalid handoff.json still lists, with handoffValid: false", () => {
  const root = fixture();
  writeJson(join(root, ".pensador/quebrado-v1/handoff.json"), "{ not valid json");

  const [row] = listPensadorHandoffs({ projectRoot: root });
  assert.equal(row.slug, "quebrado");
  assert.equal(row.handoffValid, false);
  assert.equal(row.status, null);
});

test("listPensadorHandoffs: orders by recency (mtime of the chosen versioned dir), most recent first", () => {
  const root = fixture();
  writeJson(join(root, ".pensador/antigo-v1/handoff.json"), baseHandoff("antigo"));
  writeJson(join(root, ".pensador/recente-v1/handoff.json"), baseHandoff("recente"));

  const old = new Date("2020-01-01T00:00:00Z");
  const recent = new Date("2026-01-01T00:00:00Z");
  utimesSync(join(root, ".pensador/antigo-v1"), old, old);
  utimesSync(join(root, ".pensador/recente-v1"), recent, recent);

  const rows = listPensadorHandoffs({ projectRoot: root });
  assert.deepEqual(rows.map((r) => r.slug), ["recente", "antigo"]);
});

test("listPensadorHandoffs: --limit caps the result, --all removes the cap", () => {
  const root = fixture();
  for (let i = 0; i < 3; i += 1) {
    writeJson(join(root, `.pensador/slug-${i}-v1/handoff.json`), baseHandoff(`slug-${i}`));
  }
  assert.equal(listPensadorHandoffs({ projectRoot: root, limit: 2 }).length, 2);
  assert.equal(listPensadorHandoffs({ projectRoot: root, all: true }).length, 3);
});

test("listPensadorHandoffs: consumedBy is null until a run's state.upstream.handoffPath matches it", () => {
  const root = fixture();
  writeJson(join(root, ".pensador/oficina-v1/handoff.json"), baseHandoff("oficina"));

  const before = listPensadorHandoffs({ projectRoot: root });
  assert.equal(before[0].consumedBy, null);

  const artifactDir = join(root, ".orchestration", "oficina");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, "tasks-classification.md"), "# Tasks\n\n## BE-01\n- category: BACKEND_ONLY\n", "utf8");
  writeFileSync(join(artifactDir, "waves.md"), "# Waves\n\n## Wave 1\n- BE-01\n", "utf8");
  initRun({
    projectRoot: root,
    artifactDir,
    slug: "oficina",
    runId: "oficina-001",
    upstream: {
      stage: "pensador",
      slug: "oficina",
      version: 1,
      handoffPath: ".pensador/oficina-v1/handoff.json",
    },
  });

  const after = listPensadorHandoffs({ projectRoot: root });
  assert.equal(after[0].consumedBy, "oficina-001");
});

test("listPensadorHandoffs never touches .pensador/ (read-only)", () => {
  const root = fixture();
  const handoffPath = join(root, ".pensador/oficina-v1/handoff.json");
  writeJson(handoffPath, baseHandoff("oficina"));
  const before = readFileSync(handoffPath, "utf8");
  listPensadorHandoffs({ projectRoot: root });
  const after = readFileSync(handoffPath, "utf8");
  assert.equal(before, after);
});

test("inspectVisualHandoff and ingestPensadorHandoff collect and expose brand-assets (no prototypes since cc-pensador 2.28)", () => {
  const root = fixture();
  const handoffDir = join(root, ".pensador/app-v1");
  mkdirSync(join(handoffDir, "assets"), { recursive: true });
  writeFileSync(join(handoffDir, "assets/manifest.json"), JSON.stringify({ assets: [] }), "utf8");

  const handoff = {
    ...baseHandoff("app"),
    artifacts: [
      { role: "brand-assets", path: "assets/", required: false, manifest: "assets/manifest.json", description: "Diretório de mídia e brand assets" },
    ],
  };
  const handoffPath = join(handoffDir, "handoff.json");
  writeJson(handoffPath, handoff);

  const visual = inspectVisualHandoff(handoff, handoffPath);
  assert.equal("prototypes" in visual, false);
  assert.equal(visual.brandAssets.length, 1);
  assert.equal(visual.brandAssets[0].path, "assets/");
  assert.equal(visual.brandAssets[0].manifest, "assets/manifest.json");
  assert.equal(visual.brandAssets[0].exists, true);
  assert.equal(visual.brandAssets[0].manifestExists, true);
  assert.equal(visual.brandAssets[0].description, "Diretório de mídia e brand assets");

  const ingested = ingestPensadorHandoff({ projectRoot: root });
  assert.equal(ingested.mode, "joint");
  assert.equal("prototypes" in ingested.visualPackage, false);
  assert.equal(ingested.visualPackage.brandAssets.length, 1);
  assert.equal(ingested.visualPackage.brandAssets[0].path, "assets/");
  assert.equal(ingested.visualPackage.brandAssets[0].manifestExists, true);
});

test("inspectVisualHandoff blocks a required visualImageryPlan without bound assets", () => {
  const root = fixture();
  const handoffDir = join(root, ".pensador/app-v1");
  writeJson(join(handoffDir, "project-baseline.json"), {
    visualImageryPlan: { policy: "required", provider: "agy", minimumAssets: 3, reasons: ["catalog-visual-merchandising"] },
  });
  const handoff = {
    ...baseHandoff("app"),
    artifacts: [{ role: "project-baseline", path: "project-baseline.json", required: true }],
  };
  const visual = inspectVisualHandoff(handoff, join(handoffDir, "handoff.json"));
  assert.equal(visual.visualImageryPlan.policy, "required");
  assert.equal(visual.blocking, true);
  assert.ok(visual.findings.some((finding) => finding.code === "REQUIRED_VISUAL_IMAGERY_MISSING"));
});

// A real run (OficinaAI, 2026-09-12) had a status: DONE handoff with
// design-system-files.variant "legacy-verbatim" (the DESIGN stage was
// skipped) treated as a mere warning here, so materialize-visual-handoff.mjs
// applied an unfinished design package instead of blocking Fase 4.0 as
// workflow.md already documents ("corrija na origem antes de prosseguir").
// cc-pensador >= 2.25.0 now refuses to emit DONE this way, so a DONE handoff
// with legacy-verbatim reaching this point means a stale producer version —
// defense in depth, not the primary fix.
test("inspectVisualHandoff: legacy-verbatim design on a status DONE handoff is blocking (high), not a warning", () => {
  const root = fixture();
  const handoffDir = join(root, ".pensador/app-v1");
  mkdirSync(join(handoffDir, "design-systems/bmw"), { recursive: true });
  writeFileSync(join(handoffDir, "design-systems/bmw/tokens.css"), ":root{}", "utf8");
  writeFileSync(join(handoffDir, "design-systems/bmw/DESIGN.md"), "# Design", "utf8");

  const handoff = {
    ...baseHandoff("app", "DONE"),
    artifacts: [
      { role: "design-system-files", path: "design-systems/bmw", required: true, variant: "legacy-verbatim" },
    ],
  };
  const handoffPath = join(handoffDir, "handoff.json");
  writeJson(handoffPath, handoff);

  const visual = inspectVisualHandoff(handoff, handoffPath);
  const finding = visual.findings.find((f) => f.code === "LEGACY_VERBATIM_DESIGN");
  assert.ok(finding, "expected a LEGACY_VERBATIM_DESIGN finding");
  assert.equal(finding.severity, "high");
  assert.equal(visual.blocking, true);
});

test("inspectVisualHandoff: legacy-verbatim design on a status PARTIAL handoff stays a warning (already disclosed via summary)", () => {
  const root = fixture();
  const handoffDir = join(root, ".pensador/app-v1");
  mkdirSync(join(handoffDir, "design-systems/bmw"), { recursive: true });
  writeFileSync(join(handoffDir, "design-systems/bmw/tokens.css"), ":root{}", "utf8");
  writeFileSync(join(handoffDir, "design-systems/bmw/DESIGN.md"), "# Design", "utf8");

  const handoff = {
    ...baseHandoff("app", "PARTIAL"),
    summary: "Pipeline v2.23 (prototipos/assets/auditoria) nao executado nesta rodada.",
    artifacts: [
      { role: "design-system-files", path: "design-systems/bmw", required: true, variant: "legacy-verbatim" },
    ],
  };
  const handoffPath = join(handoffDir, "handoff.json");
  writeJson(handoffPath, handoff);

  const visual = inspectVisualHandoff(handoff, handoffPath);
  const finding = visual.findings.find((f) => f.code === "LEGACY_VERBATIM_DESIGN");
  assert.ok(finding, "expected a LEGACY_VERBATIM_DESIGN finding");
  assert.equal(finding.severity, "warning");
  assert.equal(visual.blocking, false);
});

// ---------------------------------------------------------------------------
// inspectDataContractArtifacts (ui-data-map / seed-plan / surface-benchmark,
// cc-pensador >= 2.27.0)
// ---------------------------------------------------------------------------

test("inspectDataContractArtifacts: reads all three artifacts when present and valid", () => {
  const root = fixture();
  const handoffDir = join(root, ".pensador/app-v1");
  const uiDataMap = { schemaVersion: 1, screens: [{ id: "s1", reads: [], writes: [], requirementRefs: ["RF-01"], dataSource: "api-contract" }] };
  const seedPlan = { schemaVersion: 1, persistenceLayer: "database-seed", entities: [] };
  const surfaceBenchmark = { schemaVersion: 1, surfaces: [] };
  writeJson(join(handoffDir, "ui-data-map.json"), uiDataMap);
  writeJson(join(handoffDir, "seed-plan.json"), seedPlan);
  writeJson(join(handoffDir, "surface-benchmark.json"), surfaceBenchmark);

  const handoff = {
    ...baseHandoff("app"),
    artifacts: [
      { role: "ui-data-map", path: "ui-data-map.json", required: true },
      { role: "seed-plan", path: "seed-plan.json", required: true },
      { role: "surface-benchmark", path: "surface-benchmark.json", required: false },
    ],
  };
  const handoffPath = join(handoffDir, "handoff.json");
  writeJson(handoffPath, handoff);

  const result = inspectDataContractArtifacts(handoff, handoffPath);
  assert.deepEqual(result.uiDataMap, uiDataMap);
  assert.deepEqual(result.seedPlan, seedPlan);
  assert.deepEqual(result.surfaceBenchmark, surfaceBenchmark);
  assert.deepEqual(result.findings, []);
});

test("inspectDataContractArtifacts: a declared but missing ui-data-map/seed-plan is a high-severity finding", () => {
  const root = fixture();
  const handoffDir = join(root, ".pensador/app-v1");
  const handoff = {
    ...baseHandoff("app"),
    artifacts: [
      { role: "ui-data-map", path: "ui-data-map.json", required: true },
      { role: "seed-plan", path: "seed-plan.json", required: true },
    ],
  };
  const handoffPath = join(handoffDir, "handoff.json");
  writeJson(handoffPath, handoff);

  const result = inspectDataContractArtifacts(handoff, handoffPath);
  assert.equal(result.uiDataMap, null);
  assert.equal(result.seedPlan, null);
  assert.deepEqual(new Set(result.findings.map((f) => f.code)), new Set(["UI_DATA_MAP_MISSING", "SEED_PLAN_MISSING"]));
  assert.ok(result.findings.every((f) => f.severity === "high"));
});

test("inspectDataContractArtifacts: a missing surface-benchmark is only a warning (not every project has a conversion/catalog surface)", () => {
  const root = fixture();
  const handoffDir = join(root, ".pensador/app-v1");
  const handoff = { ...baseHandoff("app"), artifacts: [{ role: "surface-benchmark", path: "surface-benchmark.json", required: false }] };
  const handoffPath = join(handoffDir, "handoff.json");
  writeJson(handoffPath, handoff);

  const result = inspectDataContractArtifacts(handoff, handoffPath);
  assert.deepEqual(result.findings, [{ severity: "warning", code: "SURFACE_BENCHMARK_MISSING", path: result.surfaceBenchmarkPath }]);
});

test("inspectDataContractArtifacts: no roles declared at all (backend/frontend-less or pre-2.27.0 handoff) returns null fields, no findings", () => {
  const root = fixture();
  const handoffDir = join(root, ".pensador/app-v1");
  const handoff = { ...baseHandoff("app"), artifacts: [] };
  const handoffPath = join(handoffDir, "handoff.json");
  writeJson(handoffPath, handoff);

  const result = inspectDataContractArtifacts(handoff, handoffPath);
  assert.equal(result.uiDataMap, null);
  assert.equal(result.seedPlan, null);
  assert.equal(result.surfaceBenchmark, null);
  assert.deepEqual(result.findings, []);
});

test("ingestPensadorHandoff exposes dataContract alongside visualPackage in joint mode", () => {
  const root = fixture();
  const handoffDir = join(root, ".pensador/app-v1");
  writeJson(join(handoffDir, "ui-data-map.json"), { schemaVersion: 1, screens: [] });
  const handoff = { ...baseHandoff("app"), artifacts: [{ role: "ui-data-map", path: "ui-data-map.json", required: true }] };
  writeJson(join(handoffDir, "handoff.json"), handoff);

  const result = ingestPensadorHandoff({ projectRoot: root });
  assert.equal(result.mode, "joint");
  assert.ok(result.dataContract);
  assert.deepEqual(result.dataContract.uiDataMap, { schemaVersion: 1, screens: [] });
});


test("inspectVisualHandoff blocks the removed ui-prototype role with LEGACY_UI_PROTOTYPE_ROLE", () => {
  const root = fixture();
  const handoffDir = join(root, ".pensador/app-v1");
  mkdirSync(join(handoffDir, "prototypes"), { recursive: true });
  const handoff = {
    ...baseHandoff("app"),
    artifacts: [{ role: "ui-prototype", path: "prototypes/", required: false, description: "legacy" }],
  };
  const handoffPath = join(handoffDir, "handoff.json");
  writeJson(handoffPath, handoff);

  const visual = inspectVisualHandoff(handoff, handoffPath);
  const finding = visual.findings.find((f) => f.code === "LEGACY_UI_PROTOTYPE_ROLE");
  assert.ok(finding);
  assert.equal(finding.severity, "critical");
  assert.match(finding.message, /2\.32/);
  assert.equal("prototypes" in visual, false);
});
