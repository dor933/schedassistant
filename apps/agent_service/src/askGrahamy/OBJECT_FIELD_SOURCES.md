# Ask Grahamy — Object & Field Source Map

A field-by-field map of every object the `askGrahamy/graph.ts` pipeline materialises,
with the **exact query / snapshot / computation** that produces each value.

This is the “where does this number come from?” reference. It is organised by the
graph node that builds the object.

> Lineage rule (post v3/v4/v5 of `PUBLIC_RESEARCH_VIEW_SCHEMA_VERSION`): on any
> Research Object the **`publicSummary` and `view` are PG-derived only**.
> Pipeline-snapshot lineage and per-anchor pipeline data live in a single
> dedicated `pipeline` block. The two are kept side-by-side for traceability,
> but the agent-facing prompt only ever reads PG-derived fields.

---

## 0. Graph order (recap from `graph.ts`)

```
START
 → requireClassification        (validates classifier envelope)
 → fetchBaseSnapshots           ← pipeline snapshot service (HTTP)
 → selectTools / executeTools   ← pipeline snapshot tools (HTTP)
 → researchPlanner              (planner branch may short-circuit)
   ↘ plannerHandled → compileEvidence
   ↘ standardLoaders →
      loadResearchObjects       ← `query_v6a_*`/`v6b`/`v6c` (PG)
      loadPgCapabilities        ← `query_*` capability SQL (PG)
      loadPipelineOverlays      ← Grahamy Client API (HTTP overlay)
 → compileEvidence → buildAnswer → buildMeta → finalizeResponse
```

The objects this doc maps:
1. `SnapshotBundle` — built by `fetchBaseSnapshots`.
2. `ToolOutputs` — built by `executeTools` (out of scope for the deep map; it
   wraps the same snapshot endpoints).
3. `CachedResearchObject` (4 flavours: stock / sector / industry / regime) —
   built by `loadResearchObjects`.
4. `PgCapabilityViews` — built by `loadPgCapabilities`. 7 view shapes, one slot
   per intent.
5. `PipelineOverlayViews` — built by `loadPipelineOverlays` (today only
   `validatedEdgeEvidenceView`).

---

## 1. `SnapshotBundle` (pipeline snapshots)

**Built by:** `nodes/fetchBaseSnapshots.ts` → `GrahamySnapshotClient.fetchPublishedSnapshots()`.
**Source:** five HTTP GETs against `${GRAHAMY_AGENTS_BASE_URL}/api/client/snapshot/<name>`.

| Field | Source |
|---|---|
| `daily_brief` | HTTP GET `/api/client/snapshot/daily_brief`, raw JSON |
| `metadata` | HTTP GET `/api/client/snapshot/metadata`, raw JSON |
| `clusters` | HTTP GET `/api/client/snapshot/clusters`, raw JSON |
| `track_record` | HTTP GET `/api/client/snapshot/track_record`, raw JSON |
| `transparency` | HTTP GET `/api/client/snapshot/transparency`, raw JSON |
| `latencyMs.<name>` | Computed (`Date.now() - start`) per fetch |
| `errors.<name>` | Computed (set on non-2xx, abort/timeout, or no `baseUrl`) |
| `freshness` | Computed by `extractFreshness(metadata, transparency)` (see below) |

`FreshnessMetadata` derivation (`snapshotClient.extractFreshness`):

| Field | Source |
|---|---|
| `generatedAt` | `metadata.generated_at` |
| `dataThrough` | `metadata.data_through` |
| `pipelineStatus` | `metadata.pipeline_status` |
| `dataFreshness` | `transparency.data_freshness` OR fallback: `transparency.pipeline_health[name="Last health check"].value` |
| `stale` | Computed: true when all three (generatedAt/dataThrough/dataFreshness) are missing **or** when `pipelineStatus` ∉ {OPERATIONAL, OK} |
| `staleReason` | Computed string explaining the failed check |

These pipeline snapshots are the basis for the `pipeline.freshness` block on
every Research Object and for the per-anchor `pipeline.snapshot` slice (when
the anchor is a stock or sector). They never feed `publicSummary` / `view`.

---

## 2. `ToolOutputs` (snapshot-derived tool envelopes)

**Built by:** `nodes/executeTools.ts` (called from `selectTools/executeTools`).
**Source:** Slices of the snapshot bundle wrapped in tool-specific shapes:

| Tool | Shape (see `types.ts`) | Source |
|---|---|---|
| `get_market_context` | `MarketContext` | Slices of `daily_brief` / `metadata` (regime, vix, edges, win-rate bucket, etc.) |
| `get_stock_snapshot_context` | `StockResearchContext` | Per-symbol slice from `daily_brief.symbols` |
| `get_sector_snapshot_context` | `SectorLandscape` | Per-sector slice from `daily_brief.sectors` |
| `get_industry_snapshot_context` | `IndustryLandscape` | Industry list — substantive industry detail comes from the industry RO, not the snapshot |
| `get_homepage_focus_context` | `HomepageFocusContext` | `daily_brief.focus` |

These are passed into `buildResearchObjects(...)` as `toolOutputs`. They feed
**only** the `pipeline.snapshot` block on each RO (e.g. for a stock RO the
matching `daily_brief.symbols[symbol]` row), and `resolveCurrentRegime`
fall-back for the regime RO.

---

## 3. `CachedResearchObject` (built by `loadResearchObjects`)

`loadResearchObjects` orchestrates `buildResearchObjects(...)` from
`researchObjectBuilder.ts`. For every classified anchor it:

1. Builds a deterministic cache key — `buildResearchObjectCacheKey(type, anchor, asOfDate)` =
   `STOCK:MSFT:2026-05-09` etc. (`asOfDate` = `state.asOfDate` from the request,
   else `snapshots.freshness.dataThrough` / `generatedAt[:10]` / today).
2. If `priorResearchObjects` contains a matching cache key + `viewSchemaVersion === 5`,
   reuses it (cache hit). Stale view-version → re-hydrates from `parts.*` if
   possible, or rebuilds.
3. Otherwise runs the matching v6 SQL (see per-flavour tables below).
4. Single-stock turn with no sector/industry classified → also auto-builds the
   sibling **sector** and **industry** ROs (pulled from
   `publicSummary.sector` / `publicSummary.industry` of the just-built stock RO).
5. Always loads/builds the **regime** RO; current regime resolved by
   `resolveCurrentRegime` in this priority:
   1. `publicSummary.regime` of any object already built this turn
   2. `marketContext.regime` (snapshot `get_market_context` tool output)
   3. PG fallback: `SELECT market_regime FROM md_historical_features_daily
      WHERE symbol='SPY' AND is_delisted=false ORDER BY as_of_date DESC LIMIT 1`

### 3.0 Common envelope (every flavour)

| Field | Source |
|---|---|
| `cacheKey` | Computed: `buildResearchObjectCacheKey(...)` |
| `objectType` | Constant per flavour (`stock` / `sector` / `industry` / `regime`) |
| `anchor` | Classified symbol/sector/industry, or `MARKET` for regime |
| `asOfDate` | `meta.as_of_date` from the v6 SQL row, fallback to the keying `asOfDate` |
| `generatedAt` | Computed: `new Date().toISOString()` |
| `source` | Constant `"database"` for fresh builds; `"redis"` / `"snapshot"` only for prior cache hits |
| `parts.*` | The raw v6 SQL row for the flavour (sanitised: drops `_*` keys + empty objects) |
| `view` | PG-derived projection — see the per-flavour view section |
| `pipeline.freshness` | The pipeline `SnapshotBundle.freshness` (lineage only) |
| `pipeline.snapshot` | Stock/Sector only — `daily_brief.symbols[symbol]` / `daily_brief.sectors[sector]` slice |
| `warnings` | Per-build warnings (e.g. cache hydration messages) |
| `freshness` | Deprecated; kept on type for old persisted records — new builds do **not** emit it |

`publicSummary` always carries the per-flavour PG-derived block plus the three
view-derived sub-blocks (`edgeEvidence`, `probabilisticEvidence`, `pathRisk`)
copied from `view.*` so the agent prompt can iterate them with one shape.

---

### 3.1 Stock Research Object

**SQL invoked (in parallel):**
- `query_v6a_core_live` (param: `SYMBOL`) → `research_object_core` jsonb
- `query_v6c_financial_quality` (param: `SYMBOL`) → `research_object_v6c` jsonb

After `core.profile_keys` is read, a third query runs **only when `sector`,
`current_regime`, `valuation_bucket`, `pe_bin`, and `rsi_bin` are all present**:

