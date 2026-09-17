import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { validateHandoff } from "./handoff-validator.mjs";

/**
 * Ingestao de upstream do Pensador (WF-011): descobre e le o handoff em
 * `.pensador/<slug>-vN/handoff.json` para determinar o modo de operacao
 * (conjunto vs independente).
 *
 * Antes desta implementacao, o algoritmo abaixo existia apenas como prosa em
 * `references/workflow.md` secao 1.0 — nenhum codigo o executava. Porta o
 * mesmo padrao que `cc-testador-subagents`'s `upstream-ingest.mjs` ja usa:
 * probe ordenado, deteccao de ambiguidade, fallback legado, degradacao
 * explicita quando nada valida.
 *
 * Ordem de descoberta:
 * 1. Escaneia `.pensador/` por diretorios `<slug>-vN/`.
 * 2. Sem slug explicito e mais de um slug distinto -> `mode: "ambiguous"`.
 * 3. Entre versoes do mesmo slug, usa a maior `-vN`.
 * 4. `handoff.json` presente e valido -> `mode: "joint"`.
 * 5. `handoff.json` ausente ou invalido -> fallback para
 *    `.pensador-progress.json` (`checkpointVersion: 2`) dentro do mesmo
 *    diretorio versionado.
 * 6. Nada disso resolve -> `mode: "standalone"` com aviso.
 *
 * Regra absoluta: NUNCA escreve em `.pensador/`. Apenas le.
 */

export class PensadorIngestError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "PensadorIngestError";
    this.code = code;
    this.details = details;
  }
}

function readHandoffSafe(path) {
  if (!existsSync(path)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { handoff: null, valid: false, version_mismatch: false, errors: [{ code: "HANDOFF_INVALID_JSON", message: error.message }], path };
  }
  const result = validateHandoff(raw);
  if (!result.ok) {
    const first = result.errors[0];
    return {
      handoff: raw,
      valid: false,
      version_mismatch: first?.code === "UNSUPPORTED_HANDOFF_VERSION",
      errors: result.errors,
      path,
    };
  }
  return { handoff: raw, valid: true, version_mismatch: false, errors: [], path };
}

