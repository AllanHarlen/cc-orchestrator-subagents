#!/usr/bin/env node

/**
 * CLI da Project_Config (`/orchestrator project-config`).
 *
 * Camada fina sobre `lib/project-config.mjs`: nenhuma regra de configuracao
 * nasce aqui. O modulo continua sendo a unica fonte da verdade sobre papeis,
 * executores permitidos, formato do arquivo e derivacao do Required_CLI_Set.
 *
 * Subcomandos:
 *
 * - `show [--root .]`           -> `{ config, source, path, exists, requiredCliSet }`
 * - `write --backend-executor <v> --frontend-executor <v> --backend-reviewer <v>
 *          --frontend-reviewer <v> [--default-applied a,b] [--root .] [--now <iso>]`
 *                               -> `{ config, path, changed, previous }`
 * - `validate [--root .]`       -> parse sem gravar
 * - `required-clis [--root .]`  -> so o Required_CLI_Set derivado
 *
 * Contrato de saida herdado de `executeJsonCli`: `{ ok: true, ... }` em stdout
 * ou `{ ok: false, error: { code, message, details } }` em stderr.
 *
 * Garantias de escopo (Req 6.8): o unico caminho que escreve no filesystem e
 * `write`, e ele grava exclusivamente `.orchestrator/project-config.md` via
 * `writeProjectConfig`. Nao existe aqui criacao de `.orchestration/`,
 * inicializacao de Run, leitura de PRD nem leitura de especificacao.
 *
 * Arquivo invalido: `show`, `validate` e `required-clis` propagam o
 * `ProjectConfigError` do parser, nomeando campo, caminho, valor recebido e
 * conjunto aceito (Req 6.1 e insumo do Req 6.9). `write` e deliberadamente
 * tolerante ao arquivo anterior invalido — a regravacao a partir de novas
 * respostas e justamente a remediacao oferecida pelo Req 6.9 — e devolve o erro
 * do parser dentro de `previous.error`, sem perder a informacao.
 */

import {
  ProjectConfigError,
  QUOTA_FALLBACK_FIELD,
  ROLES,
  applyProjectConfigDefaults,
  deriveRequiredCliSet,
  diffProjectConfig,
  projectConfigPath,
  readProjectConfig,
  writeProjectConfig,
} from "./lib/project-config.mjs";
import { executeJsonCli, parseArgs, required } from "./lib/cli-utils.mjs";

/** Flag de linha de comando que carrega cada papel da Project_Config. */
const ROLE_FLAGS = Object.freeze({
  backendExecutor: "backend-executor",
  frontendExecutor: "frontend-executor",
  backendReviewer: "backend-reviewer",
  frontendReviewer: "frontend-reviewer",
});

/** Flag de linha de comando do 5o campo (opt-in, nao um papel de executor). */
const QUOTA_FALLBACK_FLAG = "quota-fallback-chain";

function help() {
  return {
    name: "project-config",
    warning:
      "write is the only mutating command and it only writes .orchestrator/project-config.md. "
      + "No command creates .orchestration/, initializes a Run or reads a PRD.",
    commands: {
      show: "show [--root .]",
      write:
        "write --backend-executor <codex|agy|claude-code> --frontend-executor <v> "
        + "--backend-reviewer <v> --frontend-reviewer <v> [--quota-fallback-chain <disabled|enabled>] "
        + "[--default-applied role,role] [--root .] [--now <iso-8601>]",
      validate: "validate [--root .]",
      "required-clis": "required-clis [--root .]",
    },
    roles: [...ROLES],
    quotaFallbackField: QUOTA_FALLBACK_FIELD,
  };
}

/** Lista de papeis vinda de `--default-applied a,b` ou de flags repetidas. */
function listArg(value) {
  if (value === undefined || value === true) return [];
  const entries = Array.isArray(value) ? value : [value];
  return entries.flatMap((entry) => String(entry).split(","));
}

function nowArg(value) {
  if (value === undefined || value === true) return new Date();
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error(`Expected an ISO 8601 instant for --now, received ${value}`);
    error.code = "INVALID_INSTANT";
    throw error;
  }
  return parsed;
}

/**
 * Le a configuracao vigente sem falhar quando o arquivo existente e invalido.
 *
 * Usado apenas por `write`: preserva o erro do parser em `error` para que a
 * regravacao continue possivel e o motivo da perda da configuracao anterior
 * fique registrado na saida.
 */
function readPreviousConfig(root) {
  try {
    const previous = readProjectConfig(root);
    return { ...previous, error: null };
  } catch (error) {
    if (!(error instanceof ProjectConfigError)) throw error;
    return {
      exists: true,
      source: "invalid",
      path: error.details?.path ?? projectConfigPath(root),
      config: null,
      error: { code: error.code, message: error.message, details: error.details },
    };
  }
}

function show(root) {
  const { config, source, path, exists } = readProjectConfig(root);
  return { config, source, path, exists, requiredCliSet: deriveRequiredCliSet(config, { path }) };
}

function validate(root) {
  const { config, source, path, exists } = readProjectConfig(root);
  return { valid: true, config, source, path, exists };
}

function requiredClis(root) {
  const { config, source, path } = readProjectConfig(root);
  return { requiredCliSet: deriveRequiredCliSet(config, { path }), source };
}

function write(root, args) {
  const answers = { defaultsApplied: listArg(args["default-applied"]) };
  for (const role of ROLES) answers[role] = required(args, ROLE_FLAGS[role]);
  // Opt-in: ausente do argv vale como "sem resposta" (o mesmo tratamento dos
  // quatro papeis) e recebe o default `disabled` marcado como default-aplicado.
  if (args[QUOTA_FALLBACK_FLAG] !== undefined) {
    answers[QUOTA_FALLBACK_FIELD] = args[QUOTA_FALLBACK_FLAG];
  }

  const now = nowArg(args.now);
  const path = projectConfigPath(root);
  // Validacao antes de qualquer I/O: valor de papel fora do conjunto permitido
  // falha aqui, sem tocar o arquivo anterior.
  const resolved = applyProjectConfigDefaults(answers, { now, path });

  const previous = readPreviousConfig(root);
  const written = writeProjectConfig(root, resolved, { now });

  return {
    config: written.config,
    path: written.path,
    changed: diffProjectConfig(previous.config, written.config, { path: written.path }),
    previous: {
      exists: previous.exists,
      source: previous.source,
      config: previous.config,
      error: previous.error,
    },
  };
}

function main(argv) {
  const [command = "help", ...rest] = argv;
  const args = parseArgs(rest);
  const root = args.root === undefined || args.root === true ? process.cwd() : String(args.root);
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      return help();
    case "show":
      return show(root);
    case "write":
      return write(root, args);
    case "validate":
      return validate(root);
    case "required-clis":
      return requiredClis(root);
    default: {
      const error = new Error(`Unknown command: ${command}`);
      error.code = "UNKNOWN_COMMAND";
      throw error;
    }
  }
}

executeJsonCli(main);