- `query_v6b_sector_aggregates` (params: `SYMBOL, SECTOR, CURRENT_REGIME,
  PE_BIN, RSI_BIN, VALUATION_BUCKET`) → `research_object_sector` jsonb

**Tables read by `query_v6a_core_live.sql`:**
- `md_symbols` — symbol-info anchor row
- `md_features_daily` — current screening row
- `md_historical_features_daily` — PIT feature spine (current_historical, analogs, own-history, path-risk paths)
- `md_historical_benchmark_daily` — SPX / VIX benchmarks
- `md_ratios_ttm_snapshots` — current TTM ratios
- `md_key_metrics_ttm_snapshots` — current TTM key metrics
- `md_ratios_annual` — own 5y / 10y ratio history
- `md_key_metrics_annual` — own 5y key-metric history
- `md_income_quarterly` — revenue trajectory
- `md_balance_quarterly` — debt trajectory
- `md_earnings_calendar` — beats/misses streak + earnings proximity
- `md_analyst_estimates` — forward consensus + revision trend
- `md_8k_filings` — recent-8K activity
- `md_dividends` — recent dividend activity
- `md_forward_returns` — h60/h252 returns for self-analog and own-history evidence

**Tables read by `query_v6b_sector_aggregates.sql`:**
- `md_research_sector_peer_daily` — peer matrix (portfolio_context, peer-rank composite)
- `md_research_sector_regime_fwd_agg` — sector × regime forward aggregate
- `md_research_sector_analog_bucket` — sector analog bucket (target + adjacent buckets, base rates, invalidation)
- `md_historical_features_daily` — sector_analog_sample rows + per-symbol path expansion
- `md_forward_returns` — h60 returns joined onto sector_analog_sample

**Tables read by `query_v6c_financial_quality.sql`:**
- `md_historical_features_daily` — anchor row + price/RSI history
- `md_historical_benchmark_daily` — peer-relative performance benchmark
- `md_features_daily` — current liquidity tier
- `md_ratios_quarterly` — quality ratios
- `md_key_metrics_quarterly` — capital allocation metrics
- `md_income_quarterly` — income/quality + growth_compound
- `md_cashflow_quarterly` — FCF efficiency
- `md_cashflow_annual` — long-horizon FCF growth
- `md_financial_growth` — 1Y/3Y/5Y growth rates
- `md_earnings_calendar` — forward catalysts (next earnings) + EXISTS checks
- `md_dividends` — dividend activity + EXISTS checks
- `md_8k_filings` — filing-count window

**`parts` block:**

| Key | Source |
|---|---|
| `parts.core` | Sanitised `coreRow.research_object_core` from `query_v6a_core_live` |
| `parts.sectorAggregates` | Sanitised `sectorRow.research_object_sector` from `query_v6b_sector_aggregates` (or `{}` if skipped) |
| `parts.financialQuality` | Sanitised `qualityRow.research_object_v6c` from `query_v6c_financial_quality` |

**`publicSummary` (built by `buildStockSummary` from PG inputs only):**

Lookups inside the `core` jsonb shape:
`core.meta`, `core.regime_context`, `core.event_context`, `core.trajectory`,
`core.company_state`, `core.analog_evidence_self.self_history`. Inside
`sectorAggregates` jsonb: `portfolio_context`, `invalidation`,
`analog_evidence_sector`. Inside `quality` jsonb: `liquidity_tier`,
`growth_compound`, `financial_quality`, `forward_catalysts`,
`capital_allocation`, `peer_relative_perf`.

| Field | Source |
|---|---|
| `symbol` | `core.meta.symbol` (PG raw) |
| `company` | `core.meta.company_name` (PG raw) |
| `sector` | `core.meta.sector` (PG raw, from `md_symbols.sector` upstream) |
| `industry` | `core.meta.industry` (PG raw, from `md_symbols.industry` upstream) |
| `asOfDate` | `core.meta.as_of_date` (PG raw) |
| `regime` | `core.regime_context.current_regime` (PG raw) |
| `vixBand` | `core.regime_context.vix_band` (PG raw) |
| `regimeFit` | Computed: `deriveRegimeFit(core.regime_context)` from `own_stock_by_regime[].hit_rate_h60` vs sample size |
| `regimeShiftDetected` | Computed: `core.regime_context.regime_shift_detected === true` |
| `eventUrgency` | `forward_catalysts.next_earnings_window` ?? `event_context.earnings_proximity` (PG raw) |
| `evidenceBadge` | Computed constant `"RESEARCH_OBJECT_BACKED"` |
| `peerRankPercentile` | Computed: `bucketPercentileRank(portfolio.composite_rank_in_sector)` (PG raw bucketed) |
| `activeSignals` | Computed by `deriveActiveSignals` from PG bands (`trajectory`, `growth_compound`, `financial_quality`, `capital_allocation`, `forward_catalysts`, `event_context`, `company_state`) |
| `edgeEvidence` | Computed by `deriveEdgeEvidence(fullResearchObject?.edge_evidence)` — currently always falls through to `unavailableEdgeEvidence` because the v6 stock SQL today returns no `edge_evidence` field (`fullResearchObject` is passed as `undefined` from `buildStockResearchObject`). |
| `forwardPerformance` | Computed by `deriveForwardPerformance(analog_evidence_self.self_history)`: `{sampleAdequacy, forwardWrBucket, forwardOutcomeBucket, horizon: "60-day", disclaimer}` |
| `probabilisticEvidence` | Computed by `deriveProbabilisticEvidence(self_history, sectorAggregates.analog_evidence_sector)` → see § 3.6 |
| `pathRisk` | Computed by `derivePathRisk(self_history, sectorAggregates.analog_evidence_sector, undefined)` → see § 3.6 |
| `fundamentalsSnapshot` | Computed by `deriveFundamentalsSnapshot` from `liquidity_tier.market_cap_tier`, `growth_compound.{revenue,eps,fcf}_growth_1y_band`, `financial_quality.{income_quality_band, fcf_ocf_efficiency_band}`, `company_state.balance_sheet.{altman_z_band, leverage_band}`, `portfolio.composite_rank_in_sector` |
| `upcomingEvents` | Computed: `deriveUpcomingEvents(forward_catalysts, event_context)` — emits `{type:EARNINGS\|EX_DIVIDEND, windowBucket}` from `next_earnings_window`, `next_exdiv_window`, `earnings_proximity` |
| `invalidationSignals` | Computed: `deriveInvalidationSignals(...)` from `regime_context.own_stock_by_regime`, `peer_relative_perf.{vs_sector_1m, vs_sector_12w}`, `forward_catalysts.next_earnings_window`, `company_state.balance_sheet.interest_coverage_band` |
| `historicalEvidence` | `analog_evidence_self.self_history.sample_adequacy` (PG raw) |
| `whyNow` | Computed string from `symbol`, `regime`, `regimeFit`, `eventUrgency`, top signal |

**`view` (= `PublicResearchObjectView`, built by `buildStockPublicResearchObjectView`):**

| Field | Source |
|---|---|
| `viewSchemaVersion` | Constant `5` (`PUBLIC_RESEARCH_VIEW_SCHEMA_VERSION`) |
| `cacheKey` | Same as envelope |
| `objectType` | `"stock"` |
| `anchor`, `asOfDate` | Same as envelope |
| `title` | `publicSummary.company` ?? `symbol` |
| `sector`, `industry` | Copied from `publicSummary.sector` / `publicSummary.industry` (PG-derived) |
| `fiveQuestion.whatMattersNow` | Computed `buildStockWhatMattersNow(publicSummary)` — top `activeSignals[].evidenceLanguage`, `fundamentalsSnapshot` line, `regimeFit` line |
| `fiveQuestion.whyNow` | `publicSummary.whyNow` |
| `fiveQuestion.historicalAnalogs` | Computed `buildHistoricalAnalogBullets(probabilisticEvidence, "stock-local and sector-conditioned analogs")` |
| `fiveQuestion.underWhichConditions` | Computed `buildStockConditionBullets(sectorAggregates)` — uses `analog_evidence_sector.bucket_key.{regime, pe_bin, rsi_bin, valuation_bucket}` |
| `fiveQuestion.invalidation` | Copied from `publicSummary.invalidationSignals` |
| `edgeEvidence` | `deriveEdgeEvidence(undefined)` ⇒ unavailable today |
| `probabilisticEvidence` | See § 3.6 (computed from `self_history` + `analog_evidence_sector`) |
| `pathRisk` | See § 3.6 |
| `warnings` | Caller-supplied (currently `[]` from the builder) |

