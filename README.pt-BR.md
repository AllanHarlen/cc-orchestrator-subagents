![cc-orchestrador-subagents](banner.png)

# cc-orchestrador-subagents

Plugin de Claude Code para conduzir um workflow de desenvolvimento multiagente a partir de um PRD/especificação já pronta, com Codex, Antigravity/AGY e artefatos de auditoria.

**[Read in English](README.md)** — English version available.

## Visão geral

O `cc-orchestrador-subagents` organiza o desenvolvimento como um **sistema de engenharia multiagente persistente** para Claude CLI/Claude Code. O Claude atua como Orchestrador Principal sobre estado durável, memória comprovada, histórico pesquisável, worktrees, validação determinística, telemetria e aprendizado curado. Ele não faz discovery da demanda nem cria plano — atua exclusivamente em projetos com **PRD já montado ou especificações pré-estabelecidas**.

O usuário fornece a especificação via menção de arquivo (`@docs/prd.md`) ou envio do arquivo de PRD/spec. Esse documento é a **fonte da verdade**: o orquestrador o ingere, classifica as tasks, monta ondas, gera contratos, delega, monitora, integra e revisa.

Codex e Antigravity/AGY entram como subagentes especializados:

| Papel | Executor | Responsabilidade |
|---|---|---|
| Orchestrador de Harness | Claude CLI / Claude Code | Ingere o PRD/spec e coordena o workflow, contratos, ondas, validações, logs e decisões do usuário. |
| Implementação back-end, banco, testes e ajustes | Codex (despacho direto via `codex-companion.mjs`; fallback `codex:codex-rescue`) | Executa tasks não front-end com `--model <gpt-5.6-terra|gpt-5.6-sol|gpt-5.6-luna> --effort <low|medium|high> --write`, os dois derivados da task (papel: implement/review/fix — nunca um default fixo). |
| Implementação front-end e UX | Antigravity/AGY (`cc-antigravity-plugin:antigravity-coder`) | Executa tasks `FRONTEND_ONLY` e fatias front-end de `FULLSTACK`, consumindo tokens de design, protótipos de discovery (`prototypes/`) e ativos de marca reais (`assets/`). |
| Review back-end pós-implementação | Codex (despacho direto via `codex-companion.mjs`, sem `--write`; fallback `codex:codex-rescue`) | Revisa **apenas o back-end** com `--effort high` ou cai para review interno read-only do orquestrador quando faltar quota. |
| Review front-end pós-implementação | Antigravity/AGY (`cc-antigravity-plugin:antigravity-agent`, `--read-only --format json --model pro-high --effort high`) | Revisa **apenas o front-end** em modo read-only ou cai para review interno do orquestrador quando o AGY estiver indisponível. |

### Stack de agentes configurável

