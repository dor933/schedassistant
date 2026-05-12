import type {
  AskGrahamyState,
  Classification,
  FactorBacktestView,
  FeatureScreenView,
  PathRiskView,
  PgCapabilityViews,
  PipelineOverlayViews,
  ProbabilisticEvidenceView,
  PublicFreshnessView,
  PublicResearchObjectView,
  PublicResearchView,
  RegimeHistoricalPlaybookView,
  SectorDeltaView,
  SectorDivergenceView,
  SectorLeaderboardView,
  StockIdeaView,
  ValidatedEdgeEvidenceView,
} from "../types";
import type {
  AnalystAnchor,
  AnalystBrief,
  AnalystBriefSource,
  AnalystBriefTable,
  AnalystConfidence,
  AnalystQuestionType,
  EvidenceLayer,
  EvidenceLayerStrength,
  EvidencePack,
} from "../types/analystTypes";

type EvidencePackInput = Pick<
  AskGrahamyState,
  | "message"
  | "classification"
  | "snapshots"
  | "researchObjects"
  | "publicResearchView"
  | "pgCapabilityViews"
  | "pipelineOverlayViews"
  | "warnings"
>;

const STRONG_BUCKETS = new Set([
  "STRONG",
  "HIGH",
  "ROBUST",
  "ATTRACTIVE",
  "CONSTRUCTIVE",
  "POSITIVE",
  "CONFIRMED",
  "edge_evidence_strong",
  "edge_evidence_present",
  "confirmed",
]);

const WEAK_BUCKETS = new Set([
  "WEAK",
  "LOW",
  "THIN",
  "RICH",
  "STRESSED",
  "NEGATIVE",
  "MIXED",
  "mixed",
  "insufficient_data",
  "unavailable",
  "not_confirmed",
  "deteriorating",
  "watch",
  "decay_elevated",
]);

export function mapQuestionType(classification?: Classification): AnalystQuestionType {
  if (!classification) return "unknown";
  if (classification.focus === "risk") return "risk";
  if (classification.focus === "validated_evidence") {
    return "validated_pipeline_evidence";
  }
  if (isComparisonClassification(classification)) return "comparison";
  switch (classification.intent) {
    case "stock":
    case "stock_sector":
    case "stock_regime":
    case "stock_sector_regime":
      return "stock_opinion";
    case "sector":
    case "sector_regime":
      return "sector_analysis";
    case "regime":
      return "regime_analysis";
    case "sector_conviction_leaderboard":
      return "leaderboard";
    case "stock_idea_discovery":
    case "sector_leaders":
      return "idea_discovery";
    case "feature_screen":
      return "feature_screen";
    case "factor_conditioned_backtest":
      return "factor_backtest";
    case "market_regime_historical_playbook":
      return "regime_playbook";
    default:
      return "unknown";
  }
}

/**
 * Comparison-style turns no longer have a dedicated intent — they're
 * recognised structurally: ≥2 stocks, ≥2 sectors, or a stock/sector mix.
 * The downstream agent reads the per-anchor research objects and produces
 * the side-by-side analysis itself.
 */
function isComparisonClassification(classification: Classification): boolean {
  const symbolCount = classification.symbols.length;
  const sectorCount = classification.sectors.length;
  const industryCount = classification.industries.length;
  if (symbolCount >= 2) return true;
  if (sectorCount >= 2) return true;
  if (industryCount >= 2) return true;
  if (symbolCount >= 1 && sectorCount >= 1) return true;
  if (symbolCount >= 1 && industryCount >= 1) return true;
  if (sectorCount >= 1 && industryCount >= 1) return true;
  return false;
}

export function buildEvidencePack(input: EvidencePackInput): EvidencePack {
  const classification = input.classification;
  const questionType = mapQuestionType(classification);
  const publicResearchObjectViews =
    input.publicResearchView?.researchObjectViews ??
    (input.researchObjects ?? [])
      .map((item) => item.view)
      .filter((item): item is PublicResearchObjectView => Boolean(item));
  const pgViews = input.publicResearchView
    ? pgViewsFromPublicResearchView(input.publicResearchView)
    : input.pgCapabilityViews;
  const pipelineViews = input.publicResearchView
    ? pipelineViewsFromPublicResearchView(input.publicResearchView)
    : input.pipelineOverlayViews;
  const anchor = inferAnchor(classification, publicResearchObjectViews, pgViews, pipelineViews);
  const currentSetup = buildCurrentSetupLayer(
    questionType,
    publicResearchObjectViews,
    pgViews,
  );
  const historicalBaseRate = buildHistoricalBaseRateLayer(
    questionType,
    publicResearchObjectViews,
    pgViews,
  );
  const pathRisk = buildPathRiskLayer(questionType, publicResearchObjectViews);
  const relativeComparison = buildComparisonLayer(questionType, publicResearchObjectViews);
  const pipelineEvidence = buildPipelineEvidenceLayer(
    questionType,
    pipelineViews?.validatedEdgeEvidenceView,
  );
  const freshness = inferFreshness(
    publicResearchObjectViews,
    pgViews,
    pipelineViews,
    input.publicResearchView,
    input.snapshots?.freshness,
  );
  const sourceViews = buildSourceViews(
    publicResearchObjectViews,
    pgViews,
    pipelineViews,
    questionType,
  );
  const contradictions = detectContradictions({
    currentSetup,
    historicalBaseRate,
    pathRisk,
    relativeComparison,
    pipelineEvidence,
    pgViews,
    pipelineViews,
    publicResearchObjectViews,
  });
  const missingEvidence = detectMissingEvidence({
    questionType,
    currentSetup,
    historicalBaseRate,
    pathRisk,
    relativeComparison,
    pipelineEvidence,
    freshness,
    pgViews,
    pipelineViews,
    publicResearchObjectViews,
  });
  const confidence = synthesizeConfidence({
    questionType,
    currentSetup,
    historicalBaseRate,
    pathRisk,
    relativeComparison,
    pipelineEvidence,
    freshness,
    contradictions,
    missingEvidence,
  });

  return {
    questionType,
    anchor,
    timeHorizon: inferTimeHorizon(questionType, publicResearchObjectViews, pgViews),
    ...(currentSetup ? { currentSetup } : {}),
    ...(historicalBaseRate ? { historicalBaseRate } : {}),
    ...(pathRisk ? { pathRisk } : {}),
    ...(relativeComparison ? { relativeComparison } : {}),
    ...(pipelineEvidence ? { pipelineEvidence } : {}),
    ...(freshness ? { freshness } : {}),
    contradictions,
    missingEvidence,
    confidence,
    monitorNext: buildMonitorNext({
      questionType,
      anchor,
      contradictions,
      missingEvidence,
      confidence,
      pipelineEvidence,
      pathRisk,
    }),
    sourceViews,
  };
}

