import { createDeepAgent } from "deepagents";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { ChatOpenAI } from "@langchain/openai";
import { logger } from "../logger";
import { resolveOrgVendorByOrg } from "../services/resolveOrgVendor.service";
import { getLangfuseCallbackHandler, flushLangfuse } from "../langfuse";
import type { AskGrahamyState, CachedResearchObject } from "./types";

/**
 * Grahamy deep-agent runner.
 *
 * Mirrors the `applicationGraph/applicationCallModel.ts` pattern: a single
 * shared `PostgresSaver` keyed on a per-conversation `thread_id` provides
 * durable memory; a `createDeepAgent` instance is built per turn with the
 * resolved evidence pre-injected into the system prompt.
 *
 * Why not templated rendering? Earlier askGrahamy versions stamped a fixed
 * "data sheet" for every turn regardless of what the user asked. With this
 * agent, the LLM resolves the user's specific question against the supplied
 * Research Object evidence and the prior conversation history (recovered
 * from PostgresSaver via `thread_id = conversationId`).
 */

const ASK_GRAHAMY_ORG_ID =
  process.env.ASK_GRAHAMY_ORG_ID ?? "acf0cbab-3aed-42cf-872d-63cba24e61c3";

const ASK_GRAHAMY_ANSWER_MODEL =
  process.env.ASK_GRAHAMY_ANSWER_MODEL ?? "gpt-5.5";

const GRAHAMY_TIMEOUT_MS = Number(
  process.env.ASK_GRAHAMY_AGENT_TIMEOUT_MS ?? 60_000,
);

const GRAHAMY_RECURSION_LIMIT = Number(
  process.env.ASK_GRAHAMY_AGENT_RECURSION_LIMIT ?? 30,
);

let _checkpointer: PostgresSaver | null = null;

/** Module-singleton PG saver — shared with applicationGraph's saver via the
 *  same `checkpoints/checkpoint_blobs/checkpoint_writes` tables. The outer
 *  applicationGraph saver already calls `setup()` at startup (idempotent),
 *  so we don't re-run it here. */
function getCheckpointer(): PostgresSaver {
  if (_checkpointer) return _checkpointer;
  const cs =
    process.env.DATABASE_URL ??
    `postgres://${process.env.PGUSER ?? "scheduler"}:${process.env.PGPASSWORD ?? "scheduler_pass"}@${process.env.PGHOST ?? "localhost"}:${process.env.PGPORT ?? "5432"}/${process.env.PGDATABASE ?? "scheduler_agent"}`;
  _checkpointer = PostgresSaver.fromConnString(cs);
  return _checkpointer;
}

class GrahamyAgentTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `Grahamy agent timed out after ${Math.round(timeoutMs / 1000)} seconds`,
    );
    this.name = "GrahamyAgentTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new GrahamyAgentTimeoutError(ms)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function resolveGrahamyModel(): Promise<ChatOpenAI | null> {
  const vendor = await resolveOrgVendorByOrg(
    ASK_GRAHAMY_ANSWER_MODEL,
    ASK_GRAHAMY_ORG_ID,
  );
  if (!vendor) {
    logger.warn("Grahamy: model/org not resolvable", {
      model: ASK_GRAHAMY_ANSWER_MODEL,
      orgId: ASK_GRAHAMY_ORG_ID,
    });
    return null;
  }
  if (vendor.vendorSlug !== "openai") {
    logger.warn("Grahamy: expected openai vendor", { got: vendor.vendorSlug });
    return null;
  }
  if (!vendor.apiKey) {
    logger.warn("Grahamy: no api key for org", { orgId: ASK_GRAHAMY_ORG_ID });
    return null;
  }
  return new ChatOpenAI({
    modelName: ASK_GRAHAMY_ANSWER_MODEL,
    apiKey: vendor.apiKey,
  });
}

function formatResearchObjectForPrompt(ro: CachedResearchObject): string {
  const header = `## ${ro.objectType.toUpperCase()} — ${ro.anchor} (as of ${ro.asOfDate})`;
  // Pass both publicSummary (already bucketed) and the raw v6 parts. The
  // system-prompt MOAT discipline section instructs the LLM to use bands /
  // labels only and never invent raw numbers — the moatGuard step at the
  // end of the graph still scrubs forbidden patterns from the response.
  const body = JSON.stringify(
    { publicSummary: ro.publicSummary, parts: ro.parts },
    null,
    2,
  );
  return `${header}\n\`\`\`json\n${body}\n\`\`\``;
}

