#!/usr/bin/env node
/**
 * INDEPENDENT-mode fallback classifier: when there is no upstream Pensador
 * handoff (no `project-baseline.json.visualImageryPlan` to preserve — see
 * references/workflow.md Fase 5 "Imagery/icones"), the Fase 2 task
 * classification runs this against each front-end task description.
 *
 * Root cause fixed here (mirrors cc-pensador >= 2.27.0's
 * inferVisualImageryPlan() — see that module's docstring for the fuller
 * note): the previous version matched loose UI vocabulary — "banner",
 * "hero", "mockup" — directly against `required`, which both false-blocked
 * (a task merely describing a component's shape, e.g. "hero com CTA", not
 * demanding real photography) and false-negatived on an English task
 * description (no pt-BR keyword ever matched). Policy now comes from the
 * TASK'S SURFACE (a conversion/catalog public page is a structural,
 * high-confidence signal — every public reference in the benchmark used
 * real photography), not from loose words. A per-item explicit mandate
 * ("upload de foto do produto") is kept as an independent, narrower trigger.
 *
 * Kept intentionally small and dependency-free (this repo has no shared
 * package with cc-pensador to import its surface detector from) — a subset
 * of cc-pensador's SECONDARY_SURFACE_SIGNALS/CATALOG_MERCHANDISING_RE
 * covering task-description-shaped text, not a full product-archetype
 * classifier.
 */
import path from 'node:path';

const normalize = (value) => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Bilingual surface signals — same set cc-pensador's SECONDARY_SURFACE_SIGNALS.conversion/catalog uses. */
const CONVERSION_SURFACE_RE = /\b(?:site publico|pagina publica|area publica|landing page|vitrine institucional|captacao de leads?|formulario de orcamento|formulario de contato|homepage|pagina inicial|marketing|public site|public page|public facing page|marketing page|lead capture)\b/;
const CATALOG_KEYWORD_RE = /\b(?:vitrine de pecas|vitrine de produtos|vitrine de servicos|catalogo publico|galeria de produtos|product gallery|public catalog|storefront|product showcase)\b/;
/** "catalogo/vitrine DE <itens>" with arbitrary words in between — same pattern as inferSeedImageryRequired()/cc-pensador's CATALOG_MERCHANDISING_RE. */
const CATALOG_MERCHANDISING_RE = /\b(?:catalogo|vitrine)\b.*\b(?:pecas|equipamentos|produtos|servicos|itens)\b|\b(?:pecas|equipamentos)\b.*\b(?:catalogo|vitrine)\b/;
/** Narrower than the old "imagem|foto|banner|hero|mockup" bucket on purpose — only an explicit per-item photo mandate, not UI vocabulary. */
const EXPLICIT_ITEM_IMAGE_RE = /\b(?:upload de foto|fotos? do produto|fotos? do item|galeria de fotos|banner personalizado)\b/;

export function classifyVisualImageryTask(input) {
  const text = normalize(typeof input === 'string' ? input : input?.text);
  const reasons = [];
  if (EXPLICIT_ITEM_IMAGE_RE.test(text)) reasons.push('explicit-imagery-requirement');
  const isCatalog = CATALOG_KEYWORD_RE.test(text) || CATALOG_MERCHANDISING_RE.test(text);
  if (isCatalog) reasons.push('catalog-visual-merchandising');
  const isConversion = CONVERSION_SURFACE_RE.test(text);
  if (isConversion) reasons.push('public-conversion-surface');
  const required = reasons.includes('explicit-imagery-requirement') || isCatalog || isConversion;
  const policy = required ? 'required' : 'not-applicable';
  return { schemaVersion: 1, policy, provider: 'agy', minimumAssets: required ? 3 : 0, reasons };
}

const isMain = process.argv[1] && path.basename(process.argv[1]) === 'visual-imagery-plan.mjs';
if (isMain) {
  const args = process.argv.slice(2);
  const index = args.indexOf('--text');
  const text = index >= 0 ? args[index + 1] ?? '' : args.filter((arg) => !arg.startsWith('--')).join(' ');
  process.stdout.write(`${JSON.stringify(classifyVisualImageryTask(text), null, 2)}\n`);
}