export function buildAnalystBriefContract(pack: EvidencePack): AnalystBrief {
  const tables = buildAnalystTables(pack);
  const caveats = [
    ...(pack.freshness?.warning ? [pack.freshness.warning] : []),
    ...pack.missingEvidence.slice(0, 4),
  ];

  return {
    bottomLine:
      "Lead with a concise analyst judgment based only on the Evidence Pack.",
    sections: [
      {
        id: "why_it_matters",
        heading: "Why it matters",
        bullets: pack.currentSetup?.keyData.slice(0, 3) ?? [],
      },
      {
        id: "supports",
        heading: "What supports it",
        bullets: supportedBullets(pack),
      },
      {
        id: "concerns",
        heading: "What argues against it",
        bullets: pack.contradictions.length
          ? pack.contradictions.slice(0, 4)
          : ["State the main concern only if it is present in the Evidence Pack."],
      },
      {
        id: "risk",
        heading: "Risk",
        bullets: pack.pathRisk?.keyData.slice(0, 4) ?? [],
      },
      {
        id: "what_changes_view",
        heading: "What would change the view",
        bullets: pack.monitorNext.slice(0, 4),
      },
      {
        id: "data_limitations",
        heading: "Data / limitations",
        bullets: caveats,
      },
      {
        id: "confidence",
        heading: "Confidence",
        body: `${pack.confidence.level}: ${pack.confidence.explanation}`,
      },
    ],
    tables,
    caveats,
    confidence: pack.confidence,
    sources: sourceLabels(pack.sourceViews),
    followUps: buildFollowUps(pack),
  };
}

export function formatEvidencePackForPrompt(pack: EvidencePack): string {
  return JSON.stringify(pack, null, 2);
}

export function formatAnalystBriefContractForPrompt(brief: AnalystBrief): string {
  return JSON.stringify(brief, null, 2);
}

/**
 * Slim Evidence Pack rendering for the deep-agent system prompt. Drops the
 * per-layer `keyData` arrays — those are lossy prose summaries of the raw
 * Research Object that the model already has verbatim in the `# Evidence`
 * section. Keeps only the *synthesis* fields the model can't derive itself
 * (analyst-side meta-analysis): question type, anchor, horizon, the catalog
 * of evidence layers that loaded (with state + strength), contradictions,
 * missing evidence, confidence, and follow-up monitor list.
 */
export function formatEvidencePackSynthesisForPrompt(pack: EvidencePack): string {
  const layerSummary = (label: string, l?: EvidenceLayer) =>
    l
      ? {
          label,
          sourceView: l.sourceView,
          state: l.state,
          strength: l.strength,
          interpretation: l.interpretation,
          ...(l.warnings.length ? { warnings: l.warnings } : {}),
        }
      : undefined;
  const layers = [
    layerSummary("currentSetup", pack.currentSetup),
    layerSummary("historicalBaseRate", pack.historicalBaseRate),
    layerSummary("pathRisk", pack.pathRisk),
    layerSummary("relativeComparison", pack.relativeComparison),
    layerSummary("pipelineEvidence", pack.pipelineEvidence),
  ].filter(Boolean);
  // NOTE: we deliberately do NOT include a top-level `freshness` here.
  // `inferFreshness` falls through PG views, RO freshness, and the pipeline
  // snapshot, picking whichever is non-empty — that conflates pipeline-side
  // and PG-side dates into one ambiguous field. The canonical date the model
  // must cite is `view.asOfDate` on each Research Object / PG capability
  // view, which is rendered in the `# Evidence` section directly.
  const synthesis = {
    questionType: pack.questionType,
    ...(pack.workflowName ? { workflowName: pack.workflowName } : {}),
    ...(pack.anchor ? { anchor: pack.anchor } : {}),
    ...(pack.timeHorizon ? { timeHorizon: pack.timeHorizon } : {}),
    evidenceLayers: layers,
    contradictions: pack.contradictions,
    missingEvidence: pack.missingEvidence,
    confidence: pack.confidence,
    monitorNext: pack.monitorNext,
    sourceViews: pack.sourceViews,
  };
  return JSON.stringify(synthesis, null, 2);
}

function isEdgeEvidenceWarning(warning: string): boolean {
  return /\b(?:validated\s+edge|edge\s+evidence|pipeline)\b/i.test(warning);
}

function pgViewsFromPublicResearchView(view: PublicResearchView): PgCapabilityViews {
  return {
    ...(view.sectorLeaderboardView
      ? { sectorLeaderboardView: view.sectorLeaderboardView }
      : {}),
    ...(view.sectorDivergenceView
      ? { sectorDivergenceView: view.sectorDivergenceView }
      : {}),
    ...(view.sectorDeltaView ? { sectorDeltaView: view.sectorDeltaView } : {}),
    ...(view.stockIdeaView ? { stockIdeaView: view.stockIdeaView } : {}),
    ...(view.featureScreenView ? { featureScreenView: view.featureScreenView } : {}),
    ...(view.factorBacktestView
      ? { factorBacktestView: view.factorBacktestView }
      : {}),
    ...(view.regimeHistoricalPlaybookView
      ? { regimeHistoricalPlaybookView: view.regimeHistoricalPlaybookView }
      : {}),
  };
}