A tabela acima descreve a stack **padrão**. Qual agente de fato implementa/revisa cada papel é uma escolha por projeto, persistida em `.orchestrator/project-config.md` e resolvida na primeira run (ou a qualquer momento via `/orchestrator project-config`):

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/orchestrator-multi-agent-development/scripts/project-config.mjs" show --root "."
```

Quatro papéis — `backendExecutor`, `frontendExecutor`, `backendReviewer`, `frontendReviewer` — aceitam `codex`, `agy` ou `claude-code`. Definir um papel como `claude-code` roteia esse papel para um subagente do próprio Claude Code (pela ferramenta `Agent`), com review rodando somente leitura, gravado em `review/review-final.md`/`review/review-frontend.md`. **Com os quatro papéis em `claude-code`, o workflow inteiro roda sem Codex nem AGY instalados** — nenhuma CLI externa é exigida pelo preflight nesse caso. O preflight só exige a CLI/plugin de `codex`/`agy` quando algum papel de fato usa esse executor.

O preflight também detecta dois MCPs opcionais — o Codebase Memory MCP (`codebase-memory-mcp`, consultas ao grafo de código para análise de arquitetura/impacto) e o Context7 (documentação atualizada de bibliotecas nos prompts dos subagentes). A ausência de qualquer um vira item em `warnings`, nunca bloqueio; ver `skills/orchestrator-multi-agent-development/references/mcp-context.md`.

Esse check agregado só prova que o servidor está registrado *em algum lugar* da máquina — não que o Codex ou o AGY especificamente o têm. Rode `node scripts/preflight.mjs --check-agent-mcp` para também consultar `codex mcp list --json`/`agy mcp list` ao vivo e obter `checks.optional.mcpPerAgent.<agent>.<servidor>`, com um campo `install` trazendo o comando exato de `mcp add` para registrar naquele agente. Nada instala sozinho: o orquestrador só roda isso depois que o usuário aprova via `AskUserQuestion`, o mesmo padrão do instalador do Open Design.

### Workflow completo

- **Fase 0 - Preflight, configuração do projeto e instalação assistida:** valida dependências, Node.js 22.13+, `node:sqlite`/FTS5, permissão `Bash(node:*)`, resolve a Project_Config (papéis acima), detecta os dois MCPs opcionais e oferece instalar qualquer dependência ausente que os papéis resolvidos realmente exigem.
- **Fase 1 - Memória + especificação:** audita `.orchestrator/project-memory.md`, projeta o histórico FTS5 e lê o PRD/spec como fonte da verdade; ingere artefatos visuais do Pensador (`tokens.css`, `prototypes/`, `assets/`); somente fatos comprovados complementam o contexto.
- **Fase 2 - Classificação das tasks:** gera categoria, dependências, complexidade, contrato, `expectedFiles`/`validationPlan`, `allowedPaths`, agente e features de routing.
- **Fase 3 - Ondas, routing e isolamento:** aplica pisos heurísticos, consulta evidência histórica quando suficiente, valida roteamento e separa worktrees isoladas de tasks serializadas por overlap.
- **Fase 4 - Contratos API/UI e materialização visual:** cria e valida deterministicamente contratos, wire format, casing, exemplos, estados e permissões para toda troca front-back, materializa o pacote visual autoritativo (`design-materialization.json`) e gera contratos fortemente tipados via `generate-contract-types.mjs`.
- **Fase 5 - Delegação paralela:** cria worktrees elegíveis, adquire leases e envia tasks conforme `plan/waves.md`; Codex e AGY recebem, cada um, o modelo explicável selecionado, com o AGY recebendo os protótipos de descoberta como spec visual imperativa.
- **Fase 6 - Lifecycle Manager:** consulta adapters, persiste retornos antes de consumir, renova heartbeat/lease por atividade observável e trata stall/grace/interrupt/retry/cancel sem presumir resultado.
- **Fase 7 - Integração:** executa Early Stack Boot (`smoke-test-infra.mjs`) na Wave 1 para validação rápida de infra em 2 minutos, roda Wave Quality Gates (`run-wave-gate.mjs`) entre ondas sem tokens LLM, e integra worktrees serialmente usando scripts determinísticos para diff, escopo, API/UI, wire format e validação.
- **Fase 8 - Review back-end pós-implementação:** delega review final read-only ao Codex com `--effort high`, **somente do back-end**, e salva `review/review-final.md`. Se Codex ficar sem quota, o próprio Orchestrador faz review interno. Ignorada se não houver back-end.
- **Fase 9 - Review front-end pós-implementação:** delega review final read-only ao AGY com `--read-only --format json --model pro-high --effort high`, **somente do front-end**, validando critérios de aceite, conformidade com o design system e fidelidade aos protótipos visuais de `prototypes/`, e salva `review/review-frontend.md`. Se o AGY estiver indisponível, o Orchestrador faz review interno. **Ignorada se não houver task front-end.**
- **Fase 9.5 - E2E no navegador:** obrigatória sempre que a run tem front-end. Dirige os fluxos críticos em navegador real e verifica CORS, resolução de tenant/host, casing de resposta, estado da UI e o efeito final visível ao usuário. Topologia de mesma origem dispensa o gate por waiver explícito, com motivo registrado — nunca por derivação silenciosa.
- **Fase 10 - Relatórios finais:** cria `report/workflow-log.md`, `report/subagents-context.md` e `report/implementation-report.md`, gerando a matriz de rastreabilidade da Seção 13 deterministicamente via `build-traceability-matrix.mjs`, consolidando timeline, contratos, validações, subagentes, Conversation IDs do AGY e status de entrega.
- **Fase 11 - Entrega durável:** prepara e persiste o resumo/instruções, sem anunciar sucesso antes dos gates finais.
- **Fase 12 - Learning e fechamento:** cria `learning/learning-report.md` e candidate lessons sem promoção automática, projeta history/telemetry, exige `audit.complete`, fecha/verifica a run e só então publica a entrega.

Os artefatos de coordenação e relatórios finais ficam em `.orchestrator/runs/<nome>/` (runs criadas antes desta versão continuam em `.orchestration/<nome>/`, ainda lidas mas nunca migradas).

### Regras operacionais principais

- **Premissa de uso:** o orquestrador só atua com PRD/spec já pronta. Ele não faz discovery, não cria plano e não reinterpreta a demanda.
- **Codex revisa apenas back-end;** AGY (`pro-high`) revisa apenas front-end.
- **Fan-out AGY:** `--parallel` e `--subagent-model` ativam subagentes Gemini nativos dentro da task AGY. Requer `cc-antigravity-plugin >= 4.0.0`.
- **Modelo AGY:** override do usuário e piso heurístico são soberanos; histórico comparável só pode escalar com amostra mínima e `agyModelEvidence`. O review usa sempre `pro-high`.
- **Memória comprovada:** somente fontes `FILE`, `CONTRACT`, `TEST` aprovado, `RUN_EVENT` e `USER` entram na Project Memory; conflitos/stale são excluídos.
- **Código para mecânica:** três ou mais reads/greps, loops e comparações repetitivas usam `scripts/intelligence`, com JSON compacto e evidence ID.
- **Isolamento físico:** scope sem overlap pode usar worktree por task; overlap ou scope desconhecido serializa a wave.
- **Telemetria privacy-first:** somente metadados allowlisted são persistidos/exportados; prompt, conteúdo, diff, source, raw output e secrets são recusados.
- **Learning controlado:** a Fase 12 cria candidatos; validação independente precede Recipe, e o Curator oferece pin/archive/backup/rollback sem auto-delete.
- **Prompts & Esforço do Codex:** `--effort` é derivado da complexidade/risco da task (`low`/`medium` para CRUDs/tasks isoladas; `high` reservado para arquitetura central e reviews).
- **Auto-verificação Local Obrigatória:** subagentes devem executar build/typecheck/testes locais em sua worktree/workspace (`<BUILD_CMD>` e `<TEST_CMD>`) com exit code 0 antes de retornar `Status: DONE`.
- **Contratos obrigatórios:** qualquer troca front-back exige contrato antes de paralelizar.
- **Wire format:** todo contrato precisa explicitar casing JSON, nomes de campos, exemplos completos e validação de serialização real.
- **Roteamento por categoria:** `FRONTEND_ONLY` fica com Antigravity/AGY, inclusive setup front-end; Codex só assume front-end como fallback operacional registrado.
- **Quota do Codex & Fallback de Back-End:** em caso de esgotamento de quota no Codex (`QUOTA_EXHAUSTED`), o fallback de implementação de back-end delega exclusivamente para o AGY com modelos Gemini (`gemini-3.8-flash-medium` para CRUDs/tarefas isoladas e `gemini-3.8-flash-high` para arquitetura/segurança), sendo estritamente proibido delegar para modelos Claude; falta de quota em review back-end aciona review interno read-only do Orchestrador.
- **Sandbox Codex:** rede externa bloqueada para pacotes/restore, pacote ausente no cache local ou escrita fora do working directory permitido viram `BLOCKED` com evidência.
- **Limite AGY no Windows:** prompts AGY acima de 28.000 chars são divididos em subtasks por entregáveis antes da delegação para evitar `ENAMETOOLONG`.

## Instalação

Local:

```text
/plugin marketplace add "C:\Users\allan\Desktop\Projetos Pessoais\cc-plugins-allan\cc-orchestrador-subagents"
/plugin install cc-orchestrador-subagents@cc-orchestrador-subagents
```

GitHub:

```text
/plugin marketplace add AllanHarlen/cc-orchestrador-subagents
/plugin install cc-orchestrador-subagents@cc-orchestrador-subagents
```

Validar:

```text
/orchestrator preflight
```

Veja "Dependências oficiais" abaixo para as CLIs/plugins opcionais do Codex/AGY, exigidos apenas pelos papéis que você configurar.

## Dependências oficiais

O runtime mínimo é **Node.js 22.13.0**, no qual `node:sqlite` está disponível sem a flag experimental de CLI, além de SQLite FTS5. O preflight bloqueia a execução quando essa capacidade não existe, **independente da configuração de stack**, porque `knowledge.db`, `history.db`, Recipes e routing adaptativo dependem dela.

As dependências de Codex e Antigravity/AGY abaixo só são exigidas quando o papel correspondente da Project_Config (`backendExecutor`, `frontendExecutor`, `backendReviewer`, `frontendReviewer`) está de fato configurado como `codex`/`agy` — ver "Stack de agentes configurável" acima. Um projeto com todos os papéis em `claude-code` não precisa de nenhuma das duas.

`/orchestrator project-config` já oferece instalar tanto a CLI quanto o plugin do Claude Code abaixo pelo Dependency_Installer assistido — uma confirmação por dependência, sem passo manual. CLI e plugin são verificados (e instalados) de forma independente: ter um não implica ter o outro. Os passos manuais abaixo continuam válidos para quem preferir instalar à mão.

Este plugin depende do Codex plugin oficial para Claude Code: https://github.com/openai/codex-plugin-cc.

```text
/plugin marketplace add openai/codex-plugin-cc
/plugin install codex@openai-codex
/reload-plugins
/codex:setup
```

O marketplace/dependency usado nos manifests é `openai-codex`. O orquestrador despacha direto para ele via `codex-companion.mjs` (path resolvido em `checks.plugins["openai-codex"].companionPath`, publicado por `scripts/preflight.mjs`); o subagente `codex:codex-rescue` é um fallback documentado para quando esse path não resolve.

Para front-end, o orquestrador exige `cc-antigravity-plugin >= 4.0.0` e AGY `>= 1.1.8` (`1.1.16` recomendado), com estes arquivos presentes no plugin instalado:

- `agents/antigravity-coder.md` (implementação)
- `agents/antigravity-agent.md` (review read-only)
- `commands/antigravity.md`
- `scripts/antigravity-bridge.js`

## Como fornecer a especificação

O orquestrador não inventa a demanda. Forneça o PRD/spec de uma destas formas:

```text
# Menção de arquivo
/orchestrator @docs/prd-reservas.md

