import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { logger } from "../logger";
import { resolveOrgVendorByOrg } from "../utils/resolveOrgVendor.service";
import {
  INTENTS,
  type Classification,
  type ConversationContext,
  type FactorBacktestClassification,
  type FactorBacktestCriterion,
  type FactorBacktestFactor,
  type FactorBacktestHorizon,
  type FeatureScreenCriterion,
  type FeatureScreenFactor,
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

const FEATURE_SCREEN_FACTORS = [
  "valuation",
  "quality",
  "momentum",
  "growth",
  "leverage",
  "sector",
  "risk",
] as const;

const FACTOR_BACKTEST_FACTORS = [
  "valuation",
  "quality",
  "momentum",
  "growth",
  "leverage",
  "sector",
] as const;

const FACTOR_BACKTEST_HORIZONS = [
  "20-day",
  "40-day",
  "60-day",
  "120-day",
  "252-day",
] as const;

const CLASSIFIER_MODEL =
  process.env.ASK_GRAHAMY_CLASSIFIER_MODEL ?? "gpt-5";

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
  focus: z.enum(["risk", "validated_evidence"]).nullable().optional(),
  featureCriteria: z
    .array(
      z.object({
        factor: z.enum(FEATURE_SCREEN_FACTORS),
        bucket: z.string(),
      }),
    )
    .max(7)
    .nullable()
    .optional(),
  factorBacktest: z
    .object({
      criteria: z
        .array(
          z.object({
            factor: z.enum(FACTOR_BACKTEST_FACTORS),
            bucket: z.string(),
          }),
        )
        .max(6),
      horizon: z.enum(FACTOR_BACKTEST_HORIZONS).nullable().optional(),
      unsupportedHorizon: z.string().nullable().optional(),
      unsupportedCriteria: z.array(z.string()).max(5).nullable().optional(),
      notes: z.array(z.string()).max(5).nullable().optional(),
    })
    .nullable()
    .optional(),
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
  • an anchorless bounded stock screen request with user-specified current feature buckets.
  • an anchorless historical factor-combination backtest / forward-profile request.
  • an anchorless current-regime historical playbook request.
  • a comparison-style request between two or more stocks/sectors (handled by listing every
    mentioned entity in symbols / sectors and turning on regimeRequested when relevant —
    there is no separate "comparison" intent).
  • an anchored risk / path-risk / drawdown / probability-of-loss question.
  • an anchored Pipeline validated-evidence / evidence-backed question.

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
  • "what is the probability of losing more than 10%?" → intent="unknown" (no anchor anywhere)

intent must be exactly one of: stock, sector, regime, stock_sector, stock_regime, sector_regime,
stock_sector_regime, sector_conviction_leaderboard, sector_momentum_vs_conviction_divergence,
week_over_week_sector_delta, stock_idea_discovery, market_regime_historical_playbook,
feature_screen, factor_conditioned_backtest, follow_up, unknown.

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
ticker AND without specifying concrete screening criteria. Examples:
  • "Give me an interesting stock"
  • "What stock looks interesting today?"
  • "Show me top conviction names today"
  • "Any attractive setup right now?"
  • "What should I look at today?"
  • "Which names have the best setup right now?"
For this intent, symbols=[], sectors=[], regimeRequested=false is valid.

Use intent = "feature_screen" when the user asks to find/screen/list stocks using specific
current public feature criteria such as valuation, quality, momentum, growth, leverage, sector,
or safe risk bucket. Put the parsed filters in featureCriteria. Do not use this intent for generic
"give me an interesting stock" idea requests with no criteria.
Supported featureCriteria factors and buckets:
  • valuation: ATTRACTIVE, FAIR, RICH
  • quality: STRONG, CONSTRUCTIVE, WEAK
  • momentum: STRONG, CONSTRUCTIVE, WEAK
  • growth: STRONG, WEAK
  • leverage: STRONG, STRESSED
  • sector: exact canonical sector label
  • risk: ELEVATED, LOW
Examples:
  • "Find me cheap quality stocks"
    → intent="feature_screen", featureCriteria=[{factor:"valuation", bucket:"ATTRACTIVE"}, {factor:"quality", bucket:"STRONG"}]
  • "Which stocks have strong quality but weak momentum?"
    → featureCriteria=[{factor:"quality", bucket:"STRONG"}, {factor:"momentum", bucket:"WEAK"}]
  • "Show stocks with attractive valuation and positive momentum"
    → featureCriteria=[{factor:"valuation", bucket:"ATTRACTIVE"}, {factor:"momentum", bucket:"CONSTRUCTIVE"}]
  • "Find high-quality stocks in Industrials"
    → featureCriteria=[{factor:"quality", bucket:"STRONG"}, {factor:"sector", bucket:"Industrials"}]
  • "Show cheap stocks with strong momentum"
    → featureCriteria=[{factor:"valuation", bucket:"ATTRACTIVE"}, {factor:"momentum", bucket:"STRONG"}]
For this intent, symbols=[], sectors=[], regimeRequested=false is valid.

Use intent = "factor_conditioned_backtest" when the user asks what happened historically,
whether factor combinations worked, or the historical forward profile of factor buckets.
Put parsed criteria and horizon in factorBacktest. This intent is for aggregate historical
base-rate evidence, not current stock screening.
Supported factorBacktest criteria:
  • valuation: ATTRACTIVE, FAIR, RICH
  • quality: STRONG, CONSTRUCTIVE, WEAK
  • momentum: STRONG, CONSTRUCTIVE, WEAK
  • growth: STRONG, WEAK
  • leverage: STRONG, STRESSED
  • sector: exact canonical sector label
Supported horizons: 20-day, 40-day, 60-day, 120-day, 252-day. Default horizon is 60-day.
Map "RSI is low" / "low RSI" to momentum WEAK for V1.
If a historical factor question names an unsupported factor such as insider buying,
still use intent="factor_conditioned_backtest" with criteria=[] and unsupportedCriteria
listing the unsupported public factor. Do not invent a supported proxy.
Examples:
  • "What happens historically when RSI is low and valuation is attractive?"
    → intent="factor_conditioned_backtest", factorBacktest={horizon:"60-day", criteria:[{factor:"momentum", bucket:"WEAK"}, {factor:"valuation", bucket:"ATTRACTIVE"}]}
  • "Do cheap high-quality stocks work historically?"
    → criteria=[{factor:"valuation", bucket:"ATTRACTIVE"}, {factor:"quality", bucket:"STRONG"}], horizon:"60-day"
  • "What is the 60-day forward profile for low momentum and strong quality?"
    → criteria=[{factor:"momentum", bucket:"WEAK"}, {factor:"quality", bucket:"STRONG"}], horizon:"60-day"
  • "How did this factor setup behave over 60 days?"
    → intent="factor_conditioned_backtest"; if no criteria are named, criteria=[]
  • "What historically happens when quality is strong but momentum is weak?"
    → criteria=[{factor:"quality", bucket:"STRONG"}, {factor:"momentum", bucket:"WEAK"}], horizon:"60-day"
  • "What happens historically when insider buying is high?"
    → intent="factor_conditioned_backtest", factorBacktest={horizon:"60-day", criteria:[], unsupportedCriteria:["insider buying"]}
For this intent, symbols=[], sectors=[], regimeRequested=false is valid.

Use intent = "market_regime_historical_playbook" when the user asks what historically works,
leads, underperforms, or matters in the current market regime. This is different from asking
"what is the market regime now?", which should remain intent="regime". Examples:
  • "What usually works in this regime?"
  • "Which sectors historically lead in the current regime?"
  • "What historically underperforms in this regime?"
  • "What are the risks in this regime?"
  • "What does a neutral regime usually favor?"
For this intent, symbols=[], sectors=[], regimeRequested=false is valid.

Comparison-style requests (stock-vs-stock, stock-vs-sector, sector-vs-sector) do NOT have
their own intent. Instead, list EVERY entity the user mentioned in symbols / sectors and set
regimeRequested=true if regime/market context is part of the comparison. The downstream
system builds one research object per stock/sector and one regime research object, then the
agent reads those objects and performs the comparison itself — no specialised comparison
query exists. Apply the natural intent based on which kinds of anchors appear:
  • two or more stocks, no sector mentioned → intent="stock"
  • stock + sector → intent="stock_sector"
  • stock + sector + regime context → intent="stock_sector_regime"
  • two sectors → intent="sector"
  • two sectors + regime context → intent="sector_regime"

Examples:
  • "Compare AMZN and NVDA"                              → symbols=["AMZN","NVDA"], sectors=[], regimeRequested=false, intent="stock"
  • "Compare AMZN and NVDA in the context of the market regime and the tech sector"
                                                         → symbols=["AMZN","NVDA"], sectors=["Technology"], regimeRequested=true, intent="stock_sector_regime"
  • "Compare GSL to its sector"                          → symbols=["GSL"], sectors=[], regimeRequested=false, intent="stock"  (the implicit "its sector" stays implicit; downstream resolves it from the stock research object)
  • "How does GSL look versus Financial Services?"        → symbols=["GSL"], sectors=["Financial Services"], regimeRequested=false, intent="stock_sector"
  • "Compare Technology vs Industrials"                   → symbols=[], sectors=["Technology","Industrials"], regimeRequested=false, intent="sector"
  • "Which is stronger, AMZN or NVDA, given the regime?"  → symbols=["AMZN","NVDA"], sectors=[], regimeRequested=true, intent="stock_regime"

Set focus="risk" only when the user is specifically asking about risk, downside risk, path
risk, temporary drawdown, "how bad can it fall along the way", or probability of losing more
than a threshold. Otherwise omit focus or set it to null.

Risk-focus examples:
  • "How risky is GSL?"                                    → intent="stock", symbols=["GSL"], focus="risk"
  • "How bad can GSL fall along the way?"                  → intent="stock", symbols=["GSL"], focus="risk"
  • "What is the drawdown risk for GSL?"                   → intent="stock", symbols=["GSL"], focus="risk"
  • "What is the probability of losing more than 10% for GSL?" → intent="stock", symbols=["GSL"], focus="risk"
  • "What does path risk look like for GSL?"               → intent="stock", symbols=["GSL"], focus="risk"
  • "Is the downside risk elevated for GSL?"               → intent="stock", symbols=["GSL"], focus="risk"
  • With prior context lastSymbols=["GSL"], "What is the probability of losing more than 10%?"
    → intent="stock", symbols=["GSL"], isFollowUp=true, focus="risk"
  • Without prior context, "What is the probability of losing more than 10%?"
    → intent="unknown", symbols=[], sectors=[], focus="risk"

Set focus="validated_evidence" only when the user asks whether a stock, sector, regime, or
comparison is evidence-backed, validated by Grahamy's Pipeline, supported by the validation
pipeline, or has validated edge evidence. Keep the normal anchor intent; do not create a separate
intent. Examples:
  • "Is GSL evidence-backed?"                         → intent="stock", symbols=["GSL"], focus="validated_evidence"
  • "Does GSL have validated edge evidence?"          → intent="stock", symbols=["GSL"], focus="validated_evidence"
  • "Does Energy have validated edge evidence?"       → intent="sector", sectors=["Energy"], focus="validated_evidence"
  • "Is the current regime evidence-backed?"          → intent="regime", regimeRequested=true, focus="validated_evidence"
  • With prior context lastSymbols=["GSL"], "Is this setup supported by the pipeline?"
    → intent="stock", symbols=["GSL"], isFollowUp=true, focus="validated_evidence"
  • Without prior context, "Is this setup supported by the pipeline?"
    → intent="unknown", symbols=[], sectors=[], focus="validated_evidence"

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

  const focus = normalizeFocus(raw.focus) ?? inferFocusFromMessage(message);
  let symbols = uniqueUpper(raw.symbols).slice(0, 5);
  let sectors: string[] = unique(raw.sectors).slice(0, 5);
  let regimeRequested = raw.regimeRequested;
  if (
    focus === "risk" &&
    !symbols.length &&
    !sectors.length &&
    !regimeRequested &&
    shouldInheritRiskAnchor(raw, previousContext)
  ) {
    symbols = uniqueUpper(previousContext?.lastSymbols ?? []).slice(0, 5);
    sectors = unique(previousContext?.lastSectors ?? []).slice(0, 5);
    regimeRequested =
      !symbols.length &&
      !sectors.length &&
      typeof previousContext?.lastIntent === "string" &&
      previousContext.lastIntent.includes("regime");
  }
  if (
    focus === "validated_evidence" &&
    !symbols.length &&
    !sectors.length &&
    !regimeRequested &&
    shouldInheritValidatedEvidenceAnchor(raw, previousContext)
  ) {
    symbols = uniqueUpper(previousContext?.lastSymbols ?? []).slice(0, 5);
    sectors = unique(previousContext?.lastSectors ?? []).slice(0, 5);
    regimeRequested =
      !symbols.length &&
      !sectors.length &&
      typeof previousContext?.lastIntent === "string" &&
      previousContext.lastIntent.includes("regime");
  }
  const inferredComparisonAnchors = inferComparisonAnchorsFromMessage(message);
  if (inferredComparisonAnchors) {
    for (const inferredSymbol of inferredComparisonAnchors.symbols) {
      if (!symbols.includes(inferredSymbol)) symbols.push(inferredSymbol);
    }
    for (const inferredSector of inferredComparisonAnchors.sectors) {
      if (!sectors.includes(inferredSector)) sectors.push(inferredSector);
    }
    if (inferredComparisonAnchors.regimeRequested) regimeRequested = true;
    symbols = symbols.slice(0, 5);
    sectors = sectors.slice(0, 5);
  }
  const inferredAnchorlessCapability = inferAnchorlessCapabilityFromMessage(
    message,
    previousContext,
  );
  const factorBacktest =
    normalizeFactorBacktest(raw.factorBacktest) ??
    inferFactorBacktestFromMessage(message);
  const featureCriteria = normalizeFeatureCriteria(raw.featureCriteria) ??
    inferFeatureScreenCriteriaFromMessage(message);

  // Slimmed classifier — the deep agent's PostgresSaver thread carries
  // conversation memory now, so we no longer need the follow-up self-
  // rescue / prior-context-merge branch that the templated answer path
  // depended on. The classifier just emits whichever symbols/sectors/regime
  // the user explicitly named THIS turn. Pure follow-ups like "why?" with
  // no anchors flow through with empty arrays — the downstream agent
  // resolves them via thread memory.
  const inferred = inferIntent(symbols, sectors, regimeRequested, raw.isFollowUp);
  const hasRiskAnchor = focus === "risk" && (symbols.length > 0 || sectors.length > 0 || regimeRequested);
  const hasValidatedEvidenceAnchor =
    focus === "validated_evidence" &&
    (symbols.length > 0 || sectors.length > 0 || regimeRequested);
  // Trust the LLM's "unknown" verdict; otherwise re-derive intent from the
  // resolved (symbols, sectors, regime) tuple so requiresTools and intent
  // stay consistent even if the model returned a mismatched label.
  const intent: Intent = factorBacktest
    ? "factor_conditioned_backtest"
    : featureCriteria.length
      ? "feature_screen"
      : inferredAnchorlessCapability
        ? inferredAnchorlessCapability
        : focus === "risk" && !hasRiskAnchor
          ? "unknown"
          : focus === "validated_evidence" && !hasValidatedEvidenceAnchor
            ? "unknown"
            : hasRiskAnchor
              ? inferred
              : hasValidatedEvidenceAnchor
                ? inferred
                : raw.intent === "unknown"
                  ? "unknown"
                  : isAnchorlessCapabilityIntent(raw.intent)
                    ? raw.intent
                    : inferredAnchorlessCapability ?? inferred;
  const includeFocus =
    (focus === "risk" || focus === "validated_evidence") &&
    intent !== "unknown" &&
    !isAnchorlessCapabilityIntent(intent);

  return {
    intent,
    symbols,
    sectors,
    regimeRequested,
    isFollowUp: raw.isFollowUp,
    ...(includeFocus ? { focus } : {}),
    ...(intent === "feature_screen" ? { featureCriteria } : {}),
    ...(intent === "factor_conditioned_backtest" && factorBacktest
      ? { factorBacktest }
      : {}),
    requiresTools: toolsForIntent(intent),
    confidence: raw.confidence,
    warnings:
      intent === "unknown"
        ? ["Could not classify the message into stock, sector, or regime context."]
        : [],
  };
}

