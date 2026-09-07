# Configuração de stack do projeto

A stack de agentes não é constante. Os quatro papéis abaixo formam a **Project_Config** do projeto e decidem quem implementa, quem revisa e quais CLIs são obrigatórias no preflight:

| Papel | Decide | Default |
|---|---|---|
| `backendExecutor` | tasks `BACKEND_ONLY`, `DATABASE_ONLY`, `DOCS_ONLY` e a fatia back-end de `FULLSTACK` | `codex` |
| `frontendExecutor` | tasks `FRONTEND_ONLY` e a fatia front-end de `FULLSTACK` | `agy` |
| `backendReviewer` | review back-end (`review/review-final.md`) e tasks `REVIEW_ONLY` | `codex` |
| `frontendReviewer` | review front-end (`review/review-frontend.md`) | `agy` |

Valores permitidos por papel: `codex`, `agy`, `claude-code`. A configuração é persistida em `.orchestrator/project-config.md` (arquivo Markdown versionável) e lida por `scripts/lib/project-config.mjs`, que é a fonte da verdade de perguntas, defaults, CLIs exigidas e roteamento derivado.

## Ordem da Fase 0

A coleta vem **antes** de qualquer oferta de instalação, e a instalação vem depois de a configuração estar resolvida. Numa Run nova sem arquivo de configuração isso produz até três preflights:

```text
0.1  preflight            -> projectConfig.source = default
0.5  configuração         -> AskUserQuestion x4 -> grava .orchestrator/project-config.md
0.5b preflight            -> projectConfig.source = file, Required_CLI_Set efetivo
0.6  instalação assistida -> uma pergunta por dependência ausente
0.6b preflight            -> novo status apresentado ao usuário
```

Se `.orchestrator/project-config.md` já existe e é válido, carregue a configuração e **não repita as quatro perguntas**; siga direto para a lista de dependências ausentes. Se o arquivo existe e é inválido, o preflight falha: apresente o erro do parser e a remediação de corrigir ou remover o arquivo, sem sobrescrevê-lo.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/project-config.mjs" show --root .
node "${CLAUDE_SKILL_DIR}/scripts/project-config.mjs" write --root . \
  --backend-executor codex --frontend-executor agy \
  --backend-reviewer codex --frontend-reviewer agy
```

## As quatro perguntas

Apresente nesta ordem, uma pergunta por papel, cada opção anunciando o papel do agente e a CLI que aquela escolha exige. Marque a opção default como recomendada.

### 1. `backendExecutor` — "Qual agente implementa as tasks de back-end?"

Executor das tasks `BACKEND_ONLY` e `DATABASE_ONLY` e da fatia back-end das tasks `FULLSTACK`.

| Opção | Default | CLI exigida | Descrição |
|---|---|---|---|
| `codex` | sim | `codex` | Codex implementa as tasks de back-end e de banco de dados. Exige a CLI `codex` instalada e autenticada. |
| `claude-code` | - | nenhuma | Claude Code implementa as tasks de back-end e de banco de dados. Não exige CLI externa: a execução vai para um subagente do próprio Claude Code. |

### 2. `frontendExecutor` — "Qual agente implementa as tasks de front-end?"

Executor das tasks `FRONTEND_ONLY` e da fatia front-end das tasks `FULLSTACK`.

| Opção | Default | CLI exigida | Descrição |
|---|---|---|---|
| `agy` | sim | `agy` | Antigravity (AGY) implementa as tasks de front-end. Exige a CLI `agy` instalada e autenticada. |
| `claude-code` | - | nenhuma | Claude Code implementa as tasks de front-end. Não exige CLI externa: a execução vai para um subagente do próprio Claude Code. |

### 3. `frontendReviewer` — "Qual agente faz o review de front-end?"

Revisor do resultado front-end, registrado em `review/review-frontend.md`.

| Opção | Default | CLI exigida | Descrição |
|---|---|---|---|
| `agy` | sim | `agy` | Antigravity (AGY) revisa o resultado front-end. Exige a CLI `agy` instalada e autenticada. |
| `codex` | - | `codex` | Codex revisa o resultado front-end. Exige a CLI `codex` instalada e autenticada. Sobrepõe a política padrão de review front-end pelo AGY. |
| `claude-code` | - | nenhuma | Claude Code revisa o resultado front-end. Não exige CLI externa: o review vai para um subagente do próprio Claude Code, em modo read-only. |

### 4. `backendReviewer` — "Qual agente faz o review de back-end?"

Revisor do resultado back-end, registrado em `review/review-final.md`.

| Opção | Default | CLI exigida | Descrição |
|---|---|---|---|
| `codex` | sim | `codex` | Codex revisa o resultado back-end. Exige a CLI `codex` instalada e autenticada. |
| `agy` | - | `agy` | Antigravity (AGY) revisa o resultado back-end. Exige a CLI `agy` instalada e autenticada. |
| `claude-code` | - | nenhuma | Claude Code revisa o resultado back-end. Não exige CLI externa: o review vai para um subagente do próprio Claude Code, em modo read-only. |

## Defaults e marca `default-aplicado`

Papel sem resposta — usuário encerrou a coleta, pulou a pergunta ou respondeu vazio — recebe o default da tabela de papéis e é registrado na seção `## Notas` do arquivo:

