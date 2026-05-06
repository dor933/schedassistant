import test from "node:test";
import assert from "node:assert/strict";
import { runAskGrahamyGraph } from "../graph";
import type { ResearchPlan } from "../researchPlanner";
import type { Classification, PublicResearchView } from "../types";
import { buildWorkflowExecutionResult } from "../workflowExecution";
import type { AnalystBrief } from "../analystTypes";

const leaderboardClassification: Classification = {
  intent: "sector_conviction_leaderboard",
  symbols: [],
  sectors: [],
  regimeRequested: false,
  isFollowUp: false,
  requiresTools: ["get_market_context"],
  confidence: "high",
  warnings: [],
};

const stockIdeaClassification: Classification = {
  intent: "stock_idea_discovery",
  symbols: [],
  sectors: [],
  regimeRequested: false,
  isFollowUp: false,
  requiresTools: ["get_market_context"],
  confidence: "high",
  warnings: [],
};

const featureScreenClassification: Classification = {
  intent: "feature_screen",
  symbols: [],
  sectors: [],
  regimeRequested: false,
  isFollowUp: false,
  featureCriteria: [
    { factor: "valuation", bucket: "ATTRACTIVE" },
    { factor: "quality", bucket: "STRONG" },
  ],
  requiresTools: ["get_market_context"],
  confidence: "high",
  warnings: [],
};

const factorBacktestClassification: Classification = {
  intent: "factor_conditioned_backtest",
  symbols: [],
  sectors: [],
  regimeRequested: false,
  isFollowUp: false,
  factorBacktest: {
    horizon: "60-day",
    criteria: [
      { factor: "valuation", bucket: "ATTRACTIVE" },
      { factor: "quality", bucket: "STRONG" },
    ],
  },
  requiresTools: ["get_market_context"],
  confidence: "high",
  warnings: [],
};

const divergenceClassification: Classification = {
  intent: "sector_momentum_vs_conviction_divergence",
  symbols: [],
  sectors: [],
  regimeRequested: false,
  isFollowUp: false,
  requiresTools: ["get_market_context"],
  confidence: "high",
  warnings: [],
};

const sectorDeltaClassification: Classification = {
  intent: "week_over_week_sector_delta",
  symbols: [],
  sectors: [],
  regimeRequested: false,
  isFollowUp: false,
  requiresTools: ["get_market_context"],
  confidence: "high",
  warnings: [],
};

const comparisonClassification: Classification = {
  intent: "comparison",
  symbols: [],
  sectors: [],
  regimeRequested: false,
  isFollowUp: false,
  comparison: {
    comparisonType: "stock_vs_sector",
    left: { type: "stock", symbol: "GSL" },
    right: { type: "implicit_stock_sector" },
  },
  requiresTools: ["get_market_context"],
  confidence: "high",
  warnings: [],
};

const sectorComparisonClassification: Classification = {
  intent: "comparison",
  symbols: [],
  sectors: [],
  regimeRequested: false,
  isFollowUp: false,
  comparison: {
    comparisonType: "sector_vs_sector",
    left: { type: "sector", sector: "Technology" },
    right: { type: "sector", sector: "Industrials" },
  },
  requiresTools: ["get_market_context"],
  confidence: "high",
  warnings: [],
};

const symbolComparisonClassification: Classification = {
  intent: "comparison",
  symbols: [],
  sectors: [],
  regimeRequested: false,
  isFollowUp: false,
  comparison: {
    comparisonType: "symbol_vs_symbol",
    left: { type: "stock", symbol: "GSL" },
    right: { type: "stock", symbol: "DAC" },
  },
  requiresTools: ["get_market_context"],
  confidence: "high",
  warnings: [],
};

const regimePlaybookClassification: Classification = {
  intent: "market_regime_historical_playbook",
  symbols: [],
  sectors: [],
  regimeRequested: false,
  isFollowUp: false,
  requiresTools: ["get_market_context"],
  confidence: "high",
  warnings: [],
};

const compoundHebrewQuestion =
  "איזה סקטור נוטה להיות חזק במצב השוק הנוכחי ואיזה מניות היסטורית חזקות אני רוצה שתמצא לי משהו נוכחי שעונה על הצלחות חוזרות היסטוריות";

const compoundClassification: Classification = {
  intent: "market_regime_historical_playbook",
  symbols: [],
  sectors: [],
  regimeRequested: false,
  isFollowUp: false,
  requiresTools: ["get_market_context"],
  confidence: "high",
  warnings: [],
};

const validCompoundPlan: ResearchPlan = {
  planType: "multi_step",
  steps: [
    {
      id: "regime_context",
      capability: "market_regime_historical_playbook",
      purpose: "Identify historically leading sectors in the current regime.",
      params: {},
    },
    {
      id: "current_candidates",
      capability: "feature_screen",
      purpose: "Find current stock candidates inside leading sectors.",
      params: {},
      dependsOn: ["regime_context"],
      paramsFromPreviousSteps: {
        sectorConstraints: {
          stepId: "regime_context",
          sourcePath: "regimeHistoricalPlaybookView.rows[role=leader].sector",
          transform: "top_3_unique_sectors",
        },
      },
    },
    {
      id: "pipeline_check",
      capability: "validated_edge_evidence",
      purpose: "Qualify top public candidates with Pipeline evidence if available.",
      params: { topN: 3 },
      dependsOn: ["current_candidates"],
      paramsFromPreviousSteps: {
        symbols: {
          stepId: "current_candidates",
          sourcePath: "featureScreenView.rows.symbol",
          transform: "top_3_symbols",
        },
      },
      optional: true,
    },
  ],
  finalAnswerGoal: "ranked_research_candidates",
  expectedViews: [
    "regimeHistoricalPlaybookView",
    "featureScreenView",
    "validatedEdgeEvidenceView",
  ],
  safetyNotes: ["Use public views only", "Do not invent stocks"],
};

const validatedEvidenceClassification: Classification = {
  intent: "stock",
  symbols: ["GSL"],
  sectors: [],
  regimeRequested: false,
  isFollowUp: false,
  focus: "validated_evidence",
  requiresTools: ["get_stock_snapshot_context", "get_market_context"],
  confidence: "high",
  warnings: [],
};

const plainStockClassification: Classification = {
  intent: "stock",
  symbols: ["GSL"],
  sectors: [],
  regimeRequested: false,
  isFollowUp: false,
  requiresTools: ["get_stock_snapshot_context", "get_market_context"],
  confidence: "high",
  warnings: [],
};

