import type {
  AnalystWorkflowName,
  WorkflowCandidateRow,
  WorkflowExecutionResult,
  WorkflowPublicViews,
} from "../types/analystTypes";
import type {
  FeatureScreenRowView,
  PublicFreshnessView,
  StockIdeaRowView,
} from "../types";

type BuildWorkflowExecutionResultInput = {
  workflowName: AnalystWorkflowName;
  publicViews: WorkflowPublicViews;
  pipelineLabels?: Record<string, string>;
  warnings?: string[];
  missingEvidence?: string[];
  contradictions?: string[];
};

const PIPELINE_LABELS = new Set([
  "ראיה מאומתת חזקה",
  "ראיה מאומתת קיימת",
  "ראיה מעורבת",
  "אין מספיק ראיה",
  "לא זמין בתור הזה",
]);

export function buildWorkflowExecutionResult(
  input: BuildWorkflowExecutionResultInput,
): WorkflowExecutionResult {
  const pipelineLabels = sanitizePipelineLabels(input.pipelineLabels ?? {});
  const candidateRows = buildCandidateRows(input.publicViews, pipelineLabels);
  const freshness = inferWorkflowFreshness(input.publicViews);
  const missingEvidence = unique([
    ...deriveMissingEvidence(input.workflowName, input.publicViews, candidateRows, pipelineLabels),
    ...(input.missingEvidence ?? []),
  ]);
  const contradictions = unique([
    ...deriveContradictions(candidateRows, pipelineLabels),
    ...(input.contradictions ?? []),
  ]);

  return {
    workflowName: input.workflowName,
    publicViews: input.publicViews,
    ...(candidateRows.length ? { candidateRows } : {}),
    ...(Object.keys(pipelineLabels).length ? { pipelineLabels } : {}),
    missingEvidence,
    contradictions,
    ...(freshness ? { freshness } : {}),
    warnings: unique(input.warnings ?? []),
  };
}

function buildCandidateRows(
  views: WorkflowPublicViews,
  pipelineLabels: Record<string, string>,
): WorkflowCandidateRow[] {
  const featureRows = (views.pgCapabilityViews?.featureScreenView?.rows ?? [])
    .slice(0, 10)
    .map((row) => fromFeatureScreenRow(row, pipelineLabels));
  if (featureRows.length) return featureRows;
  return (views.pgCapabilityViews?.stockIdeaView?.rows ?? [])
    .slice(0, 10)
    .map((row) => fromStockIdeaRow(row, pipelineLabels));
}

function fromFeatureScreenRow(
  row: FeatureScreenRowView,
  pipelineLabels: Record<string, string>,
): WorkflowCandidateRow {
  const symbol = row.symbol.toUpperCase();
  return {
    symbol,
    ...(row.companyName ? { companyName: row.companyName } : {}),
    ...(row.sector ? { sector: row.sector } : {}),
    rank: row.rank,
    ...(row.valuationBucket ? { valuationBucket: row.valuationBucket } : {}),
    ...(row.qualityBucket ? { qualityBucket: row.qualityBucket } : {}),
    ...(row.momentumBucket ? { momentumBucket: row.momentumBucket } : {}),
    ...(row.growthBucket ? { growthBucket: row.growthBucket } : {}),
    ...(row.leverageBucket ? { leverageBucket: row.leverageBucket } : {}),
    ...(row.convictionBucket ? { convictionBucket: row.convictionBucket } : {}),
    ...(row.hitRatePct !== undefined ? { hitRatePct: row.hitRatePct } : {}),
    ...(row.medianReturnPct !== undefined ? { medianReturnPct: row.medianReturnPct } : {}),
    ...(pipelineLabels[symbol] ? { pipelineLabel: pipelineLabels[symbol] } : {}),
    reasonBullets: row.reasonBullets.slice(0, 4),
    sourceView: "featureScreenView",
  };
}