---

### 3.2 Sector Research Object

**SQL invoked:** `query_v6a_sector_live` (param: `SECTOR`) → `research_object` jsonb.

**Tables read by `query_v6a_sector_live.sql`:**
- `md_research_sector_peer_daily` — anchor target_date + per-symbol composite_pct for the sector
- `md_research_sector_regime_fwd_agg` — sector × regime forward aggregate (regime rollup)
- `md_research_sector_analog_bucket` — pe/rsi bucket extremes (best/worst h60)
- `md_historical_features_daily` — sector constituent feature rows + path-risk price paths
- `md_historical_benchmark_daily` — SPX 4w + VIX bands

**`parts.sector`** = sanitised `row.research_object`.

**`publicSummary` (built by `buildSectorSummary`):**

Reads `meta`, `why_now`, `what_matters`, `historical_base_rate`,
`under_which_conditions` jsonb sub-blocks of the SQL row.

| Field | Source |
|---|---|
| `sector` | `meta.sector` (PG raw) |
| `asOfDate` | `meta.as_of_date` (PG raw) |
| `regime` | `meta.current_market_regime` ?? `why_now.current_regime` (PG raw) |
| `vixBand` | `why_now.vix_band` (PG raw) |
| `sp500PerfBand` | `why_now.sp500_perf_4w_band` (PG raw) |
| `symbolsCovered` | `what_matters.symbols` (PG raw count) |
| `industries` | `what_matters.industries` (PG raw count) |
| `leaderCount` | Computed `len(what_matters.top_leaders)` |
| `laggardCount` | Computed `len(what_matters.bottom_laggards)` |
| `unconditionalHitRateBucket` | `bucketHitRatePct(historical_base_rate.h60_hit_rate)` (computation) |
| `unconditionalOutcomeBucket` | `bucketMedianOutcomePct(historical_base_rate.h60_avg_pct)` (computation) |
| `sampleAdequacy` | `bucketSampleAdequacy(historical_base_rate.n_observations)` (computation) |
| `bestRegimeForSector` / `bestRegimeBucket` / `currentRegimeBucket` / `currentRegimeBelowBest` | Computed by `deriveSectorRegimeConditioning` over `under_which_conditions.regime_rollup[].hit_rate_h60` |
| `favorableConditions` | Computed by `deriveSectorFavorableConditions(under_which_conditions.bucket_extremes.best_h60)` — abstracts `(regime, pe_bin, rsi_bin)` rows to qualitative phrases |
| `unfavorableConditions` | Same helper applied to `bucket_extremes.worst_h60` |
| `forwardPerformance` | `deriveSectorForwardPerformance(historical_base_rate)` (computed buckets from `h60_*` percentiles) |
| `regimeFit` | `deriveSectorRegimeFit(regime, regime_rollup)` (computed: rate vs. median ± 5) |
| `activeSignals` | `deriveSectorActiveSignals(researchObject, regime)` — reads `under_which_conditions.regime_rollup`, `under_which_conditions.bucket_extremes.best_h60`, `event_context.earnings_cluster_band` |
| `invalidationSignals` | `deriveSectorInvalidationSignals(researchObject, regime)` — same fields |
| `upcomingEvents` | `deriveSectorUpcomingEvents(researchObject)` — `event_context.{earnings_cluster_band, pct_constituents_earnings_within_2w}` |
| `stocksInFocus` | `what_matters.stocks_in_focus` (PG raw, **no snapshot fallback** — v5) |
| `historicalEvidence` | `bucketSampleAdequacy(historical_base_rate.n_observations)` |
| `whyNow` | Computed string from `sector`, `regime`, `vixBand`, `sp500PerfBand`, `currentRegimeBucket` |

**`view` (`buildSectorPublicResearchObjectView`):**

- `fiveQuestion.whatMattersNow`: lines from `symbolsCovered`, `currentRegimeBucket`, `sampleAdequacy`, plus first 2 `activeSignals[].evidenceLanguage`.
- `fiveQuestion.historicalAnalogs`: bullets from `probabilisticEvidence` (computed below).
- `fiveQuestion.underWhichConditions`: prefixed `favorableConditions` / `unfavorableConditions`.
- `fiveQuestion.invalidation`: `publicSummary.invalidationSignals` plus the “current regime below best” line when `currentRegimeBelowBest`.
- `edgeEvidence`: hard-coded `unavailableEdgeEvidence("Validated edge evidence is not yet bridged for sector Research Objects in Ask Grahamy.")`.
- `probabilisticEvidence`: `deriveAggregateProbabilisticEvidence(historical_base_rate, "60-day")` — see § 3.6.
- `pathRisk`: `deriveSectorPathRisk(researchObject)` over `path_risk_base` (`p10/p25/worst max_drawdown_pct`, `loss_rate_h60_pct`, etc.) — see § 3.6.

---

### 3.3 Industry Research Object

**SQL invoked:** `query_v6a_industry_live` (param: `INDUSTRY`) → `research_object` jsonb.

**Tables read by `query_v6a_industry_live.sql`:**
- `md_industries` — industry anchor row
- `md_symbols` (joined to `md_sectors`) — symbol → industry → parent-sector mapping
- `md_industry_features` — daily PE + average % change snapshots (FMP industry feed)
- `md_historical_features_daily` — industry constituent features + path-risk price paths
- `md_historical_benchmark_daily` — SPX / VIX bands
- `md_forward_returns` — h60 forward returns for the industry base rate

**`parts.industry`** = sanitised SQL row.

**`publicSummary` (built by `buildIndustrySummary`):** reads `meta`,
`why_now`, `what_matters`, `historical_base_rate` sub-blocks.

| Field | Source |
|---|---|
| `industry` | `meta.industry` ?? `what_matters.industry` (PG raw) |
| `parentSector` | `meta.parent_sector` ?? `what_matters.parent_sector` (PG raw) |
| `asOfDate` | `meta.as_of_date` (PG raw) |
| `regime` | `meta.current_market_regime` ?? `why_now.current_regime` (PG raw) |
| `vixBand`, `sp500PerfBand` | `why_now.vix_band`, `why_now.sp500_perf_4w_band` (PG raw) |
| `symbolsCovered`, `symbolsWithValuation` | `what_matters.symbols`, `what_matters.symbols_with_valuation_data` (PG raw) |
| `industryPeToday`, `industryAvgChangeTodayPct` | `what_matters.industry_pe_today`, `what_matters.industry_avg_change_today_pct` (PG raw) |
| `meanWeekPct`, `meanMonthPct` | `what_matters.recent_perf.{mean_week_pct, mean_month_pct}` (PG raw) |
| `pePercentileDistribution.{p25, median, p75}` | `what_matters.industry_pe_percentile_distribution.{p25, median, p75}` (PG raw) |
| `topMembers` | `what_matters.top_members_by_market_cap` (PG raw array) |
| `exampleSymbols` | Computed: first 5 `topMembers[].symbol` |
| `unconditionalHitRateBucket` | `bucketHitRatePct(historical_base_rate.h60_hit_rate)` |
| `unconditionalOutcomeBucket` | `bucketMedianOutcomePct(h60_median_pct ?? h60_avg_pct)` |
| `sampleAdequacy` | `bucketSampleAdequacy(historical_base_rate.n_observations)` |
| `stocksInFocus` | Alias of `symbolsCovered` (kept for prompt-iteration symmetry with sector ROs) |
| `historicalEvidence` | Same bucket as `sampleAdequacy` |
| `whyNow` | Computed string from `industry`, `parentSector`, `regime`, `vixBand`, `sp500PerfBand` |

**`view` (`buildIndustryPublicResearchObjectView`):** same shape as sector view; reuses `deriveAggregateProbabilisticEvidence` and `deriveSectorPathRisk` over the industry SQL’s `historical_base_rate` / `path_risk_base`. `edgeEvidence` is unavailable by design.

---

### 3.4 Regime Research Object (loaded every turn)

**SQL invoked:** `query_v6a_regime_live` (param: `REGIME`) → `research_object` jsonb.

**Tables read by `query_v6a_regime_live.sql`:**
- `md_research_sector_peer_daily` — anchor target_date + sector_leadership_today / top_leaders_today
- `md_research_sector_regime_fwd_agg` — sector_rollup + base-rate aggregates for the regime
- `md_historical_features_daily` — regime constituent features + path-risk price paths (joined onto `md_forward_returns`)
- `md_historical_benchmark_daily` — VIX / SPX 4w / 10y yield bands
- `md_forward_returns` — h60 forward returns for the regime base rate

