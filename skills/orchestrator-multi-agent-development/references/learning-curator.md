# Fase 12, Learned Recipes e Curator

## Fase 12 — Learning

Depois da entrega durável da Fase 11 e antes de `run DONE`:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-learning.mjs" run \
  --root . --dir .orchestrator/runs/<slug>
```

O engine lê estado/eventos/reviews, cria `learning/learning-report.md` atomicamente e persiste candidate lessons em `knowledge.db`. Candidatos registram trigger, problema, regra, action, confidence, reuse potential e evidências. A fase nunca altera `SKILL.md` e nunca promove automaticamente.

## Validação e promoção

Uma lesson só vira recipe após evidência independente `USER`, `TEST` passando, `CONTRACT` existente ou `RUN_EVENT`:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-learning.mjs" lesson-validate \
  --id <lesson> --evidence-type TEST --source "npm run e2e" --status PASS
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-learning.mjs" recipe-promote \
  --lesson <lesson> --recipe-id cors-cross-origin
```

Recipes têm ID seguro, versão, trigger determinístico, action escopada, confidence, fonte, evidências e contadores. Matching não usa mera similaridade textual:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-learning.mjs" recipe-match \
  --context-json '{"error":"NU1301","executor":"codex"}'
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-learning.mjs" recipe-outcome \
  --id nuget-sandbox --outcome SUCCESS --run-id <run> --task-id BE-01
```

## Curator

Lifecycle de recipes: `ACTIVE -> STALE -> ARCHIVED`. Nunca há auto-delete.

- dry-run é o default;
- recipes pinadas não sofrem transição automática;
- triggers iguais com actions diferentes recebem `needsReview`;
- toda mutação cria backup;
- rollback valida hashes e cria um safety backup do estado atual.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-learning.mjs" curator-status
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-learning.mjs" curate
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-learning.mjs" curate --apply
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-learning.mjs" recipe-pin --id <id>
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-learning.mjs" recipe-archive --id <id>
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-learning.mjs" recipe-activate --id <id>
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-learning.mjs" rollback --backup <id>
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-learning.mjs" rollback --backup <id> --apply
```
