import { z } from "zod";
import type {
  AnalystBrief,
  EvidencePack,
  WorkflowExecutionResult,
} from "./analystTypes";

export const INTENTS = [
  "stock",
  "sector",
  "industry",
  "sector_conviction_leaderboard",
  "sector_momentum_vs_conviction_divergence",
  "week_over_week_sector_delta",
  "stock_idea_discovery",
  "sector_leaders",
  "industry_leaders",
  "feature_screen",
  "factor_conditioned_backtest",
  "market_regime_historical_playbook",
  "regime",
  "stock_sector",
  "stock_regime",
  "sector_regime",
  "stock_sector_regime",
  "platform_help",
  "follow_up",
  "unknown",
] as const;

/**
 * Sub-discriminator on `platform_help` turns. Tells the help node which
 * deterministic answer to render — full sector list, full industry list
 * grouped by sector, capability inventory, or platform overview. Free-form
 * help questions without a clear sub-target default to "overview".
 */
export const HELP_TOPICS = [
  "sectors",
  "industries",
  "capabilities",
  "overview",
] as const;
export type HelpTopic = (typeof HELP_TOPICS)[number];

export const ANSWER_TYPES = [
  "stock",
  "sector",
  "regime",
  "mixed",
  "clarification",
  "error",
  "help",
  "unknown",
] as const;

export const TOOL_NAMES = [
  "get_market_context",
  "get_stock_snapshot_context",
  "get_sector_snapshot_context",
  "get_industry_snapshot_context",
  "get_homepage_focus_context",
] as const;

// The main ask endpoint requires a classifier-produced envelope. Cache-hit
// records are still trusted passthrough payloads from StocksScanner.
const passthroughRecord = z.object({}).passthrough();
const classificationRecord = z
  .object({
    intent: z.enum(INTENTS),
    symbols: z.array(z.string()),
    sectors: z.array(z.string()),
    // Optional for back-compat — older StocksScanner clients haven't yet
    // started persisting industries on the classification envelope. Defaults
    // to [] so downstream code can read it unconditionally.
    industries: z.array(z.string()).default([]),
    regimeRequested: z.boolean(),
    isFollowUp: z.boolean(),
    requiresTools: z.array(z.enum(TOOL_NAMES)),
    confidence: z.enum(["high", "medium", "low"]),
    warnings: z.array(z.string()),
  })
  .passthrough();

