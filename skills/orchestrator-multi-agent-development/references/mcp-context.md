# Contexto por MCP: grafo de código e documentação atual

Dois MCPs opcionais alimentam o contexto do Orquestrador. Nenhum dos dois bloqueia o workflow: ausência é aviso no preflight, e o workflow segue pelo caminho determinístico.

| MCP | Check do preflight | O que entrega | Caminho quando ausente |
|---|---|---|---|
| CBM_MCP (`codebase-memory-mcp`) | `checks.optional.mcp.codebase-memory.ok` | grafo persistente do repositório: arquitetura, quem chama o quê, impacto de diff | scripts determinísticos de `scripts/intelligence/` |
| Context7_MCP (`context7`) | `checks.optional.mcp.context7.ok` | documentação atual e versionada de biblioteca, framework, SDK, API ou serviço de nuvem | padrões já presentes no projeto |

Regra que vale para os dois: **resultado de MCP é evidência corroborativa**. Nunca marque requisito como atendido, contrato como cumprido ou task como `DONE` apoiado apenas em resposta de MCP. Só leitura de arquivo, contrato, review ou validação determinística fecham um requisito.

A detecção é feita por `scripts/lib/mcp-detect.mjs` e publicada pelo preflight. Antes de usar qualquer MCP nesta referência, leia o check correspondente do relatório: `ok: false` com `reason: "NOT_DETECTED"` ou `"TIMEOUT"` significa que o MCP não está disponível nesta Run, mesmo que o usuário afirme tê-lo instalado. Se o usuário instalou durante a Fase 0, o agente de código precisa ser reiniciado para carregar o servidor — o novo preflight é que confirma.

### `checks.optional.mcp` é agregado por arquivo; `checks.optional.mcpPerAgent` é por agente e ao vivo

`checks.optional.mcp.<servidor>.ok` vem de uma varredura de arquivo (`.claude.json`, `.codex/config.toml`, `.gemini/...`, entre outros) que **não distingue** para qual CLI o MCP está de fato registrado — `ok: true` pode significar só que o Claude Code local tem o servidor, sem que Codex ou AGY o tenham. Antes de prometer a ferramenta no prompt de um subagente Codex ou AGY, prefira `checks.optional.mcpPerAgent.<agent>.<servidor>`, obtido rodando `codex mcp list --json`/`agy mcp list` de verdade (ver `scripts/lib/mcp-agent-cli.mjs`). O caminho padrão da Fase 0 (`SKILL.md` 0.1, `references/workflow.md` Fase 0) já roda o preflight com `--check-agent-mcp`, então esse bloco normalmente existe no relatório; ele só falta quando alguém invocou `preflight.mjs` sem a flag deliberadamente — nesse caso caia para o agregado abaixo.

```text
antes de incluir o bloco de contexto do grafo/Context7 no prompt de uma task Codex/AGY:
  se checks.optional.mcpPerAgent existir:
    usar checks.optional.mcpPerAgent.<agent>.<servidor>.ok
      checked: true, ok: true  -> inclua o bloco
      checked: true, ok: false -> NAO inclua (servidor nao registrado/desabilitado nesse agente)
      checked: false           -> nao e prova de ausencia (binario inalcancavel, timeout, saida
                                   nao parseavel) -> caia para checks.optional.mcp.<servidor>.ok
  senao:
    usar checks.optional.mcp.<servidor>.ok (aggregate, mais fraco, mas e o unico sinal disponivel)
```

### Oferta de instalação por agente (mesmo padrão do Open Design)

Quando `checks.optional.mcpPerAgent.<agent>.<servidor>` chega com `checked: true, ok: false` — o CLI daquele agente respondeu de verdade e o servidor genuinamente não está registrado ali — o campo `install` traz o comando exato de registro (`mcp-agent-install.mjs`, confirmado ao vivo: `codex mcp add context7 --url https://mcp.context7.com/mcp`, `agy mcp add codebase-memory-mcp codebase-memory-mcp`, etc.). Isso **nunca** dispara sozinho. Siga o mesmo padrão do Open Design (`references/open-design.md`, seção Fallback): ofereça via `AskUserQuestion`.

