import {
  buildAnalystBriefContract,
  buildEvidencePack,
} from "../agent/analystOrchestration";
import { compilePublicResearchView } from "../research/publicResearch";
import { buildEvidencePackFromWorkflowExecution } from "../workflow/workflowEvidencePack";
import { EMPTY_CLASSIFICATION } from "../types";
import {
  type AskGrahamyGraphState,
  type AskGrahamyLangGraphState,
  patchFromAskGrahamyState,
  runGraphNode,
  toAskGrahamyState,
} from "../state/askGrahamyState";

export async function compileEvidenceNode(
  state: AskGrahamyLangGraphState,
): Promise<Partial<AskGrahamyGraphState>> {
  return runGraphNode(state, async () => {
    const next = toAskGrahamyState(state);
    next.publicResearchView = compilePublicResearchView({
      classification: next.classification ?? EMPTY_CLASSIFICATION,
      previousContext: undefined,
      snapshots: next.snapshots ?? {},
      toolOutputs: next.toolOutputs ?? {},
      researchObjects: next.researchObjects ?? [],
      pgCapabilityViews: next.pgCapabilityViews,
      pipelineOverlayViews: next.pipelineOverlayViews,
      warnings: next.warnings,
    });
    next.evidencePack = next.workflowExecutionResult
      ? buildEvidencePackFromWorkflowExecution(next.workflowExecutionResult)
      : buildEvidencePack(next);
    next.analystBrief = buildAnalystBriefContract(next.evidencePack);
    return patchFromAskGrahamyState(next);
  });
}