```markdown
## Notas

- frontendReviewer: default-aplicado
```

A marca é informativa e não altera roteamento: o papel vale como se tivesse sido escolhido. Nunca invente valor fora de `codex`/`agy`/`claude-code` e nunca deixe papel em branco no arquivo.

## Roteamento derivado

Categoria da task + Project_Config = Executor. Não use "parece infra" ou "o outro agente consegue" como critério.

| Categoria | Papel que decide | Executor |
|---|---|---|
| `BACKEND_ONLY` | `backendExecutor` | valor configurado |
| `DATABASE_ONLY` | `backendExecutor` | valor configurado |
| `DOCS_ONLY` | `backendExecutor` | valor configurado |
| `FRONTEND_ONLY` | `frontendExecutor` | valor configurado |
| `REVIEW_ONLY` | `backendReviewer` | valor configurado |
| `FULLSTACK` | `backendExecutor` + `frontendExecutor` | fatia back-end e fatia front-end |

Grave por task, em `plan/tasks-classification.md`, `plan/waves.md` e `state.json`:

```markdown
- executor: `claude-code`
- executorSource: `project-config`
```

Task com Executor `agy` continua registrando `agyModel`, `agyModelSource`, `agyParallel` e `agySubagentModel`. Task com Executor `codex` ou `claude-code` **não** registra nenhum desses campos — o validador de roteamento reprova o bloco se eles aparecerem.

Required_CLI_Set: `codex` é obrigatória se e somente se ao menos um dos quatro papéis é `codex`; `agy` é obrigatória se e somente se ao menos um papel é `agy`. Com os quatro papéis em `claude-code`, nenhuma CLI externa é obrigatória e o workflow roda inteiro sobre subagentes do Claude Code.

## Protocolo do Dependency_Installer

Depois que a Project_Config está resolvida e o preflight rodou com ela, monte a lista de dependências ausentes: CBM_MCP ausente, Context7_MCP ausente e, para cada CLI do Required_CLI_Set, a CLI (quando `checks.cli.*` reprova) seguida do plugin do Claude Code que a conecta (quando `checks.plugins.*` reprova). MCPs primeiro, depois CLI+plugin por CLI, na ordem `codex` antes de `agy`.

**A CLI sozinha não basta.** `codex` e `agy` são processos externos; é o plugin do Claude Code — `codex-plugin-cc` para `codex`, `cc-antigravity-plugin` para `agy` — que registra os agentes e comandos pelos quais o Orquestrador invoca aquele processo. As duas reprovações são **independentes**: um ambiente pode ter a CLI instalada e autenticada com o plugin ainda ausente (ou vice-versa), e o plano só oferece o que de fato está faltando — nunca assume que aprovar uma implica a outra.

