# Handoff Contract — Pensador → Orchestrador → Testador → Executor

Contrato de atuacao conjunta entre os quatro plugins do workflow de desenvolvimento. Define os papeis de cada estagio, como cada um publica seus artefatos e como o estagio seguinte os descobre, le e confia neles. **Este documento e identico nos quatro plugins** (`cc-pensador`, `cc-orchestrador-subagents`, `cc-testador-subagents`, `cc-executor-subagents`) e e a **fonte da verdade** do handoff. Qualquer alteracao aqui deve ser replicada verbatim nos quatro repositorios.

`HANDOFF_VERSION = 1`.

---

## 1. Cadeia do workflow e papeis

```text
Pensador               Orchestrador          Testador                  Executor
(PENSA)         ─────▶  (CONSTROI)    ─────▶  (VALIDA EM NAVEGADOR) ─▶  (CORRIGE)
PRD / Spec /            planeja, delega       testa E2E, a11y,            corrige o que o
Open Design             e implementa          UI/UX e rastreabilidade     Testador reprovou
.pensador/              .orchestrator/runs/   .testador/                  .executor/
```

| Estagio | Papel | Verbo | Responsabilidade central |
|---|---|---|---|
| **Pensador** (`cc-pensador`) | Pensa | Elaborar | Transforma a demanda em PRD ou Spec (OpenSpec) + artefatos de produto, arquitetura, contrato de API e design (Open Design). Nao implementa codigo. |
| **Orchestrador** (`cc-orchestrador-subagents`) | Constroi | Implementar | Ingere os artefatos do Pensador (ou um PRD/spec avulso), classifica tasks, monta ondas, gera contratos front-back, delega a Codex/AGY em paralelo, integra e revisa. Usado para **desenvolvimento complexo**. |
| **Testador** (`cc-testador-subagents`) | Valida em navegador real | Validar/homologar | Ingere a entrega do Orchestrador, valida em navegador real via Playwright MCP, confere requisitos rastreaveis (RF/CA, Scenarios do OpenSpec, tokens do Open Design) e devolve um laudo ao Executor. Read-only sobre codigo de producao. |
| **Executor** (`cc-executor-subagents`) | Corrige e faz os ajustes finos | Refinar/corrigir | Ingere o laudo do Testador (ou a entrega do Orchestrador quando o Testador nao rodou) como baseline, faz review plano-vs-entrega, aplica correcoes, hotfixes, ajustes finos e validacao. |

Cada estagio e **produtor** para o proximo e **consumidor** do anterior. Nenhum estagio reabre o trabalho do anterior: ele **confia**, referencia e produz a sua propria camada.

---

## 2. Modos de operacao: independente e conjunto

Cada plugin funciona **isoladamente** (recebendo a demanda direto do usuario) **ou em conjunto** (consumindo o `handoff.json` do estagio anterior). O `handoff.json` upstream e o unico sinal que distingue os dois modos. O nome do arquivo e sempre `handoff.json`; onde ele mora dentro da pasta de artefatos depende do layout de cada estagio (secao 4).

| Plugin | Modo independente (sem upstream) | Modo conjunto (com upstream) |
|---|---|---|
| **Pensador** | `/pensador <demanda>` — sempre a origem da cadeia. `upstream = null`. | — (primeiro estagio, nunca tem upstream) |
| **Orchestrador** | `/orquestrador "Desenvolva um CRUD de clientes"` — o usuario fornece a demanda/PRD/spec direto (via `@arquivo` ou texto). O orquestrador trata o texto/arquivo como fonte da verdade. | Detecta `.pensador/*/handoff.json` (`stage: pensador`, `status: DONE`) e ingere PRD/Spec + contrato + design como fonte da verdade, sem re-planejar. Ver secao 7. |
| **Testador** | `/testador <alvo avulso>` — demanda de validacao independente de entrega especifica. | Detecta `.orchestrator/runs/<slug>/report/handoff.json` (`stage: orchestrador`, `status: DONE`; cai para `.orchestration/<slug>/report/handoff.json` em runs do Orchestrador anteriores a esta raiz — secao 3) e valida a entrega do Orchestrador. Ver secao 7. |
| **Executor** | `/executor <demanda de resolucao rapida>` — feature pequena ou hotfix, com ou sem plano pre-definido no proprio enunciado. | Detecta `.testador/<slug>/artefatos/handoff.json` (`stage: testador`) — preferencial. Fallback para `.orchestrator/runs/<slug>/report/handoff.json` (ou `.orchestration/<slug>/report/handoff.json` em runs anteriores) quando o Testador nao rodou. Ver secao 7. |

