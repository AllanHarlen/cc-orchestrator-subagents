# Changelog

## [4.25.0] — 2026-09-25 — Protótipo do Open Design nas tasks de front-end, cobertura RF/RNF/ARC, parser sem crase e log de eventos compacto

- **Removido:** o script determinístico `convert-design-prototype.mjs` (e a flag `--convert-design`/`--transpile-design`) que tentava transpilar HTML/CSS do protótipo do Open Design para React/Vue/etc. via regex. Não funcionava (fallback fora do React quebrava com `ReferenceError: htmlContent is not defined`, o HTML real do Open Design não compilava como TSX em vários casos, `<head>`/`<script>` eram descartados, e o resultado nunca era commitado antes da criação das worktrees da Fase 5, então `INTEGRATION_ROOT_DIRTY` bloqueava a integração) — era trabalho não comitado, nunca chegou a rodar num projeto real.
- **Abordagem:** o Open Design só gera HTML/CSS/JS; a stack real do projeto (React, Vue, Angular, Blazor, …) é a definida pelo PRD. Em vez de um script convertendo mecanicamente, o Orquestrador passa o caminho do `design-prototype` (quando o handoff do Pensador o traz — obrigatório sempre que o Open Design foi usado, ver `cc-pensador` 2.38.0) no prompt de toda task front-end da Fase 5, junto com `design-system-files`/`tokens.css`, delegando ao AGY a reprodução da hierarquia visual e dos estados de interação do protótipo nos componentes idiomáticos da stack real. `references/workflow.md` (secção 4.0b) e `SKILL.md` documentam essa referência em vez do script removido.
- **Gate de fidelidade (Fase 9):** o `visualAudit` passa a comparar as telas implementadas também contra o protótipo (quando existir), como evidência adicional de layout/hierarquia — não como diff mecânico de arquivos.

### Auditoria da run OficinaAI (2026-09)

- **Parser da Fase 2 aceita campos sem crase:** `contractIds: CT-01`, `allowedPaths: backend/**`, `expectedFiles: a, b` e `validationPlan: x; y` eram descartados em silêncio quando escritos sem crase — as 13 tasks da run chegaram ao `state.json` sem contrato, escopo, arquivos esperados nem plano de validação, desligando a validação de escopo e o planner de worktree. Crase continua tendo precedência; `validationPlan` sem crase separa por `;` (vírgula é comum dentro de um item).
- **Log de eventos compacto:** `STALL_SWEEP_COMPLETED` e `RUN_RECONCILED` gravam só as tasks alteradas (`changedTasks`) em vez do mapa inteiro; o `events.jsonl` da run tinha 10 MB (418 de 499 eventos eram varreduras, 190 sem mudança nenhuma). Eventos antigos com `tasks` completo continuam sendo reaplicados; o replay do log compacto reproduz o snapshot.
- **Cobertura RF/RNF/ARC:** `requirements-coverage.mjs` soma `requirements`, `nonFunctionalRequirements` e `architecturePatterns` do `requirements.json` (cc-pensador 2.38.0) e o parser reconhece `RNF-XX`/`ARC-XX` em `requirementIds`. `SKILL.md` e o template `assets/requirements-evidence.template.json` mostram como registrar evidência para um RNF/ARC (entrada `requirementId: "RNF-01"` com critério próprio — não há `CA-XX` vinculado).
- **`components.css`:** `subagent-prompts.md` manda importar o `components.css` do pacote depois de `tokens.css` (nunca `preview.css` nem as classes de andaime de `components.html`) e o gate de design da review confere as classes de componente no CSS **compilado** do build.
- **Testes:** `tests/orchestration-state.test.mjs` (delta de eventos com replay; campos sem crase) e `tests/requirements-coverage.test.mjs`.

### Gaps restantes da auditoria OficinaAI fechados

- **Gate de onda (`run-wave-gate.mjs`) roda o que existe:** `detectWorkspaces()` encontra cada unidade compilável até profundidade 2 (Node com o gerenciador do lockfile e `CI=true`, solução .NET, Go, Rust, Python) e roda `build`/`test` no diretório de cada uma. O gate antigo dava `SKIPPED` ("generic stack") para `backend/` .NET + `frontend/` Next e `PASS` para qualquer `package.json` na raiz **sem executar nada**. `checks.test.untestedWorkspaces` lista workspace sem teste.
- **`checks.format`:** reprova linha acima de 200 caracteres nos arquivos de código alterados (gerado, migrations, URLs, imports e comentários isentos) e roda `dotnet format ... whitespace --verify-no-changes --include` / `prettier --check` só nos arquivos alterados. No código real da run: 188 linhas acima de 200 caracteres em 47 arquivos `.cs`.
- **`checks.coordinationRefs`:** reprova código/config que leia `.pensador/`, `.orchestrator/`, `.orchestration/`, `.testador/` ou `.executor/` (o `gen:api` do front-end da run lia `../.pensador/.../openapi.yaml`). Novo `materialize-api-contract.mjs` copia o contrato do handoff para `contracts/` e normaliza o comando `validate` legado.
- **Novo gate `apiContractValidation` (Fase 8.0):** `validate-api-contract.mjs` roda Schemathesis (`st run <contrato> --url <base>`, ou `uvx schemathesis`, ou `--command`) contra a API em execução e grava `evidence/api-contract-validation.json` amarrado ao sha256 do contrato; o gate só fecha com `PASS` não dry-run do contrato atual. `N/A` só com motivo `NO_HTTP_API`/`NO_MACHINE_READABLE_CONTRACT` (conta como não aplicável, não como verificação pulada) e nunca torna a Fase 8 inteira dispensável.
- **`requirementsCoverage` lê o conteúdo:** fecha `DONE` só com `requirements-evidence.json` cobrindo toda id reivindicada por task e, com o snapshot `plan/requirements-index.json` (`validate-requirements-coverage.mjs --dir`), toda id do índice, todo `CA-XX` ligado a cada `RF` e evidência `kind: "test"` para RNF de segurança/privacidade/isolamento/conformidade (`REQUIREMENTS_EVIDENCE_BLOCKED`). A run fechou esse gate com o arquivo existindo enquanto a review reprovava 7 CAs.
- **Reviews com veredito e atualidade:** `backendReview`/`frontendReview` fecham só com a última decisão `APROVADO`/`APROVADO_COM_RESSALVAS` no relatório (`REVIEW_REPROVED`/`REVIEW_VERDICT_MISSING`) e escrito depois de toda task do escopo concluída (`REVIEW_STALE`); reconferido no fechamento da fase e no audit final. As correções de segurança da run (escalada para SuperAdmin, reuso de refresh token) nunca foram revisadas.
- **Ordem das fases:** Fase ≥5 `RUNNING` e despacho de task exigem Fases 1–4 fechadas (`PHASE_PREREQUISITES_OPEN`, `TASK_DISPATCH_BEFORE_PHASE_4`) quando a run registrou fases além da 1. A run fechou a Fase 4 26 h depois de a delegação começar.
- **Recomendações de retomada:** só a passada atual gera recomendação; task `DONE` com `reconciliation` antiga (de quando estava `STALLED`) não aparece mais.
- **Performance do monitoramento:** tick do `watch` sem evento quando nada mudou (sweep com heartbeat de 5 min), sem replay completo do log e sem projeções de history/telemetry; backoff do intervalo até `--max-interval-seconds` (padrão 120). `--persist-every-tick` para diagnóstico.
- **Materialização do design só com arquivos de produto:** `components.html`, `preview/`, `provenance.json` e os registros de audit/review ficam no pacote do Pensador (`referenceRoot`, usado em `--design-system`); a run tinha preview HTML dentro de `frontend/src/styles`. O ingest confere `design-review.json` (cc-pensador 2.38.0) quando o produtor o declara.
- **Prompts:** contrato lido de `contracts/` no repositório, limite de linha e formatador; review back-end com foco em isolamento entre tenants, escalada de privilégio, tokens, LGPD e fluxos de dinheiro/estoque.
- **Testes:** `tests/audit-gaps-2026-09.test.mjs`, `tests/wave-gate-workspaces.test.mjs` e ajustes de fixture (relatório de review aprovado, gate de contrato N/A com motivo) em `phase-transitions`, `orchestration-state`, `learning-curator`, `orchestrator-bootstrap` e `execution-acceleration-tools`.

- **Causa:** `executor-adapters.mjs::normalizeStatus` deixava a varredura de texto livre
  (`reason`/`error`/`summary`, e o `error` de um envelope stream-json) sobrescrever
  incondicionalmente qualquer status explicito reportado pelo AGY — inclusive `DONE`, `RUNNING`,
  `BLOCKED`, `CANCELLED`, `STALLED` — sempre que o texto mencionasse "quota", "timeout" ou
  "unauthorized"/"agy not found". Um dominio de negocio como o de um SaaS com planos e cobranca
  (a run real que expos isso, OficinaAI) usa exatamente esse vocabulario em texto legitimo; uma
  task `DONE` cujo resumo falasse em "alerta de quota do plano" ou "timeout do upstream de
  cobranca" era reclassificada como falha de infraestrutura, descartando o status real.
- **Correcao:** a varredura de texto so pode desambiguar um status generico/ambiguo do AGY
  (`FAILED`, ou ausente/invalido) — nunca sobrescreve um status explicito ja especifico e nao
  ambiguo. O comportamento de disambiguar `ERROR`/`FAILED` a partir do proprio campo `error`
  (ex.: "resource exhausted" -> `QUOTA_EXAUSTED`) continua identico.
- **Testes:** `tests/executor-adapters.test.mjs` (novo, 10 casos), cobrindo AGY e Codex, incluindo
  o erro real do Codex "Selected model is at capacity" (capacidade transitoria, confirmado que nao
  bate no padrao de cota). Suite completa: 511/511.

## [4.24.1] — 2026-09-19 — Rename atomico resistente a bloqueio transitorio (Windows)

- **Causa do teste instavel `reconciliation never regresses a terminal task`:** nao era a logica de reconciliacao (estado terminal e preservado de forma deterministica) e sim um `EPERM` em `renameSync(tmp -> state.json)` dentro de `writeSnapshotAtomically`. No Windows, renomear sobre um arquivo que outro processo tem aberto por um instante (antivirus, indexador, leitor concorrente) falha de forma transitoria; sem retry, o `commitEvent` de qualquer `resumeRunAtDirectory` podia lancar. Reproduzido sob carga (8 processos paralelos): 1 falha em 40 execucoes, com o mesmo `EPERM` em outro teste do arquivo.
- **Correcao:** novo `lib/fs-retry.mjs::renameWithRetry` (ate 12 tentativas, backoff de 10 a 100 ms, so para `EPERM`/`EBUSY`/`EACCES`; qualquer outro erro propaga na hora). Usado em `orchestration-state`, `executor-control`, `intelligence`, `learning-recipes`, `lifecycle-manager`, `project-config` e `telemetry`, que tinham o mesmo padrao `tmp -> path`.
- **Testes:** `tests/fs-retry.test.mjs` cobre a recuperacao por injecao de falha (deterministico), o limite de tentativas, o nao-retry de erros nao transitorios e o backoff limitado.
- **Prova:** 120 execucoes de `orchestration-state.test.mjs` (15 rodadas x 8 processos paralelos), todas verdes, incluindo o teste alvo em todas.

## [4.24.0] — 2026-09-19 — Papel legado `ui-prototype` bloqueado

- **Ingest:** `inspectVisualHandoff` deixa de ler o papel `ui-prototype` (removido do Pensador na 2.28.0 e do contrato de handoff na 2.32.0). Um handoff que o declare gera o finding critico `LEGACY_UI_PROTOTYPE_ROLE`, pedindo para regerar o handoff no Pensador >= 2.32, em vez de ser aceito em silencio. O campo `prototypes` some de `visualPackage`.
- **Docs/prompts:** referencias a `prototypes/` em `SKILL.md`, `workflow.md`, `subagent-prompts.md` e nos READMEs passam a apontar para o `preview/` gerado do design system.

## [4.23.0] — 2026-09-19 — Gates mecanicos de design (Fase 7 do plano)

O design system deixa de ser conferido por autodeclaracao no Orquestrador.

