import type { Request, Response } from "express";
import { logger } from "../logger";
import { askGrahamyRequestSchema, EMPTY_CLASSIFICATION, EMPTY_PUBLIC_RESEARCH_VIEW } from "./types";
import { buildSafeErrorAnswer } from "./answerTemplates";
import { runAskGrahamyGraph } from "./graph";

export async function handleAskGrahamy(req: Request, res: Response): Promise<Response> {
  const parsed = askGrahamyRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      conversationId: "",
      messageId: "",
      answerType: "error",
      classification: EMPTY_CLASSIFICATION,
      answer: {
        ...buildSafeErrorAnswer(),
        headline: "Invalid Ask Grahamy request.",
        summary: "userId and non-empty message are required. conversationId is optional.",
      },
      research: { publicResearchView: {} },
      ui: { cards: [], tables: [], suggestedFollowups: [] },
      meta: {
        sourcesUsed: [],
        freshness: {},
        warnings: ["Invalid request payload."],
        toolsUsed: [],
        moatGuardResult: "clean",
      },
    });
  }

  try {
    const result = await runAskGrahamyGraph(parsed.data);
    return res.status(200).json(result);
  } catch (err) {
    logger.error("Ask Grahamy HTTP handler failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({
      conversationId: parsed.data.conversationId ?? "",
      messageId: "",
      answerType: "error",
      classification: EMPTY_CLASSIFICATION,
      answer: buildSafeErrorAnswer(),
      research: { publicResearchView: EMPTY_PUBLIC_RESEARCH_VIEW },
      ui: { cards: [], tables: [], suggestedFollowups: [] },
      meta: {
        sourcesUsed: [],
        freshness: {},
        warnings: ["Ask Grahamy failed safely."],
        toolsUsed: [],
        moatGuardResult: "clean",
      },
    });
  }
}