function normalizeFocus(
  focus: ClassifierOutput["focus"],
): "risk" | "validated_evidence" | undefined {
  return focus === "risk" || focus === "validated_evidence" ? focus : undefined;
}

function inferFocusFromMessage(message: string): "risk" | "validated_evidence" | undefined {
  if (
    /\b(evidence[-\s]?backed|validated\s+edge|edge\s+evidence|validated\s+evidence|validation\s+pipeline|supported\s+by\s+(?:the\s+)?pipeline|pipeline\s+(?:confirm|confirms|validated|validation)|evidence\s+behind)\b/i.test(
      message,
    )
  ) {
    return "validated_evidence";
  }
  return /\b(risky|risk|drawdown|downside|fall|drop|lose|losing|loss|path\s+risk)\b/i.test(message)
    ? "risk"
    : undefined;
}

function shouldInheritRiskAnchor(
  raw: ClassifierOutput,
  previousContext?: ConversationContext,
): boolean {
  if (!previousContext) return false;
  if (!raw.isFollowUp && raw.intent !== "follow_up" && raw.intent !== "unknown") return false;
  return (
    previousContext.lastSymbols.length > 0 ||
    previousContext.lastSectors.length > 0 ||
    (typeof previousContext.lastIntent === "string" &&
      previousContext.lastIntent.includes("regime"))
  );
}