**Uma pergunta `AskUserQuestion` por dependência**, com as opções `instalar` e `seguir sem instalar`. Nunca agrupe dependências numa pergunta só e nunca execute comando antes de o usuário responder `instalar` para aquela dependência.

Cada pergunta informa quatro coisas: nome da dependência, benefício, impacto de seguir sem ela e o comando que será executado.

| Dependência | Benefício | Impacto de seguir sem | Comando |
|---|---|---|---|
| `codebase-memory-mcp` (opcional) | consultas estruturais no grafo do repositório (arquitetura, quem chama o quê, impacto de diff) com custo de tokens muito menor | classificação, `expectedFiles`/`allowedPaths` e raio de impacto passam a depender da varredura determinística de `scripts/intelligence/` | Windows: baixar `install.ps1`, `Unblock-File .\install.ps1`, executar o script. macOS/Linux: `install.sh` publicado no repositório |
| `context7` (opcional) | documentação atual e versionada da biblioteca injetada no contexto antes de escrever código que a usa | o subagente segue apenas os padrões do projeto e a memória do modelo, com risco de API obsoleta | `npx ctx7 setup --claude` (alternativa: registrar manualmente a URL `https://mcp.context7.com/mcp`) |
| CLI `codex` (obrigatória quando algum papel é `codex`) | executor/revisor dos papéis configurados como `codex` | as tasks desses papéis ficam sem executor | `npm install -g @openai/codex` |
| plugin `openai-codex` (obrigatória junto com a CLI `codex`) | dá ao Claude Code os agentes/comandos para invocar o Codex | a CLI `codex` instalada não basta: o Claude Code não consegue delegar às tasks desses papéis | `/plugin marketplace add openai/codex-plugin-cc` seguido de `/plugin install codex@openai-codex` |
| CLI `agy` (obrigatória quando algum papel é `agy`) | executor/revisor dos papéis configurados como `agy` | as tasks desses papéis ficam sem executor | instalador oficial do Antigravity para o SO detectado |
| plugin `cc-antigravity-plugin` (obrigatória junto com a CLI `agy`) | dá ao Claude Code os agentes/comandos para invocar o Antigravity | a CLI `agy` instalada não basta: o Claude Code não consegue delegar às tasks desses papéis | `claude plugin install AllanHarlen/cc-antigravity-plugin` |

O catálogo canônico dos comandos por SO está em `scripts/lib/dependency-plan.mjs`; use `buildMissingDependencies(report, { platform })` em vez de reescrever comandos no prompt. `CLI_PLUGIN_KEY` do mesmo módulo é o mapeamento canônico `codex → openai-codex`, `agy → cc-antigravity-plugin` — as mesmas chaves que `checks.plugins` do preflight usa, para não haver tradução paralela.

Passos interativos ficam com o usuário, nunca na sequência automática:

- `codex login` exige execução interativa do usuário depois da instalação da CLI `codex`.
- A autenticação do AGY exige abrir `agy` uma vez, também em execução interativa.
- Comandos de plugin (`/plugin ...`, `claude plugin install ...`) rodam dentro de uma sessão do Claude Code, nunca em um shell externo — não tente executá-los via processo.
- Depois de instalar um MCP, o agente de código precisa ser reiniciado para carregar o servidor.

### Exit code diferente de zero

Se um comando de instalação termina com código diferente de zero:

1. registre o código de saída e a última linha de erro;
2. apresente a remediação manual (comando alternativo, instalação pelo pacote da release, docs oficiais);
3. pergunte ao usuário, por `AskUserQuestion`, se ele quer tentar novamente, seguir sem a dependência ou encerrar.

