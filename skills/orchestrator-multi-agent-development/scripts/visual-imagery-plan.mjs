#!/usr/bin/env node
import path from 'node:path';

const normalize = (value) => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export function classifyVisualImageryTask(input) {
  const text = normalize(typeof input === 'string' ? input : input?.text);
  const reasons = [];
  const explicit = /\b(?:imagem|imagens|foto|fotos|ilustracao|banner|hero|mockup|galeria|thumbnail|asset visual)\b/.test(text);
  const catalog = /\b(?:catalogo|vitrine)\b.*\b(?:pecas|equipamentos|produtos|servicos|itens)\b|\b(?:pecas|equipamentos)\b.*\b(?:catalogo|vitrine)\b/.test(text);
  const publicSurface = /\b(?:area publica|pagina publica|site institucional|landing page|homepage|pagina inicial|marketing)\b/.test(text);
  if (explicit) reasons.push('explicit-imagery');
  if (catalog) reasons.push('catalog-visual-merchandising');
  if (publicSurface) reasons.push('public-high-visual-surface');
  const policy = explicit || catalog ? 'required' : publicSurface ? 'recommended' : 'not-applicable';
  return { schemaVersion: 1, policy, provider: 'agy', minimumAssets: policy === 'required' ? 3 : policy === 'recommended' ? 1 : 0, reasons };
}

const isMain = process.argv[1] && path.basename(process.argv[1]) === 'visual-imagery-plan.mjs';
if (isMain) {
  const args = process.argv.slice(2);
  const index = args.indexOf('--text');
  const text = index >= 0 ? args[index + 1] ?? '' : args.filter((arg) => !arg.startsWith('--')).join(' ');
  process.stdout.write(`${JSON.stringify(classifyVisualImageryTask(text), null, 2)}\n`);
}