function shouldInheritValidatedEvidenceAnchor(
  raw: ClassifierOutput,
  previousContext?: ConversationContext,
): boolean {
  if (!previousContext) return false;
  if (!raw.isFollowUp && raw.intent !== "follow_up" && raw.intent !== "unknown") return false;
  return (
    previousContext.lastSymbols.length > 0 ||
    previousContext.lastSectors.length > 0 ||
    (typeof previousContext.lastIntent === "string" &&
      previousContext.lastIntent.includes("regime"))
  );
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
    case "feature_screen":
    case "factor_conditioned_backtest":
    case "market_regime_historical_playbook":
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
    intent === "stock_idea_discovery" ||
    intent === "feature_screen" ||
    intent === "factor_conditioned_backtest" ||
    intent === "market_regime_historical_playbook"
  );
}

function inferAnchorlessCapabilityFromMessage(
  message: string,
  previousContext?: ConversationContext,
): Intent | undefined {
  if (
    /\bwhat\s+is\s+(?:the\s+)?(?:current\s+)?market\s+regime\s+(?:now|today|currently)\b/i.test(
      message,
    )
  ) {
    return undefined;
  }
  if (
    /\bwhat\s+changed\s+since\s+last\s+week\b/i.test(message) &&
    previousContext?.lastSymbols.length
  ) {
    return undefined;
  }
  if (
    /\b(?:what\s+usually\s+works|what\s+usually\s+underperforms|historically\s+lead|historically\s+leads|historically\s+underperform|historically\s+underperforms|usually\s+favou?r|interpret\s+the\s+current\s+regime\s+historically|risks?\s+(?:matter|in|for).*regime|regime\s+risks?)\b/i.test(
      message,
    )
  ) {
    return "market_regime_historical_playbook";
  }
  return undefined;
}

