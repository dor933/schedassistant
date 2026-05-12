import crypto from "node:crypto";
import type { Request, Response } from "express";
import { logger } from "../logger";
import {
  classifyAskGrahamy,
  runAskGrahamyLandingWarmForExternalUser,
  runAskGrahamyForExternalUser,
} from "../services/askGrahamy.service";
import {
  askGrahamyClassifyRequestSchema,
  askGrahamyLandingWarmRequestSchema,
  askGrahamyRequestSchema,
  EMPTY_CLASSIFICATION,
  EMPTY_PUBLIC_RESEARCH_VIEW,
  type AskGrahamyResponse,
} from "../askGrahamy/types";
import { buildSafeErrorAnswer } from "../askGrahamy/answers/answerTemplates";
import { getAskBridgeIO } from "../askBridgeSocket";

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

  /**
   * POST /api/ask-grahamy/landing-warm
   *
   * Worker-only async submit endpoint. Returns 202 immediately and emits
   * `ask:landing-warm-complete` on the ask-bridge socket when the nightly
   * graph finishes. This avoids binding BullMQ cron duration to HTTP/socket
   * request timeouts while still returning the final cache payload to SS for
   * persistence.
   */
  landingWarm = async (req: Request, res: Response) => {
    const rawBody =
      req.body && typeof req.body === "object"
        ? (req.body as Record<string, unknown>)
        : {};
    const requestId =
      typeof rawBody.requestId === "string" && rawBody.requestId.trim()
        ? rawBody.requestId.trim()
        : crypto.randomUUID();
    const { requestId: _stripped, ...requestBody } = rawBody;
    void _stripped;

    const parsed = askGrahamyLandingWarmRequestSchema.safeParse(
      requestBody,
    );
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        error:
          "Invalid landing warm payload — userId, message, and classification are required.",
      });
    }

    const acceptedAt = new Date().toISOString();
    res.status(202).json({ ok: true, requestId, acceptedAt });

    void (async () => {
      try {
        const result = await runAskGrahamyLandingWarmForExternalUser(
          parsed.data,
        );
        emitLandingWarmComplete(
          result.ok
            ? { requestId, ok: true, response: result.response }
            : {
                requestId,
                ok: false,
                status: result.status,
                error: result.error,
              },
        );
      } catch (err) {
        logger.error("Ask Grahamy landing warm background error", {
          requestId,
          error: err instanceof Error ? err.message : String(err),
        });
        emitLandingWarmComplete({
          requestId,
          ok: false,
          status: 500,
          error: err instanceof Error ? err.message : "landing warm failed",
        });
      }
    })();
  };
}

function emitLandingWarmComplete(
  payload:
    | { requestId: string; ok: true; response: AskGrahamyResponse }
    | { requestId: string; ok: false; status: number; error: string },
): void {
  try {
    getAskBridgeIO().of("/ask-bridge").emit("ask:landing-warm-complete", payload);
  } catch (err) {
    logger.warn("Ask Grahamy landing warm completion emit failed", {
      requestId: payload.requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
