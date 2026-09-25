import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { artifactWritePath } from "../../skills/orchestrator-multi-agent-development/scripts/lib/artifact-layout.mjs";
import { updateCompletionGate } from "../../skills/orchestrator-multi-agent-development/scripts/lib/orchestration-state.mjs";

const REVIEW_FILES = Object.freeze({ backendReview: "review-final.md", frontendReview: "review-frontend.md" });

/**
 * Writes the review report a review gate reads before it may close DONE (orchestration-state.mjs
 * validateReviewGateEvidence): the file must exist and its last decision word must approve.
 */
export function approveReview(artifactDir, gateId, verdict = "APROVADO") {
  const target = artifactWritePath(artifactDir, REVIEW_FILES[gateId]);
  mkdirSync(dirname(target.path), { recursive: true });
  writeFileSync(target.path, `# Review (${gateId})\n\nAchados: nenhum bloqueante.\n\nDecisao: ${verdict}\n`, "utf8");
  return target.path;
}

/** Fixtures have no machine-readable HTTP contract: the waivable gate is dispensed with a reason. */
export function waiveApiContract(artifactDir, projectRoot) {
  return updateCompletionGate(artifactDir, "apiContractValidation", "N/A", {
    projectRoot,
    required: false,
    reason: "NO_HTTP_API: fixture sem contrato HTTP maquina-legivel",
  });
}
