import {
  type AskGrahamyGraphState,
  type AskGrahamyLangGraphState,
  patchFromAskGrahamyState,
  runGraphNode,
  toAskGrahamyState,
} from "../askGrahamyState";

export async function requireClassificationNode(
  state: AskGrahamyLangGraphState,
): Promise<Partial<AskGrahamyGraphState>> {
  return runGraphNode(state, async () => {
    const next = toAskGrahamyState(state);
    if (!next.classification) {
      throw new Error(
        "Ask Grahamy request must include classification. Call POST /api/ask-grahamy/classify first.",
      );
    }
    return patchFromAskGrahamyState(next);
  });
}
