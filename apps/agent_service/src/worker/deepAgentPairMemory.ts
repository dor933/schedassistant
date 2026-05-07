/**
 * Pair-scoped rolling memory for deep-agent delegations (slice 16).
 *
 * When a primary agent (the "caller") delegates to a system agent (the
 * "executor"), each delegation runs in a fresh thread row — but we want
 * the executor to behave as if there's a continuing conversation across
 * delegations from the same caller. The deepagents library used to do
 * this in-process via its checkpoint store; we replicate the *effect*
 * by:
 *
 *   1. Stamping `threads.user_id` with the CALLER's `agents.user_id`
 *      (a per-agent stable handle). The executor's own `agents.user_id`
 *      stays in use for episodic-memory vector partitioning — that's
 *      a separate concern (RAG store scoping vs. transcript scoping).
 *      The (caller_user_id, executor_agent_id) tuple uniquely identifies
 *      a pair without adding columns.
 *
 *   2. After each delegation finishes, summarising the single
 *      request/response into 3-5 sentences and storing it on the
 *      thread row's `summary` JSONB (existing column, reused with a
 *      `kind: "deep_agent_pair_turn"` discriminator so it doesn't
 *      collide with the primary-agent SessionSummary shape — different
 *      threadIds anyway, but the discriminator makes intent explicit).
 *
 *   3. On the next delegation between the same pair, loading the most
 *      recent K=3 prior summaries (newest threads first, then reversed
 *      to chronological) and rendering them as a "Prior conversations
 *      with this caller" section appended to the executor's system
 *      prompt. K=3 keeps the token budget bounded while preserving
 *      ~10-15 effective turns of compressed context — close enough to
 *      the deepagents-library "last N messages" behaviour.
 *
 * No migrations needed.
 */

import { Op } from "sequelize";
import { Thread } from "@scheduling-agent/database";
import { logger } from "../logger";
import { runAnthropicOneShot } from "../chat/anthropic/anthropicOneShot";
import { runCodexOneShot } from "../chat/codex/codexOneShot";
import {
  shouldUseAgentSdk,
} from "../chat/anthropic/agentSdkRunner";
import { shouldUseCodexSdk } from "../chat/codex/codexSdkRunner";
import { loadCodexAuthObjectForAgentWithOrg } from "../utils/codexAuthJson.service";
import type { ResolvedOrgVendor } from "../utils/resolveOrgVendor.service";

/** Default summary lookback for the "Prior conversations" injection. */
const PRIOR_PAIR_SUMMARY_LIMIT = 3;

/**
 * Discriminator stored on `threads.summary` so a future reader can tell
 * the deep-agent rolling summary apart from the primary-agent
 * SessionSummary shape (which uses different fields). Reusing the
 * column avoids a migration; the discriminator avoids confusion.
 */
export interface DeepAgentPairTurnSummary {
  kind: "deep_agent_pair_turn";
  text: string;
  generatedAt: string;
}

function isPairTurnSummary(v: unknown): v is DeepAgentPairTurnSummary {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    o.kind === "deep_agent_pair_turn" &&
    typeof o.text === "string" &&
    typeof o.generatedAt === "string"
  );
}

/**
 * Loads the last K rolling-summary records for the (caller, executor)
 * pair. Reverses to chronological so the rendered block reads top-down
 * oldest-first.
 *
 * `callerUserId` is `agents.user_id` of the caller — the same value
 * we stamped onto `threads.user_id` when the prior delegation started.
 * Returns an empty array when no prior summaries exist (first delegation
 * between this pair, or summarisation failed every previous time).
 */
