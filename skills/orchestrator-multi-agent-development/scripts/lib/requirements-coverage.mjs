/**
 * RF/CA requirements coverage gate.
 *
 * Audit finding: the Orchestrador is obliged to satisfy every acceptance
 * criterion of the ingested spec (WORKFLOW.md's central invariant for this
 * stage), but `completionAudit()` in orchestration-state.mjs checks tasks,
 * gates, evidence and artifacts — nothing ties a task back to the `RF`/`CA`
 * it implements. The traceability matrix mandated by
 * `implementation-report.md` section 13 is prose assembled by the same
 * agent that wrote the code (Fase 7), so a requirement dropped during Fase
 * 1.2's task extraction is invisible to every deterministic check
 * downstream while `report/handoff.json` can still report `status: DONE`.
 *
 * This module closes that gap the same way `validate-routing.mjs` and
 * `validate-wire-format.mjs` close theirs: a standalone, pure gate the
 * workflow mandates running (Fase 2/7, see references/workflow.md) rather
 * than surgery on the state machine itself. It reads the `requirements.json`
 * the Pensador emits (role `requirements-index`, PRD mode only — see
 * cc-pensador's requirements-extractor.mjs) and the `requirementIds` field
 * each task declares in `plan/tasks-classification.md`, and reports which
 * id has NO task covering them.
 *
 * Covers three concerns from the same PRD, each with its own id namespace in
 * `requirements.json`: functional requirements (`requirements[]`, `RF-XX`),
 * non-functional requirements (`nonFunctionalRequirements[]`, `RNF-XX`) and
 * architecture patterns the PRD itself committed to
 * (`architecturePatterns[]`, synthetic `ARC-XX`). Audit finding: a real run
 * (OficinaAI, 2026-09) closed DONE with every `RF` covered while its RNF
 * (performance, tenant isolation) and architecture rules (Repository +
 * UnitOfWork) had no task and no evidence anywhere — nothing here checked
 * them because `requirements.json` didn't carry them yet, and this gate only
 * ever looked at `requirements[]`.
 *
 * Deliberately coarse-grained: it checks that EVERY id is claimed by AT
 * LEAST ONE task somewhere in the document, not a strict per-task
 * attribution parser. A stricter per-task mapping would require the same
 * block-splitting machinery `validate-routing.mjs` already has for
 * `executor`/`agyModel` — coverage-by-union already catches the actual bug
 * class (a requirement extracted from the PRD, then silently dropped while
 * building the task list) without that added parsing risk.
 */

const REQUIREMENT_ID_RE = /\b(?:RF|RNF|ARC|US)-(?:[A-Z]+-)?\d+[A-Z]?\b/gi;

/**
 * Extracts every requirement id (`RF-XX`, `RNF-XX`, `ARC-XX`, `US-XX`, plain
 * or domain-qualified) referenced by a `requirementIds` field anywhere in
 * `tasksClassificationMarkdown` — regardless of which task block it is in.
 * Tolerates any reasonable declaration shape a task entry might use:
 * `requirementIds: RF-01, RNF-02`, `requirementIds: [RF-01, RF-02]`, or one
 * per bullet line under a `requirementIds:` heading.
 *
 * @param {string} tasksClassificationMarkdown
 * @returns {Set<string>}
 */
export function extractCoveredRequirementIds(tasksClassificationMarkdown) {
  const text = typeof tasksClassificationMarkdown === 'string' ? tasksClassificationMarkdown : '';
  const covered = new Set();
  const fieldLineRe = /requirementIds\s*[:=]\s*(.*)$/gim;
  let match = fieldLineRe.exec(text);
  while (match !== null) {
    const ids = match[1].match(REQUIREMENT_ID_RE) ?? [];
    for (const id of ids) covered.add(id.toUpperCase());
    match = fieldLineRe.exec(text);
  }
  return covered;
}

/**
 * Computes requirement coverage across all three of `requirements.json`'s id
 * namespaces (RF, RNF, ARC): which ones have at least one task claiming them
 * in `tasksClassificationMarkdown`.
 *
 * Never throws — a missing/malformed `requirementsIndex`, or one with none
 * of the three arrays, degrades to `applicable: false` (nothing to check
 * against, e.g. Spec mode or a pre-requirements-index handoff) rather than
 * reporting a false gap.
 *
 * @param {{
 *   requirements?: Array<{ id: string }>,
 *   nonFunctionalRequirements?: Array<{ id: string }>,
 *   architecturePatterns?: Array<{ id: string }>,
 * } | null | undefined} requirementsIndex
 * @param {string} tasksClassificationMarkdown
 * @returns {{
 *   applicable: boolean,
 *   totalRequirements: number,
 *   coveredRequirementIds: string[],
 *   uncoveredRequirementIds: string[],
 *   complete: boolean,
 * }}
 */
export function computeRequirementsCoverage(requirementsIndex, tasksClassificationMarkdown) {
  const lists = [
    requirementsIndex?.requirements,
    requirementsIndex?.nonFunctionalRequirements,
    requirementsIndex?.architecturePatterns,
  ].filter((list) => Array.isArray(list));

  if (lists.length === 0) {
    return {
      applicable: false,
      totalRequirements: 0,
      coveredRequirementIds: [],
      uncoveredRequirementIds: [],
      complete: true,
    };
  }

  const covered = extractCoveredRequirementIds(tasksClassificationMarkdown);
  const requirementIds = [...new Set(
    lists.flatMap((list) => list.map((r) => (typeof r.id === 'string' ? r.id.toUpperCase() : r.id)))
      .filter((id) => typeof id === 'string' && id.length > 0),
  )];
  const uncovered = requirementIds.filter((id) => !covered.has(id));

  return {
    applicable: true,
    totalRequirements: requirementIds.length,
    coveredRequirementIds: requirementIds.filter((id) => covered.has(id)),
    uncoveredRequirementIds: uncovered,
    complete: uncovered.length === 0,
  };
}
