import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogle } from "@langchain/google";
import { ChatAnthropic } from "@langchain/anthropic";
import {
  SystemMessage,
  HumanMessage,
  AIMessage,
  type BaseMessage,
} from "@langchain/core/messages";

/** Sanitize a name for the LLM API (OpenAI rejects spaces/special chars in message name). */
function sanitizeName(raw: string): string {
  return raw.replace(/[\s<|\\/>]+/g, "_").replace(/^_+|_+$/g, "") || "user";
}
import type { RunnableConfig } from "@langchain/core/runnables";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { LLMModel, Vendor } from "@scheduling-agent/database";
import { resolveModelSlug } from "../../../chat/modelResolution";
import { SchedulerAgentState } from "../../../state";
import { logger } from "../../../logger";

/**
 * Resolves the vendor slug and API key for a given model slug by querying the DB.
 */
async function resolveVendor(modelSlug: string): Promise<{ slug: string; apiKey: string | null; modelName: string } | null> {
  const model = await LLMModel.findOne({
    where: { slug: modelSlug },
    include: [{ model: Vendor, attributes: ["slug", "apiKey"] }],
  });
  const vendor = (model as any)?.Vendor;
  if (!vendor) return null;
  return { slug: vendor.slug, apiKey: vendor.apiKey ?? null, modelName: model!.name };
}

/**
 * Creates a LangChain chat model instance based on the vendor, model slug, and API key.
 * New models under a known vendor work automatically — no code changes needed.
 */
function getModel(modelSlug: string, vendorSlug: string, apiKey: string): BaseChatModel {
  switch (vendorSlug) {
    case "openai":
      return new ChatOpenAI({ modelName: modelSlug, temperature: 0.4, apiKey });
    case "anthropic":
      return new ChatAnthropic({ modelName: modelSlug, temperature: 0.4, apiKey });
    case "google":
      return new ChatGoogle({ model: modelSlug, temperature: 0.4, apiKey });
    default:
      throw new Error(`Unsupported vendor "${vendorSlug}" for model "${modelSlug}"`);
  }
}

/**
 * Best-effort extraction of the provider's own error text (OpenAI / Anthropic / Google shapes).
 * Returned to the client and logged as-is.
 */
function rawVendorErrorText(err: unknown): string {
  if (err == null) return "Unknown error";
  if (typeof err === "string") return err;

  const tryStringify = (o: object): string | null => {
    try {
      return JSON.stringify(o);
    } catch {
      return null;
    }
  };

  const fromOpenAiStyle = (o: Record<string, unknown>): string | null => {
    const inner = o.error;
    if (inner && typeof inner === "object") {
      const e = inner as Record<string, unknown>;
      if (typeof e.message === "string") {
        const bits: string[] = [];
        if (typeof e.type === "string") bits.push(`type=${e.type}`);
        if (typeof e.code === "string") bits.push(`code=${e.code}`);
        if (typeof e.param === "string") bits.push(`param=${e.param}`);
        const suffix = bits.length ? ` (${bits.join(", ")})` : "";
        return `${e.message}${suffix}`;
      }
      const s = tryStringify(e as object);
      if (s) return s;
    }
    if (typeof o.message === "string") {
      const bits: string[] = [];
      if (typeof o.type === "string") bits.push(`type=${o.type}`);
      if (typeof o.code === "string") bits.push(`code=${o.code}`);
      const suffix = bits.length ? ` (${bits.join(", ")})` : "";
      return `${o.message}${suffix}`;
    }
    return null;
  };

  if (err instanceof Error) {
    const anyErr = err as Error & {
      status?: number;
      response?: { data?: unknown; status?: number };
      body?: unknown;
      error?: unknown;
    };
    if (anyErr.response?.data && typeof anyErr.response.data === "object") {
      const t = fromOpenAiStyle(anyErr.response.data as Record<string, unknown>);
      if (t) {
        const st = anyErr.response.status ?? anyErr.status;
        return st != null ? `HTTP ${st}: ${t}` : t;
      }
    }
    if (anyErr.body && typeof anyErr.body === "object") {
      const t = fromOpenAiStyle(anyErr.body as Record<string, unknown>);
      if (t) return t;
    }
    if (anyErr.error && typeof anyErr.error === "object") {
      const t = fromOpenAiStyle({ error: anyErr.error } as Record<string, unknown>);
      if (t) return t;
    }
    if (err.cause) {
      const nested = rawVendorErrorText(err.cause);
      if (nested && nested !== "Unknown error") return `${err.message} | cause: ${nested}`;
    }
    return err.message;
  }

  if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    const direct = fromOpenAiStyle(o);
    if (direct) return direct;
    const s = tryStringify(err as object);
    if (s) return s;
  }

  return String(err);
}

/**
 * LangGraph node that calls the LLM.
 * Validates the API key first; on LLM errors, returns the provider's raw error text.
 */
export async function callModelNode(
  state: SchedulerAgentState,
  config: RunnableConfig,
): Promise<Partial<SchedulerAgentState>> {
  const { systemPrompt, messages: stateMessages, singleChatId, groupId } = state;

  const modelSlug = await resolveModelSlug(singleChatId, groupId);

  // Resolve vendor + API key from DB
  const vendor = await resolveVendor(modelSlug);
  logger.info("Vendor resolved", { vendorSlug: vendor?.slug });
  if (!vendor) {
    const errMsg = `Unknown model "${modelSlug}". It may have been removed. Please select a different model.`;
    logger.error("Model not found in DB", { modelSlug });
    return { error: errMsg };
  }

  if (!vendor.apiKey) {
    const errMsg = `API key not configured for ${vendor.slug}. Please set the API key in the admin panel or switch to a different model.`;
    logger.error("Missing API key for vendor", { modelSlug, vendorSlug: vendor.slug });
    return { error: errMsg };
  }

  logger.info("Calling LLM", { modelSlug, vendorSlug: vendor.slug, messageCount: stateMessages.length });

  const model = getModel(modelSlug, vendor.slug, vendor.apiKey);
  const llmMessages: BaseMessage[] = [new SystemMessage(systemPrompt)];

  for (const msg of stateMessages) {
    if (typeof (msg as any)._getType === "function") {
      // Deserialized LangChain message — sanitize name if present
      const name = (msg as any).name;
      if (name && typeof name === "string") {
        (msg as any).name = sanitizeName(name);
      }
      llmMessages.push(msg);
    } else {
      const m = msg as any;
      if (m.role === "human" || m.role === "user") {
        llmMessages.push(new HumanMessage({ content: m.content, ...(m.name ? { name: sanitizeName(m.name) } : {}) }));
      } else if (m.role === "assistant" || m.role === "ai") {
        llmMessages.push(new AIMessage(m.content));
      }
    }
  }

  try {
    const response = await model.invoke(llmMessages, config);
    // Attach model metadata so it's persisted in the checkpoint and available in history
    (response as any).additional_kwargs = {
      ...(response as any).additional_kwargs,
      modelSlug,
      vendorSlug: vendor.slug,
      modelName: vendor.modelName,
    };
    return { messages: [response] };
  } catch (err) {
    const vendorText = rawVendorErrorText(err);
    logger.error("LLM invocation failed", { modelSlug, vendorSlug: vendor.slug, vendorError: vendorText });
    return { error: vendorText };
  }
}