function pipelineViewsFromPublicResearchView(
  view: PublicResearchView,
): PipelineOverlayViews {
  return {
    ...(view.validatedEdgeEvidenceView
      ? { validatedEdgeEvidenceView: view.validatedEdgeEvidenceView }
      : {}),
  };
}

function inferAnchor(
  classification: Classification | undefined,
  ros: PublicResearchObjectView[],
  pgViews: PgCapabilityViews | undefined,
  pipelineViews: PipelineOverlayViews | undefined,
): AnalystAnchor | undefined {
  const pipelineAnchor = pipelineViews?.validatedEdgeEvidenceView?.anchor;
  if (pipelineAnchor) return { ...pipelineAnchor };
  if (classification && isComparisonClassification(classification) && ros.length >= 2) {
    return {
      type: "comparison",
      label: ros
        .slice(0, 4)
        .map((ro) => ro.title ?? ro.anchor)
        .join(" vs "),
    };
  }
  const ro = ros[0];
  if (ro) {
    if (ro.objectType === "stock") {
      // Carry the stock's own sector/industry on the anchor so downstream
      // follow-up generation can suggest natural sector/industry comparison
      // questions ("how does X compare to other stocks in <sector>?", etc.)
      return {
        type: "stock",
        symbol: ro.anchor,
        label: ro.title ?? ro.anchor,
        ...(ro.sector ? { sector: ro.sector } : {}),
        ...(ro.industry ? { industry: ro.industry } : {}),
      };
    }
    if (ro.objectType === "sector") return { type: "sector", sector: ro.anchor, label: ro.title ?? ro.anchor };
    if (ro.objectType === "industry") return { type: "industry", industry: ro.anchor, label: ro.title ?? ro.anchor };
    return { type: "regime", regime: ro.anchor, label: ro.title ?? ro.anchor };
  }
  if (classification?.symbols[0]) {
    return { type: "stock", symbol: classification.symbols[0], label: classification.symbols[0] };
  }
  if (classification?.sectors[0]) {
    return { type: "sector", sector: classification.sectors[0], label: classification.sectors[0] };
  }
  if (classification?.industries[0]) {
    return { type: "industry", industry: classification.industries[0], label: classification.industries[0] };
  }
  if (pgViews?.featureScreenView) return { type: "screen", label: "Feature screen" };
  return undefined;
}

function buildCurrentSetupLayer(
  questionType: AnalystQuestionType,
  ros: PublicResearchObjectView[],
  pgViews: PgCapabilityViews | undefined,
): EvidenceLayer | undefined {
  if (questionType === "factor_backtest") return undefined;
  if (questionType === "validated_pipeline_evidence") return undefined;

  const ro = ros[0];
  if (ro && questionType !== "risk") {
    const keyData = [
      ...ro.fiveQuestion.whatMattersNow.slice(0, 3),
      ...(ro.fiveQuestion.whyNow ? [ro.fiveQuestion.whyNow] : []),
    ].filter(Boolean);
    return layer({
      state: "complete",
      keyData,
      interpretation:
        "Current public Research Object evidence is available for the anchor.",
      strength: strengthFromState("complete", keyData),
      // Filter cross-layer warnings: the RO's top-level warnings array
      // aggregates edge-evidence warnings ("No validated edge evidence
      // returned for this anchor.") into every layer that reads it. Edge
      // evidence is its own layer; its absence belongs there, not on the
      // current-setup layer.
      warnings: ro.warnings.filter((w) => !isEdgeEvidenceWarning(w)),
      sourceView: "publicResearchObjectView",
    });
  }

  if (pgViews?.featureScreenView) {
    const view = pgViews.featureScreenView;
    return layer({
      state: view.state,
      keyData: [
        `Criteria: ${view.screenCriteria.map((item) => `${item.factor} ${item.bucket}`).join(", ") || "none"}.`,
        `Rows: ${view.rows.length}.`,
        ...view.rows.slice(0, 5).map((row) => {
          const buckets = [
            row.valuationBucket ? `valuation ${row.valuationBucket}` : "",
            row.qualityBucket ? `quality ${row.qualityBucket}` : "",
            row.momentumBucket ? `momentum ${row.momentumBucket}` : "",
          ].filter(Boolean);
          return `${row.symbol}: ${buckets.join(", ") || "public buckets available"}.`;
        }),
      ],
      interpretation: "Current-feature screen results are available.",
      strength: strengthFromState(view.state, view.rows),
      warnings: view.warnings,
      sourceView: "featureScreenView",
    });
  }

  if (pgViews?.stockIdeaView) {
    const view = pgViews.stockIdeaView;
    return layer({
      state: view.state,
      keyData: [
        `Research candidates: ${view.rows.length}.`,
        ...view.rows.slice(0, 5).map((row) =>
          `${row.rank}. ${row.symbol}${row.sector ? ` (${row.sector})` : ""}: ${row.reasonBullets.join(" ")}`,
        ),
      ],
      interpretation: "PG current setup candidates are available.",
      strength: strengthFromState(view.state, view.rows),
      warnings: view.warnings,
      sourceView: "stockIdeaView",
    });
  }

  if (pgViews?.sectorLeaderboardView) {
    return sectorLeaderboardLayer(pgViews.sectorLeaderboardView);
  }
  if (pgViews?.sectorDivergenceView) {
    return sectorDivergenceLayer(pgViews.sectorDivergenceView);
  }
  if (pgViews?.sectorDeltaView) {
    return sectorDeltaLayer(pgViews.sectorDeltaView);
  }
  if (pgViews?.regimeHistoricalPlaybookView) {
    return regimePlaybookCurrentLayer(pgViews.regimeHistoricalPlaybookView);
  }
  return undefined;
}

