import { renameSync } from "node:fs";

// No Windows, renomear sobre um arquivo que outro processo tem aberto por um
// instante (antivirus, indexador, leitor concorrente) falha de forma transitoria
// com EPERM/EBUSY/EACCES. O rename em si e atomico; so a tentativa precisa de
// nova chance. Erros de outra natureza propagam na hora.
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function sleepBlocking(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * `renameSync` com retry limitado para falhas transitorias de bloqueio.
 * Devolve o numero de tentativas usadas. `rename` e `sleep` sao injetaveis
 * para teste deterministico.
 */
export function renameWithRetry(from, to, options = {}) {
  const rename = options.rename ?? renameSync;
  const sleep = options.sleep ?? sleepBlocking;
  const attempts = Number(options.attempts ?? 12);
  const baseMs = Number(options.baseMs ?? 10);
  for (let attempt = 1; ; attempt += 1) {
    try {
      rename(from, to);
      return attempt;
    } catch (error) {
      if (!TRANSIENT_RENAME_CODES.has(error?.code) || attempt >= attempts) throw error;
      sleep(Math.min(baseMs * attempt, 100));
    }
  }
}