Regra de deteccao (consumidor): antes de tratar a demanda como independente, procure o `handoff.json` do estagio anterior no caminho que a secao 7 define para esse estagio especifico. Se existir e estiver `DONE` (ou `PARTIAL`/`BLOCKED` — ver secao 8), entre em **modo conjunto**; se nao existir, siga **independente**. Em duvida (varios slugs/versoes), confirme via `AskUserQuestion`.

---

## 3. Raizes de artefatos (todas ocultas, com ponto)

| Estagio | Raiz | Identidade |
|---|---|---|
| Pensador | `.pensador/<slug>-vN/` | `slug` + versao local `-vN` |
| Orchestrador | `.orchestrator/runs/<slug>/` | `slug` (sem versao) |
| Testador | `.testador/<slug>/artefatos/` | `slug` da entrega validada |
| Executor | `.executor/<demanda_slug>/artefatos/` | `demanda_slug` da demanda de correcao |

Regra absoluta: **nenhum artefato `.md`/`.json` de coordenacao na raiz do projeto**. Tudo vive sob a raiz oculta do estagio. Excecao unica: o change set do OpenSpec (`openspec/changes/<nome>/`), que e gerido por `/opsx:propose` e vive na arvore padrao do OpenSpec (specs podem estar aninhadas: `specs/<area>/<capability>/spec.md`) — o `handoff.json` do produtor o referencia como caminho relativo ao projeto (ver secao 5).

> ⚠️ **Raiz do Orchestrador migrada de `.orchestration/<slug>/` para `.orchestrator/runs/<slug>/`.** Os dois nomes diferiam em tres caracteres, ambos ocultos, ambos na raiz do projeto, e nada no nome indicava qual era qual — `.orchestrator/` (config/knowledge por projeto: `project-config.md`, `worktrees/`, `history.db`, `knowledge.db`) e `.orchestration/` (artefatos por run) nunca tiveram razao semantica para serem nomes distintos. Toda run **nova** do Orchestrador nasce em `.orchestrator/runs/<slug>/`; uma run criada antes desta versao **nao e migrada automaticamente** e continua sendo descoberta em `.orchestration/<slug>/` — todo consumidor deste contrato (Testador, Executor) tenta a raiz atual primeiro e cai para a legada quando a run referenciada e anterior a esta mudanca.

### Correlacao por `slug`

O `slug` e a chave que liga os estagios. Deriva da demanda original (kebab-case, sem acentos). O Pensador acrescenta `-vN`; os demais usam o `slug` base (sem `-vN`). Exemplo real:

```text
.pensador/locadora-veiculos-multitenant-v1/       (slug = locadora-veiculos-multitenant, v1)
.orchestrator/runs/locadora-veiculos-multitenant/ (mesmo slug, sem versao)
.testador/locadora-veiculos-multitenant/artefatos/ (mesmo slug)
.executor/review-locadora-veiculos-.../            (demanda_slug proprio do review)
```

---

## 4. Manifesto de handoff: `handoff.json`

Cada produtor grava um `handoff.json` ao concluir. O nome do arquivo e sempre `handoff.json`; **onde** ele fica dentro da pasta de artefatos e especifico de cada estagio, porque cada um usa seu proprio layout (secao 5 detalha por estagio):