function buildHistoricalBaseRateLayer(
  questionType: AnalystQuestionType,
  ros: PublicResearchObjectView[],
  pgViews: PgCapabilityViews | undefined,
): EvidenceLayer | undefined {
  if (questionType === "validated_pipeline_evidence") return undefined;
  if (pgViews?.factorBacktestView) {
    const view = pgViews.factorBacktestView;
    const keyData = [
      `Horizon: ${view.horizon}.`,
      `Sample size: ${view.sampleSize ?? "unavailable"}.`,
      ...(view.hitRatePct !== undefined ? [`Hit rate: ${view.hitRatePct}%.`] : []),
      ...(view.medianReturnPct !== undefined ? [`Median return: ${view.medianReturnPct}%.`] : []),
      ...(view.p25ReturnPct !== undefined && view.p75ReturnPct !== undefined
        ? [`p25/p75 range: ${view.p25ReturnPct}% to ${view.p75ReturnPct}%.`]
        : []),
      ...(view.sampleAdequacy ? [`Sample adequacy: ${view.sampleAdequacy}.`] : []),
    ];
    return layer({
      state: view.state,
      keyData,
      interpretation: "Historical factor-condition evidence is available.",
      strength: strengthFromSample(view.sampleSize, view.sampleAdequacy, view.state),
      warnings: view.warnings,
      sourceView: "factorBacktestView",
    });
  }

  if (pgViews?.regimeHistoricalPlaybookView) {
    const view = pgViews.regimeHistoricalPlaybookView;
    return layer({
      state: view.state,
      keyData: [
        ...(view.regime ? [`Regime: ${view.regime}.`] : []),
        `Rows: ${view.rows.length}.`,
        ...view.rows.slice(0, 5).map((row) =>
          `${row.rank}. ${row.sector}: ${row.role}${row.hitRatePct !== undefined ? `, hit rate ${row.hitRatePct}%` : ""}.`,
        ),
      ],
      interpretation: "Historical regime playbook evidence is available.",
      strength: strengthFromState(view.state, view.rows),
      warnings: view.warnings,
      sourceView: "regimeHistoricalPlaybookView",
    });
  }

  const ro = ros[0];
  if (ro?.probabilisticEvidence) {
    const evidence = ro.probabilisticEvidence;
    return layer({
      state: evidence.state,
      keyData: probabilisticKeyData(evidence),
      interpretation: "Historical analog evidence is available.",
      strength: strengthFromSample(
        evidence.sampleSize,
        evidence.sampleAdequacy,
        evidence.state,
      ),
      // `notes` are explanatory commentary about the layer (where the data
      // came from), not turn-specific warnings. Surfacing them as warnings
      // makes the model hedge unnecessarily.
      warnings: [],
      sourceView: "publicResearchObjectView.probabilisticEvidence",
    });
  }
  return undefined;
}

function buildPathRiskLayer(
  questionType: AnalystQuestionType,
  ros: PublicResearchObjectView[],
): EvidenceLayer | undefined {
  const ro = ros[0];
  if (!ro?.pathRisk) return undefined;
  const risk = ro.pathRisk;
  const keyData = [
    `Horizon: ${risk.horizon}.`,
    ...(risk.source ? [`Source: ${risk.source === "pg_daily_price_path" ? "daily price path evidence" : "bucketed public risk evidence"}.`] : []),
    ...(risk.p10MaxDrawdownPct !== undefined ? [`p10 max drawdown: ${risk.p10MaxDrawdownPct}%.`] : []),
    ...(risk.worstMaxDrawdownPct !== undefined ? [`Worst observed max drawdown: ${risk.worstMaxDrawdownPct}%.`] : []),
    ...(risk.probDrawdownGt10Pct !== undefined ? [`Probability of drawdown greater than 10%: ${risk.probDrawdownGt10Pct}%.`] : []),
    ...(risk.recoveredByHorizonRatePct !== undefined ? [`Recovered by horizon: ${risk.recoveredByHorizonRatePct}%.`] : []),
    ...(risk.maxDrawdownBucket ? [`Max drawdown bucket: ${risk.maxDrawdownBucket}.`] : []),
    ...(risk.recoveryProfile ? [`Recovery profile: ${risk.recoveryProfile}.`] : []),
  ];
  return layer({
    state: risk.state,
    keyData,
    interpretation:
      questionType === "risk"
        ? "This is the primary evidence layer for the risk-focused answer."
        : "Daily drawdown-risk evidence is available as a risk layer.",
    strength: strengthFromSample(risk.sampleSize, risk.sampleAdequacy, risk.state),
    // `notes` describe the layer's lineage ("computed from PG daily price
    // paths..."); they are not warnings. Mixing them into warnings makes the
    // model treat normal commentary as caveats and pushes it to mention
    // pipeline-overlay machinery (Sentinel, Coroner, edge-specific path
    // risk) even when none is loaded for this turn.
    warnings: risk.warnings ?? [],
    sourceView: "publicResearchObjectView.pathRisk",
  });
}

function buildComparisonLayer(
  questionType: AnalystQuestionType,
  ros: PublicResearchObjectView[],
): EvidenceLayer | undefined {
  if (questionType !== "comparison") return undefined;
  if (ros.length < 2) return undefined;
  const warnings = ros.flatMap((ro) => ro.warnings).slice(0, 5);
  const keyData = [
    `Comparison anchors: ${ros.map((ro) => `${ro.objectType.toUpperCase()} ${ro.anchor}`).join(" vs ")}.`,
    ...ros.slice(0, 4).map((ro) => {
      const headline = ro.fiveQuestion.whatMattersNow[0] ?? ro.fiveQuestion.whyNow ?? "research object available";
      return `${ro.objectType.toUpperCase()} ${ro.anchor}: ${headline}`;
    }),
    "Derive the side-by-side analysis directly from the per-anchor research objects (whatMattersNow, probabilisticEvidence, pathRisk, edgeEvidence).",
  ];
  return layer({
    state: "complete",
    keyData,
    interpretation:
      "Multiple research objects are available — use them to perform the comparison side-by-side.",
    strength: strengthFromState("complete", ros),
    warnings,
    sourceView: "publicResearchObjectView",
  });
}