function fromStockIdeaRow(
  row: StockIdeaRowView,
  pipelineLabels: Record<string, string>,
): WorkflowCandidateRow {
  const symbol = row.symbol.toUpperCase();
  return {
    symbol,
    ...(row.companyName ? { companyName: row.companyName } : {}),
    ...(row.sector ? { sector: row.sector } : {}),
    rank: row.rank,
    ...(row.valuationBucket ? { valuationBucket: row.valuationBucket } : {}),
    ...(row.qualityBucket ? { qualityBucket: row.qualityBucket } : {}),
    ...(row.momentumBucket ? { momentumBucket: row.momentumBucket } : {}),
    ...(row.convictionBucket ? { convictionBucket: row.convictionBucket } : {}),
    ...(row.pathRiskBucket ? { pathRiskBucket: row.pathRiskBucket } : {}),
    ...(row.hitRatePct !== undefined ? { hitRatePct: row.hitRatePct } : {}),
    ...(row.medianReturnPct !== undefined ? { medianReturnPct: row.medianReturnPct } : {}),
    ...(pipelineLabels[symbol] ? { pipelineLabel: pipelineLabels[symbol] } : {}),
    reasonBullets: row.reasonBullets.slice(0, 4),
    sourceView: "stockIdeaView",
  };
}

function deriveMissingEvidence(
  workflowName: AnalystWorkflowName,
  views: WorkflowPublicViews,
  candidates: WorkflowCandidateRow[],
  pipelineLabels: Record<string, string>,
): string[] {
  const missing: string[] = [];
  if (workflowName.endsWith("_to_stock_screen") && !candidates.length) {
    missing.push("No current stock candidates matched the bounded screen.");
  }
  if (workflowName === "feature_screen_plus_backtest" && !views.pgCapabilityViews?.factorBacktestView) {
    missing.push("Aggregate historical factor backtest evidence is unavailable.");
  }
  if (
    ["stock_deep_dive_stack", "idea_to_compare_and_risk"].includes(workflowName) &&
    (views.researchObjectViews?.length ?? 0) < 2
  ) {
    missing.push(
      "Relative comparison evidence is unavailable — fewer than two research objects loaded.",
    );
  }
  if (!Object.keys(pipelineLabels).length && workflowName !== "feature_screen_plus_backtest") {
    missing.push("Pipeline validation is unavailable in this turn.");
  }
  return missing;
}

function deriveContradictions(
  candidates: WorkflowCandidateRow[],
  pipelineLabels: Record<string, string>,
): string[] {
  const contradictions: string[] = [];
  const weakHistorical = candidates.find(
    (row) =>
      (row.hitRatePct !== undefined && row.hitRatePct < 50) ||
      (row.medianReturnPct !== undefined && row.medianReturnPct < 0),
  );
  if (weakHistorical) {
    contradictions.push(
      `${weakHistorical.symbol} appears in the current screen, but its public historical forward evidence is weak or negative.`,
    );
  }
  if (Object.values(pipelineLabels).some((label) => label === "ראיה מעורבת")) {
    contradictions.push("At least one candidate has mixed public Pipeline validation.");
  }
  return contradictions;
}

function inferWorkflowFreshness(
  views: WorkflowPublicViews,
): PublicFreshnessView | undefined {
  const pg = views.pgCapabilityViews;
  const ros = views.researchObjectViews ?? [];
  // PG capability views and Research Object asOfDate are the canonical
  // sources for the workflow's data-through date. We do NOT consult the
  // pipeline overlay's freshness or the upstream snapshot freshness here —
  // those describe the lineage of an optional bonus overlay, not the data
  // the workflow's answer is grounded in.
  const candidates: Array<PublicFreshnessView | undefined> = [
    pg?.featureScreenView?.freshness,
    pg?.factorBacktestView?.freshness,
    pg?.stockIdeaView?.freshness,
    pg?.regimeHistoricalPlaybookView?.freshness,
    pg?.sectorDeltaView?.freshness,
    pg?.sectorDivergenceView?.freshness,
    // v4: view.freshness was dropped; we use only the view's canonical
    // PG-aligned `asOfDate` as the freshness signal here.
    ...ros.map((view) => ({
      dataThrough: view.asOfDate,
      state: "unknown" as const,
    })),
  ];
  return candidates.find((item) => item?.dataThrough || item?.state);
}

function sanitizePipelineLabels(labels: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [symbol, label] of Object.entries(labels)) {
    const cleanSymbol = symbol.toUpperCase();
    sanitized[cleanSymbol] = PIPELINE_LABELS.has(label)
      ? label
      : "לא זמין בתור הזה";
  }
  return sanitized;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
