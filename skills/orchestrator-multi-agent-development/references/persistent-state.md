# Estado persistente, lifecycle e resume

Este documento é o contrato operacional de `state.json`, `events.jsonl`, completion gates, cancelamento e `/orchestrator resume`.

## Arquivos e fontes de verdade

Cada `.orchestrator/runs/<slug>/` contém, no **layout 2** (`state.layoutVersion: 2`, padrão de toda run nova):

```text
state.json                        snapshot materializado
events.jsonl                      fonte append-only da run
plan/
  tasks-classification.md         Fase 2
  waves.md                        Fase 3
contracts/                        Fase 4 (um arquivo por contrato)
run/
  monitoring.md                   Fases 5-9, arquivo vivo
  lifecycle-probe.json            último conjunto normalizado de probes
  executor-results/               respostas externas persistidas antes do consumo
  prompts/                        contexto de task externalizado, quando usado
review/
  review-final.md                 Fase 8
  review-frontend.md              Fase 9
  e2e-verification.md             Fase 9.5
  screenshots/                    evidência visual da Fase 9.5
report/
  implementation-report.md        Fase 10
  workflow-log.md                 Fase 10
  subagents-context.md            Fase 10
  handoff.json                    Fase 10, consumido pelo /executor
evidence/                         resultados determinísticos vinculáveis às tasks
learning/
  learning-report.md              saída obrigatória da Fase 12
```

`events.jsonl` é a fonte reconstruível da run. `state.json` é uma projeção otimizada para leitura. Nunca edite nenhum dos dois manualmente.

### Layout dos artefatos e compatibilidade

`state.layoutVersion` declara como o diretório da run está organizado:

- **1** — todos os artefatos na raiz da run. É o layout de qualquer run criada antes desta versão, e é reconhecido pela ausência do campo no snapshot.
- **2** — artefatos agrupados por estágio do workflow, como acima.

Isso é ortogonal a **onde** o diretório `<slug>/` em si vive: toda run nova nasce sob `.orchestrator/runs/<slug>/` (`currentRunsRoot()`); `.orchestration/<slug>/` é a raiz legada, só leitura (`legacyRunsRoot()`), para runs criadas antes da consolidação dos dois nomes quase-homônimos (`.orchestration/` vs `.orchestrator/`) num só. Uma run pode estar em qualquer combinação das duas raízes com qualquer um dos dois layouts de arquivo.

Três regras governam a resolução de caminho:

1. `state.json`, `events.jsonl` e `.state.lock` ficam na **raiz** da run nos dois layouts. A descoberta de run (`nextRunId`, `resume`, projeção de history e de knowledge) varre filhos diretos de **ambas** as raízes (`runRootCandidates()` em `artifact-layout.mjs`, atual primeiro) procurando `state.json`; mover esse arquivo esconderia a run e permitiria reuso de `runId`.
2. **Leitura** tenta o layout 2 e cai para o layout 1. Uma run antiga continua legível sem migração, e um artefato que você colocou manualmente no lugar antigo continua satisfazendo o gate correspondente — o caminho reportado na evidência é o caminho real (`file:review/review-final.md` ou `file:review-final.md`).
3. **Escrita** segue o layout declarado pela run, e nunca duplica um artefato que já existe no outro layout. Uma run em andamento não é reorganizada no meio do caminho.

Não existe migração automática de layout 1 para 2. Uma run terminal fica como está; uma run nova nasce no layout 2. Se você quiser reorganizar uma run antiga à mão, mova os arquivos e acrescente `layoutVersion: 2` ao snapshot — mas isso reprova `verify`, porque o snapshot passa a divergir do replay determinístico do event log. Na prática: não migre; deixe a run antiga no layout dela.

Para código que precise resolver esses caminhos, use `scripts/lib/artifact-layout.mjs` (`resolveArtifact`, `artifactWritePath`, `artifactTreePath`, `artifactRelativePath`) em vez de concatenar nomes de arquivo.

## O que versionar

O orquestrador escreve dois diretórios no projeto do usuário: `.orchestration/`/`.orchestrator/runs/` (por run, atual e legado) e `.orchestrator/` (por projeto — `project-config.md`, `project-memory.md`, `knowledge.db`, `learned/`, `worktrees/`, `history.db`, `backups/`, `telemetry.jsonl`).

