import type { Request, Response } from "express";
import { logger } from "../logger";
import {
  classifyAskGrahamy,
  runAskGrahamyForExternalUser,
} from "../services/askGrahamy.service";
import {
  askGrahamyClassifyRequestSchema,
  askGrahamyRequestSchema,
  EMPTY_CLASSIFICATION,
  EMPTY_PUBLIC_RESEARCH_VIEW,
  type AskGrahamyResponse,
} from "../askGrahamy/types";
import { buildSafeErrorAnswer } from "../askGrahamy/answerTemplates";

/**
 * POST /api/ask-grahamy
 *
 * Body:
 *   {
 *     "userId": "<upstream client-app user id>",  // required, string
 *     "conversationId": "<uuid>",                 // optional
 *     "message": "...",                           // required, <= 4000 chars
 *     "classification": { ... }                    // required; call /classify first
 *   }
 *
 * Service-to-service auth (header `x-application-agent-token`) is enforced
 * by `requireApplicationToken` middleware applied at the router. The
 * upstream caller has already authenticated the end user; this handler
 * trusts the supplied `userId` and JIT-resolves it internally.
 *
 * Always returns the full `AskGrahamyResponse` envelope (even on error) so
 * the caller can render a "safe" answer without special-casing failures.
 */
export class AskGrahamyController {
  /**
   * POST /api/ask-grahamy/classify
   *
   * Body: { userId, message, conversationId? }
   *
   * Returns the structured classification (symbols, sectors, regimeRequested,
   * intent, confidence, etc.) without running the full askGrahamy graph.
   * The upstream caller uses this to look up its own existing research
   * objects before making the main `/api/ask-grahamy` call.
   *
   * Distinct response shape from `ask` — this is NOT an AskGrahamyResponse,
   * it's a small `{ conversationId, classification }` envelope.
   */
  classify = async (req: Request, res: Response) => {
    const parsed = askGrahamyClassifyRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        error: "userId and non-empty message are required. conversationId is optional.",
      });
    }

    try {
      const result = await classifyAskGrahamy(parsed.data);
      if (!result.ok) {
        return res.status(result.status).json({ ok: false, error: result.error });
      }
      return res.status(200).json({ ok: true, ...result.response });
    } catch (err) {
      logger.error("Ask Grahamy classify controller error", {
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : "Ask Grahamy classify failed.",
      });
    }
  };

  ask = async (req: Request, res: Response) => {
    const parsed = askGrahamyRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(
        buildSafeErrorEnvelope("", "Invalid request payload.", {
          headline: "Invalid Ask Grahamy request.",
          summary:
            "userId, non-empty message, and classification are required. Call /api/ask-grahamy/classify first.",
        }),
      );
    }

    const conversationId = parsed.data.conversationId ?? "";

    try {
      const result = await runAskGrahamyForExternalUser(parsed.data);
      if (!result.ok) {
        return res
          .status(result.status)
          .json(buildSafeErrorEnvelope(conversationId, result.error));
      }
      return res.status(200).json(result.response);
    } catch (err) {
      logger.error("Ask Grahamy controller error", {
        error: err instanceof Error ? err.message : String(err),
      });
      return res
        .status(500)
        .json(buildSafeErrorEnvelope(conversationId, "Ask Grahamy failed safely."));
    }
  };
}

/**
 * Builds the standard error envelope. Every error path returns the full
 * `AskGrahamyResponse` shape so the caller can render uniformly — see
 * `formatAskGrahamyAnswer` on the StocksScanner side.
 */
function buildSafeErrorEnvelope(
  conversationId: string,
  warning: string,
  answerOverrides: Partial<AskGrahamyResponse["answer"]> = {},
): AskGrahamyResponse {
  return {
    conversationId,
    messageId: "",
    answerType: "error",
    classification: EMPTY_CLASSIFICATION,
    answer: { ...buildSafeErrorAnswer(), ...answerOverrides },
    research: { publicResearchView: EMPTY_PUBLIC_RESEARCH_VIEW },
    ui: { cards: [], tables: [], suggestedFollowups: [] },
    meta: {
      sourcesUsed: [],
      freshness: {},
      warnings: [warning],
      toolsUsed: [],
      moatGuardResult: "clean",
    },
  };
}
