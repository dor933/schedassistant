import { z } from "zod";

export const INTENTS = [
  "stock",
  "sector",
  "sector_conviction_leaderboard",
  "sector_momentum_vs_conviction_divergence",
  "week_over_week_sector_delta",
  "stock_idea_discovery",
  "feature_screen",
  "comparison",
  "market_regime_historical_playbook",
  "regime",
  "stock_sector",
  "stock_regime",
  "sector_regime",
  "stock_sector_regime",
  "follow_up",
  "unknown",
] as const;

export const ANSWER_TYPES = [
  "stock",
  "sector",
  "regime",
  "mixed",
  "clarification",
  "error",
  "unknown",
] as const;

export const TOOL_NAMES = [
  "get_market_context",
  "get_stock_snapshot_context",
  "get_sector_snapshot_context",
  "get_homepage_focus_context",
] as const;

// Classification + priorResearchObjects are passthrough records — the
// upstream caller (StocksScanner) is trusted (auth'd via the application
// token), and the structured-output classifier and our own DB shape have
// already validated these. We re-cast on the consumer side.
const passthroughRecord = z.object({}).passthrough();

export const askGrahamyRequestSchema = z.object({
  userId: z.string().trim().min(1),
  conversationId: z.string().trim().min(1).optional().nullable(),
  message: z.string().trim().min(1).max(4000),
  /**
   * Optional. When the caller has already classified the message via
   * `POST /api/ask-grahamy/classify`, it supplies the result here so we
   * skip the LLM classify call. Absent → agent_service classifies internally.
   */
  classification: passthroughRecord.optional(),
  /**
   * Optional. Existing research objects the caller already has cached for
   * the classified anchors. agent_service uses these when cache_key matches
   * a classified key, and only builds (via v6 SQL) what the caller didn't
   * supply. Absent or empty → every classified key is built from scratch.
   */
  priorResearchObjects: z.array(passthroughRecord).optional(),
  /**
   * Optional. Existing pgCapability views the caller has cached for the
   * classified intent (sector_conviction_leaderboard, sector_divergence,
   * week_over_week_sector_delta, stock_idea_discovery, stock_vs_sector_comparison).
   * agent_service skips the corresponding SQL when `cache_key` matches.
   * Mirrors `priorResearchObjects` for the non-`stock_sector_regime` intents.
   */
  priorCapabilityViews: z.array(passthroughRecord).optional(),
});

export type AskGrahamyRequest = z.infer<typeof askGrahamyRequestSchema>;

export const askGrahamyClassifyRequestSchema = z.object({
  userId: z.string().trim().min(1),
  conversationId: z.string().trim().min(1).optional().nullable(),
  message: z.string().trim().min(1).max(4000),
  /**
   * Optional. The caller (StocksScanner) extracts the prior assistant
   * message's anchors from `ask_messages.research_object_keys` + `intent`
   * and passes them here so the classifier can resolve context-dependent
   * follow-ups like "compare to peers", "why?", "what about its sector".
   * Without this, those messages classify as `unknown` and no priors get
   * fetched — answer quality degrades.
   */
  previousContext: z
    .object({
      lastSymbols: z.array(z.string()).default([]),
      lastSectors: z.array(z.string()).default([]),
      lastRegimeRequested: z.boolean().optional(),
      lastIntent: z.string().optional(),
    })
    .optional(),
});

export type AskGrahamyClassifyRequest = z.infer<typeof askGrahamyClassifyRequestSchema>;

export type AskGrahamyClassifyResponse = {
  conversationId: string;
  classification: Classification;
};

export type Intent = (typeof INTENTS)[number];
export type AnswerType = (typeof ANSWER_TYPES)[number];
export type Confidence = "high" | "medium" | "low";
export type ToolName = (typeof TOOL_NAMES)[number];
export type ClassificationFocus = "risk";
export type FeatureScreenFactor =
  | "valuation"
  | "quality"
  | "momentum"
  | "growth"
  | "leverage"
  | "sector"
  | "risk";

export type FeatureScreenCriterion = {
  factor: FeatureScreenFactor;
  bucket: string;
};