function buildPipelineEvidenceLayer(
  questionType: AnalystQuestionType,
  view: ValidatedEdgeEvidenceView | undefined,
): EvidenceLayer | undefined {
  if (!view) return undefined;
  const keyData = [
    ...(view.evidenceState ? [`Evidence state: ${view.evidenceState}.`] : []),
    ...(view.edgeCountBucket ? [`Edge count bucket: ${view.edgeCountBucket}.`] : []),
    ...(view.eventSampleBucket ? [`Event sample bucket: ${view.eventSampleBucket}.`] : []),
    ...(view.pipelineRiskBand ? [`Pipeline risk band: ${view.pipelineRiskBand}.`] : []),
    ...(view.liveConfirmationBucket ? [`Live confirmation bucket: ${view.liveConfirmationBucket}.`] : []),
    ...(view.decayRiskBucket ? [`Decay caution bucket: ${view.decayRiskBucket}.`] : []),
    ...view.interpretationBullets.slice(0, 5),
  ];
  return layer({
    state: view.state,
    keyData,
    interpretation:
      questionType === "validated_pipeline_evidence"
        ? "Pipeline validation is the primary evidence layer for this answer."
        : "Pipeline validation evidence is available as a separate evidence layer.",
    strength: strengthFromPipeline(view),
    warnings: view.warnings,
    sourceView: "validatedEdgeEvidenceView",
  });
}

function sectorLeaderboardLayer(view: SectorLeaderboardView): EvidenceLayer {
  return layer({
    state: view.state,
    keyData: [
      `Rows: ${view.rows.length}.`,
      ...view.rows.slice(0, 5).map((row) =>
        `${row.rank}. ${row.sector}: conviction ${row.convictionBucket ?? "unavailable"}${row.hitRatePct !== undefined ? `, hit rate ${row.hitRatePct}%` : ""}.`,
      ),
    ],
    interpretation: "Sector conviction leaderboard evidence is available.",
    strength: strengthFromState(view.state, view.rows),
    warnings: view.warnings,
    sourceView: "sectorLeaderboardView",
  });
}

function sectorDivergenceLayer(view: SectorDivergenceView): EvidenceLayer {
  return layer({
    state: view.state,
    keyData: [
      `Clear divergences: ${view.clearDivergenceCount ?? view.rows.length}.`,
      ...view.rows.slice(0, 5).map((row) =>
        `${row.rank}. ${row.sector}: ${row.divergenceType ?? "divergence"}; ${row.interpretationBullets.join(" ")}`,
      ),
    ],
    interpretation: "Sector conviction-versus-momentum divergence evidence is available.",
    strength: strengthFromState(view.state, view.rows),
    warnings: view.warnings,
    sourceView: "sectorDivergenceView",
  });
}

function sectorDeltaLayer(view: SectorDeltaView): EvidenceLayer {
  return layer({
    state: view.state,
    keyData: [
      ...(view.currentAsOfDate ? [`Current date: ${view.currentAsOfDate}.`] : []),
      ...(view.priorAsOfDate ? [`Prior date: ${view.priorAsOfDate}.`] : []),
      ...view.rows.slice(0, 5).map((row) =>
        `${row.rank}. ${row.sector}: ${row.direction}; ${row.interpretationBullets.join(" ")}`,
      ),
    ],
    interpretation: "Week-over-week sector delta evidence is available.",
    strength: strengthFromState(view.state, view.rows),
    warnings: view.warnings,
    sourceView: "sectorDeltaView",
  });
}

function regimePlaybookCurrentLayer(view: RegimeHistoricalPlaybookView): EvidenceLayer {
  return layer({
    state: view.state,
    keyData: [
      ...(view.regime ? [`Regime: ${view.regime}.`] : []),
      ...view.summaryBullets.slice(0, 3),
      ...view.risks.slice(0, 3).map((risk) =>
        `${risk.riskLabel}: ${risk.riskBucket ?? "bucket unavailable"}; ${risk.interpretation}`,
      ),
    ],
    interpretation: "Regime historical playbook evidence is available.",
    strength: strengthFromState(view.state, view.rows),
    warnings: view.warnings,
    sourceView: "regimeHistoricalPlaybookView",
  });
}

function probabilisticKeyData(evidence: ProbabilisticEvidenceView): string[] {
  return [
    `Horizon: ${evidence.horizon}.`,
    ...(evidence.sampleSize !== undefined ? [`Sample size: ${evidence.sampleSize}.`] : []),
    ...(evidence.hitRatePct !== undefined ? [`Hit rate: ${evidence.hitRatePct}%.`] : []),
    ...(evidence.medianReturnPct !== undefined ? [`Median return: ${evidence.medianReturnPct}%.`] : []),
    ...(evidence.p25ReturnPct !== undefined && evidence.p75ReturnPct !== undefined
      ? [`p25/p75 range: ${evidence.p25ReturnPct}% to ${evidence.p75ReturnPct}%.`]
      : []),
    ...(evidence.sampleAdequacy ? [`Sample adequacy: ${evidence.sampleAdequacy}.`] : []),
  ];
}