function normalizeFactorBacktest(
  input: ClassifierOutput["factorBacktest"],
): FactorBacktestClassification | undefined {
  if (!input) return undefined;
  const criteria = uniqueFactorBacktestCriteria(
    input.criteria
      .map((item) => normalizeFactorBacktestCriterion(item.factor, item.bucket))
      .filter((item): item is FactorBacktestCriterion => !!item),
  );
  const horizon = normalizeFactorBacktestHorizon(input.horizon ?? undefined);
  const unsupportedHorizon = input.unsupportedHorizon?.trim() || undefined;
  const unsupportedCriteria = (input.unsupportedCriteria ?? [])
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 5);
  const notes = (input.notes ?? [])
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 5);
  if (!criteria.length && !horizon && !unsupportedHorizon && !unsupportedCriteria.length) {
    return undefined;
  }
  return {
    criteria,
    horizon: horizon ?? "60-day",
    ...(unsupportedHorizon && !horizon ? { unsupportedHorizon } : {}),
    ...(unsupportedCriteria.length ? { unsupportedCriteria } : {}),
    ...(notes.length ? { notes } : {}),
  };
}

function inferFactorBacktestFromMessage(
  message: string,
): FactorBacktestClassification | undefined {
  if (!looksLikeFactorBacktestRequest(message)) return undefined;
  const criteria: FactorBacktestCriterion[] = [];
  const unsupportedCriteria: string[] = [];
  const notes: string[] = [];

  if (/\b(?:rsi\s+(?:is\s+)?low|low\s+rsi|oversold)\b/i.test(message)) {
    criteria.push({ factor: "momentum", bucket: "WEAK" });
    notes.push(
      "In V1, low-RSI requests are represented by the public weak momentum bucket; no raw RSI threshold is exposed.",
    );
  }

  if (/\b(cheap|value|undervalued|attractive\s+valuation|valuation\s+is\s+attractive|attractively\s+valued)\b/i.test(message)) {
    criteria.push({ factor: "valuation", bucket: "ATTRACTIVE" });
  } else if (/\bfair(?:ly)?\s+(?:valued|valuation)\b/i.test(message)) {
    criteria.push({ factor: "valuation", bucket: "FAIR" });
  } else if (/\b(expensive|rich|overvalued)\b/i.test(message)) {
    criteria.push({ factor: "valuation", bucket: "RICH" });
  }

  if (/\b(strong|high)[-\s]?quality\b/i.test(message) || /\bquality\s+is\s+strong\b/i.test(message)) {
    criteria.push({ factor: "quality", bucket: "STRONG" });
  } else if (/\bconstructive\s+quality\b/i.test(message)) {
    criteria.push({ factor: "quality", bucket: "CONSTRUCTIVE" });
  } else if (/\bweak\s+quality\b/i.test(message)) {
    criteria.push({ factor: "quality", bucket: "WEAK" });
  }

  if (/\bstrong\s+momentum\b/i.test(message)) {
    criteria.push({ factor: "momentum", bucket: "STRONG" });
  } else if (/\b(?:positive|constructive)\s+momentum\b/i.test(message)) {
    criteria.push({ factor: "momentum", bucket: "CONSTRUCTIVE" });
  } else if (/\b(?:low|weak)\s+momentum\b/i.test(message) || /\bmomentum\s+is\s+weak\b/i.test(message)) {
    criteria.push({ factor: "momentum", bucket: "WEAK" });
  }

  if (/\bstrong\s+growth\b/i.test(message)) {
    criteria.push({ factor: "growth", bucket: "STRONG" });
  } else if (/\bweak\s+growth\b/i.test(message)) {
    criteria.push({ factor: "growth", bucket: "WEAK" });
  }

  if (/\b(strong\s+(?:balance\s+sheet|leverage)|low\s+leverage)\b/i.test(message)) {
    criteria.push({ factor: "leverage", bucket: "STRONG" });
  } else if (/\b(stressed\s+leverage|high\s+leverage|debt\s+stressed|stressed\s+balance\s+sheet)\b/i.test(message)) {
    criteria.push({ factor: "leverage", bucket: "STRESSED" });
  }

  if (/\binsider(?:\s+(?:buying|purchases?|activity|ownership))?\b/i.test(message)) {
    unsupportedCriteria.push("insider buying");
  }

  for (const mention of findSectorMentions(message)) {
    criteria.push({ factor: "sector", bucket: mention.label });
    break;
  }

  const horizon = inferFactorBacktestHorizon(message);
  return {
    criteria: uniqueFactorBacktestCriteria(criteria),
    horizon: horizon.horizon ?? "60-day",
    ...(horizon.unsupportedHorizon ? { unsupportedHorizon: horizon.unsupportedHorizon } : {}),
    ...(unsupportedCriteria.length ? { unsupportedCriteria } : {}),
    ...(notes.length ? { notes: Array.from(new Set(notes)).slice(0, 5) } : {}),
  };
}

