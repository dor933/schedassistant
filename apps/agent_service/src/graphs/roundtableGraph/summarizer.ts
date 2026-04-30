import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogle } from "@langchain/google";
import { ChatAnthropic } from "@langchain/anthropic";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  Roundtable,
  RoundtableAgent,
  RoundtableMessage,
} from "@scheduling-agent/database";
import type { RunnableConfig } from "@langchain/core/runnables";
import { resolveModelSlug } from "../../chat/modelResolution";
import { anthropicBaseConfig } from "../../chat/anthropicContextManagement";
import { resolveOrgVendor } from "../../services/resolveOrgVendor";
import {
  observeWithContext,
  getLangfuseCallbackHandler,
  flushLangfuse,
} from "../../langfuse";
import { logger } from "../../logger";

function getModel(
  modelSlug: string,
  vendorSlug: string,
  apiKey: string,
): BaseChatModel {
  switch (vendorSlug) {
    case "openai":
      return new ChatOpenAI({ modelName: modelSlug, apiKey });
    case "anthropic":
      return new ChatAnthropic({
        modelName: modelSlug,
        apiKey,
        ...(process.env.MERIDIAN_URL
          ? { anthropicApiUrl: process.env.MERIDIAN_URL }
          : {}),
        ...anthropicBaseConfig(),
      });
    case "google":
      return new ChatGoogle({ model: modelSlug, apiKey });
    default:
      throw new Error(
        `Unsupported vendor "${vendorSlug}" for model "${modelSlug}"`,
      );
  }
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert discussion analyst. You will be given the transcript of a \
multi-agent roundtable discussion on a specific topic. Produce a concise, well-structured \
summary that captures the substance of the debate — not a blow-by-blow recap.

Your summary MUST follow this exact markdown structure:

## Topic
One sentence restating the topic in your own words.

## Key Points
Three to six bullets capturing the most important substantive points raised, regardless of \
which agent said them. Each bullet should stand on its own.

## Agreements
Bullets of points where participants clearly converged. Omit the section if there were none.

## Disagreements & Open Questions
Bullets of unresolved tensions, contested claims, or questions nobody answered. Omit if none.

## Per-Agent Contributions
One short bullet per participant naming their distinct angle or contribution. Skip agents \
who only restated others.

Keep the entire summary under ~350 words. Be specific. Do not invent facts that aren't in \
the transcript. Do not editorialize or add recommendations.`;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Generates a final-summary string for a completed roundtable by making a
 * single LLM call over the full transcript. Does not persist anything — the
 * caller is responsible for writing it to the roundtable row and for pushing
 * it into each participant's episodic memory.
 *
 * The summarizer uses the first participating agent's configured model so
 * it respects the user's vendor/model choice without introducing a new
 * configuration surface.
 */
export async function summarizeRoundtable(
  roundtableId: string,
  options: { userId?: number } = {},
): Promise<string> {
  const roundtable = await Roundtable.findByPk(roundtableId);
  if (!roundtable) {
    throw new Error(`Roundtable ${roundtableId} not found`);
  }

  const agents = await RoundtableAgent.findAll({
    where: { roundtableId },
    order: [["turnOrder", "ASC"]],
    include: [{ association: "agent", attributes: ["definition", "agentName"] }],
  });

  const messages = await RoundtableMessage.findAll({
    where: { roundtableId },
    order: [["createdAt", "ASC"]],
    include: [
      { association: "agent", attributes: ["definition", "agentName"] },
      { association: "user", attributes: ["id", "displayName"] },
    ],
  });

  if (messages.length === 0) {
    return "_The roundtable ended without any messages to summarize._";
  }

  // Pick a model from the first agent; falls back to the system default.
  // The org-scoped API key is looked up via that agent — all participants
  // in a roundtable are in the same org, so which one we pick doesn't matter
  // for key resolution.
  const primaryAgentId = agents[0]?.agentId ?? null;
  const modelSlug = await resolveModelSlug(primaryAgentId ?? undefined);
  const vendor = await resolveOrgVendor(modelSlug, primaryAgentId);
  if (!vendor) {
    throw new Error(
      `Cannot summarize roundtable: unknown model "${modelSlug}" or no organization on the primary agent`,
    );
  }
  if (!vendor.apiKey) {
    throw new Error(
      `Cannot summarize roundtable: this organization has not configured an API key for ${vendor.vendorSlug}`,
    );
  }
  const model = getModel(modelSlug, vendor.vendorSlug, vendor.apiKey);

  // ── Build the transcript ──────────────────────────────────────────────
  const participantLines = agents.map((ra) => {
    const a = (ra as any).agent;
    const name = a?.agentName || a?.definition || ra.agentId;
    return `- ${name}`;
  });

  const transcriptLines = messages.map((m) => {
    const a = (m as any).agent;
    const u = (m as any).user;
    const name = m.userId != null
      ? (u?.displayName ? `${u.displayName} (user)` : "User")
      : a?.agentName || a?.definition || m.agentId;
    return `### Round ${m.roundNumber + 1} — ${name}\n${m.content.trim()}`;
  });

  const userPrompt =
    `**Topic:** ${roundtable.topic}\n\n` +
    `**Participants:**\n${participantLines.join("\n")}\n\n` +
    `**Transcript:**\n\n${transcriptLines.join("\n\n")}`;

  const langfuseHandler = getLangfuseCallbackHandler(options.userId, {
    roundtableId,
    threadId: roundtable.threadId,
    primaryAgentId,
    modelSlug,
    service: "agent_service",
    graph: "roundtable_summary",
  });

  const response = await observeWithContext(
    "roundtable_summary",
    () =>
      model.invoke(
        [new SystemMessage(SYSTEM_PROMPT), new HumanMessage(userPrompt)],
        langfuseHandler
          ? ({
              callbacks: [langfuseHandler],
            } as RunnableConfig)
          : undefined,
      ),
    {
      roundtableId,
      threadId: roundtable.threadId,
      participantCount: agents.length,
      messageCount: messages.length,
      topicPreview:
        typeof roundtable.topic === "string"
          ? roundtable.topic.substring(0, 200)
          : "",
    },
  );

  try {
    await flushLangfuse();
  } catch {
    /* flush errors are logged inside flushLangfuse */
  }

  const raw = response.content;
  let text: string;
  if (typeof raw === "string") {
    text = raw;
  } else if (Array.isArray(raw)) {
    text =
      raw
        .filter((b: any) => b?.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join("\n")
        .trim() || "_The model did not produce a summary._";
  } else {
    text = "_The model did not produce a summary._";
  }

  logger.info("Roundtable summary generated", {
    roundtableId,
    modelSlug,
    vendor: vendor.vendorSlug,
    summaryLen: text.length,
  });

  return text;
}
