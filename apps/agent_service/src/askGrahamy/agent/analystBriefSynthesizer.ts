import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { logger } from "../../logger";
import { runAnthropicOneShot } from "../../chat/anthropic/anthropicOneShot";
import { resolveOrgVendorByOrg } from "../../utils/resolveOrgVendor.service";
import {
  formatEvidencePackForPrompt,
} from "./analystOrchestration";
import type {
  AnalystBrief,
  AnalystBriefSection,
  AnalystBriefTable,
  EvidencePack,
  WorkflowCandidateRow,
} from "../types/analystTypes";

export type AnalystBriefSynthesisInput = {
  message: string;
  evidencePack: EvidencePack;
};

export type AnalystBriefSynthesisResult = {
  brief: AnalystBrief;
  warnings: string[];
  usedFallback: boolean;
};

export type AnalystBriefModelRunner = (input: {
  systemPrompt: string;
  userPrompt: string;
  jsonSchema: unknown;
}) => Promise<string>;

const ASK_GRAHAMY_ORG_ID =
  process.env.ASK_GRAHAMY_ORG_ID ?? "acf0cbab-3aed-42cf-872d-63cba24e61c3";

const BRIEF_MODEL =
  process.env.ASK_GRAHAMY_ANALYST_BRIEF_MODEL ?? "claude-sonnet-4-6";

const BRIEF_TIMEOUT_MS = Number(
  process.env.ASK_GRAHAMY_ANALYST_BRIEF_TIMEOUT_MS ?? 8_000,
);

const analystBriefSchema = z.object({
  bottomLine: z.string().trim().min(1).max(1200),
  sections: z.array(z.object({
    id: z.enum([
      "what_was_checked",
      "why_it_matters",
      "supports",
      "concerns",
      "risk",
      "what_changes_view",
      "data_limitations",
      "confidence",
    ]),
    heading: z.string().trim().min(1).max(120),
    body: z.string().trim().max(1500).optional(),
    bullets: z.array(z.string().trim().min(1).max(500)).max(8).optional(),
  })).min(2).max(8),
  tables: z.array(z.object({
    type: z.enum(["evidence", "risk", "candidate", "comparison", "backtest", "pipeline_evidence"]),
    columns: z.array(z.string().trim().min(1).max(80)).min(2).max(8),
    rows: z.array(z.array(z.string().trim().max(300)).min(2).max(8)).max(12),
  })).max(4),
  caveats: z.array(z.string().trim().min(1).max(500)).max(6),
  confidence: z.object({
    level: z.enum(["high", "moderate", "low", "unavailable"]),
    explanation: z.string().trim().min(1).max(500),
  }),
  sources: z.array(z.object({
    label: z.string().trim().min(1).max(120),
    type: z.enum([
      "research_object",
      "pg_historical",
      "pg_current",
      "pipeline_validation",
      "market_context",
    ]),
  })).max(8),
  followUps: z.array(z.string().trim().min(1).max(180)).max(5),
});

const ANALYST_BRIEF_JSON_SCHEMA = zodToJsonSchema(analystBriefSchema as never, {
  target: "openAi",
  $refStrategy: "none",
});

const SYSTEM_PROMPT = `You are Ask Grahamy's institutional analyst brief synthesizer.
You receive a compact public EvidencePack only. Write a professional AnalystBrief from that EvidencePack.

Rules:
- Use only the EvidencePack. Do not invent stocks, sectors, metrics, Pipeline status, or sources.
- Lead with a clear bottom line.
- Explain what was checked, what supports it, concerns, risk, limitations, and confidence.
- Include a candidate/comparison/backtest table when the EvidencePack has table rows.
- Separate PG historical evidence from Pipeline validation.
- Pipeline risk bands are not drawdown probabilities.
- If evidence is missing, say what is missing.
- Mention dataThrough/asOfDate when freshness is present.
- No buy/sell, sizing, stop-loss, entry, or exit language.
- Never mention raw SQL, raw rows, table names, edge IDs, hypothesis IDs, gates, thresholds, feature rules, Sentinel rows, Coroner details, ResearchPlan, or compoundResearchContext.

Hebrew style:
- If the user asks in Hebrew, answer in clean professional Hebrew.
- Avoid awkward mixed jargon.
- Do not use: סט־אפ טקטי, path-risk, base-rate, edge מאומת, קונסטרוקטיבי.
- Prefer: מה קרה בעבר במקרים דומים, סיכון לירידה זמנית, ראיה מחקרית מאומתת, לפי הנתונים.
`;

export function buildAnalystBriefSynthesisPrompts(
  input: AnalystBriefSynthesisInput,
): { systemPrompt: string; userPrompt: string; jsonSchema: unknown } {
  return {
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: JSON.stringify(
      {
        question: input.message,
        evidencePack: JSON.parse(formatEvidencePackForPrompt(input.evidencePack)),
      },
      null,
      2,
    ),
    jsonSchema: ANALYST_BRIEF_JSON_SCHEMA,
  };
}