function looksLikeFactorBacktestRequest(message: string): boolean {
  if (/\bregime\b/i.test(message)) return false;
  if (/\bsectors?\b/i.test(message) && !/\bstocks?\b/i.test(message)) return false;
  const hasHistoricalAsk =
    /\b(historical|historically|backtest|worked|work\s+historically|forward\s+profile|factor\s+setup|behav(?:e|ed)|base[-\s]?rate)\b/i.test(
      message,
    );
  const hasFactorLanguage =
    /\b(rsi|valuation|valued|cheap|value|quality|momentum|growth|leverage|insider(?:\s+(?:buying|purchases?|activity|ownership))?|factor\s+setup)\b/i.test(
      message,
    );
  return hasHistoricalAsk && hasFactorLanguage;
}

function inferFactorBacktestHorizon(
  message: string,
): { horizon?: FactorBacktestHorizon; unsupportedHorizon?: string } {
  const match = message.match(/\b(20|40|60|120|252|[1-9][0-9]{0,2})[-\s]?(?:day|days|d)\b/i);
  const raw = match?.[1];
  if (!raw) return { horizon: "60-day" };
  const horizon = normalizeFactorBacktestHorizon(`${raw}-day`);
  return horizon ? { horizon } : { unsupportedHorizon: `${raw}-day` };
}

