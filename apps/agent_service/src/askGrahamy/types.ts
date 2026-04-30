import { z } from "zod";

export const INTENTS = [
  "stock",
  "sector",
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

export type Classification = {
  intent: Intent;
  symbols: string[];
  sectors: string[];
  regimeRequested: boolean;
  isFollowUp: boolean;
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

export type CachedResearchObject = {
  cacheKey: string;
  objectType: "stock" | "sector" | "regime";
  anchor: string;
  asOfDate: string;
  generatedAt: string;
  source: ResearchObjectSource;
  publicSummary: Record<string, unknown>;
  parts: Record<string, unknown>;
  freshness: FreshnessMetadata;
  warnings: string[];
};

export type PublicResearchView = {
  objectType: "stock" | "sector" | "regime" | "mixed";
  headline: Record<string, unknown>;
  marketContext: MarketContext;
  stockContext: StockResearchContext;
  sectorContext: SectorLandscape;
  researchObjects: CachedResearchObject[];
  researchObjectKeys: string[];
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
  researchObjects: [],
  researchObjectKeys: [],
  evidence: {},
  freshness: {},
  warnings: [],
};

// Empty by design — the disclaimer was removed per product decision. Kept
// as an exported constant so consumers (graph.ts, answerTemplates.ts) keep
// compiling; SS-side `formatAskGrahamyAnswer` skips appending when empty.
export const DEFAULT_DISCLAIMER = "";
