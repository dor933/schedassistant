import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { logger } from "../logger";
import { resolveOrgVendorByOrg } from "../services/resolveOrgVendor.service";
import {
  INTENTS,
  type Classification,
  type ConversationContext,
  type Intent,
  type ToolName,
} from "./types";

// Canonical sector labels the downstream tools / Research Objects expect.
// Matches the Yahoo-style sector names that appear on `daily_brief.stocks[].sector`,
// plus the "Semiconductors" sub-sector which the pipeline already treats as a
// first-class label even though Yahoo classifies it under Technology.
const CANONICAL_SECTORS = [
  "Technology",
  "Healthcare",
  "Energy",
  "Financial Services",
  "Industrials",
  "Basic Materials",
  "Utilities",
  "Consumer Defensive",
  "Consumer Cyclical",
  "Communication Services",
  "Real Estate",
  "Semiconductors",
] as const;

const CLASSIFIER_MODEL =
  process.env.ASK_GRAHAMY_CLASSIFIER_MODEL ?? "gpt-4o";

// Ask Grahamy is a public, unauthenticated endpoint — there's no per-user
// agent/org to bill against. We pin a single platform org whose Anthropic key
// covers all classifier calls, mirroring the resolveOrgVendor pattern used by
// every other LLM call in this service so the credential still lives in
// `organization_vendor_api_keys` rather than a process-level env var.
const ASK_GRAHAMY_ORG_ID =
  process.env.ASK_GRAHAMY_ORG_ID ?? "acf0cbab-3aed-42cf-872d-63cba24e61c3";

const classifierOutputSchema = z.object({
  intent: z.enum(INTENTS),
  symbols: z.array(z.string()).max(5),
  sectors: z.array(z.enum(CANONICAL_SECTORS)).max(5),
  regimeRequested: z.boolean(),
  isFollowUp: z.boolean(),
  confidence: z.enum(["high", "medium", "low"]),
});

export type ClassifierOutput = z.infer<typeof classifierOutputSchema>;

type ClassifierInvoker = (input: {
  message: string;
  previousContext?: ConversationContext;
}) => Promise<ClassifierOutput>;

export type ClassifyOptions = {
  // Stub seam for tests. Default is the lazy Haiku-backed invoker below.
  classifier?: ClassifierInvoker;
};

const SYSTEM_PROMPT = `You classify user messages for a public stock-research assistant.
The downstream system can answer when the message is anchored to one or more of:
  • a public US stock — output as an UPPERCASE ticker (e.g. NVDA, MSFT, BRK.B). Resolve company
    names to their primary US ticker when you are at least medium-confidence (e.g. "nvidia" → NVDA,
    "apple" → AAPL, "jp morgan" → JPM). Omit symbols you cannot confidently resolve.
  • a sector — must be exactly one of: ${CANONICAL_SECTORS.join(", ")}.
  • the current market regime / setup / VIX / macro state.

Set isFollowUp = true when the message references a previous turn ("what about ...", "why?",
"and the risks?", "is it still valid?", "compare it").

CRITICAL: even when isFollowUp = true, you MUST extract every symbol / sector / regime cue
the user explicitly names in THIS message. Empty symbols / sectors / regimeRequested means
"the user named none here" — never use empty arrays as a way to signal "look at prior context".
The caller fills missing fields from prior context only when the message itself names none.

Examples:
  • "what about jp morgan?"                       → isFollowUp=true, symbols=["JPM"], sectors=[], regimeRequested=false
  • "what about jp morgan and the energy sector?" → isFollowUp=true, symbols=["JPM"], sectors=["Energy"], regimeRequested=false
  • "and the risks?"                              → isFollowUp=true, symbols=[], sectors=[], regimeRequested=false
  • "is the market risk-on?"                      → isFollowUp=false, symbols=[], sectors=[], regimeRequested=true

intent must be exactly one of: stock, sector, regime, stock_sector, stock_regime, sector_regime,
stock_sector_regime, follow_up, unknown.

Use intent = "unknown" only when the message is nonsensical, off-topic, or impossible to anchor
to any stock / sector / regime even after considering prior context.

symbols, sectors, and regimeRequested must be consistent with the chosen intent.

confidence:
  • "high"  — a clear ticker / sector / regime is named.
  • "medium" — inferred from a company name or follow-up context.
  • "low"   — best guess; the caller may treat as unknown.

Return ONLY the structured object — no prose.`;