**Padrão: gitignorar tudo.** `.orchestration/` e `.orchestrator/` inteiros ficam de fora do repositório do projeto alvo por padrão — mesma convenção que o `cc-pensador` já usa para `.pensador/`. Isso é uma inversão do comportamento anterior (que versionava `events.jsonl`, os `*.md` de decisão, `project-memory.md`, `learned/` e `knowledge.db` por padrão) e existe porque versionar esse estado tem um efeito colateral sério: apagar as pastas manualmente do disco **não** as remove do histórico do projeto — `git status` só marca como deletado-mas-rastreado, e o primeiro commit seguinte do próprio orquestrador que reescrever `state.json`/`events.jsonl` naqueles caminhos (uma operação normal de qualquer run) ressuscita o conteúdo antigo via mecânica comum do git. Foi exatamente assim que uma run recomeçou "do zero" mas encontrou de volta o estado de uma run anterior que o usuário já tinha apagado (`analise-run-oficina-saas-20260906.md`).

Sugestão de `.gitignore` do projeto (padrão):

```gitignore
.orchestration/
.orchestrator/
```

**Opt-in explícito — comportamento antigo.** Se o projeto quer `resume`/auditoria entre máquinas via Git (o que o padrão acima abre mão), use o bloco estreito abaixo em vez do de cima, e aceite o risco que ele reintroduz: worktree versionada ou removida por `git clean -fdx` quebra a wave em execução, e o SQLite em WAL (`knowledge.db`, `history.db`) gera conflito binário a cada commit concorrente.

```gitignore
.orchestrator/worktrees/
.orchestrator/backups/
.orchestrator/history.db
.orchestrator/telemetry.jsonl
*.db-wal
*.db-shm
```

Com esse bloco estreito, a tabela de referência por caminho (o que efetivamente fica rastreado) é:

| Caminho | Git | Por quê |
|---|---|---|
| `.orchestrator/runs/<slug>/events.jsonl` | versionar | fonte de verdade da run; permite `resume` e auditoria em outra máquina |
| `.orchestrator/runs/<slug>/*.md`, `report/handoff.json`, `contracts/` | versionar | artefatos de decisão e entrega |
| `.orchestrator/runs/<slug>/state.json` | opcional | projeção de `events.jsonl`; reconstruível por replay |
| `.orchestrator/runs/<slug>/run/executor-results/`, `evidence/`, `review/screenshots/` | opcional | saída bruta redigida; versionar só se a auditoria exigir |
| `.orchestrator/project-memory.md` | versionar | fatos validados que entram no contexto inicial |
| `.orchestrator/learned/` | versionar | recipes curadas; conhecimento deliberado, não derivado |
| `.orchestrator/knowledge.db` | versionar com cuidado | fonte das lessons/recipes; binário, faça commit com a run parada |

**Limitação residual — projetos que já têm histórico rastreado.** Inverter o padrão não desfaz o que já está commitado. Um projeto que já versionou `.orchestration/<slug>/` (ou `.orchestrator/`) em runs anteriores continua com esse histórico no repositório mesmo depois de adotar o `.gitignore` novo — `git rm --cached -r .orchestration .orchestrator` (num commit dedicado) é a única forma de fato remover o rastreamento existente. O orquestrador não automatiza essa migração; propor o `.gitignore` novo (Fase 1.K) não reescreve histórico.

## Invariantes

1. O evento é sincronizado em disco antes da troca atômica do snapshot.
2. Resultado de executor é persistido antes de alterar estado ou responder ao usuário.
3. Perda de ownership produz `UNKNOWN`; nunca presume `FAILED` ou `DONE`.
4. `DONE` exige evidência local: arquivo esperado/produzido, validação passando, delta de commit ou evidence ID durável.
5. Run terminal (`DONE`/`CANCELLED`/`PARTIAL`) é imutável e seu `runId` não pode ser reutilizado.
6. Task removida da classificação continua bloqueando o fechamento até `scope REMOVE|REINSTATE` explícito.
7. A run não fecha pela agregação das tasks. `run DONE` exige tasks, Fase 12, artefatos e completion gates.
8. Stall mede ausência de progresso, não duração total.

