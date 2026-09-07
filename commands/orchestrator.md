---
description: Conduzir, retomar e manter um workflow multiagentico persistente que acumula conhecimento comprovado, com state machine, lifecycle, worktrees, validacao deterministica, telemetria e learning
argument-hint: "help | preflight | project-config | brain-pensador [--limit N] [--all] | status [runId] | resume [runId] | knowledge <sub> | telemetry <sub> | [--model <id>] [--parallel] [--subagent-model <id>] [--effort <nivel>] [--timeout <duracao>] <PRD>"
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(node:*), AskUserQuestion, Agent, TaskCreate, TaskUpdate, TaskList, Skill
---

# /orchestrator

Orquestra um **PRD ou especificacao ja pronta** com subagentes, do preflight ate a entrega auditada. Nao faz discovery nem planejamento: a especificacao fornecida e a fonte da verdade. Para produzir a especificacao, use `/pensador`; para uma resolucao rapida sem cerimonia, use `/executor`.

Alias em portugues: `/orquestrador`.

## Sinopse

```text
/orchestrator <PRD>                    orquestra uma especificacao pronta
/orchestrator help                     esta ajuda
/orchestrator preflight                valida dependencias e encerra
/orchestrator project-config           mostra/altera a stack de agentes do projeto
/orchestrator status [runId]           estado consolidado do run
/orchestrator resume [runId]           retoma o run sem presumir resultado
/orchestrator knowledge <sub>          memoria, historico e learned recipes
/orchestrator telemetry <sub>          produtividade/qualidade, metadata-only

flags (antes do PRD, em qualquer ordem):
  --model <id>           modelo do executor de front-end
  --parallel             fan-out de subagentes no executor de front-end
  --subagent-model <id>  modelo dos subagentes (implica --parallel)
  --effort <nivel>       effort da implementacao AGY (review permanece high)
  --timeout <duracao>    timeout de silencio das delegacoes AGY, ex.: 300s, 5m
```

## Subcomandos reservados

Interceptam o argumento: se `$ARGUMENTS` comeca com um destes, o PRD **nao** e ingerido.

| Subcomando | O que faz | Executa |
|---|---|---|
| `help` | imprime a Sinopse acima e encerra | nada |
| `preflight` | valida apenas as dependencias | `scripts/preflight.mjs` |
| `project-config` | mostra/altera a stack de agentes e revalida, sem iniciar run | `project-config.mjs show`/`write` + preflight |
| `config` | alias de `project-config` | idem |
| `brain-pensador [--limit N] [--all]` | lista os handoffs do Pensador em `.pensador/` para o usuario escolher um e entrar em modo conjunto | `brain-pensador.mjs` |
| `status [runId]` | estado do run (sem runId, o mais recente) | `orchestration-state.mjs status` |
| `resume [runId]` | retoma o run exato sem assumir resultado de task interrompida | `orchestration-state.mjs resume` |
| `knowledge status` | resume memoria, historico, recipes e Curator | `orchestrator-knowledge.mjs` + `orchestration-learning.mjs` |
| `knowledge search <query>` | busca FTS5 cross-run | `orchestrator-knowledge.mjs history-search` |
| `knowledge pin\|archive\|activate <recipeId>` | controla uma Learned Recipe explicitamente | `orchestration-learning.mjs recipe-*` |
| `knowledge curate [--apply]` | lifecycle do Curator; sem `--apply` e dry-run | `orchestration-learning.mjs curate` |
| `knowledge rollback <backupId> [--apply]` | valida/mostra ou restaura backup; sem `--apply` nao muta | `orchestration-learning.mjs rollback` |
| `knowledge render\|audit\|backups\|history-project` | mapeiam para os comandos homonimos das CLIs | `orchestrator-knowledge.mjs` |
| `telemetry report` | agrega produtividade/qualidade metadata-only | `orchestration-telemetry.mjs report` |
| `telemetry compact [--retention-days N] [--apply]` | preview/aplica retencao recuperavel | `orchestration-telemetry.mjs compact` |
| `telemetry otlp-preview\|otlp-export` | exporta metadata allowlisted; endpoint explicito, HTTPS por padrao | `orchestration-telemetry.mjs otlp-*` |

`pin`/`archive`/`activate`/`rollback` exigem ID explicito; nunca escolha uma recipe ou backup por inferencia.