(Note: this query also fall-back-resolves the current regime via
`SELECT market_regime FROM md_historical_features_daily WHERE symbol='SPY' …`
inside `resolveCurrentRegime`, but that lookup is outside the SQL file.)

`anchor` is always `"MARKET"`; the canonical regime label is resolved by
`resolveCurrentRegime` (RO summary > snapshot tool > PG SPY lookup) and passed
to the SQL as `:REGIME`.

**`parts.regime`** = sanitised SQL row.

**`publicSummary` (built by `buildRegimeSummary`):** reads `meta`, `why_now`,
`what_matters`, `historical_base_rate`, `under_which_conditions` sub-blocks.

| Field | Source |
|---|---|
| `regime` | `meta.regime` ?? `meta.current_market_regime` ?? `regime.label` (legacy) ?? fallback param (PG raw) |
| `asOfDate` | `meta.as_of_date` |
| `isCurrentRegime` | `meta.is_current_market_regime === true` |
| `vixBand` | `why_now.vix_band` ?? `regime.vix_band` (legacy) (PG raw) |
| `sp500PerfBand`, `tenYearYieldBand` | `why_now.sp500_perf_4w_band`, `why_now.ten_year_yield_band` (PG raw) |
| `unconditionalHitRateBucket` | `bucketHitRatePct(historical_base_rate.h60_hit_rate)` |
| `unconditionalOutcomeBucket` | `bucketMedianOutcomePct(historical_base_rate.h60_avg_pct)` |
| `longHorizonHitRateBucket` | `bucketHitRatePct(historical_base_rate.h252_hit_rate)` |
| `sampleAdequacy` | `bucketSampleAdequacy(historical_base_rate.n_observations)` |
| `topSectorsHistorical` / `bottomSectorsHistorical` | Computed `rankSectorsByHitRate(under_which_conditions.sector_rollup)` (top/bottom-3 by `hit_rate_h60`, bucketed) |
| `sectorsActiveToday` | `what_matters.sectors_active_today` (PG raw) |
| `topSectorsTodayRank` | Computed: top-3 `what_matters.sector_leadership_today[]` ordered by `rank_composite` |
| `leaderCount` | Computed `len(what_matters.top_leaders_today)` |
| `forwardPerformance` | `deriveRegimeForwardPerformance(historical_base_rate)` |
| `activeSignals` | `deriveRegimeActiveSignals(...)` — reads `under_which_conditions.sector_rollup` (count of `hit_rate_h60 > 70`) and `historical_base_rate.h60_hit_rate` |
| `invalidationSignals` | `deriveRegimeInvalidationSignals(...)` — `sector_rollup` (count of `hit_rate_h60 < 45`), `historical_base_rate.h60_hit_rate`, `historical_base_rate.h60_avg_pct` |
| `whyNow` | Computed string from `regime`, `vixBand`, `sp500PerfBand`, `tenYearYieldBand`, hit-rate bucket |

**`view` (`buildRegimePublicResearchObjectView`):** mirror of sector/industry view; uses `deriveAggregateProbabilisticEvidence` + `deriveRegimePathRisk`; `edgeEvidence` is unavailable by design.

---

### 3.5 Sibling auto-load (single-stock turns)

When `classification.symbols.length === 1` and no sector/industry/regime is
classified, `loadSiblingSectorAndIndustry` reads the just-built stock RO’s
`publicSummary.sector` / `publicSummary.industry`, then calls
`buildResearchObjectsForAnchors({sectors, industries, ...})` (which delegates
to `buildResearchObjects(...)` with a synthesised `Classification`). The
sibling ROs are exactly the same `sector` / `industry` shapes as above, just
not requested by the classifier.

### 3.6 Shared evidence sub-blocks

Used by both `publicSummary.*` and `view.*` (kept identical by copying the
view’s blocks into `publicSummary`).

**Which query produces each `derive*` input:**

| Function | RO flavour | Input → upstream JSONB key | SQL file → CTE | Base PG tables |
|---|---|---|---|---|
| `deriveProbabilisticEvidence(selfAnalog, sectorAnalog)` | stock | `selfAnalog` = `parts.core.analog_evidence_self.self_history` | `query_v6a_core_live.sql` → CTE `self_analog_summary` (built over `self_analogs_with_fwd` → `self_analogs_top` → `self_analogs_raw`) | `md_historical_features_daily`, `md_forward_returns` |
| `deriveProbabilisticEvidence(selfAnalog, sectorAnalog)` | stock | `sectorAnalog` = `parts.sectorAggregates.analog_evidence_sector` | `query_v6b_sector_aggregates.sql` → CTEs `target_bucket` / `adjacent_buckets` | `md_research_sector_analog_bucket` (with `md_historical_features_daily` + `md_forward_returns` for the path arm) |
| `deriveAggregateProbabilisticEvidence(historical_base_rate, "60-day")` | sector | `parts.sector.historical_base_rate` | `query_v6a_sector_live.sql` (sector `historical_base_rate` block) | `md_research_sector_peer_daily`, `md_research_sector_regime_fwd_agg`, `md_research_sector_analog_bucket`, `md_historical_features_daily`, `md_historical_benchmark_daily` |
| `deriveAggregateProbabilisticEvidence(historical_base_rate, "60-day")` | industry | `parts.industry.historical_base_rate` | `query_v6a_industry_live.sql` (industry `historical_base_rate` block) | `md_industries`, `md_industry_features`, `md_symbols`, `md_historical_features_daily`, `md_historical_benchmark_daily` |
| `deriveAggregateProbabilisticEvidence(historical_base_rate, "60-day")` | regime | `parts.regime.historical_base_rate` | `query_v6a_regime_live.sql` (regime `historical_base_rate` block) | `md_research_sector_regime_fwd_agg`, `md_research_sector_peer_daily`, `md_historical_features_daily`, `md_historical_benchmark_daily` |
| `derivePathRisk(selfAnalog, sectorAnalog, fullResearchObject)` | stock | `selfAnalog.path_risk_base` | `query_v6a_core_live.sql` → CTE `self_path_risk_summary` (built over `self_analog_path_by_event` → `self_analog_path_rows` → `self_analog_path_rows_raw` joined to `self_analogs_with_fwd`) | `md_historical_features_daily`, `md_forward_returns` |
| `derivePathRisk(selfAnalog, sectorAnalog, fullResearchObject)` | stock fallback | `sectorAnalog.path_risk_base` | `query_v6b_sector_aggregates.sql` → CTE `sector_path_risk_summary` (built over `sector_analog_path_by_event` → `sector_analog_path_rows` → `sector_analog_path_rows_raw` → `sector_analog_sample`) | `md_research_sector_analog_bucket`, `md_historical_features_daily`, `md_forward_returns` |
| `derivePathRisk(..., fullResearchObject)` | stock | `fullResearchObject` (used only by `deriveValidatedPathEvidence`) | **Not wired** — `buildStockResearchObject` passes `undefined` (no SQL emits `edge_evidence` / `path_risk` at the top level today) | — |
| `deriveSectorPathRisk(researchObject)` | sector | `researchObject.path_risk_base` | `query_v6a_sector_live.sql` (sector `path_risk_base` block, computed off the same sector-analog price-path CTEs as v6b) | `md_research_sector_analog_bucket`, `md_historical_features_daily`, `md_forward_returns` |
| `deriveSectorPathRisk(researchObject)` | industry | `researchObject.path_risk_base` | `query_v6a_industry_live.sql` (industry `path_risk_base` block — same CTE shape as the sector path risk, scoped by industry) | `md_industry_features`, `md_historical_features_daily`, `md_forward_returns` |
| `deriveRegimePathRisk(researchObject)` | regime | `researchObject.path_risk_base` | `query_v6a_regime_live.sql` (regime `path_risk_base` block over all constituents in the regime) | `md_historical_features_daily`, `md_forward_returns` |
| `deriveAggregatePathRisk(historical_base_rate)` | aggregate fallback | `historical_base_rate.h60_hit_rate` | Same `historical_base_rate` block as the matching `derive*ProbabilisticEvidence` row above | (same as that row) |

Notes on the stock path:
- The `analog_evidence_sector` and its `path_risk_base` only exist on the
  stock RO when `query_v6b_sector_aggregates.sql` actually ran — that requires
  `core.profile_keys.{sector, current_regime, valuation_bucket, pe_bin, rsi_bin}`
  to all be present (skipped in `buildSectorAggregates` otherwise).
- The “self vs. sector-conditioned” pick inside
  `deriveProbabilisticEvidence` keys off `h60_hit_rate` availability —
  whichever side has data wins, with self preferred when both do.