- **Pensador:** raiz de `artifactRoot` — `.pensador/<slug>-vN/handoff.json`.
- **Orchestrador:** agrupado sob `report/` (layout v2, que reune todo artefato de categoria "report") — `.orchestrator/runs/<slug>/report/handoff.json`. Runs anteriores a esta raiz usam `.orchestration/<slug>/report/handoff.json` (ou a raiz do slug, em layout anterior ao v2 — secao 7).
- **Testador:** raiz de `artefatos_dir` — `.testador/<slug>/artefatos/handoff.json`.
- **Executor:** raiz de `artefatos_dir` — `.executor/<slug>/artefatos/handoff.json`. Como o Executor e o ultimo estagio, esse arquivo nao tem consumidor a jusante quando `nextStage: null`.

Esse arquivo e a **ancora unica de descoberta**: o consumidor le o `handoff.json` do estagio anterior, no caminho que essa lista define para aquele estagio, antes de qualquer outra coisa. Nao existe um caminho unico valido para os quatro estagios — nunca assuma que o caminho de um estagio vale para outro.

### Envelope comum

```json
{
  "handoffVersion": 1,
  "stage": "pensador | orchestrador | testador | executor",
  "slug": "locadora-veiculos-multitenant",
  "producer": { "plugin": "cc-pensador", "version": "2.9.0" },
  "artifactRoot": ".pensador/locadora-veiculos-multitenant-v1",
  "artifactMode": "prd | spec",
  "status": "DONE | PARTIAL | BLOCKED",
  "createdAt": "2026-06-18T15:40:00.000Z",
  "updatedAt": "2026-06-18T15:40:00.000Z",
  "summary": "Resumo de 1-3 frases do que foi produzido.",
  "upstream": {
    "stage": "pensador",
    "handoffPath": ".pensador/<slug>-vN/handoff.json"
  },
  "artifacts": [
    { "role": "prd", "path": "prd.md", "required": true, "description": "PRD/Spec consolidado" }
  ],
  "nextStage": {
    "consumer": "cc-orchestrador-subagents",
    "entrypoint": "/orquestrador",
    "instructions": "Ingerir os artefatos e implementar o plano."
  },
  "waiver": {
    "owner": "Produto",
    "motivo": "Por que o waiver foi necessario",
    "impacto": "O que fica sem cobertura por causa dele",
    "validade": "2026-12-31T00:00:00.000Z",
    "condicaoDeReabertura": "O que precisa acontecer para reabrir/revalidar"
  }
}
```

- `upstream` e `null` no Pensador (primeiro estagio).
- `artifactMode` (`prd` ou `spec`) so e emitido pelo Pensador; propaga o formato base para os consumidores.
- `artifacts[].path` e **relativo a `artifactRoot`**, exceto entradas explicitamente marcadas como relativas ao projeto (ex.: `openspec-change`).
- `artifacts[].role` segue o vocabulario por estagio (secao 5).
- `status: BLOCKED` ou `PARTIAL` deve trazer `summary` explicando o bloqueio; o consumidor entao pergunta ao usuario antes de prosseguir.
- `waiver` (WF-010, opcional): so valido quando `status` e `PARTIAL` ou `BLOCKED`. E o registro estruturado de um risco formalmente aceito — distinto de `summary` (uma frase para humano): `owner` (quem aceitou o risco), `motivo`, `impacto`, `validade` (timestamp ISO 8601 ou `null` quando sem prazo) e `condicaoDeReabertura`. Nem todo `PARTIAL`/`BLOCKED` tem um waiver — as vezes e so trabalho em aberto sem uma decisao formal de risco aceito por tras.

O consumidor nunca adivinha caminhos: descobre tudo via o `handoff.json` do estagio anterior, no local que a secao 4 define para aquele estagio. Se estiver ausente (execucao de versao antiga), faz fallback para descoberta por convencao (secao 7) e avisa o usuario.

---

## 5. Vocabulario de `role` por estagio