## Flags

| Flag | Valores | Default | Alias legado |
|---|---|---|---|
| `--model <id>` | alias de capacidade (`flash-low` … `pro-high`) ou slug dinamico valido | piso por heuristica + router adaptativo | `--agy-model` |
| `--parallel` | — | heuristica por task (2+ entregaveis independentes) | `--agy-parallel` |
| `--subagent-model <id>` | mesmos valores de `--model`; implica `--parallel` | `inherit` | `--agy-subagent-model` |
| `--effort <nivel>` | `low`, `medium`, `high` | padrao do executor | `--agy-effort` |
| `--timeout <duracao>` | duracao de silencio, ex.: `300s`, `5m` | padrao do bridge | `--agy-timeout` |

Os aliases legados continuam aceitos em silencio e produzem exatamente o mesmo efeito. `--effort` vale **apenas para a implementacao AGY**: o review permanece em `high` e nunca e reduzido por override.

A escada de capacidade, o piso por dificuldade e as regras do router adaptativo vivem em `SKILL.md` e `references/agent-stack.md` — nao os reproduza aqui. Overrides do usuario aceitam slug dinamico (o bridge 4.0 resolve o catalogo em runtime); heuristica e adaptacao usam apenas os aliases estaveis, e o historico adaptativo e agregado pelo alias solicitado, nao pelo slug versionado resolvido.

## Regra central de execucao

O Claude atua **somente como orquestrador**: mantem contexto, decide proximos passos, atualiza artefatos de coordenacao e delega implementacao. Ele nao implementa codigo diretamente e nao reabre o entendimento da demanda.

Roteamento por categoria da task, respeitando a Project_Config do projeto:

- Toda task `FRONTEND_ONLY` vai para o executor de front-end configurado, inclusive setup Vite/React, rotas, tipos TypeScript, servicos API e componentes simples. A delegacao chama o bridge com `--mode accept-edits --format stream-json --model <agyModel>`; o bridge consulta `agy models`, resolve aliases e encaminha `--model` nativamente, sem modificar configuracoes do usuario.
- `cc-antigravity-plugin:antigravity-agent` e **somente leitura** (analise, planejamento, review). Manda-lo implementar e erro de roteamento.
- `--agent` seleciona um agente customizado do AGY e **nao** substitui `antigravity-coder`/`antigravity-agent`.
- Codex so recebe front-end como fallback operacional registrado, depois de falha/cota do AGY ou decisao explicita do usuario.
- Review back-end usa Codex com `--effort high`; review front-end usa `--read-only --format json --model pro-high --effort high`, independente do `--model` de implementacao. Codex nunca revisa front-end.

Politica de cota, de sandbox Codex e de fallback por `reasonCode` (`QUOTA_EXHAUSTED`, `AUTH_REQUIRED`, `AGY_MISSING`, `TIMEOUT`): ver `SKILL.md` e `references/agent-stack.md`. Preserve o status cru devolvido pelo bridge em `reasonCode`; nao normalize nem invente codigo.

## O que o workflow cobre

0. Preflight, resolucao da Project_Config e instalacao assistida das dependencias ausentes
1. Project Memory comprovada + historico FTS5 + ingestao do PRD/especificacao
2. Classificacao das tasks com contrato, evidence plan, scope, complexidade e features
3. Ondas, routing adaptativo conservador e plano de worktrees
4. Contratos API/UI e programmatic validation para toda troca front-back
5. Delegacao paralela em worktrees elegiveis
6. Lifecycle Manager com probes, leases, heartbeat, stall/grace e reconciliacao
7. Integracao recuperavel e validacao deterministica de diff/escopo/wire/testes
8. Review back-end pos-implementacao (somente back-end)
9. Review front-end pos-implementacao (ignorar se nao houver front-end)
10. `report/workflow-log.md` + `report/subagents-context.md` + `report/implementation-report.md` + handoff
11. Entrega duravel ainda nao publicada
12. `learning/learning-report.md`, candidate lessons, history/telemetry, audit terminal e publicacao

Cada run mantem `.orchestrator/runs/<slug>/state.json` e `events.jsonl`; o projeto mantem `.orchestrator/project-memory.md`, `knowledge.db`, `history.db`, `telemetry.jsonl` e `learned/`. Toda transicao terminal e persistida antes de ser anunciada; uma task cujo resultado nao puder ser determinado apos interrupcao fica `UNKNOWN`, nunca `FAILED` por suposicao. Memoria aceita apenas fatos com fonte comprovada, e learning nunca edita a skill automaticamente.