**`probabilisticEvidence` (`deriveProbabilisticEvidence` / `deriveAggregateProbabilisticEvidence`):**

| Field | Source |
|---|---|
| `viewSchemaVersion` | Constant `5` |
| `state` | Computed: based on hit-rate availability + `sample_adequacy` |
| `horizon` | Constant `"60-day"` (or `"252-day"` for aggregate) |
| `referenceSet` | Computed: `self_analogs` / `sector_conditioned_analogs` / `aggregate_base_rate` based on which input has data |
| `sampleSize` | `selected.n_with_h60 ?? selected.n` (PG raw) — for aggregate: `n_observations ?? n_with_h60 ?? n` |
| `hitRatePct`, `medianReturnPct`, `p25ReturnPct`, `p75ReturnPct` | `selected.h60_hit_rate / h60_median_pct / h60_p25_pct / h60_p75_pct` (PG raw) |
| `sampleAdequacy` | `selected.sample_adequacy` (PG raw) — aggregate path also computes from `sampleSize` if missing |
| `hitRateBucket`, `medianOutcomeBucket`, `downsideQuartileBucket`, `upsideQuartileBucket` | Computed by `bucket*Pct(...)` |
| `conditionedHitRateBucket`, `conditionedOutcomeBucket` | Computed buckets of `sectorAnalog.h60_hit_rate / h60_median_pct` (stock RO only) |
| `notes` | Static strings about base-rate / sector-conditioned availability |

**`pathRisk` (`derivePathRisk` / `deriveSectorPathRisk` / `deriveRegimePathRisk` / `deriveAggregatePathRisk`):**

When PG `path_risk_base` row is present (source field `pathBase.source` starts with `pg_daily_price_path`):

| Field | Source |
|---|---|
| `state` | Computed from sample adequacy and presence of numeric drawdown |
| `horizon` | Constant `"60-day"` |
| `source` | Constant `"pg_daily_price_path"` |
| `sampleSize`, `observedPathCount` | `pathBase.n` (PG raw) |
| `sampleAdequacy` | `pathBase.sample_adequacy` (PG raw) |
| `p10MaxDrawdownPct`, `worstMaxDrawdownPct` | `pathBase.p10_max_drawdown_pct`, `pathBase.worst_max_drawdown_pct` (PG raw) |
| `probDrawdownGt5/10/15/20Pct` | `pathBase.prob_drawdown_gt_{5,10,15,20}_pct` (PG raw) |
| `recoveredByHorizonRatePct` | `pathBase.recovered_by_horizon_rate_pct` (PG raw) |
| `lossProbabilityBucket`, `severeLossProbabilityBucket` | Computed `bucketLossRatePct(pathBase.loss_rate_h60_pct / severe_loss_rate_h60_pct)` |
| `downsideTailBucket`, `adverseExcursionBucket`, `maxDrawdownBucket` | Computed `bucketTailOutcomePct(pathBase.p25_*)` |
| `recoveryProfile` | Computed `bucketRecoveryDays(pathBase.median_recovery_days)` |
| `validatedEvidence.{edgeSpecificPathRisk, sentinelRealizedDrawdown, coronerDecay}` | Computed by `deriveValidatedPathEvidence(fullResearchObject)` — currently always `unavailable` for stock ROs because `fullResearchObject` is `undefined`. Always `unavailable` for sector/industry/regime ROs by design. |
| `warnings`, `notes` | Static / sample-driven |

When `path_risk_base` is missing the path-risk falls back to a base-rate-only
view (source `analog_return_distribution`) using `selfAnalog.h60_hit_rate /
h60_p25_pct` (stock) or `historical_base_rate.h60_hit_rate` (sector / industry / regime).

**`edgeEvidence` (`deriveEdgeEvidence`):**

Driven entirely by `fullResearchObject.edge_evidence.claims[]`. Today the v6
SQL doesn’t produce that field for any flavour, so:
- Stock RO: passed `undefined` ⇒ `unavailable`.
- Sector / industry / regime ROs: hard-coded `unavailable` with the message
  “Validated edge evidence is not yet bridged for X Research Objects in Ask
  Grahamy.”

The validated-edge bonus overlay lives separately as the **pipeline overlay**
(see § 5).

---

## 4. `PgCapabilityViews` (built by `loadPgCapabilities`)

`loadPgCapabilities` calls `executePgCapabilitiesWithCache(...)` which:

1. Picks the registry entry whose `intent` matches `classification.intent`
   (one capability per intent — see `pgCapabilities/registry.ts`).
2. Builds a deterministic capability cache key:
   `CAP:{capability}:{asOfDate}` (or `CAP:{capability}:{asOfDate}:k1=v1|k2=v2`
   when the capability has params). `asOfDate` = `state.asOfDate` ?? snapshot
   `dataThrough`. Each capability supplies its own `cacheKeyParams(input)`.
3. Cache hit (matching key + matching `viewSchemaVersion`) → returns the
   stored view, then **fan-outs** the embedded `researchObjectKeys` /
   `regimeResearchObjectKey` / `rows[].researchObjectKey` to
   `buildResearchObjectsForAnchors(...)` so the agent prompt has the deep
   per-row payload (cache reuses `priorResearchObjects` again).
4. Cache miss → runs the registry entry’s `run(input)` (the per-capability
   `build*View` function), which executes the SQL via `runPgCapabilityQuery`
   (which calls `queryExternalReadonly` against the external PG warehouse with
   the loaded `.sql` text and replacements) and then fans out the result rows
   to `buildResearchObjectsForAnchors(...)` to attach RO keys to each row.

For every capability the result row of `executePgCapabilitiesWithCache`
attaches both `researchObjects` (everything resolved from cache or built) and
`researchObjectsUpdated` (cache misses only) onto graph state.

The seven capabilities, the SQL they run, and the row-shape they consume:

| Intent | Capability | SQL (file) | Source label | Freshness MV(s) | View slot |
|---|---|---|---|---|---|
| `sector_conviction_leaderboard` | sector_conviction_leaderboard | `query_sector_conviction_leaderboard.sql` | `pg_sector_peer_daily` | `md_research_sector_peer_daily`, `md_research_sector_regime_fwd_agg` | `sectorLeaderboardView` |
| `sector_momentum_vs_conviction_divergence` | sector_momentum_vs_conviction_divergence | `query_sector_divergence.sql` | `pg_sector_peer_daily` | `md_research_sector_peer_daily`, `md_research_sector_regime_fwd_agg` | `sectorDivergenceView` |
| `week_over_week_sector_delta` | week_over_week_sector_delta | `query_sector_delta.sql` | `pg_sector_weekly_history` | `md_research_sector_monday_hist` | `sectorDeltaView` |
| `stock_idea_discovery` | stock_idea_discovery | `query_stock_idea_discovery.sql` | `pg_features_daily` | `md_features_daily`, `md_research_sector_peer_daily`, `md_forward_returns` | `stockIdeaView` |
| `sector_leaders` | sector_leaders | `query_sector_leaders.sql` | `pg_features_daily` | same as discovery | `stockIdeaView` |
| `industry_leaders` | industry_leaders | `query_industry_leaders.sql` | `pg_features_daily` | `md_features_daily`, `md_forward_returns` | `stockIdeaView` |
| `feature_screen` | feature_screen | `query_feature_screen.sql` | `pg_current_features` | `md_features_daily`, `md_research_sector_peer_daily`, `md_forward_returns` | `featureScreenView` |
| `factor_conditioned_backtest` | factor_conditioned_backtest | `query_factor_conditioned_backtest.sql` | `pg_factor_history` | `sweep_universe` | `factorBacktestView` |
| `market_regime_historical_playbook` | market_regime_historical_playbook | `query_regime_historical_playbook.sql` | `pg_regime_history` | `md_research_sector_regime_fwd_agg`, `md_macro_daily_snapshot` | `regimeHistoricalPlaybookView` |

### 4.1 `CachedCapabilityView` envelope (every cached capability)

| Field | Source |
|---|---|
| `cacheKey` | Computed `CAP:{name}:{asOfDate}[:params]` |
| `capabilityName` | Constant per registry entry |
| `viewSchemaVersion` | Local `VIEW_SCHEMA_VERSION = 2` per builder |
| `asOfDate` | `state.asOfDate` ?? `snapshots.freshness.dataThrough` |
| `priorAsOfDate` | Sector-delta only — copied from `view.priorAsOfDate` |
| `anchorSymbol` / `anchorSector` / `anchorIndustry` | Set when the registry entry has `cacheAnchors(input)` (sector_leaders, industry_leaders) |
| `view` | The capability’s view (per-capability fields below) |
| `generatedAt` | Computed: `new Date().toISOString()` |

