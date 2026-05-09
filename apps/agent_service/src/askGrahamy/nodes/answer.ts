import { observeToolCall } from "../../langfuse";
import { renderAnalystBriefToAnswer } from "../analystBriefRenderer";
import { synthesizeAnalystBriefFromEvidencePack } from "../analystBriefSynthesizer";
import { runGrahamyDeepAgent } from "../grahamyAgent";
import { buildEvidencePackFromWorkflowExecution } from "../workflowEvidencePack";
import { buildHelpAnswer, genericHelpFollowUps } from "../helpAnswer";
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
    // Platform_help short-circuit: deterministic help-topic answer rendered
    // from server-side data (canonical sectors / industries) plus a curated
    // capability inventory. Skips the deep agent and the workflow path.
    if (next.classification?.intent === "platform_help") {
      const help = await observeToolCall(
        "ask_grahamy_help_answer",
        {
          message: next.message,
          helpTopic: next.classification?.helpTopic ?? "overview",
        },
        () =>
          buildHelpAnswer(
            next.classification?.helpTopic ?? "overview",
            next.message,
          ),
      );
      next.warnings.push(...help.warnings);
      next.answer = help.answer;
      next.ui = help.ui;
      return patchFromAskGrahamyState(next);
    }
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
      // Unknown-intent turns previously left the user with a "couldn't
      // classify" warning and no clear next step. Inject the help-topic
      // suggestions so they have a deterministic on-ramp into the
      // platform_help flow regardless of what the deep agent emitted.
      const followUps =
        next.classification?.intent === "unknown"
          ? mergeFollowUps(grahamy.suggestedFollowups, genericHelpFollowUps())
          : grahamy.suggestedFollowups;
      next.ui = {
        cards: [],
        tables: [],
        suggestedFollowups: followUps,
      };
    }
    return patchFromAskGrahamyState(next);
  });
}

/**
 * Merge the agent's own suggested follow-ups (if any) with the generic
 * help-topic prompts, deduped and capped at 5. Agent-emitted follow-ups
 * lead so they stay turn-specific where relevant.
 */
function mergeFollowUps(
  agent: string[],
  fallback: string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of [...agent, ...fallback]) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= 5) break;
  }
  return out;
}