# Spec colada direto no argumento
/orchestrator "Implemente o fluxo de reservas conforme: <cole aqui a especificação completa>"

# Com override de modelo AGY
/orchestrator --model pro-low @docs/prd-reservas.md

# Em português (alias)
/orquestrador @docs/prd-reservas.md
```

Se nenhum PRD/spec for fornecido, o orquestrador pede a especificação antes de continuar.

## Estado persistente e retomada

Cada run possui uma state machine durável em `.orchestrator/runs/<nome>/` (ou `.orchestration/<nome>/` para uma run criada antes desta versão):

- `state.json` é o snapshot materializado atual;
- `events.jsonl` é o histórico append-only, escrito antes do snapshot e usado para reconstruí-lo após um crash.

Retome a run ativa mais recente ou selecione uma por `runId`/slug:

```text
/orchestrator resume
/orchestrator resume reservas-20260817-001
```

Na retomada, toda task deixada como `RUNNING` passa primeiro para `UNKNOWN`. O orquestrador então reconcilia o status do executor, Git, arquivos produzidos e evidências de validação. Mudanças locais isoladas nunca significam sucesso, e uma task desconhecida nunca é reexecutada às cegas.

A CLI determinística de estado também pode ser usada para inspeção e integridade:

```bash
node scripts/orchestration-state.mjs status
node scripts/orchestration-state.mjs resume <runId>
node scripts/orchestration-state.mjs verify --dir .orchestrator/runs/<nome>
```

Uma run só vira `DONE` quando possui task não vazia, evidence plan, escopo resolvido, Fase 12 concluída, artefatos obrigatórios e completion gates com evidência. Runs terminais são imutáveis. Cancelamento interrompe/reconcilia executores antes de fechar.

O `browserE2E` é obrigatório sempre que a run tem front-end — inclusive numa run só de front-end contra uma API separada já existente, que é exatamente o caso para o qual a Fase 9.5 existe. Ele também é o único gate que aceita waiver de aplicabilidade: topologia de mesma origem precisa ser registrada como `N/A` explícito com motivo, nunca derivada da mistura de categorias das tasks.

## Memória, histórico, intelligence e learning

O contexto estável e a experiência acumulada ficam fora da pasta da run:

```text
.orchestrator/
  project-memory.md
  knowledge.db
  history.db
  telemetry.jsonl
  learned/
  backups/
