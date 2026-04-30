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

export const askGrahamyRequestSchema = z.object({
  userId: z.string().trim().min(1),
  conversationId: z.string().trim().min(1).optional().nullable(),
  message: z.string().trim().min(1).max(4000),
});

export type AskGrahamyRequest = z.infer<typeof askGrahamyRequestSchema>;

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
  userId: string;
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
  upstreamLatency?: Partial<Record<SnapshotName, number>>;
  moatGuardResult?: "clean" | "cleaned" | "failed";
};

export type AskGrahamyState = {
  userId: string;
  conversationId?: string;
  message: string;
  messageId?: string;
  previousContext?: ConversationContext;
  classification?: Classification;
  snapshots?: SnapshotBundle;
  selectedTools?: ToolName[];
  toolOutputs?: ToolOutputs;
  researchObjects?: CachedResearchObject[];
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

export const DEFAULT_DISCLAIMER = "This is not financial advice.";