export async function synthesizeAnalystBriefFromEvidencePack(
  input: AnalystBriefSynthesisInput,
  runner?: AnalystBriefModelRunner,
): Promise<AnalystBriefSynthesisResult> {
  const prompts = buildAnalystBriefSynthesisPrompts(input);
  try {
    const text = await withTimeout(
      runner ? runner(prompts) : runDefaultAnalystBriefModel(prompts),
      BRIEF_TIMEOUT_MS,
    );
    const brief = parseAnalystBrief(text);
    return { brief, warnings: [], usedFallback: false };
  } catch (err) {
    logger.warn("Ask Grahamy AnalystBrief synthesis failed; using contract fallback", {
      error: err instanceof Error ? err.message : String(err),
      workflowName: input.evidencePack.workflowName,
    });
    return {
      brief: buildFallbackAnalystBrief(input.message, input.evidencePack),
      warnings: ["Analyst brief synthesis was unavailable; returned a structured evidence brief."],
      usedFallback: true,
    };
  }
}

export function analystBriefPromptHasForbiddenInternals(
  prompts: { systemPrompt: string; userPrompt: string },
): boolean {
  return forbiddenPattern().test(prompts.userPrompt);
}

function parseAnalystBrief(text: string): AnalystBrief {
  return analystBriefSchema.parse(JSON.parse(stripCodeFences(text))) as AnalystBrief;
}