test("graph loads validatedEdgeEvidenceView for validated evidence focus", async () => {
  const response = await runAskGrahamyGraph(
    {
      userId: "external-user-1",
      conversationId: "conversation-validated-evidence",
      message: "Is GSL evidence-backed?",
      classification: validatedEvidenceClassification,
      priorResearchObjects: [],
    },
    1,
    {
      snapshotClient: {
        fetchPublishedSnapshots: async () => ({
          daily_brief: { regime: "NEUTRAL" },
          freshness: { dataThrough: "2026-05-01" },
        }),
      } as any,
      pipelineOverlayRunner: async () => ({
        views: {
          validatedEdgeEvidenceView: {
            viewSchemaVersion: 1,
            state: "complete",
            source: "client_api_research_object",
            anchor: { type: "stock", symbol: "GSL", label: "GSL" },
            evidenceState: "edge_evidence_present",
            edgeCountBucket: "present",
            eventSampleBucket: "adequate",
            interpretationBullets: [
              "Validated pipeline evidence is present for GSL.",
            ],
            freshness: { dataThrough: "2026-05-01", state: "fresh" },
            warnings: [],
          },
        },
        warnings: [],
      }),
      grahamyAgentRunner: async (state) => {
        assert.equal(state.pipelineOverlayViews?.validatedEdgeEvidenceView?.anchor.symbol, "GSL");
        return {
          answerText: "Validated pipeline evidence is present for GSL.",
          suggestedFollowups: [],
          warnings: [],
        };
      },
    },
  );

  assert.equal(response.answerType, "stock");
  assert.deepEqual(response.meta.sourcesUsed.map((item) => item.name), [
    "validated_edge_evidence",
  ]);
  const publicView = response.research.publicResearchView as PublicResearchView;
  assert.equal(publicView.validatedEdgeEvidenceView?.anchor.symbol, "GSL");
  assert.equal(publicView.validatedEdgeEvidenceView?.evidenceState, "edge_evidence_present");
});

test("graph loads sectorLeaderboardView for leaderboard intent without Research Object anchors", async () => {
  const response = await runAskGrahamyGraph(
    {
      userId: "external-user-1",
      conversationId: "conversation-1",
      message: "Which sectors are leading on conviction this week?",
      classification: leaderboardClassification,
      priorResearchObjects: [],
    },
    1,
    {
      snapshotClient: {
        fetchPublishedSnapshots: async () => ({
          daily_brief: { regime: "NEUTRAL" },
          freshness: { dataThrough: "2026-05-01" },
        }),
      } as any,
      pgCapabilityRunner: async () => ({
        views: {
          sectorLeaderboardView: {
            viewSchemaVersion: 1,
            state: "complete",
            source: "pg_sector_peer_daily",
            period: "latest",
            rankingBasis: "conviction",
            asOfDate: "2026-05-01",
            rows: [
              {
                sector: "Industrials",
                rank: 1,
                convictionScorePct: 82.4,
                convictionBucket: "HIGH",
                evidenceStrength: "ADEQUATE",
              },
            ],
            freshness: { dataThrough: "2026-05-01", state: "fresh" },
            warnings: [],
          },
        },
        warnings: [],
      }),
      grahamyAgentRunner: async () => ({
        answerText: "Industrials leads the supplied PG sector leaderboard.",
        suggestedFollowups: [],
        warnings: [],
      }),
    },
  );

  assert.equal(response.answerType, "sector");
  assert.equal(response.meta.researchObjectKeys?.length, 0);
  assert.deepEqual(response.meta.sourcesUsed, [
    { type: "research", name: "sector_conviction_leaderboard" },
  ]);
  const publicView = response.research.publicResearchView as PublicResearchView;
  assert.equal(publicView.sectorLeaderboardView?.rows[0].sector, "Industrials");
  assert.equal(publicView.researchObjectViews.length, 0);
});

test("graph loads stockIdeaView for stock idea intent without ticker anchors", async () => {
  const response = await runAskGrahamyGraph(
    {
      userId: "external-user-1",
      conversationId: "conversation-1",
      message: "Give me an interesting stock",
      classification: stockIdeaClassification,
      priorResearchObjects: [],
    },
    1,
    {
      snapshotClient: {
        fetchPublishedSnapshots: async () => ({
          daily_brief: { regime: "NEUTRAL" },
          freshness: { dataThrough: "2026-05-01" },
        }),
      } as any,
      pgCapabilityRunner: async () => ({
        views: {
          stockIdeaView: {
            viewSchemaVersion: 1,
            state: "partial",
            source: "pg_features_daily",
            asOfDate: "2026-05-01",
            rankingBasis: "setup_quality",
            rows: [
              {
                symbol: "GSL",
                companyName: "Global Ship Lease, Inc.",
                sector: "Industrials",
                rank: 1,
                convictionScorePct: 82.4,
                convictionBucket: "HIGH",
                reasonBullets: ["Sector-relative conviction bucket is HIGH."],
              },
            ],
            freshness: { dataThrough: "2026-05-01", state: "fresh" },
            warnings: ["These are research candidates to review."],
          },
        },
        warnings: [],
      }),
      grahamyAgentRunner: async () => ({
        answerText: "GSL is a research candidate from the supplied PG stock idea view.",
        suggestedFollowups: [],
        warnings: [],
      }),
    },
  );

  assert.equal(response.answerType, "stock");
  assert.equal(response.meta.researchObjectKeys?.length, 0);
  assert.deepEqual(response.meta.sourcesUsed, [
    { type: "research", name: "stock_idea_discovery" },
  ]);
  const publicView = response.research.publicResearchView as PublicResearchView;
  assert.equal(publicView.stockIdeaView?.rows[0].symbol, "GSL");
  assert.equal(publicView.researchObjectViews.length, 0);
});

