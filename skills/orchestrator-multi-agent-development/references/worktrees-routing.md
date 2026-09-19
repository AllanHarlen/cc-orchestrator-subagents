# Worktrees e model routing adaptativo

## Isolamento físico

O planner compara `allowedPaths`/`expectedFiles` das tasks da wave:

```text
scope conhecido + sharedFiles == 0 -> worktree paralelo elegível
scope ausente ou sharedFiles > 0    -> serializar
```

Fluxo:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-worktree.mjs" plan --dir <run> --wave 1
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-worktree.mjs" create --dir <run> --task BE-01
# executor trabalha no workspace.path e cria commit
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-worktree.mjs" ready --dir <run> --task BE-01
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-worktree.mjs" integrate --dir <run> --task BE-01
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-worktree.mjs" cleanup --dir <run> --task BE-01
```

O estado preserva path, branch, base/head, integration status, conflicts e cleanup. Integração exige worktree/root produtivo limpo e branch correta. Conflito fica materializado como `CONFLICT`; não é abortado nem resolvido silenciosamente. `recover` reconcilia worktrees existentes após crash. Cleanup normal só ocorre depois de merge; `--force` é explícito.

## Git ausente

Quando Git não está instalado, ou o diretório do projeto não é um repositório Git, `planTaskWorktrees` detecta isso via `inspectGit` uma única vez e marca **todas** as tasks da wave como `eligible: false` / `reason: "GIT_UNAVAILABLE"`, sem calcular overlap de escopo. `parallelEligible` fica vazio e `serialize` lista a wave inteira. Isso degrada silenciosamente para execução serializada no diretório de trabalho principal — nenhum erro é lançado e nenhuma `AskUserQuestion` é feita. `checks.runtime.git` do preflight reporta essa ausência como aviso (`NOT_INSTALLED`), nunca como bloqueio: Git nunca é obrigatório.

Com Git disponível, a elegibilidade de worktree é puramente determinística por escopo de arquivos (`SCOPE_UNKNOWN`/`SHARED_FILES`/`ISOLATED_SCOPE`); nunca pergunte ao usuário se deve isolar uma task em worktree.

## Router adaptativo

O router mantém as regras estáticas como baseline e usa tentativas históricas somente quando há amostra comparável por `taskType`/`complexity`:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-router.mjs" route \
  --context-json '{"taskType":"FRONTEND_ONLY","complexity":"medium","executor":"agy"}'
```

Prioridade:

1. override do usuário;
2. pisos de review, criticidade e fidelidade visual;
3. escalada após tentativa falha;
4. evidência histórica com amostra mínima;
5. fallback heurístico.

O score usa sucesso suavizado, intervalo Wilson, first-pass success, review failures, regressões e duração mediana. O router não baixa abaixo do piso heurístico, não explora aleatoriamente tasks críticas e exige ganho mínimo de qualidade/score antes de mudar o modelo. Decisões `adaptive` registram `agyModelEvidence` e podem ser persistidas como telemetry `routing_decision`.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-router.mjs" report
```
