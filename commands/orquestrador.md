---
name: orquestrador
description: Alias em portugues para /orchestrator
argument-hint: "help | preflight | project-config | brain-pensador [--limit N] [--all] | status [runId] | resume [runId] | knowledge <sub> | telemetry <sub> | [--model <id>] [--parallel] [--subagent-model <id>] [--effort <nivel>] [--timeout <duracao>] <PRD>"
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(node:*), AskUserQuestion, Agent, TaskCreate, TaskUpdate, TaskList
---

# /orquestrador

Alias em portugues de `/orchestrator`. Mesma superficie, mesmo workflow, mesmos subcomandos.

Quando invocado, leia `${CLAUDE_PLUGIN_ROOT}/commands/orchestrator.md` e execute exatamente o workflow ali definido, repassando `$ARGUMENTS` **na integra e sem reinterpretar** — subcomandos, flags novas e aliases legados inclusive.

Este arquivo nao redefine subcomando nem flag: `commands/orchestrator.md` e a unica fonte da verdade da superficie. Se `$ARGUMENTS` estiver vazio, siga a regra "Quando o usuario invocar sem argumento" do comando canonico.