export type Classification = {
  intent: Intent;
  symbols: string[];
  sectors: string[];
  regimeRequested: boolean;
  isFollowUp: boolean;
  focus?: ClassificationFocus;
  featureCriteria?: FeatureScreenCriterion[];
  comparison?: ComparisonClassification;
  requiresTools: ToolName[];
  confidence: Confidence;
  warnings: string[];
};

export type ComparisonAnchor =
  | {
      type: "stock";
      symbol: string;
    }
  | {
      type: "sector";
      sector?: string;
    }
  | {
      type: "implicit_stock_sector";
      sector?: string;
    };

export type ComparisonClassification =
  | {
      comparisonType: "stock_vs_sector";
      left: Extract<ComparisonAnchor, { type: "stock" }>;
      right:
        | Extract<ComparisonAnchor, { type: "sector" }>
        | Extract<ComparisonAnchor, { type: "implicit_stock_sector" }>;
    }
  | {
      comparisonType: "sector_vs_sector";
      left: Extract<ComparisonAnchor, { type: "sector" }>;
      right: Extract<ComparisonAnchor, { type: "sector" }>;
    }
  | {
      comparisonType: "symbol_vs_symbol";
      left: Extract<ComparisonAnchor, { type: "stock" }>;
      right: Extract<ComparisonAnchor, { type: "stock" }>;
    };

export type SnapshotName =
  | "daily_brief"
  | "metadata"
  | "clusters"
  | "track_record"
  | "transparency";

export type SnapshotBundle = Partial<Record<SnapshotName, unknown>> & {
  errors?: Partial<Record<SnapshotName, string>>;
  freshness?: FreshnessMetadata;
  latencyMs?: Partial<Record<SnapshotName, number>>;
};

export type FreshnessMetadata = {
  generatedAt?: string;
  dataThrough?: string;
  pipelineStatus?: string;
  dataFreshness?: string;
  stale?: boolean;
  staleReason?: string;
};

export type PublicFreshnessView = {
  dataThrough?: string;
  state?: "fresh" | "stale" | "unknown";
  warning?: string;
};

export type ConversationContext = {
  conversationId: string;
  /**
   * Internal `users.id` of the conversation owner. Resolved at the HTTP
   * boundary via `resolveOrCreateClientUser` from the upstream client app's
   * external user id; never the raw external value.
   */
  userId: number;
  lastSymbols: string[];
  lastSectors: string[];
  lastIntent?: Intent;
  lastPublicResearchSummary?: string;
  lastSuggestedFollowups: string[];
  updatedAt: string;
};

export type MarketContext = {
  regime?: string;
  vix?: number;
  vixDate?: string;
  activeEdges?: number;
  stocksWithConvergence?: number;
  forwardWinRateBucket?: string;
  pipelineStatus?: string;
  methodologySummary?: string;
};

export type StockResearchContext = {
  symbols: Array<{
    symbol: string;
    company?: string;
    sector?: string;
    convergenceScore?: number;
    confluenceLevel?: string;
    evidenceCount?: number;
    notableEvents?: Array<{
      date?: string;
      eventType?: string;
      description?: string;
      impactBucket?: string;
      confidence?: number;
    }>;
    completedSignalCount?: number;
    completedWinRateBucket?: string;
  }>;
  missingSymbols: string[];
};

export type SectorLandscape = {
  sectors: Array<{
    sector: string;
    stocksInFocus: number;
    exampleSymbols: string[];
    convergenceScoreTotal?: number;
    completedSignalCount?: number;
    completedWinRateBucket?: string;
  }>;
  missingSectors: string[];
};

export type HomepageFocusContext = {
  focusSymbols: string[];
  focusSectors: string[];
};

export type ToolOutputs = Partial<{
  get_market_context: MarketContext;
  get_stock_snapshot_context: StockResearchContext;
  get_sector_snapshot_context: SectorLandscape;
  get_homepage_focus_context: HomepageFocusContext;
}>;

export type ResearchObjectSource = "redis" | "database" | "snapshot";

export type EvidenceState = "complete" | "partial" | "unavailable";

export const PUBLIC_RESEARCH_VIEW_SCHEMA_VERSION = 2;

export type ProbabilisticReferenceSet =
  | "self_analogs"
  | "sector_conditioned_analogs"
  | "aggregate_base_rate";