```

Comandos principais:

```bash
node scripts/orchestrator-knowledge.mjs init
node scripts/intelligence/inspect-project.mjs --root . --persist-knowledge
node scripts/orchestrator-knowledge.mjs history-search "NU1301"
node scripts/orchestration-lifecycle.mjs help
node scripts/orchestration-worktree.mjs help
node scripts/orchestration-router.mjs report
node scripts/orchestration-telemetry.mjs report --detailed
node scripts/orchestration-learning.mjs curator-status
```

Também estão disponíveis no slash command: `/orchestrator knowledge status`, `knowledge search`, `knowledge pin`, `knowledge archive`, `knowledge curate`, `knowledge rollback`, `telemetry report` e `telemetry compact`. Operações de Curator/retention são dry-run sem `--apply`; OTLP é opt-in e metadata-only.

### Superfície completa do comando

| Subcomando | O que faz |
|---|---|
| `help` | imprime a sinopse, os subcomandos e as flags |
| `preflight` | valida dependências e encerra |
| `project-config` (alias `config`) | mostra/altera a stack de agentes do projeto e revalida |
| `status [runId]` | estado do run, read-only (sem `runId`, o mais recente) |
| `resume [runId]` | retoma o run sem presumir resultado de task interrompida |
| `knowledge <sub>` | `status`, `search`, `pin`, `archive`, `activate`, `curate`, `rollback`, `render`, `audit`, `backups`, `history-project` |
| `telemetry <sub>` | `report`, `compact`, `otlp-preview`, `otlp-export` |

`/orquestrador` é o alias em português e aceita exatamente a mesma superfície. A grafia anterior `/orchestrador` foi renomeada.

As flags são `--model`, `--parallel`, `--subagent-model`, `--effort` e `--timeout`. Os nomes antigos com prefixo `--agy-` (`--agy-model`, `--agy-parallel`, `--agy-subagent-model`, `--agy-effort`, `--agy-timeout`) continuam aceitos como aliases legados silenciosos, com comportamento idêntico.

A separação é deliberada: o LLM toma decisões novas; scripts determinísticos validam mecânica; history/Recipes recuperam decisões já comprovadas; Project Memory fornece contexto estável; Codex/AGY implementam.

### O que versionar

Toda run nova vive em `.orchestrator/runs/<nome>/`, ao lado de `project-config.md`, `worktrees/`, `history.db` e `knowledge.db` — uma unica raiz oculta para tudo que este plugin grava no seu projeto. (Runs criadas antes desta versão continuam em `.orchestration/<nome>/`, lidas mas nunca migradas; docs/scripts antigos que voce ainda tenha por ai podem referenciar esse caminho.)

**Padrão: gitignorar tudo.** `.orchestration/` e `.orchestrator/` inteiros ficam de fora do histórico do projeto alvo por padrão — a mesma convenção que o `cc-pensador` já usa para `.pensador/`:

```gitignore
.orchestration/
.orchestrator/
```

Isso inverte deliberadamente o comportamento anterior, que versionava `events.jsonl`, os artefatos Markdown/handoff da run, `project-memory.md`, `learned/` e `knowledge.db`. Versionar esse estado tem uma consequência séria: apagar essas pastas do disco não as remove do Git — `git status` só marca como deletado-mas-rastreado, e o próximo commit comum do próprio orquestrador que reescrever `state.json`/`events.jsonl` nesses caminhos (o que qualquer run faz normalmente) ressuscita o conteúdo antigo. Se voce quiser o comportamento antigo de volta (resume/auditoria entre máquinas via Git), use o bloco estreito abaixo em vez do de cima, e aceite o risco que ele reintroduz — worktree versionada ou removida por `git clean -fdx` quebra uma wave em execução, e o SQLite em WAL gera conflito binário a cada commit concorrente:

```gitignore
.orchestrator/worktrees/
.orchestrator/backups/
.orchestrator/history.db
.orchestrator/telemetry.jsonl
*.db-wal
*.db-shm
```

Inverter o padrão não desfaz o histórico que um projeto já commitou — isso exige um `git rm --cached -r .orchestration .orchestrator` num commit dedicado; o orquestrador não automatiza essa migração. A tabela completa por caminho (para o caso de opt-in) está em `references/persistent-state.md`.

## Codex: modelo e effort

O workflow não fixa modelos Codex como `gpt-5.4` ou `gpt-5.5`.

Use:

- despacho direto via `codex-companion.mjs` com `--effort medium --write` para implementação, handoff e ajustes;
- despacho direto via `codex-companion.mjs` com `--effort high`, **sem `--write`**, para review back-end pós-implementação — omitir a flag é o que torna o review read-only, não uma instrução de prompt;
- `codex:codex-rescue` é o subagente de fallback quando `companionPath` não resolve.

O modelo fica no padrão disponível na conta do usuário. Codex nunca revisa front-end.

## Codex: limites de sandbox

Quando o Codex estiver em ambiente sandboxado, trate como bloqueio operacional:

- falha de rede externa para pacotes, restore ou registries, como `NU1301` ao acessar `https://api.nuget.org/v3/index.json`;
- pacote necessário ausente do cache local;
- `UnauthorizedAccessException` ou erro equivalente ao tentar criar/editar arquivos fora do working directory permitido.

