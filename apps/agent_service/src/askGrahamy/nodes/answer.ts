import { observeToolCall } from "../../langfuse";
import { renderAnalystBriefToAnswer } from "../analystBriefRenderer";
import { synthesizeAnalystBriefFromEvidencePack } from "../analystBriefSynthesizer";
import { runGrahamyDeepAgent } from "../grahamyAgent";
import { buildEvidencePackFromWorkflowExecution } from "../workflowEvidencePack";
import { DEFAULT_DISCLAIMER } from "../types";
import {
  type AskGrahamyGraphState,
  type AskGrahamyLangGraphState,
  patchFromAskGrahamyState,
  runGraphNode,
  toAskGrahamyState,
} from "../askGrahamyState";

export async function answerNode(
  state: AskGrahamyLangGraphState,
): Promise<Partial<AskGrahamyGraphState>> {
  return runGraphNode(state, async () => {
    const next = toAskGrahamyState(state);
    if (next.workflowExecutionResult) {
      next.evidencePack =
        next.evidencePack ??
        buildEvidencePackFromWorkflowExecution(next.workflowExecutionResult);
      const synthesizer =
        state.options.analystBriefSynthesizer ??
        synthesizeAnalystBriefFromEvidencePack;
      const synthesis = await observeToolCall(
        "synthesize_analyst_brief",
        {
          message: next.message,
          evidencePackKeys: Object.keys(next.evidencePack ?? {}),
        },
        () =>
          synthesizer({
            message: next.message,
            evidencePack: next.evidencePack!,
          }),
      );
      next.warnings.push(...synthesis.warnings);
      next.analystBrief = synthesis.brief;
      const rendered = renderAnalystBriefToAnswer(synthesis.brief);
      next.answer = rendered.answer;
      next.ui = rendered.ui;
    } else {
      // The deep agent composes the user-facing answer from the turn evidence
      // and its own PostgresSaver thread history keyed by conversationId.
      const grahamyRunner = state.options.grahamyAgentRunner ?? runGrahamyDeepAgent;
      const grahamy = await observeToolCall(
        "grahamy_deep_agent",
        {
          message: next.message,
          conversationId: next.conversationId,
          intent: next.classification?.intent,
        },
        () => grahamyRunner(next),
      );
      next.warnings.push(...grahamy.warnings);
      next.answer = {
        headline: "",
        summary: grahamy.answerText,
        bullets: [],
        watchpoints: [],
        disclaimer: DEFAULT_DISCLAIMER,
      };
      next.ui = {
        cards: [],
        tables: [],
        suggestedFollowups: grahamy.suggestedFollowups,
      };
    }
    return patchFromAskGrahamyState(next);
  });
}
