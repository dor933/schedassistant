import type {
  EvidenceState,
  PgCapabilityViews,
  PipelineOverlayViews,
  PublicFreshnessView,
  PublicResearchObjectView,
} from "./types";

export type AnalystQuestionType =
  | "stock_opinion"
  | "sector_analysis"
  | "regime_analysis"
  | "risk"
  | "comparison"
  | "leaderboard"
  | "idea_discovery"
  | "feature_screen"
  | "factor_backtest"
  | "validated_pipeline_evidence"
  | "regime_playbook"
  | "compound_research"
  | "unknown";

export type EvidenceLayerStrength =
  | "strong"
  | "moderate"
  | "weak"
  | "unavailable";

export type EvidenceLayer = {
  state: EvidenceState;
  keyData: string[];
  interpretation: string;
  strength: EvidenceLayerStrength;
  warnings: string[];
  sourceView: string;
};

export type AnalystAnchor = {
  type:
    | "stock"
    | "sector"
    | "industry"
    | "regime"
    | "comparison"
    | "screen"
    | "unknown";
  symbol?: string;
  sector?: string;
  industry?: string;
  regime?: string;
  label?: string;
};

export type AnalystConfidenceLevel =
  | "high"
  | "moderate"
  | "low"
  | "unavailable";

export type AnalystConfidence = {
  level: AnalystConfidenceLevel;
  explanation: string;
};

export type AnalystWorkflowName =
  | "regime_to_stock_screen"
  | "sector_delta_to_stock_screen"
  | "sector_divergence_to_stock_screen"
  | "feature_screen_plus_backtest"
  | "stock_deep_dive_stack"
  | "idea_to_compare_and_risk";

export type WorkflowCandidateRow = {
  symbol: string;
  companyName?: string;
  sector?: string;
  rank: number;
  valuationBucket?: string;
  qualityBucket?: string;
  momentumBucket?: string;
  growthBucket?: string;
  leverageBucket?: string;
  convictionBucket?: string;
  hitRatePct?: number;
  medianReturnPct?: number;
  pathRiskBucket?: string;
  pipelineLabel?: string;
  reasonBullets: string[];
  sourceView: "featureScreenView" | "stockIdeaView";
};

export type WorkflowPublicViews = {
  researchObjectViews?: PublicResearchObjectView[];
  pgCapabilityViews?: PgCapabilityViews;
  pipelineOverlayViews?: PipelineOverlayViews;
};

export type WorkflowExecutionResult = {
  workflowName: AnalystWorkflowName;
  publicViews: WorkflowPublicViews;
  candidateRows?: WorkflowCandidateRow[];
  pipelineLabels?: Record<string, string>;
  missingEvidence: string[];
  contradictions: string[];
  freshness?: PublicFreshnessView;
  warnings: string[];
};

export type EvidencePack = {
  questionType: AnalystQuestionType;
  workflowName?: AnalystWorkflowName;
  anchor?: AnalystAnchor;
  timeHorizon?: string;
  currentSetup?: EvidenceLayer;
  historicalBaseRate?: EvidenceLayer;
  pathRisk?: EvidenceLayer;
  relativeComparison?: EvidenceLayer;
  pipelineEvidence?: EvidenceLayer;
  candidateTable?: WorkflowCandidateRow[];
  freshness?: PublicFreshnessView;
  contradictions: string[];
  missingEvidence: string[];
  confidence: AnalystConfidence;
  monitorNext: string[];
  sourceViews: string[];
};

export type AnalystBriefSectionId =
  | "what_was_checked"
  | "why_it_matters"
  | "supports"
  | "concerns"
  | "risk"
  | "what_changes_view"
  | "data_limitations"
  | "confidence";

export type AnalystBriefTableType =
  | "evidence"
  | "risk"
  | "candidate"
  | "comparison"
  | "backtest"
  | "pipeline_evidence";

export type AnalystBriefTable = {
  type: AnalystBriefTableType;
  columns: string[];
  rows: string[][];
};

export type AnalystBriefSection = {
  id: AnalystBriefSectionId;
  heading: string;
  body?: string;
  bullets?: string[];
};

export type AnalystBriefSource = {
  label: string;
  type:
    | "research_object"
    | "pg_historical"
    | "pg_current"
    | "pipeline_validation"
    | "market_context";
};

export type AnalystBrief = {
  bottomLine: string;
  sections: AnalystBriefSection[];
  tables: AnalystBriefTable[];
  caveats: string[];
  confidence: AnalystConfidence;
  sources: AnalystBriefSource[];
  followUps: string[];
};
