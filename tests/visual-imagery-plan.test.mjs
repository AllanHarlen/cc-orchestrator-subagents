import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyVisualImageryTask } from '../skills/orchestrator-multi-agent-development/scripts/visual-imagery-plan.mjs';

describe('visual imagery task planning', () => {
  it('requires AGY assets for parts catalogs (catalog surface)', () => {
    const result = classifyVisualImageryTask('Catalogo publico de pecas');
    assert.equal(result.policy, 'required');
    assert.equal(result.minimumAssets, 3);
    assert.ok(result.reasons.includes('catalog-visual-merchandising'));
  });

  it('requires AGY assets for a landing page (conversion surface, not merely recommended)', () => {
    // A conversion surface is a structural signal (every public reference in
    // the cross-sector benchmark used real photography), not a loose word
    // match — mirrors cc-pensador's inferVisualImageryPlan() fix.
    const result = classifyVisualImageryTask('Landing page institucional');
    assert.equal(result.policy, 'required');
    assert.ok(result.reasons.includes('public-conversion-surface'));
  });

  it('detects a "catalogo/vitrine de X" phrasing beyond the fixed keyword list', () => {
    assert.equal(classifyVisualImageryTask('Vitrine com catalogo de equipamentos').policy, 'required');
  });

  it('detects an English-only task description (fixes the old regex bilingual gap)', () => {
    assert.equal(classifyVisualImageryTask('Build a public storefront with a product gallery').policy, 'required');
  });

  it('does not force required just because the task mentions generic UI words like "hero"/"banner"/"mockup"', () => {
    // The old regex matched these words directly; now they carry no signal
    // on their own unless the task also names a conversion/catalog surface
    // or an explicit per-item photo mandate.
    const result = classifyVisualImageryTask('Ajustar o componente de hero banner no mockup do dashboard interno');
    assert.equal(result.policy, 'not-applicable');
  });

  it('requires AGY assets for an explicit per-item photo mandate, independent of surface', () => {
    const result = classifyVisualImageryTask('Permitir upload de foto do produto no cadastro interno');
    assert.equal(result.policy, 'required');
    assert.ok(result.reasons.includes('explicit-imagery-requirement'));
  });

  it('leaves backend-only work alone', () => {
    assert.equal(classifyVisualImageryTask('Corrigir indice SQL').policy, 'not-applicable');
  });
});
