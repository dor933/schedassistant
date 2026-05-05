import { createDeepAgent } from "deepagents";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { ChatOpenAI } from "@langchain/openai";
import { logger } from "../logger";
import { resolveOrgVendorByOrg } from "../utils/resolveOrgVendor.service";
import { getLangfuseCallbackHandler, flushLangfuse } from "../langfuse";
import type {
  AnalystBrief,
  EvidencePack,
} from "./analystTypes";
import {
  buildAnalystBriefContract,
  buildEvidencePack,
  formatAnalystBriefContractForPrompt,
  formatEvidencePackForPrompt,
} from "./analystOrchestration";
import type {
  AskGrahamyState,
  CachedResearchObject,
  ClassificationFocus,
  PgCapabilityViews,
  PipelineOverlayViews,
} from "./types";

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

// ─── Enum humanizer ──────────────────────────────────────────────────────────
//
// The v6 SQL emits bucket labels as ALL_CAPS_WITH_UNDERSCORES (RICH,
// HIGH_QUINTILE, STRONG_UNDERPERFORM, BELOW_OWN_HISTORY, ...). When the
// agent sees these verbatim in the JSON it copies them straight into prose.
// Translate at the source — humanize every string value before injecting
// the evidence into the system prompt.

const HUMANIZE_OVERRIDES: Record<string, string> = {
  MEGA_CAP: "mega-cap",
  LARGE_CAP: "large-cap",
  MID_CAP: "mid-cap",
  SMALL_CAP: "small-cap",
  MICRO_CAP: "micro-cap",
  STRONG_UP: "strongly up",
  DOWN_HARD: "sharply down",
  STRONG_OUTPERFORM: "strongly outperforming",
  STRONG_UNDERPERFORM: "strongly underperforming",
  IN_LINE: "in-line",
  STRONG_RALLY: "a strong rally",
  WITHIN_5_DAYS: "within 5 days",
  WITHIN_10_DAYS: "within 10 days",
  WITHIN_30_DAYS: "within 30 days",
  WITHIN_TWO_WEEKS: "within two weeks",
  BEYOND_30_DAYS: "beyond 30 days",
  NONE_SCHEDULED: "none scheduled",
  NONE_IN_90D: "none in the last 90 days",
  HIGH_QUINTILE: "high quintile",
  LOW_QUINTILE: "low quintile",
  TOP_QUINTILE: "top quintile",
  BOTTOM_QUINTILE: "bottom quintile",
  MID_QUINTILE: "middle quintile",
  TOP_QUARTILE: "top quartile",
  ABOVE_MEDIAN: "above median",
  BELOW_MEDIAN: "below median",
  BOTTOM_QUARTILE: "bottom quartile",
  WELL_BELOW_OWN_HISTORY: "well below its own 10-year history",
  BELOW_OWN_HISTORY: "below its own 10-year history",
  AT_OWN_HISTORY: "in line with its own 10-year history",
  ABOVE_OWN_HISTORY: "above its own 10-year history",
  WELL_ABOVE_OWN_HISTORY: "well above its own 10-year history",
  POOR_CONVERSION: "poor conversion (under 50%)",
  AT_PARITY: "at parity",
  BELOW_PARITY: "below parity",
  STRONG_CONVERSION: "strong conversion",
  NEGATIVE_FAVORABLE: "favorably negative (free working-capital funding)",
  HEAVY_INVESTMENT: "heavy investment",
  CAPITAL_INTENSIVE: "capital-intensive",
  CAPITAL_LIGHT: "capital-light",
  BUYING_BACK_AGGRESSIVELY: "aggressively buying back shares",
  BUYING_BACK: "buying back shares",
  MILD_DILUTION: "mild dilution",
  HEAVY_DILUTION: "heavy dilution",
  AT_OR_ABOVE_FCF: "at or above free-cash-flow",
  ABOVE_FCF: "above free-cash-flow",
  LEVERAGING_UP: "leveraging up",
  AGGRESSIVE_LEVERAGING: "aggressively leveraging up",
  WIDENING_BEAT: "widening beat margins",
  NARROWING_BEAT: "narrowing beat margins",
  LARGE_BEAT: "large beat",
  LARGE_MISS: "large miss",
  SAFE_ZONE: "safe zone",
  GREY_ZONE: "grey zone",
  DISTRESS_ZONE: "distress zone",
  HIGH_VARIANCE: "high variance",
  SPIKE_FLAG: "unusually elevated (spike flag)",
  BELOW_ONE: "below 1.0",
  DEEP_VALUE: "deep value",
  BOLT_ON: "bolt-on (small)",
  MID_SIZED: "mid-sized",
  conviction_but_weak_price_action:
    "conviction is constructive but price action is weak",
  price_action_confirms_conviction: "price action confirms conviction",
  price_momentum_without_conviction: "price momentum without conviction support",
  in_line: "in-line",
  conviction_delta: "conviction delta",
  momentum_delta: "momentum delta",
  deterioration: "deterioration",
  overall_change: "overall change",
  improved: "improved",
  deteriorated: "deteriorated",
  flat: "flat",
  stock_vs_sector: "stock-versus-sector",
  sector_vs_sector: "sector-versus-sector",
  symbol_vs_symbol: "symbol-versus-symbol",
  leader: "leader",
  laggard: "laggard",
  mixed: "mixed",
  BROAD: "broad",
  NARROW: "narrow",
  STRESSED: "stressed",
  DRAWDOWN: "drawdown",
  // Regime labels: keep recognizable casing but spaceful
  RISK_ON: "RISK-ON",
  RISK_OFF: "RISK-OFF",
};