export async function loadPriorPairSummaries(
  callerUserId: number,
  executorAgentId: string,
  options?: { limit?: number },
): Promise<DeepAgentPairTurnSummary[]> {
  const limit = options?.limit ?? PRIOR_PAIR_SUMMARY_LIMIT;
  try {
    const rows = await Thread.findAll({
      where: {
        userId: callerUserId,
        agentId: executorAgentId,
        summary: { [Op.ne]: null },
      },
      order: [["updatedAt", "DESC"]],
      limit,
      attributes: ["id", "summary", "updatedAt"],
    });
    const summaries: DeepAgentPairTurnSummary[] = [];
    for (const r of rows) {
      if (isPairTurnSummary(r.summary)) summaries.push(r.summary);
    }
    return summaries.reverse();
  } catch (err) {
    logger.warn(
      "deepAgentPairMemory: loadPriorPairSummaries failed (returning empty)",
      {
        callerUserId,
        executorAgentId,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return [];
  }
}

/**
 * Renders the prior-summary block to inject into the executor's system
 * prompt. Returns an empty string when there are no prior summaries —
 * caller can append unconditionally.
 */
export function renderPriorPairSummariesBlock(
  summaries: DeepAgentPairTurnSummary[],
): string {
  if (summaries.length === 0) return "";
  const lines = summaries.map(
    (s, i) =>
      `${i + 1}. (${s.generatedAt}) ${s.text.replace(/\s+/g, " ").trim()}`,
  );
  return (
    `\n## Prior conversations with this caller\n` +
    `Compact summaries of your last ${summaries.length} delegation(s) from the ` +
    `same caller agent, oldest first. Treat them as background context — the ` +
    `current task is what you actually need to answer.\n\n` +
    lines.join("\n") +
    `\n`
  );
}

/**
 * Generates a 3-5 sentence rolling summary for a single delegation
 * exchange and persists it onto `threads.summary`. Fire-and-forget
 * from the caller's perspective — failure is logged but never
 * propagated, so a summarisation hiccup can't block the executor's
 * result reaching the primary.
 *
 * Picks the matching one-shot SDK by vendor (Anthropic SDK for
 * Anthropic-vendor executors, Codex SDK for OpenAI). Both kill switches
 * are honoured: when the SDK is disabled we just skip summarisation
 * for this delegation. (We deliberately don't fall back to LangChain
 * `withStructuredOutput` here — the summary is a nice-to-have that
 * disappears with the SDK rather than blocking the worker.)
 */
export async function summariseAndStorePairTurn(args: {
  threadId: string;
  vendor: ResolvedOrgVendor;
  modelSlug: string;
  request: string;
  resultText: string;
  /** Caller's `agents.user_id`, used only for log/trace context here. */
  callerUserId: number;
  /** Executor agent id, only for logging. */
  executorAgentId: string;
  /**
   * Executor's organization id — needed to resolve the Codex auth_object
   * fallback for OpenAI executors that authenticate via ChatGPT-account
   * login (slice 14). Anthropic path doesn't need this.
   */
  executorAgentForAuth: string | null;
}): Promise<void> {
  const useAnthropic =
    args.vendor.vendorSlug === "anthropic" && shouldUseAgentSdk(args.vendor.vendorSlug);
  const useCodex =
    args.vendor.vendorSlug === "openai" && shouldUseCodexSdk(args.vendor.vendorSlug);

  if (!useAnthropic && !useCodex) {
    logger.debug(
      "deepAgentPairMemory: skipping summary (no SDK available for vendor)",
      { vendor: args.vendor.vendorSlug, threadId: args.threadId },
    );
    return;
  }

  const systemPrompt =
    "You produce compact rolling summaries of agent-to-agent delegations. " +
    "Given the request a primary agent sent to a specialist and the specialist's " +
    "final response, write 3 to 5 plain prose sentences capturing what was asked " +
    "and what was delivered. No markdown, no bullets, no preamble — just the " +
    "summary. Stick to facts; do not invent details.";
  const userPrompt =
    `## Caller's request\n${args.request.trim()}\n\n` +
    `## Specialist's response\n${args.resultText.trim()}`;

  let summaryText: string;
  try {
    if (useAnthropic) {
      summaryText = await runAnthropicOneShot({
        credential: args.vendor.apiKey ?? "",
        keyType: args.vendor.keyType,
        model: args.modelSlug,
        systemPrompt,
        userPrompt,
      });
    } else {
      // Codex one-shot needs the auth_object when the org is on the
      // ChatGPT-account login path (slice 14). Falls back to the api_key
      // row when no auth_object exists.
      const codexAuth = await loadCodexAuthObjectForAgentWithOrg(
        args.executorAgentForAuth,
      );
      const codexAuthObject = codexAuth?.authObject ?? null;
      summaryText = await runCodexOneShot({
        apiKey: codexAuthObject ? null : (args.vendor.apiKey ?? null),
        authObject: codexAuthObject,
        authObjectOrganizationId: codexAuth?.organizationId ?? null,
        model: args.modelSlug,
        systemPrompt,
        userPrompt,
      });
    }
  } catch (err) {
    logger.warn(
      "deepAgentPairMemory: summarisation failed (skipping persistence)",
      {
        threadId: args.threadId,
        vendor: args.vendor.vendorSlug,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return;
  }

  const trimmed = (summaryText ?? "").trim();
  if (!trimmed) {
    logger.warn(
      "deepAgentPairMemory: empty summary returned (skipping persistence)",
      { threadId: args.threadId },
    );
    return;
  }

  const payload: DeepAgentPairTurnSummary = {
    kind: "deep_agent_pair_turn",
    text: trimmed,
    generatedAt: new Date().toISOString(),
  };

  try {
    await Thread.update(
      { summary: payload as unknown as Record<string, unknown> } as any,
      { where: { id: args.threadId } },
    );
  } catch (err) {
    logger.warn(
      "deepAgentPairMemory: persisting summary failed (non-fatal)",
      {
        threadId: args.threadId,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }
}