export type EvidenceClaim = {
  text: string;
  classification?: string;
  family?: string;
  source?: string;
};

export type EdgeEvidenceView = {
  state: EvidenceState;
  source: "validated_pipeline" | "snapshot_proxy" | "unavailable";
  claims: EvidenceClaim[];
  convergence?: {
    label?: string;
    familyCountBucket?: string;
  };
  rollingForwardValidation?: EvidenceClaim[];
  decayState?: string;
  sectorSignalDensity?: string;
  warnings: string[];
};

export type ProbabilisticEvidenceView = {
  viewSchemaVersion: number;
  state: EvidenceState;
  horizon: "60-day" | "252-day";
  referenceSet?: ProbabilisticReferenceSet;
  sampleSize?: number;
  hitRatePct?: number;
  medianReturnPct?: number;
  p25ReturnPct?: number;
  p75ReturnPct?: number;
  sampleAdequacy?: string;
  hitRateBucket?: string;
  medianOutcomeBucket?: string;
  downsideQuartileBucket?: string;
  upsideQuartileBucket?: string;
  conditionedHitRateBucket?: string;
  conditionedOutcomeBucket?: string;
  notes: string[];
};

export type PathRiskView = {
  viewSchemaVersion: number;
  state: EvidenceState;
  horizon: "60-day";
  source?: "pg_daily_price_path" | "analog_return_distribution" | "unavailable";
  sampleSize?: number;
  observedPathCount?: number;
  sampleAdequacy?: string;
  p10MaxDrawdownPct?: number;
  worstMaxDrawdownPct?: number;
  probDrawdownGt5Pct?: number;
  probDrawdownGt10Pct?: number;
  probDrawdownGt15Pct?: number;
  probDrawdownGt20Pct?: number;
  recoveredByHorizonRatePct?: number;
  lossProbabilityBucket?: string;
  severeLossProbabilityBucket?: string;
  downsideTailBucket?: string;
  adverseExcursionBucket?: string;
  maxDrawdownBucket?: string;
  recoveryProfile?: string;
  validatedEvidence?: {
    edgeSpecificPathRisk: EvidenceState;
    sentinelRealizedDrawdown: EvidenceState;
    coronerDecay: EvidenceState;
  };
  warnings?: string[];
  notes: string[];
};

export type SectorLeaderboardRowView = {
  sector: string;
  rank: number;
  convictionScorePct?: number;
  convictionBucket?: string;
  evidenceStrength?: string;
  medianForwardReturnPct?: number;
  hitRatePct?: number;
  momentumBucket?: string;
  priceMomentumSeparation?: string;
  defensiveCyclicalLabel?: string;
};

export type SectorLeaderboardView = {
  viewSchemaVersion: number;
  state: EvidenceState;
  source:
    | "pg_sector_peer_daily"
    | "pg_sector_regime_forward_agg"
    | "pg_sector_analog_bucket";
  period: "latest" | "this_week";
  rankingBasis: "conviction" | "historical_forward" | "divergence";
  asOfDate?: string;
  rows: SectorLeaderboardRowView[];
  freshness: PublicFreshnessView;
  warnings: string[];
};

export type SectorDivergenceRowView = {
  sector: string;
  rank: number;
  convictionScorePct?: number;
  convictionBucket?: string;
  momentumScorePct?: number;
  momentumBucket?: string;
  divergenceType?: string;
  hitRatePct?: number;
  medianForwardReturnPct?: number;
  evidenceStrength?: string;
  interpretationBullets: string[];
};

export type SectorDivergenceView = {
  viewSchemaVersion: number;
  state: EvidenceState;
  source: "pg_sector_peer_daily";
  period: "latest";
  asOfDate?: string;
  evaluatedSectorCount?: number;
  clearDivergenceCount?: number;
  rows: SectorDivergenceRowView[];
  freshness: PublicFreshnessView;
  warnings: string[];
};

export type SectorDeltaRankingBasis =
  | "conviction_delta"
  | "momentum_delta"
  | "deterioration"
  | "overall_change";

export type SectorDeltaDirection = "improved" | "deteriorated" | "flat";