### Pensador (`stage: pensador`)
| role | arquivo padrao | required |
|---|---|---|
| `prd` | `prd.md` | sim (modo PRD) |
| `userhistory` | `userhistory.md` | sim (modo PRD) |
| `architecture` | `architecture.md` | **sim, sempre** (ambos os modos) — EXPLORE e ARCH rodam sempre, na ordem fixa do `STAGE_ORDER`, independente de `hasBackend`/`hasFrontend`. Carrega os dominios descobertos, decisoes conhecidas e, em brownfield, as convencoes que o consumidor deve preservar (ver `WORKFLOW.md`, regra de precedencia brownfield). |
| `api-contract` | `openapi.yaml` / `schema.graphql` / `service.proto` / `asyncapi.yaml` | quando `backendConfirmed` — **fonte da verdade** maquina-legivel (formato por `state.apiStyle`). Carrega `validation` (`{ spec, mock, validate }`) para o consumidor subir mock (fluxo paralelo front/back) e validar o codigo contra o contrato no CI ("a spec e lei"). |
| `communication-contract` | `communication.md` | quando `backendConfirmed` — **visao legivel derivada** do `api-contract` (`derivedFrom` aponta o arquivo fonte). Nao e a fonte da verdade. |
| `design-system` | `design-system.md` | **somente no fallback** (front-end sem Open Design) — DESIGN.md inline das 9 secoes. Quando o Open Design e usado, o `DESIGN.md` verbatim (role `design-system-files`) substitui este doc. |
| `design-system-files` | `design-systems/<id>/` | quando `hasFrontend` **e** um system foi selecionado — **uma entrada por `<id>` concreto** (de `state.designSystems`), relativa ao `artifactRoot` (`.pensador/<slug>-vN/`), com os arquivos verbatim (`tokens.css`, `DESIGN.md`, `components.html`, `preview/`, …). Cada entrada carrega `materializeInto` (o alvo em `state.uiPackageDir`, ex.: `packages/ui/design-systems/<id>/`) que o Orchestrador/Executor usa ao materializar os arquivos na arvore de codigo real (secao 6). |
| `ui-prototype` | `prototypes/` | quando `hasFrontend` — prototipos HTML estaticos e interativos dos fluxos criticos para inspecao do Orquestrador/Testador e aprovacao visual do usuario. |
| `brand-assets` | `assets/` | quando `hasFrontend` — diretorio de midia e brand assets reais gerados no DESIGN com o manifesto `assets/manifest.json`. |
| `openspec-change` | `openspec/changes/<nome>/` | quando `artifactMode = spec` — change set OpenSpec (`proposal.md`, `design.md`, `tasks.md`, `specs/` — `specs/` omitido quando a mudanca declara `skip_specs: true`). **Caminho relativo ao projeto**, nao ao `artifactRoot` (gerido por `/opsx:propose`; consumidores confirmam o estado via `openspec status --change <nome> --json`, nao varredura de arquivos). Substitui `prd`/`userhistory`/`communication-contract` no modo Spec. |
| `codebase-memory` | `codebase-memory.md` | **sim, sempre** (ambos os modos) — mesma garantia de `architecture`. Mapa do codigo real (simbolos, cadeias de chamada, raio de impacto) e, em brownfield, o baseline do contrato de API existente descoberto por `contractDiscoveryGlobs()` (EXPLORE). |
| `project-baseline` | `project-baseline.json` | **sim, sempre** (ambos os modos) — resumo estruturado, maquina-legivel, de `isGreenfield`, `techStack`, `apiStyle`, `uiPackageDir` e `existingApiContractGlobs`. Complementa `architecture`/`codebase-memory` (prosa) com campos que o consumidor pode ler direto, sem parsear Markdown, para decidir roteamento e precedencia brownfield sem re-derivar o sinal. |
| `requirements-index` | `requirements.json` | **somente no modo PRD** — extraido deterministicamente das tabelas `RF-XX`/`CA-XX` das secoes 6 e 14 do PRD (`scripts/lib/requirements-extractor.mjs`), com o vinculo `CA -> RF` preservado. E a materia-prima do gate de cobertura RF/CA do Orquestrador (secao 5 de `references/handoff-contract.md` do Orquestrador). No modo Spec, o equivalente (`SHALL` + `#### Scenario:`) ja e exposto ao vivo por `openspec status --change <nome> --json`; sem `requirements-index` (Spec, ou handoff de versao anterior), o gate degrada e registra a degradacao — nunca finge cobertura. |
| `shared-agents` | `shared-agents/` | opcional |