const ENUM_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$|^[A-Z][A-Z0-9]{2,}$/;
const SYMBOL_PRESERVE_KEYS = new Set([
  "symbol",
  "symbols",
  "anchor",
  "cacheKey",
  "researchObjectKeys",
]);

function humanizeEnum(value: string): string {
  if (HUMANIZE_OVERRIDES[value]) return HUMANIZE_OVERRIDES[value];
  if (!ENUM_PATTERN.test(value)) return value;
  // Generic: lowercase + replace underscores. Preserves regime labels (NEUTRAL).
  if (value === "NEUTRAL") return "NEUTRAL"; // keep regime label uppercase
  return value.toLowerCase().replace(/_/g, " ");
}

function polishPromptText(value: string): string {
  return value
    .replace(/\bhistorical\/base-rate\b/gi, "historical")
    .replace(/\bbase-rate\b/gi, "historical evidence")
    .replace(/\bpublic safety cap\b/gi, "bounded public sample")
    .replace(/\bsafety cap\b/gi, "bounded sample")
    .replace(/\bwarehouse\b/gi, "historical dataset")
    .replace(/\bpath-risk\b/gi, "daily drawdown risk")
    .replace(/\bbuy\/sell recommendations?\b/gi, "investment recommendations")
    .replace(/\bbuy\/sell recommendation language\b/gi, "investment recommendation language");
}

function humanizeJsonValue(value: unknown, key?: string): unknown {
  if (SYMBOL_PRESERVE_KEYS.has(key ?? "")) return value;
  if (typeof value === "string") return polishPromptText(humanizeEnum(value));
  if (Array.isArray(value)) return value.map((item) => humanizeJsonValue(item, key));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = humanizeJsonValue(v, k);
    }
    return out;
  }
  return value;
}

function formatResearchObjectForPrompt(
  ro: CachedResearchObject,
  focus?: ClassificationFocus,
): string {
  const header = `## ${ro.objectType.toUpperCase()} — ${ro.anchor} (as of ${ro.asOfDate})`;
  const publicResearchObjectView = ro.view
    ? focus === "risk"
      ? {
          viewSchemaVersion: ro.view.viewSchemaVersion,
          cacheKey: ro.view.cacheKey,
          objectType: ro.view.objectType,
          anchor: ro.view.anchor,
          asOfDate: ro.view.asOfDate,
          title: ro.view.title,
          probabilisticEvidence: ro.view.probabilisticEvidence,
          pathRisk: ro.view.pathRisk,
          freshness: ro.view.freshness,
          warnings: ro.view.warnings,
        }
      : { ...ro.view, publicSummary: undefined }
    : undefined;
  // Humanize all enum-shaped string values before serializing so the agent
  // receives "rich" / "high quintile" / "strongly underperforming" instead of
  // "RICH" / "HIGH_QUINTILE" / "STRONG_UNDERPERFORM".
  const humanized = humanizeJsonValue({
    publicResearchObjectView,
    freshness: ro.freshness,
    warnings: ro.warnings,
  });
  const body = JSON.stringify(humanized, null, 2);
  return `${header}\n\`\`\`json\n${body}\n\`\`\``;
}