---

## Fluxo

### Passo 1 - Preflight, configuracao do projeto e instalacao assistida

A Fase 0 tem quatro etapas, nesta ordem: preflight, resolucao da Project_Config, instalacao assistida e novo preflight. A ordem e obrigatoria — a coleta da configuracao vem antes de qualquer oferta de instalacao, porque o conjunto de CLIs obrigatorias depende dos papeis escolhidos. Numa run nova sem arquivo de configuracao isso produz ate tres preflights.

Leia `references/project-config.md` (perguntas, defaults, roteamento derivado, protocolo do Dependency_Installer) e `references/mcp-context.md` (protocolo do CBM_MCP e do Context7_MCP) antes de conduzir estas etapas.

#### Passo 1.1 - Preflight

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/preflight.mjs"
```

Parse o JSON retornado:

- `status: "ok"` -> siga.
- `status: "failed"` -> cancele imediatamente e use `remediation`.

O relatorio traz:

- `projectConfig` — os quatro papeis efetivos, `path`, `updatedAt`, `requiredCliSet` e `source: "file" | "default"`;
- `warnings` no topo — reprovado opcional e MCP ausente, com `reason` `NOT_DETECTED`, `TIMEOUT` ou `NOT_REQUIRED_BY_PROJECT_CONFIG`;
- `checks.optional.mcp.codebase-memory` e `checks.optional.mcp.context7` — evidencias e comandos de instalacao dos dois MCPs;
- `failed` — apenas reprovado obrigatorio. MCP ausente e CLI nao exigida pela configuracao ficam em `warnings` e nao bloqueiam.

O JSON inclui `autoRemediation`. Se a permissao `Bash(node:*)` foi criada ou ajustada em `.claude/settings.json`, reporte isso ao usuario junto com o status final e diga se a correcao foi revalidada.

O preflight valida `cc-antigravity-plugin >= 4.0.0`, AGY `>= 1.1.8` (com recomendacao de `1.1.16`) e a presenca de `agents/antigravity-coder.md` (implementacao), `agents/antigravity-agent.md` (review read-only), `commands/antigravity.md` e `scripts/antigravity-bridge.js` — todos obrigatorios somente quando algum papel da Project_Config e `agy`. O mesmo vale para `cli.codex` e `plugins.openai-codex`, obrigatorios somente quando algum papel e `codex`.

Tambem exige Node.js `>=22.13.0`, `node:sqlite` sem flag experimental e SQLite FTS5. Essa checagem e bloqueante em qualquer configuracao de projeto, porque Project Memory, history, recipes e adaptive routing dependem dela.

#### Passo 1.2 - Resolucao da Project_Config

Decida pelo bloco `projectConfig` e pelo check `checks.config.project-config`:

- `source: "file"` -> a configuracao existe e e valida. Carregue-a e **nao repita as quatro perguntas**; va direto para o Passo 1.3.
- `source: "default"` com arquivo ausente -> apresente as quatro perguntas de `AskUserQuestion` (`backendExecutor`, `frontendExecutor`, `frontendReviewer`, `backendReviewer`) **antes de oferecer qualquer instalacao**, com as descricoes e a CLI exigida por opcao de `references/project-config.md`. Grave com `project-config write` (papel sem resposta vai em `--default-applied` e recebe o default) e rode o preflight novamente para obter o Required_CLI_Set efetivo.
- `checks.config.project-config.ok: false` -> o arquivo existe e e invalido. Pare com o erro do parser e a remediacao de corrigir ou remover `.orchestrator/project-config.md`, preservando o conteudo atual. Nao sobrescreva o arquivo dentro de uma run.

Registre em `report/workflow-log.md` a configuracao efetiva, a origem e os papeis com `default-aplicado`. `frontendReviewer: codex` sobrepoe a politica padrao de review front-end pelo AGY: registre a sobreposicao e avise o usuario uma unica vez por run.

#### Passo 1.3 - Instalacao assistida

Com a Project_Config resolvida, monte a lista de dependencias ausentes: CBM_MCP ausente, Context7_MCP ausente e, para cada CLI do Required_CLI_Set, a propria CLI (quando `checks.cli.*` reprova) e o plugin do Claude Code que a conecta (quando `checks.plugins.*` reprova) — `openai-codex` para `codex`, `cc-antigravity-plugin` para `agy` (MCPs primeiro, depois CLI+plugin por CLI). CLI e plugin sao reprovacoes independentes: CLI instalada nao implica plugin instalado, e vice-versa. Use `scripts/lib/dependency-plan.mjs` (`buildMissingDependencies(report, { platform })`) como catalogo de comandos por SO em vez de reescrever comandos no prompt.

- Uma pergunta `AskUserQuestion` **por dependencia**, com as opcoes `instalar` e `seguir sem instalar`, informando nome, beneficio, impacto de seguir sem ela e o comando que sera executado.
- Execute comando de instalacao somente depois de o usuario responder `instalar` para aquela dependencia. Nunca agrupe dependencias numa pergunta so.
- Passos interativos ficam com o usuario: `codex login` depois da CLI `codex`, primeira execucao de `agy` para autenticar o AGY, e reinicio do agente de codigo para carregar um MCP recem-instalado.
- Exit code diferente de zero -> registre o codigo de saida e a ultima linha de erro, apresente a remediacao manual e peca decisao ao usuario antes de prosseguir. Sem loop de retry.
- `seguir sem instalar` em dependencia opcional (MCP) -> registre a limitacao em `report/workflow-log.md` e siga pelo caminho deterministico de `references/mcp-context.md`.
- `seguir sem instalar` em CLI do Required_CLI_Set -> ofereca por `AskUserQuestion` trocar o papel afetado para `claude-code` (regravando a configuracao e rodando o preflight de novo) ou encerrar o workflow. Nunca troque o papel por conta propria.
- Registre por dependencia apenas `name`, `decision`, `command`, `exitCode` e `durationMs` (`summarizeInstallOutcome`). Nada de stdout bruto, conteudo de arquivo de configuracao, chave de API ou cabecalho de autenticacao.

#### Passo 1.4 - Novo preflight

Concluidos todos os comandos confirmados, rode o preflight uma vez e apresente ao usuario o novo `status`, o Required_CLI_Set efetivo, os itens reprovados e os avisos. Esse preflight e obrigatorio mesmo que toda instalacao tenha retornado zero — e ele que confirma que a dependencia ficou visivel para o ambiente.

Com `checks.optional.mcp.codebase-memory.ok: true`, o protocolo de grafo de `references/mcp-context.md` passa a valer (gate de `index_status` antes de usar qualquer resultado como evidencia). Com `checks.optional.mcp.context7.ok: true`, avise o usuario que documentacao atual sera exigida nos prompts dos subagentes.

### Passo 2 - Carregar a skill

`Skill(skill="cc-orchestrador-subagents:orchestrator-multi-agent-development")`.

### Passo 3 - Validacoes leves antes da ingestao

Antes dessas validacoes, parseie as flags no inicio de `$ARGUMENTS` (em qualquer ordem, aceitando tambem os aliases legados da tabela de Flags):

- `--model <id>`: aceite alias de capacidade ou slug dinamico seguro e registre `agyModelSource: user`.
- `--parallel`: registre `agyParallel: yes` e `agyParallelSource: user` para todas as tasks AGY.
- `--subagent-model <id>`: aceite alias ou slug dinamico seguro, registre `agySubagentModel: <id>` e ligue `agyParallel: yes` automaticamente.
- `--effort <low|medium|high>`: valide e registre `agyEffort` nas tasks AGY de implementacao; **nao** reduza o effort `high` do review.
- `--timeout <duracao>`: valide e registre `agyTimeout` em toda delegacao AGY.

Remova todos os prefixos reconhecidos do argumento. Sem override de modelo, registre `agyModelSource: heuristic`. Sem `--parallel`, o orquestrador avalia por heuristica task a task.

- Se a demanda e trivial (typo, padding, rename) -> avise que o orquestrador e overkill e ofereca executar direto.
- Se o usuario nao forneceu um PRD/especificacao (nenhum arquivo mencionado/enviado e nenhuma spec colada) -> use `AskUserQuestion` pedindo o PRD/spec antes de continuar. O orquestrador nao inventa a especificacao.

### Passo 3.5 - Carregar conhecimento comprovado

Antes de classificar tasks, inicialize/audite a Project Memory e reconstrua a projecao historica:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator-knowledge.mjs" init
node "${CLAUDE_PLUGIN_ROOT}/scripts/intelligence/inspect-project.mjs" --root "." --persist-knowledge
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator-knowledge.mjs" audit
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator-knowledge.mjs" history-project
```