function buildUserPrompt(
  message: string,
  ctx?: ConversationContext,
): string {
  const lines: string[] = [];
  lines.push(`Message: ${message}`);
  if (ctx) {
    lines.push("Prior turn context:");
    lines.push(`  lastSymbols: [${ctx.lastSymbols.join(", ")}]`);
    lines.push(`  lastSectors: [${ctx.lastSectors.join(", ")}]`);
    if (ctx.lastIntent) lines.push(`  lastIntent: ${ctx.lastIntent}`);
  } else {
    lines.push("Prior turn context: (none — this is the first turn)");
  }
  return lines.join("\n");
}

// Cache the structured-output runnable per resolved API key so we re-bind only
// when the org rotates its credential. Keeping the LangChain wrapper intact
// across calls avoids re-paying its construction cost on every classification.
type StructuredRunnable = {
  invoke: (msgs: Array<{ role: string; content: string }>) => Promise<unknown>;
};
let cachedStructured: { apiKey: string; runnable: StructuredRunnable } | null = null;

function buildStructuredRunnable(apiKey: string): StructuredRunnable {
  const llm = new ChatOpenAI({ modelName: CLASSIFIER_MODEL, apiKey });
  return (llm as unknown as {
    withStructuredOutput: (
      schema: typeof classifierOutputSchema,
      opts: { name: string },
    ) => StructuredRunnable;
  }).withStructuredOutput(classifierOutputSchema, {
    name: "ask_grahamy_classification",
  });
}

const defaultInvoker: ClassifierInvoker = async ({ message, previousContext }) => {
  const vendor = await resolveOrgVendorByOrg(CLASSIFIER_MODEL, ASK_GRAHAMY_ORG_ID);
  if (!vendor) {
    throw new Error(
      `Ask Grahamy classifier: model "${CLASSIFIER_MODEL}" not found in catalog or org ${ASK_GRAHAMY_ORG_ID} missing.`,
    );
  }
  if (vendor.vendorSlug !== "openai") {
    throw new Error(
      `Ask Grahamy classifier expects an openai-vendored model; got ${vendor.vendorSlug}.`,
    );
  }
  if (!vendor.apiKey) {
    throw new Error(
      `Ask Grahamy classifier: organization ${ASK_GRAHAMY_ORG_ID} has not configured an OpenAI API key.`,
    );
  }
  if (!cachedStructured || cachedStructured.apiKey !== vendor.apiKey) {
    cachedStructured = {
      apiKey: vendor.apiKey,
      runnable: buildStructuredRunnable(vendor.apiKey),
    };
  }
  const raw = await cachedStructured.runnable.invoke([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(message, previousContext) },
  ]);
  return classifierOutputSchema.parse(raw);
};