function normalizeFactorBacktestHorizon(
  value: string | null | undefined,
): FactorBacktestHorizon | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "-");
  if (normalized === "20-day" || normalized === "20-days") return "20-day";
  if (normalized === "40-day" || normalized === "40-days") return "40-day";
  if (normalized === "60-day" || normalized === "60-days") return "60-day";
  if (normalized === "120-day" || normalized === "120-days") return "120-day";
  if (normalized === "252-day" || normalized === "252-days") return "252-day";
  return undefined;
}

function normalizeFeatureCriteria(
  criteria: ClassifierOutput["featureCriteria"],
): FeatureScreenCriterion[] | undefined {
  if (!criteria?.length) return undefined;
  const normalized = uniqueCriteria(
    criteria
      .map((item) => normalizeFeatureCriterion(item.factor, item.bucket))
      .filter((item): item is FeatureScreenCriterion => !!item),
  );
  return normalized.length ? normalized : undefined;
}

function inferFeatureScreenCriteriaFromMessage(
  message: string,
): FeatureScreenCriterion[] {
  if (!looksLikeFeatureScreenRequest(message)) return [];
  const normalized = message.toLowerCase();
  const criteria: FeatureScreenCriterion[] = [];

  if (/\b(cheap|value|undervalued|attractive\s+valuation|attractively\s+valued)\b/i.test(message)) {
    criteria.push({ factor: "valuation", bucket: "ATTRACTIVE" });
  } else if (/\bfair(?:ly)?\s+(?:valued|valuation)\b/i.test(message)) {
    criteria.push({ factor: "valuation", bucket: "FAIR" });
  } else if (/\b(expensive|rich|overvalued)\b/i.test(message)) {
    criteria.push({ factor: "valuation", bucket: "RICH" });
  }

  if (/\b(strong|high)[-\s]?quality\b/i.test(message) || /\bquality\s+stocks\b/i.test(message)) {
    criteria.push({ factor: "quality", bucket: "STRONG" });
  } else if (/\bconstructive\s+quality\b/i.test(message)) {
    criteria.push({ factor: "quality", bucket: "CONSTRUCTIVE" });
  } else if (/\bweak\s+quality\b/i.test(message)) {
    criteria.push({ factor: "quality", bucket: "WEAK" });
  }

  if (/\bstrong\s+momentum\b/i.test(message)) {
    criteria.push({ factor: "momentum", bucket: "STRONG" });
  } else if (/\b(positive|constructive)\s+momentum\b/i.test(message)) {
    criteria.push({ factor: "momentum", bucket: "CONSTRUCTIVE" });
  } else if (/\bweak\s+momentum\b/i.test(message)) {
    criteria.push({ factor: "momentum", bucket: "WEAK" });
  }

  if (/\bstrong\s+growth\b/i.test(message)) {
    criteria.push({ factor: "growth", bucket: "STRONG" });
  } else if (/\bweak\s+growth\b/i.test(message)) {
    criteria.push({ factor: "growth", bucket: "WEAK" });
  }

  if (/\b(strong\s+(?:balance\s+sheet|leverage)|low\s+leverage)\b/i.test(message)) {
    criteria.push({ factor: "leverage", bucket: "STRONG" });
  } else if (/\b(stressed\s+leverage|high\s+leverage|debt\s+stressed|stressed\s+balance\s+sheet)\b/i.test(message)) {
    criteria.push({ factor: "leverage", bucket: "STRESSED" });
  }

  if (/\belevated\s+risk\b/i.test(message)) {
    criteria.push({ factor: "risk", bucket: "ELEVATED" });
  } else if (/\blow\s+risk\b/i.test(message)) {
    criteria.push({ factor: "risk", bucket: "LOW" });
  }

  for (const mention of findSectorMentions(message)) {
    criteria.push({ factor: "sector", bucket: mention.label });
    break;
  }

  return uniqueCriteria(criteria);
}