### Orchestrador (`stage: orchestrador`)
| role | arquivo padrao | required |
|---|---|---|
| `implementation-report` | `report/implementation-report.md` | sim |
| `tasks-classification` | `plan/tasks-classification.md` | sim |
| `waves` | `plan/waves.md` | sim |
| `api-contracts` | `contracts/` | quando houver troca front-back |
| `review-final` | `review/review-final.md` | sim (back-end; N/A se nao houver) |
| `review-frontend` | `review/review-frontend.md` | quando houver front |
| `monitoring` | `run/monitoring.md` | sim |
| `workflow-log` | `report/workflow-log.md` | sim |
| `subagents-context` | `report/subagents-context.md` | sim |
| `openspec-change` | `openspec/changes/<nome>/` | quando OpenSpec for usado (relativo ao projeto; `specs/` opcional sob `skip_specs`) |

### Testador (`stage: testador`)
| role | arquivo padrao | required |
|---|---|---|
| `test-plan` | `plan/test-plan.md` | sim |
| `coverage-matrix` | `plan/coverage-matrix.json` | sim |
| `flow-map` | `plan/flow-map.json` | sim |
| `test-report` | `review/test-report.md` | sim |
| `a11y-report` | `review/a11y-report.md` | quando houver front-end |
| `uiux-report` | `review/uiux-report.md` | quando houver front-end |
| `coverage-report` | `review/coverage-report.md` | quando houver requisito formal |
| `design-conformance` | `review/design-conformance.json` | quando houver Open Design |
| `specs` | `run/specs/` | quando specs forem gerados |
| `playwright-report` | `run/playwright-report/` | quando Playwright rodar |
| `screenshots` | `review/screenshots/` | quando houver evidencia visual |
| `monitoring` | `run/monitoring.md` | sim |
| `workflow-log` | `report/workflow-log.md` | sim |
| `subagents-context` | `report/subagents-context.md` | sim |
| `implementation-report` | `report/implementation-report.md` | sim |

### Executor (`stage: executor`)
| role | arquivo padrao | required |
|---|---|---|
| `initial-plan-baseline` | `initial-plan-baseline.md` | quando houver plano pre-definido (inclui a entrega do Orchestrador em modo conjunto) |
| `execution-brief` | `execution-brief.md` | quando 2+ agentes |
| `plan-vs-output-review` | `plan-vs-output-review.md` | quando houver plano pre-definido |
| `implementation-report` | `report/implementation-report.md` | sim |
| `workflow-log` | `report/workflow-log.md` | sim |
| `subagents-context` | `report/subagents-context.md` | sim |
| `monitoring` | `run/monitoring.md` | sim |
| `screenshots` | `review/screenshots/` | quando houver validacao visual |

---

## 6. Open Design: contrato visual e materializacao

Quando o Pensador tem front-end, o Open Design produz **arquivos verbatim** (nao prosa): `tokens.css` (fonte de verdade do estilo), `DESIGN.md` (9 secoes), `components.html` (fixtures) e `preview/` (sanity check visual — os arquivos variam por system: `colors.html`, `spacing.html`, `typography.html`). Esses arquivos sao um **contrato visual**, nao decoracao.

### Ciclo de vida dos arquivos de design