function inferFreshness(
  ros: PublicResearchObjectView[],
  pgViews: PgCapabilityViews | undefined,
  pipelineViews: PipelineOverlayViews | undefined,
  publicResearchView?: PublicResearchView,
  snapshotFreshness?: { dataThrough?: string; stale?: boolean; staleReason?: string },
): PublicFreshnessView | undefined {
  const candidates: Array<PublicFreshnessView | undefined> = [
    pipelineViews?.validatedEdgeEvidenceView?.freshness,
    pgViews?.featureScreenView?.freshness,
    pgViews?.factorBacktestView?.freshness,
    pgViews?.stockIdeaView?.freshness,
    pgViews?.sectorLeaderboardView?.freshness,
    pgViews?.sectorDivergenceView?.freshness,
    pgViews?.sectorDeltaView?.freshness,
    pgViews?.regimeHistoricalPlaybookView?.freshness,
    // v4: view.freshness was dropped; we use the view's canonical
    // `asOfDate` (PG-aligned) as the freshness signal instead. The
    // pipeline-snapshot lineage lives only on the top-level RO via
    // `CachedResearchObject.freshness` and is intentionally not consulted
    // for the prompt-side freshness pick.
    ...ros.map((ro) => ({
      dataThrough: ro.asOfDate,
      state: "unknown" as const,
    })),
    publicResearchView?.freshness?.dataThrough
      ? {
          dataThrough: publicResearchView.freshness.dataThrough,
          state: publicResearchView.freshness.stale ? "stale" : "unknown",
          warning: publicResearchView.freshness.staleReason,
        }
      : undefined,
    snapshotFreshness?.dataThrough
      ? {
          dataThrough: snapshotFreshness.dataThrough,
          state: snapshotFreshness.stale ? "stale" : "unknown",
          warning: snapshotFreshness.staleReason,
        }
      : undefined,
  ];
  return candidates.find((item) => item?.dataThrough || item?.state);
}

function inferTimeHorizon(
  questionType: AnalystQuestionType,
  ros: PublicResearchObjectView[],
  pgViews: PgCapabilityViews | undefined,
): string | undefined {
  if (pgViews?.factorBacktestView) return pgViews.factorBacktestView.horizon;
  const ro = ros[0];
  if (questionType === "risk" && ro?.pathRisk?.horizon) return ro.pathRisk.horizon;
  if (ro?.probabilisticEvidence?.horizon) return ro.probabilisticEvidence.horizon;
  return undefined;
}

function buildSourceViews(
  ros: PublicResearchObjectView[],
  pgViews: PgCapabilityViews | undefined,
  pipelineViews: PipelineOverlayViews | undefined,
  questionType: AnalystQuestionType,
): string[] {
  const sources = new Set<string>();
  if (questionType === "validated_pipeline_evidence") {
    if (pipelineViews?.validatedEdgeEvidenceView) {
      sources.add("validatedEdgeEvidenceView");
    }
    return [...sources];
  }
  if (ros.length > 0) {
    sources.add("publicResearchObjectView");
  }
  for (const key of Object.keys(pgViews ?? {})) sources.add(key);
  if (pipelineViews?.validatedEdgeEvidenceView) {
    sources.add("validatedEdgeEvidenceView");
  }
  return [...sources];
}

function detectContradictions(input: {
  currentSetup?: EvidenceLayer;
  historicalBaseRate?: EvidenceLayer;
  pathRisk?: EvidenceLayer;
  relativeComparison?: EvidenceLayer;
  pipelineEvidence?: EvidenceLayer;
  pgViews?: PgCapabilityViews;
  pipelineViews?: PipelineOverlayViews;
  publicResearchObjectViews: PublicResearchObjectView[];
}): string[] {
  const bullets: string[] = [];
  const rows = [
    ...(input.pgViews?.featureScreenView?.rows ?? []),
    ...(input.pgViews?.stockIdeaView?.rows ?? []),
  ];
  for (const row of rows) {
    if (isStrong(row.qualityBucket) && isWeak(row.momentumBucket)) {
      bullets.push(
        `${"symbol" in row ? row.symbol : "A candidate"} has strong quality evidence but weak momentum evidence.`,
      );
      break;
    }
  }

  const factor = input.pgViews?.factorBacktestView;
  if (
    factor?.criteria.some((item) => item.factor === "valuation" && isStrong(item.bucket)) &&
    ((factor.hitRatePct !== undefined && factor.hitRatePct < 50) ||
      (factor.medianReturnPct !== undefined && factor.medianReturnPct < 0))
  ) {
    bullets.push(
      "The valuation setup is attractive, but the historical evidence is weak for the selected horizon.",
    );
  }

  const ro = input.publicResearchObjectViews[0];
  if (ro?.probabilisticEvidence && ro.pathRisk) {
    const strongBaseRate =
      (ro.probabilisticEvidence.hitRatePct ?? 0) >= 55 ||
      (ro.probabilisticEvidence.medianReturnPct ?? 0) > 0;
    const elevatedDrawdown =
      (ro.pathRisk.probDrawdownGt10Pct ?? 0) >= 20 ||
      (ro.pathRisk.worstMaxDrawdownPct ?? 0) <= -25 ||
      isWeak(ro.pathRisk.maxDrawdownBucket) ||
      isWeak(ro.pathRisk.downsideTailBucket);
    if (strongBaseRate && elevatedDrawdown) {
      bullets.push(
        "Historical evidence is constructive, but drawdown-risk evidence is elevated.",
      );
    }
  }

  const pipeline = input.pipelineViews?.validatedEdgeEvidenceView;
  if (
    pipeline?.evidenceState &&
    ["edge_evidence_strong", "edge_evidence_present"].includes(pipeline.evidenceState)
  ) {
    if (
      pipeline.liveConfirmationBucket &&
      ["mixed", "not_confirmed", "deteriorating"].includes(
        pipeline.liveConfirmationBucket,
      )
    ) {
      bullets.push(
        "Pipeline evidence is present, but aggregate live confirmation is not clean.",
      );
    }
    if (
      pipeline.decayRiskBucket &&
      ["watch", "decay_elevated"].includes(pipeline.decayRiskBucket)
    ) {
      bullets.push(
        "Pipeline evidence is present, but the decay/caution bucket requires monitoring.",
      );
    }
  }

  return [...new Set(bullets)].slice(0, 6);
}