function looksLikeFeatureScreenRequest(message: string): boolean {
  const hasScreenVerb =
    /\b(find|screen|show|list|which\s+stocks|stocks\s+with|stocks\s+that|give\s+me)\b/i.test(
      message,
    );
  const hasScreenNoun = /\bstocks?\b/i.test(message);
  const hasCriteria =
    /\b(cheap|value|undervalued|attractive|valuation|expensive|rich|quality|momentum|growth|leverage|balance\s+sheet|risk|Industrials|Technology|Healthcare|Energy|Utilities|Financial Services|Basic Materials|Consumer Defensive|Consumer Cyclical|Communication Services|Real Estate|Semiconductors)\b/i.test(
      message,
    );
  return (hasScreenVerb || hasScreenNoun) && hasCriteria;
}

function normalizeFeatureCriterion(
  factor: FeatureScreenFactor,
  bucket: string,
): FeatureScreenCriterion | undefined {
  const normalizedBucket = bucket.trim();
  if (!normalizedBucket) return undefined;
  const upper = normalizedBucket.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  switch (factor) {
    case "valuation":
      if (["CHEAP", "ATTRACTIVE", "UNDERVALUED", "VALUE"].includes(upper)) {
        return { factor, bucket: "ATTRACTIVE" };
      }
      if (["FAIR", "FAIR_VALUE", "FAIRLY_VALUED"].includes(upper)) {
        return { factor, bucket: "FAIR" };
      }
      if (["EXPENSIVE", "RICH", "OVERVALUED"].includes(upper)) {
        return { factor, bucket: "RICH" };
      }
      return undefined;
    case "quality":
      if (["STRONG", "HIGH", "HIGH_QUALITY"].includes(upper)) return { factor, bucket: "STRONG" };
      if (["CONSTRUCTIVE", "MODERATE"].includes(upper)) return { factor, bucket: "CONSTRUCTIVE" };
      if (["WEAK", "LOW"].includes(upper)) return { factor, bucket: "WEAK" };
      return undefined;
    case "momentum":
      if (["STRONG", "HIGH"].includes(upper)) return { factor, bucket: "STRONG" };
      if (["POSITIVE", "CONSTRUCTIVE"].includes(upper)) return { factor, bucket: "CONSTRUCTIVE" };
      if (["WEAK", "NEGATIVE", "LOW"].includes(upper)) return { factor, bucket: "WEAK" };
      return undefined;
    case "growth":
      if (["STRONG", "HIGH"].includes(upper)) return { factor, bucket: "STRONG" };
      if (["WEAK", "LOW", "NEGATIVE"].includes(upper)) return { factor, bucket: "WEAK" };
      return undefined;
    case "leverage":
      if (["STRONG", "LOW", "LOW_LEVERAGE", "HEALTHY"].includes(upper)) {
        return { factor, bucket: "STRONG" };
      }
      if (["STRESSED", "HIGH", "HIGH_LEVERAGE", "WEAK"].includes(upper)) {
        return { factor, bucket: "STRESSED" };
      }
      return undefined;
    case "risk":
      if (["ELEVATED", "HIGH"].includes(upper)) return { factor, bucket: "ELEVATED" };
      if (["LOW"].includes(upper)) return { factor, bucket: "LOW" };
      return undefined;
    case "sector": {
      const sector = canonicalSectorLabel(normalizedBucket);
      return sector ? { factor, bucket: sector } : undefined;
    }
  }
}