Leia `.orchestrator/project-memory.md` junto do PRD. Nao use fatos `STALE`, `CONFLICT` ou `REVOKED`. Se o PRD/ambiente trouxer error fingerprints, stacks ou padroes relevantes, use `history-search` e carregue apenas o resultado condensado. Historico nao substitui a especificacao nem autoriza aplicar recipe sem trigger deterministico.

### Passo 4 - Conduzir o workflow

Siga `SKILL.md` + `references/*.md`. Crie os artefatos de coordenacao em `.orchestrator/runs/<nome>/`, onde `<nome>` e um identificador descritivo em kebab-case derivado do PRD/spec. Use `assets/*.md` para os templates.

Assim que `<nome>`/`<slug>` estiver resolvido, inicialize o run antes de continuar:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-state.mjs" init \
  --slug "<nome>" --dir ".orchestrator/runs/<nome>" --phase 1
```

Depois de gerar `plan/tasks-classification.md` e `plan/waves.md`, rode `node "${CLAUDE_PLUGIN_ROOT}/skills/orchestrator-multi-agent-development/scripts/validate-routing.mjs" ".orchestrator/runs/<nome>"` ou o caminho equivalente via `${CLAUDE_SKILL_DIR}`. Se falhar, corrija os artefatos antes de delegar.

Depois que o roteamento passar, sincronize tasks/waves no snapshot:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-state.mjs" sync \
  --dir ".orchestrator/runs/<nome>"
```

