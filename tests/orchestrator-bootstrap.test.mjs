import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { bootstrapOrchestrator } from "../skills/orchestrator-multi-agent-development/scripts/orchestrator-bootstrap.mjs";
import { contractSha256 } from "../skills/orchestrator-multi-agent-development/scripts/lib/design-contract-hash.mjs";
import { materializeVisualHandoff } from "../skills/orchestrator-multi-agent-development/scripts/materialize-visual-handoff.mjs";

const roots = [];
test.afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-bootstrap-"));
  roots.push(root);
  return root;
}

function preflight(source = "file", status = "ok") {
  return {
    status,
    generatedAt: "2026-09-11T00:00:00.000Z",
    projectConfig: { source, path: ".orchestrator/project-config.md", roles: {}, requiredCliSet: ["codex", "agy"] },
    failed: status === "ok" ? [] : [{ name: "agy", error: "unavailable" }],
  };
}

function writeResolvedHandoff(root, slug = "oficina") {
  const feature = join(root, ".pensador", `${slug}-v1`);
  const resolved = join(feature, "design-systems", "agentic", "resolved");
  const asset = Buffer.from("image-content");
  mkdirSync(join(resolved, "assets", "generated"), { recursive: true });
  for (const file of ["design-tokens.json", "provenance.json"]) writeFileSync(join(resolved, file), "{}\n");
  const contractBody = { version: "2.0.0", system: "agentic", themes: { light: {}, dark: {} } };
  const contractHash = contractSha256(contractBody);
  writeFileSync(join(resolved, "design-contract.json"), JSON.stringify({ ...contractBody, sha256: contractHash }, null, 2));
  writeFileSync(join(resolved, "tokens.css"), ":root{}\n");
  writeFileSync(join(resolved, "DESIGN.md"), "# Design\n");
  writeFileSync(join(resolved, "components.html"), "<button>OK</button>\n");
  mkdirSync(join(resolved, "preview"), { recursive: true });
  writeFileSync(join(resolved, "preview", "index.html"), "<main>Preview</main>\n");
  writeFileSync(join(resolved, "assets", "generated", "service.webp"), asset);
  writeFileSync(join(resolved, "assets", "generated", "hero.webp"), asset);
  writeFileSync(join(resolved, "assets", "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    assets: [{
      id: "service", purpose: "seed-demo", classification: "required", requirementRefs: ["RF-001"], routes: ["/services"],
      componentSlot: "services.card.image", file: "generated/service.webp", aspectRatio: "4:3",
      alt: "Servico automotivo", materializeInto: "apps/web/public/assets/service.webp",
      seedBindings: ["ServicoFixo:Alinhamento"], approval: "approved",
      sha256: createHash("sha256").update(asset).digest("hex"), generator: { agent: "agy" },
    }, {
      id: "hero", purpose: "content", classification: "required", requirementRefs: ["RF-002"], routes: ["/"],
      componentSlot: "home.hero.image", file: "generated/hero.webp", aspectRatio: "16:9",
      alt: "Oficina em operacao", materializeInto: "apps/web/public/assets/hero.webp",
      seedBindings: [], approval: "approved",
      sha256: createHash("sha256").update(asset).digest("hex"), generator: { agent: "agy" },
    }],
  }, null, 2));
  writeFileSync(join(resolved, "design-audit.json"), JSON.stringify({ status: "PASS", contractSha256: contractHash, findings: [] }));
  const handoff = {
    handoffVersion: 1, stage: "pensador", slug,
    producer: { plugin: "cc-pensador", version: "2.22.0" }, artifactRoot: `.pensador/${slug}-v1`, status: "DONE",
    createdAt: "2026-09-11T00:00:00.000Z", updatedAt: "2026-09-11T00:00:00.000Z", summary: "ready", upstream: null,
    artifacts: [{
      role: "design-system-files", path: "design-systems/agentic/resolved", required: true,
      variant: "resolved", authoritative: true, sourcePath: "design-systems/agentic/original/",
      materializeInto: "apps/web/styles/design-systems/agentic/", assetsManifest: "assets/manifest.json",
      validation: { status: "PASS", audit: "design-audit.json" },
    }],
    nextStage: null,
  };
  writeFileSync(join(feature, "handoff.json"), JSON.stringify(handoff, null, 2));
  return { handoffPath: join(feature, "handoff.json"), resolved };
}

test("bootstrap has deterministic terminal states and ingests handoff before requesting a specification", () => {
  const root = fixture();
  assert.equal(bootstrapOrchestrator({ projectRoot: root, preflightReport: preflight("default") }).status, "NEEDS_PROJECT_CONFIG");
  assert.equal(bootstrapOrchestrator({ projectRoot: root, preflightReport: preflight("file", "failed") }).status, "BLOCKED_DEPENDENCY");
  assert.equal(bootstrapOrchestrator({ projectRoot: root, preflightReport: preflight(), hasSpecification: false }).status, "NEEDS_SPECIFICATION");
  assert.equal(bootstrapOrchestrator({ projectRoot: root, preflightReport: preflight(), hasSpecification: true }).status, "READY_STANDALONE");
  writeResolvedHandoff(root);
  const joint = bootstrapOrchestrator({ projectRoot: root, preflightReport: preflight() });
  assert.equal(joint.status, "READY_JOINT");
  assert.equal(joint.nextAction, "LOAD_WORKFLOW");
  assert.equal(joint.projectConfig.requiredCliSet.join(","), "codex,agy");
});