Não repita a instalação em loop, não tente comando não documentado e não prossiga para a próxima dependência sem a decisão do usuário.

### Recusa de CLI obrigatória

`seguir sem instalar` em dependência **opcional** (MCP): registre a limitação em `report/workflow-log.md` e prossiga com o workflow.

`seguir sem instalar` em CLI do **Required_CLI_Set**: o workflow não pode seguir como está. Ofereça por `AskUserQuestion`:

- **trocar o papel para `claude-code`** — nomeie os papéis afetados (`rolesByCli` do plano de dependências), regrave o Project_Config_File com os novos valores, rode o preflight novamente e siga; ou
- **encerrar o workflow** — nenhuma Run é inicializada e nenhum artefato de plano é gravado.

Nunca troque o papel por conta própria, e nunca prossiga com papel apontando para CLI ausente.

### Novo preflight após as instalações

Concluídos todos os comandos confirmados, rode o preflight uma vez e apresente ao usuário o novo `status`, o Required_CLI_Set efetivo, os itens reprovados e os avisos. Esse preflight é obrigatório mesmo que todas as instalações tenham retornado zero — é ele que confirma que a dependência ficou visível para o ambiente.

O mesmo protocolo vale quando o Config_Command troca a configuração: se o preflight disparado por `/orchestrator project-config` reprova uma CLI do Required_CLI_Set, acione o Dependency_Installer para essa CLI, com as mesmas perguntas e o mesmo tratamento de exit code.

## Registro em `report/workflow-log.md`

Registre na Fase 0 do log, em "Decisões do Orquestrador" e em "Validações e Evidências":

- a Project_Config efetiva, a origem (`file` ou `default`) e os papéis com `default-aplicado`;
- por dependência, exatamente `name`, `decision`, `command`, `exitCode` e `durationMs` (use `summarizeInstallOutcome`);
- cada limitação aceita: MCP recusado, MCP ausente por timeout, papel trocado para `claude-code` por recusa de CLI;
- o `status` de cada preflight executado na Fase 0.

Nunca registre stdout/stderr bruto do instalador, conteúdo de arquivo de configuração MCP, chave de API, token ou cabeçalho de autenticação. O Project_Config_File também não tem campo para credencial.

`frontendReviewer: codex` merece registro explícito: a escolha sobrepõe a política padrão de review front-end pelo AGY. Anote a sobreposição em `report/workflow-log.md` e **informe o usuário uma única vez por Run** — não repita o aviso a cada task ou a cada fase.

## Estabilidade durante a Run

A configuração é congelada no início da Run: `initRun` grava em `state.json` o snapshot `projectConfig` com `schemaVersion`, `source`, `updatedAt` e os quatro papéis. Nenhuma task despachada muda de Executor no meio do caminho.

No `resume`, compare o snapshot com o arquivo atual (`projectConfigDrift`):

- **sem diferença** (ou Run antiga sem snapshot, `source: "legacy"`): siga o workflow;
- **com diferença**: apresente a diferença papel a papel (`from` → `to`) e pergunte por `AskUserQuestion` se o usuário quer **manter o snapshot da Run** ou **adotar a configuração atual**. Não escolha sozinho.

Se o usuário adota a configuração atual:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-state.mjs" project-config-apply \
  --dir ".orchestrator/runs/<slug>" --scope pending
```

A nova configuração vale **apenas para tasks ainda não despachadas** (`status: PENDING`, `attempt: 0`). A operação atualiza o snapshot e emite `PROJECT_CONFIG_UPDATED` com `differences`, `appliedTaskIds`, `skippedTaskIds` e o motivo da mudança. Task já despachada mantém o Executor do dispatch, e é esse Executor que a reconciliação e a telemetria usam.

Trocar a configuração não é rota de fuga para falha operacional: `QUOTA_EXHAUSTED`, `AUTH_REQUIRED` e `TIMEOUT` continuam sendo bloqueio com evidência e decisão do usuário.
