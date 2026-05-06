import type {
  AnalystConfidence,
  EvidenceLayer,
  EvidencePack,
  WorkflowCandidateRow,
  WorkflowExecutionResult,
} from "./analystTypes";

export function buildEvidencePackFromWorkflowExecution(
  result: WorkflowExecutionResult,
): EvidencePack {
  const currentSetup = buildWorkflowCurrentSetup(result);
  const historicalBaseRate = buildWorkflowHistoricalBaseRate(result);
  const pathRisk = buildWorkflowPathRisk(result);
  const relativeComparison = buildWorkflowComparison(result);
  const pipelineEvidence = buildWorkflowPipelineEvidence(result);
  const contradictions = unique([
    ...result.contradictions,
    ...detectWorkflowContradictions(result.candidateRows ?? []),
  ]);
  const missingEvidence = unique(result.missingEvidence);
  const confidence = synthesizeWorkflowConfidence({
    result,
    contradictions,
    missingEvidence,
  });

  return {
    questionType: "compound_research",
    workflowName: result.workflowName,
    anchor: inferWorkflowAnchor(result),
    ...(currentSetup ? { currentSetup } : {}),
    ...(historicalBaseRate ? { historicalBaseRate } : {}),
    ...(pathRisk ? { pathRisk } : {}),
    ...(relativeComparison ? { relativeComparison } : {}),
    ...(pipelineEvidence ? { pipelineEvidence } : {}),
    ...(result.candidateRows?.length
      ? { candidateTable: result.candidateRows.slice(0, 10) }
      : {}),
    ...(result.comparisonRows?.length
      ? { comparisonTable: result.comparisonRows.slice(0, 8) }
      : {}),
    ...(result.freshness ? { freshness: result.freshness } : {}),
    contradictions,
    missingEvidence,
    confidence,
    monitorNext: buildWorkflowMonitorNext(result, missingEvidence, contradictions),
    sourceViews: workflowSourceViews(result),
  };
}

export function evidencePackHasForbiddenInternals(pack: EvidencePack): boolean {
  return /(ResearchPlan|compoundResearchContext|paramsFromPreviousSteps|raw_sql|raw_rows|edge_id|hypothesis_id|gates|thresholds|feature_rules|pipeline_state|grahamy_discovery|sqlite|md_features_daily|md_historical_features_daily|sweep_universe)/i.test(
    JSON.stringify(pack),
  );
}

function buildWorkflowCurrentSetup(
  result: WorkflowExecutionResult,
): EvidenceLayer | undefined {
  const candidates = result.candidateRows ?? [];
  if (candidates.length) {
    return layer({
      state: "complete",
      sourceView: candidates[0].sourceView,
      keyData: [
        `Candidate rows: ${candidates.length}.`,
        ...candidates.slice(0, 5).map((row) =>
          `${row.rank}. ${row.symbol}${row.sector ? ` (${row.sector})` : ""}: ${row.reasonBullets.join(" ") || "public buckets available"}`,
        ),
      ],
      interpretation: "Current candidates come from public bounded screens or stock idea views.",
      strength: candidates.length >= 5 ? "moderate" : "weak",
      warnings: result.warnings,
    });
  }
  const ro = result.publicViews.researchObjectViews?.[0];
  if (ro) {
    return layer({
      state: "complete",
      sourceView: "publicResearchObjectView",
      keyData: ro.fiveQuestion.whatMattersNow.slice(0, 4),
      interpretation: "Public Research Object evidence is available.",
      strength: "moderate",
      warnings: ro.warnings,
    });
  }
  return undefined;
}