```text
Pensador                              Orchestrador / Executor
grava VERBATIM em                     MATERIALIZA em (via materializeInto)
.pensador/<slug>-vN/                  packages/ui/design-systems/<id>/
  design-systems/<id>/                  (ou src/styles/… em app unico)
    tokens.css                        e CARREGA os caminhos no prompt de
    DESIGN.md                         toda task front-end + usa no gate de
    components.html                   design da fase de review.
    preview/
```

- O Pensador **nunca** escreve na arvore de codigo real; persiste os arquivos dentro da pasta da feature. Cada entrada `design-system-files` do `handoff.json` do Pensador (raiz de `.pensador/<slug>-vN/`) carrega `materializeInto` com o alvo real.
- O **Orchestrador** (modo conjunto ou quando recebe design via PRD/spec) **materializa** os arquivos em `materializeInto`, passa `tokens.css`/`components.html`/`DESIGN.md` (ou `design.md` + `specs/ui-design-system/spec.md` no modo Spec) e o diretorio `preview/` no prompt de toda task front-end, e aplica o **gate de design** no review: `tokens.css` consumido via `var(--*)` (nunca hex literal), accent contido (≤ 2x por pagina), telas-chave conferidas contra `preview/`, anti-padroes da secao 9 do DESIGN.md ausentes. Violacao de requisito explicito e **BLOQUEANTE**.
- O **Testador** VALIDA a conformidade de token e anti-padroes contra a proposta inicial do Pensador: confere que o codigo materializado usa `var(--*)` (nunca hex literal), que nenhum token foi inventado ("never invent new tokens"), e que as telas-chave correspondem ao `preview/`. Achados sao bloqueantes por violacao de requisito explicito (secao 5 deste documento).
- O **Executor** consome o mesmo contrato visual ao corrigir/ajustar o front-end: nao reinventa tokens, respeita `tokens.css` e valida a fidelidade contra `preview/`.
- Regra inviolavel herdada do Open Design: **never invent new tokens.** Divergencia justificada vira override documentado (na secao *Decisions* do `design.md` no modo Spec, ou nota no `handoff.json` do Pensador no modo PRD), nunca um valor solto no `theme.ts`.

---

## 7. Descoberta pelo consumidor (fallback sem `handoff.json`)

### Orchestrador ingere Pensador (modo conjunto)
1. Procure `.pensador/*/handoff.json`. Para multiplos `slug`, confirme com o usuario qual demanda implementar via `AskUserQuestion`.
2. Para o mesmo `slug` com varias versoes `-vN`, **use a maior versao** (mais recente). Confirme via `AskUserQuestion` se houver duvida.
3. Sem `handoff.json`: leia `.pensador/<slug>-vN/.pensador-progress.json` (`checkpointVersion: 2`) e o array `artifacts`.
4. **Modo PRD** — ingira na ordem: `prd` → `userhistory` → `architecture` → `codebase-memory` → `project-baseline` → `requirements-index` → `api-contract` → `communication-contract` → `design-system`/`design-system-files`. Use o `api-contract` (maquina-legivel) como **fonte da verdade** dos contratos API/UI da Fase 4 — suba o mock a partir dele e valide contra ele no CI (campo `validation`); o `communication-contract` e apenas a visao legivel. Use `project-baseline` (`isGreenfield`, `techStack`, `apiStyle`, `uiPackageDir`) em vez de re-derivar esses sinais; quando ausente (handoff de versao anterior a `project-baseline`), re-derive e registre a degradacao. Use `requirements-index` (`requirements.json`) como a lista de `RF`/`CA` que a Fase 2 tem de cobrir integralmente ao classificar tasks — e a materia-prima do gate de cobertura da secao 5 do handoff contract do Orquestrador; sem ele (modo Spec, ou handoff antigo), derive a lista lendo o PRD/spec diretamente e registre a degradacao. Trate o PRD/spec como **fonte da verdade**: **nao** reabra discovery nem replaneje.
5. **Modo Spec (OpenSpec)** — a `role` `openspec-change` aponta `openspec/changes/<nome>/`. Ingira `proposal.md`, `design.md`, `tasks.md` e `specs/` (quando presente — omitido sob `skip_specs`; pode estar aninhado em `specs/<area>/<capability>/spec.md`); confirme via `openspec status --change <nome> --json` antes de assumir completude. Derive a classificacao de tasks a partir de `tasks.md` preservando IDs/ordem (incluindo subtarefas aninhadas). O contrato de API esta dobrado em `design.md` + `specs/` (nao ha `api-contract` standalone).
6. **Design (Open Design), quando houver front-end** — materialize os arquivos verbatim de `design-system-files` conforme secao 6 e trate-os como contrato visual do front-end. Se so houver o fallback `design-system.md` (sem Open Design), use-o como referencia inline.