### 4.2 `SectorLeaderboardView` (sector_conviction_leaderboard)

**SQL:** `query_sector_conviction_leaderboard.sql` with replacements `MAX_ROWS`, `RANK_BY` (inferred from message: `"divergence"` / `"historical_forward"` / `"conviction"`).

**Tables read by `query_sector_conviction_leaderboard.sql`:**
- `md_research_sector_peer_daily` — current peer matrix (anchor target_date + sector composite)
- `md_historical_features_daily` — per-sector momentum / breadth context
- `md_research_sector_regime_fwd_agg` — historical forward overlay for ranking
- `md_research_refresh_stale` — freshness state for the MVs above

**Row shape (`SectorConvictionLeaderboardRow`):** `sector`, `rank`, `conviction_score_pct`, `conviction_bucket`, `evidence_strength`, `hit_rate_pct`, `momentum_bucket`, `price_momentum_separation`, `defensive_cyclical_label`, `as_of_date`, `peer_freshness_state`, `peer_completed_at`, `forward_freshness_state`, `forward_completed_at`, `overlay_available`, `evaluated_sector_count`, `clear_divergence_count`.

| View field | Source |
|---|---|
| `viewSchemaVersion` | Constant `2` |
| `state` | Computed: `"complete"` if any row has `overlay_available=true`, else `"partial"` (or `"unavailable"`) |
| `source` | Constant `"pg_sector_peer_daily"` |
| `period` | Constant `"latest"` |
| `rankingBasis` | `inferRankingBasis(message)` (computed from message keywords) |
| `asOfDate` | `rows[0].as_of_date` (PG raw) |
| `rows[i].sector` | `row.sector` (PG raw) |
| `rows[i].rank` | `row.rank` (PG raw) |
| `rows[i].convictionScorePct` | `roundNumber(row.conviction_score_pct, 1)` |
| `rows[i].convictionBucket` | `row.conviction_bucket` (PG raw) |
| `rows[i].evidenceStrength` | `row.evidence_strength` (PG raw) |
| `rows[i].hitRatePct` | `roundNumber(row.hit_rate_pct, 1)` |
| `rows[i].momentumBucket` | `row.momentum_bucket` (PG raw) |
| `rows[i].priceMomentumSeparation` | `row.price_momentum_separation` (PG raw) |
| `rows[i].defensiveCyclicalLabel` | `row.defensive_cyclical_label` (PG raw) |
| `rows[i].researchObjectKey` | Initially `buildResearchObjectCacheKey("SECTOR", row.sector, asOfDate)`; **rewritten by the fan-out** to the actual sector-RO `cacheKey` produced by `buildResearchObjectsForAnchors({sectors, ...})` |
| `researchObjectKeys` | Deduped collection of `rows[].researchObjectKey` |
| `freshness` | `assessCapabilityFreshness({sources: [{md_research_sector_peer_daily ⇒ peer_completed_at/peer_freshness_state}, {md_research_sector_regime_fwd_agg ⇒ forward_completed_at/forward_freshness_state}]})` |
| `warnings` | Static + freshness-driven (e.g. “Historical forward-return overlay is unavailable …”) |

### 4.3 `SectorDivergenceView` (sector_momentum_vs_conviction_divergence)

**SQL:** `query_sector_divergence.sql` with replacement `MAX_ROWS`.

**Tables read by `query_sector_divergence.sql`:**
- `md_research_sector_peer_daily` — anchor target_date + per-sector conviction composite
- `md_historical_features_daily` — sector momentum/price-action features
- `md_research_sector_regime_fwd_agg` — historical forward overlay (hit-rate / median forward return)
- `md_research_refresh_stale` — freshness state for the MVs above

**Row shape (`SectorDivergenceRow`):** `sector`, `rank`, `conviction_score_pct`, `conviction_bucket`, `momentum_score_pct`, `momentum_bucket`, `divergence_type`, `evidence_strength`, `hit_rate_pct`, `median_forward_return_pct`, `as_of_date`, `peer_freshness_state`, `peer_completed_at`, `forward_freshness_state`, `forward_completed_at`, `overlay_available`.

| View field | Source |
|---|---|
| `state` | Computed: `"complete"` / `"partial"` / `"unavailable"` based on row count and `overlay_available` |
| `source` | Constant `"pg_sector_peer_daily"` |
| `period` | Constant `"latest"` |
| `asOfDate` | `rows[0].as_of_date` |
| `evaluatedSectorCount` | `rows[0].evaluated_sector_count` ?? `rows.length` |
| `clearDivergenceCount` | `rows[0].clear_divergence_count` ?? filtered row count |
| `rows[i].convictionScorePct/Bucket`, `momentumScorePct/Bucket`, `divergenceType`, `hitRatePct`, `medianForwardReturnPct`, `evidenceStrength` | All raw from PG row, with the score fields rounded |
| `rows[i].interpretationBullets` | Computed `buildInterpretationBullets(...)` from the row’s buckets |
| `rows[i].researchObjectKey` | `buildResearchObjectCacheKey("SECTOR", sector, asOfDate)` then rewritten by fan-out |
| `researchObjectKeys` | Dedup of `rows[].researchObjectKey` |
| `freshness` | `assessCapabilityFreshness({peer_*, forward_*})` |
| `warnings` | Static + freshness/no-clear-divergence |

Note: only rows with `divergence_type === "conviction_but_weak_price_action"` are kept.

### 4.4 `SectorDeltaView` (week_over_week_sector_delta)

**SQL:** `query_sector_delta.sql` with replacements `MAX_ROWS`, `RANK_BY` (`conviction_delta` / `momentum_delta` / `deterioration` / `overall_change`), `DIRECTION_FILTER` (`all` / `improved` / `deteriorated` / `momentum_improved` / `momentum_deteriorated`).

**Tables read by `query_sector_delta.sql`:**
- `md_research_sector_monday_hist` — current + prior weekly sector baseline (current/prior conviction + momentum scores, evaluated/meaningful counts)
- `md_research_refresh_stale` — freshness state for the weekly MV

**Row shape (`SectorDeltaRow`):** `sector`, `rank`, `current_conviction_score_pct`, `prior_conviction_score_pct`, `conviction_delta_pct`, `current_conviction_bucket`, `prior_conviction_bucket`, `current_momentum_score_pct`, `prior_momentum_score_pct`, `momentum_delta_pct`, `current_momentum_bucket`, `prior_momentum_bucket`, `direction`, `include_in_public`, `current_as_of_date`, `prior_as_of_date`, `weekly_freshness_state`, `weekly_completed_at`, `evaluated_sector_count`, `meaningful_delta_count`.

| View field | Source |
|---|---|
| `source` | Constant `"pg_sector_weekly_history"` |
| `period` | Constant `"week_over_week"` |
| `currentAsOfDate`, `priorAsOfDate` | `rows[0].current_as_of_date`, `rows[0].prior_as_of_date` |
| `rankingBasis` | `inferRankingBasis(message)` |
| Per-row `current/priorConvictionScorePct`, `convictionDeltaPct`, `current/priorConvictionBucket`, `current/priorMomentumBucket`, `momentumDeltaPct`, `direction` | Raw from PG (rounded numbers) |
| Per-row `interpretationBullets` | Computed from buckets/direction |
| Per-row `researchObjectKey` | `buildResearchObjectCacheKey("SECTOR", sector, currentAsOfDate)`, rewritten by fan-out |
| `researchObjectKeys` | Dedup |
| `freshness` | `assessCapabilityFreshness({md_research_sector_monday_hist ⇒ weekly_*})` |
| `warnings` | Freshness + no-meaningful-delta |

### 4.5 `StockIdeaView` (stock_idea_discovery — and reused by sector_leaders / industry_leaders)

**SQL:**
- `query_stock_idea_discovery.sql` with `MAX_ROWS`, `CANDIDATE_POOL_SIZE`, `RANK_BY`.
- `query_sector_leaders.sql` with `MAX_ROWS`, `CANDIDATE_POOL_SIZE`, `RANK_BY`, `SECTOR_FILTER`.
- `query_industry_leaders.sql` with `MAX_ROWS`, `CANDIDATE_POOL_SIZE`, `RANK_BY`, `INDUSTRY_FILTER`.