function formatPgCapabilitiesForPrompt(views: PgCapabilityViews | undefined): string[] {
  const blocks: string[] = [];
  if (views?.sectorLeaderboardView) {
    const humanized = humanizeJsonValue({
      sectorLeaderboardView: views.sectorLeaderboardView,
      freshness: views.sectorLeaderboardView.freshness,
      warnings: views.sectorLeaderboardView.warnings,
    });
    blocks.push(
      `## SECTOR LEADERBOARD — PG historical intelligence\n\`\`\`json\n${JSON.stringify(humanized, null, 2)}\n\`\`\``,
    );
  }
  if (views?.sectorDivergenceView) {
    const humanized = humanizeJsonValue({
      sectorDivergenceView: views.sectorDivergenceView,
      freshness: views.sectorDivergenceView.freshness,
      warnings: views.sectorDivergenceView.warnings,
    });
    blocks.push(
      `## SECTOR MOMENTUM VS CONVICTION DIVERGENCE — PG historical intelligence\n\`\`\`json\n${JSON.stringify(humanized, null, 2)}\n\`\`\``,
    );
  }
  if (views?.sectorDeltaView) {
    const humanized = humanizeJsonValue({
      sectorDeltaView: views.sectorDeltaView,
      freshness: views.sectorDeltaView.freshness,
      warnings: views.sectorDeltaView.warnings,
    });
    blocks.push(
      `## WEEK-OVER-WEEK SECTOR DELTA — PG historical intelligence\n\`\`\`json\n${JSON.stringify(humanized, null, 2)}\n\`\`\``,
    );
  }
  if (views?.stockIdeaView) {
    const humanized = humanizeJsonValue({
      stockIdeaView: views.stockIdeaView,
      freshness: views.stockIdeaView.freshness,
      warnings: views.stockIdeaView.warnings,
    });
    blocks.push(
      `## STOCK IDEA DISCOVERY — PG historical intelligence\n\`\`\`json\n${JSON.stringify(humanized, null, 2)}\n\`\`\``,
    );
  }
  if (views?.featureScreenView) {
    const humanized = humanizeJsonValue({
      featureScreenView: views.featureScreenView,
      freshness: views.featureScreenView.freshness,
      warnings: views.featureScreenView.warnings,
    });
    blocks.push(
      `## FEATURE SCREEN — PG current-feature screen\n\`\`\`json\n${JSON.stringify(humanized, null, 2)}\n\`\`\``,
    );
  }
  if (views?.factorBacktestView) {
    const humanized = humanizeJsonValue({
      factorBacktestView: views.factorBacktestView,
      freshness: views.factorBacktestView.freshness,
      warnings: views.factorBacktestView.warnings,
    });
    blocks.push(
      `## FACTOR-CONDITIONED BACKTEST — PG historical evidence\n\`\`\`json\n${JSON.stringify(humanized, null, 2)}\n\`\`\``,
    );
  }
  if (views?.comparisonView) {
    const humanized = humanizeJsonValue({
      comparisonView: views.comparisonView,
      freshness: views.comparisonView.freshness,
      warnings: views.comparisonView.warnings,
    });
    blocks.push(
      `## COMPARISON — PG historical intelligence\n\`\`\`json\n${JSON.stringify(humanized, null, 2)}\n\`\`\``,
    );
  }
  if (views?.regimeHistoricalPlaybookView) {
    const humanized = humanizeJsonValue({
      regimeHistoricalPlaybookView: views.regimeHistoricalPlaybookView,
      freshness: views.regimeHistoricalPlaybookView.freshness,
      warnings: views.regimeHistoricalPlaybookView.warnings,
    });
    blocks.push(
      `## MARKET REGIME HISTORICAL PLAYBOOK — PG historical intelligence\n\`\`\`json\n${JSON.stringify(humanized, null, 2)}\n\`\`\``,
    );
  }
  return blocks;
}