export async function classifyMessage(
  message: string,
  previousContext?: ConversationContext,
  options: ClassifyOptions = {},
): Promise<Classification> {
  const invoker = options.classifier ?? defaultInvoker;
  let raw: ClassifierOutput;
  try {
    raw = await invoker({ message, previousContext });
  } catch (err) {
    logger.error("Ask Grahamy classifier LLM call failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      intent: "unknown",
      symbols: [],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      requiresTools: [],
      confidence: "low",
      warnings: ["Classifier unavailable — please retry."],
    };
  }

  const symbols = uniqueUpper(raw.symbols).slice(0, 5);
  const sectors = unique(raw.sectors).slice(0, 5);

  if (raw.isFollowUp) {
    // Self-anchored short-circuit: the user phrased the turn as a follow-up
    // ("what about ..."), but the message itself names a stock / sector /
    // regime. The downstream graph can answer from this message alone — no
    // prior-context dependency. Treat it like a fresh self-contained turn so
    // we don't fall into the clarification path on what should be a clean
    // first-turn-of-thread query.
    const messageHasOwnAnchor =
      symbols.length > 0 || sectors.length > 0 || raw.regimeRequested;
    if (messageHasOwnAnchor) {
      const inferred = inferIntent(symbols, sectors, raw.regimeRequested, false);
      return {
        intent: inferred,
        symbols,
        sectors,
        regimeRequested: raw.regimeRequested,
        isFollowUp: false,
        requiresTools: toolsForIntent(inferred),
        confidence: raw.confidence,
        warnings: [],
      };
    }

    const hasPrior =
      !!previousContext &&
      (previousContext.lastSymbols.length > 0 ||
        previousContext.lastSectors.length > 0 ||
        !!previousContext.lastIntent);
    if (!hasPrior) {
      return {
        intent: "follow_up",
        symbols: [],
        sectors: [],
        regimeRequested: false,
        isFollowUp: true,
        requiresTools: [],
        confidence: "low",
        warnings: ["Missing prior context for follow-up."],
      };
    }
    const ctx = previousContext!;
    const resolvedSymbols = symbols.length ? symbols : ctx.lastSymbols;
    const resolvedSectors = sectors.length ? sectors : ctx.lastSectors;
    const resolvedRegime =
      raw.regimeRequested ||
      ctx.lastIntent === "regime" ||
      ctx.lastIntent === "stock_regime" ||
      ctx.lastIntent === "sector_regime" ||
      ctx.lastIntent === "stock_sector_regime";
    const resolvedIntent = inferIntent(
      resolvedSymbols,
      resolvedSectors,
      resolvedRegime,
      true,
    );
    return {
      intent: resolvedIntent,
      symbols: resolvedSymbols,
      sectors: resolvedSectors,
      regimeRequested: resolvedRegime,
      isFollowUp: true,
      requiresTools: toolsForIntent(resolvedIntent),
      // Promote pure-low to medium since prior context is rescuing the turn.
      confidence: raw.confidence === "low" ? "medium" : raw.confidence,
      warnings: [],
    };
  }

  // Non-follow-up. Trust the LLM's "unknown" verdict, otherwise re-derive
  // intent from the resolved (symbols, sectors, regime) tuple so requiresTools
  // and intent stay consistent even if the model returned a mismatched label.
  const inferred = inferIntent(symbols, sectors, raw.regimeRequested, false);
  const intent: Intent = raw.intent === "unknown" ? "unknown" : inferred;

  return {
    intent,
    symbols,
    sectors,
    regimeRequested: raw.regimeRequested,
    isFollowUp: false,
    requiresTools: toolsForIntent(intent),
    confidence: raw.confidence,
    warnings:
      intent === "unknown"
        ? ["Could not classify the message into stock, sector, or regime context."]
        : [],
  };
}

export function toolsForIntent(intent: Intent): ToolName[] {
  switch (intent) {
    case "stock":
    case "stock_regime":
      return ["get_stock_snapshot_context", "get_market_context"];
    case "sector":
    case "sector_regime":
      return ["get_sector_snapshot_context", "get_market_context"];
    case "regime":
      return ["get_market_context"];
    case "stock_sector":
    case "stock_sector_regime":
      return [
        "get_stock_snapshot_context",
        "get_sector_snapshot_context",
        "get_market_context",
      ];
    case "follow_up":
    case "unknown":
      return [];
  }
}

function inferIntent(
  symbols: string[],
  sectors: string[],
  regimeRequested: boolean,
  wasFollowUp: boolean,
): Intent {
  if (symbols.length && sectors.length && regimeRequested) return "stock_sector_regime";
  if (symbols.length && sectors.length) return "stock_sector";
  if (symbols.length && regimeRequested) return "stock_regime";
  if (sectors.length && regimeRequested) return "sector_regime";
  if (symbols.length) return "stock";
  if (sectors.length) return "sector";
  if (regimeRequested) return "regime";
  return wasFollowUp ? "follow_up" : "unknown";
}

function uniqueUpper(items: string[]): string[] {
  return Array.from(
    new Set(
      items
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0 && s.length <= 10),
    ),
  );
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}
