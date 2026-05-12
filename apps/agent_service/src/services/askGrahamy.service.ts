import crypto from "node:crypto";
import { logger } from "../logger";
import { observeWithContext } from "../langfuse";
import {
  resolveDefaultClientApplication,
  resolveOrCreateClientUser,
} from "../utils/clientApplicationUser.service";
import { runAskGrahamyGraph } from "../askGrahamy/graph";
import { runAskGrahamyLandingWarmGraph } from "../askGrahamy/landingWarmGraph";
import { classifyMessage } from "../askGrahamy/classification";
import type { RunAskGrahamyGraphOptions } from "../askGrahamy/askGrahamyState";
import type {
  AskGrahamyClassifyRequest,
  AskGrahamyClassifyResponse,
  AskGrahamyRequest,
  AskGrahamyResponse,
} from "../askGrahamy/types";

export type RunAskGrahamyForExternalUserResult =
  | { ok: true; response: AskGrahamyResponse }
  | { ok: false; status: number; error: string };

export type ClassifyAskGrahamyResult =
  | { ok: true; response: AskGrahamyClassifyResponse }
  | { ok: false; status: number; error: string };

/**
 * REST entry orchestration for `/api/ask-grahamy`:
 *
 *   1. Resolves the default `client_applications` row (configured via
 *      DEFAULT_CLIENT_APPLICATION_ID) — the upstream caller has already been
 *      authenticated by the `requireApplicationToken` middleware, so this row
 *      is the implicit identity behind that token.
 *   2. JIT-resolves the upstream client app's `userId` (an external string)
 *      to an internal `users.id` so conversation persistence and any future
 *      FK references use the canonical internal identifier.
 *   3. Runs the Ask Grahamy graph with the resolved internal id.
 *
 * Returns a discriminated envelope so the controller can shape the HTTP
 * response without leaking infrastructure details.
 */
export async function runAskGrahamyForExternalUser(
  request: AskGrahamyRequest,
  graphOptions: RunAskGrahamyGraphOptions = {},
): Promise<RunAskGrahamyForExternalUserResult> {
  const clientApplication = await resolveDefaultClientApplication();
  if (!clientApplication) {
    logger.error(
      "Ask Grahamy: DEFAULT_CLIENT_APPLICATION_ID is missing or refers to a non-existent row",
    );
    return {
      ok: false,
      status: 500,
      error: "Server is not configured for client-app requests.",
    };
  }

  const user = await resolveOrCreateClientUser({
    clientApplication,
    externalUserId: request.userId,
  });

  try {
    const response = await runAskGrahamyGraph(request, user.id, graphOptions);
    return { ok: true, response };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Ask Grahamy graph failed", {
      error: message,
      userId: user.id,
      conversationId: request.conversationId,
    });
    return { ok: false, status: 500, error: message };
  }
}

/**
 * Worker-only entry for the nightly landing/ranking graph. It shares the
 * same client-user resolution as the live graph for traceability, but calls
 * a separate LangGraph compiled workflow where expensive capability SQL and
 * Research Object fanout are allowed.
 */
export async function runAskGrahamyLandingWarmForExternalUser(
  request: AskGrahamyRequest,
  graphOptions: RunAskGrahamyGraphOptions = {},
): Promise<RunAskGrahamyForExternalUserResult> {
  const clientApplication = await resolveDefaultClientApplication();
  if (!clientApplication) {
    logger.error(
      "Ask Grahamy landing warm: DEFAULT_CLIENT_APPLICATION_ID is missing or refers to a non-existent row",
    );
    return {
      ok: false,
      status: 500,
      error: "Server is not configured for client-app requests.",
    };
  }

  const user = await resolveOrCreateClientUser({
    clientApplication,
    externalUserId: request.userId,
  });

  try {
    const response = await runAskGrahamyLandingWarmGraph(
      request,
      user.id,
      graphOptions,
    );
    return { ok: true, response };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Ask Grahamy landing warm graph failed", {
      error: message,
      userId: user.id,
      conversationId: request.conversationId,
    });
    return { ok: false, status: 500, error: message };
  }
}