**Tables read by `query_stock_idea_discovery.sql`:**
- `md_features_daily` — current candidate pool + features (anchor target_date)
- `md_symbols` — symbol metadata join
- `md_exchanges` — exchange filter
- `md_research_sector_peer_daily` — per-symbol sector-relative conviction overlay
- `md_forward_returns` — historical forward overlay (hit-rate / median / p25 / p75)
- `md_research_refresh_stale` — freshness state

**Tables read by `query_sector_leaders.sql`:** identical set to `query_stock_idea_discovery.sql` (`md_features_daily`, `md_symbols`, `md_exchanges`, `md_research_sector_peer_daily`, `md_forward_returns`, `md_research_refresh_stale`) — same shape, just additionally filtered by `SECTOR_FILTER`.

**Tables read by `query_industry_leaders.sql`:**
- `md_features_daily` — candidate pool + features
- `md_symbols` — joined to `md_industries` via `industry_id`
- `md_exchanges` — exchange filter
- `md_industries` — industry filter target
- `md_research_sector_peer_daily` — sector-level peer overlay (no industry-level peer MV exists)
- `md_forward_returns` — forward overlay
- `md_research_refresh_stale` — freshness state

`RANK_BY` is `setup_quality` / `conviction` / `historical_forward` / `risk_adjusted` (inferred from the message). All three capabilities share the `StockIdeaDiscoveryRow` row shape and produce a `StockIdeaView`.

**Row shape:** `symbol`, `company_name`, `sector`, `rank`, `conviction_score_pct`, `conviction_bucket`, `evidence_strength`, `hit_rate_pct`, `median_return_pct`, `p25_return_pct`, `p75_return_pct`, `momentum_bucket`, `quality_bucket`, `valuation_bucket`, `path_risk_bucket`, `as_of_date`, `features_freshness_state`, `features_completed_at`, `peer_freshness_state`, `peer_completed_at`, `forward_overlay_available`.

| View field | Source |
|---|---|
| `source` | Constant `"pg_features_daily"` |
| `asOfDate` | `rows[0].as_of_date` |
| `rankingBasis` | Inferred from message |
| `rows[i].symbol/companyName/sector/rank` | Raw from PG (`symbol` upper-cased) |
| `rows[i].convictionScorePct`, `evidenceStrength`, `hitRatePct`, `medianReturnPct`, `p25ReturnPct`, `p75ReturnPct`, `momentumBucket`, `qualityBucket`, `valuationBucket`, `pathRiskBucket` | All raw from PG (numbers rounded) |
| `rows[i].convictionBucket` | Raw from PG |
| `rows[i].reasonBullets` | Computed from row buckets (e.g. “Conviction bucket is …”) |
| `rows[i].researchObjectKey` | `buildResearchObjectCacheKey("STOCK", symbol, asOfDate)`, rewritten by fan-out (`buildResearchObjectsForAnchors({symbols, ...})`) — for `industry_leaders` an industry RO is **also** built |
| `researchObjectKeys` | Dedup |
| `freshness` | `assessCapabilityFreshness({md_features_daily ⇒ features_*, md_research_sector_peer_daily ⇒ peer_*})` |
| `warnings` | Static (“These are research candidates …”, “V1 stock idea discovery does not include daily path-risk drawdown metrics.”) + freshness/overlay |

### 4.6 `FeatureScreenView` (feature_screen)

**SQL:** `query_feature_screen.sql` with `MAX_ROWS`, `CANDIDATE_POOL_SIZE`, plus per-criterion `*_BUCKET` filters extracted from `classification.featureCriteria` (`valuation` / `quality` / `momentum` / `growth` / `leverage` / `sector` / `risk`).

**Tables read by `query_feature_screen.sql`:**
- `md_features_daily` — current feature pool (anchor target_date + per-bucket filters)
- `md_symbols` — symbol metadata
- `md_exchanges` — exchange filter
- `md_research_sector_peer_daily` — sector-relative conviction overlay
- `md_forward_returns` — forward overlay
- `md_research_refresh_stale` — freshness state

**Row shape:** `symbol`, `company_name`, `sector`, `rank`, `valuation_bucket`, `quality_bucket`, `momentum_bucket`, `growth_bucket`, `leverage_bucket`, `risk_bucket`, `conviction_bucket`, `hit_rate_pct`, `median_return_pct`, `as_of_date`, `current_row_count`, `matched_row_count`, `features_freshness_state`, `features_completed_at`, `peer_freshness_state`, `peer_completed_at`, `forward_overlay_available`.

| View field | Source |
|---|---|
| `source` | Constant `"pg_current_features"` |
| `screenCriteria` | The `FeatureScreenCriterion[]` echoed from input (PG-input lineage) |
| `asOfDate` | `rows[0].as_of_date` |
| `rows[i].*Bucket` and `convictionBucket`, `hitRatePct`, `medianReturnPct` | Raw from PG (numbers rounded) |
| `rows[i].reasonBullets` | Computed from `criteria` + `convictionBucket` |
| `rows[i].researchObjectKey` | `STOCK:{symbol}:{asOfDate}` then rewritten by fan-out |
| `researchObjectKeys` | Dedup |
| `freshness` | `assessCapabilityFreshness({features_*, peer_*})` |
| `warnings` | Static + match-count + freshness |

### 4.7 `FactorBacktestView` (factor_conditioned_backtest)

**SQL:** `query_factor_conditioned_backtest.sql` with `HORIZON` (e.g. `60-day`), `MAX_SAMPLE_SIZE`, plus per-criterion `*_BUCKET` filters from `classification.factorBacktest.criteria`.

**Tables read by `query_factor_conditioned_backtest.sql`:**
- `sweep_universe` — the only base table; supplies the historical PIT sweep with horizon-shifted forward returns and per-criterion bucket columns. `as_of_date` is anchored from `MAX(as_of_date) FROM sweep_universe` and the horizon offsets all derive from the same MV.

**Row shape (`FactorBacktestRow`):** `as_of_date`, `horizon`, `sample_size`, `hit_rate_pct`, `median_return_pct`, `p25_return_pct`, `p75_return_pct`, `matched_row_count`, `source_row_count`, `capped_sample`, `contributing_symbols`.

| View field | Source |
|---|---|
| `source` | Constant `"pg_factor_history"` |
| `horizon` | From input (default `60-day`) |
| `criteria` | Echo of input criteria |
| `sampleSize` | `rows[0].sample_size` (PG raw) |
| `hitRatePct`, `medianReturnPct`, `p25ReturnPct`, `p75ReturnPct` | Raw from PG (rounded) |
| `sampleAdequacy` | Computed `adequacyForSample(sampleSize)` — ROBUST / ADEQUATE / THIN / UNKNOWN |
| `contributingResearchObjectKeys` | `rows[0].contributing_symbols` mapped to `STOCK:{symbol}:{asOfDate}`, rewritten after `buildResearchObjectsForAnchors({symbols, ...})` fan-out |
| `freshness` | `assessCapabilityFreshness({sweep_universe ⇒ as_of_date})` |
| `warnings` | Static (“historical/base-rate factor evidence, not a prediction”) + freshness + sample/criteria notes |

### 4.8 `RegimeHistoricalPlaybookView` (market_regime_historical_playbook)

**SQL:** `query_regime_historical_playbook.sql` with `MAX_ROWS`, `ROLE_FILTER` (`leaders` / `laggards` / `risks` / `general` — inferred from message).

**Tables read by `query_regime_historical_playbook.sql`:**
- `md_historical_features_daily` — current regime label + sample-size context
- `md_research_sector_regime_fwd_agg` — per-sector × regime historical hit-rate / forward returns (the row body)
- `md_historical_benchmark_daily` — VIX / dispersion / breadth context
- `md_macro_daily_snapshot` — macro risk buckets (rate / yield / commodity context)
- `md_research_refresh_stale` — freshness state for the regime + macro MVs

**Row shape (`RegimeHistoricalPlaybookRow`):** `regime`, `as_of_date`, `sector`, `rank`, `role`, `include_in_public`, `sample_size`, `hit_rate_pct`, `median_forward_return_pct`, `evidence_strength`, `vix_risk_bucket`, `breadth_risk_bucket`, `dispersion_risk_bucket`, `trend_risk_bucket`, `risk_context_available`, `regime_freshness_state`, `regime_completed_at`, `macro_freshness_state`, `macro_completed_at`, `evaluated_sector_count`, `meaningful_sector_count`.