Nesses casos o subagente deve parar, registrar evidência e retornar `Status: BLOCKED`, sem insistir em retries longos nem tentar contornar o sandbox. Há uma exceção limitada: quando o registry já esteve acessível e apenas `dotnet restore` falha por TLS/SSL/autenticação do pacote de segurança, o Orquestrador executa uma única vez o mesmo restore no workspace da task, salva o handoff e devolve o resultado ao Codex. Ele não altera certificados, proxy, VPN, credenciais, `NuGet.Config` nem instala/adiciona pacotes; falha nessa tentativa permanece `BLOCKED`.

## Roteamento de front-end

O agente é escolhido pela categoria da task, não pela aparência do trabalho. Se a task for `FRONTEND_ONLY`, use `cc-antigravity-plugin:antigravity-coder` mesmo quando ela for setup Vite/React, React routing ou outra infraestrutura front-end. `antigravity-agent` permanece read-only e reservado para o review da Fase 9 — o `validate-routing.mjs` reprova a wave quando uma task de implementação aponta para ele.

Codex só deve receber front-end como fallback operacional registrado depois de `QUOTA_EXAUSTED`, `AUTH_REQUIRED`, `AGY_MISSING`, `TIMEOUT`, falha de ferramenta/escrita do AGY ou decisão explícita.