function buildWorkflowHistoricalBaseRate(
  result: WorkflowExecutionResult,
): EvidenceLayer | undefined {
  const pg = result.publicViews.pgCapabilityViews;
  const backtest = pg?.factorBacktestView;
  if (backtest) {
    return layer({
      state: backtest.state,
      sourceView: "factorBacktestView",
      keyData: [
        `Horizon: ${backtest.horizon}.`,
        `Sample size: ${backtest.sampleSize ?? "unavailable"}.`,
        ...(backtest.hitRatePct !== undefined ? [`Hit rate: ${backtest.hitRatePct}%.`] : []),
        ...(backtest.medianReturnPct !== undefined ? [`Median return: ${backtest.medianReturnPct}%.`] : []),
        ...(backtest.sampleAdequacy ? [`Sample adequacy: ${backtest.sampleAdequacy}.`] : []),
      ],
      interpretation: "Aggregate historical factor evidence is available for the public criteria.",
      strength: backtest.sampleSize && backtest.sampleSize >= 100 ? "strong" : "moderate",
      warnings: backtest.warnings,
    });
  }
  const regime = pg?.regimeHistoricalPlaybookView;
  if (regime) {
    return layer({
      state: regime.state,
      sourceView: "regimeHistoricalPlaybookView",
      keyData: [
        ...(regime.regime ? [`Regime: ${regime.regime}.`] : []),
        ...regime.rows.slice(0, 5).map((row) =>
          `${row.rank}. ${row.sector}: ${row.role}${row.hitRatePct !== undefined ? `, hit rate ${row.hitRatePct}%` : ""}.`,
        ),
      ],
      interpretation: "Historical sector behavior in the current regime is available.",
      strength: regime.rows.length >= 3 ? "moderate" : "weak",
      warnings: regime.warnings,
    });
  }
  const ro = result.publicViews.researchObjectViews?.[0];
  if (ro?.probabilisticEvidence) {
    return layer({
      state: ro.probabilisticEvidence.state,
      sourceView: "publicResearchObjectView.probabilisticEvidence",
      keyData: [
        `Horizon: ${ro.probabilisticEvidence.horizon}.`,
        ...(ro.probabilisticEvidence.sampleSize !== undefined
          ? [`Sample size: ${ro.probabilisticEvidence.sampleSize}.`]
          : []),
        ...(ro.probabilisticEvidence.hitRatePct !== undefined
          ? [`Hit rate: ${ro.probabilisticEvidence.hitRatePct}%.`]
          : []),
      ],
      interpretation: "Historical analog evidence is available for the anchor.",
      strength: "moderate",
      warnings: ro.probabilisticEvidence.notes,
    });
  }
  return undefined;
}

function buildWorkflowPathRisk(
  result: WorkflowExecutionResult,
): EvidenceLayer | undefined {
  const ro = result.publicViews.researchObjectViews?.[0];
  if (!ro?.pathRisk) return undefined;
  return layer({
    state: ro.pathRisk.state,
    sourceView: "publicResearchObjectView.pathRisk",
    keyData: [
      `Horizon: ${ro.pathRisk.horizon}.`,
      ...(ro.pathRisk.p10MaxDrawdownPct !== undefined
        ? [`p10 max drawdown: ${ro.pathRisk.p10MaxDrawdownPct}%.`]
        : []),
      ...(ro.pathRisk.probDrawdownGt10Pct !== undefined
        ? [`Probability of drawdown greater than 10%: ${ro.pathRisk.probDrawdownGt10Pct}%.`]
        : []),
      ...(ro.pathRisk.maxDrawdownBucket ? [`Risk bucket: ${ro.pathRisk.maxDrawdownBucket}.`] : []),
    ],
    interpretation: "Public drawdown-risk evidence is available.",
    strength: ro.pathRisk.sampleAdequacy === "ROBUST" ? "strong" : "moderate",
    warnings: [...(ro.pathRisk.warnings ?? []), ...(ro.pathRisk.notes ?? [])],
  });
}

function buildWorkflowComparison(
  result: WorkflowExecutionResult,
): EvidenceLayer | undefined {
  const comparison = result.publicViews.pgCapabilityViews?.comparisonView;
  if (!comparison) return undefined;
  return layer({
    state: comparison.state,
    sourceView: "comparisonView",
    keyData: [
      `${comparison.left.label} vs ${comparison.right.label}.`,
      ...comparison.summaryBullets.slice(0, 3),
      ...(result.comparisonRows ?? []).slice(0, 5).map((row) =>
        `${row.metric}: ${row.interpretation}${row.explanation ? `; ${row.explanation}` : ""}`,
      ),
    ],
    interpretation: "Public relative comparison evidence is available.",
    strength: comparison.state === "complete" ? "moderate" : "weak",
    warnings: comparison.warnings,
  });
}

