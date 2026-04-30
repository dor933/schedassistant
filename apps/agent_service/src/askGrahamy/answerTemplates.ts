import {
  DEFAULT_DISCLAIMER,
  EMPTY_PUBLIC_RESEARCH_VIEW,
  type AnswerObject,
  type AnswerType,
  type PublicResearchView,
  type UiHints,
} from "./types";

/**
 * Static stubs for the three "no real answer to compose" paths. The full
 * conversational answer is now produced by `runGrahamyDeepAgent` (LLM with
 * PostgresSaver memory); these stubs only handle:
 *   - clarification: classifier emitted no anchors and no usable follow-up
 *   - unknown: classifier explicitly returned "unknown"
 *   - safe error: graph caught an exception before producing an answer
 */

export const DEFAULT_FOLLOWUPS = [
  "What are the main risks?",
  "How does this compare to peers?",
  "What would invalidate the thesis?",
  "How does this fit the current market regime?",
];

export function buildClarificationAnswer(): {
  answerType: AnswerType;
  answer: AnswerObject;
  researchView: PublicResearchView;
  ui: UiHints;
} {
  return {
    answerType: "clarification",
    answer: {
      headline: "I need one more detail.",
      summary: "What stock, sector, or market theme should I explain?",
      bullets: [],
      watchpoints: [],
      disclaimer: DEFAULT_DISCLAIMER,
    },
    researchView: EMPTY_PUBLIC_RESEARCH_VIEW,
    ui: { cards: [], tables: [], suggestedFollowups: [] },
  };
}

export function buildUnknownAnswer(): {
  answerType: AnswerType;
  answer: AnswerObject;
  researchView: PublicResearchView;
  ui: UiHints;
} {
  return {
    answerType: "unknown",
    answer: {
      headline: "Ask about a stock, sector, or market regime.",
      summary:
        "I can answer when the question is anchored to a ticker, a sector, or the current market setup.",
      bullets: [],
      watchpoints: [],
      disclaimer: DEFAULT_DISCLAIMER,
    },
    researchView: EMPTY_PUBLIC_RESEARCH_VIEW,
    ui: { cards: [], tables: [], suggestedFollowups: [] },
  };
}

export function buildSafeErrorAnswer(): AnswerObject {
  return {
    headline: "Ask Grahamy is temporarily unavailable.",
    summary:
      "The request could not be completed safely. Please try again, or ask a narrower stock, sector, or regime question.",
    bullets: [],
    watchpoints: [
      "If this continues, check snapshot freshness and schedassistant upstream connectivity.",
    ],
    disclaimer: DEFAULT_DISCLAIMER,
  };
}