## AGY: delegação front-end

Tasks de front-end são direcionadas ao Antigravity/AGY por categoria. Implementação usa `--mode accept-edits --format stream-json --model <agyModel>`; o bridge resolve aliases pelo catálogo runtime e nunca edita configurações do usuário.

Política padrão (implementação):

- `flash-medium` para a maioria das tasks;
- `pro-low` para tasks complexas, multi-rota, multi-arquivo, com contrato API/UI delicado ou risco alto de regressão;
- `pro-high` apenas em casos críticos;
- override manual disponível em `/orchestrator --model <modelo> <demanda>`.

Sem override, essa política define o **piso**. O router adaptativo pode escalar quando há amostra comparável suficiente por tipo/complexidade, usando first-pass success, review failures, regressões, duração e intervalo Wilson. Ele nunca rebaixa o piso, nunca explora aleatoriamente tasks críticas e registra a decisão em `agyModelEvidence`.

O **review front-end (Fase 9)** usa sempre `--read-only --format json --model pro-high --effort high`, independentemente do `agyModel` de implementação.

## AGY: fan-out nativo de subagentes Gemini

Quando uma task front-end produz dois ou mais entregáveis independentes (ex.: três componentes React, dois relatórios HTML), o orquestrador pode acionar o fan-out nativo do AGY via `DefineSubagent` dentro do prompt.

O mecanismo é puramente intra-task: continua sendo 1 task = 1 delegação AGY; `run/monitoring.md`, contratos e `validate-routing.mjs` ficam intactos.

### Flags novas

| Flag | Comportamento |
|---|---|
| `--parallel` | Força fan-out em todas as tasks AGY da execução. O AGY decide a contagem. |
| `--subagent-model <modelo>` | Modelo dos subagentes Gemini. Implica `--parallel`. Default: `inherit` (herda `agyModel`). |
| `--effort <low|medium|high>` | Override opcional de effort na implementação; o review permanece em `high`. |
| `--timeout <duração>` | Timeout de silêncio de toda delegação AGY, inclusive review, como `300s` ou `5m`. |

### Exemplos

```text
# Fan-out forçado pelo usuário
/orchestrator --parallel "Crie três componentes React independentes: Header, Sidebar e Footer"

# Planejador Pro coordenando subagentes Flash
/orchestrator --model pro-low --subagent-model flash-medium \
  "Gere dois relatórios HTML: impostos em carros elétricos e em carros a combustão"

# Heurística automática (orquestrador decide)
/orchestrator "Crie Header, Sidebar e Footer como componentes separados em src/components/"
```

### Quando o fan-out é usado por heurística

O orquestrador liga `--parallel` automaticamente quando uma task `FRONTEND_ONLY` (ou fatia front-end de `FULLSTACK`) lista dois ou mais entregáveis independentes nos critérios de aceite — e a lógica da task não é compartilhada entre eles.

Entregáveis dependentes ou que compartilham estado permanecem no subagente AGY único, sem `--parallel`.

### Campos novos em `plan/tasks-classification.md` e `plan/waves.md` (tasks AGY)

- `agyParallel: yes|no`
- `agyParallelSource: user|heuristic`
- `agySubagentModel: <modelo>|inherit`

Aliases estáveis usados pela heurística e pelo routing adaptativo:

| Modelo | Tier |
|---|---|
| `flash-low` | Flash |
| `flash-medium` | Flash |
| `flash-high` | Flash |
| `pro-low` | Pro |
| `pro-high` | Pro |
| `auto` | — |

Overrides do usuário também podem usar um slug dinâmico seguro. O bridge o valida contra `agy models`; o histórico de routing continua agrupado pelo alias estável solicitado.

## Preflight e auto-remediação

Rode:

```bash
node scripts/preflight.mjs --check-agent-mcp   # caminho padrao (Fase 0 de SKILL.md/workflow.md); tambem consulta codex/agy ao vivo
node scripts/preflight.mjs                     # sem o bloco optional.mcpPerAgent; so se quiser pular o custo do subprocesso
```

O JSON inclui:

- `status`
- `checks`
- `failed`
- `remediation`
- `autoRemediation`

O `preflight` valida:

- versão do `agy` encontrada no PATH;
- Codex CLI no PATH;
- `cc-antigravity-plugin >= 4.0.0` e plugin `openai-codex`;
- presença de `agents/antigravity-coder.md`, `agents/antigravity-agent.md`, `commands/antigravity.md` e `scripts/antigravity-bridge.js` no plugin AGY instalado;
- permissão `Bash(node:*)` para o companion do Codex.

