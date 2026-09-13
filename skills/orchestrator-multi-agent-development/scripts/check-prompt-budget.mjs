#!/usr/bin/env node

/**
 * Mede um prompt de delegacao contra o orcamento indicativo de 24.000
 * caracteres. Puramente indicativo (`advisory: true`) para todo agente desde
 * o bridge cc-antigravity-plugin 4.4.0: `agy --print <prompt>` deixou de ser a
 * unica forma de chegar ao AGY — o bridge agora faz stream do prompt final via
 * stdin sempre que ele excede o tamanho seguro de argv (8.191 chars no
 * Windows, 100.000 nas demais plataformas), preservando o contexto inline
 * inteiro em vez de descarta-lo. `--agent codex` (`--prompt-file`,
 * codex-companion.mjs) nunca teve limite de argv. Nenhum dos dois falha por
 * esta checagem hoje.
 *
 * O threshold continua util como sinal de qualidade: um corpo de task muito
 * grande costuma indicar escopo mal recortado, mesmo que o transporte
 * suporte o tamanho.
 *
 * Uso:
 *   node check-prompt-budget.mjs --agent agy --file <path>
 *   node check-prompt-budget.mjs --agent codex --stdin < prompt.txt
 *   echo "$PROMPT" | node check-prompt-budget.mjs --agent agy --stdin
 *
 * Saida: `{ chars, limit, overBy, ok, advisory, suggestedSplits }`.
 * `advisory: true` sempre — exit 0 mesmo com `ok: false`, para qualquer
 * agente suportado.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { executeJsonCli, numberArg, parseArgs, required } from "./lib/cli-utils.mjs";

export const PROMPT_CHAR_LIMIT = 24_000;
const HARD_LIMIT_AGENTS = new Set();
const ADVISORY_LIMIT_AGENTS = new Set(["agy", "codex"]);

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function suggestSplits(chars, limit) {
  if (chars <= limit) return 1;
  return Math.ceil(chars / limit);
}

function main(argv) {
  const args = parseArgs(argv);
  const agent = String(required(args, "agent")).toLowerCase();
  if (!HARD_LIMIT_AGENTS.has(agent) && !ADVISORY_LIMIT_AGENTS.has(agent)) {
    const error = new Error(
      `Unsupported --agent "${agent}". Expected one of: ${[
        ...HARD_LIMIT_AGENTS,
        ...ADVISORY_LIMIT_AGENTS,
      ].join(", ")}`,
    );
    error.code = "UNSUPPORTED_AGENT";
    throw error;
  }
  const limit = numberArg(args.limit, PROMPT_CHAR_LIMIT);
  const advisory = ADVISORY_LIMIT_AGENTS.has(agent);

  const text = args.stdin ? readStdin() : readFileSync(resolve(String(required(args, "file"))), "utf8");

  const chars = text.length;
  const ok = chars <= limit;
  const overBy = ok ? 0 : chars - limit;

  // Every currently supported agent is advisory-only (see module docstring),
  // so this never throws today. Kept as a real branch, not dead code removed:
  // a future agent added to HARD_LIMIT_AGENTS re-activates it without needing
  // to rebuild the error/exit-code contract the tests already pin.
  if (!ok && !advisory) {
    const error = new Error(
      `Prompt has ${chars} chars, ${overBy} over the ${limit}-char limit for --agent ${agent}. `
      + "Split the task into independent-deliverable subtasks before delegating.",
    );
    error.code = "PROMPT_OVER_LIMIT";
    error.details = { agent, chars, limit, overBy, suggestedSplits: suggestSplits(chars, limit) };
    throw error;
  }

  return {
    agent,
    chars,
    limit,
    overBy,
    ok,
    advisory,
    suggestedSplits: ok ? 1 : suggestSplits(chars, limit),
  };
}

executeJsonCli(main);