```text
[Orquestrador | Fase 0/4] O <servidor> não está registrado no <agent>.
Registrar agora deixa a task usar a ferramenta em vez do fallback determinístico.

Opção A (recomendada): Registrar via `<comando de install>`
  O Orquestrador roda o comando de registro no CLI do <agent> e confirma com um novo check.

Opção B: Seguir sem registrar
  A task roda pelo caminho determinístico (grafo/documentação ausente para esse agente).
```

Se o usuário aprovar a Opção A: rode `installAgentMcp(agent, server)` de `mcp-agent-install.mjs` (nunca construa o comando à mão — use a função, que já é o argv confirmado ao vivo), depois **re-verifique** com `detectAgentMcpServers`/um novo `--check-agent-mcp` antes de prometer a ferramenta no prompt do subagente — não assuma sucesso só porque o comando não lançou erro. Registre a decisão e o resultado em `report/workflow-log.md`. Nunca chame `installAgentMcp` a partir do prompt de um subagente Codex/AGY: é o Orquestrador (este processo) que roda o comando, sempre depois da confirmação do usuário — o mesmo motivo pelo qual o Open Design nunca deixa o `antigravity-coder` disparar sua própria instalação (ver `references/open-design.md`).

⚠️ `installAgentMcp` **sobrescreve** um registro existente do mesmo nome (`mcp add` é "add or update", confirmado ao vivo no AGY). Só ofereça a Opção A quando `checked: true, ok: false` — nunca quando `ok: true` já, e nunca para "corrigir" uma configuração existente sem o usuário pedir explicitamente, para não substituir silenciosamente uma entrada que o usuário configurou com opções próprias (ex.: uma chave de API do Context7 já embutida no comando).

## Parte 1 — CBM_MCP: grafo de código

### Gate de índice antes de qualquer uso

Com `checks.optional.mcp.codebase-memory.ok` em `true`, a primeira chamada é sempre `index_status` para o projeto atual. Nenhum resultado do CBM_MCP entra em classificação, contrato, prompt ou artefato antes desse gate.

```text
index_status
  ├─ sem índice para este projeto
  │    -> AskUserQuestion: "Indexar o repositório agora?"
  │         instalar/indexar  -> index_repository na raiz do projeto -> segue
  │         seguir sem índice -> caminho determinístico + registro no workflow-log
  ├─ índice existente e sem pendência para os arquivos consultados  (Index_Fresh)
  │    -> grafo liberado para as consultas das fases abaixo
  └─ índice existente com reindexação pendente
       -> trate como não-Index_Fresh: use o grafo apenas como pista e confirme por leitura de arquivo
```

A oferta de `index_repository` acontece **antes da classificação de tasks** (Fase 2), porque é ali que o grafo paga o custo dele. Nunca dispare `index_repository` por conta própria: indexação varre o repositório inteiro e é decisão do usuário.

Use `list_projects` quando houver dúvida sobre qual projeto indexado corresponde à raiz atual, e guarde o `projectId` resolvido — ele é obrigatório na evidência de Project Memory.

### Protocolo por fase

| Fase | Ferramentas | Uso |
|---|---|---|
| 1 — Ingestão da especificação | `get_architecture`, `get_graph_schema` | compor o contexto de projeto carregado junto da especificação: camadas, módulos, pontos de entrada e o vocabulário de nós/arestas que as consultas seguintes vão usar |
| 2 — Classificação das tasks | `search_graph`, `trace_path`, `get_code_snippet` | derivar `expectedFiles` e `allowedPaths` por task: localizar o símbolo citado na especificação, traçar quem chama e quem é chamado, e ler o trecho exato antes de fixar o escopo |
| 4 — Contratos | `search_graph`, `get_code_snippet` | localizar DTO, endpoint e consumidor para montar o contrato; a comprovação de wire format e casing continua em `inspect-contract.mjs`/`inspect-api-ui.mjs`/`validate-wire-format.mjs` |
| 7 — Integração | `detect_changes` | mapear o diff aos símbolos afetados e ao raio de impacto, antes de decidir o alcance do review |

`get_architecture` e `get_graph_schema` na Fase 1 exigem Index_Fresh. `search_graph`, `trace_path` e `get_code_snippet` na Fase 2 exigem Index_Fresh. Sem Index_Fresh, essas fases seguem pelo caminho determinístico.

