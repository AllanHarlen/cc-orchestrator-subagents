import assert from "node:assert/strict";
import test from "node:test";

import {
  adaptExecutorProbe,
  adaptProbeSet,
} from "../skills/orchestrator-multi-agent-development/scripts/lib/executor-adapters.mjs";

/**
 * Regressao para o bug real (OficinaAI, 2026-09-22 e narrado na sessao de
 * analise de 2026-09-23): `normalizeStatus` deixava um AGY probe reportando
 * um status explicito valido (DONE, RUNNING, ...) ser sobrescrito por uma
 * varredura de texto livre sobre `reason`/`error`/`summary`, sempre que esse
 * texto mencionasse "quota", "timeout", "unauthorized" ou "agy not found" —
 * mesmo fora de qualquer contexto de falha de infraestrutura. Um domino como
 * o do PRD da OficinaAI (SaaS com planos, cobranca e "quota" de uso por
 * tenant) torna esse vocabulario comum em texto de negocio legitimo.
 */

test("AGY: an explicit DONE status survives a summary that legitimately mentions quota/timeout vocabulary", () => {
  const probe = adaptExecutorProbe("agy", {
    status: "SUCCESS",
    summary: "Implementado o endpoint de quota do plano: retorna 429 com Retry-After quando o tenant excede o limite mensal; adicionamos um timeout de 5s no upstream de cobranca.",
  });
  assert.equal(probe.executorStatus, "DONE");
});

test("AGY: an explicit RUNNING status survives text mentioning the same vocabulary", () => {
  const probe = adaptExecutorProbe("agy", {
    status: "RUNNING",
    reason: "Ainda implementando a tela de billing; falta o aviso de quota excedida e o texto de unauthorized no 401.",
  });
  assert.equal(probe.executorStatus, "RUNNING");
});

test("AGY: an explicit CANCELLED/BLOCKED/STALLED/PENDING status is never reinterpreted from free text", () => {
  for (const status of ["CANCELLED", "BLOCKED", "STALLED", "PENDING"]) {
    const probe = adaptExecutorProbe("agy", {
      status,
      reason: "mentions quota, timeout, unauthorized and agy not found in unrelated business copy",
    });
    assert.equal(probe.executorStatus, status, `status ${status} must not be overridden by text scanning`);
  }
});

test("AGY: a generic ERROR/FAILED status is still disambiguated from its own error text (unchanged behavior)", () => {
  const quota = adaptExecutorProbe("agy", {
    status: "ERROR",
    error: "resource exhausted",
  });
  assert.equal(quota.executorStatus, "QUOTA_EXAUSTED");
  assert.equal(quota.reasonCode, "QUOTA_EXAUSTED");

  const auth = adaptExecutorProbe("agy", {
    status: "FAILED",
    error: "Authentication required. Please sign in.",
  });
  assert.equal(auth.executorStatus, "AUTH_REQUIRED");

  const missing = adaptExecutorProbe("agy", {
    status: "FAILED",
    error: "agy: command not found",
  });
  assert.equal(missing.executorStatus, "AGY_MISSING");

  const timeout = adaptExecutorProbe("agy", {
    status: "FAILED",
    error: "the operation timed out",
  });
  assert.equal(timeout.executorStatus, "TIMEOUT");
});

test("AGY: a missing/garbage explicit status still falls back to text scanning (unchanged behavior)", () => {
  const probe = adaptExecutorProbe("agy", {
    reason: "Individual quota reached. Please upgrade your subscription.",
  });
  assert.equal(probe.executorStatus, "QUOTA_EXAUSTED");
});

test("AGY: DONE from a stream-json result envelope survives quota/timeout vocabulary in its own error/reason field", () => {
  // summarizeAgyStream() folds the result envelope's `error` field into the
  // text used for classification (as `stream.error`); the fix must hold on
  // that path too, not just for a top-level `reason`/`error`/`summary` field.
  const probe = adaptExecutorProbe("agy", {
    events: [{
      event: "result",
      result: {
        status: "SUCCESS",
        conversation_id: "conv-1",
        error: "no quota or timeout issues seen in the billing flow",
      },
    }],
  });
  assert.equal(probe.executorStatus, "DONE");
});

test("Codex: an explicit DONE/RUNNING status is never reinterpreted from free text (parity with AGY fix)", () => {
  const done = adaptExecutorProbe("codex", {
    status: "COMPLETED",
    summary: "Implementado endpoint de quota do plano e timeout configuravel para o upstream.",
  });
  assert.equal(done.executorStatus, "DONE");

  const running = adaptExecutorProbe("codex", {
    status: "RUNNING",
    reason: "still working; mentions unauthorized in a comment",
  });
  assert.equal(running.executorStatus, "RUNNING");
});

test("Codex: a missing/garbage explicit status still falls back to text scanning (unchanged behavior)", () => {
  const probe = adaptExecutorProbe("codex", {
    output: "Codex error: rate limit exceeded, please retry later.",
  });
  assert.equal(probe.executorStatus, "QUOTA_EXHAUSTED");
  assert.equal(probe.reasonCode, "QUOTA_EXHAUSTED");
});

test("Codex: 'Selected model is at capacity' (transient capacity, not quota) does not match the quota pattern", () => {
  // Real Codex error observed in a live run (OficinaAI, 2026-09-22, job
  // task-mudb4nhk-96mf5k): "Codex error: Selected model is at capacity.
  // Please try a different model." This is transient model-capacity pressure,
  // not an account quota/rate-limit exhaustion, and must not be classified as
  // QUOTA_EXHAUSTED — conflating the two would make the orchestrator apply
  // the quota-exhaustion policy (pause/fallback/wait for reset) to a case
  // that just needs a retry or a different model.
  const probe = adaptExecutorProbe("codex", {
    output: "Codex error: Selected model is at capacity. Please try a different model.",
  });
  assert.notEqual(probe.executorStatus, "QUOTA_EXHAUSTED");
});

test("adaptProbeSet applies the same guard across a batch of tasks", () => {
  const result = adaptProbeSet({
    tasks: {
      "fe-01": {
        executor: "agy",
        status: "SUCCESS",
        summary: "Sem problemas de quota ou timeout no fluxo de billing.",
      },
      "fe-02": {
        executor: "agy",
        status: "ERROR",
        error: "resource exhausted",
      },
    },
  });
  assert.equal(result.tasks["FE-01"].executorStatus, "DONE");
  assert.equal(result.tasks["FE-02"].executorStatus, "QUOTA_EXAUSTED");
});
