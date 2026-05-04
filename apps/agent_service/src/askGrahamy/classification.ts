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
  comparison: z
    .discriminatedUnion("comparisonType", [
      z.object({
        comparisonType: z.literal("stock_vs_sector"),
        left: z.object({
          type: z.literal("stock"),
          symbol: z.string(),
        }),
        right: z.object({
          type: z.enum(["sector", "implicit_stock_sector"]),
          sector: z.string().nullable(),
        }),
      }),
      z.object({
        comparisonType: z.literal("sector_vs_sector"),
        left: z.object({
          type: z.literal("sector"),
          sector: z.string(),
        }),
        right: z.object({
          type: z.literal("sector"),
          sector: z.string(),
        }),
      }),
    ])
    .nullable(),
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
  • an anchorless week-over-week sector change / sector delta request.
  • an anchorless stock idea / best setups / top conviction names discovery request.
  • a stock-vs-sector or sector-vs-sector comparison request.

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
week_over_week_sector_delta, stock_idea_discovery, comparison, follow_up, unknown.

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

Use intent = "week_over_week_sector_delta" when the user asks for broad sector changes versus
last week without naming a specific sector. Examples:
  • "Which sectors improved most versus last week?"
  • "Which sectors deteriorated versus last week?"
  • "What changed since last week?"
  • "Which sectors gained conviction week-over-week?"
  • "Which sectors lost momentum this week?"
For this intent, symbols=[], sectors=[], regimeRequested=false is valid.
For "What changed since last week?":
  • If prior context is sector / regime / market / sector leaderboard / sector divergence, use this intent.
  • If no prior context exists, use this broad sector-delta intent.
  • If prior context is a stock-specific turn, preserve stock follow-up behavior instead.

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

Use intent = "comparison" for stock-vs-sector and sector-vs-sector comparison requests. Put
the anchors in comparison.left/right (NOT in symbols), so the PG comparison capability can
run without building full Stock Research Objects. For this intent, symbols=[], sectors=[],
regimeRequested=false is valid.

Supported stock-vs-sector examples:
  • "Compare GSL to its sector"
  • "How does GSL look versus Financial Services?"
  • "Is GSL better than its sector?"
  • "Compare GSL with its industry/sector"
For implicit-sector wording ("its sector", "its industry", "the sector"):
  comparison={ comparisonType:"stock_vs_sector", left:{type:"stock", symbol:"GSL"},
    right:{type:"implicit_stock_sector", sector:null} }
For explicit-sector wording:
  comparison={ comparisonType:"stock_vs_sector", left:{type:"stock", symbol:"GSL"},
    right:{type:"sector", sector:"Financial Services"} }   (use the best canonical sector label)

Supported sector-vs-sector examples:
  • "Compare Technology vs Industrials"
  • "Which sector looks better, Energy or Industrials?"
  • "Is Healthcare stronger than Financial Services?"
  • "Compare Consumer Defensive with Consumer Cyclical"
Use exact canonical labels when possible:
  comparison={ comparisonType:"sector_vs_sector", left:{type:"sector", sector:"Technology"},
    right:{type:"sector", sector:"Industrials"} }

Do NOT classify stock-vs-stock comparisons as supported yet; use intent="unknown"
for "Compare GSL vs DAC" or "Which is stronger, GSL or DAC?".
For every non-comparison message, set comparison=null.

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
  const comparison =
    normalizeComparison(raw.comparison) ??
    // Sector inference runs first because "Compare FAKE123 to its sector"
    // is a supported stock-vs-sector shape even when the stock is not found
    // later in PG. Symbol-vs-symbol remains unsupported in this phase.
    inferStockVsSectorComparisonFromMessage(message) ??
    inferSectorVsSectorComparisonFromMessage(message);

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
    raw.intent === "unknown" && comparison
      ? "comparison"
      : raw.intent === "unknown"
        ? "unknown"
      : raw.intent === "comparison" && comparison
        ? "comparison"
        : raw.intent === "comparison"
          ? "unknown"
      : isAnchorlessCapabilityIntent(raw.intent)
        ? raw.intent
        : inferred;

  return {
    intent,
    symbols: intent === "comparison" ? [] : symbols,
    sectors: intent === "comparison" ? [] : sectors,
    regimeRequested: intent === "comparison" ? false : raw.regimeRequested,
    isFollowUp: raw.isFollowUp,
    ...(intent === "comparison" && comparison ? { comparison } : {}),
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
    case "week_over_week_sector_delta":
    case "stock_idea_discovery":
    case "comparison":
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
    intent === "week_over_week_sector_delta" ||
    intent === "stock_idea_discovery"
  );
}

