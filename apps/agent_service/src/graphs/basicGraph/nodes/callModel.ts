import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogle } from "@langchain/google";
import { ChatAnthropic } from "@langchain/anthropic";
import {
  SystemMessage,
  HumanMessage,
  AIMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { LLMModel, Vendor } from "@scheduling-agent/database";
import { resolveModelSlug } from "../../../chat/modelResolution";
import { SchedulerAgentState } from "../../../state";
import { logger } from "../../../logger";

/** Maps vendor slug → required env var name. */
const VENDOR_API_KEY_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
};

/**
 * Resolves the vendor slug for a given model slug by querying the DB.
 */
async function resolveVendorSlug(modelSlug: string): Promise<string | null> {
  const model = await LLMModel.findOne({
    where: { slug: modelSlug },
    include: [{ model: Vendor, attributes: ["slug"] }],
  });
  return (model as any)?.Vendor?.slug ?? null;
}

/**
 * Checks whether the API key for the given vendor is set.
 * Returns the env var name if missing, or null if OK.
 */
export function getMissingApiKeyEnv(vendorSlug: string): string | null {
  const envVar = VENDOR_API_KEY_ENV[vendorSlug];
  if (!envVar) return null;
  return process.env[envVar] ? null : envVar;
}

/**
 * Creates a LangChain chat model instance based on the vendor and model slug.
 * New models under a known vendor work automatically — no code changes needed.
 */
function getModel(modelSlug: string, vendorSlug: string): BaseChatModel {
  switch (vendorSlug) {
    case "openai":
      return new ChatOpenAI({ modelName: modelSlug, temperature: 0.4 });
    case "anthropic":
      return new ChatAnthropic({ modelName: modelSlug, temperature: 0.4 });
    case "google":
      return new ChatGoogle({ model: modelSlug, temperature: 0.4 });
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

  // Resolve vendor from DB
  const vendorSlug = await resolveVendorSlug(modelSlug);
  logger.info("Vendor slug resolved", { vendorSlug });
  if (!vendorSlug) {
    const errMsg = `Unknown model "${modelSlug}". It may have been removed. Please select a different model.`;
    logger.error("Model not found in DB", { modelSlug });
    return { error: errMsg };
  }

  // Validate API key
  const missingEnv = getMissingApiKeyEnv(vendorSlug);
  if (missingEnv) {
    logger.info("Missing API key env", { missingEnv });
    const errMsg = `API key not configured for ${vendorSlug} (missing ${missingEnv}). Please set the environment variable or switch to a different model.`;
    logger.error("Missing API key for model", { modelSlug, vendorSlug, missingEnv });
    return { error: errMsg };
  }

  logger.info("Calling LLM", { modelSlug, vendorSlug, messageCount: stateMessages.length });

  const model = getModel(modelSlug, vendorSlug);
  const llmMessages: BaseMessage[] = [new SystemMessage(systemPrompt)];

  for (const msg of stateMessages) {
    if (typeof (msg as any)._getType === "function") {
      llmMessages.push(msg);
    } else {
      const m = msg as any;
      if (m.role === "human" || m.role === "user") {
        llmMessages.push(new HumanMessage({ content: m.content, ...(m.name ? { name: m.name } : {}) }));
      } else if (m.role === "assistant" || m.role === "ai") {
        llmMessages.push(new AIMessage(m.content));
      }
    }
  }

  try {
    const response = await model.invoke(llmMessages, config);
    return { messages: [response] };
  } catch (err) {
    const vendorText = rawVendorErrorText(err);
    logger.error("LLM invocation failed", { modelSlug, vendorSlug, vendorError: vendorText });
    return { error: vendorText };
  }
}
