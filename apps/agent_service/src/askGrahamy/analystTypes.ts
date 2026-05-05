import type { EvidenceState, PublicFreshnessView } from "./types";

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
  type: "stock" | "sector" | "regime" | "comparison" | "screen" | "unknown";
  symbol?: string;
  sector?: string;
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

export type EvidencePack = {
  questionType: AnalystQuestionType;
  anchor?: AnalystAnchor;
  timeHorizon?: string;
  currentSetup?: EvidenceLayer;
  historicalBaseRate?: EvidenceLayer;
  pathRisk?: EvidenceLayer;
  relativeComparison?: EvidenceLayer;
  pipelineEvidence?: EvidenceLayer;
  freshness?: PublicFreshnessView;
  contradictions: string[];
  missingEvidence: string[];
  confidence: AnalystConfidence;
  monitorNext: string[];
  sourceViews: string[];
};

export type AnalystBriefSectionId =
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
