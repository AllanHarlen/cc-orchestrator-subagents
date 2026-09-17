import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyVisualImageryTask } from '../skills/orchestrator-multi-agent-development/scripts/visual-imagery-plan.mjs';

describe('visual imagery task planning', () => {
  it('requires AGY assets for parts catalogs', () => {
    assert.deepEqual(classifyVisualImageryTask('Catalogo publico de pecas').policy, 'required');
  });
  it('recommends AGY imagery for landing pages', () => {
    assert.deepEqual(classifyVisualImageryTask('Landing page institucional').policy, 'recommended');
  });
  it('leaves backend-only work alone', () => {
    assert.deepEqual(classifyVisualImageryTask('Corrigir indice SQL').policy, 'not-applicable');
  });
});