test("graph loads featureScreenView for bounded stock screen intent without ticker anchors", async () => {
  const response = await runAskGrahamyGraph(
    {
      userId: "external-user-1",
      conversationId: "conversation-1",
      message: "Find me cheap quality stocks",
      classification: featureScreenClassification,
      priorResearchObjects: [],
    },
    1,
    {
      snapshotClient: {
        fetchPublishedSnapshots: async () => ({
          daily_brief: { regime: "NEUTRAL" },
          freshness: { dataThrough: "2026-05-01" },
        }),
      } as any,
      pgCapabilityRunner: async () => ({
        views: {
          featureScreenView: {
            viewSchemaVersion: 1,
            state: "complete",
            source: "pg_current_features",
            asOfDate: "2026-05-01",
            screenCriteria: featureScreenClassification.featureCriteria ?? [],
            rows: [
              {
                symbol: "GSL",
                companyName: "Global Ship Lease, Inc.",
                sector: "Industrials",
                rank: 1,
                valuationBucket: "ATTRACTIVE",
                qualityBucket: "STRONG",
                convictionBucket: "HIGH",
                reasonBullets: ["Valuation bucket matched ATTRACTIVE."],
              },
            ],
            freshness: { dataThrough: "2026-05-01", state: "fresh" },
            warnings: ["These are screen results to review."],
          },
        },
        warnings: [],
      }),
      grahamyAgentRunner: async () => ({
        answerText: "GSL appears in the supplied PG feature screen view.",
        suggestedFollowups: [],
        warnings: [],
      }),
    },
  );

  assert.equal(response.answerType, "stock");
  assert.equal(response.meta.researchObjectKeys?.length, 0);
  assert.deepEqual(response.meta.sourcesUsed, [
    { type: "research", name: "feature_screen" },
  ]);
  const publicView = response.research.publicResearchView as PublicResearchView;
  assert.equal(publicView.featureScreenView?.rows[0].symbol, "GSL");
  assert.equal(publicView.researchObjectViews.length, 0);
});

test("graph loads factorBacktestView for historical factor questions without ticker anchors", async () => {
  const response = await runAskGrahamyGraph(
    {
      userId: "external-user-1",
      conversationId: "conversation-1",
      message: "Do cheap high-quality stocks work historically?",
      classification: factorBacktestClassification,
      priorResearchObjects: [],
    },
    1,
    {
      snapshotClient: {
        fetchPublishedSnapshots: async () => ({
          daily_brief: { regime: "NEUTRAL" },
          freshness: { dataThrough: "2026-05-01" },
        }),
      } as any,
      pgCapabilityRunner: async () => ({
        views: {
          factorBacktestView: {
            viewSchemaVersion: 1,
            state: "complete",
            source: "pg_factor_history",
            horizon: "60-day",
            criteria: factorBacktestClassification.factorBacktest?.criteria ?? [],
            sampleSize: 125,
            hitRatePct: 57.5,
            medianReturnPct: 2.35,
            p25ReturnPct: -6.79,
            p75ReturnPct: 11.23,
            sampleAdequacy: "ROBUST",
            freshness: { dataThrough: "2026-02-02", state: "fresh" },
            warnings: ["This is historical/base-rate factor evidence."],
          },
        },
        warnings: [],
      }),
      grahamyAgentRunner: async () => ({
        answerText: "The supplied PG factor backtest is robust.",
        suggestedFollowups: [],
        warnings: [],
      }),
    },
  );

  assert.equal(response.answerType, "stock");
  assert.equal(response.meta.researchObjectKeys?.length, 0);
  assert.deepEqual(response.meta.sourcesUsed, [
    { type: "research", name: "factor_conditioned_backtest" },
  ]);
  const publicView = response.research.publicResearchView as PublicResearchView;
  assert.equal(publicView.factorBacktestView?.sampleSize, 125);
  assert.equal(publicView.researchObjectViews.length, 0);
});

test("graph loads sectorDivergenceView for divergence intent without anchors", async () => {
  const response = await runAskGrahamyGraph(
    {
      userId: "external-user-1",
      conversationId: "conversation-1",
      message: "Which sectors have conviction but weak price action?",
      classification: divergenceClassification,
      priorResearchObjects: [],
    },
    1,
    {
      snapshotClient: {
        fetchPublishedSnapshots: async () => ({
          daily_brief: { regime: "NEUTRAL" },
          freshness: { dataThrough: "2026-05-01" },
        }),
      } as any,
      pgCapabilityRunner: async () => ({
        views: {
          sectorDivergenceView: {
            viewSchemaVersion: 1,
            state: "complete",
            source: "pg_sector_peer_daily",
            period: "latest",
            asOfDate: "2026-05-01",
            rows: [
              {
                sector: "Utilities",
                rank: 1,
                convictionScorePct: 70,
                convictionBucket: "CONSTRUCTIVE",
                momentumScorePct: 30,
                momentumBucket: "WEAK",
                divergenceType: "conviction_but_weak_price_action",
                hitRatePct: 58.2,
                evidenceStrength: "ADEQUATE",
                interpretationBullets: [
                  "Conviction is constructive but current price action is not confirming it.",
                ],
              },
            ],
            freshness: { dataThrough: "2026-05-01", state: "fresh" },
            warnings: [],
          },
        },
        warnings: [],
      }),
      grahamyAgentRunner: async () => ({
        answerText: "Utilities has conviction but weak price action in the supplied PG view.",
        suggestedFollowups: [],
        warnings: [],
      }),
    },
  );

  assert.equal(response.answerType, "sector");
  assert.equal(response.meta.researchObjectKeys?.length, 0);
  assert.deepEqual(response.meta.sourcesUsed, [
    {
      type: "research",
      name: "sector_momentum_vs_conviction_divergence",
    },
  ]);
  const publicView = response.research.publicResearchView as PublicResearchView;
  assert.equal(publicView.sectorDivergenceView?.rows[0].sector, "Utilities");
  assert.equal(publicView.researchObjectViews.length, 0);
});