test("multiple handoffs ask only for slug selection", () => {
  const root = fixture();
  writeResolvedHandoff(root, "oficina");
  writeResolvedHandoff(root, "checkout");
  const result = bootstrapOrchestrator({ projectRoot: root, preflightReport: preflight() });
  assert.equal(result.status, "AMBIGUOUS_HANDOFF");
  assert.equal(result.nextAction, "SELECT_SLUG");
});

test("materializer copies only the authoritative resolved package and its declared assets", () => {
  const root = fixture();
  const { handoffPath } = writeResolvedHandoff(root);
  const dry = materializeVisualHandoff({ projectRoot: root, handoffPath, apply: false });
  assert.equal(dry.status, "PASS");
  assert.equal(dry.applied, false);
  const applied = materializeVisualHandoff({ projectRoot: root, handoffPath, apply: true });
  assert.equal(applied.status, "PASS");
  assert.equal(readFileSync(join(root, "apps/web/public/assets/service.webp"), "utf8"), "image-content");
  assert.equal(readFileSync(join(root, "apps/web/public/assets/hero.webp"), "utf8"), "image-content");
  assert.equal(readFileSync(join(root, "apps/web/styles/design-systems/agentic/tokens.css"), "utf8"), ":root{}\n");
  const assetOperation = applied.operations.find((operation) => operation.type === "asset" && operation.id === "service");
  assert.deepEqual(assetOperation.seedBindings, ["ServicoFixo:Alinhamento"]);
  assert.equal(assetOperation.destination, join(root, "apps/web/public/assets/service.webp"));
  assert.equal(assetOperation.applied, true);
  const staticOperation = applied.operations.find((operation) => operation.type === "asset" && operation.id === "hero");
  assert.deepEqual(staticOperation.seedBindings, []);
  assert.equal(staticOperation.applied, true);
});

test("materializer rejects a seed/demo image without seedBindings but accepts static required imagery", () => {
  const root = fixture();
  const { handoffPath, resolved } = writeResolvedHandoff(root, "seed-bindings");
  const manifestPath = join(resolved, "assets", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.assets.find((asset) => asset.id === "service").seedBindings = [];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const result = materializeVisualHandoff({ projectRoot: root, handoffPath, apply: false });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.findings.some((finding) => finding.code === "ASSET_BINDING_INCOMPLETE" && finding.assetId === "service"));
});

function rewriteAudit(resolved, patch) {
  const file = join(resolved, "design-audit.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...patch }));
}

test("materializer distrusts the handoff's validation.status: the audit on disk decides", () => {
  const root = fixture();
  const { handoffPath, resolved } = writeResolvedHandoff(root, "audit-blocked");
  rewriteAudit(resolved, { status: "BLOCKED" });
  const result = materializeVisualHandoff({ projectRoot: root, handoffPath, apply: false });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.findings.some((finding) => finding.code === "DESIGN_AUDIT_NOT_PASS"));
});

test("materializer blocks a missing design-audit.json even when the handoff claims validation PASS", () => {
  const root = fixture();
  const { handoffPath, resolved } = writeResolvedHandoff(root, "audit-missing");
  rmSync(join(resolved, "design-audit.json"));
  const result = materializeVisualHandoff({ projectRoot: root, handoffPath, apply: false });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.findings.some((finding) => finding.code === "DESIGN_AUDIT_MISSING"));
});

test("materializer blocks a contract edited after the audit (hash mismatch, critical) and copies nothing", () => {
  const root = fixture();
  const { handoffPath, resolved } = writeResolvedHandoff(root, "hash-drift");
  const file = join(resolved, "design-contract.json");
  const contract = JSON.parse(readFileSync(file, "utf8"));
  contract.themes.light["--accent"] = "#ff0000";
  writeFileSync(file, JSON.stringify(contract, null, 2));
  const result = materializeVisualHandoff({ projectRoot: root, handoffPath, apply: true });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.applied, false);
  assert.ok(result.findings.some((finding) => finding.code === "CONTRACT_HASH_MISMATCH" && finding.severity === "critical"));
});

test("materializer blocks when the handoff's contractSha256 disagrees with the recomputed hash", () => {
  const root = fixture();
  const { handoffPath } = writeResolvedHandoff(root, "handoff-hash");
  const handoff = JSON.parse(readFileSync(handoffPath, "utf8"));
  handoff.artifacts[0].contractSha256 = "0".repeat(64);
  writeFileSync(handoffPath, JSON.stringify(handoff));
  const result = materializeVisualHandoff({ projectRoot: root, handoffPath, apply: false });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.findings.some((finding) => finding.code === "CONTRACT_HASH_MISMATCH" && finding.source === "handoff"));
});

test("materializer blocks a contract that does not carry its own sha256", () => {
  const root = fixture();
  const { handoffPath, resolved } = writeResolvedHandoff(root, "no-hash");
  writeFileSync(join(resolved, "design-contract.json"), "{}\n");
  const result = materializeVisualHandoff({ projectRoot: root, handoffPath, apply: false });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.findings.some((finding) => finding.code === "CONTRACT_HASH_MISSING"));
});

test("contractSha256 matches the cc-pensador serialization (sorted keys, sha256 excluded)", () => {
  const a = contractSha256({ b: 1, a: { d: 2, c: 3 }, sha256: "x" });
  const b = contractSha256({ a: { c: 3, d: 2 }, b: 1 });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});
