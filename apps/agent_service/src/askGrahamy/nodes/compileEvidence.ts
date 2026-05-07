import {
  buildAnalystBriefContract,
  buildEvidencePack,
} from "../analystOrchestration";
import { compilePublicResearchView } from "../publicResearch";
import { buildEvidencePackFromWorkflowExecution } from "../workflowEvidencePack";
import { EMPTY_CLASSIFICATION } from "../types";
import {
  type AskGrahamyGraphState,
  type AskGrahamyLangGraphState,
  patchFromAskGrahamyState,
  runGraphNode,
  toAskGrahamyState,
} from "../askGrahamyState";

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