function normalizeFactorBacktestCriterion(
  factor: FactorBacktestFactor,
  bucket: string,
): FactorBacktestCriterion | undefined {
  const normalizedBucket = bucket.trim();
  if (!normalizedBucket) return undefined;
  const upper = normalizedBucket.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  switch (factor) {
    case "valuation":
      if (["CHEAP", "ATTRACTIVE", "UNDERVALUED", "VALUE"].includes(upper)) {
        return { factor, bucket: "ATTRACTIVE" };
      }
      if (["FAIR", "FAIR_VALUE", "FAIRLY_VALUED"].includes(upper)) {
        return { factor, bucket: "FAIR" };
      }
      if (["EXPENSIVE", "RICH", "OVERVALUED"].includes(upper)) {
        return { factor, bucket: "RICH" };
      }
      return undefined;
    case "quality":
      if (["STRONG", "HIGH", "HIGH_QUALITY"].includes(upper)) return { factor, bucket: "STRONG" };
      if (["CONSTRUCTIVE", "MODERATE"].includes(upper)) return { factor, bucket: "CONSTRUCTIVE" };
      if (["WEAK", "LOW"].includes(upper)) return { factor, bucket: "WEAK" };
      return undefined;
    case "momentum":
      if (["STRONG", "HIGH"].includes(upper)) return { factor, bucket: "STRONG" };
      if (["POSITIVE", "CONSTRUCTIVE"].includes(upper)) return { factor, bucket: "CONSTRUCTIVE" };
      if (["WEAK", "LOW", "NEGATIVE", "LOW_RSI", "OVERSOLD"].includes(upper)) {
        return { factor, bucket: "WEAK" };
      }
      return undefined;
    case "growth":
      if (["STRONG", "HIGH"].includes(upper)) return { factor, bucket: "STRONG" };
      if (["WEAK", "LOW", "NEGATIVE"].includes(upper)) return { factor, bucket: "WEAK" };
      return undefined;
    case "leverage":
      if (["STRONG", "LOW", "LOW_LEVERAGE", "HEALTHY"].includes(upper)) {
        return { factor, bucket: "STRONG" };
      }
      if (["STRESSED", "HIGH", "HIGH_LEVERAGE", "WEAK"].includes(upper)) {
        return { factor, bucket: "STRESSED" };
      }
      return undefined;
    case "sector": {
      const sector = canonicalSectorLabel(normalizedBucket);
      return sector ? { factor, bucket: sector } : undefined;
    }
  }
}

function uniqueCriteria(criteria: FeatureScreenCriterion[]): FeatureScreenCriterion[] {
  const seen = new Set<string>();
  const out: FeatureScreenCriterion[] = [];
  for (const item of criteria) {
    const key = `${item.factor}:${item.bucket}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.slice(0, 7);
}

function uniqueFactorBacktestCriteria(
  criteria: FactorBacktestCriterion[],
): FactorBacktestCriterion[] {
  const seen = new Set<string>();
  const out: FactorBacktestCriterion[] = [];
  for (const item of criteria) {
    const key = `${item.factor}:${item.bucket}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.slice(0, 6);
}

type InferredComparisonAnchors = {
  symbols: string[];
  sectors: string[];
  regimeRequested: boolean;
};

/**
 * Backstop for comparison-style messages — extracts ALL named entities and
 * any market/regime context. Runs after the LLM classifier so it only adds
 * anchors the LLM may have missed (or, for the deterministic fallback, fills
 * them in entirely). Returns undefined when the message doesn't look like a
 * comparison, so we don't widen anchors on plain "stock X" turns.
 */
function inferComparisonAnchorsFromMessage(
  message: string,
): InferredComparisonAnchors | undefined {
  const hasComparisonCue = /\b(compare|versus|vs\.?|stronger|better|weaker|worse|or)\b/i.test(message)
    || /\b(?:its|the)\s+(?:sector|industry)\b/i.test(message)
    || /\bindustry\/sector\b/i.test(message);
  if (!hasComparisonCue) return undefined;

  const sectorMentions = findSectorMentions(message).map((m) => m.label);
  const tickerTokens = extractTickerLikeTokens(message).filter(
    (token) => !canonicalSectorLabel(token),
  );
  const regimeRequested = mentionsRegime(message);

  // Only treat as a comparison candidate when the user clearly named ≥2
  // entities of any kind (2+ stocks, 2+ sectors, or a stock+sector pair).
  const totalAnchors = sectorMentions.length + tickerTokens.length;
  const hasStockSectorPair =
    tickerTokens.length >= 1 &&
    (sectorMentions.length >= 1 ||
      /\b(?:its|the)\s+(?:sector|industry)\b/i.test(message) ||
      /\bindustry\/sector\b/i.test(message));
  if (totalAnchors < 2 && !hasStockSectorPair && !regimeRequested) {
    return undefined;
  }

  return {
    symbols: tickerTokens,
    sectors: sectorMentions,
    regimeRequested,
  };
}

function mentionsRegime(message: string): boolean {
  return /\b(?:market\s+regime|regime|macro|market\s+context|market\s+backdrop|the\s+market)\b/i.test(
    message,
  );
}

function extractTickerLikeTokens(message: string): string[] {
  const ignored = new Set([
    "COMPARE",
    "WHICH",
    "STRONGER",
    "BETTER",
    "WEAKER",
    "WORSE",
    "THAN",
    "VERSUS",
    "WITH",
    "AND",
    "OR",
    "LOOKS",
    "SECTOR",
    "MARKET",
    "REGIME",
    "THE",
    "ITS",
    "IS",
  ]);
  const matches = message.match(/\b[A-Z][A-Z0-9.]{0,9}\b/g) ?? [];
  return Array.from(
    new Set(
      matches
        .map((token) => token.trim().toUpperCase())
        .filter((token) => token.length > 0 && !ignored.has(token)),
    ),
  ).slice(0, 5);
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