function detectMissingEvidence(input: {
  questionType: AnalystQuestionType;
  currentSetup?: EvidenceLayer;
  historicalBaseRate?: EvidenceLayer;
  pathRisk?: EvidenceLayer;
  relativeComparison?: EvidenceLayer;
  pipelineEvidence?: EvidenceLayer;
  freshness?: PublicFreshnessView;
  pgViews?: PgCapabilityViews;
  pipelineViews?: PipelineOverlayViews;
  publicResearchObjectViews: PublicResearchObjectView[];
}): string[] {
  const bullets: string[] = [];
  const needsPathRisk = ["stock_opinion", "risk", "comparison"].includes(input.questionType);
  if (needsPathRisk && (!input.pathRisk || input.pathRisk.state === "unavailable")) {
    bullets.push("Path-risk evidence is unavailable.");
  } else if (needsPathRisk && input.pathRisk?.state === "partial") {
    bullets.push("Path-risk evidence is partial.");
  }

  // Validated pipeline edge evidence is a BONUS layer on top of the PG
  // Research Object stack — its absence is the common case and must not be
  // surfaced as a "missing evidence" hedge in user-facing answers. Only flag
  // it when the user explicitly asked for validated-pipeline-evidence (in
  // which case the absence really is the answer).
  if (
    input.questionType === "validated_pipeline_evidence" &&
    !input.pipelineEvidence
  ) {
    bullets.push("Pipeline validated evidence is unavailable for this anchor.");
  }

  // Pipeline-snapshot freshness ("daily_brief"/snapshots.freshness) is
  // supplemental, not canonical. Postgres per-view `asOfDate` /
  // `freshness.dataThrough` is what the model anchors on. Do NOT surface
  // pipeline-snapshot freshness state as a "data limitations" bullet — that
  // produces phrases like "רמת הטריות מסומנת כלא ידועה" which contradict
  // the actual evidence layer the answer is built from.

  const factor = input.pgViews?.factorBacktestView;
  if (factor?.sampleAdequacy === "THIN" || (factor?.sampleSize ?? 100) < 30) {
    bullets.push("Historical sample is thin.");
  }
  if (
    input.questionType === "comparison" &&
    (!input.relativeComparison || input.relativeComparison.state === "unavailable")
  ) {
    bullets.push(
      "Comparison evidence is unavailable — fewer than two research objects were built.",
    );
  }
  if (
    input.questionType === "factor_backtest" &&
    (!input.historicalBaseRate || input.historicalBaseRate.state === "unavailable")
  ) {
    bullets.push("Factor backtest evidence is unavailable.");
  }
  // Pipeline overlay sub-buckets (live confirmation, decay/caution) are
  // optional aggregate-context fields. Their absence is not "missing
  // evidence" — it just means the overlay was not produced this turn. Do
  // not push them into missingEvidence.
  return [...new Set(bullets)].slice(0, 8);
}

function synthesizeConfidence(input: {
  questionType: AnalystQuestionType;
  currentSetup?: EvidenceLayer;
  historicalBaseRate?: EvidenceLayer;
  pathRisk?: EvidenceLayer;
  relativeComparison?: EvidenceLayer;
  pipelineEvidence?: EvidenceLayer;
  freshness?: PublicFreshnessView;
  contradictions: string[];
  missingEvidence: string[];
}): AnalystConfidence {
  const layers = [
    input.currentSetup,
    input.historicalBaseRate,
    input.pathRisk,
    input.relativeComparison,
    input.pipelineEvidence,
  ].filter((item): item is EvidenceLayer => Boolean(item));

  if (layers.length === 0 || layers.every((item) => item.state === "unavailable")) {
    return {
      level: "unavailable",
      explanation: "No public evidence layer is available for this question.",
    };
  }

  const completeLayers = layers.filter((item) => item.state === "complete").length;
  const strongLayers = layers.filter((item) => item.strength === "strong").length;
  const weakLayers = layers.filter((item) => item.strength === "weak").length;
  const stale = input.freshness?.state === "stale";
  const majorMissing = input.missingEvidence.length >= 3;
  const majorContradiction = input.contradictions.length >= 2;

  if (stale || majorMissing || majorContradiction || weakLayers >= 2) {
    return {
      level: "low",
      explanation:
        "Important evidence is stale, missing, weak, or contradictory, so confidence should stay low.",
    };
  }

  if (completeLayers >= 2 && strongLayers >= 1 && input.contradictions.length === 0) {
    return {
      level: "high",
      explanation:
        "Multiple public evidence layers are complete and broadly aligned.",
    };
  }

  return {
    level: "moderate",
    explanation:
      "Useful public evidence is available, but some evidence is missing, partial, or mixed.",
  };
}

function buildMonitorNext(input: {
  questionType: AnalystQuestionType;
  anchor?: AnalystAnchor;
  contradictions: string[];
  missingEvidence: string[];
  confidence: AnalystConfidence;
  pipelineEvidence?: EvidenceLayer;
  pathRisk?: EvidenceLayer;
}): string[] {
  const label = input.anchor?.label ?? input.anchor?.symbol ?? input.anchor?.sector ?? "the setup";
  const items = new Set<string>();
  if (input.pathRisk) {
    items.add(`Watch whether ${label} keeps drawdown risk contained over the stated horizon.`);
  }
  if (input.pipelineEvidence) {
    items.add(`Watch whether Pipeline validation and live confirmation stay aligned for ${label}.`);
  }
  if (input.contradictions.length) {
    items.add("Watch whether the main contradiction resolves or widens.");
  }
  if (input.missingEvidence.length) {
    items.add("Fill the missing evidence before raising conviction.");
  }
  if (input.questionType === "factor_backtest") {
    items.add("Check sample adequacy before treating the historical pattern as meaningful.");
  }
  if (items.size === 0) {
    items.add("Monitor freshness and whether the key public buckets continue to confirm.");
  }
  return [...items].slice(0, 5);
}