function buildWorkflowPipelineEvidence(
  result: WorkflowExecutionResult,
): EvidenceLayer | undefined {
  const labels = Object.entries(result.pipelineLabels ?? {});
  if (!labels.length) return undefined;
  return layer({
    state: "complete",
    sourceView: "validatedEdgeEvidenceView",
    keyData: labels.slice(0, 5).map(([symbol, label]) => `${symbol}: ${label}.`),
    interpretation: "Pipeline validation is a separate public qualification layer.",
    strength: labels.some(([, label]) => label.includes("חזקה")) ? "strong" : "moderate",
    warnings: result.publicViews.pipelineOverlayViews?.validatedEdgeEvidenceView?.warnings ?? [],
  });
}

function inferWorkflowAnchor(result: WorkflowExecutionResult): EvidencePack["anchor"] {
  const ro = result.publicViews.researchObjectViews?.[0];
  if (ro) return { type: ro.objectType, label: ro.title ?? ro.anchor, symbol: ro.objectType === "stock" ? ro.anchor : undefined, sector: ro.objectType === "sector" ? ro.anchor : undefined };
  const comparison = result.publicViews.pgCapabilityViews?.comparisonView;
  if (comparison) {
    return {
      type: "comparison",
      label: `${comparison.left.label} vs ${comparison.right.label}`,
    };
  }
  if (result.candidateRows?.length) return { type: "screen", label: "Current candidate screen" };
  return { type: "unknown" };
}

function synthesizeWorkflowConfidence(input: {
  result: WorkflowExecutionResult;
  contradictions: string[];
  missingEvidence: string[];
}): AnalystConfidence {
  const candidateCount = input.result.candidateRows?.length ?? 0;
  const hasHistorical =
    Boolean(input.result.publicViews.pgCapabilityViews?.factorBacktestView) ||
    Boolean(input.result.publicViews.pgCapabilityViews?.regimeHistoricalPlaybookView);
  const hasComparison = Boolean(input.result.publicViews.pgCapabilityViews?.comparisonView);
  const hasPipeline = Boolean(Object.keys(input.result.pipelineLabels ?? {}).length);
  const hasStaleWarning = input.result.freshness?.state === "stale";

  if (!candidateCount && !hasHistorical && !hasComparison) {
    return { level: "unavailable", explanation: "The required public evidence layers were unavailable." };
  }
  if (input.contradictions.length >= 2 || hasStaleWarning) {
    return { level: "low", explanation: "Evidence is available, but contradictions or freshness limits reduce confidence." };
  }
  if ((candidateCount >= 3 || hasComparison) && hasHistorical && hasPipeline && input.missingEvidence.length === 0) {
    return { level: "high", explanation: "Multiple public evidence layers are available and broadly consistent." };
  }
  return { level: "moderate", explanation: "The public evidence supports a research view, with some missing or optional layers." };
}

function buildWorkflowMonitorNext(
  result: WorkflowExecutionResult,
  missingEvidence: string[],
  contradictions: string[],
): string[] {
  return unique([
    ...(result.candidateRows?.[0]?.symbol ? [`Check risk and sector comparison for ${result.candidateRows[0].symbol}.`] : []),
    ...(missingEvidence.length ? ["Fill the missing evidence layers before relying on the screen."] : []),
    ...(contradictions.length ? ["Monitor whether the contradictory evidence resolves or worsens."] : []),
    ...(result.freshness?.dataThrough ? [`Watch for data updates after ${result.freshness.dataThrough}.`] : []),
  ]).slice(0, 4);
}

function detectWorkflowContradictions(rows: WorkflowCandidateRow[]): string[] {
  const row = rows.find(
    (item) =>
      (item.hitRatePct !== undefined && item.hitRatePct < 50) ||
      (item.medianReturnPct !== undefined && item.medianReturnPct < 0),
  );
  return row
    ? [`${row.symbol} is a current candidate, but its public historical forward profile is weak or negative.`]
    : [];
}

function workflowSourceViews(result: WorkflowExecutionResult): string[] {
  return unique([
    ...(result.publicViews.researchObjectViews?.length ? ["publicResearchObjectView"] : []),
    ...Object.keys(result.publicViews.pgCapabilityViews ?? {}),
    ...Object.keys(result.publicViews.pipelineOverlayViews ?? {}),
  ]);
}

function layer(input: EvidenceLayer): EvidenceLayer {
  return input;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