function buildSystemPrompt(state: AskGrahamyState): string {
  const ros = state.researchObjects ?? [];
  const classification = state.classification;
  const dailyBrief = state.snapshots?.daily_brief as Record<string, unknown> | undefined;
  const todayRegime = typeof dailyBrief?.regime === "string" ? dailyBrief.regime : undefined;
  const freshness = state.snapshots?.freshness;

  const evidence = ros.length === 0
    ? "(No specific Research Objects were loaded for this turn — answer from your conversational memory and acknowledge the limitation.)"
    : ros.map(formatResearchObjectForPrompt).join("\n\n");

  const classifiedLine = classification
    ? `Symbols: [${classification.symbols.join(", ") || "none"}], Sectors: [${classification.sectors.join(", ") || "none"}], Regime requested: ${classification.regimeRequested ? "yes" : "no"}`
    : "(no classification)";

  return `You are **Grahamy** — StocksScanner's AI stock-research assistant.

Your job is to answer the user's specific question, conversationally, using the bucketed evidence below. This is one turn in an ongoing conversation; your prior turns are in your memory (PostgresSaver thread).

# Style guide
- Be direct, conversational, and concise. Address the user's specific question — don't restate the entire data sheet on every turn.
- Use bullet points only when listing things; otherwise plain prose.
- For follow-ups like "why?", "what are the main risks?", "how does it compare?", focus on the relevant slice of evidence — don't redump everything.
- Reference earlier turns when natural ("as I mentioned about NVDA's ROIC trend...").
- End every response with: \`This is not financial advice.\`

# MOAT discipline (strict)
- Use ONLY the bucket labels, percentile bands, and direction descriptors from the EVIDENCE below. Acceptable: "in the high quintile of its sector", "FCF/NI poor conversion", "ROE above its 5-year history", "regime-challenged".
- DO NOT invent or report raw numbers — no specific PE multiples, revenue figures, prices, or hit-rate percentages.
- DO NOT mention internal terms: \`signal_sql\`, \`raw_alpha\`, edge IDs, methodology details, internal model names, or pipeline mechanics.
- If forward-return analog evidence has fewer than 30 observations, label it explicitly as low-confidence / small sample.

# Today's market backdrop
${todayRegime ? `Current regime: ${todayRegime}` : "Current regime: not available"}
${freshness?.dataThrough ? `Data through: ${freshness.dataThrough}` : ""}
${freshness?.staleReason ? `Freshness caveat: ${freshness.staleReason}` : ""}

# Classification for this turn
${classifiedLine}

# Evidence
${evidence}

Now answer the user's message naturally. If the user is asking a focused follow-up, do not re-list every section — answer their actual question and refer back to evidence as needed.`;
}

export type GrahamyAgentResult = {
  /** Free-form prose / markdown produced by the agent. Goes into
   *  AskGrahamyResponse.answer.summary. */
  answerText: string;
  warnings: string[];
};

export async function runGrahamyDeepAgent(
  state: AskGrahamyState,
): Promise<GrahamyAgentResult> {
  const chatModel = await resolveGrahamyModel();
  if (!chatModel) {
    return {
      answerText:
        "Grahamy is temporarily unavailable — the platform org's API key isn't configured.\n\nThis is not financial advice.",
      warnings: ["Grahamy answer model unavailable"],
    };
  }

  const systemPrompt = buildSystemPrompt(state);
  const checkpointer = getCheckpointer();

  const agent = createDeepAgent({
    model: chatModel as any,
    tools: [],
    systemPrompt,
    checkpointer,
  });

  const langfuseHandler = getLangfuseCallbackHandler(
    state.internalUserId !== undefined ? state.internalUserId : undefined,
    {
      service: "ask_grahamy",
      conversationId: state.conversationId ?? null,
    },
  );
  const tracedAgent = langfuseHandler
    ? agent.withConfig({ callbacks: [langfuseHandler] })
    : agent;

  // thread_id is the SS conversationId — each StocksScanner conversation =
  // one PostgresSaver thread. "New chat" in the UI = new conversationId =
  // fresh thread (clean memory). Within a conversation, the agent has full
  // recall of prior user/assistant turns.
  const threadId = state.conversationId
    ? `grahamy:${state.conversationId}`
    : `grahamy:user:${state.internalUserId}:default`;

  try {
    const result = await withTimeout(
      tracedAgent.invoke(
        { messages: [{ role: "user" as const, content: state.message }] },
        {
          configurable: {
            thread_id: threadId,
            user_id: String(state.internalUserId),
          },
          recursionLimit: GRAHAMY_RECURSION_LIMIT,
        },
      ),
      GRAHAMY_TIMEOUT_MS,
    );

    await flushLangfuse();

    const messages: any[] = Array.isArray((result as any)?.messages)
      ? (result as any).messages
      : [];
    const lastAi = [...messages].reverse().find(
      (m: any) =>
        (typeof m._getType === "function" && m._getType() === "ai") ||
        m.role === "assistant",
    );
    const text =
      typeof lastAi?.content === "string"
        ? lastAi.content
        : lastAi?.content
          ? JSON.stringify(lastAi.content)
          : "Grahamy did not produce a response.";

    return { answerText: text, warnings: [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Grahamy deep agent failed", {
      error: message,
      conversationId: state.conversationId,
      userId: state.internalUserId,
    });
    return {
      answerText:
        "Grahamy hit an error generating this answer. Please try again in a moment.\n\nThis is not financial advice.",
      warnings: [`Grahamy agent: ${message}`],
    };
  }
}
