# Workflow detalhado por fase

Este arquivo expande as fases do `SKILL.md`.

## Layout do diretorio da run

Toda run nova grava os artefatos agrupados por estagio (`state.layoutVersion: 2`), sob `.orchestrator/runs/<nome>/` (raiz atual — `currentRunsRoot()` em `artifact-layout.mjs`). Os caminhos citados nas fases abaixo sao relativos a esse diretorio:

```text
state.json                  events.jsonl                (raiz: identidade da run)
plan/                       tasks-classification.md, waves.md
contracts/                  um arquivo por contrato
run/                        monitoring.md, lifecycle-probe.json, executor-results/, prompts/
review/                     review-final.md, review-frontend.md, e2e-verification.md, screenshots/
report/                     implementation-report.md, workflow-log.md, subagents-context.md, handoff.json
evidence/                   saida dos scripts de intelligence
learning/                   learning-report.md
```

`state.json` e `events.jsonl` nunca saem da raiz da run. `resume` e a numeracao de `runId` varrem **duas** raizes, atual primeiro (`runRootCandidates()` em `artifact-layout.mjs`): `.orchestrator/runs/<nome>/` (escrita de toda run nova) e `.orchestration/<nome>/` (raiz legada, so leitura — runs criadas antes desta versao permanecem la, nao sao migradas, e continuam legiveis sem intervencao). Nunca passe `--dir ".orchestration/<nome>"` para uma run nova: isso sobrescreve o default de `initRun()` e faz a run nascer na raiz legada por engano. Detalhes e regras de resolucao em `references/persistent-state.md`.

O orquestrador atua somente em projetos com PRD/especificacao ja pronta, em desenvolvimento complexo. Ele nao faz discovery, nao cria plano OpenSpec e nao reabre o entendimento da demanda. Todos os artefatos de coordenacao ficam em `.orchestrator/runs/<nome>/`, onde `<nome>` e um identificador descritivo em kebab-case: em **modo conjunto** e o `<slug>` do Pensador (sem `-vN`); em **modo independente** e derivado do PRD. Ver `references/handoff-contract.md`.

Por padrao, `.orchestrator/` (e a raiz legada `.orchestration/`, se ainda existir no projeto) sao gitignorados — ver "O que versionar" em `persistent-state.md`.

## Checkpoint transversal e resume

Toda fase e toda task sao transicoes da state machine descrita em `persistent-state.md`. O orquestrador grava primeiro em `events.jsonl` e somente depois publica a mudanca; `state.json` e um snapshot reparavel, nao uma segunda fonte manual.

Antes de iniciar uma fase, execute `orchestration-state.mjs phase --status RUNNING`. Ao concluir, persista `DONE`; em bloqueio/interrupcao, persista o estado correspondente antes de parar. Um crash entre fases retoma da proxima entrada segura da sequencia explicita (`... 9, 9.5, 10, 11, 12`). Um crash com executor ativo transforma `RUNNING` em `UNKNOWN` ate a reconciliacao provar o resultado.

**A ordem de fase e validada, nao apenas registrada.** `updatePhase` recusa marcar uma fase `DONE` enquanto qualquer predecessora em `PHASE_SEQUENCE` nao estiver fechada (`DONE` ou `N/A`), e recusa iniciar `RUNNING` enquanto uma predecessora ainda estiver `RUNNING`. Isso existe porque uma run real chegou a `phase: 12, status: DONE` com a Fase 6 nunca tendo existido e a Fase 5 nunca tendo fechado — o `phaseHistory` fechava fases em lote, em 0 ms, sem a maquina de estados ter de fato conduzido a execucao. `N/A` e o unico jeito de pular uma fase, e so vale para fase cujo completion gate correspondente e `waivable` (hoje so a 9.5); exige sempre `--reason`.

**Reentrar numa fase reabre o que vem depois dela.** Se a Fase 9.5 encontrar um defeito de integracao e a correcao voltar pela Fase 7, marcar `--phase 7 --status RUNNING` reabre automaticamente toda fase posterior que ja estava `DONE` (8, 9, 9.5) de volta a `PENDING`, junto com o completion gate correspondente. Isso fecha a lacuna que deixou 8 tasks serem entregues depois dos reviews de codigo na run analisada, com `backendReview`/`frontendReview` carimbados 1h24 depois — um gate carimbado depois do fato nao e um gate.

`/orchestrator resume [runId]` segue o protocolo completo de `persistent-state.md`: replay, reconciliacao conservadora, probes de Codex/AGY, reconstrucao da wave e continuacao da ultima fase segura. Quando existir adapter, rode `orchestration-lifecycle.mjs tick --resume`; o resultado bruto e persistido antes da transicao. Resume nunca e atalho para redelegar trabalho cujo resultado ainda pode chegar.

## Fase 0 - Preflight

Rode:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/preflight.mjs" --check-agent-mcp
```

Regras:

- se `status=failed`, cancele;
- `autoRemediation` existe para registrar se `.claude/settings.json` foi criado ou atualizado para adicionar `Bash(node:*)`;
- a auto-remediacao so vale para `codex-companion-bash`;
- se `.claude/settings.json` existir com JSON invalido, nao sobrescreva; falhe com remediacao clara.

## Fase 1 - Ingestao da especificacao

A especificacao chega por **duas vias** (ver `references/handoff-contract.md`). Antes de tratar a demanda como avulsa, detecte o modo.

### 1.K Inicializar conhecimento comprovado do projeto

Antes da classificacao, inicialize e audite a memoria pequena do projeto e atualize a projecao pesquisavel das runs anteriores:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/orchestrator-knowledge.mjs" init
node "${CLAUDE_SKILL_DIR}/scripts/inspect-project.mjs" --root "." --persist-knowledge
node "${CLAUDE_SKILL_DIR}/scripts/orchestrator-knowledge.mjs" audit
node "${CLAUDE_SKILL_DIR}/scripts/orchestrator-knowledge.mjs" history-project
```

Leia `.orchestrator/project-memory.md` junto da especificacao. Somente fatos `VALIDATED` com fonte `FILE`, `CONTRACT`, `TEST` aprovado, `RUN_EVENT` ou `USER` entram nessa projecao. Se `audit` marcar `STALE`/`CONFLICT`, exclua o fato da classificacao ate nova validacao. Busque `history-search` apenas por fingerprints, stacks ou problemas relevantes e mantenha o resultado condensado.

Na primeira run do projeto, confira se o `.gitignore` ja cobre `.orchestration/` e `.orchestrator/` (o padrao atual — ver "O que versionar" em `persistent-state.md`). Se ja tiver so o bloco estreito antigo (`.orchestrator/worktrees/`, `backups/`, `history.db`, `telemetry.jsonl`, `*.db-wal`/`*.db-shm`), trate como opt-in explicito ja feito pelo projeto e nao pergunte de novo. Se nao cobrir nenhum dos dois, proponha o bloco novo ao usuario antes de seguir, via `AskUserQuestion` — commitar esse estado no repositorio alvo faz com que uma limpeza manual (`rm -rf .orchestration .orchestrator`) nao "pegue": qualquer commit futuro do orquestrador sobre esses caminhos ressuscita o conteudo antigo via git normal, e worktree versionada ou removida por `git clean` quebra a wave em execucao. Nao altere o `.gitignore` do usuario sem aprovacao.

### 1.0 Detectar modo de operacao (conjunto vs independente)

Rode a ingestao deterministica em vez de escanear `.pensador/` manualmente — ela ja implementa a
descoberta ordenada, a escolha de maior versao, a deteccao de ambiguidade e o fallback legado
(WF-011; `lib/pensador-ingest.mjs`, testado em `tests/pensador-ingest.test.mjs`):

```bash
node "${CLAUDE_SKILL_DIR}/scripts/ingest-pensador.mjs" --root . [--slug <slug>]
```

1. `result.mode === "standalone"`: **modo independente** — sem `.pensador/`, ou nada validou (ver
   `result.warning`/`result.invalidHandoff`). O usuario fornece a especificacao via `@arquivo` ou
   texto no `/orquestrador`. `<nome>`/`<slug>` derivam do PRD.
2. `result.mode === "ambiguous"`: varios `slug` distintos em `.pensador/` sem slug explicito —
   confirme via `AskUserQuestion` usando `result.slugCandidates` e rode de novo com `--slug`. Para
   apresentar mais do que o nome cru do slug (status, feature, deliverable, se ja foi consumido por
   outra run), rode `brain-pensador.mjs` em vez de `AskUserQuestion` direto sobre
   `slugCandidates` (ver Modo `brain-pensador` em `commands/orchestrator.md`) — e o mesmo caminho
   que `/orquestrador brain-pensador` usa quando o usuario invoca o subcomando explicitamente.
3. `result.mode === "joint"` (**Pensador → Orchestrador**): `result.slug`/`result.version` ja
   resolvem a maior versao `-vN` do slug escolhido.
   - `result.pensadorHandoff` presente: leia-o e trate os artefatos referenciados como fonte da
     verdade. Correlacione pelo `slug` e grave seus artefatos em `.orchestrator/runs/<slug>/` (sem
     `-vN`). `status: BLOCKED`/`PARTIAL` no upstream: pare e peca decisao ao usuario.
   - `result.pensadorHandoff` ausente mas `result.legacyProgress` presente: fallback por convencao
     ja aplicado (`.pensador-progress.json`, `checkpointVersion: 2`) — leia o array `artifacts` de
     `result.legacyProgress` e avise o usuario (`result.warning`).