- **Wave gate real (O1):** `run-wave-gate.mjs` passa a chamar o linter de tokens sobre os arquivos front-end alterados (`--tokens-css`, `--changed-files` ou `git diff`). `lintCssForTokens` agora tambem acusa px de espacamento/raio fora de `var(...)` e `style={{}}` inline com espacamento/raio literal (cada violacao ganha `kind`: `hex` | `px` | `inline-style`), e o gate acusa `var(--x)` sem token definido. `checks.designTokens` deixa de ser `PASS` fixo: e `PASS`/`FAILED`, ou `SKIPPED` explicito (sem `--tokens-css` ou sem como listar os arquivos). Hex literal em componente reprova a onda. O pacote de design nunca e linta.
- **Materializacao confere o pacote (O3):** `inspectVisualHandoff`/`materialize-visual-handoff.mjs` recalculam o `contractSha256` do `design-contract.json` (novo `lib/design-contract-hash.mjs`, mesma serializacao canonica do Pensador) e o comparam com o contrato, o `design-audit.json` e o `contractSha256` do handoff (`CONTRACT_HASH_MISMATCH` critico, `CONTRACT_HASH_MISSING`). O veredito do audit vem do `design-audit.json` em disco (`DESIGN_AUDIT_MISSING`/`DESIGN_AUDIT_INVALID`/`DESIGN_AUDIT_NOT_PASS`); o `validation.status` do handoff nao e mais lido. Os pacotes passam a expor `themes` e `designBriefPath`.
- **Evidencia mecanica (O2):** em `validate-ui-evidence.mjs`, `undefinedTokens`/`hardcodedDesignValues`/`previewDivergence` em `false` so valem com `evidence.designEvidence.tokenLint` (saida `--json` do wave gate) e `previewDiff` (saida do probe/comparacao com `preview/`): `DESIGN_EVIDENCE_MISSING`/`_INVALID`/`_FAILED`. Flag `true` continua bloqueando.
- **Prompts (O4):** `subagent-prompts.md` e `SKILL.md` fixam a ordem normativa `design-contract.json`/`tokens.css` > `components.html` > prosa, apontam para o `preview/` gerado (`index/colors/typography/spacing/components/app.html`, nos dois temas) em vez das paginas do catalogo, pedem o tema conforme `design-brief.json` (`themeDefault`/`themeExposure`) e o `DESIGN_CHANGE_REQUEST` para token novo.
- **Testes:** `tests/wave-gate-design-tokens.test.mjs` (novo), casos de hash/audit em `orchestrator-bootstrap.test.mjs` e de evidencia em `ui-evidence.test.mjs`; o fixture do pacote `resolved` agora traz contrato assinado e audit ligado por hash.
- **Migracao:** handoffs cujo `resolved/` nao tenha `design-audit.json` PASS e `design-contract.json` com `sha256` (Pensador < 2.31) passam a ficar `BLOCKED`; gere o pacote de novo no Pensador.

## [4.22.0] — 2026-09-19 — Contrato de handoff do design system (Fase 6 do plano)

Sync com `cc-pensador` 2.32.0 (Fase 6 do plano de design system): `handoff-contract.md` reescrito (secao 6) e byte-identico nos 4 plugins.

- **Contrato:** `design-system-files` aponta para `design-systems/<id>/resolved/` (unico pacote normativo); `source/` guarda so a proveniencia do engine; nao existe mais `original/` nem verbatim de catalogo. Front matter do `DESIGN.md` e normativo, a prosa nao. `materializeInto` = `<uiPackageDir>/design-systems/<id>/`.
- **Novos campos da entrada:** `contractSha256` (sha256 hex ou `null`), `themes` (inclui `light` e `dark`), `designBriefPath` (relativo ao `artifactRoot`), alem de `variant`, `authoritative`, `sourcePath`, `assetsManifest` e `validation.{status,audit}` no schema.
- **Politica de token:** token novo so por nova versao do Pensador; a correcao que o exigir registra `DESIGN_CHANGE_REQUEST`.
- **Validador:** `validateHandoff()` rejeita `contractSha256` malformado (`INVALID_CONTRACT_SHA256`), `themes` sem `light`/`dark` (`INVALID_DESIGN_THEMES`) e `designBriefPath` vazio (`INVALID_DESIGN_BRIEF_PATH`) em entradas `resolved`; fixture e casos de teste em cada um dos 4 plugins.

## [4.21.0] - 2026-09-19 - Guard do estado da run, handoff validado no DONE e sync com cc-pensador 2.28/2.29

Endurece o plugin contra as falhas observadas numa run real do Pensador (OficinaAI, sessao
`oficinaai-dd`, 2026-09-18): etapas delegadas a um fork em segundo plano (74 min sem progresso),
checkpoint movido a mao de `INIT` para `DONE` pulando seis estagios, e um `handoff.json` escrito a
mao que reprovava em `validate-handoff.mjs` apresentado como "PRD completo". O estado deste plugin
ja e event-sourced e gated; o que faltava era impedir o contorno manual e validar o handoff no fechamento.

- **Novo hook `PreToolUse`** (`hooks/hooks.json` → `scripts/guard-state.mjs`, decisao em
  `lib/state-guard.mjs`): bloqueia `Edit`/`Write`/`MultiEdit` e escritas via Bash/PowerShell em
  `state.json`, `events.jsonl` e `.state.lock` dentro de `.orchestration/` e `.orchestrator/`. Leituras e o proprio `orchestration-state.mjs`
  passam; falha aberta. O `verify`/replay do CLI continua sendo a rede de seguranca.
- **`auditRunCompletion()` valida o handoff**: `report/handoff.json` que reprova em `validateHandoff()` (ou nao
  e JSON) entra em `invalidHandoff` e impede `complete`/`DONE` (`RUN_COMPLETION_GATES_FAILED`); a run fecha
  PARTIAL. O fixture de teste que usava `{}` como handoff — exatamente o defeito — passa a usar um handoff valido.
- **SKILL**: nova secao "Execucao no fio principal e estado so via CLI" — proibe delegar a conducao a
  fork/segundo plano/`ScheduleWakeup`/`/loop`, proibe editar o estado a mao, exige validar o handoff e
  obriga o recap final a declarar o que foi pulado, dispensado ou degradado (nunca "concluido" com lacunas).
- Sync com o contrato do `cc-pensador` 2.28: role `ui-prototype` removido de `HANDOFF_ROLES_BY_STAGE.pensador`
  e do `handoff-contract.md` (byte-identico nos 4 plugins).