function formatPipelineOverlaysForPrompt(
  views: PipelineOverlayViews | undefined,
): string[] {
  const blocks: string[] = [];
  if (views?.validatedEdgeEvidenceView) {
    const humanized = humanizeJsonValue({
      validatedEdgeEvidenceView: views.validatedEdgeEvidenceView,
      freshness: views.validatedEdgeEvidenceView.freshness,
      warnings: views.validatedEdgeEvidenceView.warnings,
    });
    blocks.push(
      `## VALIDATED EDGE EVIDENCE — Grahamy Client API public overlay\n\`\`\`json\n${JSON.stringify(humanized, null, 2)}\n\`\`\``,
    );
  }
  return blocks;
}

function formatCompoundResearchContextForPrompt(
  state: AskGrahamyState,
): string[] {
  if (!state.compoundResearchContext) return [];
  const context = humanizeJsonValue(state.compoundResearchContext);
  return [
    `## COMPOUND RESEARCH CONTEXT — public-safe execution summary\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\``,
  ];
}

export function buildSystemPrompt(state: AskGrahamyState): string {
  const ros = state.researchObjects ?? [];
  const classification = state.classification;
  const dailyBrief = state.snapshots?.daily_brief as Record<string, unknown> | undefined;
  const todayRegime = typeof dailyBrief?.regime === "string" ? dailyBrief.regime : undefined;
  const freshness = state.snapshots?.freshness;
  const evidencePack: EvidencePack =
    state.evidencePack ?? buildEvidencePack(state);
  const analystBrief: AnalystBrief =
    state.analystBrief ?? buildAnalystBriefContract(evidencePack);

  const evidenceBlocks =
    classification?.focus === "validated_evidence"
      ? formatPipelineOverlaysForPrompt(state.pipelineOverlayViews)
      : [
          ...ros.map((ro) => formatResearchObjectForPrompt(ro, classification?.focus)),
          ...formatPgCapabilitiesForPrompt(state.pgCapabilityViews),
          ...formatPipelineOverlaysForPrompt(state.pipelineOverlayViews),
          ...formatCompoundResearchContextForPrompt(state),
        ];
  const evidence = evidenceBlocks.length === 0
    ? "(No specific Research Objects or PG capability views were loaded for this turn — answer from your conversational memory and acknowledge the limitation.)"
    : evidenceBlocks.join("\n\n");

  const classifiedLine = classification
    ? `Symbols: [${classification.symbols.join(", ") || "none"}], Sectors: [${classification.sectors.join(", ") || "none"}], Regime requested: ${classification.regimeRequested ? "yes" : "no"}, Focus: ${classification.focus ?? "none"}`
    : "(no classification)";

  return `You are **Grahamy** — StocksScanner's AI stock-research assistant.

Your job is to answer the user's specific question, conversationally, using the bucketed evidence below. This is one turn in an ongoing conversation; your prior turns are in your memory (PostgresSaver thread).

# Style guide
- Be direct, conversational, and concise. Address the user's specific question — don't restate the entire data sheet on every turn.
- Use bullet points only when listing things; otherwise plain prose.
- Match the language of the user's question (English / Hebrew / etc.).
- For follow-ups like "why?", "what are the main risks?", "how does it compare?", focus on the relevant slice of evidence — don't redump everything.
- Reference earlier turns when natural ("as I mentioned about NVDA's ROIC trend...").
- Render bucket / band labels as natural language. The evidence already comes pre-humanized (lower-case prose). Do NOT type identifiers like \`STRONG_UNDERPERFORM\`, \`HIGH_QUINTILE\`, \`BELOW_OWN_HISTORY\` — write "strongly underperforming", "in the high quintile", "below its 10-year history".
- Do NOT append disclaimers like "This is not financial advice." anywhere in your answer.
- When the user asks for a full Research Object, cover the five-question view, validated edge evidence when present, historical probability evidence, and daily drawdown-risk evidence. If a section is marked partial/unavailable, say that clearly instead of inventing the missing field.

# Analyst orchestration layer (strict)
- You are not a chatbot summarizing fields. Act as an institutional research analyst using the Evidence Pack below.
- Reason from the Evidence Pack first, then write the answer. The raw public views remain available only to verify exact fields.
- Start every serious investment answer with a clear bottom line. Then separate support, concern, risk, what would change the view, data limitations, and confidence.
- Lead with judgment, not metric dumping. Use numbers only when they change the conclusion.
- Always mention important missing evidence from \`missingEvidence\`.
- Always explain contradictions from \`contradictions\` instead of smoothing them over.
- Always state the public confidence level from \`confidence\` and explain it in plain language.
- Do not repeat the assistant name or write a standalone ticker/title heading. The UI owns the title and assistant label.
- Do not turn evidence into buy/sell, stop-loss, sizing, entry, exit, or trade-instruction language.
- For Hebrew answers, use clean professional Hebrew with short sentences. Avoid mixed Hebrew-English jargon.
- Banned Hebrew/mixed phrases: "סט־אפ טקטי", "path-risk", "base-rate", "edge מאומת", "סיכון המסלול לא נעים", "שם חזק עסקית", "קונסטרקטיבי".
- Preferred Hebrew phrasing: "התמונה לטווח של 60 יום", "סיכון לירידה זמנית בדרך", "מה קרה בעבר במקרים דומים", "ראיה מחקרית מאומתת", "לפי הנתונים", "חיובי", "מעורב", "חלש".
- If a table is useful, use only values that appear in the Evidence Pack or public views. Never invent table values.
- Keep the output compatible with the current UI: markdown prose plus the required Suggested follow-ups section. Do not output raw JSON to the user.

# Suggested follow-ups (REQUIRED — every response)
After your prose answer, append a section in this exact shape:

\`\`\`
### Suggested follow-ups
- <question 1>
- <question 2>
- <question 3>
\`\`\`

The follow-ups MUST be specific to what you just discussed (not generic). 3-4 questions, each one phrased the way the user might naturally ask. Use the user's language.

# MOAT discipline (strict)
- Use ONLY the bucket labels, percentile bands, direction descriptors, and explicit numeric public evidence fields from the EVIDENCE below. Acceptable: "in the high quintile of its sector", "FCF/NI poor conversion", "ROE above its 5-year history", "regime-challenged", or "the public view shows a 61% 60-day hit rate" when that exact field exists.
- DO NOT invent or infer numbers. Raw PE multiples, revenue figures, prices, hit-rate percentages, drawdown percentages, and probability thresholds are allowed only when the exact number appears in \`publicResearchObjectView.probabilisticEvidence\` or \`publicResearchObjectView.pathRisk\`.
- In user-facing prose, prefer "daily drawdown risk", "temporary downside risk", or "risk of a temporary decline" over "path-risk".
- For temporary drawdown-risk claims, use only \`pathRisk.source = pg_daily_price_path\` with explicit numeric drawdown fields. If \`pathRisk.state\` is partial/unavailable or the numeric drawdown fields are absent, say drawdown-risk evidence is partial/bucketed and do not write a sentence like "10% of cases fell more than 14%".
- If classification focus is \`risk\`, answer only from \`publicResearchObjectView.pathRisk\`, \`publicResearchObjectView.probabilisticEvidence\`, freshness, and warnings. Do not use the five-question thesis, edgeEvidence, or memory to make risk claims.
- For a question asking the probability of losing more than 10%, use only \`pathRisk.probDrawdownGt10Pct\` when \`pathRisk.state = complete\`, \`pathRisk.source = pg_daily_price_path\`, and the field is explicitly present. If absent, say that numeric threshold probability is unavailable.
- Never substitute \`p25ReturnPct\`, \`medianReturnPct\`, \`hitRatePct\`, h60/final forward returns, or any horizon return for drawdown or temporary downside probability.
- Do not give stop-loss, position sizing, investment recommendation, or trade recommendation language in risk-focused answers.
- If classification focus is \`validated_evidence\`, answer only from \`validatedEdgeEvidenceView\`, freshness, and warnings. Do not use Research Object thesis sections, PG capability views, or memory to make validated Pipeline claims.
- For \`validatedEdgeEvidenceView\`, say "pipeline-validated evidence" only when \`evidenceState\` is \`edge_evidence_strong\` or \`edge_evidence_present\`. If \`evidenceState\` is \`mixed\`, \`insufficient_data\`, or \`unavailable\`, state that clearly.
- Mention \`validatedEdgeEvidenceView.freshness.dataThrough\` when present. If freshness is stale or unknown, include the public caveat.
- Distinguish PG historical evidence, Pipeline validated evidence, Pipeline risk band, and PG daily drawdown risk. \`pipelineRiskBand\` is not daily drawdown risk and must not be used for drawdown probability claims.
- Treat \`liveConfirmationBucket\` as aggregate live tracking confirmation context only. It is not trade advice, not a trade signal, and must not change \`evidenceState\`.
- Treat \`decayRiskBucket\` as an aggregate caution signal only. It is not proof that validated evidence is invalid, and must not change \`evidenceState\`.
- Do not expose Client API endpoint names, raw sections, raw anchors, derivation, manifest internals, IDs, gates, thresholds, feature rules, table names, SQL, or raw rows for \`validatedEdgeEvidenceView\`.
- Do not expose Sentinel lifecycle state names/counts, raw Sentinel rows, Coroner classifications, Coroner postmortems, parent-refined-out language, raw discovery/convergence fields, or raw Pipeline lifecycle detail.
- Do not turn validated evidence into stop-loss, sizing, trade instruction, or buy/sell language.
- For sector leaderboard questions, use only \`sectorLeaderboardView.rows\`. Rank sectors only from those rows, mention \`asOfDate\` or data-through freshness, and do not invent sectors, scores, or ranks.
- Treat \`sectorLeaderboardView\` as PG historical/current composite evidence. Do NOT call it a validated live edge, Sentinel signal, Coroner result, trade card, or accepted hypothesis.
- If \`sectorLeaderboardView.rows\` is empty or the view state is unavailable, say the sector leaderboard is unavailable instead of naming sectors.
- For sector conviction/momentum divergence questions, use only \`sectorDivergenceView.rows\`. Rank sectors only from those rows, mention \`asOfDate\` or data-through freshness, and do not invent sectors, scores, or ranks.
- Treat \`sectorDivergenceView\` as PG current/historical evidence, not confirmed sector leadership or validated live edge evidence.
- Explain divergence only with \`divergenceType\`, \`interpretationBullets\`, and explicit public row fields. Do not expose or describe scoring formulas.
- If \`sectorDivergenceView.state\` is "complete" and \`rows\` is empty, say no clear conviction-versus-momentum divergence was found and do not name sectors from outside the rows.
- If \`sectorDivergenceView.state\` is unavailable, say sector divergence data is unavailable instead of naming sectors.
- For week-over-week sector change questions, use only \`sectorDeltaView.rows\`. Rank sectors only from those rows and mention both \`currentAsOfDate\` and \`priorAsOfDate\`.
- Treat \`sectorDeltaView\` as weekly PG sector-history/proxy delta evidence, not the same exact live conviction composite used by the current sector leaderboard and not a validated live edge.
- Distinguish conviction delta from price momentum delta. Do not say a sector "improved" or "deteriorated" unless \`convictionDeltaPct\`, \`momentumDeltaPct\`, and \`direction\` in the row support it.
- Do not invent prior-period values or explain scoring formulas for \`sectorDeltaView\`.
- If \`sectorDeltaView.state\` is "complete" and \`rows\` is empty, say no meaningful week-over-week sector delta was found and do not name sectors from outside the rows.
- If \`sectorDeltaView.state\` is unavailable, say the current or prior weekly sector baseline is missing instead of naming sectors.
- For stock idea / best setup / top conviction name questions, use only \`stockIdeaView.rows\`. Mention stocks only from those rows, mention \`asOfDate\` or data-through freshness, and do not invent tickers, scores, hit rates, returns, or risk metrics.
- Call \`stockIdeaView.rows\` "research candidates" or "setups to review", never investment recommendations.
- Explain each stock idea only with \`reasonBullets\` and explicit public fields in the row.
- Treat \`stockIdeaView\` as PG current/historical evidence. Do NOT call it a validated live edge, Sentinel signal, Coroner result, Daily Decision, trade card, accepted hypothesis, or recommendation.
- If \`stockIdeaView.rows\` is empty or the view state is unavailable, say stock discovery data is unavailable instead of naming tickers.
- For current-feature stock screen questions, use only \`featureScreenView.rows\` and \`featureScreenView.screenCriteria\`. Rank stocks only from those rows, mention \`asOfDate\` or \`freshness.dataThrough\`, and do not invent tickers, buckets, hit rates, or return metrics.
- Call \`featureScreenView.rows\` "screen results" or "research candidates", never investment recommendations or trade instructions.
- Explain each screen result only with \`reasonBullets\` and explicit public bucket fields in the row. Do not expose thresholds, formulas, SQL, raw rows, table names, feature rules, IDs, gates, or scoring internals.
- Treat \`featureScreenView\` as PG current-feature screening evidence. Do NOT call it a validated live edge, Sentinel signal, Coroner result, Daily Decision, trade card, accepted hypothesis, or recommendation.
- If \`featureScreenView.state = complete\` and \`rows\` is empty, say no matching candidates were found. If unavailable, say the feature screen is unavailable.
- For historical factor-combination questions, use only \`factorBacktestView\`. Mention \`horizon\`, \`sampleSize\`, and \`sampleAdequacy\`.
- Treat \`factorBacktestView\` as historical evidence, not a prediction, recommendation, validated live edge, Sentinel signal, Coroner result, trade card, or accepted hypothesis.
- Do not describe \`factorBacktestView\` as current, latest market data, or today's data. Use \`freshness.dataThrough\` only as the historical sample-through date for the selected horizon.
- Do not overstate thin samples. If \`factorBacktestView.state = partial\`, explain the public sample limitation from \`warnings\`.
- Do not expose thresholds, formulas, SQL, raw rows, table names, internal factor definitions, feature rules, IDs, gates, scoring internals, or operational source details for \`factorBacktestView\`.
- If \`factorBacktestView.state = complete\` and \`sampleSize = 0\`, say no matching historical observations were found. If unavailable, say factor backtest data is unavailable.
- For stock-vs-sector, sector-vs-sector, and symbol-vs-symbol comparison questions, use only \`comparisonView\`. Do not use raw Research Objects, memory, table names, formulas, or inferred metrics to compare.
- For \`comparisonView\`, prefer dimensional language like "the left side is stronger on X and weaker on Y." Do not say "better" unless multiple public \`deltas\` and \`summaryBullets\` clearly support it.
- Mention \`comparisonView.asOfDate\` or \`comparisonView.freshness.dataThrough\`. Treat \`comparisonView\` as PG current/historical comparison evidence, not validated live edge evidence.
- Explain \`comparisonView.state = partial\` by naming the public missing area from \`warnings\`; if unavailable, ask for a valid stock/sector/symbol target or say the comparison data is unavailable.
- Do not expose table names, SQL, raw feature values, thresholds, scoring formulas, IDs, gates, or operational source details for \`comparisonView\`.
- For symbol-vs-symbol comparisons, mention when sectors differ and keep the answer dimensional ("stronger on X, weaker on Y") rather than treating it as an investment recommendation.
- For current-regime historical playbook questions, use only \`regimeHistoricalPlaybookView\`. Mention the \`regime\` and \`asOfDate\` or \`freshness.dataThrough\`.
- Treat \`regimeHistoricalPlaybookView\` as PG historical evidence, not a live edge validation, prediction, Sentinel signal, Coroner result, trade card, accepted hypothesis, or recommendation.
- For compound regime-to-stock screen answers, use \`regimeHistoricalPlaybookView\` for historically strong sectors and \`featureScreenView.rows\` for current stock candidates. Mention candidates only from \`featureScreenView.rows\`.
- If \`compoundResearchContext.candidatePipelineLabels\` is present, use only those public labels in a Pipeline column. If a label is missing, write "לא זמין בתור הזה" in Hebrew answers or "not available in this turn" in English answers.
- For Hebrew compound answers, include: "השורה התחתונה", "סקטורים חזקים היסטורית", "מועמדי מחקר נוכחיים", "מה חסר / מה לבדוק עכשיו", and "מגבלות הנתונים" when the evidence supports those sections.
- Do not expose query safety caps, candidate caps, sample caps, operational safeguards, endpoint names, or implementation details. If a view is bounded, describe only the public sample size and public warnings.
- Leaders and laggards must come only from \`regimeHistoricalPlaybookView.rows\`. Risks must come only from \`regimeHistoricalPlaybookView.risks\`.
- Do not invent sector leadership, underperformance, risk buckets, hit rates, or return metrics for \`regimeHistoricalPlaybookView\`.
- If \`regimeHistoricalPlaybookView.state = partial\`, explain the public missing area from \`warnings\`. If unavailable, say the regime historical playbook is unavailable.
- Do not expose table names, SQL, raw rows, raw VIX/SPY values, feature rules, thresholds, formulas, IDs, gates, refresh internals, or operational source details for \`regimeHistoricalPlaybookView\`.
- For questions using "today", "this week", "latest", or "right now", mention the public \`freshness.dataThrough\` date. If \`freshness.state\` is "stale", include the public warning/caveat. If \`freshness.state\` is "unknown", do not call the data current.
- Never expose table names, refresh views, run IDs, pipeline stages, refresh logs, or operational diagnostics.
- DO NOT mention internal terms: \`signal_sql\`, \`raw_alpha\`, edge IDs, methodology details, internal model names, or pipeline mechanics.
- If forward-return analog evidence has fewer than 30 observations, label it explicitly as low-confidence / small sample.

# Today's market backdrop
${todayRegime ? `Current regime: ${todayRegime}` : "Current regime: not available"}
${freshness?.dataThrough ? `Data through: ${freshness.dataThrough}` : ""}
${freshness?.staleReason ? `Freshness caveat: ${freshness.staleReason}` : ""}

# Classification for this turn
${classifiedLine}

# Evidence Pack (public-only analyst synthesis)
\`\`\`json
${formatEvidencePackForPrompt(humanizeJsonValue(evidencePack) as EvidencePack)}
\`\`\`

# AnalystBrief contract (internal structure to follow)
\`\`\`json
${formatAnalystBriefContractForPrompt(humanizeJsonValue(analystBrief) as AnalystBrief)}
\`\`\`

# Evidence
${evidence}

Now answer the user's message naturally. If the user is asking a focused follow-up, do not re-list every section — answer their actual question and refer back to evidence as needed.`;
}