`detect_changes` na Fase 7 pode ser usado sempre que o CBM_MCP estiver disponível: ele é o único uso cujo insumo é o diff, não o índice histórico. Ainda assim, o resultado é pista sobre o raio de impacto — a prova mecânica do diff continua sendo `inspect-diff.mjs` e `validate-task-scope.mjs`.

### Limite de 30 s por consulta

Cada consulta ao CBM_MCP tem orçamento de **30 segundos**. Consulta que retorna erro ou estoura esse limite:

1. registre a falha (ferramenta, fase, motivo) em `report/workflow-log.md`;
2. siga pela alternativa determinística da fase;
3. prossiga com o workflow.

Não repita a mesma consulta em loop, não aumente o orçamento e não pare o workflow por falha de MCP. Duas falhas seguidas do mesmo servidor: trate o CBM_MCP como ausente pelo resto da Run e registre isso uma vez.

### Fallback determinístico

Com o CBM_MCP ausente — ou indisponível por timeout, erro ou recusa de indexação —, o caminho é o de sempre: os scripts de `scripts/intelligence/`, que continuam sendo obrigatórios quando o MCP falta e continuam sendo a prova quando o MCP está presente.

| Necessidade | Script determinístico |
|---|---|
| manifests, frameworks, comandos de validação | `inspect-project.mjs` |
| seções, placeholders, casing e gates do contrato | `inspect-contract.mjs` |
| DTO C# × tipos TypeScript | `inspect-api-ui.mjs` |
| estatísticas e riscos mecânicos do diff | `inspect-diff.mjs` |
| arquivos alterados × `allowedPaths` | `validate-task-scope.mjs` |
| payload × JSON Schema/exemplo de contrato | `validate-wire-format.mjs` |

```bash
node "${CLAUDE_SKILL_DIR}/scripts/inspect-project.mjs" --root . --persist-knowledge
node "${CLAUDE_SKILL_DIR}/scripts/inspect-diff.mjs" --root . --dir ".orchestrator/runs/<slug>" --task <ID> --base <commitBefore>
```

Registre em `report/workflow-log.md` a limitação: qual MCP faltou, em qual fase, e qual caminho determinístico foi usado no lugar. A regra operacional de intelligence (≥ 3 Greps/Reads, loop de arquivos ou comparação mecânica → script determinístico) vale igual com ou sem grafo; ver `references/programmatic-intelligence.md`.

### Lacuna de cobertura: leia o arquivo

Quando o CBM_MCP reporta lacuna de cobertura para um arquivo consultado — arquivo fora do índice, linguagem não suportada, parse parcial, resultado vazio para caminho que existe no disco —, **leia esse arquivo diretamente antes de afirmar ausência** de símbolo, chamada ou referência.

Grafo silencioso não é prova de inexistência. Nunca escreva "não existe consumidor deste endpoint", "nenhum teste cobre este módulo" ou "este símbolo não é referenciado" com base só em resultado vazio de consulta. Ou o grafo cobre o arquivo e responde, ou você lê o arquivo.

### Fato de projeto derivado do grafo

Fato registrado na Project Memory a partir do CBM_MCP usa a fonte `GRAPH`, com o `projectId` indexado e o timestamp da consulta:

```js
{
  sourceType: "GRAPH",
  sourceRef: "graph:<projectId>:trace_path",
  evidence: { projectId: "<id>", tool: "trace_path", queriedAt: "2026-02-14T18:07:02Z", resultDigest: "<sha256>" }
}
```

`GRAPH` **não se sustenta sozinho**: fato cuja única evidência é o grafo é rejeitado com `GRAPH_EVIDENCE_REQUIRES_CORROBORATION`. Acompanhe sempre de `FILE`, `CONTRACT`, `TEST` aprovado ou `RUN_EVENT`:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/orchestrator-knowledge.mjs" fact-add \
  --section Architecture --key AuthEntryPoint --value "src/Api/Auth/AuthController.cs" \
  --source-type GRAPH --source-ref "graph:<projectId>:search_graph"
node "${CLAUDE_SKILL_DIR}/scripts/orchestrator-knowledge.mjs" fact-add \
  --section Architecture --key AuthEntryPoint --value "src/Api/Auth/AuthController.cs" \
  --source-type FILE --source-ref src/Api/Auth/AuthController.cs