- `pensador-ingest`: o teste de coleta visual deixa de exigir `ui-prototype` (o Pensador 2.28+ nao gera mais prototipos); `workflow.md` ajustado.
- Versao 4.21.0 (a 4.20.0 esta reservada pela PR #7, fallback de cota); a base desta branch inclui a PR #7.
- Testes: `tests/state-guard.test.mjs` e o caso "run cannot be DONE with a hand-written handoff.json" em `tests/orchestration-state.test.mjs`.

## [4.20.0] — 2026-09-17 — Fallback de cota opt-in (claude-code -> codex -> agy) e worktree sem Git instalado

Dois pedidos independentes do usuario sobre o mesmo plugin: (1) hoje `QUOTA_EXHAUSTED`/`QUOTA_EXAUSTED`
num Executor de implementacao vira bloqueio ou pede decisao do usuario, e Claude nunca e usado como
fallback ("preservar a cota da sessao principal"); alguns usuarios querem suspender essa regra de
forma explicita e opt-in. (2) quando o diretorio do projeto nao tem Git instalado ou nao e um
repositorio Git, `planTaskWorktrees` calculava overlap de escopo sobre um `inspectGit` que ja
reportava `available: false`, deixando o comportamento efetivo dependente de como o consumidor lia
esse plano em vez de ser explicito e testado.

- **5a pergunta da Project_Config: `quotaFallbackChain` (`disabled`/`enabled`, default `disabled`).**
  Novo campo opt-in, documentado em `references/project-config.md` ao lado das quatro perguntas de
  papel — mas fora de `ROLES`: nao decide um Executor, e um toggle. Retrocompativel por design: um
  `.orchestrator/project-config.md` gravado antes desta versao nao tem a linha e o parser resolve
  `disabled` sem lancar `PROJECT_CONFIG_FIELD_MISSING` (`scripts/lib/project-config.mjs`). Congelado
  no snapshot `state.json.projectConfig` junto dos quatro papeis e coberto pelo mesmo fluxo de
  `projectConfigDrift`/adocao de escopo `pending` (`orchestration-state.mjs`, novo
  `diffQuotaFallbackChain`).
- **`scripts/lib/quota-fallback.mjs` (novo) e `state.json.quotaHandoffs[]` (contrato de repasse).**
  `resolveFallbackChain(originalExecutor, { exhausted })` calcula, de forma pura, os elos ainda
  tentaveis da cadeia fixa `claude-code, codex, agy` excluindo o Executor original e qualquer elo ja
  esgotado nesta Run. `recordQuotaHandoff`/`listQuotaHandoffs`/`markQuotaRecoveryChecked` gravam e
  consultam uma nova transicao de estado (`appendQuotaHandoff`/`markQuotaHandoffRecoveryChecked` em
  `orchestration-state.mjs`, no mesmo padrao de `updateTaskWorkspace`): cada troca de Executor por
  cota vira uma entrada `{ taskId, wave, fromExecutor, toExecutor, reasonCode, chainPosition,
  timestamp, quotaRecoveryCheck }`. Nova CLI fina `scripts/quota-fallback.mjs` (`resolve`, `record`,
  `list`, `mark-recovery-checked`) para o workflow chamar durante a Fase de dispatch e o ciclo de
  heartbeat/sweep. **Kiro fica de fora desta rodada** (nao ha hoje integracao de Kiro como Executor no
  Orquestrador; adiciona-la e trabalho novo, nao uma extensao desta cadeia).
- **`SKILL.md` (Politica de quota) e `references/agent-stack.md` atualizados com a condicao de
  ativacao do fallback**, preservando linha a linha o comportamento atual quando `quotaFallbackChain`
  esta `disabled` (ou ausente/legado). Fallback para `claude-code` segue a "Regra central do Executor
  `claude-code`" ja existente (implementacao via `Agent`, review read-only); fallback para
  `codex`/`agy` segue o caminho de troca de Executor ja documentado. Ciclo de heartbeat/sweep sonda
  `quotaHandoffs` com `quotaRecoveryCheck: "PENDING"` (reaproveitando `adaptExecutorProbe`) e
  atualiza para `RESTORED` — puramente informativo, nunca reabre ou reexecuta uma task ja `DONE`.
- **Telemetria: novo tipo de evento `quota_handoff`.** `TELEMETRY_EVENT_TYPES`,
  `ALLOWED_FIELDS`/`ALLOWED_METADATA_FIELDS` de `scripts/lib/telemetry.mjs` ganham `fromExecutor`,
  `toExecutor`, `chainPosition` e `quotaRecoveryCheck`, respeitando o contrato de privacidade
  existente (metadata-only, `FORBIDDEN_FIELD_PATTERN` continua banindo prompt/conteudo/credencial).
- **Worktree sem Git instalado degrada silenciosamente para execucao serializada.**
  `scripts/preflight.mjs` ganha `checks.runtime.git` (via o `checkCli()` generico ja existente) —
  nunca obrigatorio, sempre um aviso (`NOT_INSTALLED`) quando reprova, no mesmo padrao do loop de
  avisos de MCP. `worktree-manager.mjs::planTaskWorktrees` agora checa `inspectGit(root)` uma unica
  vez no inicio: quando indisponivel, marca toda task da wave `eligible: false, reason:
  "GIT_UNAVAILABLE"` sem calcular overlap de escopo, sem lancar erro e sem perguntar nada ao usuario.
  Com Git disponivel o comportamento nao muda (elegibilidade deterministica por escopo de arquivos) —
  agora documentado explicitamente em `SKILL.md` e `references/worktrees-routing.md` para nao
  regredir.

11 testes novos/atualizados (`quota-fallback.test.mjs`, `routing-gates.test.mjs`,
`worktree-manager.test.mjs`, `run-config.property.test.mjs`, `project-config-cli.test.mjs`,
`tests/helpers/project-config-arbitraries.mjs`); suite completa: 460 passed, 1 pre-existente (fora
do escopo desta mudanca — sincronizacao de `handoff-contract.md`/`ui-prototype` pendente de uma
mudanca irmA no cc-pensador).

## [4.19.0] — 2026-09-17 — Gate de cobertura de contrato (ui-data-map), prova de persistencia na E2E, imagery por superficie

Segunda rodada de correcao sobre a mesma run real (OficinaAI, 2026-09-16, apos a 4.18.0 ja em
producao): 3 rodadas de review "APROVADO" com `gates.productionMockFallback: false` preenchido pelo
proprio orquestrador, enquanto o painel interno inteiro lia/gravava em `localStorage` — porque so 4
de dezenas de telas foram auditadas, nenhuma delas uma lista, e o contrato (`openapi.yaml`) tinha 21
operacoes para 41 RFs sem que nada cruzasse tela x operacao antes do dispatch. Ver tambem
cc-pensador 2.27.0 (metade Pensador destas mesmas correcoes).

- **Novo gate `contractCoverage` (Fase 4), `scripts/validate-contract-coverage.mjs`.** Porta de
  `scripts/lib/contract-coverage.mjs` (mesmo parser OpenAPI proprio, sem dependencia de YAML, do
  cc-pensador — mantido em paralelo por nao haver pacote compartilhado entre os repos). Cruza cada
  operacao de leitura/escrita do `ui-data-map.json` (role novo do Pensador, ingerido por
  `inspectDataContractArtifacts()` em `pensador-ingest.mjs`) contra o contrato real; um gap vira task
  de back-end **antes** de qualquer dispatch front-end, nunca contornado com dado local. Formatos
  fora de REST/OpenAPI degradam para `applicable: false` com motivo — nunca um passe silencioso.
  Mesmo padrao de integracao (script standalone, gate por exit-code em prosa do workflow) de
  `validate-requirements-coverage.mjs` — nao acopla ao framework de completion gates de
  `orchestration-state.mjs`.
- **Prompts front-end: contrato e a unica fonte de dados, nunca client-side storage.** Novo campo de
  contexto (`ui-data-map.json`), secao "Fonte de dados" explicando a regra em termos absolutos, novo
  `Status: CONTRACT_GAP` (tratado como `NEEDS_SYNC` — cria a task de back-end faltante antes de
  redespachar) e novo campo obrigatorio de retorno "Fonte de dados por tela" (uma linha por tela,
  `id` -> operacao real consumida). Um retorno sem essa secao, ou com uma tela cuja fonte declarada
  nao seja uma operacao do contrato, e reprovado na Fase 7.
- **Fase 9.5 (E2E) ganha prova de persistencia mecanica, nao mais so um booleano de auto-atestado.**
  `validate-ui-evidence.mjs` aceita `--ui-data-map` opcional: toda tela que o `ui-data-map` declara
  precisa aparecer em `evidence.routes[]` (`SCREEN_COVERAGE_INCOMPLETE` senao — fecha a lacuna real
  de so 4 telas terem sido auditadas), e toda tela de leitura `scope: "list"` precisa de
  `route.persistenceProof` (criar via UI, verificar em um contexto de navegador limpo —
  `PERSISTENCE_PROOF_MISSING` senao) — a unica checagem que distingue mecanicamente uma lista real
  da API de um array de seed no cliente. Novo `route.storageAudit.domainEntitiesInClientStorage`:
  uma entidade de dominio encontrada em `localStorage`/`sessionStorage`/IndexedDB e bloqueante
  (`DOMAIN_ENTITY_IN_CLIENT_STORAGE`) mesmo com `gates.productionMockFallback: false`.
- **`inferVisualImageryPlan`/`classifyVisualImageryTask` corrigidos: politica vem da superficie, nao
  de palavras soltas.** `scripts/visual-imagery-plan.mjs` (fallback do modo independente) tinha o
  mesmo bug do lado Pensador — "banner"/"hero"/"mockup" forcavam `required` mesmo sem nenhum outro
  sinal, e uma descricao de task em ingles nunca casava (so palavras-chave pt-BR). Reescrito para
  reconhecer superficie `conversion`/`catalog` (o sinal estrutural real) e um mandato explicito por
  item, removendo o nivel `recommended` (agora binario: `required`/`not-applicable`, espelhando o
  lado Pensador). `pensador-ingest.mjs` tinha o mesmo bug de contagem de `handoff-validator.mjs` do
  lado Pensador (contava so assets `seed-demo` contra um minimo que agora e sobre imagem de
  CONTEUDO) — corrigido para contar qualquer asset vinculado.
- `handoff-contract.md` (secao 5, Pensador) e `handoff-validator.mjs` (`HANDOFF_ROLES_BY_STAGE`)
  sincronizados com os tres roles novos do cc-pensador 2.27.0 (`ui-data-map`, `seed-plan`,
  `surface-benchmark`), byte-identicos aos quatro plugins do workflow.

24 testes novos/atualizados (contract-coverage, ui-evidence, pensador-ingest, visual-imagery-plan);
suite completa: 443 passed.

## [4.18.0] — 2026-09-15 — Gates de contrato/infra na Fase 4, IDs de requisito por dominio, mutacao obrigatoria na E2E

Levantamento de gaps sobre uma run real do Pensador -> Orquestrador (OficinaAI, apos a 4.17.0 ja
em producao): scripts deterministicos bem desenhados que existiam mas nunca eram executados (o
mesmo padrao de bug ja corrigido na 4.17.0 para `updatePhase`), um regex de routing fragil e uma
decisao de design ambigua sobre imagens de seed. Ver tambem cc-pensador 2.26.0 (metade Pensador
das mesmas correcoes).

- **`inspect-contract.mjs`/`smoke-test-infra.mjs` existiam, eram instruidos, nunca rodavam.**
  Nenhuma das 3 invocacoes reais apareceu no transcript da run analisada; os 3 contratos que a
  review de back-end reprovou por falta de autorizacao nao tinham nenhuma das 11 secoes que
  `inspect-contract.mjs` exige (`Permissoes` inclusive). A secao "Early Stack Boot" do
  `workflow.md` tambem estava fisicamente posicionada depois do ponto em que precisava ser lida
  (sob `## Fase 7`, que so e alcancada depois de todas as waves rodarem) — movida para `### 4.3`,
  antes de `## Fase 5`.
  - Dois completion gates novos na Fase 4 (`contractsInspected`, `infraSmokeTest`), reaproveitando
    o `PHASE_GATE_NOT_DONE` da 4.17.0 sem codigo novo de bloqueio. Evidencia de `contractsInspected`
    e vinculada ao SHA-256 do conteudo atual do contrato — editar um contrato depois de
    inspecionado invalida a evidencia, revalidado em `updatePhase`, `updateCompletionGate` e no
    audit final.
  - `smoke-test-infra.mjs` reescrito: faz polling real de `docker compose ps --all --format json`
    ate todo servico ficar `running`+`healthy` (timeout, falha terminal em
    `exited`/`dead`/`unhealthy`), sonda `--health-url` opcional com retry, e persiste o resultado
    tipado (`kind: "infra-smoke-test"`, `schemaVersion: 1`) atomicamente em `evidence/`.
- **`requirements-coverage.mjs`:** `RF_ID_RE` so casava `RF-\d+`; o `requirements.json` real usa
  `RF-<DOMINIO>-NN` (inclusive sufixo alfabetico, `RF-OS-02a`) — reportava falso-negativo "58 de
  58 sem cobertura", ja documentado e contornado manualmente numa run real
  (`SendFeedback` rascunhado, nunca enviado). Regex ampliado, comparacao case-insensitive.
- **`validate-routing.mjs`:** `extractBlocks()` tratava qualquer linha contendo a palavra "ID" em
  qualquer posicao como abertura de bloco novo — uma frase de prosa como "O usuario informa o ID
  do veiculo (FE-04 depende disso)" reabria um bloco no meio da descricao de outra task,
  corrompendo o parsing de `tasks-classification.md`/`waves.md` silenciosamente. Restrito a rotulo
  de campo real (`ID:`/`**ID:**` no inicio da linha).
- **Fase 9.5 (E2E):** passa a exigir pelo menos um fluxo de mutacao completo do dominio central
  (criar -> decidir/aprovar -> efeito colateral observavel) — uma review real encontrou IDOR que
  so apareceria exercitando esse fluxo de verdade, nao so lendo o controller. Tambem passa a
  verificar mecanicamente `<img src>` nao vazio em toda rota que o PRD/CA descreve como tendo
  imagem (tokens computados e placeholders CSS nao contam).
- **Imagens de seed/demo:** `pensador-ingest.mjs` distingue asset `purpose: "seed-demo"` (exige
  `seedBindings` nao vazio) de asset estatico de conteudo (`seedBindings: []` legitimo) — mesma
  distincao aplicada em paralelo no `design-package.mjs` do cc-pensador. A materializacao
  (`materialize-visual-handoff.mjs`) propaga cada `seedBinding` no relatorio de operacoes para a
  task de seed correspondente aplicar e confirmar no browser.

## [4.17.0] — 2026-09-13 — `updatePhase` nao pisa mais em gate proprio aberto

O usuario ja tinha rascunhado esse bug report na propria run analisada: "`orchestration-state.mjs
phase --status DONE` silently flips unrelated open gates to DONE". Reproduzido e corrigido.

- **Causa raiz:** `updatePhase(..., "DONE")` so verificava que fases PREDECESSORAS estavam
  fechadas (`assertPhaseTransition`); nunca verificava os gates da PROPRIA fase antes de fechar, e
  o loop de sincronizacao no final de `updatePhase` sobrescrevia incondicionalmente todo gate
  mapeado aquela fase para o novo status — inclusive um gate que ja estava `BLOCKED` por um motivo
  legitimo, sem passar por nenhuma das validacoes de `updateCompletionGate` (evidencia, achados de
  UI, relatorio de materializacao, exigencia de sweep). Reproduzido: `visualAudit` `BLOCKED` por
  `VIEWPORT_MISSING`, fase 9 fechada `DONE` sem erro, `visualAudit` virou `DONE` silenciosamente.
- **`assertPhaseTransition`:** nova checagem `PHASE_GATE_NOT_DONE`, espelhando a checagem de
  predecessores — uma fase so pode fechar `DONE` quando os gates que lhe pertencem (via
  `completionGateForPhase`) e sao `required` ja estao `DONE`/`N/A`.
- **Loop de sincronizacao de `updatePhase`:** para de sobrescrever um gate cujo status atual ja e
  `DONE`, `BLOCKED`, `FAILED` ou `N/A` — so avanca gates ainda intocados (`PENDING`/`RUNNING`).
  Defesa em profundidade para as transicoes de fase que a checagem acima nao cobre
  (`RUNNING`/`FAILED`/`BLOCKED`/`CANCELLED`).
- 6 testes novos em `tests/phase-transitions.test.mjs` (reproducao exata da regressao + o caminho
  de sucesso legitimo + garantia de que um gate DONE nao regride quando a fase vai BLOCKED por
  outro motivo). 14 testes existentes em `phase-transitions.test.mjs`, `orchestration-state.test.mjs`
  e `learning-curator.test.mjs` dependiam do comportamento antigo (fechavam fases em loop sem
  jamais chamar `updateCompletionGate`) e foram corrigidos para fechar cada gate legitimamente
  antes de fechar a fase — o mesmo padrao que a run real deveria ter seguido.

## [4.16.0] — 2026-09-13

- **`pensador-ingest.mjs` (`inspectVisualHandoff`):** `LEGACY_VERBATIM_DESIGN` escala de `warning`
  para `high` (bloqueante) quando o handoff upstream do Pensador tem `status: "DONE"` — defesa em
  profundidade complementar ao novo gate `validateVisualCompleteness()` do cc-pensador
  (>= 2.25.0): um handoff `DONE` com pacote de design `legacy-verbatim` so pode chegar aqui vindo
  de um producer desatualizado. `status: "PARTIAL"/"BLOCKED"` continua `warning` (o gap ja vem
  disclosed via `summary`). Isso fecha a lacuna real observada numa run (OficinaAI, 2026-09-12):
  `materialize-visual-handoff.mjs --apply` copiava um pacote de design nao auditado em vez de
  fechar o gate `visualMaterialization` como `BLOCKED`, exatamente o comportamento que
  `references/workflow.md` Secao 4.0 ja documentava ("corrija na origem antes de prosseguir; nao
  contorne despachando mesmo assim") mas que a severidade `warning` nunca acionava.

## [4.15.0] — 2026-09-13

Motivação: numa run real (OficinaAI, 12/09), o bridge cc-antigravity-plugin 4.2.x descartava os
~40 arquivos do pacote de design (`max-files-exceeded`/`prompt-overflow-windows`) e o AGY passou a
ler `tokens.css`/`components.html`/`DESIGN.md` por conta própria, de forma irregular por task.
`.claude-plugin/marketplace.json` também estava com drift de versão (4.12.0) contra
`package.json`/`plugin.json` (4.14.0) — o mesmo padrão que fez a correção 4.3.0 do
cc-antigravity-plugin nunca ser instalada.

- **`--design-system <dir>`** (bridge cc-antigravity-plugin >= 4.4.0) substitui `--priority-files`
  como forma de entregar o pacote de design ao AGY nas Fases 4.0/5/9:
  `subagent-prompts.md` Seções 2/2a/5, `SKILL.md` item 13 e checklist, `workflow.md`.
- **Orçamento de prompt AGY/Codex passa a ser sempre indicativo** (`check-prompt-budget.mjs`,
  `advisory: true` para os dois agentes): o bridge 4.4.0 faz stream do prompt final via stdin
  sempre que excede o argv seguro da plataforma, eliminando o descarte de contexto por tamanho no
  caminho headless. O threshold de 24.000 chars continua como sinal de qualidade (escopo mal
  recortado), não como bloqueio.
- `.claude-plugin/marketplace.json` realinhado com `package.json`/`plugin.json` (drift 4.12.0 →
  4.15.0 corrigido).
- `README.md`/`README.pt-BR.md`: seção "AGY Prompt Limit" reescrita para refletir o comportamento
  indicativo e o transporte via stdin.

## [4.14.0] — 2026-09-12

- Diretrizes avançadas de Context7 MCP (Upstash Context7):
  - `skills/orchestrator-multi-agent-development/references/mcp-context.md`: incorporação da regra de **Single-Concept Scoping** (evitando diluição de ranking semântico em buscas de documentação), formato canônico versionado `/org/project/version` a partir de `Versions`, pontuação oficial no nome da biblioteca (`Next.js`, `ASP.NET Core`), orçamento de até 3 consultas por tarefa e filtros de escopo negativos explícitos.
  - `skills/orchestrator-multi-agent-development/references/subagent-prompts.md`: templates de prompt de subagentes back-end (Codex) e front-end (AGY) atualizados com as regras atômicas de consulta de documentação sob os placeholders `Context7 MCP:`.
  - Checklist da referência de MCPs atualizado com os novos critérios.

## [4.13.0] — 2026-09-12

- Novas ferramentas determinísticas de aceleração de execução:
  - `generate-contract-types.mjs`: geração fortemente tipada de DTOs e interfaces a partir de OpenAPI/YAML/JSON na Fase 4, prevenindo alucinações de payload e divergências de casing.
  - `smoke-test-infra.mjs`: early stack boot de Docker Compose na Wave 1 (Fase 7), validando portas, volumes e dependências em 2 minutos para falhar rápido.
  - `run-wave-gate.mjs`: gate de qualidade incremental por onda (0 tokens LLM) verificando build, typecheck, linting de tokens e integridade de escopo antes de autorizar a próxima onda.
  - `build-traceability-matrix.mjs`: geração automática e determinística da matriz de rastreabilidade (RF/CA para tasks e commits) para a Seção 13 do relatório de implementação.
- Roteamento e política de cota:
  - Fallback de implementação back-end em caso de `QUOTA_EXHAUSTED` no Codex passa a delegar exclusivamente para o AGY (`cc-antigravity-plugin:antigravity-coder`) com modelos Gemini (`gemini-3.8-flash-medium` para tarefas pontuais/CRUDs e `gemini-3.8-flash-high` para arquitetura/segurança).
  - Proibição estrita de delegar fallback de implementação para modelos Claude ou subagentes `claude-code`, preservando a cota da sessão principal.
  - Calibração de esforço formalizada: `--effort high` restrito a arquitetura central e reviews; `--effort medium`/`low` para tarefas isoladas e CRUDs.
- Prompts normativos:
  - Auto-verificação local obrigatória antes de reportar `DONE` (<BUILD_CMD> e <TEST_CMD> com exit code 0) adicionada aos templates de prompt do Codex e do AGY.
  - Reforço do consumo de contratos tipados e shift-left do design system (`components.html` / `tokens.css`).
- Suíte de testes: adicionados 8 testes automatizados em `tests/execution-acceleration-tools.test.mjs` (total de 394 testes verdes).

## [4.12.0] — 2026-09-12

- Ingestão visual e inspeção de handoff (`inspectVisualHandoff`): estendido para coletar e validar formalmente os artefatos visuais emitidos pelo Pensador: `ui-prototype` (`prototypes/` com protótipos HTML estáticos/interativos de discovery) e `brand-assets` (`assets/` com `assets/manifest.json` contendo ativos reais de mídia, logos e banners).
- Prompts de implementação front-end (AGY / `antigravity-coder`): inclusão dos protótipos de discovery no bloco de Contexto e instrução mandatória para uso como SPEC VISUAL dos fluxos, replicando layout, hierarquia, comportamento e textos aprovados sem inferir telas do zero.
- Review front-end (AGY / `antigravity-agent`): inclusão dos protótipos no bloco de leitura e checklist obrigatório de fidelidade visual contra os protótipos de referência de `prototypes/` para garantir fidelidade às telas aprovadas no discovery.
- Testes unitários e de integração adicionados em `tests/pensador-ingest.test.mjs`, assegurando 100% de conformidade da ingestão com a suíte de testes (386 testes verdes).

## [4.11.0] — 2026-09-11

- Bootstrap deterministico centraliza preflight, Project Config e ingestao automatica de `handoff.json`, sem auto-invocacao da skill interna.
- Pacotes visuais `resolved/` autoritativos e assets declarados passam por inspecao e materializacao programatica.
- Novo gate deterministico `visualMaterialization` (Fase 4): fechar a Fase 5 (dispatch de tasks front-end) sem `design-materialization.json` com `status: "PASS"` e agora impossivel. Antes, a materializacao do pacote de design so era exigida em prosa — pular a etapa so aparecia depois, de forma indireta e dificil de diagnosticar, como imagens quebradas no gate `visualAudit` da Fase 9.
- Gates de UI/UX e E2E exigem screenshots desktop/mobile, assercoes semanticas, rastreabilidade de requisito e evidencia de API real.
- Telemetria por tentativa separa execucao, fila e espera do usuario, registra cache tokens e fecha tentativas antigas antes de retry.
- `DONE` bloqueia findings visuais altos/criticos, tentativas filhas ativas e integracao/cleanup pendentes.

## [4.10.1] — 2026-09-09

- Corrigido o caminho de `review/requirements-evidence.json` no layout v2 e o gate agora valida a cobertura de todos os `requirementIds`, critérios com evidência estruturada e findings resolvidos.
- `PARTIAL` passou a ser terminal de forma consistente no state engine, lifecycle watcher, schema público, CLI e documentação.
- Parser de tasks volta a exigir IDs canônicos e preserva todos os `requirementIds` declarados em listas multilinha.

## [4.10.0] — 2026-09-09

- Parser de tasks agora aceita apenas registros estruturais (heading, campo `Task`/`ID` ou primeira célula de tabela); referências `US-*`, `RF-*` e `CT-*` em prosa não criam tasks fantasmas.
- Metadados de task são lidos apenas do valor do campo e `contractIds` aceita somente IDs `CT-*` válidos.
- Adicionado gate de evidência semântica para planos que declaram `requirementIds`, com `requirements-evidence.json` e recomendação explícita `PARTIAL` no audit quando a execução não é comprovável.
- Telemetria projeta somente outcomes terminais e usa IDs estáveis, eliminando duplicação causada por reconciliações que alteram `updatedAt`.
- Reconciliação sem adapter preserva `RUNNING` como estado não verificado; o sweeper continua responsável por transicionar tarefas realmente inativas para `STALLED`.
- Estado público de run passa a aceitar `PARTIAL` como resultado terminal auditável.

## [4.9.2] — 2026-09-07

### Relay automático para falha TLS no restore do Codex

- `SKILL.md`, `references/workflow.md`, `references/agent-stack.md` e
  `references/subagent-prompts.md`: quando o registry NuGet já esteve acessível e o
  `dotnet restore` do Codex falha por TLS/SSL/autenticação do pacote de segurança, o
  Orquestrador faz uma única tentativa do mesmo restore no workspace da task e devolve
  um handoff auditável ao Codex. O relay não altera certificados, proxy, VPN,
  credenciais ou `NuGet.Config`, não adiciona pacotes e mantém `BLOCKED` se o restore
  do host também falhar.
- `README.md`, `README.pt-BR.md`: documentada a exceção limitada à política de sandbox.
- `npm test`: 369 passed, 0 failed.

## [4.9.1] — 2026-09-07

### Watch obrigatorio apos dispatch; `.orchestration`/`.orchestrator` gitignorados por padrao

Segue-se a `analise-run-oficina-saas-20260906.md`: uma run real despachou 3 tasks do Codex em
paralelo, todas terminaram em ~5 minutos, e o orquestrador nunca soube — a sessao ficou ociosa
apos o dispatch e so retomou um dia depois. Separadamente, apagar `.orchestration`/`.orchestrator`
do disco nao "pegava": como esses caminhos eram versionados por padrao no projeto alvo, o
primeiro commit seguinte do proprio orquestrador sobre `state.json`/`events.jsonl` ressuscitava o
conteudo antigo via git normal.

- `skills/orchestrator-multi-agent-development/scripts/lib/lifecycle-manager.mjs` (alterado):
  `watchLifecycle` ganha `options.onTick` (registro compacto por tick) e parada antecipada
  (`stoppedReason: "NO_ACTIVE_TASKS"` quando nao sobra task `RUNNING`/`STALLED`/`UNKNOWN`,
  `"RUN_TERMINAL"` quando a run chega a `DONE`/`CANCELLED`; `--auto-stop=false` desliga).
- `skills/orchestrator-multi-agent-development/scripts/orchestration-lifecycle.mjs` (alterado):
  `watch` agora imprime uma linha NDJSON `{"type":"tick",...}` por tick no stdout, em vez de um
  unico JSON so ao final — inspecionavel com o processo ja rodando em segundo plano.
- `skills/orchestrator-multi-agent-development/scripts/lib/orchestration-state.mjs` (alterado):
  `updateCompletionGate` recusa fechar o gate `monitoring` como `DONE`
  (`GATE_MONITORING_REQUIRES_SWEEP`) enquanto `lifecycle.lastSweepAt` estiver vazio — prova de que
  `tick`/`watch`/`sweep` rodou ao menos uma vez durante a Fase 6, nao so que alguma evidencia foi
  escrita antes de fecha-la.
- `references/workflow.md`, `SKILL.md`, `commands/orchestrator.md` (alterados): iniciar
  `orchestration-lifecycle.mjs watch` em segundo plano passa a ser obrigatorio assim que a ultima
  task de uma wave e despachada — mesmo sem `--adapter-config` (sem adapter, `tick` ja rebaixa
  `RUNNING` nao confirmado para `UNKNOWN` a partir do primeiro tick, e `sweepStalledTasks` marca
  `STALLED` por inatividade; o adapter so melhora o sinal). Os mesmos tres arquivos tinham 21+11+15
  ocorrencias de `--dir ".orchestration/<slug>"` como alvo de escrita, nunca atualizadas apos a
  migracao para `.orchestrator/runs/<slug>/` — corrigidas para o caminho atual; a prosa que
  descreve o fallback de leitura da raiz legada foi preservada e clarificada.
- `references/persistent-state.md`, `README.md`, `README.pt-BR.md` (alterados): "O que
  versionar"/"What to Commit" inverte o padrao — `.orchestration/` e `.orchestrator/` ficam
  gitignorados por padrao (mesma convencao que `cc-pensador` ja usa para `.pensador/`); o bloco
  estreito antigo vira opt-in explicito documentado, com o risco que reintroduz. Documentada a
  limitacao residual: a inversao nao desfaz historico ja commitado (precisa de
  `git rm --cached -r` manual).
- `tests/lifecycle-telemetry-router.test.mjs`, `tests/orchestration-state.test.mjs`,
  `tests/phase-transitions.test.mjs` (alterados): cobertura nova para `watchLifecycle`
  (`maxTicks`, `onTick`, `stoppedReason`) e para `GATE_MONITORING_REQUIRES_SWEEP`; os dois helpers
  de teste que fechavam o gate `monitoring` sem nunca chamar `sweepStalledTasks` foram corrigidos.
  `npm test`: 369 passed, 0 failed.
- Nenhuma mudanca em `artifact-layout.mjs` nem em `handoff-contract.md`: nenhum dos dois toca git,
  e as menções a `.orchestration/` no contrato sao prosa de fallback de leitura, nao de
  versionamento — os 4 plugins seguem byte-identicos.

## [4.8.1] — 2026-09-03

### `nextStage` roteia para o Testador por padrao; suite do handoff-validator alinhada

Uma sincronizacao anterior trouxe `testador` para `HANDOFF_STAGES`/`HANDOFF_ROLES_BY_STAGE`
(dados), mas `references/workflow.md` continuava com `nextStage.consumer` fixo em
`cc-executor-subagents` — a instrucao executiva ignorava o novo estagio que o proprio contrato
(`handoff-contract.md` secao 1) descreve entre Orquestrador e Executor. `test/handoff-validator.test.mjs`
tinha a mesma lacuna de cobertura do `cc-pensador` (ver changelog dele na mesma data).

- `skills/orchestrator-multi-agent-development/references/workflow.md` (alterado): Fases 10-12,
  ao gravar `report/handoff.json`, `nextStage` agora aponta `consumer: "cc-testador-subagents"`,
  `entrypoint: "/testador"` por padrao; degrada para `cc-executor-subagents`/`/executor` (e
  registra a degradacao) apenas quando o plugin Testador nao esta instalado no workspace.
- `tests/handoff-validator.test.mjs` (alterado): mesma correcao de `cc-pensador` — fixture
  `validTestadorHandoff()`, ternario de 4 ramos, regex `[a-z0-9-]+`, teste de alinhamento com a
  tabela do contrato para `testador`. `npm test`: 258 passed, 0 failed.
- `skills/orchestrator-multi-agent-development/references/handoff-contract.md` (alterado,
  replicado nos quatro plugins): secao 9 corrigida — nao afirma mais byte-identidade de
  schema/validador entre plugins (ver changelog de `cc-pensador`).

## [4.8.0] — 2026-08-27

### Reconciliacao da superficie unificada com o contrato Antigravity 4 e cobertura RF/CA

Esta versao integra a linha remota 4.6.0 de comandos com as entregas locais 4.6.0–4.7.0,
eliminando a colisao de versoes e preservando ambos os conjuntos de mudancas:

- Alias em portugues corrigido de `/orchestrador` para `/orquestrador`.
- Novos subcomandos `help` e `status [runId]`; `config` tambem funciona como alias de
  `project-config`.
- Flags publicas unificadas em `--model`, `--parallel`, `--subagent-model`, `--effort` e
  `--timeout`, mantendo os nomes `--agy-*` como aliases legados.
- Mantidos o contrato Antigravity 4, o validador de `handoff.json` e o gate deterministico de
  cobertura RF/CA da linha local.

## [4.7.0] — 2026-08-24

### Gate deterministico de cobertura RF/CA (`validate-requirements-coverage.mjs`)

Achado de auditoria: a premissa central deste estagio — "o Orquestrador e obrigado a atender todos
os criterios de aceite da spec/PRD vigente" — nao tinha nenhum respaldo deterministico.
`completionAudit()` verifica tasks, gates, evidencia e artefatos, mas nenhum campo liga uma task ao
`RF`/`CA` que ela implementa. A matriz de rastreabilidade da secao 13 do `implementation-report.md`
e prosa, montada pelo mesmo agente que escreveu o codigo (Fase 7) — se a Fase 1.2 perder um `RF` ao
extrair tasks, toda a pilha deterministica ainda devolve `complete: true` e o handoff fecha `DONE`.

- `skills/orchestrator-multi-agent-development/scripts/lib/requirements-coverage.mjs` (novo):
  `computeRequirementsCoverage(requirementsIndex, tasksClassificationMarkdown)` — confere que todo
  `RF` do `requirements.json` do Pensador (role `requirements-index`, novo em `cc-pensador` 2.16.0)
  esta reivindicado pelo campo `requirementIds` de pelo menos uma task. Degrada para
  `applicable: false` (nunca falso-positivo) quando nao ha `requirements-index` no upstream — modo
  Spec, ou handoff de versao anterior a esse role.
- `skills/orchestrator-multi-agent-development/scripts/validate-requirements-coverage.mjs` (novo,
  CLI, segue o padrao `executeJsonCli` de `check-prompt-budget.mjs`) + `scripts/validate-requirements-coverage.mjs`
  (wrapper): `REQUIREMENTS_NOT_COVERED` (exit 1) reporta os `RF-XX` sem cobertura.
- `references/workflow.md`: novo campo `requirementIds` na Fase 2, gate rodado logo apos
  `tasks-classification.md` (barato pegar cedo) e de novo na Fase 7 (antes da matriz de
  rastreabilidade). `SKILL.md`: novo item de checklist.
- `tests/requirements-coverage.test.mjs` (novo, 16 testes): caminho positivo (cobertura completa,
  degradacao correta sem `requirements-index`) e negativo (requisito derrubado detectado com o ID
  exato, sem tasks nenhum requisito coberto, referencia a RF-ID nao relacionado nao conta) + CLI.

## [4.6.0] — 2026-08-24

### Schema + validador do envelope `handoff.json` (`validate-handoff.mjs`)

Achado de auditoria: `handoff.json` e a "ancora unica de descoberta" entre os tres plugins do
workflow (handoff-contract.md secao 4) — o unico sinal que distingue modo conjunto de modo
independente — mas nenhum codigo em nenhum dos tres repositorios escrevia, lia ou validava esse
arquivo (`grep -rn handoffVersion --include=*.mjs --include=*.json` nos tres retornava zero). Um
produtor podia divergir do contrato em silencio (como ja havia acontecido: `feature-isolation.md`
do Pensador sem os roles `api-contract`/`openspec-change`) sem nenhum teste pegar ate um consumidor
falhar a achar um artefato esperado.

- `skills/orchestrator-multi-agent-development/scripts/lib/handoff-validator.mjs` (novo, canonico,
  byte-identico nos tres plugins): `validateHandoff(handoff)` colige todas as violacoes do envelope
  numa passada — campos obrigatorios, enums de `stage`/`status`, e o vocabulario de `role` **por
  stage** (o que teria pego o drift do `feature-isolation.md`), incluindo o caso de um role valido
  para outro estagio ser reivindicado pelo estagio errado.
- `skills/orchestrator-multi-agent-development/scripts/validate-handoff.mjs` (novo, CLI) +
  `scripts/validate-handoff.mjs` (wrapper de compatibilidade): `node validate-handoff.mjs --file
  <path>`, JSON `{ ok, file, errors[] }`, exit 0 somente com `ok: true`.
- `skills/orchestrator-multi-agent-development/assets/handoff.schema.json` (novo): schema formal
  documentando o envelope, mesmo padrao ja usado por `orchestration-state.schema.json` — nenhuma
  dependencia de biblioteca de JSON Schema, so o validador escrito a mao.
- `references/handoff-contract.md` (canonico, replicado byte-identico nos tres plugins): nova secao
  9 documentando o validador e quando roda-lo (produtor antes de `DONE`; consumidor antes de
  confiar num handoff descoberto).
- `tests/handoff-validator.test.mjs` (novo, 38 testes): caminho positivo (handoff bem formado por
  estagio, cada role valido aceito) e negativo (cada violacao especifica com o codigo certo,
  incluindo o caso do role cruzado entre estagios) + round-trip do CLI + guarda que fixa
  `HANDOFF_ROLES_BY_STAGE` contra as tabelas de `handoff-contract.md` secao 5.

## [4.5.0] — 2026-08-24

### Despacho direto ao Codex, prompt persistido como artefato da run, e `--check-agent-mcp` no caminho padrão

O contexto do workflow atravessa quatro fronteiras (orquestrador → subagente → bridge/companion →
CLI externa) e três delas degradavam em silêncio: o prompt efetivo que chegava na CLI nunca era
persistido, o orçamento de 28.000 chars existia só como prosa aqui (embora já fosse um script no
plugin errado, `cc-executor-subagents`), e `codex:codex-rescue` custava um Sonnet reescrevendo o
prompt sem devolver isolamento de contexto nenhum — ele é instruído a devolver o stdout do Codex
exatamente como recebeu.

- **`scripts/preflight.mjs`**: `checkPlugin("openai-codex", "codex", ...)` agora exige
  `scripts/codex-companion.mjs` e publica `checks.plugins["openai-codex"].companionPath` — o único
  lugar do workflow que resolve o path versionado do companion, para que nada fora deste script
  hardcode a versão instalada (plugin de terceiro, sobrescrito a cada update).
- **`references/subagent-prompts.md`, `references/workflow.md`**: despacho para Codex passa a ser
  `node "<companionPath>" task --prompt-file <path> --effort ... [--write] --background --json`,
  chamado direto pelo orquestrador em vez de via subagente `codex:codex-rescue` (que vira fallback
  documentado para quando `companionPath` não resolve). No review de back-end (Fase 8), `--write` é
  **omitido**, o que torna o `read-only` uma garantia estrutural (`handleTask` em
  `codex-companion.mjs` faz `write = Boolean(options.write)`) em vez de uma frase de prompt.
- **`scripts/check-prompt-budget.mjs`** (novo, com wrapper em `scripts/`): mede o prompt persistido
  contra o limite de 28.000 chars — duro para `--agent agy` (exit 1, o gargalo real é
  `agy --print <prompt>` no bridge, que sempre vai por argv), apenas indicativo para `--agent codex`
  (exit 0 mesmo acima do limite, porque `--prompt-file` não passa pelo limite de argv do Windows).
- **Prompt efetivo como artefato da run**: `run/prompts/` já existia declarado em
  `scripts/lib/artifact-layout.mjs` mas nunca era preenchido. Agora todo dispatch persiste o corpo
  do prompt em `run/prompts/<taskId>.md` (ou `<taskId>-review.md`) antes de delegar, e para AGY o
  novo `--dump-prompt` do bridge (`cc-antigravity-plugin` 4.1.0) grava o prompt real da run e um
  sidecar de auditoria. `assets/subagents-context-template.md` ganha os campos **Prompt enviado**,
  **Contexto degradado** e **Arquivos descartados pelo corte**, alimentados a partir desse sidecar.
- **`scripts/validate-routing.mjs`**: `CODEX_SUBAGENT_RE` agora também reconhece `codex-companion.mjs`
  além de `codex:codex-rescue`, para que o gate do Req 7.11 (executor `claude-code` não invoca
  executor externo) cubra o novo caminho de despacho direto.
- **`--check-agent-mcp` entra no caminho padrão da Fase 0`** (`SKILL.md` 0.1, `references/workflow.md`
  Fase 0): a versão anterior deste changelog introduziu a flag como opt-in porque "Regras comuns" já
  instruía preferir `checks.optional.mcpPerAgent` (sinal ao vivo por agente) ao agregado de arquivo,
  mas sem a flag no caminho padrão esse bloco nunca existia e a regra era inalcançável na prática.

## [4.4.0] — 2026-08-24

### Detecção de MCP por agente (`--check-agent-mcp`) e oferta de instalação

O check agregado `checks.optional.mcp.<servidor>.ok` prova apenas que o Codebase Memory MCP ou o
Context7 estão registrados *em algum lugar* da máquina — não que o Codex ou o AGY especificamente
os têm. Isso fazia o bloco de instrução do grafo/Context7 ir para o prompt de um subagente Codex/AGY
mesmo quando aquela CLI específica não tinha a ferramenta.

- `scripts/lib/mcp-agent-cli.mjs` (novo): introspecção real via `codex mcp list --json`/`agy mcp
  list`, em vez de adivinhar por convenção de arquivo. Redação estrita — nunca extrai
  `transport.http_headers`/`transport.env`/URL/comando (que podem carregar uma chave de API real),
  só `name`/`enabled`/`type`. Corrige também um bug de plataforma: `execFileSync` sem shell falhava
  silenciosamente contra o `codex.cmd`/`.ps1` do npm no Windows (`BINARY_MISSING` falso-positivo);
  trocado por `execSync` com o mesmo padrão já usado por `checkCli()`.
- `scripts/lib/mcp-agent-install.mjs` (novo): registra (`installAgentMcp`) e remove
  (`removeAgentMcp`) um servidor no CLI do agente, via os comandos reais confirmados ao vivo (`codex
  mcp add context7 --url ...`, `agy mcp add codebase-memory-mcp codebase-memory-mcp`, etc.). Nunca
  roda sozinho — só depois de aprovação explícita via `AskUserQuestion`, mesmo padrão do instalador
  do Open Design (`cc-pensador`). Nunca embute uma chave de API real no comando.
- `scripts/lib/mcp-detect.mjs`: nova `detectMcpServersPerAgent()`, separada de `detectMcpServers()`
  (que continua sendo o scan de arquivo, puro e rápido). Cada resultado carrega `install` — o
  comando pronto para oferecer — só quando `checked: true, ok: false` (ausência confirmada, não
  suposta).
- `scripts/preflight.mjs`: nova flag opt-in `--check-agent-mcp` (custo real de subprocesso, por
  isso fora do caminho padrão) publica `checks.optional.mcpPerAgent.<agent>.<servidor>`.
- `references/mcp-context.md`, `references/subagent-prompts.md`, `references/preflight-check.md`:
  documentam a ordem de preferência (`mcpPerAgent` por agente > `mcp` agregado como fallback quando
  `checked: false`) e a seção "Oferta de instalação por agente". O bloco de instrução do grafo, que
  a documentação já afirmava estar "no template de `subagent-prompts.md`" mas não estava, agora
  está de fato lá (placeholders `Codebase Memory MCP:` ao lado de cada `Context7 MCP:`).
- `tests/mcp-agent-cli.test.mjs`, `tests/mcp-agent-install.test.mjs`, `tests/mcp-prompt-wiring.test.mjs`
  (novos): 26 testes, incluindo fixtures reais capturados ao vivo (codex-cli 0.148.0, agy 1.1.17) e
  um caso que garante que nenhum comando de instalação carrega uma chave de API.

## [4.3.0] — 2026-08-21

### Saneamento da ingestão OpenSpec (`openspec-change`) e correções de documentação

- `references/workflow.md`: a ingestão do change set OpenSpec em modo conjunto agora confirma o
  estado via `openspec status --change <nome> --json` antes de ler os arquivos, tolera `specs/`
  ausente (mudanças com `skip_specs: true`) e caminhos aninhados
  (`specs/<área>/<capability>/spec.md`), e conta subtarefas aninhadas ao derivar tasks.
- `references/handoff-contract.md`: papel `openspec-change` atualizado para refletir o OpenSpec
  1.9+ (specs opcionais/aninhadas, mudança gerida por `/opsx:propose` em vez do prefixo
  `openspec-*` legado). Sincronizado byte-a-byte com a cópia canônica em `cc-pensador`.
- `README.md`/`README.pt-BR.md`: removida a afirmação de que "o OpenSpec deixou de fazer parte do
  fluxo" — o preflight de fato não exige o CLI OpenSpec, mas o orquestrador continua podendo
  ingerir um handoff com artefato `openspec-change` do Pensador em modo conjunto.
- `.claude/settings.json`: a entrada `Bash(openspec publish:*)` (comando inexistente) foi
  substituída por `Bash(openspec list:*)`, `show`, `status` e `validate` — as chamadas de CLI
  realmente usadas pela ingestão.
- A árvore gerada `.claude/skills/openspec-*` + `.claude/commands/opsx/*` foi regenerada
  localmente na 1.10.0 via `openspec update`, mas **permanece ignorada pelo git** (`.claude/` no
  `.gitignore`): é artefato de ambiente, não conteúdo do plugin. `.claude/settings.json` continua
  versionado, como antes.

## [4.2.0] — 2026-08-20

### Integração com cc-antigravity-plugin 4.0

- O preflight agora exige `cc-antigravity-plugin >= 4.0.0` e AGY `>= 1.1.8`, recomendando a versão validada `1.1.16` sem bloquear versões compatíveis intermediárias.
- Implementação front-end usa o contrato explícito `--mode accept-edits --format stream-json`; review front-end usa `--read-only --format json --model pro-high --effort high`.
- O routing deixou de fixar slugs versionados. Heurística e aprendizado usam aliases estáveis (`flash-low`, `flash-medium`, `flash-high`, `pro-low`, `pro-high`), enquanto overrides do usuário aceitam slugs dinâmicos seguros validados pelo catálogo runtime do bridge.
- Novos overrides públicos `/orchestrator --agy-effort <low|medium|high>` e `--agy-timeout <duração>`. Controles de baixo nível (`--mode`, `--format`, `--agent`, `--json-schema` e retomada) continuam sob responsabilidade do orquestrador.
- O adapter AGY preserva metadados estruturados allowlisted: conversa, modelo resolvido, usage numérico, duração, turnos e diretiva segura de retry. Retomada prefere `--conversation <id>` e usa `--continue` somente sem ID.
- `state.json` e `attemptHistory` preservam esses metadados sem migrar runs antigas; novas tentativas mantêm a conversa/retry e limpam métricas pertencentes à tentativa anterior.
- Documentação, comandos, referências e templates foram sincronizados para não editar `settings.json` do usuário e para distinguir `--agent` customizado do AGY dos subagentes do Claude Code.

### Stack de agentes configurável (`project-config`)

A stack deixou de ser fixa em Codex/AGY. Quatro papéis — `backendExecutor`, `frontendExecutor`, `backendReviewer`, `frontendReviewer` — cada um `codex`, `agy` ou `claude-code`, formam a Project_Config do projeto, persistida em `.orchestrator/project-config.md` e derivada por `scripts/lib/project-config.mjs`, a única fonte da verdade de perguntas, defaults, CLIs obrigatórias e roteamento. Um projeto com os quatro papéis em `claude-code` roda o workflow inteiro sem Codex nem AGY instalados; o Executor `claude-code` delega implementação a um subagente do próprio Claude Code pela ferramenta `Agent` e roda review em modo somente leitura, gravando em `review/review-final.md`/`review/review-frontend.md`.

- Novo subcomando `/orchestrator project-config` (e alias `/orchestrador project-config`): mostra e altera a configuração vigente e revalida o ambiente, sem iniciar run, criar `.orchestration/<slug>/` nem ler PRD.
- Nova CLI `scripts/project-config.mjs` (`show`, `write`, `validate`, `required-clis`).
- `preflight.mjs` publica o bloco `projectConfig` (papéis efetivos, `path`, `updatedAt`, `requiredCliSet`, `source: file|default`) e um array `warnings` no topo para reprovado opcional/MCP ausente; `failed` só contém reprovado obrigatório, decidido pelo Required_CLI_Set da Project_Config.
- Preflight agora detecta dois MCPs opcionais — Codebase Memory MCP (`codebase-memory-mcp`) e Context7 — nenhum bloqueante; ver `references/mcp-context.md` para o protocolo de uso de cada um.
- `validate-routing.mjs` valida `executor`/`executorSource` por task contra a derivação da Project_Config, mantendo a heurística legada por menção de agente para artefato sem o campo `executor`.
- `orchestration-state.mjs`: `state.json` grava um snapshot da Project_Config na inicialização da run; `resume` reporta `projectConfigDrift` quando o arquivo mudou desde então; nova operação `project-config-apply --scope pending` adota a configuração atual só em tasks ainda não despachadas, preservando o Executor de toda task já despachada.
- Telemetria projeta `metadata.executorSource` junto do `executor` efetivo de cada task.
- Novas referências `references/project-config.md` e `references/mcp-context.md`.
- O Dependency_Installer (`scripts/lib/dependency-plan.mjs`) agora também oferece, junto de cada CLI reprovada, o plugin do Claude Code que a conecta — `openai-codex` (`codex-plugin-cc`) para `codex`, `cc-antigravity-plugin` para `agy` — quando `checks.plugins.*` do preflight reprova esse plugin. As duas reprovações são independentes: CLI instalada não implica plugin instalado, e vice-versa.

## [4.1.0] — 2026-08-18

### Layout de artefatos por estágio do workflow

O diretório de uma run deixou de ser uma pasta plana com 13 arquivos na raiz e passou a ser organizado por estágio. Runs criadas antes desta versão continuam funcionando sem migração.

#### Layout 2

Toda run nova nasce com `state.layoutVersion: 2` e grava:

```text
state.json  events.jsonl        raiz: identidade da run
plan/       tasks-classification.md, waves.md
contracts/  um arquivo por contrato
run/        monitoring.md, lifecycle-probe.json, executor-results/, prompts/
review/     review-final.md, review-frontend.md, e2e-verification.md, screenshots/
report/     implementation-report.md, workflow-log.md, subagents-context.md, handoff.json
evidence/   saída dos scripts de intelligence
learning/   learning-report.md
```

`state.json`, `events.jsonl` e `.state.lock` permanecem na **raiz** da run, e o diretório da run continua sendo filho direto de `.orchestration/`. Isso não é estética: `nextRunId`, a descoberta de run do `resume`, a projeção de history e a de knowledge varrem filhos diretos procurando `state.json`. Aninhar ou arquivar uma run em subpasta a esconderia dessas quatro varreduras — e faria `nextRunId` reutilizar um `runId` já emitido no mesmo dia, violando a imutabilidade de run terminal introduzida no 4.0.0.

#### Resolução de caminho centralizada

- Novo `scripts/lib/artifact-layout.mjs` é a única fonte de path de artefato: `resolveArtifact`, `artifactWritePath`, `artifactTreePath`, `artifactRelativePath`, `artifactTreeRelativePath`, `detectArtifactLayout`, `ensureArtifactLayout`.
- **Leitura** tenta layout 2 e cai para layout 1. Uma run antiga continua legível, e um artefato deixado manualmente no lugar antigo continua satisfazendo o gate — a evidência registra o caminho real (`file:review/review-final.md` ou `file:review-final.md`).
- **Escrita** segue o layout declarado pela run e nunca duplica um artefato que já exista no outro layout; uma run em andamento não é reorganizada no meio do caminho.
- Snapshot sem `layoutVersion` é layout 1 por definição. Sem snapshot legível, a inferência olha o diretório: presença de `plan/`/`report/` indica layout 2, presença de `events.jsonl` sem eles mantém layout 1.
- `layoutVersion` entra em `state.json` via o payload de `RUN_INITIALIZED`, portanto sobrevive ao replay determinístico e não quebra `verify`. Adicionado ao `orchestration-state.schema.json` como propriedade opcional.

#### Consumidores atualizados

`orchestration-state.mjs` (parse de plano, mapa de artefato dos completion gates, artefatos obrigatórios de `run DONE`, `init`), `validate-routing.mjs`, `learning-recipes.mjs` (escrita e evidência do `learning-report.md`, varredura de reviews), `orchestration-history.mjs` (indexação FTS5 dos artefatos), `intelligence.mjs` (`evidence/`), `executor-control.mjs` (`executor-results/`), `lifecycle-manager.mjs` (`lifecycle-probe.json`) e `inspect-contract.mjs` (default de `contracts/`).

#### Testes

Novo `tests/artifact-layout.test.mjs` cobre: run nova declarando layout 2 com a árvore criada; `plan/` como fonte parseada de tasks/waves; plano deixado na raiz continuando legível; evidência de gate e audit apontando o layout que realmente contém o arquivo; mapeamento e detecção de layout; e não duplicação de artefato entre layouts. Suíte completa: 61 testes.

#### Contagem de tokens: drift de template fechado

O `workflow.md` já mandava consolidar tokens em `implementation-report.md` seção 11a e em `subagents-context.md` seção "Uso de Tokens por Agente", mas nenhuma das duas seções existia nos templates — só o campo `Tokens usados` por subagente. Ambas foram criadas com os nomes exatos que a referência cita, mais o total da execução em `workflow-log.md` seção 1. As regras agora são explícitas: dado não reportado é `N/A` e nunca `0`; papel que não executou na run é `N/A` na linha inteira; com `agyParallel: yes` o total do AGY já é o agregado da sessão e não se soma o fan-out por fora; rodadas de review repetidas por `REPROVADO` somam na mesma linha com a contagem de rodadas; e as duas tabelas precisam fechar no mesmo total.

Tokens continuam **fora** de `.orchestrator/telemetry.jsonl`: `FORBIDDEN_FIELD_PATTERN` em `lib/telemetry.mjs` recusa qualquer campo cujo nome contenha `token`, e afrouxar essa regex enfraqueceria a proteção contra vazamento de token de autenticação. Agregação de tokens cross-run exigiria contadores com nome neutro (`usageInputUnits` e afins) no allowlist e um bump do `telemetry-event.schema.json` — não feito neste release.

#### Sem migração automática

Não existe conversão de layout 1 para 2. Mover arquivos de uma run existente e editar `layoutVersion` no snapshot faz `verify` reprovar, porque o snapshot passa a divergir do replay do event log. Runs antigas ficam no layout delas.

## [4.0.0] — 2026-08-17

### Sistema de engenharia persistente inspirado nos padrões do Hermes

Este release conclui os 11 itens do review de conformidade e transforma o workflow em um sistema que preserva estado, pesquisa experiências anteriores, executa validações mecânicas em código e aprende sob curadoria. É um major release porque passa a exigir **Node.js 22.13+ com `node:sqlite`/FTS5** e amplia o contrato operacional da run até a Fase 12.

#### 1. State Engine e resume estabilizados

- Runs terminais são imutáveis; `runId` não pode ser reutilizado e `RUN_TRANSITIONS` é independente do lifecycle de tasks.
- `run DONE` exige tasks não vazias, evidence plan, escopo resolvido, Fase 12, artefatos e completion gates com evidence IDs.
- Task removida da classificação continua bloqueante até decisão explícita `REMOVE|REINSTATE`; corrupção da run mais recente é exposta como `RUN_CORRUPT`, sem fallback silencioso.
- Cancelamento tornou-se protocolo reconciliável: impede dispatch, interrompe/consulta executores, terminaliza tasks e só então fecha a run.
- `UNKNOWN -> DONE` exige status externo autoritativo mais corroboração local; Git/arquivo isolado nunca prova sucesso. Reason codes brutos, attempts, leases e workspaces são preservados.
- O gate `browserE2E` é obrigatório sempre que a run possui front-end. A dispensa por topologia (front e back na mesma origem) é um waiver explícito com motivo auditável, nunca uma derivação silenciosa; nenhum outro gate obrigatório pode ser dispensado.

#### 2–3. Project Memory e histórico pesquisável

- `.orchestrator/project-memory.md` é uma projeção pequena apenas de fatos `VALIDATED`, provenientes de `FILE`, `CONTRACT`, teste aprovado, `RUN_EVENT` ou declaração explícita `USER`.
- `knowledge.db` preserva fingerprints, conflitos, stale/revoke/pin, lessons e recipes. Fontes alteradas deixam automaticamente o contexto sempre carregado.
- `history.db` é uma projeção SQLite reconstruível/idempotente dos `events.jsonl`, com migrations WAL e FTS5 para runs, tasks, falhas, soluções, reviews, modelos, agentes e evidências.
- Nova CLI `orchestrator-knowledge.mjs`: init/status/render/audit, facts, project/rebuild/search/browse/status do histórico.

#### 4. Programmatic intelligence

- Nova camada de scripts determinísticos: `inspect-project`, `inspect-contract`, `inspect-api-ui`, `inspect-diff`, `validate-wire-format`, `validate-task-scope`, `collect-test-results` e `reconcile-run`.
- Scans são confinados ao projeto, bounded, read-only sobre código produtivo e emitem JSON versionado + `evidenceId`; resultados podem ser anexados ao State Engine.
- A regra operacional agora é executável: três ou mais reads/greps, loop de arquivos ou comparação mecânica devem usar script, mantendo o contexto do LLM condensado.

#### 5. Lifecycle Manager completo

- Adapters conservadores de Codex/AGY, probes por arquivo ou comando sem shell, redaction/limite de output e persistência de resultados antes da transição.
- Scheduler `tick/watch`, heartbeats baseados em progresso, leases renováveis, stall/grace, recovery, interrupt, retry e cancel reais.
- Ações externas exigem adapter ou confirmação explícita; payload desconhecido mantém `UNKNOWN`.

#### 6–8. Learning, Learned Recipes e Curator

- Fase 12 formal gera atomicamente `learning-report.md` e candidate lessons a partir de eventos/reviews duráveis, sem editar `SKILL.md` nem promover regras automaticamente.
- Promoção exige validação independente; Recipes são versionadas, possuem trigger determinístico, action escopada, confidence, evidências e contadores de uso/sucesso/falha.
- Curator implementa `ACTIVE -> STALE -> ARCHIVED`, pin/archive/activate, detecção de contradições (`needsReview`), backups com hashes e rollback com safety backup. Mutação é dry-run por padrão e nunca apaga recipe arquivada.

#### 9. Worktrees por task

- Planner compara `allowedPaths`/`expectedFiles`: scopes disjuntos são elegíveis a worktree; overlap ou escopo ausente serializa a execução.
- Create/recover/ready/integrate/cleanup persistem branch, base/head, status, conflito e cleanup. Conflitos ficam materializados e nunca são abortados/resolvidos silenciosamente.

#### 10–11. Adaptive routing e observabilidade

- Router conservador combina override, pisos de criticidade/fidelidade, retry e histórico comparável por tipo/complexidade. Usa sucesso suavizado, intervalo Wilson, first-pass success, review failures, regressões e duração; nunca rebaixa o piso nem explora tasks críticas aleatoriamente.
- Decisões adaptativas exigem `agyModelEvidence`; o validator recusa source adaptativo sem evidência.
- `.orchestrator/telemetry.jsonl` registra somente metadados allowlisted. Campos de prompt/conteúdo/diff/source/raw output/secrets são recusados inclusive quando aninhados.
- Relatórios cross-run, retenção recuperável com backup e export OTLP/HTTP metadata-only opt-in foram adicionados.

#### Gates mecânicos e consistência entre parsers

Correções encontradas na revisão de conformidade do próprio 4.0.0, antes da publicação:

- **`validate-routing.mjs` passou a aceitar a mesma gramática de ID do State Engine** (`T1`, `T12-A`, `BE-01`, `FE-001-B`) e entradas de wave em lista (`- FE-01 -> agente`). Antes reconhecia apenas `T<N>` em cabeçalho/tabela: uma classificação com `BE-01` — formato documentado no workflow e usado nos próprios exemplos do CLI — reprovava a Fase 3 com "nenhum bloco de task encontrado", sem saída além de renomear todas as tasks.
- **O validador agora reprova implementação delegada ao `antigravity-agent`**, que é somente leitura. A regra existia em prosa desde o 3.5.0 no workflow, no comando e no `SKILL.md`, e o preflight já exigia `antigravity-coder.md`, mas o gate mecânico não distinguia os dois subagentes e deixava passar exatamente o bug crítico que o 3.5.0 corrigiu.
- **`browserE2E` deixou de sumir sozinho em run só de front-end.** A aplicabilidade era derivada de `backend && frontend`, então uma SPA consumindo uma API separada já existente — o caso canônico da Fase 9.5 — nascia `N/A` sem motivo nem registro. Agora o gate é obrigatório sempre que há front-end e a dispensa exige waiver com motivo.
- **Nome de modelo AGY deixou de ser lido como task.** `TASK_ID_SOURCE` casava `gemini-3` dentro de `gemini-3.5-flash-high`; numa tabela de roteamento isso podia virar o ID do bloco no validador e uma task fantasma no `sync`. A gramática — idêntica nos dois parsers — agora descarta sufixo de versão.
- Novos testes de regressão em `tests/routing-gates.test.mjs` cobrem os quatro casos.
- **Documentado o que versionar.** `.orchestration/` e `.orchestrator/` não têm o mesmo destino no Git: `events.jsonl`, artefatos da run, `project-memory.md` e `learned/` são versionáveis; `history.db`/`telemetry.jsonl` são projeções reconstruíveis; `.orchestrator/worktrees/` e `*.db-wal`/`*.db-shm` nunca podem ser versionados nem limpos durante uma wave. Tabela por caminho em `references/persistent-state.md`, com bloco de `.gitignore` pronto nos READMEs e verificação na Fase 1.K.

#### Integração e rastreabilidade

- `/orchestrator` e `/orquestrador` agora expõem `resume`, operações `knowledge` e `telemetry`, além do workflow completo até Learning.
- `SKILL.md`, workflow, READMEs, schemas e referências foram atualizados; `references/hermes-adaptation.md` documenta exatamente os padrões adaptados e as diferenças locais.
- Lógica estudada no [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent/tree/aeabff6aec6fe0e8a32ed96cf76b9a692eaf705f) (MIT), commit auditado em 2026-08-17: persist-before-delivery, estado indeterminado explícito, stall por atividade, SQLite/FTS5, execução condensada e curadoria recuperável. A implementação Node.js deste plugin é própria e não declara compatibilidade de API.

## [3.6.0] — 2026-08-17

### State engine persistente e `/orchestrator resume`

- **Nova state machine durável por run:** `.orchestration/<slug>/state.json` materializa o estado atual e `events.jsonl` preserva um log append-only com write-ahead, revisão monotônica, lock exclusivo e reconstrução automática do snapshot.
- **Retomada conservadora:** `/orchestrator resume [runId]` localiza a run ativa, transforma tasks interrompidas de `RUNNING` em `UNKNOWN`, reconcilia Git, arquivos, validações e probes de Codex/AGY, e nunca reexecuta nem declara sucesso apenas por encontrar mudanças locais.
- **Lifecycle formal:** estados canônicos `PENDING`, `RUNNING`, `DONE`, `FAILED`, `BLOCKED`, `STALLED`, `CANCELLED` e `UNKNOWN`; heartbeats, atividade de tool/API, grace period e detecção de stall baseada em ausência de progresso, não em duração total.
- **Recuperação após crash:** evento persistido antes do snapshot, replay de snapshot ausente/inválido, reparo seguro de evento final truncado, preservação de tasks terminais e bloqueio de resume em runs `DONE`/`CANCELLED`.
- **CLI e contratos versionados:** comandos determinísticos `init`, `sync`, `phase`, `task`, `heartbeat`, `sweep`, `reconcile`, `resume`, `run`, `status` e `verify`, acompanhados de JSON Schemas e referência operacional.
- **Cobertura automatizada:** testes de replay, tail truncado, snapshot inválido, reconciliação autoritativa, proteção contra falso positivo, stall/heartbeat, terminalidade, avanço de fase e sincronização de tasks.
- A semântica foi adaptada dos princípios do [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/c86197e60798801f62986e4e59460b1272d0c687) (MIT): persistir antes de publicar, representar ownership perdido como `unknown` e distinguir lentidão de ausência real de progresso. A implementação neste plugin é própria e ajustada ao workflow Codex/AGY.

## [3.5.0] — 2026-07-15

### Correções de processo identificadas em auditoria multi-frente (Pensador → Orquestrador)

Uma auditoria de ponta a ponta (código-fonte dos dois plugins + verificação real da entrega de um SaaS de oficina automotiva no navegador via Playwright) encontrou 9 problemas concretos no processo Pensador → Orquestrador. Esta versão corrige os que cabem ao Orquestrador:

- **CRÍTICO — roteamento de implementação front-end apontava para um agente somente-leitura.** Todo o roteamento (`workflow.md`, `subagent-prompts.md`, `agent-stack.md`, `commands/orchestrator.md`, templates) delegava tasks `FRONTEND_ONLY`/fatia front-end de `FULLSTACK` para `cc-antigravity-plugin:antigravity-agent` — que no plugin `cc-antigravity-plugin` é **read-only** (análise/review); quem edita arquivos é `antigravity-coder`. Corrigido em todos os pontos: implementação → `antigravity-coder`; review (Fase 9) → `antigravity-agent` (mantido, correto). `preflight.mjs` agora também valida a presença de `agents/antigravity-coder.md`.
- **`handoff-contract.md` ressincronizado (byte-idêntico nos 3 plugins)** — a cópia do `cc-pensador` estava 118 linhas desatualizada; corrigida no lado do Pensador (ver changelog daquele plugin), verificado aqui.
- **`validate-routing.mjs` agora reprova automaticamente** task de design system (cita `tokens.css`/`components.html`/`DESIGN.md`) usando modelo AGY de tier baixo (`flash-low`/`flash-medium`) — a regra "fidelidade de design" da Fase 0 do `SKILL.md` deixou de ser só prosa. Testado funcionalmente (fixture com modelo baixo reprova; com `flash-high` passa).
- **Gate de design (Fase 9) passa a exigir hover/focus reais via CSS**, não `style={{}}` inline — inline style não pode expressar `:hover`/`:focus`/`@keyframes`. Achado real: uma entrega com 141 blocos `style={{}}` e apenas 3 regras `:hover` em todo o app (só as setas do carrossel).
- **Pipeline de imagery/ícones (`IMAGE_SUGGESTIONS`)** — o `antigravity-coder` já sugeria proativamente oportunidades de imagem (mecanismo nativo `--generate-image`/Nano Banana), mas o Orquestrador nunca instruía a task front-end a devolver isso nem tratava a resposta. Agora todo prompt front-end carrega `sectorContext` e retorna o bloco `IMAGE_SUGGESTIONS`; quando presente, o Orquestrador apresenta as opções ao usuário via `AskUserQuestion` (multiSelect) antes de gerar qualquer imagem (ver seção 2a de `subagent-prompts.md`).
- **Guidance de testes contraditória removida.** Categoria `TEST_ONLY` eliminada (implicava tasks dedicadas de "escrever testes"); linguagem solta "adicione testes quando aplicável" removida. Deixado explícito: nem orquestrador nem subagentes geram projeto/suite de testes automatizados como entregável — a validação de cada requisito (`RF`/`CA`) acontece no review de código (Fases 8/9), por inspeção direta.
- **Nova matriz de rastreabilidade RF/CA → evidência** (`implementation-report-template.md` seção 13), montada na Fase 7 (não retroativamente) e conferida nas Fases 8/9. `// TODO`/`NotImplementedException`/placeholder/stub no caminho de um `RF` do escopo agora é achado **CRÍTICO/bloqueante** explícito nos prompts de review — não mais uma "lacuna conhecida" que passa despercebida (foi assim que um requisito de conteúdo institucional ficou 5 ondas como `// TODO` sem bloquear nenhum review).
- **Contagem de design systems curados corrigida (1/152 → confirmado ~150, 1 com `app.html`)**, alinhada com a correção equivalente no `cc-pensador`.
- **Fase 9.5 (E2E no navegador) agora cobre fluxos autenticados.** Novo passo explícito: antes de tentar login, verificar se o PRD documenta credenciais de seed conhecidas; se não, tratar como lacuna real (idealmente corrigir redefinindo a senha do seed para um valor conhecido, não apenas pular o fluxo). Evita repetir o gap observado: seed com hash sem plaintext bloqueou toda a verificação E2E de fluxos autenticados numa entrega real.

## [3.4.0] — 2026-07-14

### Verificacao E2E no navegador real obrigatoria (Fase 9.5) — fim do "APROVADO" cego

Corrige uma falha real e grave de processo: num SaaS com front (Next.js) e back (.NET) em origens/deploys separados, o orquestrador deu "APROVADO" **tres vezes** (Onda 1, Ondas 2-5, correcoes de seguranca) verificando apenas `dotnet build`, `npm run build` e `curl`. Ao dirigir a app num navegador real com o Playwright MCP, a vitrine publica inteira estava quebrada por defeitos que `build`/`curl` sao estruturalmente incapazes de detectar:

- **CORS ausente** no back — `curl` respondia 200, mas o browser bloqueava toda chamada cross-origin no preflight;
- **resolucao de tenant a partir do browser** — o front chamava a API sem o subdominio do tenant e recebia `400 tenant_required` (mascarado no `curl` porque o `Host` era passado a mao);
- **mismatch de casing no corpo de resposta** — o back serializava `whatsAppRedirectUrl` e o front lia `whatsappRedirectUrl`; a chamada retornava `200`, o campo vinha `undefined`, e a acao (redirect pro WhatsApp) falhava **silenciosamente, sem nenhum erro**.

Mudancas:

- **Nova regra central 17 (`SKILL.md`):** verificacao E2E no navegador real e OBRIGATORIA antes de qualquer "APROVADO" quando front e back sao separados; `build`/`tsc`/`curl` sao declarados explicitamente cegos a CORS, resolucao de host/tenant no browser, casing de resposta e "200 mas silenciosamente quebrado". Sem essa verificacao, a entrega no maximo pode ser `PARTIAL`, nunca `DONE`.
- **Nova Fase 9.5 (`references/workflow.md`):** passo concreto de verificacao — subir a app de verdade (`docker compose up`), dirigir os fluxos criticos (`UC-*`) via Playwright MCP, checar console/network sem CORS, UI refletindo dados reais, efeito final de cada acao confirmado, resolucao multi-tenant a partir do browser; achados sao BLOQUEANTES; evidencia em `.orchestration/<slug>/e2e-verification.md`.
- **Lista de fases e checklist minimo atualizados** com a Fase 9.5.

## [3.3.0] — 2026-07-13

### Reconciliação com a integração Pensador → Orquestrador (modo conjunto)

Este release também incorpora um commit que já estava publicado em `origin/main` sem entrada correspondente no changelog nem bump de versão: a detecção de `modo conjunto` (Fase 1.0), a ingestão do `handoff.json` do Pensador como fonte da verdade (PRD/Spec + `api-contract` + `design-system-files`), e a reformulação de `references/handoff-contract.md` (papéis por estágio, modos independente/conjunto, materialização do design system via `materializeInto`). As regras de execução contínua desta versão (abaixo) já foram escritas levando em conta esse modo conjunto.

### Execução contínua até a conclusão integral — fim do corte silencioso de escopo

Corrige um problema real observado em produção: numa demanda com PRD grande (SaaS multi-domínio) vinda da integração Pensador → Orquestrador, o orquestrador extraiu o escopo completo mentalmente, decidiu sozinho reduzir a execução a uma "Onda 1 — Fundação" e só comunicou esse corte de escopo no relatório final, depois de já ter implementado, revisado e fechado a entrega. O usuário nunca teve a chance de reagir a essa redução, porque nunca foi consultado sobre ela.

- **Nova regra central 16 (`SKILL.md`):** "Execução contínua até a conclusão integral do que já foi elaborado — sem corte unilateral de escopo, sem pausa para perguntar sobre fasear." A decisão de escopo já foi tomada rio acima — pelo Pensador (que já conduziu a entrevista de descoberta com o usuário no modo conjunto) ou pelo próprio usuário ao escrever/fornecer o PRD/spec (modo independente). O orquestrador **implementa o que já foi decidido até o fim**, montando todas as ondas necessárias e executando-as sequencialmente sem parar entre elas para confirmar se deve continuar.
- **Nova seção 1.3a (`references/workflow.md`):** "Execução contínua até a conclusão integral" — reforça que as únicas pausas legítimas durante a execução são por bloqueio real (lacuna bloqueante da Fase 1.3, bloqueio de sandbox/quota, reprovação em review na Fase 8/9), nunca por incerteza sobre o tamanho do escopo. Redução de escopo só é aceitável se o próprio usuário pedir isso explicitamente na mensagem que invocou o orquestrador.
- **Checklist mínimo atualizado** com o item correspondente: todas as tasks extraídas e todas as ondas executadas sequencialmente até a conclusão, sem pausa para perguntar sobre fasear.

## [3.2.2] — 2026-06-23

### Coerência do roteamento de modelo por fidelidade de design

- **`gemini-3.5-flash-high` agora está na escada da heurística (GAP #2 do review):** a regra de fidelidade de design fixava o piso em `flash-high`, mas a heurística base (default/complexa/crítica) nunca listava esse tier — o leitor não via onde ele se posicionava. Adicionada a linha `flash-high` (design system não-crítico) à heurística e a escada de capacidade explícita: `flash-low < flash-medium < flash-high < pro-low < pro-high` (allowlist `validate-routing.mjs`).
- **Checklist desambiguado (GAP #3):** o item dizia "`-high` quando crítico" (ambíguo entre `flash-high` e `pro-high`); agora diz `gemini-3.1-pro-high` por extenso, alinhado à regra 15.

## [3.2.1] — 2026-06-23

### Correções do review e2e Open Design

- **`preview/` em vez de `preview/app.html` (GAP 1 — bug real):** dos ~152 systems curados do Open Design, só 1 traz `preview/app.html`; a maioria traz `preview/colors.html`, `preview/spacing.html` e `preview/typography.html`. Todas as referências operacionais (`SKILL.md` regra 15, checklist, `references/subagent-prompts.md` prompt de implementação/regra de comparação/gate de design Fase 9, `references/handoff-contract.md` passo 5) foram atualizadas para apontar para o diretório `preview/` — igual ao que o `od-fetch-system.mjs` já fazia ao copiar o diretório inteiro via `copyTree`.
- **`design-system` role no handoff-contract (GAP 2):** a tabela do Pensador em `references/handoff-contract.md` estava sem a linha `design-system`, quebrando a promessa de documento idêntico entre os três plugins. Adicionada com o diretório verbatim `packages/ui/design-systems/<id>/` explícito no contrato.

## [3.2.0] — 2026-06-21

### Design system (Open Design) como contrato visual de ponta a ponta

Fecha a lacuna que deixava o front-end com "cara de template": o orquestrador recebia o design system do Pensador mas **não passava os artefatos de design ao AGY** e revisava só bugs de runtime, nunca a fidelidade visual.

- **Prompt de implementação front-end (`references/subagent-prompts.md`):** novo bloco **Design System (Open Design)** carregando os caminhos de `tokens.css` (fonte de verdade), `components.html` (fixtures), `design-system.md`/`design.md` (decisões) e `preview/app.html` (alvo visual), com as regras obrigatórias do skills-protocol — consumir `var(--*)`, não inventar tokens, casar estados de `components.html`, accent ≤ 2×/página, sem emoji-ícone, sem sombra se Depth & Elevation = minimal, override sempre documentado.
- **Gate de design no review da Fase 9:** o review front-end passa a verificar consumo de `tokens.css`, accent contido, diff das telas-chave contra `preview/app.html`, atendimento da capability `ui-design-system` (modo Spec) e ausência dos anti-padrões da seção 9 do DESIGN.md. Violação de requisito explícito (token inventado, override sem justificativa, accent flood) é tratada como **BLOQUEANTE**.
- **Roteamento de modelo por fidelidade de design (`SKILL.md`):** task front-end que **implementa design system** nunca usa `gemini-3.5-flash-medium` — mínimo `gemini-3.1-pro-low`, subindo para `gemini-3.1-pro-high` quando a fidelidade visual é crítica (landing, vitrine, hero). Scaffold funcional puro segue a heurística padrão.
- **Regra central nova + handoff:** `SKILL.md` ganha a regra 15 (design system é contrato visual, não decoração); `references/handoff-contract.md` documenta a ingestão do `design-system` (PRD) ou `design.md` + `specs/ui-design-system/spec.md` (Spec/OpenSpec) e dos arquivos verbatim em `packages/ui/design-systems/<id>/`, carregados em toda task front-end.
- **Suporte ao modo Spec/OpenSpec:** quando a demanda veio do Pensador em modo Spec, o orquestrador lê as decisões de design do `design.md` do change e os requisitos da capability delta-spec `ui-design-system`, usando cada cenário como critério de aceite do gate.
- **Checklist mínimo** atualizado com os três itens de design (paths no prompt, modelo coerente, gate aplicado na Fase 9).