Esses invariantes adaptam os padrões de persist-before-delivery, ownership indeterminado e progress-aware timeout estudados no Hermes. A rastreabilidade das fontes está em `hermes-adaptation.md`.

## Estados

Tasks usam apenas:

```text
PENDING RUNNING DONE FAILED BLOCKED STALLED CANCELLED UNKNOWN PARTIAL
```

Runs usam:

```text
PENDING RUNNING DONE FAILED BLOCKED STALLED CANCELLED UNKNOWN
```

Sinais operacionais permanecem em `reasonCode`, preservando a grafia recebida (`QUOTA_EXHAUSTED`, `QUOTA_EXAUSTED`, `AUTH_REQUIRED`, `AGY_MISSING`, `TIMEOUT`, `NEEDS_SYNC`).

## Contrato mínimo de task

Toda task classificada precisa declarar:

- `category`, `complexity`, executor/modelo quando aplicável;
- `expectedFiles` ou `validationPlan` (evidence plan minimo);
- `allowedPaths` para escopo/worktree;
- `contractRequired` e `contractIds` quando houver troca front-back.

O estado também preserva `attemptHistory`, `sessionId`/`conversationId`, `retryDirective`, modelo solicitado/resolvido, `usage`, `durationSeconds`, `numTurns`, commits, evidências, lease e workspace. Recuperação de `STALLED`/`UNKNOWN` para uma sessão ainda viva mantém a tentativa; retry confirmado abre uma tentativa nova e reutiliza exatamente `--conversation <id>` quando disponível, ou `--continue` sem ID. Runs antigas permanecem legíveis sem migração.

## Snapshot da Project_Config e drift

`state.json` grava, na inicialização, um snapshot da Project_Config vigente:

```json
"projectConfig": {
  "schemaVersion": 1,
  "source": "file",
  "updatedAt": "2026-02-14T18:07:02Z",
  "roles": {
    "backendExecutor": "codex",
    "frontendExecutor": "agy",
    "backendReviewer": "codex",
    "frontendReviewer": "agy"
  }
}
```

Toda task despachada carrega `executor` e `executorSource` derivados desse snapshot no momento do dispatch — não do arquivo de configuração corrente. Isso é o que garante a regra 10.5: uma task já despachada continua reconciliada e projetada na telemetria com o Executor que de fato a executou, mesmo que a Project_Config mude depois.

`resume` compara o snapshot gravado com `.orchestrator/project-config.md` atual e devolve `projectConfigDrift`:

```json
"projectConfigDrift": {
  "changed": true,
  "differences": [{ "role": "frontendExecutor", "from": "agy", "to": "claude-code" }],
  "snapshotUpdatedAt": "2026-02-14T18:07:02Z",
  "fileUpdatedAt": "2026-03-01T09:00:00Z"
}
```

Run sem snapshot (criada antes desta versão) devolve `changed: false` e `source: "legacy"` — continua legível sem migração. Quando `changed: true`, apresente a diferença ao usuário e peça por `AskUserQuestion` a decisão entre manter o snapshot da Run e adotar a configuração atual, **antes** de despachar mais tasks.

Se o usuário adotar a configuração atual, aplique com escopo `pending` — reatribui `executor`/`executorSource` **somente** em tasks ainda `PENDING` com `attempt: 0`; toda task já despachada (`skippedTaskIds`) preserva o Executor do dispatch:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-state.mjs" project-config-apply \
  --dir .orchestrator/runs/<slug> --scope pending [--reason "<motivo>"]