test("graph loads sectorDeltaView for week-over-week sector delta intent without anchors", async () => {
  const response = await runAskGrahamyGraph(
    {
      userId: "external-user-1",
      conversationId: "conversation-1",
      message: "Which sectors improved most versus last week?",
      classification: sectorDeltaClassification,
      priorResearchObjects: [],
    },
    1,
    {
      snapshotClient: {
        fetchPublishedSnapshots: async () => ({
          daily_brief: { regime: "NEUTRAL" },
          freshness: { dataThrough: "2026-04-27" },
        }),
      } as any,
      pgCapabilityRunner: async () => ({
        views: {
          sectorDeltaView: {
            viewSchemaVersion: 1,
            state: "complete",
            source: "pg_sector_weekly_history",
            period: "week_over_week",
            currentAsOfDate: "2026-04-27",
            priorAsOfDate: "2026-04-20",
            rankingBasis: "overall_change",
            rows: [
              {
                sector: "Technology",
                rank: 1,
                currentConvictionScorePct: 76,
                priorConvictionScorePct: 68,
                convictionDeltaPct: 8,
                currentConvictionBucket: "HIGH",
                priorConvictionBucket: "CONSTRUCTIVE",
                currentMomentumBucket: "STRONG",
                priorMomentumBucket: "MIXED",
                momentumDeltaPct: 5,
                direction: "improved",
                interpretationBullets: [
                  "Weekly conviction proxy improved by 8 points.",
                ],
              },
            ],
            freshness: { dataThrough: "2026-04-27", state: "fresh" },
            warnings: [],
          },
        },
        warnings: [],
      }),
      grahamyAgentRunner: async () => ({
        answerText: "Technology improved in the supplied PG weekly sector delta view.",
        suggestedFollowups: [],
        warnings: [],
      }),
    },
  );

  assert.equal(response.answerType, "sector");
  assert.equal(response.meta.researchObjectKeys?.length, 0);
  assert.deepEqual(response.meta.sourcesUsed, [
    {
      type: "research",
      name: "week_over_week_sector_delta",
    },
  ]);
  const publicView = response.research.publicResearchView as PublicResearchView;
  assert.equal(publicView.sectorDeltaView?.rows[0].sector, "Technology");
  assert.equal(publicView.researchObjectViews.length, 0);
});

test("graph loads comparisonView for stock-vs-sector comparison without Research Object anchors", async () => {
  const response = await runAskGrahamyGraph(
    {
      userId: "external-user-1",
      conversationId: "conversation-1",
      message: "Compare GSL to its sector",
      classification: comparisonClassification,
      priorResearchObjects: [],
    },
    1,
    {
      snapshotClient: {
        fetchPublishedSnapshots: async () => ({
          daily_brief: { regime: "NEUTRAL" },
          freshness: { dataThrough: "2026-05-01" },
        }),
      } as any,
      pgCapabilityRunner: async () => ({
        views: {
          comparisonView: {
            viewSchemaVersion: 1,
            state: "partial",
            comparisonType: "stock_vs_sector",
            source: "pg_current_features",
            asOfDate: "2026-05-01",
            left: {
              type: "stock",
              label: "GSL",
              symbol: "GSL",
              sector: "Industrials",
              metrics: {
                convictionScorePct: 82,
                convictionBucket: "HIGH",
                momentumBucket: "STRONG",
              },
            },
            right: {
              type: "sector",
              label: "Industrials",
              sector: "Industrials",
              metrics: {
                convictionScorePct: 55,
                convictionBucket: "MIXED",
                momentumBucket: "MIXED",
              },
            },
            deltas: [
              {
                metric: "conviction",
                leftValue: 82,
                rightValue: 55,
                delta: 27,
                interpretationBucket: "left_stronger",
                explanation: "Compares public conviction fields.",
              },
            ],
            summaryBullets: [
              "GSL screens stronger than Industrials on conviction.",
            ],
            freshness: { dataThrough: "2026-05-01", state: "fresh" },
            warnings: ["Daily path-risk comparison is unavailable in V1."],
          },
        },
        warnings: [],
      }),
      grahamyAgentRunner: async () => ({
        answerText: "GSL is stronger than its sector on conviction in the supplied PG comparison view.",
        suggestedFollowups: [],
        warnings: [],
      }),
    },
  );

  assert.equal(response.answerType, "mixed");
  assert.equal(response.meta.researchObjectKeys?.length, 0);
  assert.deepEqual(response.meta.sourcesUsed, [
    { type: "research", name: "stock_vs_sector_comparison" },
  ]);
  const publicView = response.research.publicResearchView as PublicResearchView;
  assert.equal(publicView.comparisonView?.left.symbol, "GSL");
  assert.equal(publicView.researchObjectViews.length, 0);
});

test("graph loads comparisonView for sector-vs-sector comparison without Research Object anchors", async () => {
  const response = await runAskGrahamyGraph(
    {
      userId: "external-user-1",
      conversationId: "conversation-1",
      message: "Compare Technology vs Industrials",
      classification: sectorComparisonClassification,
      priorResearchObjects: [],
    },
    1,
    {
      snapshotClient: {
        fetchPublishedSnapshots: async () => ({
          daily_brief: { regime: "NEUTRAL" },
          freshness: { dataThrough: "2026-05-01" },
        }),
      } as any,
      pgCapabilityRunner: async () => ({
        views: {
          comparisonView: {
            viewSchemaVersion: 1,
            state: "complete",
            comparisonType: "sector_vs_sector",
            source: "pg_sector_peer_daily",
            asOfDate: "2026-05-01",
            left: {
              type: "sector",
              label: "Technology",
              sector: "Technology",
              metrics: { convictionScorePct: 72, convictionBucket: "CONSTRUCTIVE" },
            },
            right: {
              type: "sector",
              label: "Industrials",
              sector: "Industrials",
              metrics: { convictionScorePct: 52, convictionBucket: "MIXED" },
            },
            deltas: [
              {
                metric: "conviction",
                leftValue: 72,
                rightValue: 52,
                delta: 20,
                interpretationBucket: "left_stronger",
                explanation: "Compares public sector conviction fields.",
              },
            ],
            summaryBullets: [
              "Technology screens stronger than Industrials on conviction.",
            ],
            freshness: { dataThrough: "2026-05-01", state: "fresh" },
            warnings: [],
          },
        },
        warnings: [],
      }),
      grahamyAgentRunner: async () => ({
        answerText: "Technology screens stronger on the supplied PG comparison view.",
        suggestedFollowups: [],
        warnings: [],
      }),
    },
  );

  assert.equal(response.answerType, "mixed");
  assert.equal(response.meta.researchObjectKeys?.length, 0);
  assert.deepEqual(response.meta.sourcesUsed, [
    { type: "research", name: "sector_vs_sector_comparison" },
  ]);
  const publicView = response.research.publicResearchView as PublicResearchView;
  assert.equal(publicView.comparisonView?.comparisonType, "sector_vs_sector");
  assert.equal(publicView.comparisonView?.left.sector, "Technology");
  assert.equal(publicView.comparisonView?.right.sector, "Industrials");
  assert.equal(publicView.researchObjectViews.length, 0);
});