async function runDefaultAnalystBriefModel(input: {
  systemPrompt: string;
  userPrompt: string;
  jsonSchema: unknown;
}): Promise<string> {
  const vendor = await resolveOrgVendorByOrg(BRIEF_MODEL, ASK_GRAHAMY_ORG_ID);
  if (!vendor || !vendor.apiKey) {
    throw new Error("Ask Grahamy AnalystBrief model is unavailable.");
  }
  if (vendor.vendorSlug !== "anthropic") {
    throw new Error(`Ask Grahamy AnalystBrief does not support vendor ${vendor.vendorSlug}.`);
  }
  return runAnthropicOneShot({
    credential: vendor.apiKey,
    keyType: vendor.keyType,
    model: BRIEF_MODEL,
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    jsonSchemaHint: input.jsonSchema,
  });
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`AnalystBrief synthesis timed out after ${Math.round(ms / 1000)} seconds`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function forbiddenPattern(): RegExp {
  return /(ResearchPlan|compoundResearchContext|paramsFromPreviousSteps|raw_sql|raw_rows|edge_id|hypothesis_id|gates|thresholds|feature_rules|pipeline_state|grahamy_discovery|sqlite|md_features_daily|md_historical_features_daily|sweep_universe)/i;
}

function buildFallbackAnalystBrief(message: string, pack: EvidencePack): AnalystBrief {
  const hebrew = /[\u0590-\u05ff]/.test(message);
  const candidates = pack.candidateTable ?? [];
  const tables: AnalystBriefTable[] = [];
  if (candidates.length) {
    tables.push({
      type: "candidate",
      columns: hebrew
        ? ["מניה", "סקטור", "למה עלתה", "ראיה היסטורית", "Pipeline"]
        : ["Symbol", "Sector", "Why it appeared", "Historical evidence", "Pipeline"],
      rows: candidates.slice(0, 10).map((row) => candidateTableRow(row, hebrew)),
    });
  }

  const sections: AnalystBriefSection[] = [
    {
      id: "what_was_checked",
      heading: hebrew ? "מה נבדק" : "What was checked",
      bullets: checkedBullets(pack, hebrew),
    },
    {
      id: "supports",
      heading: hebrew ? "מה תומך בזה" : "What supports it",
      bullets: supportBullets(pack, hebrew),
    },
    {
      id: "concerns",
      heading: hebrew ? "מה מטריד" : "What argues against it",
      bullets: pack.contradictions.length
        ? pack.contradictions.slice(0, 4)
        : [hebrew ? "לא זוהתה סתירה מרכזית בשכבות הציבוריות שנבדקו." : "No major contradiction was visible in the checked public layers."],
    },
    {
      id: "data_limitations",
      heading: hebrew ? "מגבלות הנתונים" : "Data / limitations",
      bullets: [
        ...(pack.freshness?.dataThrough
          ? [hebrew ? `הנתונים זמינים עד ${pack.freshness.dataThrough}.` : `Data is available through ${pack.freshness.dataThrough}.`]
          : []),
        ...pack.missingEvidence.slice(0, 4),
      ],
    },
  ];

  return {
    bottomLine: fallbackBottomLine(pack, hebrew),
    sections,
    tables,
    caveats: [
      ...(pack.freshness?.warning ? [pack.freshness.warning] : []),
      ...pack.missingEvidence.slice(0, 4),
    ],
    confidence: pack.confidence,
    sources: pack.sourceViews.slice(0, 8).map((source) => ({
      label: source,
      type: source.includes("Pipeline") || source.includes("validated")
        ? "pipeline_validation"
        : source.includes("ResearchObject")
          ? "research_object"
          : source.includes("Historical") || source.includes("factorBacktest") || source.includes("regimeHistorical")
            ? "pg_historical"
            : "pg_current",
    })),
    followUps: pack.monitorNext.slice(0, 5),
  };
}

function fallbackBottomLine(pack: EvidencePack, hebrew: boolean): string {
  const candidateCount = pack.candidateTable?.length ?? 0;
  if (candidateCount) {
    return hebrew
      ? `לפי שכבות הראיה הציבוריות, נמצאו ${candidateCount} מועמדי מחקר נוכחיים; יש לבחון את הראיה ההיסטורית, הסיכון והחוסרים לפני הסתמכות.`
      : `The public evidence stack produced ${candidateCount} current research candidates; historical evidence, risk, and missing layers still need review.`;
  }
  return hebrew
    ? "הראיה הציבורית הזמינה חלקית, ולכן המסקנה צריכה להישאר זהירה."
    : "Available public evidence is partial, so the conclusion should remain cautious.";
}

function supportBullets(pack: EvidencePack, hebrew: boolean): string[] {
  if (hebrew) {
    const bullets = [
      ...(pack.candidateTable ?? []).slice(0, 3).map((row) => {
        const evidence = [
          row.hitRatePct !== undefined ? `שיעור הצלחה ${row.hitRatePct}%` : "",
          row.medianReturnPct !== undefined ? `תשואה חציונית ${row.medianReturnPct}%` : "",
          row.pipelineLabel ? `Pipeline: ${row.pipelineLabel}` : "",
        ].filter(Boolean).join(" / ");
        return `${row.symbol}${row.sector ? ` (${row.sector})` : ""}: ${evidence || "עבר את המסך הציבורי"}.`;
      }),
      ...(pack.historicalBaseRate ? ["קיימת שכבת ראיה היסטורית ציבורית לשאלה הזו."] : []),
      ...(pack.relativeComparison ? ["קיימת שכבת השוואה ציבורית מול הסקטור או הנכס הרלוונטי."] : []),
    ];
    return bullets.length ? bullets.slice(0, 5) : ["שכבת הראיה הנוכחית זמינה, אך חסרות שכבות תומכות נוספות."];
  }
  const bullets = [
    ...(pack.historicalBaseRate?.keyData.slice(0, 3) ?? []),
    ...(pack.pipelineEvidence?.keyData.slice(0, 3) ?? []),
    ...(pack.relativeComparison?.keyData.slice(0, 2) ?? []),
  ];
  if (bullets.length) return bullets.slice(0, 5);
  return [
    hebrew
      ? "שכבת הראיה הנוכחית זמינה, אך חסרות שכבות תומכות נוספות."
      : "The current evidence layer is available, but additional supporting layers are missing.",
  ];
}

function checkedBullets(pack: EvidencePack, hebrew: boolean): string[] {
  if (!hebrew) {
    return [
      ...(pack.currentSetup?.keyData.slice(0, 3) ?? []),
      ...(pack.historicalBaseRate?.keyData.slice(0, 3) ?? []),
      ...(pack.relativeComparison?.keyData.slice(0, 2) ?? []),
    ].slice(0, 6);
  }
  return [
    pack.candidateTable?.length
      ? `נבדקו ${pack.candidateTable.length} מועמדי מחקר מתוך שכבות ציבוריות.`
      : undefined,
    pack.historicalBaseRate ? "נבדקה שכבת ראיה היסטורית ציבורית." : undefined,
    pack.relativeComparison ? "נבדקה השוואה ציבורית רלוונטית." : undefined,
    pack.pathRisk ? "נבדקה שכבת סיכון לירידה זמנית." : undefined,
    pack.pipelineEvidence ? "נבדקה שכבת ראיה מחקרית מאומתת מה-Pipeline כאשר הייתה זמינה." : undefined,
  ].filter((item): item is string => Boolean(item));
}

function candidateTableRow(row: WorkflowCandidateRow, hebrew: boolean): string[] {
  const why = [
    row.valuationBucket ? `${hebrew ? "תמחור" : "valuation"} ${row.valuationBucket}` : "",
    row.qualityBucket ? `${hebrew ? "איכות" : "quality"} ${row.qualityBucket}` : "",
    row.momentumBucket ? `${hebrew ? "מומנטום" : "momentum"} ${row.momentumBucket}` : "",
    row.reasonBullets[0] ?? "",
  ].filter(Boolean).slice(0, 3).join("; ");
  const historical = [
    row.hitRatePct !== undefined ? `${hebrew ? "שיעור הצלחה" : "hit rate"} ${row.hitRatePct}%` : "",
    row.medianReturnPct !== undefined ? `${hebrew ? "תשואה חציונית" : "median return"} ${row.medianReturnPct}%` : "",
  ].filter(Boolean).join(" / ");
  return [
    row.symbol,
    row.sector ?? "",
    why || (hebrew ? "עבר את המסך הציבורי" : "Passed the public screen"),
    historical || (hebrew ? "לא זמין" : "Unavailable"),
    row.pipelineLabel ?? (hebrew ? "לא זמין בתור הזה" : "Unavailable in this turn"),
  ];
}