Assim que o slug estiver resolvido, crie `.orchestrator/runs/<slug>/` e inicialize o estado **antes** de ler/produzir novos artefatos dessa execucao:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-state.mjs" init \
  --slug "<slug>" --dir ".orchestrator/runs/<slug>" --phase 1
```

Em **modo conjunto** (`result.mode === "joint"`), passe tambem a origem — e o que permite a fase 9.5 se auto-delegar ao Testador mais adiante (secao correspondente da Fase 9.5) e o que `/orquestrador brain-pensador` usa para marcar um slug como ja consumido (`consumedBy`):

```bash
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-state.mjs" init \
  --slug "<slug>" --dir ".orchestrator/runs/<slug>" --phase 1 \
  --upstream-stage pensador --upstream-slug "<slug>" --upstream-version <result.version> \
  --upstream-handoff-path ".pensador/<slug>-v<result.version>/handoff.json"
```

### 1.1 Ler a especificacao fornecida

- Em modo conjunto, ingira os artefatos do Pensador na ordem do handoff contract (secao 7):
  - **Modo PRD:** `prd` → `userhistory` → `architecture` → `api-contract` → `communication-contract` → `design-system`/`design-system-files`.
  - **Modo Spec (OpenSpec):** confirme o estado via `openspec status --change <nome> --json` (ou `openspec show <nome> --json`) antes de ler os arquivos; ingira o change set em `openspec/changes/<nome>/` (`proposal.md`, `design.md`, `tasks.md`, `specs/` quando presente — omitido sob `skip_specs`, podendo estar aninhado em `specs/<area>/<capability>/spec.md`); derive as tasks de `tasks.md` preservando IDs/ordem (contando subtarefas aninhadas).
- Em modo independente, leia o arquivo de PRD/spec apontado pelo usuario com `Read`. Se o usuario apontar varios arquivos ou um diretorio de specs, leia todos os relevantes.
- Nao reescreva, nao replaneje e nao reinterprete a demanda. O papel do orquestrador e **orquestrar**, nao planejar.
- **Contrato de API:** quando houver `api-contract` (maquina-legivel), ele e a **fonte da verdade** dos contratos da Fase 4 — suba o mock a partir dele e valide o codigo contra ele (campo `validation`). O `communication-contract` e apenas a visao legivel.
- **Design (Open Design):** quando houver `design-system-files`, guarde os caminhos verbatim e o `materializeInto` de cada `<id>` para materializar na Fase 4 (ver Fase 4).

### 1.2 Extrair os entregaveis e tasks

A partir da especificacao, extraia diretamente:

- objetivos e entregaveis ja definidos;
- tasks, fases ou ordem de implementacao quando o PRD ja as trouxer;
- decisoes tecnicas firmes (arquitetura, bibliotecas, endpoints, telas, contratos, migrations);
- restricoes de escopo, agente, tecnologia ou arquivo;
- criterios de aceite (`CA`) e validacoes obrigatorias — usados depois nos gates de review (Fases 8/9), nao para gerar uma suite de testes.

Quando o PRD ja lista tasks, preserve IDs, nomes e ordem para rastreabilidade. Quando o PRD descreve entregaveis sem IDs formais, derive uma lista de tasks objetiva a partir do texto, sem inventar escopo novo.

**Extraia o escopo completo, nao um subconjunto.** A lista de tasks desta fase deve cobrir tudo que a especificacao implica — nao apenas uma "primeira onda", "fundacao" ou MVP que o orquestrador julgue razoavel para uma unica execucao. A decisao de escopo ja foi tomada rio acima: no **modo conjunto** (integracao Pensador → Orquestrador), o Pensador ja conduziu a entrevista de descoberta com o usuario e o `report/handoff.json`/PRD/spec resultante ja reflete o escopo acordado; no **modo independente**, o proprio usuario definiu o escopo ao escrever ou fornecer o PRD/spec. Em nenhum dos dois casos cabe ao orquestrador redecidir o tamanho do trabalho — ver 1.3a abaixo.

### 1.3 Lacunas bloqueantes

Se a especificacao tiver uma lacuna que impeca classificar e delegar com seguranca (ex.: contrato de dados ausente entre front e back, decisao tecnica obrigatoria nao tomada), use `AskUserQuestion` para resolver apenas a lacuna bloqueante. Nao transforme isso em discovery aberto — pergunte o minimo necessario para destravar a orquestracao e registre a resposta.

### 1.3a Execucao continua ate a conclusao integral

Depois de extrair a lista completa de tasks (1.2), monte as ondas necessarias (Fase 3) e execute-as **sequencialmente ate a ultima**, sem pausar entre ondas para perguntar ao usuario se deve continuar. Isso vale mesmo quando a especificacao gerar tasks suficientes para varias ondas com dependencias fortes entre blocos (ex.: um PRD de produto inteiro com multiplos dominios funcionais): o orquestrador planeja o breakdown completo em `plan/tasks-classification.md`/`plan/waves.md` e delega onda apos onda ate esgotar o escopo, sem checkpoint de "posso continuar?" no meio do caminho.

As unicas pausas legitimas em qualquer ponto da execucao sao por bloqueio real, ja cobertas em outras secoes deste documento:

- lacuna bloqueante da Fase 1.3 (informacao que falta para classificar/delegar com seguranca);
- bloqueio de sandbox ou de quota (Codex/AGY — secoes "Politica de sandbox Codex" e "Politica de quota");
- reprovacao em review (Fase 8/9), que aciona o loop de correcao da Fase 7 antes de seguir adiante.

Reducao de escopo (implementar menos do que a especificacao pede) so e aceitavel quando o **proprio usuario** pedir isso explicitamente na mensagem que invocou o orquestrador — nunca por iniciativa do orquestrador, e nunca comunicada apenas no relatorio final depois do fato consumado.

Ao final da Fase 1, o orquestrador deve conseguir produzir `plan/tasks-classification.md` a partir da especificacao ingerida mais fatos comprovados da Project Memory, cobrindo o escopo integral, e seguir sem pausa ate a Fase 12 e o fechamento terminal.

## Fase 2 - Classificacao das tasks

Para cada task extraida do PRD/spec, registre em `.orchestrator/runs/<nome>/plan/tasks-classification.md`:

- categoria;
- dependencias;
- arquivos criticos;
- complexidade;
- `contractRequired: yes|no`;
- `assignedAgent`;
- `executor` e `executorSource: project-config` — o Executor derivado da categoria pela Project_Config vigente (`codex`, `agy` ou `claude-code`), ver abaixo;
- `routingReason`;
- `expectedFiles` e/ou `validationPlan` (ao menos um e obrigatorio para reconciliacao);
- `allowedPaths` para validar escopo e decidir isolamento;
- `complexity`, `contractIds` e features de routing;
- `requirementIds` — a lista de `RF-XX` do `requirements-index` do Pensador que esta task implementa (quando houver `requirements.json` no upstream; formato livre — `requirementIds: RF-01, RF-02` — o gate abaixo so precisa achar os IDs em algum lugar do texto da task);
- para AGY, `agyModel`, `agyModelSource` e, quando adaptativo, `agyModelEvidence`;
- para Codex, `codexModel`, `codexModelSource` e `codexEffort` — ver "Vocabulario de modelo do Codex" abaixo. Assim como no AGY, `codexModel` nao e escolha livre: e um dos tres papeis fixos (`gpt-5.6-sol` para review, `gpt-5.6-terra` para implementacao, `gpt-5.6-luna` para correcao), e `validate-routing.mjs` reprova task de implementacao usando o modelo de review ou vice-versa.

**Cobertura de autenticacao.** Para cada area/rota declarada como autenticada na especificacao, confirme que existe uma task cobrindo o endpoint de autenticacao correspondente (`POST /api/auth/login` ou equivalente) — nao assuma que ele ja existe. Numa run real, uma aplicacao cuja area administrativa inteira era autenticada nao tinha task nenhuma para o endpoint de login; so foi descoberta por acaso, ao checar se o endpoint existia antes de despachar a tela de login, ja na Fase 5. Trate a lacuna como um gap bloqueante desta fase, nao como algo a descobrir mais adiante.

**Titulo de task nunca cita numero de fase.** Uma task ad-hoc criada durante a execucao (gap descoberto, correcao da Fase 9.5) registra o motivo em prosa (`routingReason`), nunca "gap descoberto na Fase N" — a numeracao de fase da maquina de estados e do texto do artefato podem divergir (a fase que estava de fato `RUNNING` no `state.json` no momento da criacao da task raramente e a mesma que a prosa do artefato menciona, porque o registro em texto costuma ficar atrasado em relacao ao avanco real da state machine). Se precisar referenciar quando a task foi criada, cite o timestamp ou o evento (ex.: "gap descoberto ao validar contrato antes do dispatch da tela de login"), nunca "Fase N".

Depois de escrever `plan/tasks-classification.md`, rode o gate de cobertura RF/CA (quando houver `requirements-index` no upstream) **antes** de montar as ondas — pegar um `RF` sem task aqui e mais barato do que descobrir na Fase 7:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/validate-requirements-coverage.mjs"   --requirements ".pensador/<slug>-vN/requirements.json"   --tasks ".orchestrator/runs/<nome>/plan/tasks-classification.md"
```

