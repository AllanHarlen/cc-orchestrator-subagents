#!/usr/bin/env node

/**
 * CLI do fallback de cota opt-in (`/orchestrator` invoca durante a Politica de
 * quota e o ciclo de heartbeat/sweep, ver SKILL.md e
 * references/lifecycle-telemetry.md).
 *
 * Camada fina sobre `lib/quota-fallback.mjs`: nenhuma regra nasce aqui.
 *
 * Subcomandos:
 *
 * - `resolve --original <executor> [--exhausted a,b]`
 *     -> `{ chain: string[] }` — elos ainda tentaveis da cadeia fixa
 *        `claude-code, codex, agy`, pura, sem tocar o filesystem.
 * - `record --dir <run> --task <id> --from <executor> --to <executor>
 *           --reason-code <code> --chain-position <n> [--wave <n>] [--now <iso>]`
 *     -> grava uma entrada no contrato de repasse (`state.json.quotaHandoffs[]`).
 * - `list --dir <run>`
 *     -> `{ quotaHandoffs: object[] }`, sem mutar o estado.
 * - `mark-recovery-checked --dir <run> --task <id> --status <PENDING|RESTORED>`
 *     -> atualiza `quotaRecoveryCheck` das entradas daquela task (ciclo de
 *        monitoramento por heartbeat/sweep). Nunca reabre nem reexecuta a task.
 */

import { numberArg, parseArgs, required } from "./lib/cli-utils.mjs";
import { executeJsonCli } from "./lib/cli-utils.mjs";
import {
  listQuotaHandoffs,
  markQuotaRecoveryChecked,
  recordQuotaHandoff,
  resolveFallbackChain,
} from "./lib/quota-fallback.mjs";

function help() {
  return {
    name: "quota-fallback",
    commands: {
      resolve: "resolve --original <codex|agy|claude-code> [--exhausted a,b]",
      record:
        "record --dir <run> --task <id> --from <executor> --to <executor> "
        + "--reason-code <code> --chain-position <n> [--wave <n>] [--now <iso-8601>]",
      list: "list --dir <run>",
      "mark-recovery-checked": "mark-recovery-checked --dir <run> --task <id> --status <PENDING|RESTORED>",
    },
  };
}

function listArg(value) {
  if (value === undefined || value === true) return [];
  const entries = Array.isArray(value) ? value : [value];
  return entries.flatMap((entry) => String(entry).split(","));
}

function resolve_(args) {
  return { chain: resolveFallbackChain(required(args, "original"), { exhausted: listArg(args.exhausted) }) };
}

function record(args) {
  const entry = {
    taskId: required(args, "task"),
    wave: args.wave !== undefined ? numberArg(args.wave) : null,
    fromExecutor: required(args, "from"),
    toExecutor: required(args, "to"),
    reasonCode: required(args, "reason-code"),
    chainPosition: numberArg(required(args, "chain-position")),
  };
  const result = recordQuotaHandoff(required(args, "dir"), entry, { now: args.now });
  return { quotaHandoff: result.quotaHandoff, quotaHandoffs: result.quotaHandoffs };
}

function list(args) {
  return { quotaHandoffs: listQuotaHandoffs(required(args, "dir")) };
}

function markRecoveryChecked(args) {
  const result = markQuotaRecoveryChecked(required(args, "dir"), required(args, "task"), required(args, "status"));
  return { quotaHandoffs: result.quotaHandoffs };
}

function main(argv) {
  const [command = "help", ...rest] = argv;
  const args = parseArgs(rest);
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      return help();
    case "resolve":
      return resolve_(args);
    case "record":
      return record(args);
    case "list":
      return list(args);
    case "mark-recovery-checked":
      return markRecoveryChecked(args);
    default: {
      const error = new Error(`Unknown command: ${command}`);
      error.code = "UNKNOWN_COMMAND";
      throw error;
    }
  }
}

executeJsonCli(main);