function buildFollowUps(pack: EvidencePack): string[] {
  const label = pack.anchor?.label ?? pack.anchor?.symbol ?? pack.anchor?.sector ?? "this setup";
  const followUps = new Set<string>();
  if (pack.pathRisk) followUps.add(`What is the main risk for ${label}?`);
  if (!pack.pipelineEvidence) followUps.add(`Is there validated Pipeline evidence for ${label}?`);
  if (pack.relativeComparison) followUps.add(`What is the strongest comparison point for ${label}?`);
  if (pack.contradictions.length) followUps.add("What would resolve the main contradiction?");

  // Stock anchors with a known sector/industry → lead the user toward the
  // natural peer-comparison capabilities (sector_leaders, industry_leaders,
  // sector_conviction_leaderboard) that the platform already supports.
  if (pack.anchor?.type === "stock") {
    const sector = pack.anchor.sector;
    const industry = pack.anchor.industry;
    if (sector) {
      followUps.add(`How does ${label} compare to other stocks in the ${sector} sector?`);
      followUps.add(`What are the leading stocks in ${sector} right now?`);
    }
    if (industry) {
      followUps.add(`How does ${label} compare to other stocks in the ${industry} industry?`);
    }
  }

  followUps.add("What should I monitor next?");
  return [...followUps].slice(0, 5);
}

function buildAnalystTables(pack: EvidencePack): AnalystBriefTable[] {
  const tables: AnalystBriefTable[] = [];
  const evidenceRows = [
    pack.currentSetup,
    pack.historicalBaseRate,
    pack.pathRisk,
    pack.relativeComparison,
    pack.pipelineEvidence,
  ]
    .filter((item): item is EvidenceLayer => Boolean(item))
    .map((item) => [
      item.sourceView,
      item.keyData.slice(0, 2).join(" "),
      item.interpretation,
      item.strength,
    ]);
  if (evidenceRows.length) {
    tables.push({
      type: "evidence",
      columns: ["Layer", "Key data", "Interpretation", "Strength"],
      rows: evidenceRows,
    });
  }
  if (pack.pathRisk) {
    tables.push({
      type: "risk",
      columns: ["Risk type", "Metric", "Meaning", "Severity"],
      rows: pack.pathRisk.keyData.slice(0, 4).map((item) => [
        "Path risk",
        item,
        pack.pathRisk?.interpretation ?? "",
        pack.pathRisk?.strength ?? "unavailable",
      ]),
    });
  }
  if (pack.relativeComparison) {
    tables.push({
      type: "comparison",
      columns: ["Metric", "Asset", "Peer/Sector", "Interpretation"],
      rows: pack.relativeComparison.keyData.slice(0, 5).map((item) => [
        "Public comparison",
        "",
        "",
        item,
      ]),
    });
  }
  if (pack.questionType === "factor_backtest" && pack.historicalBaseRate) {
    tables.push({
      type: "backtest",
      columns: ["Horizon", "Sample size", "Hit rate", "Median return", "p25/p75", "Adequacy"],
      rows: [pack.historicalBaseRate.keyData],
    });
  }
  if (pack.pipelineEvidence) {
    tables.push({
      type: "pipeline_evidence",
      columns: ["Evidence area", "Bucket", "Meaning", "Caveat"],
      rows: pack.pipelineEvidence.keyData.slice(0, 6).map((item) => [
        "Pipeline validation",
        item,
        pack.pipelineEvidence?.interpretation ?? "",
        "Not a trade instruction.",
      ]),
    });
  }
  return tables;
}

function supportedBullets(pack: EvidencePack): string[] {
  const bullets = [
    ...(pack.currentSetup?.keyData.slice(0, 2) ?? []),
    ...(pack.historicalBaseRate?.keyData.slice(0, 2) ?? []),
    ...(pack.pipelineEvidence?.keyData.slice(0, 2) ?? []),
  ];
  return bullets.length ? bullets : ["Use only explicit support from the Evidence Pack."];
}

function sourceLabels(sourceViews: string[]): AnalystBriefSource[] {
  return sourceViews.map((sourceView) => {
    if (sourceView.includes("validatedEdgeEvidence")) {
      return { label: "Pipeline validation", type: "pipeline_validation" };
    }
    if (sourceView.includes("factor") || sourceView.includes("regimeHistorical")) {
      return { label: "Historical evidence", type: "pg_historical" };
    }
    if (sourceView.includes("publicResearchObject")) {
      return { label: "Research Object", type: "research_object" };
    }
    return { label: "Current public view", type: "pg_current" };
  });
}

function layer(input: EvidenceLayer): EvidenceLayer {
  return {
    ...input,
    keyData: input.keyData.filter(Boolean).slice(0, 10),
    warnings: input.warnings.filter(Boolean).slice(0, 8),
  };
}

function strengthFromState(state: EvidenceLayer["state"], rows: unknown[]): EvidenceLayerStrength {
  if (state === "unavailable") return "unavailable";
  if (state === "partial") return rows.length ? "moderate" : "weak";
  return rows.length ? "strong" : "weak";
}

function strengthFromSample(
  sampleSize: number | undefined,
  adequacy: string | undefined,
  state: EvidenceLayer["state"],
): EvidenceLayerStrength {
  if (state === "unavailable") return "unavailable";
  if (state === "partial" || adequacy === "THIN" || (sampleSize ?? 100) < 30) {
    return "weak";
  }
  if (adequacy === "ROBUST" || (sampleSize ?? 0) >= 100) return "strong";
  return "moderate";
}

function strengthFromPipeline(view: ValidatedEdgeEvidenceView): EvidenceLayerStrength {
  if (view.state === "unavailable") return "unavailable";
  if (view.evidenceState === "edge_evidence_strong") return "strong";
  if (view.evidenceState === "edge_evidence_present") return "moderate";
  if (view.evidenceState === "mixed" || view.state === "partial") return "weak";
  return "unavailable";
}

function isStrong(value: string | undefined): boolean {
  return Boolean(value && STRONG_BUCKETS.has(value));
}

function isWeak(value: string | undefined): boolean {
  return Boolean(value && WEAK_BUCKETS.has(value));
}
