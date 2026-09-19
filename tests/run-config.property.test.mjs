import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import fc from "fast-check";

import {
  CATEGORY_ROLE,
  EXECUTORS,
  resolveExecutorForCategory,
  writeProjectConfig,
} from "../skills/orchestrator-multi-agent-development/scripts/lib/project-config.mjs";
import {
  applyProjectConfigToRun,
  initRun,
  resumeRunAtDirectory,
  updateTaskStatus,
} from "../skills/orchestrator-multi-agent-development/scripts/lib/orchestration-state.mjs";
import { arbProjectConfig } from "./helpers/project-config-arbitraries.mjs";

/**
 * Testes de propriedade do snapshot de Project_Config na Run e da uniformidade
 * do registro de dispatch.
 *
 * Uma propriedade do design por teste, cada uma com o comentario de tag e o
 * minimo de 100 iteracoes. Os geradores constroem a Run com as funcoes reais de
 * `orchestration-state.mjs` sobre um diretorio temporario (sem mocks): a unica
 * forma honesta de testar snapshot, drift e a reatribuicao de escopo `pending`
 * e passar pelo write-ahead log de verdade.
 *
 * Categorias sem fatia dupla (tudo menos `FULLSTACK`) mantem o Executor
 * esperado de cada task como uma string unica, o que deixa a propriedade livre
 * para comparar contra `resolveExecutorForCategory` sem reimplementar a
 * composicao `backend+frontend`.
 */

const NUM_RUNS = 25;

const roots = [];

test.afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* Geradores                                                                   */
/* -------------------------------------------------------------------------- */

/** Categorias com um unico papel responsavel (exclui FULLSTACK, que teria fatia dupla). */
const SINGLE_ROLE_CATEGORIES = Object.freeze(
  Object.keys(CATEGORY_ROLE).filter((category) => CATEGORY_ROLE[category] !== null),
);

function arbSingleRoleCategory() {
  return fc.constantFrom(...SINGLE_ROLE_CATEGORIES);
}

/**
 * Uma task do plano: categoria de papel unico, e se ela ja foi "despachada"
 * (RUNNING com um Executor proprio, distinto do que a config atual derivaria)
 * antes da Run ser retomada e da configuracao ser adotada.
 */
function arbTaskSpec() {
  return fc.record({
    category: arbSingleRoleCategory(),
    dispatched: fc.boolean(),
    dispatchExecutor: fc.constantFrom(...EXECUTORS),
    terminal: fc.boolean(),
  });
}

/** Plano de 1 a 5 tasks com identificadores unicos. */
function arbTaskPlan() {
  return fc
    .array(arbTaskSpec(), { minLength: 1, maxLength: 5 })
    .map((specs) => specs.map((spec, index) => ({ ...spec, id: `T${index + 1}` })));
}

/* -------------------------------------------------------------------------- */
/* Fixture: Run real construida sobre um projeto temporario                    */
/* -------------------------------------------------------------------------- */

function temporaryProject() {
  const root = mkdtempSync(join(process.cwd(), ".tmp-run-config-"));
  roots.push(root);
  return root;
}

function writeClassification(artifactDir, plan) {
  const blocks = plan.map((task) =>
    [`## ${task.id} - Task ${task.id}`, `- category: ${task.category}`].join("\n"),
  );
  writeFileSync(join(artifactDir, "tasks-classification.md"), `# Tasks\n\n${blocks.join("\n\n")}\n`, "utf8");
  const waveLines = plan.map((task) => `- ${task.id}`).join("\n");
  writeFileSync(join(artifactDir, "waves.md"), `# Waves\n\n## Wave 1\n${waveLines}\n`, "utf8");
}

/**
 * Constroi uma Run real: grava a Project_Config inicial no arquivo, inicializa
 * a Run (que congela o snapshot a partir do arquivo) e despacha as tasks
 * marcadas como `dispatched` no plano com um Executor proprio.
 */