export type SectorDeltaRowView = {
  sector: string;
  rank: number;
  currentConvictionScorePct?: number;
  priorConvictionScorePct?: number;
  convictionDeltaPct?: number;
  currentConvictionBucket?: string;
  priorConvictionBucket?: string;
  currentMomentumBucket?: string;
  priorMomentumBucket?: string;
  momentumDeltaPct?: number;
  direction: SectorDeltaDirection;
  interpretationBullets: string[];
};

export type SectorDeltaView = {
  viewSchemaVersion: number;
  state: EvidenceState;
  source: "pg_sector_weekly_history";
  period: "week_over_week";
  currentAsOfDate?: string;
  priorAsOfDate?: string;
  rankingBasis: SectorDeltaRankingBasis;
  rows: SectorDeltaRowView[];
  freshness: PublicFreshnessView;
  warnings: string[];
};

export type StockIdeaRowView = {
  symbol: string;
  companyName?: string;
  sector?: string;
  rank: number;
  convictionScorePct?: number;
  convictionBucket?: string;
  evidenceStrength?: string;
  hitRatePct?: number;
  medianReturnPct?: number;
  p25ReturnPct?: number;
  p75ReturnPct?: number;
  momentumBucket?: string;
  qualityBucket?: string;
  valuationBucket?: string;
  pathRiskBucket?: string;
  p10MaxDrawdownPct?: number;
  recoveredByHorizonRatePct?: number;
  reasonBullets: string[];
};

export type StockIdeaView = {
  viewSchemaVersion: number;
  state: EvidenceState;
  source: "pg_features_daily";
  asOfDate?: string;
  rankingBasis:
    | "setup_quality"
    | "conviction"
    | "historical_forward"
    | "risk_adjusted";
  rows: StockIdeaRowView[];
  freshness: PublicFreshnessView;
  warnings: string[];
};

export type FeatureScreenRowView = {
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
  reasonBullets: string[];
};

export type FeatureScreenView = {
  viewSchemaVersion: number;
  state: EvidenceState;
  source: "pg_current_features";
  asOfDate?: string;
  screenCriteria: FeatureScreenCriterion[];
  rows: FeatureScreenRowView[];
  freshness: PublicFreshnessView;
  warnings: string[];
};

export type ComparisonSideMetrics = {
  convictionScorePct?: number;
  convictionBucket?: string;
  valuationBucket?: string;
  momentumBucket?: string;
  qualityBucket?: string;
  growthBucket?: string;
  leverageBucket?: string;
  hitRatePct?: number;
  medianReturnPct?: number;
  pathRiskBucket?: string;
};

export type ComparisonSideView = {
  type: "stock" | "sector";
  label: string;
  symbol?: string;
  sector?: string;
  metrics: ComparisonSideMetrics;
};

export type ComparisonDeltaMetric =
  | "conviction"
  | "valuation"
  | "momentum"
  | "quality"
  | "growth"
  | "leverage"
  | "historical_forward"
  | "path_risk";

export type ComparisonDeltaView = {
  metric: ComparisonDeltaMetric;
  leftValue?: number | string;
  rightValue?: number | string;
  delta?: number;
  interpretationBucket: "left_stronger" | "right_stronger" | "similar" | "mixed";
  explanation: string;
};

export type ComparisonView = {
  viewSchemaVersion: number;
  state: EvidenceState;
  comparisonType: "stock_vs_sector" | "sector_vs_sector" | "symbol_vs_symbol";
  source: "pg_current_features" | "pg_sector_peer_daily";
  asOfDate?: string;
  left: ComparisonSideView;
  right: ComparisonSideView;
  deltas: ComparisonDeltaView[];
  summaryBullets: string[];
  freshness: PublicFreshnessView;
  warnings: string[];
};

export type RegimeHistoricalPlaybookRole = "leader" | "laggard" | "mixed";

export type RegimeHistoricalPlaybookRowView = {
  sector: string;
  rank: number;
  role: RegimeHistoricalPlaybookRole;
  hitRatePct?: number;
  medianForwardReturnPct?: number;
  evidenceStrength?: string;
  interpretationBullets: string[];
};

export type RegimeHistoricalPlaybookRiskView = {
  riskLabel: string;
  riskBucket?: string;
  interpretation: string;
};