Antes do validator final, tasks AGY sem override consultam `orchestration-router.mjs route`. Preserve o piso heuristico e grave a decisao com `--record`; `source: adaptive` exige `agyModelEvidence`, caso contrario mantenha `heuristic`. Depois de `sync`, execute `orchestration-worktree.mjs plan` por wave. So `ISOLATED` pode ser criado/rodado concorrentemente; `SERIAL`/`UNSCOPED` aguardam.

Antes/depois de cada fase, persista `phase --status RUNNING|DONE|FAILED|BLOCKED|CANCELLED|UNKNOWN` com evidencia. Antes de lancar um subagente, crie a worktree elegivel, adquira lease e persista a task como `RUNNING` com executor, modelo, attempt e `sessionId`/`conversationId`. Assim que a ultima task da wave estiver `RUNNING`, inicie `orchestration-lifecycle.mjs watch` em segundo plano — obrigatorio, com ou sem `--adapter-config` (sem adapter ele ja rebaixa RUNNING nao confirmado para `UNKNOWN` e marca `STALLED` por inatividade). `updateCompletionGate --gate monitoring --status DONE` recusa fechar sem ao menos um tick/sweep ter rodado. O retorno externo redigido deve ser persistido antes de `DONE`/`FAILED`/`BLOCKED` e antes de anunciar o resultado. Use apenas estados canonicos e preserve quota/auth/timeout em `reasonCode`.

Na integracao, use `ready` + `integrate` para worktrees e os scripts `inspect-diff`, `validate-task-scope`, `inspect-api-ui`, `validate-wire-format` e `collect-test-results` para mecanica repetitiva. Se a operacao exigiria tres ou mais Greps/Reads, loop ou comparacao mecanica, a regra e usar script deterministico e consumir seu JSON condensado.