export const askGrahamyRequestSchema = z.object({
  userId: z.string().trim().min(1),
  conversationId: z.string().trim().min(1).optional().nullable(),
  message: z.string().trim().min(1).max(4000),
  /**
   * Required. The caller has already classified the message via
   * `POST /api/ask-grahamy/classify` and supplies the result here.
   * The main graph does not run classification.
   */
  classification: classificationRecord,
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
   * week_over_week_sector_delta, stock_idea_discovery, feature_screen, etc.).
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
      lastIndustries: z.array(z.string()).default([]),
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
export type ClassificationFocus = "risk" | "validated_evidence";
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

export type FactorBacktestFactor =
  | "valuation"
  | "quality"
  | "momentum"
  | "growth"
  | "leverage"
  | "sector";

export type FactorBacktestHorizon =
  | "20-day"
  | "40-day"
  | "60-day"
  | "120-day"
  | "252-day";

export type FactorBacktestCriterion = {
  factor: FactorBacktestFactor;
  bucket: string;
};

export type FactorBacktestClassification = {
  criteria: FactorBacktestCriterion[];
  horizon?: FactorBacktestHorizon;
  unsupportedHorizon?: string;
  unsupportedCriteria?: string[];
  notes?: string[];
};

export type Classification = {
  intent: Intent;
  symbols: string[];
  sectors: string[];
  industries: string[];
  regimeRequested: boolean;
  isFollowUp: boolean;
  focus?: ClassificationFocus;
  featureCriteria?: FeatureScreenCriterion[];
  factorBacktest?: FactorBacktestClassification;
  /**
   * Names a compound multi-step research workflow when the user is asking a
   * question that needs the output of one PG capability fed as a parameter
   * into the next (e.g. "leading sectors in the current regime → screen the
   * stocks IN those sectors"). When set, the research planner skips its own
   * LLM plan-proposal and runs the named workflow directly. Most turns leave
   * this undefined — single-capability questions don't need a workflow.
   *
   * Replaces the old keyword-regex `detectResearchWorkflowIntent` + planner
   * LLM call with a single classifier-side decision.
   */
  compoundWorkflow?: CompoundResearchWorkflowName;
  /**
   * Set ONLY when `intent === "platform_help"`. Discriminates between the
   * four deterministic help-topic responses the platform_help node renders.
   * Defaults to "overview" if the LLM picks platform_help without a topic.
   */
  helpTopic?: HelpTopic;
  requiresTools: ToolName[];
  confidence: Confidence;
  warnings: string[];
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
  lastIndustries: string[];
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

/**
 * Lightweight pre-RO snapshot for industries. The daily_brief snapshot
 * doesn't attribute stocks to industries (only sectors), so the snapshot
 * tool here returns mostly the requested industry list with whatever sector
 * mapping it can derive — substantive industry detail (member counts, PE,
 * forward base rates, top members) lives on the industry research object
 * built from `query_v6a_industry_live.sql`.
 */
export type IndustryLandscape = {
  industries: Array<{
    industry: string;
    /** Optional parent sector when known from prior context or the RO. */
    parentSector?: string;
    /** Whether the industry RO has been (or will be) attached this turn. */
    researchObjectAttached: boolean;
  }>;
  missingIndustries: string[];
};

export type HomepageFocusContext = {
  focusSymbols: string[];
  focusSectors: string[];
};

export type ToolOutputs = Partial<{
  get_market_context: MarketContext;
  get_stock_snapshot_context: StockResearchContext;
  get_sector_snapshot_context: SectorLandscape;
  get_industry_snapshot_context: IndustryLandscape;
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
  /** Cache key of the sector Research Object that carries the deep payload
   * for this row. Resolves via the shared research-object cache so the
   * discovery answer and any anchored answer for the same sector see the
   * exact same data. */
  researchObjectKey: string;
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
  /** All sector Research Object cache keys this view points at (deduplicated,
   * row order). Reader resolves via the shared research-object cache. */
  researchObjectKeys: string[];
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
  researchObjectKey: string;
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
  researchObjectKeys: string[];
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
  researchObjectKey: string;
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
  researchObjectKeys: string[];
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
  researchObjectKey: string;
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
  researchObjectKeys: string[];
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
  researchObjectKey: string;
};

export type FeatureScreenView = {
  viewSchemaVersion: number;
  state: EvidenceState;
  source: "pg_current_features";
  asOfDate?: string;
  screenCriteria: FeatureScreenCriterion[];
  rows: FeatureScreenRowView[];
  researchObjectKeys: string[];
  freshness: PublicFreshnessView;
  warnings: string[];
};

export type FactorBacktestView = {
  viewSchemaVersion: number;
  state: EvidenceState;
  source: "pg_factor_history";
  horizon: FactorBacktestHorizon;
  criteria: FactorBacktestCriterion[];
  sampleSize?: number;
  hitRatePct?: number;
  medianReturnPct?: number;
  p25ReturnPct?: number;
  p75ReturnPct?: number;
  sampleAdequacy?: "ROBUST" | "ADEQUATE" | "THIN" | "UNKNOWN";
  /** Cache keys for the most-recent contributing-sample stock Research
   * Objects (capped to a small N). Resolves via the shared research-object
   * cache so the aggregate answer can show the same depth as anchored ones. */
  contributingResearchObjectKeys: string[];
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
  researchObjectKey: string;
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
  /** Sector Research Object keys for the rows above (deduplicated, row order). */
  researchObjectKeys: string[];
  /** Regime Research Object key for the regime header (typically "REGIME:MARKET:<asOfDate>"). */
  regimeResearchObjectKey?: string;
  freshness: PublicFreshnessView;
  warnings: string[];
};

export type ValidatedEdgeEvidenceState =
  | "edge_evidence_strong"
  | "edge_evidence_present"
  | "mixed"
  | "insufficient_data"
  | "unavailable";

export type LiveConfirmationBucket =
  | "confirmed"
  | "mixed"
  | "not_confirmed"
  | "deteriorating"
  | "insufficient_live_data";

export type DecayRiskBucket =
  | "no_recent_decay_warning"
  | "watch"
  | "decay_elevated"
  | "insufficient_decay_data";

export type ValidatedEdgeEvidenceAnchorView = {
  type: "stock" | "sector" | "regime";
  symbol?: string;
  sector?: string;
  regime?: string;
  label?: string;
};

export type ValidatedEdgeEvidenceHorizonView = {
  horizon: string;
  hitRatePct?: number;
  alphaBucket?: string;
  evidenceStrength?: string;
};

export type ValidatedEdgeEvidenceView = {
  viewSchemaVersion: number;
  state: EvidenceState;
  source: "client_api_research_object";
  anchor: ValidatedEdgeEvidenceAnchorView;
  evidenceState?: ValidatedEdgeEvidenceState;
  edgeCountBucket?: string;
  eventSampleBucket?: string;
  horizonEvidence?: ValidatedEdgeEvidenceHorizonView[];
  baseRateSummary?: {
    sampleAdequacy?: string;
    hitRatePct?: number;
    medianReturnPct?: number;
  };
  pipelineRiskBand?: string;
  liveConfirmationBucket?: LiveConfirmationBucket;
  decayRiskBucket?: DecayRiskBucket;
  interpretationBullets: string[];
  freshness: PublicFreshnessView;
  warnings: string[];
};

export type PgCapabilityViews = {
  sectorLeaderboardView?: SectorLeaderboardView;
  sectorDivergenceView?: SectorDivergenceView;
  sectorDeltaView?: SectorDeltaView;
  stockIdeaView?: StockIdeaView;
  featureScreenView?: FeatureScreenView;
  factorBacktestView?: FactorBacktestView;
  regimeHistoricalPlaybookView?: RegimeHistoricalPlaybookView;
};

export type PipelineOverlayViews = {
  validatedEdgeEvidenceView?: ValidatedEdgeEvidenceView;
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
  objectType: "stock" | "sector" | "industry" | "regime";
  anchor: string;
  asOfDate: string;
  title?: string;
  /**
   * Stock-only: the canonical sector this stock belongs to (from
   * md_symbols.sector via the core query's `meta.sector`). Surfaced as a
   * first-class field on the view so the deep agent can suggest natural
   * sector-comparison follow-ups ("how does X compare to other stocks in
   * <sector>?") without having to infer it from prose.
   */
  sector?: string;
  /**
   * Stock-only: the Yahoo industry this stock belongs to (from
   * md_symbols.industry via the core query's `meta.industry`). Same purpose
   * as `sector` but at the finer industry granularity.
   */
  industry?: string;
  fiveQuestion: FiveQuestionCoverage;
  edgeEvidence: EdgeEvidenceView;
  probabilisticEvidence: ProbabilisticEvidenceView;
  pathRisk: PathRiskView;
  freshness: FreshnessMetadata;
  warnings: string[];
};

export type CachedResearchObject = {
  cacheKey: string;
  objectType: "stock" | "sector" | "industry" | "regime";
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
  objectType: "stock" | "sector" | "industry" | "regime" | "mixed";
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
  factorBacktestView?: FactorBacktestView;
  regimeHistoricalPlaybookView?: RegimeHistoricalPlaybookView;
  validatedEdgeEvidenceView?: ValidatedEdgeEvidenceView;
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

export type CompoundResearchWorkflowName =
  | "regime_to_stock_screen"
  | "sector_delta_to_stock_screen"
  | "sector_divergence_to_stock_screen"
  | "feature_screen_plus_backtest"
  | "stock_deep_dive_stack"
  | "idea_to_compare_and_risk";

export type CompoundResearchContext = {
  workflowName: CompoundResearchWorkflowName;
  /**
   * Backward-compatible marker for the first shipped compound path. Internal
   * only; never serialized into public research_view/history.
   */
  planType?: "regime_sector_to_stock_screen" | "approved_multi_step_workflow";
  leadingSectors?: string[];
  selectedSectors?: string[];
  selectedSymbol?: string;
  featureScreenCriteria?: FeatureScreenCriterion[];
  candidatePipelineLabels?: Record<string, string>;
  warnings: string[];
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
  pipelineOverlayViews?: PipelineOverlayViews;
  /**
   * Internal public-safe summary for compound research answer synthesis.
   * It is not part of AskGrahamyResponse and must not be persisted as
   * research_view. It contains no ResearchPlan, raw rows, SQL, or internals.
   */
  compoundResearchContext?: CompoundResearchContext;
  /**
   * Internal normalized result from approved multi-step workflow execution.
   * Built only from public-safe views and never serialized to browser/history.
   */
  workflowExecutionResult?: WorkflowExecutionResult;
  /**
   * Internal analyst orchestration layer. Built only from public-safe views
   * and used to guide answer synthesis; not exposed as a customer payload in
   * Phase 1.
   */
  evidencePack?: EvidencePack;
  analystBrief?: AnalystBrief;
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
  industries: [],
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
