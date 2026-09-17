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
  - **Modo PRD:** `prd` → `userhistory` → `architecture` → `api-contract` → `communication-contract` → `ui-data-map` → `seed-plan` → `surface-benchmark` → `design-system`/`design-system-files` → `ui-prototype` / `brand-assets`.
  - **Modo Spec (OpenSpec):** confirme o estado via `openspec status --change <nome> --json` (ou `openspec show <nome> --json`) antes de ler os arquivos; ingira o change set em `openspec/changes/<nome>/` (`proposal.md`, `design.md`, `tasks.md`, `specs/` quando presente — omitido sob `skip_specs`, podendo estar aninhado em `specs/<area>/<capability>/spec.md`); derive as tasks de `tasks.md` preservando IDs/ordem (contando subtarefas aninhadas). `ui-data-map`/`seed-plan`/`surface-benchmark` sao comuns aos dois modos (cc-pensador >= 2.27.0).
- **Mapa tela -> contrato (`ui-data-map`) e plano de seed (`seed-plan`):** quando presentes (`pensador-ingest.mjs` -> `inspectDataContractArtifacts()`), sao a **unica fonte de dados** permitida para cada tela nas tasks front-end da Fase 5 — nenhuma task pode persistir entidade de dominio em `localStorage`/`sessionStorage`/estado do cliente, e nenhuma task de seed pode gravar dados fora da camada `persistenceLayer: "database-seed"` que `seed-plan` fixa. Preserve os dois arquivos para a Fase 4 (gate `contractCoverage`) e a Fase 5 (prompts). Ausencia (handoff de producer < 2.27.0) degrada: sem `ui-data-map`, a Fase 4 nao pode rodar o gate de cobertura e a regra de fonte de dados da Fase 5 vira orientacao, nao verificacao mecanica — registre a degradacao em `report/workflow-log.md`.
- Em modo independente, leia o arquivo de PRD/spec apontado pelo usuario com `Read`. Se o usuario apontar varios arquivos ou um diretorio de specs, leia todos os relevantes.
- Nao reescreva, nao replaneje e nao reinterprete a demanda. O papel do orquestrador e **orquestrar**, nao planejar.
- **Contrato de API:** quando houver `api-contract` (maquina-legivel), ele e a **fonte da verdade** dos contratos da Fase 4 — suba o mock a partir dele e valide o codigo contra ele (campo `validation`). O `communication-contract` e apenas a visao legivel.
- **Design (Open Design):** quando houver `design-system-files`, guarde os caminhos verbatim e o `materializeInto` de cada `<id>` para materializar na Fase 4 (ver Fase 4).
- **Protótipos e Brand Assets:** quando houver `ui-prototype` (`prototypes/`) e `brand-assets` (`assets/`), use-os como SPEC VISUAL e pacote de mídia fechados do Pensador nos prompts do AGY (Fase 5) e gate de fidelidade visual (Fase 9).

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
- `visualImageryPolicy: required|recommended|not-applicable`, `visualImageryReasons` e `minimumAssets`, calculados com `node "${CLAUDE_SKILL_DIR}/scripts/visual-imagery-plan.mjs" --text "<descricao da task>"`. Preserve a politica mais forte de `project-baseline.json.visualImageryPlan` quando o Pensador a fornecer;
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

### 4.0 Materializar arquivos de design (Open Design) — gate `visualMaterialization`