/** Resolves additive v1 visual handoff fields and marks older entries explicitly. */
export function inspectVisualHandoff(handoff, handoffPath) {
  const handoffDir = dirname(handoffPath);
  const declaredRoot = String(handoff.artifactRoot ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  const declaredSegments = declaredRoot.split("/").filter(Boolean);
  const projectRoot = declaredSegments.length > 0
    ? resolve(handoffDir, ...declaredSegments.map(() => ".."))
    : resolve(handoffDir, "..", "..");
  const resolveArtifactRoot = (artifactPath) => {
    const normalized = String(artifactPath ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
    if (declaredRoot && (normalized === declaredRoot || normalized.startsWith(`${declaredRoot}/`))) {
      return resolve(projectRoot, normalized);
    }
    return resolve(handoffDir, normalized);
  };
  const packages = [];
  const findings = [];
  const prototypes = [];
  const brandAssets = [];
  const baselineArtifact = (handoff.artifacts ?? []).find((artifact) => artifact?.role === "project-baseline");
  let projectBaseline = null;
  if (baselineArtifact) {
    const baselinePath = resolveArtifactRoot(baselineArtifact.path);
    try { projectBaseline = JSON.parse(readFileSync(baselinePath, "utf8")); }
    catch { findings.push({ severity: "high", code: "PROJECT_BASELINE_INVALID", path: baselinePath }); }
  }
  for (const artifact of handoff.artifacts ?? []) {
    if (artifact?.role === "ui-prototype") {
      const prototypeRoot = resolveArtifactRoot(artifact.path);
      prototypes.push({
        path: artifact.path,
        resolvedPath: prototypeRoot,
        exists: existsSync(prototypeRoot),
        description: artifact.description,
      });
      continue;
    }
    if (artifact?.role === "brand-assets") {
      const assetRoot = resolveArtifactRoot(artifact.path);
      const manifestPath = artifact.manifest
        ? resolveArtifactRoot(artifact.manifest)
        : join(assetRoot, "manifest.json");
      brandAssets.push({
        path: artifact.path,
        manifest: artifact.manifest ?? "assets/manifest.json",
        resolvedPath: assetRoot,
        manifestPath,
        exists: existsSync(assetRoot),
        manifestExists: existsSync(manifestPath),
        description: artifact.description,
      });
      continue;
    }
    if (artifact?.role !== "design-system-files") continue;
    const variant = artifact.variant ?? "legacy-verbatim";
    const packageRoot = resolveArtifactRoot(artifact.path);
    const priorityFiles = variant === "resolved"
      ? ["design-contract.json", "tokens.css", "DESIGN.md", artifact.assetsManifest ?? "assets/manifest.json"]
      : ["tokens.css", "DESIGN.md"];
    if (variant === "legacy-verbatim") {
      // Blocking when the upstream handoff claims status: DONE — the Pensador's
      // own gate (cc-pensador >= 2.25.0, validateVisualCompleteness()) now
      // refuses to emit DONE with an unresolved design package, so a DONE
      // handoff reaching this point with legacy-verbatim only happens from a
      // stale/pre-fix producer version. A real run (OficinaAI, 2026-09-12)
      // materialized exactly this — legacy-verbatim, status DONE, no waiver —
      // as a mere warning, and the Fase 4.0 gate let front-end tasks dispatch
      // against a design package that was never audited or completed.
      // PARTIAL/BLOCKED already carries a mandatory summary disclosing the
      // gap (handoff-validator.mjs), so it stays informative there.
      const severity = handoff?.status === "DONE" ? "high" : "warning";
      findings.push({ severity, code: "LEGACY_VERBATIM_DESIGN", path: artifact.path, message: "Handoff has no variant; reinforced visual gates are required." });
    } else {
      if (artifact.authoritative !== true) findings.push({ severity: "high", code: "DESIGN_NOT_AUTHORITATIVE", path: artifact.path });
      if (artifact.validation?.status !== "PASS") findings.push({ severity: "high", code: "DESIGN_AUDIT_NOT_PASS", path: artifact.path });
      if (!artifact.materializeInto) findings.push({ severity: "high", code: "MATERIALIZATION_TARGET_MISSING", path: artifact.path });
    }
    for (const file of priorityFiles) {
      if (!existsSync(join(packageRoot, file))) findings.push({ severity: artifact.required === false ? "warning" : "high", code: "VISUAL_ARTIFACT_MISSING", path: `${artifact.path}/${file}` });
    }
    let assets = [];
    const manifestPath = join(packageRoot, artifact.assetsManifest ?? "assets/manifest.json");
    if (existsSync(manifestPath)) {
      try { assets = JSON.parse(readFileSync(manifestPath, "utf8")).assets ?? []; }
      catch { findings.push({ severity: "high", code: "ASSET_MANIFEST_INVALID", path: manifestPath }); }
    }
    for (const asset of assets) {
      const source = join(packageRoot, "assets", asset.file ?? "");
      if (asset.classification === "required" && !existsSync(source)) findings.push({ severity: "critical", code: "REQUIRED_ASSET_MISSING", path: source, assetId: asset.id });
      const seedAsset = asset.purpose === "seed-demo" || (Array.isArray(asset.seedBindings) && asset.seedBindings.length > 0);
      const missingSeedBinding = asset.purpose === "seed-demo" && !asset.seedBindings?.length;
      if (asset.classification === "required" && (!asset.alt || !asset.routes?.length || !asset.materializeInto || !asset.sha256 || missingSeedBinding)) {
        findings.push({ severity: "high", code: "ASSET_BINDING_INCOMPLETE", assetId: asset.id, seedAsset });
      }
      if (existsSync(source) && asset.sha256) {
        const actual = createHash("sha256").update(readFileSync(source)).digest("hex");
        if (actual !== asset.sha256) findings.push({ severity: "critical", code: "ASSET_HASH_MISMATCH", assetId: asset.id, path: source });
      }
    }
    packages.push({ variant, authoritative: artifact.authoritative === true, packageRoot, materializeInto: artifact.materializeInto, priorityFiles, assets });
  }
  const imageryPlan = projectBaseline?.visualImageryPlan ?? null;
  const boundAssets = packages.flatMap((item) => item.assets).filter((asset) =>
    asset?.purpose === "seed-demo" || (Array.isArray(asset?.seedBindings) && asset.seedBindings.length > 0));
  if (imageryPlan?.policy === "required" && boundAssets.length < Number(imageryPlan.minimumAssets ?? 1)) {
    findings.push({
      severity: "high",
      code: "REQUIRED_VISUAL_IMAGERY_MISSING",
      expected: Number(imageryPlan.minimumAssets ?? 1),
      actual: boundAssets.length,
      message: "Pensador visualImageryPlan requires AGY assets with real bindings before orchestration.",
    });
  } else if (imageryPlan?.policy === "recommended" && packages.flatMap((item) => item.assets).length === 0) {
    findings.push({ severity: "warning", code: "RECOMMENDED_VISUAL_IMAGERY_MISSING", expected: Number(imageryPlan.minimumAssets ?? 1), actual: 0 });
  }
  return {
    packages,
    prototypes,
    brandAssets,
    projectBaseline,
    visualImageryPlan: imageryPlan,
    findings,
    blocking: findings.some((item) => ["critical", "high"].includes(item.severity)),
    degraded: findings.some((item) => item.code === "LEGACY_VERBATIM_DESIGN"),
  };
}

/** Parses a `.pensador/` entry name as `<slug>-vN`, or null if it doesn't match. */
function parseVersionedSlugDir(name) {
  const match = name.match(/^(.+)-v(\d+)$/);
  if (!match) return null;
  return { slug: match[1], version: Number(match[2]), dirName: name };
}

/** Lists every `<slug>-vN/` directory under `.pensador/`. */
function discoverPensadorDirs(projectRoot) {
  const dir = join(projectRoot, ".pensador");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => parseVersionedSlugDir(entry.name))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function buildStandaloneResult(warning, extras = {}) {
  return {
    mode: "standalone",
    slug: null,
    version: null,
    pensadorHandoff: null,
    pensadorHandoffPath: null,
    legacyProgress: null,
    warning,
    ...extras,
  };
}

/**
 * Le a versao legada `.pensador-progress.json` (`checkpointVersion: 2`) de
 * dentro de um diretorio `.pensador/<slug>-vN/`. Retorna `null` se ausente,
 * malformado, ou de versao incompativel.
 */
function readLegacyProgress(versionedDir) {
  const legacyPath = join(versionedDir, ".pensador-progress.json");
  if (!existsSync(legacyPath)) return null;
  let legacy;
  try {
    legacy = JSON.parse(readFileSync(legacyPath, "utf8"));
  } catch {
    return null;
  }
  if (legacy.checkpointVersion !== 2 || !Array.isArray(legacy.artifacts)) return null;
  return { legacy, path: legacyPath };
}

/**
 * Ponto de entrada principal.
 *
 * @param {object} options
 * @param {string} options.projectRoot  Raiz do projeto.
 * @param {string} [options.slug]       Slug do handoff a ingerir. Sem slug,
 *                                      varre `.pensador/` e usa o unico
 *                                      slug distinto disponivel.
 * @returns {{
 *   mode: "joint"|"ambiguous"|"standalone",
 *   slug: string|null,
 *   version: number|null,
 *   pensadorHandoff: object|null,
 *   pensadorHandoffPath: string|null,
 *   legacyProgress: object|null,
 *   slugCandidates?: string[],
 *   warning: string|null,
 * }}
 */
export function ingestPensadorHandoff(options = {}) {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const requestedSlug = options.slug ?? null;

  const dirs = discoverPensadorDirs(projectRoot);
  if (dirs.length === 0) {
    return buildStandaloneResult("No .pensador/ directory found — running in independent mode.");
  }

  let candidates = dirs;
  if (requestedSlug) {
    candidates = dirs.filter((d) => d.slug === requestedSlug);
    if (candidates.length === 0) {
      return buildStandaloneResult(
        `No .pensador/ handoff found for slug "${requestedSlug}" — running in independent mode.`,
      );
    }
  } else {
    const distinctSlugs = [...new Set(dirs.map((d) => d.slug))];
    if (distinctSlugs.length > 1) {
      return {
        mode: "ambiguous",
        slugCandidates: distinctSlugs,
        warning: `Multiple Pensador slugs found (${distinctSlugs.join(", ")}); pass an explicit slug to select one.`,
        slug: null,
        version: null,
        pensadorHandoff: null,
        pensadorHandoffPath: null,
        legacyProgress: null,
      };
    }
  }

  // All remaining candidates share one slug — pick the highest version.
  candidates = [...candidates].sort((a, b) => b.version - a.version);
  const chosen = candidates[0];
  const versionedDir = join(projectRoot, ".pensador", chosen.dirName);
  const handoffPath = join(versionedDir, "handoff.json");

  const handoffRead = readHandoffSafe(handoffPath);
  if (handoffRead?.valid) {
    const visualPackage = inspectVisualHandoff(handoffRead.handoff, handoffPath);
    return {
      mode: "joint",
      slug: chosen.slug,
      version: chosen.version,
      pensadorHandoff: handoffRead.handoff,
      pensadorHandoffPath: handoffPath,
      legacyProgress: null,
      warning: null,
      visualPackage,
    };
  }

  // handoff.json absent, invalid, or version-mismatched: fall back to the
  // legacy checkpoint before giving up (mirrors the Testador's N-14 fix —
  // a broken v2-style artifact must not mask a still-usable legacy one).
  const legacy = readLegacyProgress(versionedDir);
  if (legacy) {
    return {
      mode: "joint",
      slug: chosen.slug,
      version: chosen.version,
      pensadorHandoff: null,
      pensadorHandoffPath: null,
      legacyProgress: legacy.legacy,
      legacyProgressPath: legacy.path,
      warning: "Using legacy .pensador-progress.json (checkpointVersion: 2) — no handoff.json found or it failed validation.",
    };
  }

  const reason = handoffRead
    ? (handoffRead.version_mismatch ? "handoff.json version mismatch" : `handoff.json failed validation (${handoffRead.errors[0]?.code})`)
    : "no handoff.json and no legacy .pensador-progress.json";
  return buildStandaloneResult(
    `Could not ingest .pensador/${chosen.dirName}/ (${reason}) — degrading to independent mode.`,
    { invalidHandoff: handoffRead ?? undefined },
  );
}

function toPosix(value) {
  return String(value).split(sep).join("/");
}

/**
 * Indice `handoffPath` posix-relativo-a-projectRoot -> `runId`, construido a
 * partir de `state.upstream.handoffPath` de toda run em `.orchestration/`
 * (Bloco 2.6 do plano de ajustes: `initRun` persiste `upstream` quando a run
 * e modo conjunto). Leitura tolerante — `state.json` ausente, ilegivel ou sem
 * `upstream` simplesmente nao entra no indice; nunca lanca.
 *
 * So le `.orchestration/`, nunca `.pensador/` — mantem a regra absoluta do
 * modulo (`ingestPensadorHandoff` nunca escreve, e esta funcao tampouco lê
 * nada dentro de `.pensador/`).
 */
function buildConsumedByIndex(projectRoot) {
  const index = new Map();
  const orchestrationDir = join(projectRoot, ".orchestration");
  if (!existsSync(orchestrationDir)) return index;
  let entries;
  try {
    entries = readdirSync(orchestrationDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return index;
  }
  for (const entry of entries) {
    const stateFile = join(orchestrationDir, entry.name, "state.json");
    if (!existsSync(stateFile)) continue;
    let state;
    try {
      state = JSON.parse(readFileSync(stateFile, "utf8"));
    } catch {
      continue;
    }
    const handoffPath = state?.upstream?.handoffPath;
    if (handoffPath) index.set(toPosix(handoffPath), state.runId ?? entry.name);
  }
  return index;
}

/**
 * Lista os handoffs do Pensador disponiveis em `.pensador/`, um por slug
 * (a versao mais alta entre `<slug>-vN/`), ordenados por recencia (mtime do
 * diretorio versionado escolhido) decrescente. Read-only, como o resto do
 * modulo — nunca escreve em `.pensador/`.
 *
 * Fecha a lacuna que `ingestPensadorHandoff` deixa quando ha mais de um
 * slug: hoje ela devolve `mode: "ambiguous"` com uma lista de nomes crus e
 * para; isto lista o suficiente (status, feature, deliverable, se ja foi
 * consumido) para o usuario escolher.
 *
 * @param {object} options
 * @param {string} [options.projectRoot]
 * @param {number} [options.limit=10]  Ignorado quando `options.all` e true.
 * @param {boolean} [options.all=false]
 */
export function listPensadorHandoffs(options = {}) {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const limit = options.all ? Infinity : Number(options.limit ?? 10);
  const dirs = discoverPensadorDirs(projectRoot);

  const bySlug = new Map();
  for (const entry of dirs) {
    const list = bySlug.get(entry.slug) ?? [];
    list.push(entry);
    bySlug.set(entry.slug, list);
  }

  const consumedByIndex = buildConsumedByIndex(projectRoot);

  const rows = [];
  for (const [slug, versions] of bySlug) {
    const sorted = [...versions].sort((a, b) => b.version - a.version);
    const latest = sorted[0];
    const versionedDir = join(projectRoot, ".pensador", latest.dirName);
    const handoffPath = join(versionedDir, "handoff.json");
    const handoffRead = readHandoffSafe(handoffPath);
    const handoff = handoffRead?.valid ? handoffRead.handoff : null;

    let mtimeMs = 0;
    try {
      mtimeMs = statSync(versionedDir).mtimeMs;
    } catch {
      mtimeMs = 0;
    }

    const relativeHandoffPath = toPosix(relative(projectRoot, handoffPath));
    const hasDesignSystem = (handoff?.artifacts ?? []).some(
      (artifact) => artifact?.role === "design-system-files",
    );

    rows.push({
      slug,
      latestVersion: latest.version,
      versions: sorted.map((entry) => entry.version),
      artifactRoot: handoff?.artifactRoot ?? toPosix(relative(projectRoot, versionedDir)),
      handoffPath: relativeHandoffPath,
      handoffValid: Boolean(handoff),
      status: handoff?.status ?? null,
      summary: handoff?.summary ?? null,
      deliverable: handoff?.artifactMode ?? null,
      hasDesignSystem,
      updatedAt: handoff?.updatedAt ?? null,
      consumedBy: consumedByIndex.get(relativeHandoffPath) ?? null,
      mtimeMs,
    });
  }

  rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const limited = Number.isFinite(limit) ? rows.slice(0, limit) : rows;
  return limited.map(({ mtimeMs, ...rest }) => rest);
}