```

A auditoria não reidrata evidência `GRAPH` (não há arquivo para reler); é a corroboração obrigatória que mantém o fato auditável. As regras gerais de prova estão em `references/project-knowledge.md`.

### Instrução nos prompts de subagente

Ao delegar uma task com o CBM_MCP disponível, e quando o Executor daquela task tem acesso ao servidor, o prompt deve instruir **consulta de grafo antes de exploração arquivo-a-arquivo**. Bloco sugerido, encaixado na seção de contexto do template de `references/subagent-prompts.md`:

```text
Contexto de código por MCP (codebase-memory):
- Antes de varrer arquivos, use search_graph / trace_path / get_code_snippet para localizar
  o símbolo, quem o chama e quem ele chama.
- Grafo é pista, não prova: confirme por leitura do arquivo antes de alterar comportamento.
- Se o grafo não cobrir o arquivo, ou a consulta falhar, leia o arquivo diretamente.
- Fique dentro de allowedPaths mesmo que o grafo aponte para fora dele.
```

Executor sem acesso ao CBM_MCP não recebe esse bloco — instrução para ferramenta indisponível só gasta prompt e provoca tentativa falha. Quando o Executor é `claude-code`, o subagente herda os MCPs da sessão do Claude Code; para `codex` e `agy`, verifique a evidência de configuração daquele agente no check do preflight antes de prometer a ferramenta no prompt.

## Parte 2 — Context7_MCP: documentação atual

### Aviso ao usuário quando disponível

Com `checks.optional.mcp.context7.ok` em `true`, informe ao usuário, na Fase 0, que **documentação atual será exigida nos prompts dos subagentes**: toda task que envolva biblioteca, framework, SDK, API ou serviço de nuvem vai carregar a instrução de consultar a documentação antes de escrever código. Uma menção por Run é suficiente.

### Quando usar e quando NÃO usar (filtros de escopo)

- **Usar para:** sintaxe de APIs externas, assinaturas de métodos, configurações de libs/frameworks, CLIs de ferramentas e migrações de versão.
- **NÃO usar para:** lógica de negócio interna da aplicação, refatoração de código local do repositório, scripts utilitários simples sem bibliotecas ou code review geral.

### Resolver identificador antes de pedir documentação

A ordem é sempre a mesma, e não tem atalho:

```text
1. resolver o identificador da biblioteca (nome livre -> identificador do Context7)
2. pedir a documentação desse identificador (escopada a um único conceito)
3. escrever código que usa a biblioteca
```

1. **Pontuação oficial no nome:** Passe a biblioteca com pontuação e maiúsculas oficiais (ex.: `Next.js` em vez de `nextjs`, `ASP.NET Core` em vez de `aspnetcore`, `Three.js` em vez de `threejs`).
2. **Versão canônica no ID:** Se `resolve-library-id` listar `Versions` compatíveis com a versão fixada no projeto (`package.json`, `*.csproj`, lockfile), use diretamente o identificador versionado no formato `/org/project/version` (ex.: `/vercel/next.js/v14.2.0`). Documentação de major diferente é a causa mais comum de API inexistente em código gerado.
3. **Escopo atômico (Single-Concept Scoping):** Em `query-docs`, faça cada busca focada em um único conceito específico (ex.: "Fastify JWT cookie authentication plugin"). **Não misture** múltiplos tópicos na mesma consulta (ex.: "rotas, auth e banco no Fastify"), pois queries compostas diluem o ranking semântico e trazem respostas rasas.
4. **Limite de chamadas:** No máximo 3 consultas ao Context7 por tarefa. Se não resolver após 3 tentativas, adote a melhor resposta obtida ou caia para os padrões locais.

Nunca pule o passo 1, nem quando você "já sabe" o identificador de uma consulta anterior no mesmo projeto: nome de pacote e identificador do servidor não são a mesma coisa, e pedir documentação de identificador inventado devolve conteúdo errado ou vazio. Isso vale para consulta feita pelo Orquestrador e para consulta feita por subagente.

### Instrução nos prompts de subagente

Task que envolve biblioteca, framework, SDK, API ou serviço de nuvem, com o Context7_MCP disponível, recebe no prompt (ver template em `references/subagent-prompts.md`):

```text
Documentação atual por MCP (context7):
- Antes de escrever código que usa <biblioteca>, resolva o identificador dela usando o nome oficial pontuado (ex: 'Next.js').
- Se houver versão correspondente em Versions, use o ID '/org/project/version'.
- Faça query-docs escopada a UM ÚNICO conceito por vez (Single-Concept Scoping; não misture tópicos na mesma busca).
- Limite de no máximo 3 consultas por tarefa. Se não resolver, siga os padrões locais do projeto.
- Não invente assinatura, opção de configuração nem nome de API a partir de memória.
- Não use Context7 para lógica de negócio do projeto ou funções locais.
- Se a documentação divergir do padrão já presente no projeto, siga o projeto e registre a divergência no retorno.
```

Sem o Context7_MCP, o prompt instrui o Executor a **seguir os padrões já presentes no projeto** — imports, wrappers, versão do manifest, exemplos existentes — em vez de improvisar API, e a limitação é registrada em `report/workflow-log.md`.

### Erro de autenticação

Consulta ao Context7_MCP que volta com erro de autenticação:

1. apresente ao usuário a remediação de configurar a chave de API do Context7 (registro do servidor por `npx ctx7 setup --claude` ou configuração da chave no cliente MCP, seguida de reinício do agente de código);
2. prossiga com o workflow **sem documentação externa**, no caminho de "Context7 ausente";
3. registre a limitação em `report/workflow-log.md`.

Não pare a Run, não peça a chave em texto na conversa e não tente contornar a autenticação por outra rota.

### Chave de API fora de tudo

A chave de API do Context7 não entra em **prompt de subagente**, **artefato da Run** (`plan/`, `contracts/`, `run/`, `review/`, `report/`, `evidence/`) nem **telemetria**. Também não entra em `.orchestrator/project-config.md`, que não tem campo para credencial.

Ao citar o Context7 em qualquer artefato, cite nome do servidor, URL pública `https://mcp.context7.com/mcp` e o comando de setup — nunca cabeçalho de autenticação, nunca valor de chave, nunca linha de arquivo de configuração. A detecção do preflight segue a mesma regra: só caminho de arquivo, nome de servidor e tipo de evidência.