Depois de reports/handoff e da entrega duravel da Fase 11, execute a Fase 12 antes de fechar a run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-learning.mjs" run --dir ".orchestrator/runs/<nome>"
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator-knowledge.mjs" history-project --dir ".orchestrator/runs/<nome>"
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-telemetry.mjs" project --dir ".orchestrator/runs/<nome>"
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-state.mjs" audit --dir ".orchestrator/runs/<nome>"
```

Somente com `audit.complete: true`, todas as tasks/gates/evidencias/artefatos completos e Phase 12 `DONE`, marque `run --status DONE`, rode `verify`, reprojete history/telemetry e publique a mensagem ao usuario. Candidate lessons nunca sao promovidas automaticamente nem alteram `SKILL.md`.

As tasks `FRONTEND_ONLY` e a fatia front-end de `FULLSTACK` devem registrar `agyModel` e `agyModelSource: user|heuristic|adaptive` em `plan/tasks-classification.md` e `plan/waves.md`; `adaptive` sem `agyModelEvidence` e invalido.

Antes de iniciar cada fase e antes de lancar ou redelegar subagentes, faca um gate operacional:

- Se a mensagem mais recente do usuario indicar cancelamento, pausa, reprovacao do plano/contrato ou problema bloqueante, interrompa imediatamente.
- Nao invoque novos subagentes, nao edite implementacao e nao avance de fase.
- Atualize `run/monitoring.md`, `report/workflow-log.md` e `report/subagents-context.md` com `CANCELLED` ou `PAUSED` quando ja houver artefatos.

### Passo 5 - Reportar updates

Mantenha o usuario informado com mensagens curtas:

- `preflight OK`
- se houve auto-correcao: `preflight auto-remediou Bash(node:*) em .claude/settings.json e revalidou`
- `stack do projeto: back-end <executor>, front-end <executor>, review back-end <revisor>, review front-end <revisor> (origem: file|default)`
- se houve instalacao: `instalei <N> dependencias confirmadas e rodei o preflight de novo: status <ok|failed>`
- `Context7 MCP detectado; vou exigir docs atuais nos prompts dos subagentes`
- `Codebase Memory MCP detectado; vou consultar index_status antes de usar o grafo como evidencia`
- `Project Memory auditada; carreguei apenas fatos validados e projetei o historico pesquisavel`
- `especificacao ingerida; classificando tasks em .orchestrator/runs/<nome>`
- `wave <N>: <X> tasks isoladas em worktrees e <Y> serializadas por overlap/escopo`
- `lancei <N> subagentes em paralelo para a onda <N>, aviso quando completarem`
- no fim: caminhos do `report/workflow-log.md`, `report/implementation-report.md`, `report/subagents-context.md` e `learning/learning-report.md` + resumo e instrucoes de negocio
- no fim: confirme `audit.complete: true`, Phase 12, history/telemetry projetados, `runId` terminal e `verify` aprovado

---

## Modos

Cada ramo abaixo **substitui** a execucao de PRD: nao inicialize run, nao crie `.orchestrator/runs/<slug>/`, nao ingira especificacao e nao delegue agentes.

### Modo help

Imprima a Sinopse, a tabela de Subcomandos reservados e a tabela de Flags. Nao rode script nenhum e encerre.

### Modo preflight

Se `$ARGUMENTS` for exatamente `preflight`, rode apenas:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/preflight.mjs"
```

Mostre o resumo do JSON ao usuario e encerre. O relatorio ja traz o bloco `projectConfig` com os quatro papeis efetivos e o `requiredCliSet` derivado; neste modo nao colete configuracao nem ofereca instalacao.

### Modo brain-pensador

Descobre e lista os handoffs do Pensador em `.pensador/` — um por slug (a maior `-vN`), ordenados por recencia — para o usuario escolher qual implementar em modo conjunto, sem precisar saber o slug de cabeca. Fecha a lacuna de `ingestPensadorHandoff()` na Fase 1: com mais de um slug distinto e nenhum `--slug` explicito, ela devolve `mode: "ambiguous"` com uma lista de nomes crus e para ali.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/orchestrator-multi-agent-development/scripts/brain-pensador.mjs" --root "." [--limit 10] [--all]
```

Read-only, nunca escreve em `.pensador/`. Sem `--limit`/`--all`, lista os 10 mais recentes; `--all` remove o corte. Cada linha traz `slug`, `latestVersion`, `versions`, `status`, `summary`, `deliverable` (`prd`\|`spec`), `hasDesignSystem`, `updatedAt` e `consumedBy` (o `runId` que ja ingeriu aquele handoff, via `state.upstream.handoffPath`, ou `null`).

Apresente a lista ao usuario por `AskUserQuestion` — priorize os que `consumedBy` for `null` — e, com o slug escolhido, prossiga exatamente como o modo conjunto normal da Fase 1 prossegue com um slug explicito (`ingestPensadorHandoff({ slug })`, ver `references/workflow.md` Fase 1). Um slug com `consumedBy` preenchido ja foi implementado; confirme explicitamente antes de reprocessa-lo.

### Modo status

Se o primeiro argumento for `status`, trate o segundo, quando presente, como `runId`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-state.mjs" status
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-state.mjs" status "operatus-equipamento-20260814-001"
```