test("graph loads comparisonView for symbol-vs-symbol comparison without Research Object anchors", async () => {
  const response = await runAskGrahamyGraph(
    {
      userId: "external-user-1",
      conversationId: "conversation-1",
      message: "Compare GSL vs DAC",
      classification: symbolComparisonClassification,
      priorResearchObjects: [],
    },
    1,
    {
      snapshotClient: {
        fetchPublishedSnapshots: async () => ({
          daily_brief: { regime: "NEUTRAL" },
          freshness: { dataThrough: "2026-05-01" },
        }),
      } as any,
      pgCapabilityRunner: async () => ({
        views: {
          comparisonView: {
            viewSchemaVersion: 1,
            state: "partial",
            comparisonType: "symbol_vs_symbol",
            source: "pg_current_features",
            asOfDate: "2026-05-01",
            left: {
              type: "stock",
              label: "GSL",
              symbol: "GSL",
              sector: "Industrials",
              metrics: { convictionScorePct: 82, convictionBucket: "HIGH" },
            },
            right: {
              type: "stock",
              label: "DAC",
              symbol: "DAC",
              sector: "Industrials",
              metrics: { convictionScorePct: 58, convictionBucket: "MIXED" },
            },
            deltas: [
              {
                metric: "conviction",
                leftValue: 82,
                rightValue: 58,
                delta: 24,
                interpretationBucket: "left_stronger",
                explanation: "Compares public stock conviction fields.",
              },
            ],
            summaryBullets: ["GSL screens stronger than DAC on conviction."],
            freshness: { dataThrough: "2026-05-01", state: "fresh" },
            warnings: ["Daily path-risk comparison is unavailable in V1."],
          },
        },
        warnings: [],
      }),
      grahamyAgentRunner: async () => ({
        answerText: "GSL screens stronger on the supplied PG comparison view.",
        suggestedFollowups: [],
        warnings: [],
      }),
    },
  );

  assert.equal(response.answerType, "mixed");
  assert.equal(response.meta.researchObjectKeys?.length, 0);
  assert.deepEqual(response.meta.sourcesUsed, [
    { type: "research", name: "symbol_vs_symbol_comparison" },
  ]);
  const publicView = response.research.publicResearchView as PublicResearchView;
  assert.equal(publicView.comparisonView?.comparisonType, "symbol_vs_symbol");
  assert.equal(publicView.comparisonView?.left.symbol, "GSL");
  assert.equal(publicView.comparisonView?.right.symbol, "DAC");
  assert.equal(publicView.researchObjectViews.length, 0);
});

test("graph loads regimeHistoricalPlaybookView without changing Regime RO route", async () => {
  const response = await runAskGrahamyGraph(
    {
      userId: "external-user-1",
      conversationId: "conversation-1",
      message: "What usually works in this regime?",
      classification: regimePlaybookClassification,
      priorResearchObjects: [],
    },
    1,
    {
      snapshotClient: {
        fetchPublishedSnapshots: async () => ({
          daily_brief: { regime: "NEUTRAL" },
          freshness: { dataThrough: "2026-05-04" },
        }),
      } as any,
      pgCapabilityRunner: async () => ({
        views: {
          regimeHistoricalPlaybookView: {
            viewSchemaVersion: 1,
            state: "complete",
            source: "pg_regime_history",
            regime: "NEUTRAL",
            asOfDate: "2026-05-04",
            rows: [
              {
                sector: "Industrials",
                rank: 1,
                role: "leader",
                hitRatePct: 56.2,
                evidenceStrength: "ROBUST",
                interpretationBullets: [
                  "Industrials has historically screened among stronger sectors in NEUTRAL regimes.",
                ],
              },
            ],
            risks: [
              {
                riskLabel: "Volatility backdrop",
                riskBucket: "MODERATE",
                interpretation:
                  "Volatility backdrop is moderate in the latest public bucket.",
              },
            ],
            summaryBullets: [
              "In NEUTRAL regimes, historical sector leaders in this view include Industrials.",
            ],
            freshness: { dataThrough: "2026-05-04", state: "fresh" },
            warnings: [],
          },
        },
        warnings: [],
      }),
      grahamyAgentRunner: async () => ({
        answerText: "Industrials leads the supplied PG historical regime playbook.",
        suggestedFollowups: [],
        warnings: [],
      }),
    },
  );

  assert.equal(response.answerType, "regime");
  assert.equal(response.meta.researchObjectKeys?.length, 0);
  assert.deepEqual(response.meta.sourcesUsed, [
    { type: "research", name: "market_regime_historical_playbook" },
  ]);
  const publicView = response.research.publicResearchView as PublicResearchView;
  assert.equal(publicView.objectType, "regime");
  assert.equal(publicView.regimeHistoricalPlaybookView?.regime, "NEUTRAL");
  assert.equal(publicView.regimeHistoricalPlaybookView?.rows[0].sector, "Industrials");
  assert.equal(publicView.researchObjectViews.length, 0);
});

