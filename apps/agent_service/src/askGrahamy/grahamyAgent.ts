import { createDeepAgent } from "deepagents";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { ChatOpenAI } from "@langchain/openai";
import { logger } from "../logger";
import { resolveOrgVendorByOrg } from "../utils/resolveOrgVendor.service";
import { getLangfuseCallbackHandler, flushLangfuse } from "../langfuse";
import { stringValue } from "./snapshotClient";
import type {
  EvidencePack,
} from "./analystTypes";
import {
  buildEvidencePack,
  formatEvidencePackSynthesisForPrompt,
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

// Hard cap on a single Grahamy deep-agent invocation. MUST stay BELOW the
// upstream SS axios timeout (`SCHEDASSISTANT_ASK_GRAHAMY_TIMEOUT_MS`,
// default 150s) so when this fires SS still has time to receive the clean
// error response we emit. 60s was too tight for compound workflows or
// cold-cache turns where the deep agent can legitimately reason for
// 60-90 seconds — the user saw a generic "research assistant
// unavailable" error while Langfuse showed the trace was still active.
const GRAHAMY_TIMEOUT_MS = Number(
  process.env.ASK_GRAHAMY_AGENT_TIMEOUT_MS ?? 120_000,
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
  "researchObjectKey",
  "researchObjectKeys",
  "regimeResearchObjectKey",
  "contributingResearchObjectKeys",
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

/**
 * "No validated edge evidence" is the *default* state for stocks — validated
 * pipeline evidence is a bonus overlay, not a required layer. Carrying that
 * warning in the rendered RO trains the model to apologise for a missing
 * thing that was never expected. Strip it unless the user explicitly asked
 * about validated/pipeline evidence (focus = validated_evidence).
 */
function isEdgeAbsenceWarning(warning: string): boolean {
  return /\b(?:no\s+validated\s+edge|validated\s+edge\s+evidence\s+is\s+not\s+yet\s+bridged)\b/i.test(
    warning,
  );
}

function stripEdgeAbsence(
  warnings: string[] | undefined,
  focus?: ClassificationFocus,
): string[] {
  if (!warnings) return [];
  if (focus === "validated_evidence") return warnings;
  return warnings.filter((w) => !isEdgeAbsenceWarning(w));
}

function shapeViewForPrompt(
  view: NonNullable<CachedResearchObject["view"]>,
  focus?: ClassificationFocus,
) {
  // The RO carries two date families that get conflated in prose:
  //   - `asOfDate`              → canonical date for the data ("today")
  //   - `freshness.dataThrough` → pipeline-snapshot lineage date
  // Rename the lineage block so the model can't misread it as the canonical
  // date. The MOAT rule already says "the only valid date is `view.asOfDate`",
  // and now the data shape backs that rule visibly.
  const pipelineSnapshotLineage = view.freshness
    ? {
        dataThrough: view.freshness.dataThrough,
        generatedAt: view.freshness.generatedAt,
        pipelineStatus: view.freshness.pipelineStatus,
        ...(view.freshness.staleReason
          ? { staleReason: view.freshness.staleReason }
          : {}),
        note: "Pipeline-snapshot lineage only — NOT the canonical date for this evidence. Cite `asOfDate`, never this block.",
      }
    : undefined;

  const cleanedWarnings = stripEdgeAbsence(view.warnings, focus);
  const cleanedEdgeEvidence =
    focus === "validated_evidence"
      ? view.edgeEvidence
      : view.edgeEvidence
        ? {
            ...view.edgeEvidence,
            warnings: stripEdgeAbsence(view.edgeEvidence.warnings, focus),
          }
        : view.edgeEvidence;

  if (focus === "risk") {
    return {
      viewSchemaVersion: view.viewSchemaVersion,
      cacheKey: view.cacheKey,
      objectType: view.objectType,
      anchor: view.anchor,
      asOfDate: view.asOfDate,
      title: view.title,
      ...(view.sector ? { sector: view.sector } : {}),
      ...(view.industry ? { industry: view.industry } : {}),
      probabilisticEvidence: view.probabilisticEvidence,
      pathRisk: view.pathRisk,
      ...(pipelineSnapshotLineage ? { pipelineSnapshotLineage } : {}),
      warnings: cleanedWarnings,
    };
  }
  return {
    viewSchemaVersion: view.viewSchemaVersion,
    cacheKey: view.cacheKey,
    objectType: view.objectType,
    anchor: view.anchor,
    asOfDate: view.asOfDate,
    title: view.title,
    ...(view.sector ? { sector: view.sector } : {}),
    ...(view.industry ? { industry: view.industry } : {}),
    fiveQuestion: view.fiveQuestion,
    edgeEvidence: cleanedEdgeEvidence,
    probabilisticEvidence: view.probabilisticEvidence,
    pathRisk: view.pathRisk,
    ...(pipelineSnapshotLineage ? { pipelineSnapshotLineage } : {}),
    warnings: cleanedWarnings,
  };
}

function formatResearchObjectForPrompt(
  ro: CachedResearchObject,
  focus?: ClassificationFocus,
): string {
  const header = `## ${ro.objectType.toUpperCase()} — ${ro.anchor} (as of ${ro.asOfDate})`;
  const publicResearchObjectView = ro.view
    ? shapeViewForPrompt(ro.view, focus)
    : undefined;
  // Humanize all enum-shaped string values before serializing so the agent
  // receives "rich" / "high quintile" / "strongly underperforming" instead of
  // "RICH" / "HIGH_QUINTILE" / "STRONG_UNDERPERFORM".
  const humanized = humanizeJsonValue(publicResearchObjectView);
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
  // Regime is sourced from the regime Research Object (Postgres-backed,
  // loaded for every turn). Pipeline `daily_brief.regime` is supplemental
  // and intentionally not surfaced as the canonical backdrop. We also drop
  // the pipeline `dataThrough` line from the prompt — per-view freshness
  // (PG capability views, Research Object views) is what the model should
  // anchor any "today/latest" wording on, not the pipeline snapshot.
  const regimeRO = ros.find((ro) => ro.objectType === "regime");
  const todayRegime =
    stringValue((regimeRO?.publicSummary as Record<string, unknown> | undefined)?.regime) ??
    stringValue((regimeRO?.view as Record<string, unknown> | undefined)?.title);
  const evidencePack: EvidencePack =
    state.evidencePack ?? buildEvidencePack(state);

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
- Open every serious investment answer with a direct bottom line. Add supporting reasoning afterwards. Lead with the answer the user actually asked for.
- Be confident when the data supports it. Hedge only on the dimensions where the Evidence Pack actually flags partial / unavailable layers — do not manufacture caveats for sections that came back complete.
- Lead with judgment, not metric dumping. Use numbers only when they change the conclusion.
- Mention items from \`missingEvidence\` ONLY when that array is non-empty. If \`missingEvidence\` is empty or only lists unrelated items, omit any "what's missing" section entirely.
- Explain contradictions from \`contradictions\` ONLY when that array is non-empty and the contradiction is material to the user's question. If empty, do not write a "contradictions" / "מה מטריד" / "מה לא להסיק" section at all.
- State the public confidence level from \`confidence\` ONLY when it is anything other than "high" — i.e., explicitly call out medium / low / partial confidence. When confidence is high, do not append a confidence paragraph; the directness of the answer already conveys it.
- Do not append generic disclaimers about "this is a screen, not a full analysis", "not necessarily a stock to invest in automatically", "you should still review each one separately before concluding", or similar self-undermining boilerplate. The MOAT rules already cover the not-a-recommendation framing once.
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

When the anchor is a single stock and the Research Object exposes \`sector\` and/or \`industry\` as first-class fields, AT LEAST ONE follow-up SHOULD be a peer-comparison question grounded in that sector or industry — e.g. "How does <stock> compare to other stocks in <sector>?", "What are the leading stocks in <sector> right now?", or "How does <stock> compare to other stocks in the <industry> industry?". These map to the platform's \`sector_leaders\` / \`industry_leaders\` / \`sector_conviction_leaderboard\` capabilities and lead the user toward natural next steps. Skip this if the stock RO didn't carry a sector/industry value.

# MOAT discipline (strict)
- Use ONLY the bucket labels, percentile bands, direction descriptors, and explicit numeric public evidence fields from the EVIDENCE below. Acceptable: "in the high quintile of its sector", "FCF/NI poor conversion", "ROE above its 5-year history", "regime-challenged", or "the public view shows a 61% 60-day hit rate" when that exact field exists.
- DO NOT invent or infer numbers. Raw PE multiples, revenue figures, prices, hit-rate percentages, drawdown percentages, and probability thresholds are allowed only when the exact number appears in \`publicResearchObjectView.probabilisticEvidence\` or \`publicResearchObjectView.pathRisk\`.
- PEER-RANK GRANULARITY (strict). On a stock RO, \`peerRankPercentile\` is SECTOR-relative — it ranks the stock against its sector peers, NOT its industry peers. Do NOT write "top quintile of <industry>" / "leading in <industry>" / similar industry-rank phrasing from this field. If you cite it, frame it as "top quintile of its sector" only. There is currently no industry-level peer-rank percentile on the stock RO; an industry-relative ranking would have to come from a separate \`industry_leaders\` query.
- INDUSTRY RO IS AGGREGATE, NOT A RANKING. The industry Research Object (\`objectType = "industry"\`) carries industry-aggregate evidence (industry-wide hit rate, industry-level path risk, industry-level fundamentals like \`industryPeToday\`, \`industryAvgChangeTodayPct\`). It does NOT carry a per-stock-vs-industry ranking. When comparing a stock to its industry, frame the comparison QUALITATIVELY — "the stock's quality is STRONG vs the industry's MIXED", "the stock's regime fit is ALIGNED vs the industry's NEUTRAL backdrop" — and DO NOT make quantitative rank claims like "top decile of the industry", "ranked #N in <industry>", or any specific industry percentile. Those numbers do not exist in the structured fields.
- For genuine quantitative industry-peer rankings, suggest the user run an industry-leaders follow-up (e.g. "Top stocks in <industry>?") rather than fabricating a numeric industry rank from the dual-RO evidence. The platform has \`industry_leaders\` as a dedicated capability for that — surface it in your suggested follow-ups when a stock vs industry comparison is being discussed.
- In user-facing prose, prefer "daily drawdown risk", "temporary downside risk", or "risk of a temporary decline" over "path-risk".
- For temporary drawdown-risk claims, use only \`pathRisk.source = pg_daily_price_path\` with explicit numeric drawdown fields. If \`pathRisk.state\` is partial/unavailable or the numeric drawdown fields are absent, say drawdown-risk evidence is partial/bucketed and do not write a sentence like "10% of cases fell more than 14%".
- If classification focus is \`risk\`, answer only from \`publicResearchObjectView.pathRisk\`, \`publicResearchObjectView.probabilisticEvidence\`, freshness, and warnings. Do not use the five-question thesis, edgeEvidence, or memory to make risk claims.
- For a question asking the probability of losing more than 10%, use only \`pathRisk.probDrawdownGt10Pct\` when \`pathRisk.state = complete\`, \`pathRisk.source = pg_daily_price_path\`, and the field is explicitly present. If absent, say that numeric threshold probability is unavailable.
- Never substitute \`p25ReturnPct\`, \`medianReturnPct\`, \`hitRatePct\`, h60/final forward returns, or any horizon return for drawdown or temporary downside probability.
- Do not give stop-loss, position sizing, investment recommendation, or trade recommendation language in risk-focused answers.
- Validated edge evidence (\`edgeEvidence\` on the Research Object, \`validatedEdgeEvidenceView\` on the pipeline overlay) is an OPTIONAL BONUS layer on top of the PG Research Object stack. Its absence is the common case for most stocks and sectors — it is NOT "missing evidence" and must NOT be flagged, apologised for, or framed as a limitation in stock/sector/regime/comparison answers. Do not write sentences like "no validated edge evidence is available", "ראיה מאומתת לא קיימת", "missing validated overlay", or anything analogous when the user did not ask for validated evidence. Treat absence as silence.
- The ONLY time you discuss validated edge evidence at all (present OR absent) is when classification focus is \`validated_evidence\`, OR when \`edgeEvidence.state\` / \`validatedEdgeEvidenceView.evidenceState\` is \`edge_evidence_strong\` / \`edge_evidence_present\` (and you are using it as supporting evidence for the user's actual question). In every other case, do not mention it.
- If classification focus is \`validated_evidence\`, answer only from \`validatedEdgeEvidenceView\`, its own freshness, and warnings. Do not use Research Object thesis sections, PG capability views, or memory to make validated Pipeline claims. In this focus, if \`evidenceState\` is \`mixed\`, \`insufficient_data\`, or \`unavailable\`, state that clearly — because the user asked for it.
- For \`validatedEdgeEvidenceView\`, say "pipeline-validated evidence" only when \`evidenceState\` is \`edge_evidence_strong\` or \`edge_evidence_present\`.
- Mention \`validatedEdgeEvidenceView.freshness.dataThrough\` when present and you are using the overlay. Otherwise do not.
- Distinguish PG historical evidence, Pipeline validated evidence, Pipeline risk band, and PG daily drawdown risk. \`pipelineRiskBand\` is not daily drawdown risk and must not be used for drawdown probability claims.
- Treat \`liveConfirmationBucket\` as aggregate live tracking confirmation context only. It is not trade advice, not a trade signal, and must not change \`evidenceState\`.
- Treat \`decayRiskBucket\` as an aggregate caution signal only. It is not proof that validated evidence is invalid, and must not change \`evidenceState\`.
- Do not expose Client API endpoint names, raw sections, raw anchors, derivation, manifest internals, IDs, gates, thresholds, feature rules, table names, SQL, or raw rows for \`validatedEdgeEvidenceView\`.
- Do not expose Sentinel lifecycle state names/counts, raw Sentinel rows, Coroner classifications, Coroner postmortems, parent-refined-out language, raw discovery/convergence fields, or raw Pipeline lifecycle detail.
- Do not turn validated evidence into stop-loss, sizing, trade instruction, or buy/sell language.
- For any PG capability row that includes \`researchObjectKey\`, use the matching Research Object block for deeper stock/sector/regime context. Do not introduce extra rows or anchors outside the capability view; the Research Object is supporting detail for the listed row.
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
- For "leading / top / best stocks in <sector>" questions (intent \`sector_leaders\`), \`stockIdeaView.rows\` is sector-internally ranked within the user's named sector. Frame the rows as leading research candidates within that sector specifically, and reference the sector by name. Do NOT generalise to other sectors and do NOT introduce tickers from outside the rows. If the rows are empty or the view is unavailable, say leading-stock data for that sector is unavailable.
- For current-feature stock screen questions, use only \`featureScreenView.rows\` and \`featureScreenView.screenCriteria\`. Rank stocks only from those rows; if you cite a date, cite \`featureScreenView.asOfDate\` only. Do not invent tickers, buckets, hit rates, or return metrics.
- Call \`featureScreenView.rows\` "screen results" or "research candidates", never investment recommendations or trade instructions.
- Explain each screen result only with \`reasonBullets\` and explicit public bucket fields in the row. Do not expose thresholds, formulas, SQL, raw rows, table names, feature rules, IDs, gates, or scoring internals.
- Treat \`featureScreenView\` as PG current-feature screening evidence. Do NOT call it a validated live edge, Sentinel signal, Coroner result, Daily Decision, trade card, accepted hypothesis, or recommendation.
- If \`featureScreenView.state = complete\` and \`rows\` is empty, say no matching candidates were found. If unavailable, say the feature screen is unavailable.
- For historical factor-combination questions, use only \`factorBacktestView\`. Mention \`horizon\`, \`sampleSize\`, and \`sampleAdequacy\`.
- \`factorBacktestView.contributingResearchObjectKeys\` names a bounded sample of recent contributing stock Research Objects. Use those Research Objects only as examples of what matched the factor condition, not as proof that the aggregate result applies to every future stock.
- Treat \`factorBacktestView\` as historical evidence, not a prediction, recommendation, validated live edge, Sentinel signal, Coroner result, trade card, or accepted hypothesis.
- Do not describe \`factorBacktestView\` as current, latest market data, or today's data. Use \`freshness.dataThrough\` only as the historical sample-through date for the selected horizon.
- Do not overstate thin samples. If \`factorBacktestView.state = partial\`, explain the public sample limitation from \`warnings\`.
- Do not expose thresholds, formulas, SQL, raw rows, table names, internal factor definitions, feature rules, IDs, gates, scoring internals, or operational source details for \`factorBacktestView\`.
- If \`factorBacktestView.state = complete\` and \`sampleSize = 0\`, say no matching historical observations were found. If unavailable, say factor backtest data is unavailable.
- For comparison-style questions (stock-vs-stock, stock-vs-sector, stock-vs-industry, sector-vs-sector, sector-vs-industry, industry-vs-industry, anchored to the regime, etc.), the evidence is the set of per-anchor Research Objects rendered above — one per stock, sector, industry, and (when relevant) the regime. Read each Research Object and perform the comparison yourself, dimension by dimension, using only fields that exist in those objects: \`fiveQuestion.whatMattersNow\`, \`probabilisticEvidence\`, \`pathRisk\`, \`edgeEvidence\`, freshness, and warnings. When a stock RO is rendered alongside a sibling sector and/or industry RO (the standard loader auto-attaches both for single-stock turns), treat that as the platform telling you "the user may want a peer comparison" — anchor your peer claims to those sibling Research Objects.
- Use dimensional language like "X is stronger on quality but weaker on momentum" rather than declaring an overall winner. Only call one side "better" if multiple dimensions clearly point the same way.
- When the user supplies regime/sector context alongside a stock-vs-stock comparison, frame the comparison through that context — explain how the regime/sector backdrop changes how the per-stock evidence should be read.
- If you cite a date for a Research Object, cite only \`view.asOfDate\` (the date inside the per-RO \`view\` block). If a Research Object is partial or unavailable, name the missing area instead of inventing the comparison.
- If only one Research Object loaded for what looks like a comparison, ask the user to confirm the second anchor and answer from the single Research Object you have.
- Treat the Research Objects as PG current/historical evidence — not validated live edge evidence. Do not expose internal feature names, thresholds, scoring formulas, or table names while comparing.
- For current-regime historical playbook questions, use only \`regimeHistoricalPlaybookView\`. Mention the \`regime\`; if you cite a date, cite only \`regimeHistoricalPlaybookView.asOfDate\`.
- Treat \`regimeHistoricalPlaybookView\` as PG historical evidence, not a live edge validation, prediction, Sentinel signal, Coroner result, trade card, accepted hypothesis, or recommendation.
- For approved compound research answers, use the public views produced in this turn and the \`compoundResearchContext.workflowName\` summary only as an execution guide. Do not expose the workflow name, plan, step ids, source paths, or implementation details.
- For compound sector-to-stock screen answers, use the sector context view for the sector constraint and \`featureScreenView.rows\` for current stock candidates. Mention candidates only from \`featureScreenView.rows\`.
- For \`regime_to_stock_screen\`, sectors must come only from \`regimeHistoricalPlaybookView.rows\` where the public role is leader.
- For \`sector_delta_to_stock_screen\`, sectors must come only from \`sectorDeltaView.rows\` where direction is improved.
- For \`sector_divergence_to_stock_screen\`, sectors must come only from \`sectorDivergenceView.rows\`; if rows are empty, say no clear divergence candidates were found.
- For \`feature_screen_plus_backtest\`, \`factorBacktestView\` is aggregate historical context for the screen criteria, not stock-specific proof.
- For \`stock_deep_dive_stack\`, use the stock Research Object, public risk fields, any sibling sector/regime Research Objects produced for the same turn, and optional \`validatedEdgeEvidenceView\`; do not introduce extra stocks.
- For \`idea_to_compare_and_risk\`, call the top \`stockIdeaView.rows\` item a research candidate, not a top pick or recommendation.
- If \`compoundResearchContext.candidatePipelineLabels\` is present, use only those public labels in a Pipeline column. If a label is missing, write "לא זמין בתור הזה" in Hebrew answers or "not available in this turn" in English answers.
- For Hebrew compound answers, always lead with "השורה התחתונה" and the relevant evidence sections (e.g. "סקטורים חזקים היסטורית", "מועמדי מחקר נוכחיים"). Include "מה חסר / מה לבדוק עכשיו" or "מגבלות הנתונים" ONLY when \`missingEvidence\` / \`contradictions\` / partial-state warnings actually contain material entries. If those arrays are empty, omit those sections entirely — do not invent generic "this is only a screen" / "you should still check each one" hedges.
- Do not expose query safety caps, candidate caps, sample caps, operational safeguards, endpoint names, or implementation details. If a view is bounded, describe only the public sample size and public warnings.
- Leaders and laggards must come only from \`regimeHistoricalPlaybookView.rows\`. Risks must come only from \`regimeHistoricalPlaybookView.risks\`.
- Do not invent sector leadership, underperformance, risk buckets, hit rates, or return metrics for \`regimeHistoricalPlaybookView\`.
- If \`regimeHistoricalPlaybookView.state = partial\`, explain the public missing area from \`warnings\`. If unavailable, say the regime historical playbook is unavailable.
- Do not expose table names, SQL, raw rows, raw VIX/SPY values, feature rules, thresholds, formulas, IDs, gates, refresh internals, or operational source details for \`regimeHistoricalPlaybookView\`.
- DATE DISCIPLINE — strict. Each Research Object / PG capability view in the Evidence section carries TWO date families that must NEVER be conflated:
  1. \`asOfDate\` — the canonical date for the data in that block. THIS is the only date you may cite when the user says "today", "this week", "latest", or "right now".
  2. \`pipelineSnapshotLineage\` (or \`freshness\` on PG capability views) — the pipeline-snapshot lineage block. This describes WHEN the upstream snapshot ran, NOT the date of the data. Treat it as opaque metadata. Do NOT cite \`pipelineSnapshotLineage.dataThrough\`, \`pipelineSnapshotLineage.generatedAt\`, or \`freshness.dataThrough\` to the user. Do NOT use it to override \`asOfDate\` even if the two disagree.
  Also do NOT cite the date inside \`cacheKey\` (it can be a stale cache-stamp). Mention a date only when the user asked about timing.
- Never expose table names, refresh views, run IDs, pipeline stages, refresh logs, or operational diagnostics.
- DO NOT mention internal terms: \`signal_sql\`, \`raw_alpha\`, edge IDs, methodology details, internal model names, or pipeline mechanics.
- If forward-return analog evidence has fewer than 30 observations, label it explicitly as low-confidence / small sample.

# Today's market backdrop
${todayRegime ? `Current regime: ${todayRegime}` : "Current regime: not available"}
(Sourced from the current-regime Research Object in Postgres. The ONLY valid "today" date is \`asOfDate\` on the specific Research Object or PG capability view you are citing — never \`pipelineSnapshotLineage\`/\`freshness.dataThrough\` (lineage of the upstream snapshot, not the data date), and never \`cacheKey\` suffixes (cache-stamps, not data dates).)

# Classification for this turn
${classifiedLine}

# Analyst synthesis (meta-analysis only — NOT a duplicate of the evidence)
This block is the analyst-side meta on top of the raw evidence below: which
evidence layers loaded, the contradictions/missing-evidence/confidence the
orchestrator detected, and the freshness anchor. The actual numbers and
buckets the model must reason from live in the \`# Evidence\` section that
follows. Do NOT treat \`evidenceLayers[*].interpretation\` as a finished
answer — it is an availability marker, not a thesis.
\`\`\`json
${formatEvidencePackSynthesisForPrompt(humanizeJsonValue(evidencePack) as EvidencePack)}
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