export type RegimeHistoricalPlaybookView = {
  viewSchemaVersion: number;
  state: EvidenceState;
  source: "pg_regime_history";
  regime?: string;
  asOfDate?: string;
  rows: RegimeHistoricalPlaybookRowView[];
  risks: RegimeHistoricalPlaybookRiskView[];
  summaryBullets: string[];
  freshness: PublicFreshnessView;
  warnings: string[];
};

export type PgCapabilityViews = {
  sectorLeaderboardView?: SectorLeaderboardView;
  sectorDivergenceView?: SectorDivergenceView;
  sectorDeltaView?: SectorDeltaView;
  stockIdeaView?: StockIdeaView;
  featureScreenView?: FeatureScreenView;
  comparisonView?: ComparisonView;
  regimeHistoricalPlaybookView?: RegimeHistoricalPlaybookView;
};

export type FiveQuestionCoverage = {
  whatMattersNow: string[];
  whyNow?: string;
  historicalAnalogs: string[];
  underWhichConditions: string[];
  invalidation: string[];
};

export type PublicResearchObjectView = {
  viewSchemaVersion: number;
  cacheKey: string;
  objectType: "stock" | "sector" | "regime";
  anchor: string;
  asOfDate: string;
  title?: string;
  fiveQuestion: FiveQuestionCoverage;
  edgeEvidence: EdgeEvidenceView;
  probabilisticEvidence: ProbabilisticEvidenceView;
  pathRisk: PathRiskView;
  freshness: FreshnessMetadata;
  warnings: string[];
};

export type CachedResearchObject = {
  cacheKey: string;
  objectType: "stock" | "sector" | "regime";
  anchor: string;
  asOfDate: string;
  generatedAt: string;
  source: ResearchObjectSource;
  publicSummary: Record<string, unknown>;
  parts: Record<string, unknown>;
  view?: PublicResearchObjectView;
  freshness: FreshnessMetadata;
  warnings: string[];
};

/**
 * Re-export of the pgCapability cache shape so consumers (graph state,
 * response meta, upstream caller types) live in one place. Definition
 * itself sits next to the registry that produces it.
 */
export type { CachedCapabilityView } from "./pgCapabilities/types";

export type PublicResearchView = {
  objectType: "stock" | "sector" | "regime" | "mixed";
  headline: Record<string, unknown>;
  marketContext: MarketContext;
  stockContext: StockResearchContext;
  sectorContext: SectorLandscape;
  researchObjectViews: PublicResearchObjectView[];
  researchObjectKeys: string[];
  probabilisticEvidence: Record<string, ProbabilisticEvidenceView>;
  pathRisk: Record<string, PathRiskView>;
  edgeEvidence: Record<string, EdgeEvidenceView>;
  sectorLeaderboardView?: SectorLeaderboardView;
  sectorDivergenceView?: SectorDivergenceView;
  sectorDeltaView?: SectorDeltaView;
  stockIdeaView?: StockIdeaView;
  featureScreenView?: FeatureScreenView;
  comparisonView?: ComparisonView;
  regimeHistoricalPlaybookView?: RegimeHistoricalPlaybookView;
  evidence: Record<string, unknown>;
  freshness: FreshnessMetadata;
  warnings: string[];
};

export type AnswerObject = {
  headline: string;
  summary: string;
  bullets: string[];
  watchpoints: string[];
  disclaimer: string;
};

export type UiHints = {
  cards: unknown[];
  tables: unknown[];
  suggestedFollowups: string[];
};

export type ResponseMeta = {
  sourcesUsed: Array<{ type: "snapshot" | "research"; name: string }>;
  freshness: FreshnessMetadata;
  warnings: string[];
  toolsUsed: ToolName[];
  researchObjectKeys?: string[];
  researchObjectCache?: {
    hits: number;
    misses: number;
    writes: number;
  };
  /**
   * Subset of research objects that were freshly built this turn (cache
   * misses where agent_service ran the v6 SQL and bucketed the result in
   * memory). agent_service does NOT persist these; the upstream client
   * (StocksScanner) is responsible for writing them to its `research_objects`
   * table + Redis after receiving the response. Empty when every key was a
   * cache hit.
   */
  researchObjectsUpdated?: CachedResearchObject[];
  /** Cache-key listing for this turn's pgCapability view (max one per turn). */
  capabilityViewKeys?: string[];
  capabilityViewCache?: {
    hits: number;
    misses: number;
    writes: number;
  };
  /**
   * Subset of capability views freshly built this turn (cache miss). The
   * upstream client persists them in its `cached_capability_views` table for
   * reuse on future turns within the same `as_of_date`. Empty when the
   * intent had no capability or the call was a cache hit.
   */
  capabilityViewsUpdated?: import("./pgCapabilities/types").CachedCapabilityView[];
  upstreamLatency?: Partial<Record<SnapshotName, number>>;
  moatGuardResult?: "clean" | "cleaned" | "failed";
};