function normalizeComparison(
  comparison: ClassifierOutput["comparison"],
): import("./types").ComparisonClassification | undefined {
  if (!comparison) return undefined;

  if (comparison.comparisonType === "sector_vs_sector") {
    return {
      comparisonType: "sector_vs_sector",
      left: {
        type: "sector",
        sector: comparison.left.sector.trim(),
      },
      right: {
        type: "sector",
        sector: comparison.right.sector.trim(),
      },
    };
  }

  if (comparison.comparisonType !== "stock_vs_sector") return undefined;
  const symbol = comparison.left.symbol.trim().toUpperCase();
  if (!symbol || symbol.length > 10) return undefined;
  if (comparison.right.type === "implicit_stock_sector") {
    return {
      comparisonType: "stock_vs_sector",
      left: { type: "stock", symbol },
      right: { type: "implicit_stock_sector" },
    };
  }
  const sector = comparison.right.sector?.trim();
  return {
    comparisonType: "stock_vs_sector",
    left: { type: "stock", symbol },
    right: {
      type: "sector",
      ...(sector ? { sector } : {}),
    },
  };
}

function inferStockVsSectorComparisonFromMessage(
  message: string,
): import("./types").ComparisonClassification | undefined {
  const stockMatch = message.match(/\b(?:compare|how\s+does|is)\s+([A-Za-z][A-Za-z0-9.]{0,9})\b/i);
  const symbol = stockMatch?.[1]?.trim();
  if (!symbol || !looksLikeTickerAnchor(symbol)) return undefined;

  if (
    /\b(?:its|the)\s+(?:sector|industry)\b/i.test(message) ||
    /\bindustry\/sector\b/i.test(message)
  ) {
    return {
      comparisonType: "stock_vs_sector",
      left: { type: "stock", symbol: symbol.toUpperCase() },
      right: { type: "implicit_stock_sector" },
    };
  }

  const targetMatch = message.match(/\b(?:versus|against|than|to)\s+(.+?)(?:[?.!]|$)/i);
  const rawTarget = targetMatch?.[1]?.trim().replace(/^the\s+/i, "");
  if (!rawTarget) return undefined;

  const canonicalSector = canonicalSectorLabel(rawTarget);
  if (canonicalSector || /\bsector\b/i.test(rawTarget)) {
    return {
      comparisonType: "stock_vs_sector",
      left: { type: "stock", symbol: symbol.toUpperCase() },
      right: { type: "sector", sector: canonicalSector ?? rawTarget },
    };
  }

  return undefined;
}

function inferSectorVsSectorComparisonFromMessage(
  message: string,
): import("./types").ComparisonClassification | undefined {
  if (!/\b(compare|versus|vs\.?|stronger|better|weaker|worse)\b/i.test(message)) {
    return undefined;
  }

  const sectors = findSectorMentions(message);
  if (sectors.length >= 2) {
    return {
      comparisonType: "sector_vs_sector",
      left: { type: "sector", sector: sectors[0].label },
      right: { type: "sector", sector: sectors[1].label },
    };
  }

  const compareMatch = message.match(
    /\bcompare\s+(.+?)\s+(?:vs\.?|versus|against|with|to|and)\s+(.+?)(?:[?.!]|$)/i,
  );
  if (compareMatch) {
    const left = compareMatch[1]?.trim().replace(/^the\s+/i, "");
    const right = compareMatch[2]?.trim().replace(/^the\s+/i, "");
    if (left && right && (mentionsSectorWord(left) || mentionsSectorWord(right))) {
      return {
        comparisonType: "sector_vs_sector",
        left: { type: "sector", sector: canonicalSectorLabel(left) ?? left },
        right: { type: "sector", sector: canonicalSectorLabel(right) ?? right },
      };
    }
  }

  return undefined;
}

function findSectorMentions(message: string): Array<{ label: string; index: number }> {
  const mentions: Array<{ label: string; index: number }> = [];
  for (const sector of CANONICAL_SECTORS) {
    const pattern = new RegExp(`\\b${escapeRegExp(sector).replace(/\\s+/g, "\\\\s+")}\\b`, "i");
    const match = message.match(pattern);
    if (match?.index != null) mentions.push({ label: sector, index: match.index });
  }
  return mentions.sort((a, b) => a.index - b.index);
}

function mentionsSectorWord(value: string): boolean {
  return /\bsector\b/i.test(value);
}

function looksLikeTickerAnchor(value: string): boolean {
  const token = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9.]{0,9}$/.test(token)) return false;
  if (token === token.toUpperCase()) return true;
  return token.length <= 5;
}

function canonicalSectorLabel(value: string): string | undefined {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return CANONICAL_SECTORS.find(
    (sector) =>
      sector.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === normalized,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