| View field | Source |
|---|---|
| `source` | Constant `"pg_regime_history"` |
| `regime`, `asOfDate` | `rows[0].regime`, `rows[0].as_of_date` |
| `rows[i].sector/rank/role` | Raw from PG (filtered by `include_in_public`) |
| `rows[i].hitRatePct`, `medianForwardReturnPct`, `evidenceStrength` | Raw from PG (numbers rounded) |
| `rows[i].interpretationBullets` | Computed from role / regime / hit-rate availability |
| `rows[i].researchObjectKey` | `SECTOR:{sector}:{asOfDate}`, rewritten by fan-out |
| `risks[]` | `buildRisks(first)` over `vix_risk_bucket`, `breadth_risk_bucket`, `dispersion_risk_bucket`, `trend_risk_bucket` (PG raw bucketed) |
| `summaryBullets` | Computed from regime + rows + risks |
| `researchObjectKeys` | Dedup of row RO keys |
| `regimeResearchObjectKey` | `REGIME:MARKET:{asOfDate}`; fan-out also requests the regime RO so this is the canonical regime RO key |
| `freshness` | `assessCapabilityFreshness({md_research_sector_regime_fwd_agg ⇒ regime_*, md_macro_daily_snapshot ⇒ macro_*})` |
| `warnings` | Freshness + no-meaningful-rows |

---

## 5. `PipelineOverlayViews` (built by `loadPipelineOverlays`)

`loadPipelineOverlays` calls `executePipelineOverlays` → today only
`executeValidatedEdgeEvidenceOverlay`. Runs only when
`classification.focus === "validated_evidence"` (no-op otherwise).

**Source:** Grahamy Client API (HTTP) — see `pipelineOverlays/client.ts`.
- `GET ${GRAHAMY_CLIENT_API_BASE_URL}/v1/manifest/current` → freshness manifest.
- One of (priority order): `…/v1/research/ticker/{SYMBOL}` (when classifier
  has a symbol) → `…/v1/research/sector/{SECTOR}` → `…/v1/research/regime/current`.

Sentinel/coroner/dailyDecision/researchCard/acceptedDiscovery overlays are
declared in `pipelineOverlays/registry.ts` with `mapperStatus:"placeholder"` —
nothing runs them today. The **only** populated overlay slot is
`validatedEdgeEvidenceView`.

### 5.1 `ValidatedEdgeEvidenceView`

**Pre-compute:** `buildAnchor(classification)` — `{type, symbol|sector|regime, label}`. `freshness` derived from the manifest envelope via `mapManifestToPublicFreshness`.

**Body source:** `extractDataObject(rawEnvelope)` then nested record extraction; see `mapValidatedEdgeEvidenceView`.

| View field | Source |
|---|---|
| `viewSchemaVersion` | Constant `1` |
| `state` | Computed: `"complete"` if the upstream returned an explicit `evidence_state`, else `"partial"`; `"unavailable"` when no public evidence is found |
| `source` | Constant `"client_api_research_object"` |
| `anchor` | Built from classification |
| `evidenceState` | `data.evidence_state` ?? `pipeline_evidence.evidence_state` (normalised via `normalizeEvidenceState`); falls back to a count-based bucketing when missing |
| `edgeCountBucket` | Computed from `pipeline_evidence.total_edges` / `pipeline_evidence.active_edges.total` / `accepted_edges` / `data.edge_count` (raw → bucket) |
| `eventSampleBucket` | Computed from `pipeline_evidence.events_total` / `eventsTotal` / `event_count` |
| `horizonEvidence[]` | Built by `buildHorizonEvidence(active_edges ?? pipeline_evidence)`. Two paths: (a) explicit `horizon_evidence` array (`hit_rate_pct`, `alpha`, `evidence_strength`); (b) keyed maps `mean_hit_rate_by_horizon` / `mean_alpha_by_horizon` / `edges_by_horizon` joined by horizon key. Numbers normalised + bucketed. |
| `baseRateSummary.hitRatePct` | `base_rate.hit_rate_pct` ?? `hit_rate` ?? `value` (normalised pct) |
| `baseRateSummary.medianReturnPct` | `base_rate.median_return_pct` ?? `median_return` (normalised pct) |
| `baseRateSummary.sampleAdequacy` | `base_rate.sample_adequacy` (raw, slice-trimmed) |
| `pipelineRiskBand` | `path_risk.band` ?? `path_risk.risk_band` ?? `pipeline_evidence.risk_band` ?? `data.pipeline_risk_band` (raw) |
| `liveConfirmationBucket` | Computed by `buildLiveConfirmationBucket` from `pipeline_evidence.sentinel.{active_patterns, lifecycle_states}` (or flat `sentinel_active_patterns` / `sentinel_lifecycle_states`) — emits `confirmed` / `mixed` / `not_confirmed` / `deteriorating` / `insufficient_live_data` |
| `decayRiskBucket` | Computed by `buildDecayRiskBucket` from `pipeline_evidence.coroner_recent_failures_90d` — emits `no_recent_decay_warning` / `watch` / `decay_elevated` |
| `interpretationBullets` | Computed from the buckets above |
| `freshness` | From `mapManifestToPublicFreshness(manifestRawEnvelope)` (PG-side `data.last_completed_at` etc.) |
| `warnings` | Aggregated: freshness warnings + state warnings + qualification warnings (live tracking deteriorating, decay elevated) |

After mapping, `createPublicOverlayResult(view)` re-applies the
`forbiddenFields` policy (`pipeline_overlay_public_safe`) — final `view` may
have specific fields scrubbed if they leak forbidden lineage.

---

## 6. Plumbing recap (where to look in the code)

| Concern | File |
|---|---|
| Graph node wiring | `graph.ts` |
| State shape + classification | `askGrahamyState.ts`, `types.ts` |
| Snapshot fetch + freshness derivation | `snapshotClient.ts` |
| Stock/sector/industry/regime RO build | `researchObjectBuilder.ts` |
| v6 SQL files (research objects) | `pgCapabilities/queries/query_v6a_*.sql`, `query_v6b_sector_aggregates.sql`, `query_v6c_financial_quality.sql` |
| v6 SQL loader | `researchQueryClient.ts` |
| External readonly PG client | `utils/externalReadonlyDb.ts` (called from both research + capability paths) |
| Capability registry | `pgCapabilities/registry.ts` |
| Per-capability builders | `pgCapabilities/{sectorConvictionLeaderboard,sectorDivergence,sectorDelta,stockIdeaDiscovery,sectorLeaders,industryLeaders,featureScreen,factorConditionedBacktest,regimeHistoricalPlaybook}.ts` |
| Capability SQL files | `pgCapabilities/queries/query_*.sql` |
| Capability SQL loader | `pgCapabilities/queryClient.ts` |
| Capability freshness assessor | `pgCapabilities/freshnessGuard.ts` (called from each builder) |
| Pipeline overlay registry | `pipelineOverlays/registry.ts` |
| Validated-edge overlay | `pipelineOverlays/validatedEdgeEvidence.ts` |
| Pipeline overlay HTTP client | `pipelineOverlays/client.ts` |
| Pipeline overlay public-mapper / forbidden-field guard | `pipelineOverlays/publicMapper.ts`, `pipelineOverlays/forbiddenFields.ts` |

---

## 7. Quick rules-of-thumb

- **publicSummary / view = PG-only.** If you need to know which SQL row a
  field came from, look in the `parts.*` block of the same RO — the field
  comes from one of those v6a/v6b/v6c sub-jsonb shapes.
- **`pipeline.snapshot` ≠ source of truth.** It is per-anchor `daily_brief`
  context kept for traceability/lineage. The agent prompt reads it only when
  pipeline lineage is the question itself. Stock ROs carry it; industry and
  regime ROs do not.
- **Capability views fan out into Research Objects.** Every capability’s
  `rows[i].researchObjectKey` and the top-level `researchObjectKeys` /
  `regimeResearchObjectKey` are written to point at exactly the same
  `CachedResearchObject` cache the standard anchored path uses — cache hits
  via `priorResearchObjects` cover the fan-out so it is usually free.
- **`asOfDate`** flows top-down from the request: SS supplies it on
  `priorResearchObjects` / `priorCapabilityViews` lookups and on the request
  itself. Agent-service uses it as the cache-key date for everything built
  this turn so SS-side priors actually hit. When missing it falls back to
  `snapshots.freshness.dataThrough` (which can lag the real PG date — that is
  the bug the parameter exists to avoid).
- **Validated edge evidence is two separate things.** The deep RO has an
  `edgeEvidence` block (`view.edgeEvidence` / `publicSummary.edgeEvidence`)
  that today is always `unavailable`. The pipeline overlay
  `validatedEdgeEvidenceView` is the actual validated-pipeline source — fed
  by the Grahamy Client API, not PG.