Apresente fase atual, wave, contagem de tasks por estado e pendencias. Este modo e **read-only**: nao repare log, nao reconcilie e nao mude estado — para isso existe `resume`. Se o state engine retornar `RUN_NOT_FOUND`, informe e encerre.

### Modo project-config

Aceita tambem `config`. Leia `references/project-config.md` por completo ao entrar neste modo.

Etapa 1 - mostre a configuracao vigente e a origem (`file` = `.orchestrator/project-config.md`; `default` = padrao `codex`/`agy`/`codex`/`agy`):

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/orchestrator-multi-agent-development/scripts/project-config.mjs" show --root "."
```

`show` devolve `{ config, source, path, exists, requiredCliSet }`. `validate` e `required-clis` existem para checagem isolada e nunca gravam.

Etapa 2 - se `show` retornar `ok: false` com erro do parser (`PROJECT_CONFIG_FIELD_MISSING`, `PROJECT_CONFIG_INVALID_VALUE`, `PROJECT_CONFIG_SCHEMA_UNSUPPORTED`, `PROJECT_CONFIG_UNPARSEABLE`), apresente o erro nomeando campo, valor recebido, conjunto aceito e caminho, e ofereca por `AskUserQuestion` a regravacao do arquivo a partir de novas respostas. Nao sobrescreva o arquivo sem confirmacao explicita.

Etapa 3 - apresente as quatro perguntas de `AskUserQuestion` (`backendExecutor`, `frontendExecutor`, `frontendReviewer`, `backendReviewer`) com o texto, as descricoes de papel e a CLI exigida por opcao de `references/project-config.md`, marcando o **valor vigente** de cada papel como opcao default.

Etapa 4 - grave as respostas. Papel sem resposta entra em `--default-applied` e recebe o default da referencia; omita a flag quando todos os quatro papeis foram respondidos:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/orchestrator-multi-agent-development/scripts/project-config.mjs" write --root "." \
  --backend-executor "<codex|agy|claude-code>" \
  --frontend-executor "<codex|agy|claude-code>" \
  --backend-reviewer "<codex|agy|claude-code>" \
  --frontend-reviewer "<codex|agy|claude-code>" \
  --default-applied "<papel,papel>"
```

`write` grava `updatedAt` novo e devolve `changed` (papeis alterados) e `previous`. Nunca edite `.orchestrator/project-config.md` a mao: o renderer e a unica rota de gravacao.

Etapa 5 - rode o preflight uma vez, sempre, inclusive quando `changed` vier vazio:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/preflight.mjs"
```

- `changed` vazio -> informe que nenhum papel mudou e apresente o resultado da revalidacao.
- `changed` com papeis -> apresente o novo `status`, o `projectConfig.requiredCliSet` e os itens de `failed` e `warnings`.

Etapa 6 - se o preflight reprovar uma CLI do Required_CLI_Set ou o plugin do Claude Code que a conecta (`openai-codex`/`cc-antigravity-plugin`), acione o Dependency_Installer para o item reprovado, com o mesmo protocolo do Passo 1.3: uma pergunta por dependencia, execucao somente apos `instalar`, tratamento de exit code diferente de zero e novo preflight ao final. Depois disso encerre o comando; nenhuma run e iniciada.

### Modo resume

Se o primeiro argumento for `resume`, trate o segundo argumento, quando presente, como `runId`. Antes de qualquer nova delegacao, execute:

```bash
# Sem runId: seleciona a run ativa mais recente
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-state.mjs" resume