## Registro em `report/workflow-log.md`

Anote, em "Validações e Evidências" e em "Decisões do Orquestrador":

- disponibilidade dos dois MCPs conforme o preflight, com `reason` quando ausente (`NOT_DETECTED` ou `TIMEOUT`);
- resultado do gate de `index_status` e a decisão do usuário sobre `index_repository`;
- por fase, quais consultas de grafo alimentaram qual artefato, e o caminho determinístico usado quando o grafo não respondeu;
- cada consulta que falhou ou estourou os 30 s, com a alternativa aplicada;
- cada arquivo lido diretamente por lacuna de cobertura do grafo;
- limitação aceita: MCP ausente, indexação recusada, Context7 sem autenticação.

Nunca registre conteúdo bruto de resposta de MCP, conteúdo de arquivo de configuração MCP, chave de API ou cabeçalho de autenticação. Resposta de grafo entra no log como `projectId`, ferramenta, `queriedAt` e digest do resultado.

## Checklist

- [ ] Preflight lido: `checks.optional.mcp.codebase-memory` e `checks.optional.mcp.context7`.
- [ ] `index_status` consultado antes de qualquer uso do grafo como evidência.
- [ ] `index_repository` oferecido por `AskUserQuestion`, nunca disparado por conta própria.
- [ ] Fase 1 com `get_architecture`/`get_graph_schema`; Fase 2 com `search_graph`/`trace_path`/`get_code_snippet`; Fase 7 com `detect_changes`.
- [ ] Consulta acima de 30 s ou com erro: falha registrada, caminho determinístico seguido, workflow em frente.
- [ ] Lacuna de cobertura: arquivo lido antes de afirmar ausência.
- [ ] Fato `GRAPH` gravado com `projectId` e `queriedAt`, sempre acompanhado de `FILE`/`CONTRACT`/`TEST`/`RUN_EVENT`.
- [ ] Prompt de subagente com bloco de grafo só quando o Executor tem acesso ao CBM_MCP.
- [ ] Identificador da biblioteca resolvido antes de pedir documentação, sempre com pontuação oficial.
- [ ] ID canônico versionado (`/org/project/version`) e consultas com Single-Concept Scoping (máx 3).
- [ ] Chave de API do Context7 fora de prompt, artefato e telemetria.