```

A operação atualiza o snapshot e emite o evento `PROJECT_CONFIG_UPDATED` com `differences`, `appliedTaskIds`, `skippedTaskIds` e o motivo da mudança.

## Completion gates

Os gates persistidos são:

| Gate | Fase | Regra |
|---|---:|---|
| `visualMaterialization` | 4 | obrigatório quando existe front-end; exige `design-materialization.json` com `status: PASS` |
| `contractsInspected` | 4 | obrigatório quando existe qualquer arquivo em `contracts/`; cada contrato exige evidência válida de `inspect-contract.mjs` vinculada ao SHA-256 atual |
| `infraSmokeTest` | 4 | obrigatório quando existem back-end e front-end; exige `evidence/infra-smoke-test.json` schema v1, aplicável, real (não dry-run) e `PASS` |
| `monitoring` | 6 | sempre obrigatório — fecha junto com a Fase 6, exige evidência de telemetria (`run/monitoring.md` ou `--evidence`) |
| `backendReview` | 8 | obrigatório quando existe back-end |
| `frontendReview` | 9 | obrigatório quando existe front-end |
| `browserE2E` | 9.5 | obrigatório sempre que existe front-end; `N/A` é a única waiver de aplicabilidade e exige motivo explícito — `--delegated-to <plugin>` marca o caso em que outro plugin da cadeia assume a verificação (ver abaixo), sem o qual a `N/A` é um waiver puro |
| `reports` | 10 | sempre obrigatório |
| `handoff` | 10 | sempre obrigatório |
| `delivery` | 11 | sempre obrigatório |
| `learning` | 12 | sempre obrigatório |

`DONE` exige evidence ID/arquivo. Um gate não obrigatório pode ser `N/A` somente com motivo.

A aplicabilidade derivada por categoria responde apenas "existe front-end?". Um run só de front-end (SPA consumindo API separada já existente) é exatamente o caso da Fase 9.5 e mantém o gate `PENDING`. Quando front/back não usam origens separadas, registre a decisão arquitetural de forma explícita: `gate --gate browserE2E --status N/A --required false --reason "<topologia comprovada>"`. A topologia é julgamento do orquestrador e precisa ficar no motivo — nunca é inferida silenciosamente da mistura de categorias. Nenhum outro gate obrigatório aceita override.

### Delegação de gate ao Testador (modo conjunto a partir do Pensador)

Quando a run é modo conjunto (Fase 1 detectou `.pensador/<slug>-vN/handoff.json`) e `cc-testador-subagents` está instalado, a Fase 9.5 não roda aqui — o Testador é quem dirige o navegador. Isso **não é um waiver comum**: a verificação vai rodar, só que no próximo estágio da cadeia. Marque explicitamente:

```bash
node "$STATE" gate --dir .orchestrator/runs/<slug> --gate browserE2E \
  --status N/A --required false --delegated-to cc-testador-subagents \
  --reason "PENSADOR_CHAIN_DELEGATED_TO_TESTADOR"
node "$STATE" phase --dir .orchestrator/runs/<slug> --phase 9.5 --status N/A \
  --reason "PENSADOR_CHAIN_DELEGATED_TO_TESTADOR"
```

`auditRunCompletion`/`completionAudit` confirma a delegação contra `report/handoff.json.nextStage.consumer` — só conta como válida (não bloqueia `complete: true`) se o `nextStage` da run de fato apontar para o mesmo plugin. Se `cc-testador-subagents` não estiver instalado, `nextStage` degrada para `cc-executor-subagents` (regra já documentada na Fase 9.5 de `workflow.md`); nesse caso a delegação fica automaticamente inválida — `invalidDelegations` reprova com `DELEGATION_WITHOUT_NEXT_STAGE` e a run fecha `PARTIAL`, nunca `DONE`. Sem `report/handoff.json` legível, a delegação também fica inválida (falha fechada): não há como confirmar quem assumiu a verificação.

## CLI do State Engine

```bash
STATE="${CLAUDE_SKILL_DIR}/scripts/orchestration-state.mjs"

node "$STATE" init --slug <slug> --dir .orchestrator/runs/<slug> --phase 1
node "$STATE" sync --dir .orchestrator/runs/<slug>
node "$STATE" phase --dir .orchestrator/runs/<slug> --phase 5 --status RUNNING
node "$STATE" task --dir .orchestrator/runs/<slug> --task BE-01 --status RUNNING \
  --executor codex --session-id <id>
node "$STATE" heartbeat --dir .orchestrator/runs/<slug> --task BE-01 \
  --api-calls 7 --tool-calls 13 --current-tool Edit --in-tool true
node "$STATE" gate --dir .orchestrator/runs/<slug> --gate backendReview \
  --status DONE --evidence file:review/review-final.md