### Testador ingere Orchestrador (modo conjunto)
1. Procure `.orchestrator/runs/<slug>/report/handoff.json` — a raiz atual do Orchestrador, com `handoff.json` agrupado sob `report/` desde o layout v2. Sem ela, procure `.orchestration/<slug>/report/handoff.json` (raiz legada, runs anteriores a esta migracao — secao 3). Caia para `<raiz-encontrada>/<slug>/handoff.json` (sem `report/`) apenas em runs anteriores ao layout v2.
2. Adote a entrega do Orchestrador como **baseline de validacao**: preserve o conteudo relevante em `{artefatos_dir}/ingested-baseline.md`.
3. Sem `handoff.json`: leia `<raiz>/<slug>/report/implementation-report.md` + `<raiz>/<slug>/plan/tasks-classification.md` + `<raiz>/<slug>/plan/waves.md` + `<raiz>/<slug>/contracts/`, onde `<raiz>` e `.orchestrator/runs` ou, na ausencia dela, `.orchestration`.
4. Para rastreabilidade, siga `upstream` ate o `handoff.json` do Pensador (raiz de `.pensador/<slug>-vN/` — nao leva o prefixo `report/`, que e especifico do layout do Orchestrador) e use `prd`/`api-contract`/`requirements-index` como criterio de cobertura e `design-system-files` como criterio visual.
5. O `test-report.md` do Testador, quando o laudo for `REPROVADO`, serve como plano de correcao para o Executor seguinte: `nextStage.instructions` orienta o Executor a usar `{artefatos_dir}/review/test-report.md` como `plano_predefinido`.

### Executor ingere Testador (modo conjunto — preferencial) ou Orchestrador (fallback quando Testador nao rodou)
1. **Preferencial:** procure `.testador/<slug>/artefatos/handoff.json` (`stage: testador`).
2. **Fallback:** se nao existir, procure `.orchestrator/runs/<slug>/report/handoff.json` (`stage: orchestrador`, raiz atual); sem ela, `.orchestration/<slug>/report/handoff.json` (raiz legada — secao 3). Caia para `<raiz-encontrada>/<slug>/handoff.json` (sem `report/`) apenas em runs anteriores ao layout v2 do Orchestrador.
3. Adote o handoff encontrado como **plano pre-definido baseline**: registre `plano_predefinido: true`, preserve o conteudo relevante em `{artefatos_dir}/initial-plan-baseline.md` e execute o review plano-vs-entrega (Codex high) comparando o baseline com o estado atual do codigo. As correcoes e ajustes finos derivam desse review.
4. Sem `handoff.json` de nenhum dos dois: leia `<raiz>/<slug>/report/implementation-report.md` + `<raiz>/<slug>/plan/tasks-classification.md` + `<raiz>/<slug>/plan/waves.md` + `<raiz>/<slug>/contracts/`, onde `<raiz>` e `.orchestrator/runs` ou, na ausencia dela, `.orchestration`.
5. Para rastreabilidade, siga `upstream` ate o `handoff.json` do Pensador (raiz de `.pensador/<slug>-vN/`) e use o `prd`/`api-contract`/`communication-contract` como baseline de referencia do review; use `design-system-files` como criterio visual dos ajustes de front-end.
6. Registre as fontes em `plano_predefinido_fonte` e `plano_predefinido` no `.executor/checkpoint.json`.

