import {
  appendQuotaHandoff,
  markQuotaHandoffRecoveryChecked,
  readQuotaHandoffs,
} from "./orchestration-state.mjs";

/**
 * Fallback de cota opt-in (`projectConfig.quotaFallbackChain === "enabled"`,
 * ver `references/project-config.md` e a secao "Politica de quota" do
 * SKILL.md).
 *
 * Modulo fino sobre `orchestration-state.mjs`: nenhuma regra de estado nasce
 * aqui. A cadeia fixa e `claude-code, codex, agy` — a mesma ordem citada no
 * SKILL.md — e o "contrato de repasse" e a entrada gravada em
 * `state.json.quotaHandoffs[]` por `appendQuotaHandoff`.
 *
 * - `resolveFallbackChain(originalExecutor, { exhausted })`: pura, sem I/O.
 *   Devolve os elos ainda tentaveis, na ordem fixa, excluindo o Executor
 *   original e qualquer elo ja sinalizado como tambem esgotado nesta Run.
 * - `recordQuotaHandoff(artifactDir, entry)`: grava uma troca de Executor por
 *   cota no contrato de repasse.
 * - `listQuotaHandoffs(artifactDir)`: le o contrato de repasse sem mutar o
 *   estado.
 * - `markQuotaRecoveryChecked(artifactDir, taskId, status)`: atualiza
 *   `quotaRecoveryCheck` (`PENDING`/`RESTORED`) no ciclo de monitoramento
 *   (heartbeat/sweep) — puramente informativo, nunca reabre ou reexecuta a
 *   task.
 */

/** Ordem fixa da cadeia de fallback de cota, citada em SKILL.md/project-config.md. */
export const QUOTA_FALLBACK_CHAIN_ORDER = Object.freeze(["claude-code", "codex", "agy"]);

/**
 * Calcula os elos ainda tentaveis da cadeia de fallback de cota, na ordem
 * fixa `claude-code, codex, agy`.
 *
 * Exclui o Executor original (ja sabemos que ele esgotou a cota) e qualquer
 * elo listado em `options.exhausted` (elos que ja falharam por cota nesta
 * mesma Run, sinalizados por chamadas anteriores desta funcao/dos handoffs
 * ja registrados). Pura: nenhuma leitura de estado, nenhuma I/O.
 *
 * @param {string} originalExecutor Executor que reportou QUOTA_EXHAUSTED/QUOTA_EXAUSTED.
 * @param {{ exhausted?: string[] }} [options]
 * @returns {string[]} Elos restantes, na ordem fixa da cadeia.
 */
export function resolveFallbackChain(originalExecutor, options = {}) {
  const original = String(originalExecutor ?? "").trim().toLowerCase();
  const exhausted = new Set(
    (options.exhausted ?? []).map((executor) => String(executor ?? "").trim().toLowerCase()),
  );
  return QUOTA_FALLBACK_CHAIN_ORDER.filter(
    (executor) => executor !== original && !exhausted.has(executor),
  );
}

/**
 * Grava uma entrada no contrato de repasse de cota
 * (`state.json.quotaHandoffs[]`), via a transicao dedicada
 * `orchestration-state.mjs::appendQuotaHandoff`.
 *
 * `entry` segue o formato `{ taskId, wave, fromExecutor, toExecutor,
 * reasonCode, chainPosition, timestamp, quotaRecoveryCheck }`; campos
 * ausentes recebem o default da transicao (`quotaRecoveryCheck: "PENDING"`,
 * `timestamp: now`).
 *
 * @param {string} artifactDir Diretorio da Run.
 * @param {object} entry Entrada do contrato de repasse.
 * @param {object} [options] Repassado a `appendQuotaHandoff` (`now`, `actor`, ...).
 */
export function recordQuotaHandoff(artifactDir, entry, options = {}) {
  return appendQuotaHandoff(artifactDir, entry, options);
}

/**
 * Le o contrato de repasse de cota da Run, sem mutar o estado.
 *
 * @param {string} artifactDir Diretorio da Run.
 * @param {object} [options] Repassado a `readQuotaHandoffs` (ex.: `verifyReplay`).
 * @returns {Array<object>}
 */
export function listQuotaHandoffs(artifactDir, options = {}) {
  return readQuotaHandoffs(artifactDir, options);
}

/**
 * Atualiza `quotaRecoveryCheck` das entradas de `taskId` no contrato de
 * repasse (ciclo de monitoramento por heartbeat/sweep). Puramente
 * informativo: nunca reabre nem reexecuta a task ja `DONE` com o Executor de
 * fallback.
 *
 * @param {string} artifactDir Diretorio da Run.
 * @param {string} taskId Task cujo repasse deve ser atualizado.
 * @param {"PENDING"|"RESTORED"} status Novo valor de `quotaRecoveryCheck`.
 * @param {object} [options] Repassado a `markQuotaHandoffRecoveryChecked`.
 */
export function markQuotaRecoveryChecked(artifactDir, taskId, status, options = {}) {
  return markQuotaHandoffRecoveryChecked(artifactDir, taskId, status, options);
}