node "$STATE" audit --dir .orchestrator/runs/<slug>
node "$STATE" verify --dir .orchestrator/runs/<slug>
node "$STATE" run --dir .orchestrator/runs/<slug> --status DONE
```

Outros comandos: `scope`, `lease`, `workspace`, `sweep`, `reconcile`, `resume`, `cancel`, `status`.

## Resume e corrupção

`/orchestrator resume` seleciona a run ativa mais recente. `/orchestrator resume <runId>` seleciona exatamente a identidade pedida.

Ordem obrigatória:

1. localizar a run; a run mais recente corrompida retorna `RUN_CORRUPT` e nunca causa fallback silencioso;
2. adquirir lock, reparar tail incompleto e reproduzir eventos;
3. converter ownership interrompido de `RUNNING` para `UNKNOWN`;
4. persistir probes normalizados de Codex/AGY;
5. reconciliar executor, Git, arquivos e validações;
6. recuperar worktrees e leases;
7. reconstruir `currentWave` e `resumeFromPhase` pela sequência explícita `1..9, 9.5, 10..12`;
8. continuar somente após uma decisão comprovada.

`resume` também calcula `projectConfigDrift` (ver "Snapshot da Project_Config e drift" acima); se `changed: true`, apresente a diferença e decida com o usuário antes de despachar mais tasks.

O adapter desconhecido retorna `UNKNOWN`. `executorStatus=DONE` sem corroboração local retorna `UNKNOWN/COLLECT_LOCAL_EVIDENCE`.

## Heartbeat, lease e stall

Defaults:

- ocioso fora de tool: `450s`;
- dentro de tool: `1200s`;
- grace period: `120s`;
- lease: `900s`, renovada somente com atividade observável.

Iniciar `watch` em segundo plano é **obrigatório** assim que uma wave é despachada (ver Fase 5 em `workflow.md`) — `--adapter-config` é opcional e só melhora o sinal, não é o que torna o watch obrigatório:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-lifecycle.mjs" watch \
  --dir .orchestrator/runs/<slug> --adapter-config .orchestrator/executor-control.json \
  --interval-seconds 30
```

Cada tick imprime uma linha NDJSON `{"type":"tick",...}` no stdout imediatamente (inspecionável com o processo já rodando, não só ao final). Por padrão o loop para sozinho (`stoppedReason`) quando não sobra nenhuma task `RUNNING`/`STALLED`/`UNKNOWN` (`NO_ACTIVE_TASKS`) ou quando a run chega a um status terminal (`RUN_TERMINAL`); `--auto-stop=false` desliga isso. `updateCompletionGate --gate monitoring --status DONE` recusa fechar (`GATE_MONITORING_REQUIRES_SWEEP`) enquanto `lifecycle.lastSweepAt` estiver vazio — prova de que `tick`/`watch`/`sweep` rodou ao menos uma vez.

Sem adapter estável, o orquestrador executa a ação pela integração instalada, persiste seu retorno e usa `--external-confirmed`; nunca marca interrupt/dispatch apenas por intenção. Sem adapter, note também que `tick`/`watch` já rebaixa qualquer task `RUNNING` sem confirmação externa para `UNKNOWN` a partir do primeiro tick (ver regra 23 do `SKILL.md`) — isso não é regressão do watch obrigatório, é o comportamento pré-existente de `reconcileRunAtDirectory`, e é justamente o sinal visível que faltou na run analisada.

## Cancelamento

Cancelamento é protocolo, não atribuição direta:

1. `cancel --reason` impede novos dispatches;
2. tasks ativas viram `UNKNOWN` e recebem pedido de interrupção;
3. cada executor é consultado/reconciliado;
4. somente quando todas as tasks forem terminais a run pode virar `CANCELLED`.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-lifecycle.mjs" cancel \
  --dir .orchestrator/runs/<slug> --reason "pedido do usuário" \
  --adapter-config .orchestrator/executor-control.json --finalize
```

## Integridade final

`audit` recusa conclusão quando faltar task, resolução de escopo, evidence, gate, Fase 12 ou qualquer artefato obrigatório (`report/workflow-log.md`, `report/subagents-context.md`, `report/implementation-report.md`, `report/handoff.json`, `learning/learning-report.md`). `verify` compara snapshot e replay byte-semanticamente. Ambos precisam passar antes de `run DONE`.