---

## 8. Regras de confianca e versao

- O consumidor **confia** nos artefatos `DONE` do produtor sem reimplementar o trabalho dele.
- `handoffVersion` diferente da suportada: avise o usuario e degrade para descoberta por convencao.
- O produtor nunca escreve dentro da raiz de outro estagio.
- O consumidor nunca edita artefatos do produtor; ele referencia e produz os seus.
- Quando `status: BLOCKED` no upstream, o consumidor para e pede decisao do usuario antes de prosseguir.
- Este arquivo e a fonte da verdade do handoff e deve permanecer **byte-identico** nos quatro plugins.

## 9. Validacao estrutural (`validate-handoff.mjs`)

O envelope descrito nas secoes 4-5 tem um schema formal (`assets/handoff.schema.json`) e um validador executavel (`scripts/lib/handoff-validator.mjs`, exporta `validateHandoff(handoff)` — colige todas as violacoes numa passada, incluindo `artifacts[].role` fora do vocabulario da `stage` declarada, o modo de falha que este arquivo documentava sem nenhum codigo checar), presentes nos quatro plugins. Diferente deste arquivo (secao 8, byte-identico por exigencia), o schema e o validador **nao** sao byte-identicos entre plugins: cada `HANDOFF_ROLES_BY_STAGE` e coberto por teste proprio contra a tabela de secoes 4-5 deste contrato (garantindo equivalencia semantica), e o validador tem divergencias pontuais documentadas e intencionais por estagio (ex.: regra de `nextStage` do Executor, estagio terminal, difere da regra do Testador). Rode antes de gravar `status: "DONE"` (produtor) e antes de confiar num handoff descoberto (consumidor):

```bash
node "${CLAUDE_SKILL_DIR}/scripts/validate-handoff.mjs" --file <caminho/para/handoff.json>
```

Saida JSON `{ ok, file, errors[] }`; exit code 0 somente quando `ok: true`. Escopo: `handoffVersion: 1` (secao 4) — valida a forma estrutural do envelope (campos obrigatorios, enums de `stage`/`status`, vocabulario de `role` por `stage`, consistencia `upstream`/`nextStage`), nao invariantes de negocio do estagio produtor (essas continuam na state machine de cada plugin).


## 10. Extensao aditiva v1 — pacote visual resolvido

`handoffVersion: 1` permanece. Para um novo handoff visual, a entrada autoritativa e:

```json
{
  "role": "design-system-files",
  "path": "design-systems/<id>/resolved/",
  "required": true,
  "variant": "resolved",
  "authoritative": true,
  "sourcePath": "design-systems/<id>/original/",
  "materializeInto": "apps/web/styles/design-systems/<id>/",
  "assetsManifest": "assets/manifest.json",
  "validation": { "status": "PASS", "audit": "design-audit.json" }
}
```

O produtor preserva `original/` byte a byte e publica apenas `resolved/` como autoridade. O pacote resolvido contem `design-contract.json`, `tokens.css`, `design-tokens.json`, `DESIGN.md`, `components.html`, `preview/`, `assets/manifest.json`, `design-audit.json` e `provenance.json`. O consumidor carrega `design-contract.json`, `tokens.css`, `DESIGN.md` e `assets/manifest.json` como priority-files, copia assets conforme `materializeInto` e aplica `seedBindings`; nao gera imagens nem reabre decisoes visuais.

Entrada antiga sem `variant` e aceita como `legacy-verbatim`, com aviso de degradacao e gates visuais reforcados. Finding alto/critico, audit diferente de `PASS`, asset `required` ausente ou artefato obrigatorio descartado bloqueia dispatch e `DONE`.

Assets funcionais de iconografia sao vetoriais, com pacote/versao/uso no contrato; emoji nao substitui icone. Evidencia visual exige screenshot, assercao de navegador, rota, viewport, requisito e prova de API real — hash de commit sozinho nao e evidencia visual.