test("graph activates research planner for compound Hebrew research question and merges mocked public views", async () => {
  let plannerCalled = false;
  let executorCalled = false;

  const response = await runAskGrahamyGraph(
    {
      userId: "external-user-1",
      conversationId: "conversation-compound-planner",
      message: compoundHebrewQuestion,
      classification: compoundClassification,
      priorResearchObjects: [],
    },
    1,
    {
      snapshotClient: {
        fetchPublishedSnapshots: async () => ({
          daily_brief: { regime: "NEUTRAL" },
          freshness: { dataThrough: "2026-05-04" },
        }),
      } as any,
      researchPlanProposer: async (message) => {
        plannerCalled = true;
        assert.equal(message, compoundHebrewQuestion);
        return validCompoundPlan;
      },
      researchPlanExecutor: async ({ plan }) => {
        executorCalled = true;
        assert.equal(plan.planType, "multi_step");
        assert.deepEqual(
          plan.steps.map((step) => step.capability),
          [
            "market_regime_historical_playbook",
            "feature_screen",
            "validated_edge_evidence",
          ],
        );
        const pgCapabilityViews = {
          regimeHistoricalPlaybookView: {
            viewSchemaVersion: 1,
            state: "complete" as const,
            source: "pg_regime_history" as const,
            regime: "NEUTRAL",
            asOfDate: "2026-05-04",
            rows: [
              {
                sector: "Industrials",
                rank: 1,
                role: "leader" as const,
                hitRatePct: 56.2,
                evidenceStrength: "ROBUST",
                interpretationBullets: [
                  "Industrials has historically screened among stronger sectors in NEUTRAL regimes.",
                ],
              },
            ],
            risks: [],
            summaryBullets: [
              "Industrials has historically led in the current regime.",
            ],
            freshness: { dataThrough: "2026-05-04", state: "fresh" as const },
            warnings: [],
          },
          featureScreenView: {
            viewSchemaVersion: 1,
            state: "complete" as const,
            source: "pg_current_features" as const,
            asOfDate: "2026-05-04",
            screenCriteria: [{ factor: "sector" as const, bucket: "Industrials" }],
            rows: [
              {
                symbol: "GSL",
                sector: "Industrials",
                rank: 1,
                hitRatePct: 58.1,
                medianReturnPct: 3.2,
                reasonBullets: ["Sector filter matched Industrials."],
              },
            ],
            freshness: { dataThrough: "2026-05-04", state: "fresh" as const },
            warnings: ["These are screen results to review."],
          },
        };
        const pipelineOverlayViews = {
          validatedEdgeEvidenceView: {
            viewSchemaVersion: 1,
            state: "complete" as const,
            source: "client_api_research_object" as const,
            anchor: { type: "stock" as const, symbol: "GSL", label: "GSL" },
            evidenceState: "edge_evidence_present" as const,
            edgeCountBucket: "present",
            eventSampleBucket: "adequate",
            interpretationBullets: [
              "Validated pipeline evidence is present for GSL.",
            ],
            freshness: { dataThrough: "2026-05-04", state: "fresh" as const },
            warnings: [],
          },
        };
        return {
          pgCapabilityViews,
          pipelineOverlayViews,
          workflowExecutionResult: buildWorkflowExecutionResult({
            workflowName: "regime_to_stock_screen",
            publicViews: { pgCapabilityViews, pipelineOverlayViews },
            pipelineLabels: { GSL: "ראיה מאומתת קיימת" },
          }),
          warnings: [],
        };
      },
      analystBriefSynthesizer: async ({ evidencePack }) => {
        assert.equal(evidencePack.workflowName, "regime_to_stock_screen");
        assert.equal(evidencePack.candidateTable?.[0].symbol, "GSL");
        return {
          brief: mockAnalystBrief(
            "Industrials מוביל היסטורית, ו-GSL הגיע ממסך המניות הציבורי.",
          ),
          warnings: [],
          usedFallback: false,
        };
      },
      grahamyAgentRunner: async () => {
        throw new Error("compound workflow should use AnalystBrief synthesis");
      },
    },
  );

  assert.equal(plannerCalled, true);
  assert.equal(executorCalled, true);
  assert.equal(response.meta.researchObjectKeys?.length, 0);
  const publicView = response.research.publicResearchView as PublicResearchView;
  assert.equal(publicView.regimeHistoricalPlaybookView?.rows[0].sector, "Industrials");
  assert.equal(publicView.featureScreenView?.rows[0].symbol, "GSL");
  assert.equal(publicView.validatedEdgeEvidenceView?.anchor.symbol, "GSL");
  const serialized = JSON.stringify(response);
  assert.equal(serialized.includes("planType"), false);
  assert.equal(serialized.includes("paramsFromPreviousSteps"), false);
  assert.equal(serialized.includes("regime_context"), false);
});