/**
 * Classify-only entry point for `POST /api/ask-grahamy/classify`. The
 * upstream caller (StocksScanner) hits this first, then uses the returned
 * `classification.symbols` / `sectors` to look up its existing research
 * objects, then makes the main `POST /api/ask-grahamy` call with both the
 * classification and the prior research objects bundled in.
 *
 * Loads previousContext from the conversation store so follow-up classifying
 * benefits from prior turn anchors, exactly like the main graph does.
 */
export async function classifyAskGrahamy(
  request: AskGrahamyClassifyRequest,
): Promise<ClassifyAskGrahamyResult> {
  const clientApplication = await resolveDefaultClientApplication();
  if (!clientApplication) {
    logger.error(
      "Ask Grahamy classify: DEFAULT_CLIENT_APPLICATION_ID is missing or refers to a non-existent row",
    );
    return {
      ok: false,
      status: 500,
      error: "Server is not configured for client-app requests.",
    };
  }

  const user = await resolveOrCreateClientUser({
    clientApplication,
    externalUserId: request.userId,
  });

  const conversationId = request.conversationId || crypto.randomUUID();

  try {
    // SS extracts the prior assistant turn's anchors from `ask_messages`
    // and passes them as `previousContext`. The classifier uses them as
    // hints so that anchor-less follow-ups ("compare to peers", "why?",
    // "מה לגבי המתחרים") resolve to the prior turn's symbols/sectors
    // instead of returning "unknown". Pure intra-conversation memory
    // still lives in PostgresSaver inside the deep agent — this is just
    // for fetching the right Research Objects on the SS side.
    const previousContext = request.previousContext
      ? {
          conversationId,
          userId: user.id,
          lastSymbols: request.previousContext.lastSymbols ?? [],
          lastSectors: request.previousContext.lastSectors ?? [],
          lastIndustries: request.previousContext.lastIndustries ?? [],
          lastIntent: request.previousContext.lastIntent as
            | undefined
            | import("../askGrahamy/types").Intent,
          lastSuggestedFollowups: [] as string[],
          updatedAt: new Date().toISOString(),
        }
      : undefined;
    logger.info("Ask Grahamy classify", {
      userId: user.id,
      conversationId,
      messagePreview: request.message.slice(0, 80),
      previousContextSupplied: !!previousContext,
      previousContextSymbols: previousContext?.lastSymbols ?? [],
      previousContextSectors: previousContext?.lastSectors ?? [],
      previousContextIndustries: previousContext?.lastIndustries ?? [],
    });
    const classification = await observeWithContext(
      "ask_grahamy_classify",
      async () =>
        classifyMessage(request.message, previousContext, {
          traceContext: {
            userId: user.id,
            metadata: {
              service: "ask_grahamy_classify",
              conversationId,
              previousContextSupplied: !!previousContext,
              previousContextSymbols: previousContext?.lastSymbols ?? [],
              previousContextSectors: previousContext?.lastSectors ?? [],
              previousContextIndustries: previousContext?.lastIndustries ?? [],
            },
          },
        }),
      {
        message: request.message,
        conversationId,
        userId: user.id,
        previousContextSymbols: previousContext?.lastSymbols ?? [],
        previousContextSectors: previousContext?.lastSectors ?? [],
        previousContextIndustries: previousContext?.lastIndustries ?? [],
      },
    );
    logger.info("Ask Grahamy classify result", {
      conversationId,
      intent: classification.intent,
      symbols: classification.symbols,
      sectors: classification.sectors,
      confidence: classification.confidence,
      isFollowUp: classification.isFollowUp,
    });
    return {
      ok: true,
      response: { conversationId, classification },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Ask Grahamy classify failed", {
      error: message,
      userId: user.id,
      conversationId,
    });
    return { ok: false, status: 500, error: message };
  }
}