# Com runId/slug explicito
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-state.mjs" resume "operatus-equipamento-20260814-001"
```

O comando faz replay/reparo do log, muda tasks previamente `RUNNING` para `UNKNOWN`, reconcilia Git/arquivos e retorna `resumeFromPhase`, `currentWave`, `pendingExternalProbes` e `recommendations`.

Para cada `pendingExternalProbes`:

1. consulte `TaskList` e as capacidades de retomada/status do subagente instalado;
2. para Codex, correlacione pelo `sessionId`/task ID; para AGY, correlacione pelo `conversationId` e pelo retorno persistido do bridge;
3. se a integracao nao expuser status autoritativo, mantenha `UNKNOWN` e use Git, arquivos e validacoes apenas como evidencia — nunca como prova isolada de sucesso;
4. grave um `.orchestrator/runs/<slug>/reconciliation-probe.json` sem secrets, no formato de `references/persistent-state.md`, e rode:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-state.mjs" reconcile \
  --dir ".orchestrator/runs/<slug>" \
  --probe-file ".orchestrator/runs/<slug>/reconciliation-probe.json"
```

Quando `.orchestrator/executor-control.json` existir e validar contra `executor-control-config.schema.json`, prefira a reconciliacao automatizada:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-lifecycle.mjs" tick \
  --dir ".orchestrator/runs/<slug>" --resume \
  --adapter-config ".orchestrator/executor-control.json"
```

O manager persiste o retorno redigido/limitado do executor em `run/executor-results/` antes de atualizar o state. Sem adapter ou status autoritativo, mantenha `UNKNOWN`; Git/arquivos/testes sao corroboracao, nao substitutos de ownership externo.

Nao redelegue task `UNKNOWN` ate confirmar que a sessao/conversation anterior nao segue ativa e avaliar mudancas parciais. Depois da reconciliacao, rode o preflight; se passar, carregue a skill e continue exatamente de `resumeFromPhase`/`currentWave`. Se o state engine retornar `RUN_NOT_FOUND`, informe o erro e encerre sem criar um run novo implicitamente.

Este ramo substitui a ingestao/inicializacao de uma run nova: nao interprete `resume` como PRD, nao execute `init` novamente e nao passe pela validacao de "PRD ausente" do Passo 3. Apos preflight + carregamento da skill, salte diretamente para a fase/wave devolvida pelo state engine.

Leia `references/persistent-state.md` por completo ao entrar neste modo.

### Modo knowledge

Mapeie o segundo argumento conforme a tabela de Subcomandos reservados:

```bash
# status consolidado (execute os tres)
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator-knowledge.mjs" status
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator-knowledge.mjs" history-status
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-learning.mjs" curator-status

# busca historica
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator-knowledge.mjs" history-search "<query>"

# lifecycle explicito de recipe
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-learning.mjs" recipe-pin --id "<id>"
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-learning.mjs" recipe-archive --id "<id>"
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-learning.mjs" recipe-activate --id "<id>"

# curator/rollback: preview por padrao; mutacao so com --apply do usuario
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-learning.mjs" curate [--apply]
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-learning.mjs" rollback --backup "<id>" [--apply]
```

`render`, `audit`, `backups` e `history-project` mapeiam para os comandos homonimos das CLIs. Mostre contradicoes e `needsReview`; recipe contraditoria nao pode ser aplicada.

### Modo telemetry

Mapeie `report`, `compact`, `otlp-preview` e `otlp-export` para `scripts/orchestration-telemetry.mjs`. `compact` e dry-run sem `--apply`; export OTLP exige endpoint fornecido explicitamente, usa HTTPS por padrao e envia somente metadata allowlisted.

---

## Execucao autonoma com `/goal`

Para trabalho independente entre turnos, o modo recomendado e envolver a demanda em `/goal`.

```text
/goal Execute a skill cc-orchestrador-subagents:orchestrator-multi-agent-development para orquestrar a especificacao: <PRD/spec>. Condicao de conclusao: preflight e SQLite/FTS5 OK; Project Memory auditada; especificacao ingerida; tasks classificadas com evidence plan/scope e roteamento validado; worktrees/lifecycle encerrados ou bloqueios documentados; reviews e E2E aplicaveis executados; reports/handoff e learning/learning-report.md criados; Phase 12 concluida; history/telemetry projetados; audit.complete=true; run DONE e verify OK; so entao resultados e instrucoes publicados; ou pare preservando o estado sem presumir resultado.
```

## Quando o usuario invocar sem argumento

Se `$ARGUMENTS` estiver vazio, use `AskUserQuestion` para pedir o PRD/especificacao a orquestrar.

## Quando nao usar

Se a demanda for troca de texto, cor, padding, typo, import order ou ajuste de 1-2 linhas, ofereca execucao direta sem orquestracao.
