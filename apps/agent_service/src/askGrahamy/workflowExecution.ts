import type {
  AnalystWorkflowName,
  WorkflowCandidateRow,
  WorkflowComparisonRow,
  WorkflowExecutedStep,
  WorkflowExecutionResult,
  WorkflowPublicViews,
} from "./analystTypes";
import type {
  EvidenceState,
  FeatureScreenRowView,
  PgCapabilityViews,
  PipelineOverlayViews,
  PublicFreshnessView,
  PublicResearchObjectView,
  StockIdeaRowView,
} from "./types";

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

const WORKFLOW_STEPS: Record<AnalystWorkflowName, string[]> = {
  regime_to_stock_screen: [
    "market_regime_historical_playbook",
    "feature_screen",
    "validated_edge_evidence",
  ],
  sector_delta_to_stock_screen: [
    "week_over_week_sector_delta",
    "feature_screen",
    "validated_edge_evidence",
  ],
  sector_divergence_to_stock_screen: [
    "sector_momentum_vs_conviction_divergence",
    "feature_screen",
    "validated_edge_evidence",
  ],
  feature_screen_plus_backtest: [
    "feature_screen",
    "factor_conditioned_backtest",
  ],
  stock_deep_dive_stack: [
    "stock_research_object",
    "risk_path",
    "validated_edge_evidence",
  ],
  idea_to_compare_and_risk: [
    "stock_idea_discovery",
    "risk_path",
    "validated_edge_evidence",
  ],
};

export function buildWorkflowExecutionResult(
  input: BuildWorkflowExecutionResultInput,
): WorkflowExecutionResult {
  const pipelineLabels = sanitizePipelineLabels(input.pipelineLabels ?? {});
  const candidateRows = buildCandidateRows(input.publicViews, pipelineLabels);
  const comparisonRows = buildComparisonRows(input.publicViews.pgCapabilityViews);
  const freshness = inferWorkflowFreshness(input.publicViews);
  const missingEvidence = unique([
    ...deriveMissingEvidence(input.workflowName, input.publicViews, candidateRows, pipelineLabels),
    ...(input.missingEvidence ?? []),
  ]);
  const contradictions = unique([
    ...deriveContradictions(candidateRows, comparisonRows, pipelineLabels),
    ...(input.contradictions ?? []),
  ]);

  return {
    workflowName: input.workflowName,
    executedSteps: buildExecutedSteps(input.workflowName, input.publicViews),
    publicViews: input.publicViews,
    ...(candidateRows.length ? { candidateRows } : {}),
    ...(comparisonRows.length ? { comparisonRows } : {}),
    ...(Object.keys(pipelineLabels).length ? { pipelineLabels } : {}),
    missingEvidence,
    contradictions,
    ...(freshness ? { freshness } : {}),
    warnings: unique(input.warnings ?? []),
  };
}

export function workflowResultHasForbiddenInternals(
  result: WorkflowExecutionResult,
): boolean {
  return forbiddenPattern().test(JSON.stringify(result));
}

function buildExecutedSteps(
  workflowName: AnalystWorkflowName,
  views: WorkflowPublicViews,
): WorkflowExecutedStep[] {
  return WORKFLOW_STEPS[workflowName].map((capability) => ({
    id: capability,
    capability,
    state: capabilityState(capability, views),
    warnings: capabilityWarnings(capability, views),
  }));
}

function capabilityState(
  capability: string,
  views: WorkflowPublicViews,
): EvidenceState | "skipped" {
  const pg = views.pgCapabilityViews;
  const pipeline = views.pipelineOverlayViews;
  const ros = views.researchObjectViews ?? [];
  switch (capability) {
    case "market_regime_historical_playbook":
      return pg?.regimeHistoricalPlaybookView?.state ?? "unavailable";
    case "week_over_week_sector_delta":
      return pg?.sectorDeltaView?.state ?? "unavailable";
    case "sector_momentum_vs_conviction_divergence":
      return pg?.sectorDivergenceView?.state ?? "unavailable";
    case "feature_screen":
      return pg?.featureScreenView?.state ?? "unavailable";
    case "factor_conditioned_backtest":
      return pg?.factorBacktestView?.state ?? "unavailable";
    case "stock_idea_discovery":
      return pg?.stockIdeaView?.state ?? "unavailable";
    case "validated_edge_evidence":
      return pipeline?.validatedEdgeEvidenceView?.state ?? "skipped";
    case "stock_research_object":
    case "risk_path":
      return ros.length ? "complete" : "unavailable";
    default:
      return "skipped";
  }
}

function capabilityWarnings(capability: string, views: WorkflowPublicViews): string[] {
  const pg = views.pgCapabilityViews;
  const pipeline = views.pipelineOverlayViews;
  switch (capability) {
    case "market_regime_historical_playbook":
      return pg?.regimeHistoricalPlaybookView?.warnings ?? [];
    case "week_over_week_sector_delta":
      return pg?.sectorDeltaView?.warnings ?? [];
    case "sector_momentum_vs_conviction_divergence":
      return pg?.sectorDivergenceView?.warnings ?? [];
    case "feature_screen":
      return pg?.featureScreenView?.warnings ?? [];
    case "factor_conditioned_backtest":
      return pg?.factorBacktestView?.warnings ?? [];
    case "stock_idea_discovery":
      return pg?.stockIdeaView?.warnings ?? [];
    case "validated_edge_evidence":
      return pipeline?.validatedEdgeEvidenceView?.warnings ?? [];
    case "stock_research_object":
    case "risk_path":
      return (views.researchObjectViews ?? []).flatMap((view) => view.warnings);
    default:
      return [];
  }
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

/**
 * After the v6 refactor, comparison-style turns no longer fire a dedicated
 * SQL view; the agent derives deltas itself from the per-anchor research
 * objects. We keep the function for shape compatibility but it always
 * returns no rows.
 */
function buildComparisonRows(
  _pgViews: PgCapabilityViews | undefined,
): WorkflowComparisonRow[] {
  return [];
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
  comparisonRows: WorkflowComparisonRow[],
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
  if (comparisonRows.some((row) => row.interpretation === "mixed")) {
    contradictions.push("The public comparison evidence is mixed across dimensions.");
  }
  return contradictions;
}

function inferWorkflowFreshness(
  views: WorkflowPublicViews,
): PublicFreshnessView | undefined {
  const pg = views.pgCapabilityViews;
  const pipeline = views.pipelineOverlayViews;
  const ros = views.researchObjectViews ?? [];
  const candidates: Array<PublicFreshnessView | undefined> = [
    pg?.featureScreenView?.freshness,
    pg?.factorBacktestView?.freshness,
    pg?.stockIdeaView?.freshness,
    pg?.regimeHistoricalPlaybookView?.freshness,
    pg?.sectorDeltaView?.freshness,
    pg?.sectorDivergenceView?.freshness,
    pipeline?.validatedEdgeEvidenceView?.freshness,
    ...ros.map((view) => ({
      dataThrough: view.freshness.dataThrough ?? view.asOfDate,
      state: "unknown" as const,
      warning: view.freshness.staleReason,
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

function forbiddenPattern(): RegExp {
  return /(ResearchPlan|compoundResearchContext|paramsFromPreviousSteps|raw_sql|raw_rows|edge_id|hypothesis_id|gates|thresholds|feature_rules|pipeline_state|md_features_daily|md_historical_features_daily|sweep_universe|grahamy_discovery|sqlite)/i;
}