> A partir da versão 3.0.0, o preflight não exige mais OpenSpec CLI nem skills `openspec-*` — o orquestrador não aciona o OpenSpec por conta própria. Ele continua podendo ingerir, em modo conjunto, um handoff do Pensador com artefato de role `openspec-change` (ver `references/workflow.md` e `references/handoff-contract.md`); essa ingestão nunca depende do CLI do OpenSpec estar instalado.

### Escopo da auto-remediação

Só existe auto-correção para `codex-companion-bash`:

- se `.claude/settings.json` não existir, ele pode ser criado;
- se existir com JSON válido, `permissions.allow` recebe `Bash(node:*)`;
- se existir com JSON inválido, o arquivo não é sobrescrito.

Exemplo de baseline mínimo:

```json
{
  "permissions": {
    "allow": [
      "Bash(node:*)"
    ]
  }
}
```

## Orçamento de prompt AGY — indicativo, não é limitação de CLI

O CLI do AGY é invocado via `child_process` pelo bridge do plugin. No Windows, o Node.js passava o prompt via argv com quoting automático (cada `"` vira `\"`, cada `\` se duplica), o que antes quebrava perto de ~29.140 chars reais (`ENAMETOOLONG`).

Desde o cc-antigravity-plugin **4.4.0**, esse teto deixou de valer: o bridge faz stream do prompt final para o AGY via stdin sempre que ele excede o tamanho seguro de argv da plataforma (8.191 chars no Windows, 100.000 nas demais), então o dispatch headless nunca mais descarta contexto inline por tamanho. Um pacote de design system entregue ao bridge via `--design-system <dir>` vai na íntegra, independente do tamanho, fora desse orçamento por completo.

O `check-prompt-budget.mjs` continua medindo o corpo da task persistido contra um **orçamento indicativo de 24.000 chars** (`advisory: true` para qualquer agente, nunca bloqueia). Ele continua útil como sinal de qualidade — um corpo de task tão grande costuma indicar trabalho mal recortado — mas um `ok: false` não exige mais divisão antes do dispatch. Quando a checagem sinaliza uma task e ela realmente se beneficia de divisão:

1. Divide os entregáveis da task em dois grupos independentes (A e B).
2. Cria subtasks `<ID>-a` e `<ID>-b`, cada uma cobrindo um grupo.
3. Atualiza `plan/tasks-classification.md` e `plan/waves.md`.
4. Remonta os dois prompts e confirma que cada um está abaixo do orçamento.
5. Registra a divisão em `run/monitoring.md` e `report/workflow-log.md` com o tamanho original e o motivo.

Se a task for monolítica e indivisível por entregáveis, o orquestrador reduz `Arquivos e módulos relevantes` ao essencial e, como último recurso, registra `promptOverflow: true` como nota de qualidade em `plan/tasks-classification.md` — não há mais decisão de usuário a pedir aqui, já que o dispatch não é bloqueado.

## Política de quota

### Codex em implementação, ajuste ou handoff

Se houver `QUOTA_EXHAUSTED`:

- delegar o fallback de implementação de back-end exclusivamente para o AGY (`cc-antigravity-plugin:antigravity-coder`) com modelos Gemini:
  - `gemini-3.8-flash-medium` para tarefas pontuais/CRUDs, seeds e ajustes isolados;
  - `gemini-3.8-flash-high` para arquitetura, segurança ou refatorações complexas;
- proibir estritamente fallback para modelos Claude ou subagentes `claude-code`, preservando a cota da sessão principal;
- registrar motivo do fallback e evidência em `run/monitoring.md` e `report/workflow-log.md`.

### Codex em review back-end

Se houver `QUOTA_EXHAUSTED`:

- o orquestrador faz review interno read-only;
- salva o resultado em `review/review-final.md`;
- não edita código produtivo.

### AGY em review front-end

Se houver `QUOTA_EXAUSTED`, `AUTH_REQUIRED`, `AGY_MISSING` ou `TIMEOUT`:

- o orquestrador faz review interno read-only;
- salva o resultado em `review/review-frontend.md`;
- não edita código produtivo.

### Antigravity/AGY em implementação

Continua com fallback controlado para Codex apenas quando for seguro. O bridge do plugin retorna status cru:

- `QUOTA_EXAUSTED`
- `AUTH_REQUIRED`
- `TIMEOUT`
- `AGY_MISSING`

O orquestrador deve registrar esses valores como vierem do bridge.

## Contratos obrigatórios

Contrato é obrigatório sempre que houver troca de dados entre front-end e back-end.

Isso vale para:

- tasks `FULLSTACK`;
- pares dependentes `BACKEND_ONLY` + `FRONTEND_ONLY`.

Na Fase 2, cada task deve registrar `contractRequired: yes|no`.

Para tasks `FRONTEND_ONLY` e para a fatia front-end de `FULLSTACK`, registre também:

- `agyModel`
- `agyModelSource: user|heuristic|adaptive`
- `agyModelEvidence` quando a origem for `adaptive`

O validador de roteamento exige esses campos nas tasks AGY e falha se:

- uma task AGY não registrar `agyModel`;
- `agyModelSource` estiver ausente;
- `agyModelSource: adaptive` não tiver evidência auditável;
- uma decisão heurística/adaptativa usar slug dinâmico em vez de alias estável, ou um slug do usuário for sintaticamente inseguro;
- uma task de design system (`tokens.css`, `components.html`, `DESIGN.md`) usar modelo de tier baixo;
- `FRONTEND_ONLY` estiver apontando para Codex como agente primário;
- `FRONTEND_ONLY` ou `FULLSTACK` delegar implementação ao `antigravity-agent`, que é somente leitura, em vez do `antigravity-coder`.

O validador lê a mesma gramática de ID do State Engine (`T1`, `T12-A`, `BE-01`, `FE-001-B`, nunca sufixo de versão como `gemini-3.5`) e reconhece entradas de wave escritas como cabeçalho, linha de tabela ou item de lista.

Na Fase 4, o orquestrador cria `contracts/*.md` para todo item com `contractRequired: yes`.

## Wire format e serialização

Todo contrato deve documentar:

- casing JSON esperado;
- nomes exatos dos campos;
- exemplos completos de request e response;
- serializer global ou atributos de serialização quando houver;
- validação da serialização real contra o TypeScript consumidor.

Em especial para C# + TypeScript:

- DTO interno em `PascalCase` não basta;
- payload JSON esperado em `camelCase` precisa estar documentado;
- a compatibilidade deve ser validada no payload real, não apenas em tipos TypeScript.

## Arquivos principais

- `commands/orchestrator.md`
- `skills/orchestrator-multi-agent-development/SKILL.md`
- `skills/orchestrator-multi-agent-development/references/workflow.md`
- `skills/orchestrator-multi-agent-development/references/persistent-state.md`
- `skills/orchestrator-multi-agent-development/references/project-knowledge.md`
- `skills/orchestrator-multi-agent-development/references/programmatic-intelligence.md`
- `skills/orchestrator-multi-agent-development/references/lifecycle-telemetry.md`
- `skills/orchestrator-multi-agent-development/references/learning-curator.md`
- `skills/orchestrator-multi-agent-development/references/worktrees-routing.md`
- `skills/orchestrator-multi-agent-development/references/hermes-adaptation.md`
- `skills/orchestrator-multi-agent-development/references/agent-stack.md`
- `skills/orchestrator-multi-agent-development/references/subagent-prompts.md`
- `skills/orchestrator-multi-agent-development/references/contracts.md`
- `skills/orchestrator-multi-agent-development/assets/contract-template.md`
- `skills/orchestrator-multi-agent-development/assets/monitoring-template.md`
- `skills/orchestrator-multi-agent-development/assets/implementation-report-template.md`
- `skills/orchestrator-multi-agent-development/assets/orchestration-state.schema.json`
- `skills/orchestrator-multi-agent-development/assets/orchestration-event.schema.json`
- `skills/orchestrator-multi-agent-development/scripts/orchestration-state.mjs`
- `skills/orchestrator-multi-agent-development/scripts/orchestrator-knowledge.mjs`
- `skills/orchestrator-multi-agent-development/scripts/orchestration-lifecycle.mjs`
- `skills/orchestrator-multi-agent-development/scripts/orchestration-worktree.mjs`
- `skills/orchestrator-multi-agent-development/scripts/orchestration-router.mjs`
- `skills/orchestrator-multi-agent-development/scripts/orchestration-telemetry.mjs`
- `skills/orchestrator-multi-agent-development/scripts/orchestration-learning.mjs`
- `skills/orchestrator-multi-agent-development/scripts/lib/`
- `scripts/orchestration-state.mjs`
- `scripts/intelligence/`
- `tests/*.test.mjs`

## Validação recomendada

```bash
node --check skills/orchestrator-multi-agent-development/scripts/preflight.mjs
node --check skills/orchestrator-multi-agent-development/scripts/orchestration-state.mjs
node scripts/preflight.mjs
node skills/orchestrator-multi-agent-development/scripts/validate-routing.mjs .orchestrator/runs/<nome>
node --test tests/*.test.mjs
rg --line-number --fixed-strings -- 'QUOTA_EXAUSTED' README.md commands skills
rg --line-number --fixed-strings -- 'agyModelSource' README.md commands skills
rg --line-number --fixed-strings -- 'agyParallel' README.md commands skills
rg --line-number --fixed-strings -- 'pro-high' README.md commands skills
```