function buildDispatchedRun(root, configA, plan, now) {
  writeProjectConfig(root, configA, { now });
  const artifactDir = join(root, ".orchestration", "demo");
  mkdirSync(artifactDir, { recursive: true });
  writeClassification(artifactDir, plan);

  const init = initRun({
    projectRoot: root,
    artifactDir,
    slug: "demo",
    runId: "run-config-property",
    now,
  });

  for (const task of plan) {
    if (!task.dispatched) continue;
    updateTaskStatus(artifactDir, task.id, "RUNNING", {
      projectRoot: root,
      executor: task.dispatchExecutor,
      executorSource: "manual-dispatch",
      sessionId: `${task.id}-session`,
      now,
    });
    if (task.terminal) {
      updateTaskStatus(artifactDir, task.id, "BLOCKED", {
        projectRoot: root,
        reasonCode: "QUOTA_EXHAUSTED",
        reason: "fixture: simulated executor outage",
        now,
      });
    }
  }

  return { artifactDir, init };
}

/* -------------------------------------------------------------------------- */
/* Propriedades                                                                */
/* -------------------------------------------------------------------------- */

// Feature: orchestrator-mcp-agent-config, Property 13: Snapshot de configuracao e escopo da mudanca na Run
// Para qualquer par de Project_Config e qualquer estado de Run, o snapshot gravado na inicializacao e
// igual a configuracao vigente, a diferenca reportada na retomada e exatamente o conjunto de papeis
// divergentes entre snapshot e arquivo, e adotar a configuracao atual altera o Executor apenas de
// tasks ainda nao despachadas, preservando o Executor registrado no dispatch de toda task ja
// despachada e emitindo um evento com o motivo da mudanca.
//
// **Validates: Requirements 6.5, 10.1, 10.2, 10.3, 10.4, 10.5**
test("Property 13: snapshot na inicializacao, drift na retomada, escopo pending na adocao", () => {
  fc.assert(
    fc.property(
      arbProjectConfig(),
      arbProjectConfig(),
      arbTaskPlan(),
      (configA, configB, plan) => {
        const root = temporaryProject();
        const now = configA.updatedAt;
        const { artifactDir, init } = buildDispatchedRun(root, configA, plan, now);

        // O snapshot gravado na inicializacao e igual a configuracao vigente (Req 10.1).
        assert.equal(init.state.projectConfig.source, "file");
        assert.equal(init.state.projectConfig.updatedAt, configA.updatedAt);
        for (const role of ["backendExecutor", "frontendExecutor", "frontendReviewer", "backendReviewer"]) {
          assert.equal(init.state.projectConfig.roles[role], configA[role]);
        }

        // Sobrescreve o Project_Config_File com uma configuracao B, possivelmente
        // divergente, e retoma a Run: o drift reportado e exatamente o conjunto de
        // papeis que divergem entre o snapshot (A) e o arquivo (B) (Req 10.2).
        const laterNow = new Date(Date.parse(configA.updatedAt) + 1000).toISOString().slice(0, 19) + "Z";
        writeProjectConfig(root, { ...configB, updatedAt: laterNow });
        const resumed = resumeRunAtDirectory(artifactDir, { projectRoot: root, now });

        const expectedDiffRoles = [
          "backendExecutor",
          "frontendExecutor",
          "frontendReviewer",
          "backendReviewer",
          "quotaFallbackChain",
        ]
          .filter((role) => configA[role] !== configB[role])
          .sort();
        const actualDiffRoles = resumed.projectConfigDrift.differences.map((entry) => entry.role).sort();
        assert.deepEqual(actualDiffRoles, expectedDiffRoles);
        assert.equal(resumed.projectConfigDrift.changed, expectedDiffRoles.length > 0);
        assert.equal(resumed.projectConfigDrift.source, "file");

        // Adotar a configuracao atual (B) so reatribui tasks PENDING com attempt 0;
        // toda task ja despachada preserva o Executor do dispatch (Req 10.4, 10.5).
        const beforeApply = resumed.state.tasks;
        const applied = applyProjectConfigToRun(artifactDir, {
          projectRoot: root,
          scope: "pending",
          now,
        });

        for (const task of plan) {
          const before = beforeApply[task.id];
          const after = applied.state.tasks[task.id];
          if (task.dispatched) {
            // Task ja despachada: Executor do dispatch preservado, task listada em skipped.
            assert.equal(after.executor, before.executor, `${task.id} deveria preservar o executor do dispatch`);
            assert.equal(after.executorSource, before.executorSource);
            assert.ok(applied.skippedTaskIds.includes(task.id));
            assert.ok(!applied.appliedTaskIds.includes(task.id));
          } else {
            // Task ainda pendente: Executor reatribuido a partir da configuracao B.
            const expected = resolveExecutorForCategory(task.category, configB);
            assert.equal(after.executor, expected.executor, `${task.id} deveria adotar o executor de B`);
            assert.equal(after.executorSource, "project-config");
            assert.ok(applied.appliedTaskIds.includes(task.id));
            assert.ok(!applied.skippedTaskIds.includes(task.id));
          }
        }

        // O evento registrado traz o motivo da mudanca (Req 10.4).
        assert.equal(applied.event.type, "PROJECT_CONFIG_UPDATED");
        assert.equal(typeof applied.reason, "string");
        assert.ok(applied.reason.trim() !== "");
        assert.equal(applied.state.projectConfig.roles.backendExecutor, configB.backendExecutor);
        assert.equal(applied.state.projectConfig.roles.frontendExecutor, configB.frontendExecutor);
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

// Feature: orchestrator-mcp-agent-config, Property 18: Registro de dispatch e uniforme entre executores
// Para qualquer Executor do conjunto `codex`/`agy`/`claude-code`, o registro da task no `state.json`
// traz `executor`, identificador da sessao do subagente, `attempt` e um estado canonico, com as mesmas
// invariantes de transicao.
//
// **Validates: Requirements 7.7**
test("Property 18: o registro de dispatch tem a mesma forma para codex, agy e claude-code", () => {
  fc.assert(
    fc.property(fc.constantFrom(...EXECUTORS), fc.constantFrom(...SINGLE_ROLE_CATEGORIES), (executor, category) => {
      const root = temporaryProject();
      const artifactDir = join(root, ".orchestration", "demo");
      mkdirSync(artifactDir, { recursive: true });
      writeClassification(artifactDir, [{ id: "T1", category }]);
      initRun({ projectRoot: root, artifactDir, slug: "demo", runId: "run-dispatch-uniform" });

      const dispatched = updateTaskStatus(artifactDir, "T1", "RUNNING", {
        projectRoot: root,
        executor,
        executorSource: "project-config",
        sessionId: `${executor}-session`,
        now: "2026-08-19T12:00:00Z",
      });

      const task = dispatched.task;
      // As mesmas quatro invariantes de registro, independente do Executor (Req 7.7).
      assert.equal(task.executor, executor);
      assert.equal(task.executorSource, "project-config");
      assert.equal(task.sessionId, `${executor}-session`);
      assert.equal(task.attempt, 1);
      assert.equal(task.status, "RUNNING");

      // A mesma invariante de transicao: um segundo RUNNING sem `newAttempt` nao
      // incrementa a tentativa, para qualquer Executor.
      const sameAttempt = updateTaskStatus(artifactDir, "T1", "RUNNING", {
        projectRoot: root,
        executor,
        now: "2026-08-19T12:05:00Z",
      });
      assert.equal(sameAttempt.task.attempt, 1);

      // Transicao para um estado terminal canonico continua uniforme.
      const blocked = updateTaskStatus(artifactDir, "T1", "BLOCKED", {
        projectRoot: root,
        reasonCode: "QUOTA_EXHAUSTED",
        reason: "fixture",
        now: "2026-08-19T12:10:00Z",
      });
      assert.equal(blocked.task.status, "BLOCKED");
      assert.equal(blocked.task.executor, executor);
    }),
    { numRuns: 25 },
  );
});
