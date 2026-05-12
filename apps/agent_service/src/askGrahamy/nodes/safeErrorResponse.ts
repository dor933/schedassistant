import { finalizeSafeGraphError } from "./finalizeResponse";
import {
  type AskGrahamyGraphState,
  type AskGrahamyLangGraphState,
  patchFromAskGrahamyState,
  toAskGrahamyState,
} from "../state/askGrahamyState";

export async function safeErrorResponseNode(
  state: AskGrahamyLangGraphState,
): Promise<Partial<AskGrahamyGraphState>> {
  const next = toAskGrahamyState(state);
  const response = await finalizeSafeGraphError(
    next,
    new Error(state.error ?? "Unknown Ask Grahamy graph error."),
  );
  return {
    ...patchFromAskGrahamyState(next),
    response,
  };
}