Quando a ingestao trouxe `design-system-files` (ou um `design-system.md` com diretorio verbatim) e ha front-end:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/materialize-visual-handoff.mjs" --root "." --handoff "<caminho para o handoff.json do Pensador>" --apply > ".orchestrator/runs/<nome>/design-materialization.json"
```

- O script preserva `original/` intacto, copia apenas o pacote `resolved/` autoritativo de cada `<id>` para o alvo real (`materializeInto`, ex.: `packages/ui/design-systems/<id>/`, ou `src/styles/…` em app unico — ver `references/handoff-contract.md` secao 6) e materializa cada asset. Ele propaga os `seedBindings` no relatorio de operacoes; para cada asset com `purpose: "seed-demo"`, o Orquestrador deve inclui-los na task de seed correspondente, aplicar cada vinculo no codigo/dado real e confirmar o resultado no browser. Assets estaticos podem ter `seedBindings: []`. Nao reescreva `tokens.css`, `DESIGN.md`, `components.html` nem `preview/`: eles sao consumidos verbatim.
- Um `status: "BLOCKED"` no JSON gravado significa finding alto/critico no pacote (`resolved/` ausente, asset obrigatorio faltando, hash divergente, ou um handoff `status: DONE` com `design-system-files.variant: "legacy-verbatim"` — desde cc-pensador >= 2.25.0 isso e sempre um producer desatualizado, nunca uma saida valida do proprio Pensador) — corrija na origem (Pensador) antes de prosseguir; nao contorne despachando mesmo assim.
- Feche o gate somente apos `status: "PASS"`: `gate --gate visualMaterialization --status DONE --evidence file:design-materialization.json`. **O dispatch de qualquer task front-end (Fase 5) fica bloqueado** (`assertPhaseTransition`) enquanto este gate nao fechar — isso e deliberado: um pacote de design nao materializado so aparecia antes como sintoma indireto e generico no gate visualAudit da Fase 9 (imagens quebradas/ausentes), sem apontar a causa raiz.
- Guarde os caminhos materializados para carregar no prompt de **toda task front-end** (Fase 5) e para o gate de design da Fase 9.
- No modo Spec, o design chega em `design.md` + `specs/ui-design-system/spec.md`: use-os como requisito normativo do gate.
- Quando nao ha front-end (`visualMaterialization` nao e `required`), o gate fica `N/A` automaticamente — nao ha o que materializar.

### 4.1 Contratos

Crie `.orchestrator/runs/<nome>/contracts/*.md` para:

- toda task `FULLSTACK`;
- todo par dependente `BACKEND_ONLY` + `FRONTEND_ONLY` que troque dados entre si.

Valide cada contrato e o conjunto API/UI de forma deterministica:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/inspect-contract.mjs" --root "." --dir ".orchestrator/runs/<nome>" --persist-knowledge
node "${CLAUDE_SKILL_DIR}/scripts/inspect-api-ui.mjs" --root "." --backend <path> --frontend <path>
node "${CLAUDE_SKILL_DIR}/scripts/validate-wire-format.mjs" --root "." --contract <path> --payload <path>
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-state.mjs" gate --dir ".orchestrator/runs/<nome>" --gate contractsInspected --status DONE
```

`inspect-contract.mjs --dir` inspeciona todos os arquivos de `contracts/` e persiste o resultado em `evidence/`. O gate `contractsInspected` somente fecha quando cada contrato existente possui uma inspecao persistida para o SHA-256 do conteudo atual, com `valid: true` (ou uma justificativa explicita no registro); adicionar ou editar um contrato invalida a evidencia anterior antes de a Fase 4 fechar e tambem aparece no `audit` final.

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

### 4.1a Cobertura de contrato (ui-data-map x api-contract) — gate `contractCoverage`

Quando a ingestao trouxe `ui-data-map` (modo conjunto) ou uma tela front-end foi mapeada manualmente no modo independente (Fase 2), rode o gate ANTES de despachar qualquer task front-end — pegar aqui uma tela sem operacao correspondente e muito mais barato do que descobrir na Fase 9.5, depois que o front-end ja preencheu a lacuna com `localStorage` (defeito real de uma run: OficinaAI, 2026-09-16, 41 RFs contra 21 operacoes de `openapi.yaml`, 4 telas do painel sem endpoint de listagem, so descobertas na E2E):

```bash
node "${CLAUDE_SKILL_DIR}/scripts/validate-contract-coverage.mjs" --ui-data-map "<ui-data-map.json>" --contract "<api-contract>" [--format rest]
```

- `applicable: false` (sem `ui-data-map`, sem contrato, ou formato fora de REST/OpenAPI) nunca bloqueia — registre a degradacao em `report/workflow-log.md` e siga; nao e um passe silencioso, e um gap disclosed.
- `ok: false` (exit 1) e **bloqueante**: cada entrada de `gaps[]` (`screenId`, `operation`) vira uma task de back-end nova (categoria `BACKEND_ONLY`, `routingReason` citando o gap, nunca "Fase N" — regra da Fase 2) antes de qualquer task front-end que dependa daquela tela ser despachada. Nao redija a tela para usar outra fonte de dados: o contrato e que esta incompleto.
- No modo independente, monte `ui-data-map.json` voce mesmo na Fase 2 a partir das tasks front-end extraidas (mesma forma de `ui-data-map.schema.json` do Pensador: `screens[].reads[]/writes[].operation` no formato `"METODO /caminho"`, `dataSource: "api-contract"` fixo).
- Este gate e independente de linguagem: le apenas o texto do contrato (OpenAPI/GraphQL/gRPC/AsyncAPI) e o `ui-data-map.json`, nunca codigo gerado.

### 4.2 Geracao deterministica de tipos e contratos

A partir da especificacao OpenAPI/YAML/JSON ou dos contratos em `.orchestrator/runs/<nome>/contracts/`, gere tipos e DTOs fortemente tipados para a stack do projeto antes de despachar os subagentes:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/generate-contract-types.mjs" \
  --contract ".orchestrator/runs/<nome>/contracts/<id>.md" \
  --lang auto \
  --output "<workspace>/contracts"
```

Isso elimina alucinacoes de payload, divergencias de casing e interfaces inventadas pelos subagentes no back-end e front-end.

### 4.3 Early Stack Boot / Smoke Test de Infra — gate `infraSmokeTest`

Antes de abrir a Fase 5, quando a run tem back-end e front-end, execute o smoke test real da stack e persista o resultado na propria run:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/smoke-test-infra.mjs" \
  --root "." --dir ".orchestrator/runs/<nome>" \
  [--compose-file docker-compose.yml] [--health-url http://localhost:<porta>/health] [--timeout 120] --json
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-state.mjs" gate \
  --dir ".orchestrator/runs/<nome>" --gate infraSmokeTest --status DONE
```

O resultado fica em `evidence/infra-smoke-test.json`, identificado por `kind: "infra-smoke-test"` e `schemaVersion: 1`. Depois do `up`, o script le todos os containers por JSON estruturado, reprova servico parado ou com health negativo e, quando `--health-url` for informado, exige resposta HTTP 2xx dentro do timeout. `SKIPPED`, `FAILED`, evidencia sem esse envelope e `--dry-run` nao fecham o gate: a evidencia precisa ser aplicavel, vir de uma subida real e ter `status: "PASS"`. Isso confirma cedo imagens Docker, Dockerfiles, portas, credenciais, volumes, banco, filas e dependencias essenciais; falha aqui bloqueia a Fase 4 antes de qualquer dispatch.

## Fase 5 - Delegacao paralela

Antes de lancar subagentes, confirme que `validate-routing.mjs` passou e que o plano de worktrees da wave nao possui overlap sendo despachado em paralelo. A delegacao precisa seguir `assignedAgent` dos artefatos validados.

**"Paralelo" significa multiplas chamadas de tool no MESMO turno, nao dispatch->espera->dispatch.**
Numa run real (OficinaAI, 2026-09-12), 4 tasks Codex independentes de back-end na mesma wave
(BE-02..BE-05) foram despachadas via `--background --json` (retorno imediato com `jobId`) mas cada
uma so comecou depois que a anterior **terminou** — BE-03 iniciou aos 00:26:54, exatamente 8s depois
de BE-02 reportar `DONE` aos 00:26:46. `--background` deixou de bloquear a chamada, mas isso nao
adianta se cada dispatch e seu proprio turno esperando o `jobId` antes de decidir o proximo passo:
o efeito pratico foi tao serial quanto sem `--background`. Para toda task Codex/AGY sem overlap de
escopo na mesma wave: emita as chamadas de dispatch (Bash `--background`/Agent) **todas na mesma
resposta do assistente** — sem aguardar `result`/retorno de uma antes de disparar a proxima — e so
entao inicie o watcher (abaixo) sobre o conjunto inteiro.

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
e um sidecar `<path>.audit.json` com `{ promptChars, limit, transport, degraded, droppedFiles,
included, skipped, designSystems }`. Preencha os campos "Prompt enviado" e "Contexto degradado" de
`assets/subagents-context-template.md` a partir desse sidecar.

**Quando `degraded: true`** (raro desde o bridge 4.4.0: so acontece em `--interactive`, que nao tem
canal de stdin para o prompt — headless nunca degrada mais, pois o prompt vai por stdin sempre que
excede o argv seguro), a task **nao conta como executada com contexto completo** — registre em
`run/monitoring.md` a lista de arquivos descartados (`skipped` com `reason:
"prompt-overflow-windows"`) e decida entre redespachar com `--priority-files` apontando para os
arquivos que ficaram de fora, ou dividir a task por entregaveis (ver abaixo). `transport` no
sidecar diz por onde o prompt realmente foi (`stdin` ou `argv`); `designSystems` lista os pacotes
Open Design entregues via `--design-system` (ver Secao 2a).

### Fonte de dados front-end — contrato, nunca client-side storage

Em toda task `FRONTEND_ONLY` (ou fatia front-end de `FULLSTACK`), o prompt (`subagent-prompts.md`) declara a regra em termos absolutos: a **unica** fonte de dados de qualquer tela e a operacao do contrato mapeada em `ui-data-map.json` (`dataSource: "api-contract"`, fixo). Proibido:

- persistir/ler entidade de dominio via `localStorage`, `sessionStorage`, IndexedDB ou qualquer estado do cliente que sobreviva ao reload sem passar pela API;
- credenciais de demo hardcoded no cliente que contornem a chamada real de login;
- popular uma tela com dados fixos ("seed" local ao componente) quando o contrato ja tem a operacao correspondente.

Quando a task precisa de uma tela sem operacao correspondente no `ui-data-map`/contrato (deveria ter sido pego pelo gate `contractCoverage` da Fase 4, mas uma task ad-hoc pode chegar sem passar por ele), o subagente retorna `Status: CONTRACT_GAP` em vez de inventar uma fonte de dados alternativa. O orquestrador trata como `NEEDS_SYNC` (mesma rotina de `references/contracts.md` "Quando o contrato muda"): cria a task de back-end faltante, atualiza o contrato/`ui-data-map`, e so entao redespacha a task front-end.

O retorno de toda task front-end passa a ter a secao obrigatoria **"Fonte de dados por tela"** — uma linha por tela tocada, citando o `id` do `ui-data-map` (ou a rota, no modo independente) e a operacao real consumida (`GET /caminho`). Um retorno sem essa secao, ou com uma tela cuja fonte declarada nao seja uma operacao do contrato, e reprovado na Fase 7 antes de integrar — nao espere a Fase 9.5 para descobrir.

### Orcamento indicativo de prompt AGY/Codex (24.000 chars)

Antes de delegar, meca o arquivo persistido (nao conte manualmente):

```bash
node "${CLAUDE_SKILL_DIR}/scripts/check-prompt-budget.mjs" --agent agy \
  --file ".orchestrator/runs/<slug>/run/prompts/<taskId>.md"
```

**Threshold:** 24.000 chars, **puramente indicativo** para os dois agentes (`advisory: true`,
`ok: false` nunca falha, exit 0) desde o bridge cc-antigravity-plugin 4.4.0: o hop bridge→agy faz
stream do prompt final via stdin sempre que excede o argv seguro (8.191 chars no Windows, 100.000
nas demais plataformas), entao nao ha mais descarte de contexto por tamanho no caminho headless.
Para Codex, a chamada direta ao companion ja usava `--prompt-file` (`codex-companion.mjs`), que
nunca passou pelo limite de argv.

Um `ok: false` continua um sinal de qualidade a considerar, mesmo sem bloquear: um corpo de task
muito grande costuma indicar escopo mal recortado, contexto redundante ou uma listagem mecanica que
deveria ter ido por `scripts/intelligence` em vez de colada inteira no prompt.

**Pacote de design system: use `--design-system`, nao `--priority-files`.** Quando a task tem
contrato visual (Fase 4.0), passe `--design-system "<materializeInto>"` ao bridge em vez de colar
`tokens.css`/`components.html`/`DESIGN.md` manualmente no corpo do prompt ou for
ca-los via `--priority-files`: o bridge inclui os arquivos centrais do pacote na integra,
fora do orcamento de `--max-files`/`--max-file-bytes` e do transporte por argv, e lista o resto do
pacote para leitura sob demanda (ver Secao 2a de `subagent-prompts.md`). Isso e o que fecha a
lacuna observada numa run real: o bridge 4.2.x descartava os ~40 arquivos do pacote de design por
`max-files-exceeded`/`prompt-overflow-windows`, e o AGY passava a ler tokens/componentes por conta
propria, de forma irregular.

Quando um prompt segue muito acima de 24.000 chars mesmo sem contar o pacote de design (`--design-system`
ja o exclui do calculo do corpo persistido), isso ainda pode indicar escopo mal recortado:

1. Identifique os entregaveis listados nos criterios de aceite da task original.
2. Divida os entregaveis em dois grupos independentes (A e B), priorizando que cada grupo seja coeso e nao dependa do outro para executar.
3. Crie duas subtasks derivadas da original:
   - **Task `<ID>-a`**: herda todos os metadados da task original (categoria, agente, contrato, stack, escopo); `Descricao` e criterios de aceite cobrem apenas o Grupo A.
   - **Task `<ID>-b`**: mesmo metadados; `Descricao` e criterios de aceite cobrem apenas o Grupo B.
4. Atualize `plan/tasks-classification.md` e `plan/waves.md` substituindo a task original pelas duas subtasks; mantenha a mesma wave se forem independentes.
5. Remonte os dois prompts e confirme que cada um esta abaixo de 24.000 chars. Se ainda exceder, repita a divisao — o gate aqui e a qualidade do recorte, nao o transporte.
6. Registre a divisao em `run/monitoring.md` e `report/workflow-log.md` com:
   - task original e motivo (prompt excedeu N chars);
   - subtasks geradas e criterios de aceite de cada uma.

**Quando a task nao pode ser dividida por entregaveis** (descricao monolitica indivisivel):

- Reduza `Arquivos e modulos relevantes` ao minimo critico para esta task; mova arquivos secundarios para `Fora do escopo`.
- Substitua listagens mecanicas extensas por um resumo deterministico de `scripts/intelligence` e referencias de path confinadas ao workspace; nao reduza o modelo, pois isso nao altera o orcamento indicativo e pode violar o piso de fidelidade.
- Se persistir, registre `promptOverflow: true` em `plan/tasks-classification.md` como nota de qualidade — nao ha decisao de usuario a pedir aqui, pois o dispatch nao esta mais bloqueado.

Para Codex:

- passe `--model <codexModel>` sempre — os tres papeis fixos sao `gpt-5.6-sol` (review), `gpt-5.6-terra` (implementacao) e `gpt-5.6-luna` (correcao), ver "Vocabulario de modelo do Codex" na Fase 2. Nunca omita `--model`: sem ele, o Codex cai no `model = "gpt-5.6-sol"` do `~/.codex/config.toml` do usuario, que e o modelo de review, para qualquer task;
- `--effort <codexEffort>`, derivado de complexidade/risco na classificacao (nunca um valor fixo) — tipicamente `medium` para implementacao/handoff/ajuste, `high` para review e para task de risco alto de regressao;
- registre `codexModelSource: user|heuristic|adaptive`, mesma semantica de `agyModelSource`;
- antes de executar instalacao/restore de pacotes, verifique se a task depende de rede externa ou de cache local; se falhar por rede bloqueada ou pacote ausente, pare como `BLOCKED`. A unica excecao automatica e o relay TLS descrito na politica de sandbox: ele executa uma vez o mesmo `dotnet restore` pelo Orquestrador e devolve a evidencia ao Codex; nao instala nem adiciona pacotes.
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

### Imagery/icones — materializacao do handoff e modo independente

No modo conjunto, o Pensador ja tomou a decisao de imagery e publicou `assets/manifest.json`. Preserve `project-baseline.json.visualImageryPlan`; politica `required` sem o minimo de assets vinculados bloqueia a ingestao/materializacao e deve ser corrigida na origem. Nao regenere silenciosamente um pacote autoritativo.

No modo independente, a Fase 2 e proprietaria da decisao: rode `node "${CLAUDE_SKILL_DIR}/scripts/visual-imagery-plan.mjs" --text "<descricao da task>"` para cada task front-end. A politica vem da SUPERFICIE da task, nao de palavras soltas ("hero"/"banner"/"mockup" sozinhas nao bastam): catalogo/vitrine de pecas, equipamentos, produtos ou servicos, OU site/pagina/area publica, landing page, homepage — ambas geram uma task visual AGY **obrigatoria** com minimo 3 imagens; um mandato explicito por item ("upload de foto do produto") tambem forca `required`, independente de superficie. Sem nenhum desses sinais, `not-applicable` — nao gere imagem. Execute uma chamada sequencial `--generate-image` por arquivo e exija `AGY_IMAGE_RESULT` (`count: 1`, destino, bytes e SHA-256). Depois vincule a `src`/import e, em catalogos, ao seed/registro real. O browser gate (Fase 9, `visualAudit`) comprova o resultado; arquivo solto nao conclui a task.

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
  - O fallback de implementacao de back-end delega exclusivamente para o AGY (`cc-antigravity-plugin:antigravity-coder`) com modelos Gemini nativos:
    - `gemini-3.8-flash-medium` para tarefas pontuais/CRUDs, migrations simples, seeds e ajustes isolados;
    - `gemini-3.8-flash-high` para tarefas de arquitetura, seguranca ou refatoracao complexa.
  - **NUNCA** fazer fallback para modelos Claude ou subagentes `claude-code`, preservando estritamente a cota da sessao principal e evitando sobrecarga/custo no orquestrador.
  - Registre o motivo do fallback e os identificadores em `run/monitoring.md` e `report/workflow-log.md`.

- `QUOTA_EXHAUSTED` no Codex durante review back-end:
  - faca review interno read-only no orquestrador;
  - salve o resultado em `review/review-final.md`;
  - nao edite codigo produtivo.

### Politica de sandbox Codex

- `NU1301`, falha ao acessar registry externo, restore sem rede ou pacote ausente do cache local:
  - marque `BLOCKED`;
  - registre comando, erro e pacote necessario;
  - peca decisao do usuario antes de alterar plano ou dependencia.

- Falha de TLS/SSL de `dotnet restore` apos acesso ao registry (por exemplo, `The SSL connection could not be established`, `Authentication failed` ou `Credenciais nao disponiveis no pacote de seguranca`):
  - classifique como `CODEX_TLS_RESTORE_RELAY`, nao como nova liberacao de sandbox;
  - preserve a evidencia do Codex e execute uma unica vez o mesmo `dotnet restore <solution-ou-project>` pelo Orquestrador, no workspace efetivo da task;
  - nunca execute `dotnet add package`, altere `NuGet.Config`, certificados, proxy, VPN, credenciais ou flags que ignorem fontes/falhas;
  - persista comando, diretorio, exit code, saida redigida e hashes/paths de arquivos de lock eventualmente alterados em `run/handoffs/<taskId>-dependency-restore.md`, depois registre o evento de relay por `orchestration-state.mjs` (nunca editando `events.jsonl` diretamente);
  - se o restore passar, abra uma nova tentativa Codex com o handoff como contexto, mantendo o mesmo escopo e orientando validacoes com `--no-restore` quando aplicavel;
  - se falhar, marque `BLOCKED` com `reasonCode: HOST_DEPENDENCY_RESTORE_FAILED`, sem novo retry ou pergunta imediata ao usuario. A wave pode continuar somente com tasks independentes.

- `UnauthorizedAccessException` ou erro equivalente ao escrever fora do working directory permitido:
  - marque `BLOCKED`;
  - registre working directory efetivo e caminho que falhou;
  - peca decisao do usuario para ajustar o diretorio permitido, mover a execucao para a raiz correta ou redefinir o escopo.

- Para UI sem dependencia de rede, mantenha AGY como executor primario. So faca handoff para Codex se o bloqueio AGY estiver documentado e o sandbox Codex permitir a escrita necessaria.

## Fase 7 - Integracao

### 7.1 Gate de Qualidade Incremental por Onda (Wave Gate)

Ao final de cada wave (antes de autorizar a transicao para a wave seguinte), execute o gate deterministico de qualidade:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/run-wave-gate.mjs" --wave <N> --dir ".orchestrator/runs/<nome>"
```

O script roda localmente compilacao (`build`), typecheck e verificacao de escopo alterado (`git diff`), sem consumir tokens de LLM. Nenhuma wave avancara se a wave anterior tiver deixado erros de build ou tipagem acumulados.

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

**Monte a matriz de rastreabilidade RF/CA → evidência aqui, nao no relatorio final.** Para preencher a Secao 13 do `report/implementation-report.md` de forma deterministica sem consumir tokens de LLM nem context window, execute:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/build-traceability-matrix.mjs" \
  --requirements ".pensador/<slug>-vN/requirements.json" \
  --tasks ".orchestrator/runs/<nome>/plan/tasks-classification.md" \
  --output ".orchestrator/runs/<nome>/report/traceability-matrix.md"
```

O resultado gerado e inserido na secao 13. Um `RF` sem entrega correspondente (ou com `// TODO`/placeholder/stub no caminho do requisito) e uma lacuna que precisa ser **sinalizada agora** — nao silenciosamente absorvida como "lacuna conhecida" no relatorio final sem passar pelo gate de review. Essa matriz alimenta diretamente as Fases 8 e 9.

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

> **Esta fase verifica funcao e semantica visual.** Alem dos fluxos, cubra desktop/mobile, compare telas criticas ao preview resolvido, confirme tokens computados, fonte carregada, navegacao, iconografia e assets. Grave `review/ui-evidence.json` e feche o gate `visualAudit`; o validador rejeita commit como evidencia visual e exige screenshot, viewport, requisito, assercao de navegador e prova de API real.

**Quando roda:** sempre que houver task `FRONTEND_ONLY` ou fatia front-end de `FULLSTACK` **e** o front-end for servido como deploy/origem separada do back-end (SPA/Next.js/etc. chamando uma API em outra porta/host). Quando nao ha front-end, ou o front e server-rendered sem chamadas cross-origin, registre "N/A" e siga.

**Compatibilidade legada (nao aplicar a runs 4.11+).** A delegacao abaixo existia em runs anteriores. No contrato atual, `browserE2E` e `visualAudit` rodam no Orquestrador e nao podem ser delegados; portanto nao execute estes comandos em runs novas:

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
3. **Dirija os fluxos de usuario criticos** em desktop e mobile: home publica; servicos e pecas com imagens; institucional; carrinho/checkout; login administrativo; dashboard; refresh apos login; deep link protegido; estados empty/error/loading/success. **Para o viewport mobile, prefira Playwright MCP** (`browser_resize` altera a janela real do navegador headless) **a `claude-in-chrome`**: numa run real (OficinaAI, 2026-09-12), o resize do `claude-in-chrome` retornava sucesso mas a dimensao do screenshot nunca mudava, e o gate `visualAudit` fechou `BLOCKED` por `VIEWPORT_MISSING` — corretamente, sem forjar aprovacao, mas evitavel se Playwright MCP estivesse disponivel e tivesse sido a primeira escolha. Confirme a troca de viewport comparando as dimensoes do screenshot antes de seguir (nao confie so no retorno "sucesso" da chamada de resize); se nenhuma ferramenta capaz de mudar viewport estiver disponivel, registre a limitacao explicitamente (nao invente aprovacao mobile) e marque `visualAudit` como `BLOCKED`.
   - O roteiro obrigatoriamente inclui pelo menos um fluxo completo de mutacao do dominio central: criar -> decidir/aprovar -> confirmar um efeito colateral observavel na UI e na API. Uma navegacao apenas de leitura nao satisfaz esta fase.
4. **Em cada fluxo, verifique:**
   - console e network **sem erros de CORS** nem `net::ERR_FAILED`;
   - cada requisicao de API retorna 2xx **e a UI reflete o dado real** — desconfie de "200 mas a tela ficou vazia/inalterada", que e o sintoma classico de casing divergente ou campo `undefined`;
   - o **efeito final** de cada acao aconteceu de fato (o redirect abriu a aba/rota, o item entrou no carrinho, o registro apareceu na lista, o estado mudou) — nao apenas que a chamada retornou;
   - resolucao **multi-tenant / por host** funciona a partir do browser (o front informa o tenant certo ao back);
   - estados de tela (vazio/carregando/erro/sucesso) se comportam como especificado.
   - zero imagens quebradas, todo asset requerido visivel no fluxo normal com `alt`, seed apontando para URL real e nenhum emoji usado como icone;
   - para cada rota que o PRD/CA descreve como contendo imagem, execute `document.querySelectorAll('img[src]:not([src=""])')` (ou assercao Playwright equivalente) e registre ao menos um `<img src>` real e nao vazio no DOM; tokens computados, placeholders CSS ou a mera existencia do arquivo nao contam como imagem renderizada;
   - nenhum fallback mock silencioso, erro HTTP mascarado, token CSS indefinido ou valor visual hardcoded fora da allowlist;
   - consistencia monetaria, sessao preservada no refresh/deep link e navegacao equivalente ao design-contract.
   - **prova de persistencia real, nao so "200 e a tela mudou".** Uma run real (OficinaAI, 2026-09-16) teve 3 rodadas de review "APROVADO" com `gates.productionMockFallback: false` preenchido pelo proprio orquestrador, enquanto o painel interno inteiro lia/gravava em `localStorage` — porque so 4 de dezenas de telas foram auditadas, e nenhuma das 4 era uma tela de listagem. Quando houver `ui-data-map.json` (Fase 1.1), **toda tela** que ele declara precisa aparecer em `evidence.routes[]` — nao uma amostra. Para toda tela com leitura `scope: "list"`, crie um registro pela UI, **abra um contexto de navegador limpo** (aba anonima/nova sessao) e confirme que o registro **ainda existe** — isso e o que `route.persistenceProof` (`validate-ui-evidence.mjs`) exige e o que mecanicamente distingue uma lista real da API de um array de seed no cliente. Inspecione tambem `localStorage`/`sessionStorage`/IndexedDB no DevTools/Playwright e registre em `route.storageAudit.domainEntitiesInClientStorage` qualquer chave de entidade de dominio encontrada — uma lista nao-vazia ali e bloqueante (`DOMAIN_ENTITY_IN_CLIENT_STORAGE`), mesmo com `gates.productionMockFallback: false`.
5. **Capture evidencia**: screenshot e/ou o resumo de console+network dos fluxos exercitados, salvos em `.orchestrator/runs/<slug>/review/e2e-verification.md` (e screenshots em `.orchestrator/runs/<slug>/review/screenshots/`).
6. Grave `review/ui-evidence.json`, rode `validate-ui-evidence.mjs --evidence <arquivo> [--ui-data-map <ui-data-map.json>]` — com `--ui-data-map`, o validador tambem cruza cada tela declarada contra `evidence.routes[]` (`SCREEN_COVERAGE_INCOMPLETE` se faltar) e exige `persistenceProof` em toda tela de lista (`PERSISTENCE_PROOF_MISSING`) — e somente entao feche `gate --gate visualAudit --status DONE --evidence file:review/ui-evidence.json`.

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