export type AskGrahamyState = {
  /**
   * Internal `users.id` (resolved at the HTTP boundary). Anchors conversation
   * lookup, persistence, and downstream FKs. Never the raw external id.
   */
  internalUserId: number;
  conversationId?: string;
  message: string;
  messageId?: string;
  previousContext?: ConversationContext;
  classification?: Classification;
  snapshots?: SnapshotBundle;
  selectedTools?: ToolName[];
  toolOutputs?: ToolOutputs;
  /**
   * Research objects supplied by the upstream caller (StocksScanner), one
   * per anchor it already had in its `research_objects` table for the
   * current asOfDate. Used as the "is it cached?" check during build —
   * keys present here are reused as-is; missing keys are built from v6 SQL.
   */
  priorResearchObjects?: CachedResearchObject[];
  researchObjects?: CachedResearchObject[];
  /** Subset of `researchObjects` that need persistence by the upstream caller —
   * either freshly built this turn or augmented with new fields. Cache hits
   * (used as-is from priorResearchObjects) are NOT included. */
  researchObjectsUpdated?: CachedResearchObject[];
  researchObjectCacheStats?: {
    hits: number;
    misses: number;
    writes: number;
  };
  /**
   * pgCapability views supplied by the upstream caller (StocksScanner), each
   * keyed by `cache_key`. Used as the cache-hit lookup inside
   * `executePgCapabilitiesWithCache` exactly the way `priorResearchObjects`
   * is used by `buildResearchObjects`.
   */
  priorCapabilityViews?: import("./pgCapabilities/types").CachedCapabilityView[];
  pgCapabilityViews?: PgCapabilityViews;
  /**
   * Subset of capability views freshly built this turn (cache miss). The
   * upstream caller persists them after receiving the response. Empty when
   * the intent had no matching capability or the call was a cache hit.
   */
  capabilityViewsUpdated?: import("./pgCapabilities/types").CachedCapabilityView[];
  capabilityViewCacheStats?: {
    hits: number;
    misses: number;
    writes: number;
  };
  publicResearchView?: PublicResearchView;
  answer?: AnswerObject;
  ui?: UiHints;
  meta?: ResponseMeta;
  warnings: string[];
};

export type AskGrahamyResponse = {
  conversationId: string;
  messageId: string;
  answerType: AnswerType;
  classification: Classification;
  answer: AnswerObject;
  research: {
    publicResearchView: PublicResearchView | Record<string, never>;
  };
  ui: UiHints;
  meta: ResponseMeta;
};

export const EMPTY_CLASSIFICATION: Classification = {
  intent: "unknown",
  symbols: [],
  sectors: [],
  regimeRequested: false,
  isFollowUp: false,
  requiresTools: [],
  confidence: "low",
  warnings: [],
};

export const EMPTY_PUBLIC_RESEARCH_VIEW: PublicResearchView = {
  objectType: "mixed",
  headline: {},
  marketContext: {},
  stockContext: { symbols: [], missingSymbols: [] },
  sectorContext: { sectors: [], missingSectors: [] },
  researchObjectViews: [],
  researchObjectKeys: [],
  probabilisticEvidence: {},
  pathRisk: {},
  edgeEvidence: {},
  evidence: {},
  freshness: {},
  warnings: [],
};

// Empty by design — the disclaimer was removed per product decision. Kept
// as an exported constant so consumers (graph.ts, answerTemplates.ts) keep
// compiling; SS-side `formatAskGrahamyAnswer` skips appending when empty.
export const DEFAULT_DISCLAIMER = "";