test("graph uses real focused executor for compound plan with mocked capability runners", async () => {
  let grahamyCalled = false;
  let synthesizerCalled = false;
  const pipelineSymbols: string[] = [];
  const response = await runAskGrahamyGraph(
    {
      userId: "external-user-1",
      conversationId: "conversation-compound-real-executor",
      message: compoundHebrewQuestion,
      classification: compoundClassification,
      priorResearchObjects: [],
    },
    1,
    {
      snapshotClient: {
        fetchPublishedSnapshots: async () => ({
          daily_brief: { regime: "NEUTRAL" },
          freshness: { dataThrough: "2026-05-04" },
        }),
      } as any,
      researchPlanProposer: async () => validCompoundPlan,
      pgCapabilityRunner: async (input) => {
        if (input.classification.intent === "market_regime_historical_playbook") {
          return {
            views: {
              regimeHistoricalPlaybookView: {
                viewSchemaVersion: 1,
                state: "complete",
                source: "pg_regime_history",
                regime: "NEUTRAL",
                asOfDate: "2026-05-04",
                rows: [
                  { sector: "Industrials", rank: 1, role: "leader", interpretationBullets: [] },
                  { sector: "Utilities", rank: 2, role: "laggard", interpretationBullets: [] },
                ],
                risks: [],
                summaryBullets: [],
                freshness: { dataThrough: "2026-05-04", state: "fresh" },
                warnings: [],
              },
            },
            warnings: [],
          };
        }
        assert.equal(input.classification.intent, "feature_screen");
        assert.deepEqual(input.classification.featureCriteria, [
          { factor: "sector", bucket: "Industrials" },
        ]);
        return {
          views: {
            featureScreenView: {
              viewSchemaVersion: 1,
              state: "complete",
              source: "pg_current_features",
              asOfDate: "2026-05-04",
              screenCriteria: input.classification.featureCriteria ?? [],
              rows: [
                {
                  symbol: "GSL",
                  sector: "Industrials",
                  rank: 1,
                  qualityBucket: "STRONG",
                  momentumBucket: "STRONG",
                  hitRatePct: 58.1,
                  medianReturnPct: 3.2,
                  reasonBullets: ["Sector filter matched Industrials."],
                },
                {
                  symbol: "AAA",
                  sector: "Industrials",
                  rank: 2,
                  valuationBucket: "ATTRACTIVE",
                  qualityBucket: "STRONG",
                  hitRatePct: 57.2,
                  medianReturnPct: 2.9,
                  reasonBullets: ["Sector filter matched Industrials."],
                },
                {
                  symbol: "BBB",
                  sector: "Industrials",
                  rank: 3,
                  qualityBucket: "STRONG",
                  momentumBucket: "POSITIVE",
                  hitRatePct: 55.3,
                  medianReturnPct: 2.2,
                  reasonBullets: ["Sector filter matched Industrials."],
                },
                {
                  symbol: "CCC",
                  sector: "Industrials",
                  rank: 4,
                  growthBucket: "STRONG",
                  leverageBucket: "STRONG",
                  hitRatePct: 53.4,
                  medianReturnPct: 1.8,
                  reasonBullets: ["Sector filter matched Industrials."],
                },
                {
                  symbol: "DDD",
                  sector: "Industrials",
                  rank: 5,
                  hitRatePct: 51.5,
                  medianReturnPct: 1.1,
                  reasonBullets: ["Sector filter matched Industrials."],
                },
                {
                  symbol: "EEE",
                  sector: "Industrials",
                  rank: 6,
                  hitRatePct: 49.6,
                  medianReturnPct: 0.8,
                  reasonBullets: ["Sector filter matched Industrials."],
                },
              ],
              freshness: { dataThrough: "2026-05-04", state: "fresh" },
              warnings: [],
            },
          },
          warnings: [],
        };
      },
      pipelineOverlayRunner: async (input) => {
        const symbol = input.classification.symbols[0];
        pipelineSymbols.push(symbol);
        return {
          views: {
            validatedEdgeEvidenceView: {
              viewSchemaVersion: 1,
              state: "complete",
              source: "client_api_research_object",
              anchor: { type: "stock", symbol, label: symbol },
              evidenceState:
                symbol === "AAA"
                  ? "edge_evidence_strong"
                  : symbol === "BBB"
                    ? "mixed"
                    : "edge_evidence_present",
              interpretationBullets: [],
              freshness: { dataThrough: "2026-05-04", state: "fresh" },
              warnings: [],
            },
          },
          warnings: [],
        };
      },
      analystBriefSynthesizer: async ({ evidencePack }) => {
        synthesizerCalled = true;
        assert.equal(evidencePack.workflowName, "regime_to_stock_screen");
        assert.equal(evidencePack.candidateTable?.length, 6);
        assert.equal(evidencePack.candidateTable?.[0].symbol, "GSL");
        assert.equal(JSON.stringify(evidencePack).includes("ResearchPlan"), false);
        assert.equal(JSON.stringify(evidencePack).includes("compoundResearchContext"), false);
        return {
          brief: mockAnalystBrief(
            "Industrials היה הסקטור המוביל, והמועמדים הגיעו ממסך ציבורי מוגבל.",
          ),
          warnings: [],
          usedFallback: false,
        };
      },
      grahamyAgentRunner: async () => {
        grahamyCalled = true;
        throw new Error("compound workflow should skip the deep agent");
      },
    },
  );

  assert.equal(grahamyCalled, false);
  assert.equal(synthesizerCalled, true);
  assert.deepEqual(pipelineSymbols, ["GSL", "AAA", "BBB"]);
  const publicView = response.research.publicResearchView as PublicResearchView;
  assert.equal(publicView.regimeHistoricalPlaybookView?.rows[0].sector, "Industrials");
  assert.equal(publicView.featureScreenView?.rows[0].symbol, "GSL");
  assert.equal(publicView.featureScreenView?.rows.length, 6);
  assert.match(response.answer.summary, /### השורה התחתונה/);
  assert.match(response.answer.summary, /מה נבדק/);
  assert.match(response.answer.summary, /\| מניה \| סקטור \| ראיה \|/);
  assert.match(response.answer.summary, /\| GSL \|/);
  assert.match(response.answer.summary, /ראיה מאומתת קיימת/);
  const serialized = JSON.stringify(response);
  assert.equal(serialized.includes("compoundResearchContext"), false);
  assert.equal(serialized.includes("ResearchPlan"), false);
  assert.equal(serialized.includes("planType"), false);
  assert.equal(serialized.includes("paramsFromPreviousSteps"), false);
  assert.equal(serialized.includes("Utilities"), true);
  assert.equal(serialized.includes("raw_sql"), false);
  assert.equal(serialized.includes("edge_id"), false);
  assert.equal(serialized.includes("hypothesis_id"), false);
  assert.equal(serialized.includes("feature_rules"), false);
  assert.equal(/\b(buy|sell|sizing|stop-loss)\b/i.test(serialized), false);
});

test("graph rejects invalid compound research plan and falls back to standard route", async () => {
  let executorCalled = false;
  const invalidPlan: ResearchPlan = {
    ...validCompoundPlan,
    steps: [
      {
        id: "bad_screen",
        capability: "feature_screen",
        purpose: "Run an unbounded current stock screen.",
        params: {},
      },
    ],
  };

  const response = await runAskGrahamyGraph(
    {
      userId: "external-user-1",
      conversationId: "conversation-invalid-planner",
      message: compoundHebrewQuestion,
      classification: compoundClassification,
      priorResearchObjects: [],
    },
    1,
    {
      snapshotClient: {
        fetchPublishedSnapshots: async () => ({
          daily_brief: { regime: "NEUTRAL" },
          freshness: { dataThrough: "2026-05-04" },
        }),
      } as any,
      researchPlanProposer: async () => invalidPlan,
      researchPlanExecutor: async () => {
        executorCalled = true;
        return { warnings: [] };
      },
      pgCapabilityRunner: async () => ({
        views: {
          regimeHistoricalPlaybookView: {
            viewSchemaVersion: 1,
            state: "complete",
            source: "pg_regime_history",
            regime: "NEUTRAL",
            asOfDate: "2026-05-04",
            rows: [
              {
                sector: "Industrials",
                rank: 1,
                role: "leader",
                interpretationBullets: ["Industrials is the fallback view."],
              },
            ],
            risks: [],
            summaryBullets: ["Fallback regime playbook loaded."],
            freshness: { dataThrough: "2026-05-04", state: "fresh" },
            warnings: [],
          },
        },
        warnings: [],
      }),
      grahamyAgentRunner: async (state) => {
        assert.equal(state.pgCapabilityViews?.regimeHistoricalPlaybookView?.rows[0].sector, "Industrials");
        assert.equal(state.pgCapabilityViews?.featureScreenView, undefined);
        return {
          answerText: "Fallback regime playbook answer.",
          suggestedFollowups: [],
          warnings: [],
        };
      },
    },
  );

  assert.equal(executorCalled, false);
  const publicView = response.research.publicResearchView as PublicResearchView;
  assert.equal(publicView.regimeHistoricalPlaybookView?.rows[0].sector, "Industrials");
  assert.equal(publicView.featureScreenView, undefined);
  assert.equal(
    response.meta.warnings.some((warning) =>
      warning.includes("could not be safely expanded into bounded checks"),
    ),
    true,
  );
  const serialized = JSON.stringify(response);
  assert.equal(serialized.includes("Run an unbounded"), false);
  assert.equal(serialized.includes("feature_screen must have"), false);
});

test("graph leaves simple feature-screen turns on the existing single-intent path", async () => {
  let plannerCalled = false;
  let executorCalled = false;

  const response = await runAskGrahamyGraph(
    {
      userId: "external-user-1",
      conversationId: "conversation-no-planner",
      message: "Find me cheap quality stocks",
      classification: featureScreenClassification,
      priorResearchObjects: [],
    },
    1,
    {
      snapshotClient: {
        fetchPublishedSnapshots: async () => ({
          daily_brief: { regime: "NEUTRAL" },
          freshness: { dataThrough: "2026-05-04" },
        }),
      } as any,
      researchPlanProposer: async () => {
        plannerCalled = true;
        return validCompoundPlan;
      },
      researchPlanExecutor: async () => {
        executorCalled = true;
        return { warnings: [] };
      },
      pgCapabilityRunner: async () => ({
        views: {
          featureScreenView: {
            viewSchemaVersion: 1,
            state: "complete",
            source: "pg_current_features",
            asOfDate: "2026-05-04",
            screenCriteria: featureScreenClassification.featureCriteria ?? [],
            rows: [
              {
                symbol: "GSL",
                sector: "Industrials",
                rank: 1,
                reasonBullets: ["Valuation bucket matched ATTRACTIVE."],
              },
            ],
            freshness: { dataThrough: "2026-05-04", state: "fresh" },
            warnings: [],
          },
        },
        warnings: [],
      }),
      grahamyAgentRunner: async () => ({
        answerText: "Existing feature screen path.",
        suggestedFollowups: [],
        warnings: [],
      }),
    },
  );

  assert.equal(plannerCalled, false);
  assert.equal(executorCalled, false);
  const publicView = response.research.publicResearchView as PublicResearchView;
  assert.equal(publicView.featureScreenView?.rows[0].symbol, "GSL");
});

test("graph leaves simple stock turns on the existing deep-agent path", async () => {
  let plannerCalled = false;
  let grahamyCalled = false;

  const response = await runAskGrahamyGraph(
    {
      userId: "external-user-1",
      conversationId: "conversation-simple-stock-no-planner",
      message: "Tell me about GSL",
      classification: plainStockClassification,
      priorResearchObjects: [],
    },
    1,
    {
      snapshotClient: {
        fetchPublishedSnapshots: async () => ({
          daily_brief: { regime: "NEUTRAL" },
          freshness: { dataThrough: "2026-05-04" },
        }),
      } as any,
      researchPlanProposer: async () => {
        plannerCalled = true;
        return validCompoundPlan;
      },
      researchObjectBuilder: async () => ({
        objects: [],
        objectsUpdated: [],
        stats: { hits: 0, misses: 0, writes: 0 },
        warnings: [],
      }),
      pgCapabilityRunner: async () => ({ views: {}, warnings: [] }),
      pipelineOverlayRunner: async () => ({ views: {}, warnings: [] }),
      grahamyAgentRunner: async () => {
        grahamyCalled = true;
        return {
          answerText: "Normal stock path.",
          suggestedFollowups: [],
          warnings: [],
        };
      },
    },
  );

  assert.equal(plannerCalled, false);
  assert.equal(grahamyCalled, true);
  assert.equal(response.answer.summary, "Normal stock path.");
});

test("graph leaves simple comparison turns on the existing deep-agent path", async () => {
  let plannerCalled = false;
  let grahamyCalled = false;

  const response = await runAskGrahamyGraph(
    {
      userId: "external-user-1",
      conversationId: "conversation-simple-comparison-no-planner",
      message: "Compare GSL vs DAC",
      classification: symbolComparisonClassification,
      priorResearchObjects: [],
    },
    1,
    {
      snapshotClient: {
        fetchPublishedSnapshots: async () => ({
          daily_brief: { regime: "NEUTRAL" },
          freshness: { dataThrough: "2026-05-04" },
        }),
      } as any,
      researchPlanProposer: async () => {
        plannerCalled = true;
        return validCompoundPlan;
      },
      researchObjectBuilder: async () => ({
        objects: [],
        objectsUpdated: [],
        stats: { hits: 0, misses: 0, writes: 0 },
        warnings: [],
      }),
      pgCapabilityRunner: async () => ({
        views: {
          comparisonView: {
            viewSchemaVersion: 1,
            state: "complete",
            comparisonType: "symbol_vs_symbol",
            source: "pg_current_features",
            asOfDate: "2026-05-04",
            left: {
              type: "stock",
              symbol: "GSL",
              label: "GSL",
              metrics: { convictionBucket: "HIGH" },
            },
            right: {
              type: "stock",
              symbol: "DAC",
              label: "DAC",
              metrics: { convictionBucket: "MIXED" },
            },
            deltas: [],
            summaryBullets: [],
            freshness: { dataThrough: "2026-05-04", state: "fresh" },
            warnings: [],
          },
        },
        warnings: [],
      }),
      pipelineOverlayRunner: async () => ({ views: {}, warnings: [] }),
      grahamyAgentRunner: async () => {
        grahamyCalled = true;
        return {
          answerText: "Normal comparison path.",
          suggestedFollowups: [],
          warnings: [],
        };
      },
    },
  );

  assert.equal(plannerCalled, false);
  assert.equal(grahamyCalled, true);
  assert.equal(response.answer.summary, "Normal comparison path.");
});

function mockAnalystBrief(bottomLine: string): AnalystBrief {
  return {
    bottomLine,
    sections: [
      {
        id: "what_was_checked",
        heading: "מה נבדק",
        bullets: ["נבדקו שכבות ראיה ציבוריות בלבד."],
      },
      {
        id: "supports",
        heading: "מה תומך בזה",
        bullets: ["המועמדים הגיעו ממסך מוגבל."],
      },
      {
        id: "data_limitations",
        heading: "מגבלות הנתונים",
        bullets: ["יש להשתמש בזה כמסך מחקר."],
      },
    ],
    tables: [
      {
        type: "candidate",
        columns: ["מניה", "סקטור", "ראיה"],
        rows: [["GSL", "Industrials", "ראיה מאומתת קיימת"]],
      },
    ],
    caveats: ["הנתונים זמינים עד 2026-05-04."],
    confidence: {
      level: "moderate",
      explanation: "יש ראיה ציבורית, עם מגבלות רגילות של מסך מחקר.",
    },
    sources: [
      { label: "featureScreenView", type: "pg_current" },
    ],
    followUps: ["בדוק את הסיכון ב-GSL."],
  };
}