### Regra de roteamento por categoria

O Executor de cada task vem da categoria combinada com a Project_Config (`references/project-config.md`), nao de "parece infra" ou preferencia do orquestrador. Registre `executor` e `executorSource: project-config` por task em `plan/tasks-classification.md` e `plan/waves.md`; `validate-routing.mjs` reprova task cujo `executor` divirja do derivado para a categoria ou esteja fora de `codex`/`agy`/`claude-code`. Setup de projeto front-end, rotas, servicos API em TypeScript, componentes, paginas, hooks, estado e UX continuam sendo `FRONTEND_ONLY` e recebem o `frontendExecutor` configurado.

| Categoria | Papel da Project_Config | Execucao sob os defaults (`codex`/`agy`) |
|---|---|---|
| `BACKEND_ONLY` | `backendExecutor` | Codex via `codex-companion.mjs task --model <codexModel> --effort <codexEffort> --write` (chamada direta; fallback `codex:codex-rescue`) |
| `DATABASE_ONLY` | `backendExecutor` | Codex via `codex-companion.mjs task --model <codexModel> --effort <codexEffort> --write` (chamada direta; fallback `codex:codex-rescue`) |
| `REVIEW_ONLY` | `backendReviewer` | Codex via `codex-companion.mjs task --model gpt-5.6-sol --effort high` **sem `--write`** (chamada direta; fallback `codex:codex-rescue`) |
| `FRONTEND_ONLY` | `frontendExecutor` | AGY (`cc-antigravity-plugin:antigravity-coder`) com `--mode accept-edits --format stream-json --model <agyModel>` |
| `FULLSTACK` | `backendExecutor` + `frontendExecutor` | Codex com `--model <codexModel> --effort <codexEffort>` para back-end; AGY com `--mode accept-edits --format stream-json --model <agyModel>` para front-end |

#### Vocabulario de modelo do Codex

Assim como o AGY tem uma escada de capacidade (ver "Roteamento por fidelidade de design" abaixo), o Codex tem **tres papeis fixos**, nunca escolha livre:

| Papel | Modelo | Quando usar |
|---|---|---|
| `review` | `gpt-5.6-sol` | Fases 8/9 (review de codigo) e task `REVIEW_ONLY`. **Somente review** — nunca implementacao. |
| `implement` | `gpt-5.6-terra` | `BACKEND_ONLY`, `DATABASE_ONLY`, `DOCS_ONLY`, fatia back-end de `FULLSTACK`. Desenvolvimento geral. |
| `fix` | `gpt-5.6-luna` | Correcao originada da Fase 9.5 (browser-e2e) ou de review `REPROVADO`. |

Registre `codexModel` e `codexModelSource: user\|heuristic\|adaptive` (mesma semantica de `agyModelSource`) em toda task cujo Executor efetivo seja `codex`. `codexEffort` (`low\|medium\|high`) e sempre derivado da complexidade/risco da task na classificacao — nunca um valor fixo, e nunca um rebaixamento silencioso do `model_reasoning_effort` que o usuario configurou em `~/.codex/config.toml`. `validate-routing.mjs` reprova: task de implementacao usando `gpt-5.6-sol`; task `REVIEW_ONLY` usando qualquer modelo que nao seja `gpt-5.6-sol`; `codexModel`/`codexEffort` ausentes numa task apontando para Codex; e `codexModel`/`codexEffort` presentes numa task `claude-code`.

Quando o papel resolvido e `claude-code`, o `executor` da task e `claude-code`: delegue pela ferramenta `Agent` a um subagente do proprio Claude Code (implementacao) ou rode a task em modo read-only gravando em `review/review-final.md`/`review/review-frontend.md` (review). Uma task com `executor: claude-code` nunca registra `agyModel`, `agyModelSource`, `agyParallel` nem `agySubagentModel` — o validador reprova o bloco se algum desses campos aparecer. Artefato legado sem o campo `executor` continua validado pela heuristica antiga de mencao de agente (`assignedAgent`).

Se `FRONTEND_ONLY` aparecer com Codex como Executor fora do fallback abaixo, corrija antes de montar waves. Codex so pode assumir front-end depois de `QUOTA_EXAUSTED`, `AUTH_REQUIRED`, `AGY_MISSING`, `TIMEOUT`, falha operacional de AGY ou decisao explicita do usuario, e isso deve ficar registrado em `run/monitoring.md`, `report/workflow-log.md` e `report/subagents-context.md`.

**`antigravity-agent` e somente leitura.** Se `FRONTEND_ONLY` (ou a fatia front-end de `FULLSTACK`) aparecer com `assignedAgent: cc-antigravity-plugin:antigravity-agent`, isso e um erro de roteamento — corrija para `cc-antigravity-plugin:antigravity-coder` antes de montar waves. `antigravity-agent` so e valido como `assignedAgent` nas tasks de review (Fase 9), nunca em tasks que criam/editam arquivos.

### Regra de `agyParallel`

Para tasks `FRONTEND_ONLY` ou fatia front-end de `FULLSTACK`, avalie se ha dois ou mais entregaveis independentes nos criterios de aceite. Se sim, prefira **uma** task com `agyParallel: yes` em vez de N tasks AGY separadas. Registre em `plan/tasks-classification.md`:

- `agyParallel: yes|no`
- `agyParallelSource: user|heuristic` (quando `yes`)
- `agySubagentModel: <modelo>|inherit`

Condicoes para `agyParallel: yes`: entregaveis listados nos criterios de aceite sao independentes, nenhum toca arquivo central compartilhado, contrato nao esta pendente, schema nao esta mudando.

### Regra de `contractRequired`

Marque `yes` sempre que houver troca de dados front-back, mesmo que uma task esteja classificada como `BACKEND_ONLY` e outra como `FRONTEND_ONLY`.

Exemplos:

- endpoint novo consumido por tela -> `yes`;
- mudanca de payload, filtros, paginacao, validacao ou erro -> `yes`;
- ajuste puramente visual sem tocar API -> `no`.

## Fase 3 - Ondas

Agrupe tasks em `.orchestrator/runs/<nome>/plan/waves.md`.

Cada entrada de `plan/waves.md` deve repetir `assignedAgent` vindo de `plan/tasks-classification.md`. Depois de montar as waves, rode:

1. Para cada task AGY sem override do usuario, chame `orchestration-router.mjs route` com `taskType`, `complexity`, piso heuristico, criticidade, design e historico de attempts. O router exige amostra comparavel e nunca reduz o piso. Se retornar `source: adaptive`, registre `agyModelEvidence`; se retornar fallback, mantenha `source: heuristic`.
2. Valide o roteamento:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/validate-routing.mjs" ".orchestrator/runs/<nome>"
```

Se o validador falhar, corrija `plan/tasks-classification.md` e `plan/waves.md` antes de qualquer delegacao.

Quando o validador passar, sincronize os artefatos com o snapshot. O parser aceita IDs como `T1`, `BE-01` e `FE-01`; tasks removidas do Markdown nao sao apagadas silenciosamente do historico.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-state.mjs" sync \
  --dir ".orchestrator/runs/<nome>"
```

Em seguida, planeje isolamento fisico usando `allowedPaths`:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-worktree.mjs" plan \
  --dir ".orchestrator/runs/<nome>" --wave <N>