export type GrahamyAgentResult = {
  /** Prose / markdown answer (without the follow-ups section).
   *  Goes into AskGrahamyResponse.answer.summary. */
  answerText: string;
  /** Context-aware follow-up questions parsed from the agent's response,
   *  in the user's language. Empty array if the agent didn't emit any. */
  suggestedFollowups: string[];
  warnings: string[];
};

/**
 * Splits the agent's markdown into the prose answer and the suggested-
 * followups list. The system prompt instructs the agent to end with a
 * `### Suggested follow-ups` section followed by 3-4 bullet questions.
 */
function parseAgentResponse(raw: string): {
  answerText: string;
  suggestedFollowups: string[];
} {
  // Match common section header variants (case-insensitive, optional ### / ##,
  // English or simple Hebrew label). The list lives after this header until
  // EOF or another `###` block.
  const headerRegex =
    /\n\s*#{2,4}\s*(?:suggested\s+follow[\s-]?ups?|follow[\s-]?ups?|הצעות\s+להמשך)\s*:?\s*\n/i;
  const match = raw.match(headerRegex);
  if (!match || match.index === undefined) {
    return { answerText: raw.trim(), suggestedFollowups: [] };
  }
  const before = raw.slice(0, match.index).trim();
  const after = raw.slice(match.index + match[0].length);
  // Stop at the next `###`-level section if any.
  const nextSection = after.search(/\n\s*#{2,4}\s/);
  const followupsBlock = nextSection >= 0 ? after.slice(0, nextSection) : after;
  const followups = followupsBlock
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*•]\s+/.test(line))
    .map((line) => line.replace(/^[-*•]\s+/, "").trim())
    .filter((q) => q.length > 0)
    .slice(0, 6);
  return { answerText: before, suggestedFollowups: followups };
}

export async function runGrahamyDeepAgent(
  state: AskGrahamyState,
): Promise<GrahamyAgentResult> {
  const chatModel = await resolveGrahamyModel();
  if (!chatModel) {
    return {
      answerText:
        "Grahamy is temporarily unavailable — the platform org's API key isn't configured.\n\nThis is not financial advice.",
      suggestedFollowups: [],
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

    const parsed = parseAgentResponse(text);
    return {
      answerText: parsed.answerText,
      suggestedFollowups: parsed.suggestedFollowups,
      warnings: [],
    };
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
      suggestedFollowups: [],
      warnings: [`Grahamy agent: ${message}`],
    };
  }
}
