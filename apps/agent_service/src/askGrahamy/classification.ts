import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { logger } from "../logger";
import { resolveOrgVendorByOrg } from "../utils/resolveOrgVendor.service";
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
  • an anchorless sector leaderboard / sector conviction ranking request.
  • an anchorless sector momentum-vs-conviction divergence request.
  • an anchorless stock idea / best setups / top conviction names discovery request.

Set isFollowUp = true when the message references a previous turn — short questions with
no own anchor like "what about ...?", "why?", "and the risks?", "compare to peers", "compare it",
"is it still valid?", "מה לגבי המתחרים", "ולמה?", or any pronoun-only reference back ("it", "this",
"this one"). The user's language can be English, Hebrew, or any other — the test is semantic, not
keyword.

ANCHOR INHERITANCE FOR FOLLOW-UPS (important):
- If the message NAMES new anchors (a different ticker / sector / regime), use those new anchors
  and DO NOT inherit from prior context.
- If the message is anchor-less BUT "Prior turn context" is supplied, INHERIT lastSymbols and
  lastSectors as this turn's symbols/sectors. lastIntent including the substring "regime" implies
  regimeRequested=true. This lets the downstream pipeline fetch the right Research Objects so
  the agent can give a real answer instead of falling back to memory only.
- If the message is anchor-less AND no prior context exists, output intent="unknown".

Examples (with prior context lastSymbols=["NVDA"]):
  • "what about jp morgan?"            → symbols=["JPM"], sectors=[], regimeRequested=false      (new anchor wins)
  • "compare it to others"             → symbols=["NVDA"], sectors=[], regimeRequested=false     (inherit)
  • "מה לגבי המתחרים שלה?"            → symbols=["NVDA"], sectors=[], regimeRequested=false     (inherit, Hebrew)
  • "and the risks?"                   → symbols=["NVDA"], sectors=[], regimeRequested=false     (inherit)
  • "is the market risk-on?"           → symbols=[], sectors=[], regimeRequested=true            (new regime anchor)
  • "what about its sector?"           → symbols=["NVDA"], sectors=["Technology"], if NVDA's sector
                                          is known to be Technology and prior lastSectors had it. If
                                          unsure of sector, inherit symbols only.

Without prior context:
  • "what about jp morgan?"            → symbols=["JPM"], sectors=[], regimeRequested=false
  • "and the risks?"                   → intent="unknown" (no anchor anywhere)

intent must be exactly one of: stock, sector, regime, stock_sector, stock_regime, sector_regime,
stock_sector_regime, sector_conviction_leaderboard, sector_momentum_vs_conviction_divergence,
stock_idea_discovery, follow_up, unknown.

Use intent = "sector_conviction_leaderboard" when the user asks for a sector-wide ranking without
naming a specific sector. Examples:
  • "Which sectors are leading on conviction this week?"
  • "Show me the sector conviction leaderboard"
  • "Which sectors have strongest historical forward profile?"
For this intent, symbols=[], sectors=[], regimeRequested=false is valid.

Use intent = "sector_momentum_vs_conviction_divergence" when the user asks for sectors where
conviction/evidence and price action/momentum disagree without naming a specific sector. Examples:
  • "Which sectors have conviction but weak price action?"
  • "Which sectors have strong evidence but poor momentum?"
  • "Where is there divergence between conviction and momentum?"
  • "Which sectors look fundamentally good but aren’t moving yet?"
  • "Any sectors where the market is not confirming the data yet?"
For this intent, symbols=[], sectors=[], regimeRequested=false is valid.

Use intent = "stock_idea_discovery" when the user asks for stock ideas, interesting names,
top conviction names, attractive setups, or what to look at today without naming a specific
ticker. Examples:
  • "Give me an interesting stock"
  • "What stock looks interesting today?"
  • "Show me top conviction names today"
  • "Any attractive setup right now?"
  • "What should I look at today?"
  • "Which names have the best setup right now?"
For this intent, symbols=[], sectors=[], regimeRequested=false is valid.

Use intent = "unknown" only when the message is nonsensical, off-topic, or impossible to anchor
to any stock / sector / regime EVEN AFTER inheritance from prior context.

symbols, sectors, and regimeRequested must be consistent with the chosen intent.

confidence:
  • "high"   — a clear ticker / sector / regime is named.
  • "medium" — inferred from a company name OR inherited from prior context.
  • "low"    — best guess; the caller may treat as unknown.

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

  // Slimmed classifier — the deep agent's PostgresSaver thread carries
  // conversation memory now, so we no longer need the follow-up self-
  // rescue / prior-context-merge branch that the templated answer path
  // depended on. The classifier just emits whichever symbols/sectors/regime
  // the user explicitly named THIS turn. Pure follow-ups like "why?" with
  // no anchors flow through with empty arrays — the downstream agent
  // resolves them via thread memory.
  const inferred = inferIntent(symbols, sectors, raw.regimeRequested, raw.isFollowUp);
  // Trust the LLM's "unknown" verdict; otherwise re-derive intent from the
  // resolved (symbols, sectors, regime) tuple so requiresTools and intent
  // stay consistent even if the model returned a mismatched label.
  const intent: Intent =
    raw.intent === "unknown"
      ? "unknown"
      : isAnchorlessCapabilityIntent(raw.intent)
        ? raw.intent
        : inferred;

  return {
    intent,
    symbols,
    sectors,
    regimeRequested: raw.regimeRequested,
    isFollowUp: raw.isFollowUp,
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
    case "sector_conviction_leaderboard":
    case "sector_momentum_vs_conviction_divergence":
    case "stock_idea_discovery":
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

function isAnchorlessCapabilityIntent(intent: Intent): boolean {
  return (
    intent === "sector_conviction_leaderboard" ||
    intent === "sector_momentum_vs_conviction_divergence" ||
    intent === "stock_idea_discovery"
  );
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