```

`ISOLATED` pode executar em worktree paralela; `SERIAL` (overlap) e `UNSCOPED` nao podem compartilhar a mesma execucao concorrente. O plano e persistido antes de qualquer mutacao Git. Leia `worktrees-routing.md`.

Nao paralelize quando houver:

- contrato pendente;
- schema indefinido;
- arquivo central compartilhado;
- autenticacao ou seguranca sem consolidacao.

Se uma operacao de descoberta/comparacao exigir loops ou tres ou mais reads/greps, rode o script de intelligence correspondente em vez de expandir todos os arquivos no contexto.

## Fase 4 - Contratos API/UI e materializacao de design

### 4.0 Materializar arquivos de design (Open Design)

Quando a ingestao trouxe `design-system-files` (ou um `design-system.md` com diretorio verbatim):

- Copie os arquivos verbatim de cada `<id>` (`.pensador/<slug>-vN/design-systems/<id>/`) para o alvo real indicado em `materializeInto` (ex.: `packages/ui/design-systems/<id>/`, ou `src/styles/…` em app unico). Ver `references/handoff-contract.md` secao 6.
- Nao reescreva `tokens.css`, `DESIGN.md`, `components.html` nem `preview/`: eles sao consumidos verbatim.
- Guarde os caminhos materializados para carregar no prompt de **toda task front-end** (Fase 5) e para o gate de design da Fase 9.
- No modo Spec, o design chega em `design.md` + `specs/ui-design-system/spec.md`: use-os como requisito normativo do gate.

### 4.1 Contratos

Crie `.orchestrator/runs/<nome>/contracts/*.md` para:

- toda task `FULLSTACK`;
- todo par dependente `BACKEND_ONLY` + `FRONTEND_ONLY` que troque dados entre si.

Valide cada contrato e o conjunto API/UI de forma deterministica:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/inspect-contract.mjs" --root "." --path ".orchestrator/runs/<nome>/contracts/<id>.md" --persist-knowledge
node "${CLAUDE_SKILL_DIR}/scripts/inspect-api-ui.mjs" --root "." --backend <path> --frontend <path>
node "${CLAUDE_SKILL_DIR}/scripts/validate-wire-format.mjs" --root "." --contract <path> --payload <path>
```

Todo contrato deve conter:

- endpoint e metodo;
- wire format;
- casing JSON esperado;
- exemplos completos de request/response;
- status codes;
- estados de UI;
- permissoes;
- validacoes;
- comprovacao de serializacao real contra TypeScript.

### Regra especial para C# e TypeScript

Quando houver DTO C# e consumidor TypeScript:

- explicite se o DTO interno esta em `PascalCase`;
- explicite se o JSON exposto deve sair em `camelCase`;
- documente serializer global ou atributos por campo;
- nao aceite "bate com a interface" sem verificar o payload real.

## Fase 5 - Delegacao paralela

Antes de lancar subagentes, confirme que `validate-routing.mjs` passou e que o plano de worktrees da wave nao possui overlap sendo despachado em paralelo. A delegacao precisa seguir `assignedAgent` dos artefatos validados.

Para cada task `ISOLATED`, crie a worktree antes do dispatch e use o path retornado como working directory do executor:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-worktree.mjs" create \
  --dir ".orchestrator/runs/<nome>" --task <ID>
```

Adquira uma lease com owner estavel antes do dispatch; o Lifecycle Manager a renova quando observa atividade e a libera apos terminal/reconciliacao. Nunca aponte dois executores para a mesma workspace/lease.

Para cada dispatch, persista a task como `RUNNING` **antes** de iniciar o executor. Inclua `executor`, `sessionId` do Agent/Codex ou `conversationId` do AGY assim que cada identificador existir. O engine captura `commitBefore` e incrementa `attempt` somente numa nova tentativa. Se o agendamento falhar antes do executor iniciar, registre `FAILED` com `reasonCode: DISPATCH_FAILED`; nao deixe a task eternamente `RUNNING`.

Quando o executor retornar, converta sinais de quota/auth/tooling para `BLOCKED` + `reasonCode`, ou persista `DONE`/`FAILED`, **antes** de anunciar o retorno na conversa ou avancar a wave.

### O watch e obrigatorio assim que a ultima task da wave for despachada

Numa run real, uma wave inteira (3 tasks Codex em background) terminou em ~5 minutos e ficou sem ninguem saber por um dia inteiro: a sessao ficou ociosa logo apos o dispatch, respondeu uma pergunta do usuario sem relacao e nunca mais voltou a checar o resultado (`analise-run-oficina-saas-20260906.md`). Para evitar essa classe de incidente, assim que **todas** as tasks da wave estiverem persistidas `RUNNING`, antes de qualquer outra acao — inclusive responder a uma pergunta do usuario que nao seja sobre a run — inicie o watcher em segundo plano:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-lifecycle.mjs" watch \
  --dir ".orchestrator/runs/<nome>" \
  --interval-seconds 30 --max-ticks 120 \
  [--adapter-config ".orchestrator/executor-control.json"]
```

Rode isso como processo em segundo plano (nao bloqueie o turno esperando ele terminar). Isso e obrigatorio **mesmo sem `--adapter-config`**: sem adapter, `tick`/`reconcileRunAtDirectory` ja rebaixa qualquer task `RUNNING` sem confirmacao externa para `UNKNOWN` a partir do primeiro tick (regra 23 do `SKILL.md`, "sem autoridade externa, mantenha UNKNOWN") e `sweepStalledTasks` marca `STALLED` quem ficar realmente ocioso — os dois sao sinais visiveis em `state.json`, bem mais rapidos que o silencio que causou o incidente. O adapter so melhora o sinal (confirma DONE/BLOCKED de verdade em vez de so sinalizar "precisa verificar"); nao e o que torna o watch obrigatorio. `--max-ticks 120` a 30s cobre 1h sem rodar sem supervisao para sempre; se a wave ainda estiver ativa quando o watch parar (`stoppedReason` ausente porque bateu o teto), reemita `watch` ou faca `tick` periodico. O watch imprime uma linha NDJSON `{"type":"tick",...}` por tick — inspecionavel com o processo ja rodando, nao so no final. `updateCompletionGate --gate monitoring --status DONE` recusa fechar (`GATE_MONITORING_REQUIRES_SWEEP`) enquanto `lifecycle.lastSweepAt` estiver vazio, ou seja, enquanto nenhum tick/sweep tiver rodado nesta run.

### Prompt efetivo como artefato da run

Antes de cada dispatch (Codex ou AGY), monte o corpo do prompt seguindo o template de
`subagent-prompts.md` com os placeholders preenchidos, e **persista-o em arquivo antes de
delegar** — nunca so em memoria, nunca so em argv:

- `.orchestrator/runs/<slug>/run/prompts/<taskId>.md` para implementacao/handoff/ajuste;
- `.orchestrator/runs/<slug>/run/prompts/<taskId>-review.md` para review (Fases 8/9).

Isso alimenta dois pontos que antes nao existiam: o prompt que de fato chegou na CLI vira algo
auditavel depois (nao so o retorno do subagente, que e o unico rastro hoje), e a medicao do
orcamento abaixo passa a medir o arquivo real, nao uma estimativa mental.

Para AGY, ao invocar o `antigravity-coder`/`antigravity-agent`, passe tambem
`--dump-prompt ".orchestrator/runs/<slug>/run/prompts/<taskId>.agy.txt"` (ver `subagent-prompts.md`
Secao 2) — o bridge grava o prompt final **da run real** (pos fallback de overflow, nao um dry run)
e um sidecar `<path>.audit.json` com `{ promptChars, limit, degraded, droppedFiles, included,
skipped }`. Preencha os campos "Prompt enviado" e "Contexto degradado" de
`assets/subagents-context-template.md` a partir desse sidecar.

**Quando `degraded: true`** (o bridge descartou arquivos inline por causa do limite de 28.000 chars
no Windows), a task **nao conta como executada com contexto completo** — registre em
`run/monitoring.md` a lista de arquivos descartados (`skipped` com `reason:
"prompt-overflow-windows"`) e decida entre redespachar com `--priority-files` apontando para os
arquivos que ficaram de fora, ou dividir a task por entregaveis (ver abaixo). Hoje essa degradacao
so aparecia como um aviso em stderr que ninguem le; a partir daqui e um fato registrado na run.

### Regra de limite de prompt AGY (28.000 chars)

Antes de delegar, meca o arquivo persistido (nao conte manualmente):

```bash
node "${CLAUDE_SKILL_DIR}/scripts/check-prompt-budget.mjs" --agent agy \
  --file ".orchestrator/runs/<slug>/run/prompts/<taskId>.md"
```

**Threshold:** 28.000 chars. Prompts reais com aspas, barras invertidas, XML e quebras de linha inflariam ~14% na linha de comando codificada pelo Node.js no Windows, causando `ENAMETOOLONG`. O threshold conservador garante margem segura. Para AGY isso e limite duro: `ok: false` sai com exit 1 e o chamador deve tratar a falha antes de despachar.

**Para Codex, a mesma checagem (`--agent codex`) e apenas indicativa** (`advisory: true`, nunca
falha, exit 0 mesmo acima do limite) — a chamada direta ao companion usa `--prompt-file`
(`codex-companion.mjs`), que nao passa pelo limite de argv do Windows. Um prompt muito acima do
limite ainda pode indicar contexto mal recortado; considere dividir por entregaveis mesmo sem erro.

Se o prompt montado **exceder 28.000 chars**:

1. Identifique os entregaveis listados nos criterios de aceite da task original.
2. Divida os entregaveis em dois grupos independentes (A e B), priorizando que cada grupo seja coeso e nao dependa do outro para executar.
3. Crie duas subtasks derivadas da original:
   - **Task `<ID>-a`**: herda todos os metadados da task original (categoria, agente, contrato, stack, escopo); `Descricao` e criterios de aceite cobrem apenas o Grupo A.
   - **Task `<ID>-b`**: mesmo metadados; `Descricao` e criterios de aceite cobrem apenas o Grupo B.
4. Atualize `plan/tasks-classification.md` e `plan/waves.md` substituindo a task original pelas duas subtasks; mantenha a mesma wave se forem independentes.
5. Remonte os dois prompts e confirme que cada um esta abaixo de 28.000 chars. Se ainda exceder, repita a divisao.
6. Registre a divisao em `run/monitoring.md` e `report/workflow-log.md` com:
   - task original e motivo (prompt excedeu N chars);
   - subtasks geradas e criterios de aceite de cada uma.

**Quando a task nao pode ser dividida por entregaveis** (descricao monolitica indivisivel):

- Reduza `Arquivos e modulos relevantes` ao minimo critico para esta task; mova arquivos secundarios para `Fora do escopo`.
- Substitua listagens mecanicas extensas por um resumo deterministico de `scripts/intelligence` e referencias de path confinadas ao workspace; nao reduza o modelo, pois isso nao altera o limite da linha de comando e pode violar o piso de fidelidade.
- Se persistir, registre `promptOverflow: true` em `plan/tasks-classification.md` e peca decisao ao usuario antes de delegar.

Para Codex:

- passe `--model <codexModel>` sempre — os tres papeis fixos sao `gpt-5.6-sol` (review), `gpt-5.6-terra` (implementacao) e `gpt-5.6-luna` (correcao), ver "Vocabulario de modelo do Codex" na Fase 2. Nunca omita `--model`: sem ele, o Codex cai no `model = "gpt-5.6-sol"` do `~/.codex/config.toml` do usuario, que e o modelo de review, para qualquer task;
- `--effort <codexEffort>`, derivado de complexidade/risco na classificacao (nunca um valor fixo) — tipicamente `medium` para implementacao/handoff/ajuste, `high` para review e para task de risco alto de regressao;
- registre `codexModelSource: user|heuristic|adaptive`, mesma semantica de `agyModelSource`;
- antes de executar instalacao/restore de pacotes, verifique se a task depende de rede externa ou de cache local; se falhar por rede bloqueada ou pacote ausente, pare como `BLOCKED`.
- se houver erro de permissao ao escrever fora do working directory permitido, pare como `BLOCKED` e reporte o caminho alvo.

Para Antigravity/AGY (implementacao):

- delegue ao `cc-antigravity-plugin:antigravity-coder` (unico subagente AGY com permissao de escrita; `antigravity-agent` e somente leitura e nao deve receber tasks de implementacao);
- passe `--mode accept-edits --format stream-json --model <agyModel>` para o bridge do plugin;
- inclua `--effort <agyEffort>` e `--timeout <agyTimeout>` somente quando os overrides publicos correspondentes existirem;
- registre `agyModelSource: user|heuristic|adaptive`; a opcao `adaptive` exige `agyModelEvidence` completo;
- quando `agyParallel: yes`, passe tambem `--parallel` ao bridge; quando `agySubagentModel` for diferente de `inherit`, passe `--subagent-model <agySubagentModel>` (implica `--parallel`);
- por padrao (`agySubagentModel: inherit`), omita `--subagent-model`; os subagentes herdam o modelo da sessao AGY principal;
- `--subagent-model` (alias legado: `--agy-subagent-model`) informado pelo usuario liga `--parallel` automaticamente;
- o bridge consulta `agy models`, resolve aliases e encaminha `--model` nativamente; nao leia nem altere `settings.json` do usuario;
- eventos NDJSON `init`, `step_update` e `result` que chegarem ao adapter renovam heartbeat somente com atividade observavel; persista apenas contadores e metadados seguros.

Cada prompt deve incluir:

- descricao da task;
- contrato quando `contractRequired=yes`;
- escopo permitido;
- wire format;
- regra de validar casing JSON e serializacao;
- `sectorContext` (setor/industria do negocio, do PRD/`design-system.md` do Pensador) — orienta que imagery/iconografia fazem sentido para o produto real.

### Imagery/icones (`IMAGE_SUGGESTIONS`)

Todo prompt de task front-end usa o template da Secao 2 de `subagent-prompts.md`, que instrui o `antigravity-coder` a devolver um bloco `IMAGE_SUGGESTIONS` quando identificar oportunidades de imagem (hero, banners, ilustracoes de empty/error state, icones de produto/servico) — o `antigravity-coder` **nunca gera sem aprovacao previa**. Quando esse bloco vier preenchido na resposta, siga o fluxo da Secao 2a de `subagent-prompts.md` **antes de fechar a task**: apresente as opcoes ao usuario via `AskUserQuestion` (multiSelect), delegue apenas as aprovadas de volta ao `antigravity-coder` com `--generate-image`, confirme que o arquivo gerado foi fiado no componente, e registre o resultado em `report/subagents-context.md`. Nao marcar a task front-end como `DONE` com sugestoes de imagem pendentes de decisao do usuario.

### Verificacao de skills compativeis

Todo subagente em background deve, como **primeiro passo antes de implementar**, listar as skills disponiveis no ambiente e filtrar as compativeis com sua task:

1. execute `/skills` ou equivalente para listar as skills do ambiente;
2. ignore skills exclusivas do orquestrador (planejamento/coordenacao);
3. das skills restantes, identifique quais se aplicam a task em execucao;
4. use as skills compativeis durante a implementacao;
5. registre no retorno quais skills foram utilizadas (campo obrigatorio no retorno de Codex e Gemini).

O orquestrador consolida as skills utilizadas por subagente em `report/subagents-context.md`.

## Fase 6 - Monitoramento

Esta fase tem completion gate proprio (`monitoring`, sempre obrigatorio) — fechar a Fase 7 sem antes fechar a Fase 6 e recusado por `assertPhaseTransition`. Feche com evidencia real (`run/monitoring.md` atualizado, ou `--evidence` apontando para o que a Fase 6 de fato produziu): `orchestration-state.mjs gate --gate monitoring --status DONE --evidence file:run/monitoring.md`. Isso existe porque, numa run real, a Fase 6 nunca foi executada de fato — o `phaseHistory` mostrou fases fechando em lote e a telemetria por task (conversationId, modelo resolvido, duracao real, retentativa) ficou vazia em todas as tasks, sem que nada tivesse exigido essa evidencia. O mesmo comando tambem recusa (`GATE_MONITORING_REQUIRES_SWEEP`) se `tick`/`watch`/`sweep` nunca rodou nesta run — evidencia sozinha nao prova que o monitoramento aconteceu *durante* a fase, so que algo foi escrito antes de fecha-la. Ver "O watch e obrigatorio..." na Fase 5.

Estados canonicos persistidos:

- `PENDING`
- `RUNNING`
- `DONE`
- `FAILED`
- `BLOCKED`
- `STALLED`
- `CANCELLED`
- `UNKNOWN`

`PAUSED` descreve o run/interacao, nao uma conclusao de task. `NEEDS_SYNC`, `QUOTA_EXAUSTED`, `QUOTA_EXHAUSTED`, `AUTH_REQUIRED`, `AGY_MISSING`, `TIMEOUT` e `REVIEWED` permanecem sinais operacionais em `reasonCode`/evidencia; nao criam estados concorrentes fora da state machine.

### Heartbeat e stall

Atualize heartbeat apenas quando houver progresso observavel (novo retorno/token, API call, tool call ou mudanca de `currentTool`). Poll sem mudanca nao renova `lastActivityAt`.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-state.mjs" heartbeat \
  --dir ".orchestrator/runs/<nome>" --task <ID> \
  --api-calls <N> --tool-calls <N> --current-tool <tool> --in-tool <true|false>

node "${CLAUDE_SKILL_DIR}/scripts/orchestration-state.mjs" sweep \
  --dir ".orchestrator/runs/<nome>"
```

Defaults: 450s sem progresso fora de tool, 1200s dentro de tool e 120s de grace period. `STALLED` recomenda interrupcao + reconciliacao; nao significa `FAILED` e nao autoriza retry imediato. Heartbeat real durante a grace period pode reativar `STALLED -> RUNNING`.

O manager continuo (`watch`, ja iniciado obrigatoriamente na Fase 5 — ver "O watch e obrigatorio...") substitui o polling manual de heartbeat/sweep acima. `--adapter-config` e opcional mas melhora o sinal quando disponivel:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-lifecycle.mjs" watch \
  --dir ".orchestrator/runs/<nome>" \
  --adapter-config ".orchestrator/executor-control.json" \
  --interval-seconds 30
```

O adapter recebe apenas placeholders allowlisted e roda sem shell. Cada probe bruto redigido e limitado e salvo em `run/executor-results/` antes de atualizar task, heartbeat, lease, history e telemetry. Para AGY, preserve `conversationId`, modelo resolvido, `usage`, duracao, turnos e a diretiva de retry validada. `interrupt`, `retry` e `cancel` exigem adapter ou `--external-confirmed`; nunca simule sucesso da acao externa. Retry confirmado usa exatamente `--conversation <id>` quando houver ID e `--continue` apenas quando nao houver. Veja `lifecycle-telemetry.md` e `assets/executor-control-config.schema.json`.

**Ler de volta o que as CLIs ja publicaram.** AGY grava `conversationId`/modelo resolvido no log JSONL do bridge (`bridge.exit`, `%LOCALAPPDATA%/agy/cc-plugin-logs/` ou `CC_ANTIGRAVITY_LOG_PATH`); Codex grava o thread id no sidecar de job e o **modelo efetivamente resolvido** no rollout de sessao (`~/.codex/sessions/YYYY/MM/DD/*.jsonl`, evento `thread_settings_applied` — a unica fonte que revela quando o modelo pedido e o que de fato rodou divergem, ver Achado 13 da run oficina-saas-20260905-001). Depois de cada dispatch, ou em lote ao fechar a fase, rode:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/import-executor-telemetry.mjs" --dir ".orchestrator/runs/<nome>" --task <ID> --root "." \
  --agy-log "<path do log do bridge>" --agy-pid <pid> \
  --codex-job "<path do sidecar de job>" --codex-rollout "<path do rollout>"
```

Grava `conversationId`/`sessionId`, `resolvedModel`, `codexEffort` efetivo, `startedAt`/`completedAt` reais (corrigindo `durationMs` para o tempo real da task, nao do lote de dispatch — Achado 3) e `producedFiles` via `git diff --name-only` entre `commitBefore`/`commitAfter`. `--dry-run` mostra o que seria capturado sem gravar. So faz backfill de campo vazio — mudar `conversationId`/`sessionId`/`executor` que ja tinham valor exige `--new-attempt`, senao `updateTaskStatus` recusa com `ATTEMPT_NOT_DECLARED`.

**Todo redispatch declara `--new-attempt`.** Um retorno AGY via `--conversation <id>` depois de truncamento, ou uma troca de executor por cota (Codex -> `claude-code`), e uma retentativa de verdade mesmo quando o status externo continua `RUNNING` de ponta a ponta. Sem `--new-attempt`, `task --status RUNNING` com `executor`/`sessionId`/`conversationId` diferente do que ja estava gravado e recusado (`ATTEMPT_NOT_DECLARED`) — a run analisada tinha 9 redispatches reais e registrou `attempt: 1` em 33/33 tasks porque nada distinguia "funcionou" de "funcionou na segunda". Use `orchestration-lifecycle.mjs retry` (que ja passa `newAttempt: true` internamente) ou `task --status RUNNING --new-attempt` diretamente.

### Politica de quota

- `QUOTA_EXHAUSTED` no Antigravity/AGY:
  - registre evidencia, `conversationId`, modelo resolvido, uso e retry seguro;
  - nao retente automaticamente enquanto a quota continuar indisponivel;
  - se o fallback for seguro, redelegue para Codex com `--effort medium`;
  - se mudar muito a natureza da entrega, peca confirmacao do usuario.

- `AUTH_REQUIRED` no Antigravity/AGY:
  - marque `BLOCKED`;
  - registre evidencia;
  - oriente o usuario a rodar `agy` interativamente uma vez.

- `AGY_MISSING` no Antigravity/AGY:
  - marque `BLOCKED`;
  - registre evidencia;
  - publique os passos de instalacao.

- `TIMEOUT` no Antigravity/AGY:
  - registre evidencia;
  - aumente timeout, reduza escopo ou quebre a task antes de insistir.

- `QUOTA_EXHAUSTED` no Codex durante implementacao, ajuste pontual ou handoff:
  - nao tente trocar modelo fixo;
  - marque `BLOCKED`;
  - registre evidencia;
  - peca decisao ao usuario.

- `QUOTA_EXHAUSTED` no Codex durante review back-end:
  - faca review interno read-only no orquestrador;
  - salve o resultado em `review/review-final.md`;
  - nao edite codigo produtivo.

### Politica de sandbox Codex

- `NU1301`, falha ao acessar registry externo, restore sem rede ou pacote ausente do cache local:
  - marque `BLOCKED`;
  - registre comando, erro e pacote necessario;
  - peca decisao do usuario antes de alterar plano ou dependencia.

- `UnauthorizedAccessException` ou erro equivalente ao escrever fora do working directory permitido:
  - marque `BLOCKED`;
  - registre working directory efetivo e caminho que falhou;
  - peca decisao do usuario para ajustar o diretorio permitido, mover a execucao para a raiz correta ou redefinir o escopo.

- Para UI sem dependencia de rede, mantenha AGY como executor primario. So faca handoff para Codex se o bloqueio AGY estiver documentado e o sandbox Codex permitir a escrita necessaria.

## Fase 7 - Integracao

Para cada worktree isolada concluida, marque `ready` (commit recuperavel) e integre serialmente na branch de integracao. O root produtivo deve estar limpo fora dos metadados do orquestrador. Em conflito, persista `CONFLICT` e pare; nao aborte, escolha lado ou limpe a worktree silenciosamente.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-worktree.mjs" ready --dir ".orchestrator/runs/<nome>" --task <ID>
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-worktree.mjs" integrate --dir ".orchestrator/runs/<nome>" --task <ID>
```

Valide:

- aderencia a especificacao (PRD/spec) ingerida;
- aderencia ao contrato;
- wire format;
- casing JSON;
- serializacao real;
- arquivos alterados fora do escopo;
- build (compilacao/typecheck/lint) sem erros.

Use programmatic intelligence para a parte mecanica e persista os evidence IDs na task/gate:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/inspect-diff.mjs" --root "." --dir ".orchestrator/runs/<nome>" --task <ID> --base <commitBefore>
node "${CLAUDE_SKILL_DIR}/scripts/validate-task-scope.mjs" --root "." --dir ".orchestrator/runs/<nome>" --task <ID>
node "${CLAUDE_SKILL_DIR}/scripts/collect-test-results.mjs" --root "." --input <resultado> --dir ".orchestrator/runs/<nome>" --task <ID> --persist-knowledge --command "<comando>"
```

Depois de cada outcome/review, projete a telemetria metadata-only; chamadas repetidas sao idempotentes por event ID:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-telemetry.mjs" project --dir ".orchestrator/runs/<nome>"
```

Nao gere projeto de testes automatizados como parte da integracao. A validacao de que cada requisito (`RF`/`CA`) foi implementado corretamente e responsabilidade do review de codigo (Fases 8 e 9), nao de uma suite de testes.

**Monte a matriz de rastreabilidade RF/CA → evidência aqui, nao no relatorio final.** Percorra cada `RF`/`CA` do escopo da especificacao e registre, em `report/implementation-report.md` secao 13, a task que o implementou e o arquivo/trecho de evidencia. Um `RF` sem entrega correspondente (ou com `// TODO`/placeholder/stub no caminho do requisito) e uma lacuna que precisa ser **sinalizada agora** — nao silenciosamente absorvida como "lacuna conhecida" no relatorio final sem passar pelo gate de review. Essa matriz alimenta diretamente as Fases 8 e 9.

**Gate deterministico de cobertura RF/CA.** A matriz acima e prosa, montada pelo mesmo agente que escreveu o codigo — sozinha, ela nao pega um `RF` que a Fase 1.2 perdeu ao extrair tasks. Quando o handoff do Pensador trouxe `requirements-index` (role `requirements-index`, `requirements.json`, modo PRD), rode o gate deterministico antes de fechar esta fase:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/validate-requirements-coverage.mjs"   --requirements ".pensador/<slug>-vN/requirements.json"   --tasks ".orchestrator/runs/<nome>/plan/tasks-classification.md"
```

Ele confere que todo `RF` do `requirements.json` esta reivindicado pelo campo `requirementIds` de pelo menos uma task (Fase 2). Sem `requirements-index` no upstream (modo Spec, ou handoff de versao anterior a esse role), o gate degrada para `applicable: false` e nao bloqueia — a cobertura fica so com a matriz de prosa nesse caso, e isso deve ser registrado em `report/workflow-log.md` como limitacao. `REQUIREMENTS_NOT_COVERED` (exit 1) e um achado de lacuna real: volte a Fase 1.2/2 e adicione a task que falta, nunca ignore o `RF` silenciosamente.

Se precisar ajuste, delegue para Codex com `--effort medium` (back-end) ou AGY (front-end), conforme a categoria.

## Fase 8 - Review back-end pos-implementacao (Codex)

> **Ignorar quando nao houver back-end:** Se nao houver nenhuma task `BACKEND_ONLY`, `DATABASE_ONLY` nem fatia back-end de `FULLSTACK`, pule a Fase 8 e registre `review/review-final.md` com a nota `"Sem back-end: review back-end nao aplicavel"`.

Objetivo da fase: validar a implementacao **back-end** final contra a especificacao, os contratos, as tasks executadas e os retornos dos subagentes. Esta fase e read-only: nao edite codigo durante o review. Codex revisa **apenas back-end** — nunca front-end. Se houver defeitos, volte para a Fase 7 para integrar ajustes ou redelegar correcao.

### 8.1 Preparar pacote de review

Antes de delegar ao Codex ou fazer review interno, monte um pacote de contexto com:

- especificacao original (PRD/spec) ingerida na Fase 1;
- `plan/tasks-classification.md`, `plan/waves.md` e contratos em `contracts/*.md`;
- `run/monitoring.md`, `report/workflow-log.md` e `report/subagents-context.md`;
- resumo dos arquivos back-end alterados;
- comandos de build e validacoes executadas no back-end;
- falhas, bloqueios, fallbacks e decisoes do usuario durante a execucao.

### 8.2 Fluxo principal

- delegue ao Codex com `--effort high`;
- informe que o review e somente leitura e restrito ao back-end (controllers, services, repositorios, DTOs, migrations, contratos do lado servidor);
- exija achados com severidade, arquivo/trecho quando aplicavel, impacto e correcao esperada;
- salve o resultado em `review/review-final.md`.

O prompt do review back-end deve pedir verificacao explicita de:

- aderencia a especificacao e ao escopo back-end;
- **cada criterio de aceite (`CA`) das tasks back-end validado por inspecao direta do codigo** — a validacao do requisito e responsabilidade deste review, nao de uma suite de testes gerada;
- contratos API, wire format, status codes, casing JSON e serializacao real no lado servidor;
- auth/autorizacao, validacoes e tratamento de erro no back-end;
- migrations, persistencia, indices e integridade referencial quando houver banco;
- build back-end sem erros;
- arquivos alterados fora do escopo;
- regressao potencial em fluxos existentes do back-end.

### 8.3 Fluxo de fallback

- se o review Codex vier com `QUOTA_EXHAUSTED`, o orquestrador faz review interno read-only do back-end;
- registre no proprio `review/review-final.md` que o review foi fallback interno do orquestrador por indisponibilidade de quota do Codex;
- mantenha as mesmas secoes obrigatorias do fluxo principal.

### 8.4 Resultado e loop de correcao

`review/review-final.md` deve terminar com uma decisao:

- `APROVADO`: pode seguir para a Fase 9;
- `APROVADO_COM_RESSALVAS`: pode seguir somente se as ressalvas forem documentadas como nao bloqueantes;
- `REPROVADO`: nao avance; volte para a Fase 7 ou redelegue ajustes ao Codex.

**`REPROVADO` obrigatorio quando:** um `RF`/`CA` do escopo back-end nao tem evidencia na matriz de rastreabilidade (secao 13 do `report/implementation-report.md`), ou o caminho de codigo desse requisito contem `// TODO`, `NotImplementedException`, stub vazio ou placeholder equivalente. Isso vale mesmo que o build passe e nenhum outro achado de severidade tenha sido levantado — requisito nao implementado nao e "ressalva nao bloqueante", e reprovacao.

## Fase 9 - Review front-end pos-implementacao (AGY)

> **Ignorar quando nao houver front-end:** Se nao houver nenhuma task `FRONTEND_ONLY` nem fatia front-end de `FULLSTACK`, pule a Fase 9 e registre `review/review-frontend.md` com a nota `"Sem front-end: review front-end nao aplicavel"`. Se nao existir `review/review-frontend.md`, basta registrar a ausencia em `report/workflow-log.md`.

Objetivo da fase: validar a implementacao **front-end** final. O review e feito pelo **AGY** com `--read-only --format json --model pro-high --effort high`. Codex nunca participa desta fase.

### 9.1 Preparar pacote de review

Monte um pacote de contexto com:

- especificacao original (PRD/spec) ingerida na Fase 1;
- `plan/tasks-classification.md`, `plan/waves.md` e contratos em `contracts/*.md`;
- `report/subagents-context.md` das tasks front-end;
- resumo dos arquivos front-end alterados;
- comandos de build/typecheck/lint executados no front-end.

### 9.2 Fluxo principal

- delegue ao `cc-antigravity-plugin:antigravity-agent` com `--read-only --format json --model pro-high --effort high` e inclua `--timeout <agyTimeout>` quando o usuario o definiu;
- informe que o review e somente leitura — o AGY nao modifica arquivos;
- exija achados com severidade, arquivo/trecho quando aplicavel, impacto e correcao esperada;
- salve o resultado em `review/review-frontend.md`.

O prompt do review front-end deve pedir verificacao explicita de:

- aderencia a especificacao e ao escopo front-end;
- **cada criterio de aceite (`CA`) das tasks front-end validado por inspecao direta do codigo/comportamento** — nao delegue essa validacao a uma suite de testes; o revisor confirma o requisito olhando a implementacao (e, quando aplicavel, a Fase 9.5 exercitando o fluxo num navegador real);
- consumo correto do contrato API/UI: wire format, casing JSON e serializacao real contra o TypeScript consumidor;
- estados de UI tratados (loading, erro, empty, sucesso);
- tipagem TypeScript, build, typecheck e lint;
- acessibilidade e consistencia visual quando aplicavel;
- arquivos alterados fora do escopo;
- regressao potencial em telas/fluxos existentes.

### 9.3 Fluxo de fallback

- se o review AGY vier com `QUOTA_EXAUSTED`, `AUTH_REQUIRED`, `AGY_MISSING` ou `TIMEOUT`, o orquestrador faz review interno read-only do front-end;
- registre em `review/review-frontend.md` que o review foi fallback interno do orquestrador por indisponibilidade do AGY, com o status cru retornado pelo bridge;
- mantenha as mesmas secoes obrigatorias do fluxo principal.

### 9.4 Resultado e loop de correcao

`review/review-frontend.md` deve terminar com uma decisao:

- `APROVADO`: pode seguir para a Fase 10;
- `APROVADO_COM_RESSALVAS`: pode seguir somente se as ressalvas forem documentadas como nao bloqueantes;
- `REPROVADO`: nao avance; volte para a Fase 7 e redelegue a correcao ao AGY.

**`REPROVADO` obrigatorio quando:** um `RF`/`CA` do escopo front-end nao tem evidencia na matriz de rastreabilidade (secao 13 do `report/implementation-report.md`), ou o componente correspondente contem `// TODO`, texto placeholder fixo (ex.: copy em ingles genérico onde o requisito pede conteudo real do tenant/dominio) ou estado vazio nao implementado. Isso vale mesmo que o build/typecheck/lint passem — requisito nao implementado nao e "ressalva nao bloqueante", e reprovacao.

Se houver achados bloqueantes em qualquer das fases de review (8 ou 9):

1. registre os achados em `run/monitoring.md` e `report/workflow-log.md`;
2. crie ou atualize tasks de correcao com agente responsavel pela categoria;
3. execute a correcao pela Fase 7;
4. repita o review focando nas areas alteradas e nos achados anteriores.

## Fase 9.5 - Verificacao E2E no navegador real (OBRIGATORIA para front separado do back)

> **Por que esta fase existe.** Review de codigo, `dotnet build`, `npm run build`, `tsc` e `curl` sao **cegos** a uma classe inteira de defeitos de integracao runtime. Em um caso real, tres rodadas de review deram "APROVADO" e a vitrine publica inteira estava quebrada no navegador — porque nenhum review tinha aberto um browser de verdade. Ver a regra 17 do `SKILL.md` para os tres defeitos concretos (CORS ausente, tenant nao resolvido a partir do browser, casing de resposta divergente que falha silenciosamente com 200).

> **Esta fase verifica funcao, nao design.** Ela dirige fluxos de usuario — login, CRUD, checkout — e confirma que o efeito final aconteceu de fato; nao abre uma viewport de celular para medir layout, nao compara uma cor computada contra a paleta do contrato, nao confere se a fonte declarada realmente carrega. Numa run real isso deixou passar uma fonte nunca entregue (renderizava so porque estava instalada na maquina), uma sidebar mobile ocupando 39% da pagina antes do conteudo comecar, e um header sem gutter — os tres invisiveis a build, `curl`, review de codigo **e** a este E2E funcional. Quando o projeto tem Open Design e `cc-testador-subagents` esta instalado, essa conformidade de design em runtime e responsabilidade dele (gate `design-runtime` da Fase 8 do Testador, `lib/runtime-design-probe.mjs`) — nao desta fase.

**Quando roda:** sempre que houver task `FRONTEND_ONLY` ou fatia front-end de `FULLSTACK` **e** o front-end for servido como deploy/origem separada do back-end (SPA/Next.js/etc. chamando uma API em outra porta/host). Quando nao ha front-end, ou o front e server-rendered sem chamadas cross-origin, registre "N/A" e siga.

**Excecao: modo conjunto a partir do Pensador com Testador instalado.** Quando a Fase 1 detectou `.pensador/<slug>-vN/handoff.json` (`mode: "joint"`) e `cc-testador-subagents` esta instalado no marketplace do workspace, a verificacao em navegador real e responsabilidade do Testador, nao do Orquestrador — ele e quem vai efetivamente dirigir o navegador no proximo estagio da cadeia. Pule esta fase automaticamente, sem pedir confirmacao:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-state.mjs" gate --gate browserE2E \
  --status N/A --required false --delegated-to cc-testador-subagents \
  --reason "PENSADOR_CHAIN_DELEGATED_TO_TESTADOR"
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-state.mjs" phase --phase 9.5 --status N/A \
  --reason "PENSADOR_CHAIN_DELEGATED_TO_TESTADOR"
```

Isso **nao e o mesmo** que o "N/A" do paragrafo acima (front-end inexistente ou server-rendered): aqui a verificacao vai rodar, so que la na frente. `completionAudit` confirma isso contra `report/handoff.json.nextStage.consumer` na Fase 10 — a delegacao so vale se o `nextStage` da propria run apontar para `cc-testador-subagents`. Se o plugin nao estiver instalado, a regra de degradacao da Fase 10 manda `nextStage` para o Executor, a delegacao fica automaticamente invalida, e esta fase 9.5 **e obrigatoria de novo** — ninguem mais na cadeia vai abrir um navegador.

**Como conduzir (o orquestrador faz diretamente, read-only sobre a app rodando):**

1. **Suba a app de verdade** (ex.: `docker compose up --build`) e confirme os servicos saudaveis. Se subir a stack falhar, isso ja e um achado bloqueante — nao existe "APROVADO" para uma app que nao sobe.
2. **Credenciais de seed/demo para fluxos autenticados.** Antes de tentar logar, confira se o PRD/spec documenta credenciais conhecidas de seed (ver seção "Observabilidade & Operação" do PRD). Se documentadas, use-as para exercitar os `UC-*` que exigem login. Se o ambiente tem seed/demo mas **nenhuma credencial documentada** (ex.: senha só como hash sem plaintext registrado), isso e uma lacuna real: registre-a explicitamente em `review/e2e-verification.md`, e prefira resolvê-la (redefinir a senha do seed para um valor conhecido e documentá-lo, com uma correção pela Fase 7) a simplesmente pular os fluxos autenticados. Só marque os fluxos autenticados como não verificados se resolver a credencial estiver fora do escopo da correção.
3. **Dirija os fluxos de usuario criticos** (os `UC-*`/caminhos-felizes da especificacao, **incluindo os que exigem login** quando a credencial estiver disponível) num navegador real via **Playwright MCP** (ou ferramenta equivalente): navegue, preencha formularios, clique, submeta.
4. **Em cada fluxo, verifique:**
   - console e network **sem erros de CORS** nem `net::ERR_FAILED`;
   - cada requisicao de API retorna 2xx **e a UI reflete o dado real** — desconfie de "200 mas a tela ficou vazia/inalterada", que e o sintoma classico de casing divergente ou campo `undefined`;
   - o **efeito final** de cada acao aconteceu de fato (o redirect abriu a aba/rota, o item entrou no carrinho, o registro apareceu na lista, o estado mudou) — nao apenas que a chamada retornou;
   - resolucao **multi-tenant / por host** funciona a partir do browser (o front informa o tenant certo ao back);
   - estados de tela (vazio/carregando/erro/sucesso) se comportam como especificado.
5. **Capture evidencia**: screenshot e/ou o resumo de console+network dos fluxos exercitados, salvos em `.orchestrator/runs/<slug>/review/e2e-verification.md` (e screenshots em `.orchestrator/runs/<slug>/review/screenshots/`).

**Achados desta fase sao BLOQUEANTES** como qualquer review: registre em `run/monitoring.md`/`report/workflow-log.md`, crie tasks de correcao, corrija pela Fase 7 e **re-verifique no navegador** antes de aprovar. So depois que os fluxos criticos passarem no navegador o orquestrador pode marcar a entrega como `DONE`. Se a ferramenta de navegador nao estiver disponivel no ambiente, **nao invente aprovacao**: registre a limitacao e marque o `report/handoff.json` como `PARTIAL` com o gap explicito ("verificacao E2E no navegador nao executada").

## Fases 10, 11 e 12 - Relatorio, entrega duravel e learning

Entregaveis obrigatorios (salve na **raiz de execucao do agente**, `.orchestrator/runs/<slug>/`):

- `report/workflow-log.md`
- `report/subagents-context.md`
- `report/implementation-report.md`
- `report/handoff.json` — manifesto de handoff do estagio orchestrador (ver `references/handoff-contract.md`)
- `learning/learning-report.md` — candidatos comprovados extraidos na Fase 12; nenhuma promocao automatica
- `state.json` + `events.jsonl` — estado/auditoria da execucao (nao entram no vocabulario de artefatos do handoff)

### Gravar `report/handoff.json` (para o Executor)

Ao fechar, grave `.orchestrator/runs/<slug>/report/handoff.json` com:

- `handoffVersion: 1`, `stage: "orchestrador"`, `slug` (sem `-vN`), `producer` (plugin + version), `artifactRoot: ".orchestrator/runs/<slug>"`, `status` (`DONE`/`PARTIAL`/`BLOCKED`), `summary`, timestamps.
- `upstream`: em modo conjunto, aponta o `handoff.json` do Pensador (`.pensador/<slug>-vN/handoff.json`); em modo independente, `null`.
- `artifacts[]`: uma entrada por role do vocabulario Orchestrador (secao 5 do handoff contract) — `implementation-report`, `tasks-classification`, `waves`, `api-contracts`, `review-final`, `review-frontend`, `monitoring`, `workflow-log`, `subagents-context` (+ `openspec-change` quando aplicavel), com `path` relativo ao `artifactRoot`.
- `nextStage`: a cadeia de quatro estagios (`handoff-contract.md` secao 1) tem o Testador entre o Orchestrador e o Executor — aponte para ele por padrao: `consumer: "cc-testador-subagents"`, `entrypoint: "/testador"`, `instructions` orientando a validar a entrega em navegador real via Playwright MCP. Se o plugin `cc-testador-subagents` nao estiver instalado no marketplace do workspace (verifique `.claude-plugin/` ou pergunte ao usuario quando em duvida), degrade para `consumer: "cc-executor-subagents"`, `entrypoint: "/executor"`, `instructions` orientando review plano-vs-entrega e ajustes finos diretamente — e registre essa degradacao no `report/workflow-log.md`.

O relatorio final deve citar:

- se houve auto-remediacao no preflight;
- quais contratos foram criados;
- quais validacoes de wire format e serializacao foram feitas;
- se houve fallback de review interno (back-end por `QUOTA_EXHAUSTED` no Codex; front-end por indisponibilidade do AGY);
- para cada delegacao AGY com `agyParallel: yes`: numero de subagentes Gemini nativos e Conversation IDs reportados pelo AGY;
- contagem de tokens por agente, nos tres lugares previstos pelos templates: tabela consolidada em `report/implementation-report.md` secao "11a. Uso de tokens por agente", detalhe por agente/papel em `report/subagents-context.md` secao "Uso de Tokens por Agente" (alem do campo `Tokens usados` de cada bloco de subagente), e o total da execucao em `report/workflow-log.md` secao 1. As duas tabelas devem fechar no mesmo total. Quando houver fan-out, os tokens reportados pelo AGY sao o agregado da sessao — nao some os subagentes Gemini por fora. Dado nao reportado pelo agente ou nao exposto pela plataforma e `N/A`, nunca `0`.

Na Fase 10, finalize reports/handoff e marque os gates `reports`/`handoff` com evidence IDs de arquivo. Na Fase 11, prepare a mensagem e instrucoes de negocio em artefato duravel, marque `delivery` e conclua a fase, mas **nao publique sucesso ainda**.

Na Fase 12, extraia somente candidates suportados pelo event log/reviews:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-learning.mjs" run \
  --dir ".orchestrator/runs/<slug>"

node "${CLAUDE_SKILL_DIR}/scripts/orchestrator-knowledge.mjs" history-project \
  --dir ".orchestrator/runs/<slug>"

node "${CLAUDE_SKILL_DIR}/scripts/orchestration-telemetry.mjs" project \
  --dir ".orchestrator/runs/<slug>"

node "${CLAUDE_SKILL_DIR}/scripts/orchestration-state.mjs" audit \
  --dir ".orchestrator/runs/<slug>"

node "${CLAUDE_SKILL_DIR}/scripts/orchestration-state.mjs" run \
  --dir ".orchestrator/runs/<slug>" --status DONE

node "${CLAUDE_SKILL_DIR}/scripts/orchestration-state.mjs" verify \
  --dir ".orchestrator/runs/<slug>"
```

`audit.complete` precisa ser `true`; falha de gate/integridade bloqueia a entrega. Nao corrija `revision`/`lastEventId` manualmente; reproduza o event log ou restaure um backup coerente. O `report/handoff.json` so pode usar `DONE` quando as tasks obrigatorias estiverem `DONE`, cada task tiver evidence plan e os gates aplicaveis tiverem passado com evidencia; `UNKNOWN`, `STALLED` ou `BLOCKED` pendente exige `PARTIAL`/`BLOCKED` com resumo explicito. Um gate `waivable` (hoje so `browserE2E`) marcado `N/A` via `--required false` aparece em `audit.waivedGates` e por si so ja forca `audit.complete: false` — dispensar a verificacao com motivo documentado nao e o mesmo que ela ter passado; o handoff sai `PARTIAL`, nunca `DONE`, ate o usuario decidir disponibilizar a ferramenta, aceitar formalmente a limitacao (registrando isso fora do gate) ou reverter a dispensa. Projete history/telemetry novamente depois do evento `RUN_STATUS_UPDATED(DONE)` para capturar o terminal e so entao publique a mensagem preparada na Fase 11.

### Contagem de tokens

Cada subagente deve incluir no retorno:

```
Tokens usados: input=<N> output=<N> cache_read=<N> total=<N>
```

O orquestrador coleta esses valores, preenche as tabelas de tokens nos tres entregaveis finais e calcula o total consolidado de toda a execucao. Use `N/A` quando o agente nao reportar ou a plataforma nao expuser o dado.
