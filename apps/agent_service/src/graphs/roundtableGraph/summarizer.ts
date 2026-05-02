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
import { anthropicBaseConfig } from "../../chat/anthropic/anthropicContextManagement";
import { resolveOrgVendor } from "../../utils/resolveOrgVendor.service";
import {
  observeWithContext,
  getLangfuseCallbackHandler,
  flushLangfuse,
} from "../../langfuse";
import { logger } from "../../logger";
import { runCodexOneShot } from "../../chat/codex/codexOneShot";
import { loadCodexAuthObjectForAgent } from "../../utils/codexAuthJson.service";
import { shouldUseCodexSdk } from "../../chat/codex/codexSdkRunner";
import { runAnthropicOneShot } from "../../chat/anthropic/anthropicOneShot";
import { shouldUseAgentSdk } from "../../chat/anthropic/agentSdkRunner";

/**
 * Builds a LangChain `BaseChatModel` for the non-Codex paths
 * (Anthropic, Google, and the kill-switch fallback to ChatOpenAI).
 * The OpenAI happy path no longer reaches this — it goes through
 * `runCodexOneShot` below — but we keep ChatOpenAI here so
 * `CODEX_SDK_DISABLED=1` cleanly falls back without code changes.
 */
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
  // Per slice 14: OpenAI may store its credential as a structured Codex
  // auth.json blob (key_type='auth_object') instead of a plain API key.
  // Look up the auth_object alongside the api_key so we can satisfy the
  // "must have at least one credential" check whichever path the org
  // configured.
  const codexAuthObject =
    vendor.vendorSlug === "openai"
      ? await loadCodexAuthObjectForAgent(primaryAgentId)
      : null;
  if (!vendor.apiKey && !codexAuthObject) {
    throw new Error(
      `Cannot summarize roundtable: this organization has not configured an API key for ${vendor.vendorSlug}`,
    );
  }

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

  // ── Vendor branch ────────────────────────────────────────────────────
  // Each vendor runs through its own native SDK in a tool-less one-shot:
  //   - openai    → Codex SDK
  //   - anthropic → Claude Agent SDK (covers both API-key and OAuth-token
  //                 orgs; ChatAnthropic only handles API keys, so the
  //                 SDK path is the only thing that works for Pro/Max
  //                 subscription billing).
  //   - google or kill-switch fallback → LangChain `model.invoke`.
  // No structured output here — roundtable summaries are plain prose,
  // so the SDK branches just return the text directly.
  let text: string;
  const useCodex =
    vendor.vendorSlug === "openai" && shouldUseCodexSdk(vendor.vendorSlug);
  const useAnthropicSdk =
    vendor.vendorSlug === "anthropic" && shouldUseAgentSdk(vendor.vendorSlug);
  const observeMeta = {
    roundtableId,
    threadId: roundtable.threadId,
    participantCount: agents.length,
    messageCount: messages.length,
    topicPreview:
      typeof roundtable.topic === "string"
        ? roundtable.topic.substring(0, 200)
        : "",
  };

  if (useCodex) {
    text = await observeWithContext(
      "roundtable_summary",
      () =>
        runCodexOneShot({
          // Prefer auth_object when configured — same priority rule as
          // the Codex SDK runner. Falls back to the api_key row when
          // the org only configured a plain OpenAI key.
          apiKey: codexAuthObject ? null : (vendor.apiKey ?? null),
          authObject: codexAuthObject,
          model: modelSlug,
          systemPrompt: SYSTEM_PROMPT,
          userPrompt,
        }),
      observeMeta,
    );
    if (!text || text.trim().length === 0) {
      text = "_The model did not produce a summary._";
    }
  } else if (useAnthropicSdk) {
    text = await observeWithContext(
      "roundtable_summary",
      () =>
        runAnthropicOneShot({
          credential: vendor.apiKey ?? "",
          keyType: vendor.keyType,
          model: modelSlug,
          systemPrompt: SYSTEM_PROMPT,
          userPrompt,
        }),
      observeMeta,
    );
    if (!text || text.trim().length === 0) {
      text = "_The model did not produce a summary._";
    }
  } else {
    // The LangChain fallback path can't speak the auth_object protocol —
    // it expects a plain key string in env-var-style auth. If we landed
    // here it's because the SDK was kill-switched off; require a real
    // api_key row to be configured.
    if (!vendor.apiKey) {
      throw new Error(
        `Cannot summarize roundtable: SDK fallback requires an api_key for ${vendor.vendorSlug}, but the org only has an auth_object.`,
      );
    }
    const model = getModel(modelSlug, vendor.vendorSlug, vendor.apiKey);
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
      observeMeta,
    );
    const raw = response.content;
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
  }

  try {
    await flushLangfuse();
  } catch {
    /* flush errors are logged inside flushLangfuse */
  }

  logger.info("Roundtable summary generated", {
    roundtableId,
    modelSlug,
    vendor: vendor.vendorSlug,
    runtime: useCodex
      ? "codex_one_shot"
      : useAnthropicSdk
        ? "anthropic_one_shot"
        : "langchain",
    summaryLen: text.length,
  });

  return text;
}
