-- ═════════════════════════════════════════════════════════════════════════════
-- Grahamy — Research Object Query V6a SECTOR LIVE (Fast Path, MV-only)
-- ═════════════════════════════════════════════════════════════════════════════
-- ANCHOR: a SECTOR (Technology, Healthcare, ...). Same 5-question contract as
-- V5.2 SECTOR, but strictly MV-only — no sector_timeline aggregation, no
-- analyst-revision LATERAL joins. Targets <300ms cold, <100ms warm.
--
-- When to use which:
--   V5.2 SECTOR — deep mode: sector-self-analogs (timeline distance matching),
--                 crowding vs own-history (RSI + share rich-plus), analyst
--                 rating tilt, 8-K event density. ~300-800ms.
--   V6a SECTOR  — fast mode: aggregated base rates per regime/valuation from MV,
--                 today's sector leaderboard, live macro context. ~50-100ms.
--
-- PIT / MOAT / SURVIVORSHIP — same guarantees as V5.2 SECTOR (MV is Monday-
-- sampled, is_delisted=false, pe_ratio>0 & price>0).
--
-- USAGE:
--   docker exec -i stock_analyzer_db psql -U stock_user -d stock_analyzer \
--     -v SECTOR="'Technology'" < query_v6a_sector_live.sql
-- ═════════════════════════════════════════════════════════════════════════════

WITH

config AS (
  SELECT
    :SECTOR::text                                           AS target_sector,
    (SELECT MAX(as_of_date) FROM md_research_sector_peer_daily) AS target_date
),

-- C-3: dropped vix_level / interest_rate_10y — never consumed downstream.
market_state_today AS (
  SELECT market_regime
  FROM md_historical_features_daily
  WHERE symbol = 'SPY'
    AND as_of_date = (SELECT target_date FROM config)
    AND is_delisted = false
),

-- C-3: dropped sp500_close — only perf_4w / perf_12w bands are surfaced.
benchmark_sp500 AS (
  SELECT perf_4w AS sp500_perf_4w, perf_12w AS sp500_perf_12w
  FROM md_historical_benchmark_daily
  WHERE symbol = '^GSPC' AND as_of_date <= (SELECT target_date FROM config)
  ORDER BY as_of_date DESC LIMIT 1
),
benchmark_vix AS (
  SELECT close AS vix_close
  FROM md_historical_benchmark_daily
  WHERE symbol = '^VIX' AND as_of_date <= (SELECT target_date FROM config)
  ORDER BY as_of_date DESC LIMIT 1
),

-- Q1 (fast): sector universe TODAY via MV peer table. No features scan.
sector_universe_today AS (
  SELECT
    mp.symbol,
    mp.industry,
    mp.composite_pct,
    mp.roe_pct,
    mp.fcf_pct,
    mp.npm_pct,
    mp.d2e_pct_lowbetter,
    mp.rev_growth_pct
  FROM md_research_sector_peer_daily mp
  WHERE mp.sector = (SELECT target_sector FROM config)
),

sector_census AS (
  SELECT
    COUNT(*)                                                AS n_symbols,
    COUNT(DISTINCT industry)                                AS n_industries,
    -- Exclude data-quality-zero rows (all 5 composite metrics NULL → composite=0)
    -- so percentile distribution reflects scored symbols only.
    COUNT(*) FILTER (WHERE composite_pct > 0)               AS n_symbols_scored,
    AVG(composite_pct) FILTER (WHERE composite_pct > 0)     AS mean_composite,
    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY composite_pct)
      FILTER (WHERE composite_pct > 0)                      AS p25_composite,
    PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY composite_pct)
      FILTER (WHERE composite_pct > 0)                      AS p50_composite,
    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY composite_pct)
      FILTER (WHERE composite_pct > 0)                      AS p75_composite
  FROM sector_universe_today
),

industry_breakdown AS (
  SELECT
    industry,
    COUNT(*)                                                AS n,
    AVG(composite_pct)                                      AS mean_composite
  FROM sector_universe_today
  WHERE industry IS NOT NULL
  GROUP BY industry
),

sector_leaders AS (
  SELECT
    symbol, industry, composite_pct,
    RANK() OVER (ORDER BY composite_pct DESC NULLS LAST)    AS rnk_desc,
    RANK() OVER (ORDER BY composite_pct ASC NULLS LAST)     AS rnk_asc
  FROM sector_universe_today
),

-- Q4 (fast): sector × regime × valuation from MV — one indexed read.
regime_valuation_matrix AS (
  SELECT
    market_regime, valuation_bucket,
    n, n_with_h60, median_h60, avg_h60, wins_h60, total_h60,
    median_h252, wins_h252, total_h252
  FROM md_research_sector_regime_fwd_agg
  WHERE sector = (SELECT target_sector FROM config)
),

-- Q4 (bucket detail — top/bottom only).
bucket_matrix AS (
  SELECT
    pe_bin, rsi_bin, market_regime,
    n_with_h60, median_h60, wins_h60, total_h60
  FROM md_research_sector_analog_bucket
  WHERE sector = (SELECT target_sector FROM config)
    AND n_with_h60 >= 100
),

-- Q4 rollups.
regime_rollup AS (
  SELECT
    market_regime,
    SUM(n_with_h60)                                         AS n_with_h60,
    SUM(avg_h60 * n_with_h60) / NULLIF(SUM(n_with_h60), 0)  AS weighted_avg_h60,
    SUM(wins_h60)                                           AS wins_h60,
    SUM(total_h60)                                          AS total_h60,
    SUM(wins_h252)                                          AS wins_h252,
    SUM(total_h252)                                         AS total_h252
  FROM regime_valuation_matrix
  GROUP BY market_regime
),

valuation_rollup AS (
  SELECT
    valuation_bucket,
    SUM(n_with_h60)                                         AS n_with_h60,
    SUM(avg_h60 * n_with_h60) / NULLIF(SUM(n_with_h60), 0)  AS weighted_avg_h60,
    SUM(wins_h60)                                           AS wins_h60,
    SUM(total_h60)                                          AS total_h60,
    SUM(wins_h252)                                          AS wins_h252,
    SUM(total_h252)                                         AS total_h252
  FROM regime_valuation_matrix
  GROUP BY valuation_bucket
),

-- Sector base rate across all regimes.
sector_base_rate AS (
  SELECT
    SUM(n_with_h60)                                         AS n_with_h60,
    SUM(avg_h60 * n_with_h60) / NULLIF(SUM(n_with_h60), 0)  AS weighted_avg_h60,
    SUM(wins_h60)                                           AS wins_h60,
    SUM(total_h60)                                          AS total_h60,
    SUM(wins_h252)                                          AS wins_h252,
    SUM(total_h252)                                         AS total_h252
  FROM regime_valuation_matrix
),

-- feeds: deriveForwardPerformance, deriveProbabilisticEvidence
-- Weighted percentile approximation of h60 forward returns across all
-- (regime, valuation_bucket) cells for this sector. Uses each cell's median_h60
-- weighted by n_with_h60 via generate_series repetition to produce p25/p50/p75.
-- Identical technique to regime query's regime_forward_pct CTE.
sector_forward_pct AS (
  SELECT
    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY median_h60) AS p25_h60,
    PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY median_h60) AS median_h60,
    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY median_h60) AS p75_h60
  FROM (
    SELECT
      s.median_h60
    FROM regime_valuation_matrix s
    JOIN LATERAL generate_series(1, LEAST(s.n_with_h60, 50)) ON true
    WHERE s.median_h60 IS NOT NULL
  ) weighted_cells
),

-- feeds: deriveUpcomingEvents
-- Percentage of sector constituents with earnings within the next two weeks.
-- Uses md_historical_features_daily (same underlying table as market_state_today).
-- Runtime impact: one additional index scan on (sector, as_of_date, is_delisted).
sector_event_context AS (
  SELECT
    COUNT(*) FILTER (WHERE h.days_to_earnings BETWEEN 0 AND 14) * 100.0
      / NULLIF(COUNT(*), 0)                                 AS pct_constituents_earnings_within_2w
  FROM md_historical_features_daily h
  WHERE h.sector = (SELECT target_sector FROM config)
    AND h.as_of_date = (SELECT target_date FROM config)
    AND h.is_delisted = false
    AND h.days_to_earnings IS NOT NULL
),

assembled AS (
  SELECT
    cfg.target_sector,
    cfg.target_date,
    mst.market_regime                                       AS current_market_regime,

    bs.sp500_perf_4w, bs.sp500_perf_12w,
    bv.vix_close,

    sc.n_symbols, sc.n_symbols_scored, sc.n_industries, sc.mean_composite,
    sc.p25_composite, sc.p50_composite, sc.p75_composite,

    (SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
        'industry',           industry,
        'n',                  n,
        'mean_composite_percentile', ROUND((COALESCE(mean_composite,0)*100)::numeric, 1)
      ) ORDER BY n DESC)
     FROM industry_breakdown)                               AS industry_breakdown_json,

    (SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
        'symbol',               symbol,
        'industry',             industry,
        'composite_percentile', ROUND((composite_pct*100)::numeric, 1)
      ) ORDER BY rnk_desc)
     FILTER (WHERE rnk_desc <= 10) FROM sector_leaders)     AS top_leaders_json,

    (SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
        'symbol',               symbol,
        'industry',             industry,
        'composite_percentile', ROUND((composite_pct*100)::numeric, 1)
      ) ORDER BY rnk_asc)
     FILTER (WHERE rnk_asc <= 10) FROM sector_leaders)      AS bottom_laggards_json,

    sbr.n_with_h60                                          AS base_n,
    sbr.weighted_avg_h60                                    AS base_avg_h60,
    sbr.wins_h60                                            AS base_wins_h60,
    sbr.total_h60                                           AS base_total_h60,
    sbr.wins_h252                                           AS base_wins_h252,
    sbr.total_h252                                          AS base_total_h252,

    -- feeds: deriveForwardPerformance
    sfp.p25_h60                                             AS base_p25_h60,
    sfp.median_h60                                          AS base_median_h60,
    sfp.p75_h60                                             AS base_p75_h60,

    (SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
        'regime',           market_regime,
        'n',                n_with_h60,
        'avg_h60_pct',      ROUND((weighted_avg_h60 * 100)::numeric, 2),
        'hit_rate_h60',     ROUND((wins_h60::numeric / NULLIF(total_h60, 0) * 100), 1),
        'hit_rate_h252',    ROUND((wins_h252::numeric / NULLIF(total_h252, 0) * 100), 1)
      ) ORDER BY weighted_avg_h60 DESC NULLS LAST)
     FROM regime_rollup)                                    AS regime_rollup_json,

    (SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
        'valuation_bucket', valuation_bucket,
        'n',                n_with_h60,
        'avg_h60_pct',      ROUND((weighted_avg_h60 * 100)::numeric, 2),
        'hit_rate_h60',     ROUND((wins_h60::numeric / NULLIF(total_h60, 0) * 100), 1),
        'hit_rate_h252',    ROUND((wins_h252::numeric / NULLIF(total_h252, 0) * 100), 1)
      ) ORDER BY valuation_bucket)
     FROM valuation_rollup)                                 AS valuation_rollup_json,

    (SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
        'regime',             market_regime,
        'valuation_bucket',   valuation_bucket,
        'n',                  n_with_h60,
        'median_h60_pct',     ROUND((median_h60 * 100)::numeric, 2),
        'hit_rate_h60',       ROUND((wins_h60::numeric / NULLIF(total_h60, 0) * 100), 1),
        'hit_rate_h252',      ROUND((wins_h252::numeric / NULLIF(total_h252, 0) * 100), 1),
        'sample_adequacy',
          CASE
            WHEN n_with_h60 < 200  THEN 'INSUFFICIENT'
            WHEN n_with_h60 < 500  THEN 'WEAK'
            WHEN n_with_h60 < 2000 THEN 'ADEQUATE'
            ELSE 'ROBUST'
          END
      ) ORDER BY market_regime, valuation_bucket)
     FROM regime_valuation_matrix)                          AS matrix_json,

    -- Bucket best/worst.
    (SELECT JSONB_BUILD_OBJECT(
      'best_h60', (
        SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
          'pe_bin', pe_bin, 'rsi_bin', rsi_bin, 'regime', market_regime,
          'n',           n_with_h60,
          'median_pct',  ROUND((median_h60 * 100)::numeric, 2),
          'hit_rate',    ROUND((wins_h60::numeric / NULLIF(total_h60,0) * 100), 1)
        ) ORDER BY median_h60 DESC)
        FROM (SELECT * FROM bucket_matrix ORDER BY median_h60 DESC LIMIT 5) r
      ),
      'worst_h60', (
        SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
          'pe_bin', pe_bin, 'rsi_bin', rsi_bin, 'regime', market_regime,
          'n',           n_with_h60,
          'median_pct',  ROUND((median_h60 * 100)::numeric, 2),
          'hit_rate',    ROUND((wins_h60::numeric / NULLIF(total_h60,0) * 100), 1)
        ) ORDER BY median_h60 ASC)
        FROM (SELECT * FROM bucket_matrix ORDER BY median_h60 ASC LIMIT 5) r
      )
    ))                                                      AS bucket_extremes_json,

    -- feeds: deriveUpcomingEvents
    sec.pct_constituents_earnings_within_2w                 AS event_pct_earnings_2w

  FROM config cfg
  -- LEFT JOIN (not CROSS JOIN) so the assembled row is emitted even when SPY
  -- is missing on target_date (data gap, delisted, etc). Otherwise the entire
  -- response collapses to zero rows with no error — silent 200-with-empty-body.
  LEFT JOIN market_state_today mst ON true
  LEFT JOIN benchmark_sp500 bs    ON true
  LEFT JOIN benchmark_vix bv      ON true
  LEFT JOIN sector_census sc      ON true
  LEFT JOIN sector_base_rate sbr  ON true
  LEFT JOIN sector_forward_pct sfp ON true
  LEFT JOIN sector_event_context sec ON true
)

SELECT
  JSONB_BUILD_OBJECT(
    'meta', JSONB_BUILD_OBJECT(
      'anchor_type',            'SECTOR',
      'mode',                   'FAST',
      'sector',                 a.target_sector,
      'as_of_date',             a.target_date,
      'current_market_regime',  a.current_market_regime,
      'schema_version',         'research_object_v6a_sector',
      'canon',                  'institutional_intelligence_layer_2026_04_23',
      'deep_mode_available',    'query_v5_2_sector.sql'
    ),

    'what_matters', JSONB_BUILD_OBJECT(
      'symbols',                 a.n_symbols,
      'symbols_with_complete_metrics', a.n_symbols_scored,
      'industries',              a.n_industries,
      'sector_composite_percentile_distribution', JSONB_BUILD_OBJECT(
        'p25',                   ROUND((COALESCE(a.p25_composite,0)*100)::numeric, 1),
        'median',                ROUND((COALESCE(a.p50_composite,0)*100)::numeric, 1),
        'p75',                   ROUND((COALESCE(a.p75_composite,0)*100)::numeric, 1),
        'note',                  'Percentile distribution computed only over symbols '
                              || 'with at least one scored metric (composite_pct > 0). '
                              || 'Sectors with many funds / BDCs / SPACs may have more '
                              || 'unscored rows than scored.'
      ),
      'industry_breakdown',      COALESCE(a.industry_breakdown_json, '[]'::jsonb),
      'top_leaders',             COALESCE(a.top_leaders_json, '[]'::jsonb),
      'bottom_laggards',         COALESCE(a.bottom_laggards_json, '[]'::jsonb)
    ),

    'why_now', JSONB_BUILD_OBJECT(
      'current_regime',          a.current_market_regime,
      'vix_band',
        CASE
          WHEN a.vix_close IS NULL THEN NULL
          WHEN a.vix_close < 13 THEN 'VERY_LOW'
          WHEN a.vix_close < 18 THEN 'LOW'
          WHEN a.vix_close < 25 THEN 'MODERATE'
          WHEN a.vix_close < 35 THEN 'ELEVATED'
          ELSE 'STRESSED'
        END,
      'sp500_perf_4w_band',
        CASE
          WHEN a.sp500_perf_4w IS NULL THEN NULL
          WHEN a.sp500_perf_4w < -0.05 THEN 'DRAWDOWN'
          WHEN a.sp500_perf_4w <  0.01 THEN 'WEAK'
          WHEN a.sp500_perf_4w <  0.05 THEN 'POSITIVE'
          ELSE 'STRONG_RALLY'
        END
    ),

    'historical_base_rate', JSONB_BUILD_OBJECT(
      'n_observations',          a.base_n,
      'h60_avg_pct',             ROUND((COALESCE(a.base_avg_h60,0) * 100)::numeric, 2),
      'h60_hit_rate',            ROUND((a.base_wins_h60::numeric / NULLIF(a.base_total_h60, 0) * 100), 1),
      'h252_hit_rate',           ROUND((a.base_wins_h252::numeric / NULLIF(a.base_total_h252, 0) * 100), 1),
      'h60_median_pct',          ROUND((COALESCE(a.base_median_h60,0) * 100)::numeric, 2),
      'h60_p25_pct',             ROUND((COALESCE(a.base_p25_h60,0) * 100)::numeric, 2),
      'h60_p75_pct',             ROUND((COALESCE(a.base_p75_h60,0) * 100)::numeric, 2),
      -- feeds: deriveProbabilisticEvidence (state: 'partial' -> 'complete' when ADEQUATE+)
      'sample_adequacy',
        CASE
          WHEN COALESCE(a.base_n, 0) < 200  THEN 'INSUFFICIENT'
          WHEN a.base_n < 500               THEN 'WEAK'
          WHEN a.base_n < 2000              THEN 'ADEQUATE'
          ELSE                                   'ROBUST'
        END,
      'framing_note',            'Unconditional Monday-sampled forward-return aggregate '
                              || 'across ALL historical observations for this sector. '
                              || 'For analog-distance-matched self-analogs, use deep mode (V5.2).'
    ),

    'under_which_conditions', JSONB_BUILD_OBJECT(
      'regime_rollup',           COALESCE(a.regime_rollup_json, '[]'::jsonb),
      'valuation_rollup',        COALESCE(a.valuation_rollup_json, '[]'::jsonb),
      'regime_valuation_matrix', COALESCE(a.matrix_json, '[]'::jsonb),
      'bucket_extremes',         COALESCE(a.bucket_extremes_json, '{}'::jsonb)
    ),

    -- feeds: deriveUpcomingEvents
    'event_context', JSONB_BUILD_OBJECT(
      'pct_constituents_earnings_within_2w',
        ROUND(COALESCE(a.event_pct_earnings_2w, 0)::numeric, 1),
      'earnings_cluster_band',
        CASE
          WHEN a.event_pct_earnings_2w IS NULL     THEN NULL
          WHEN a.event_pct_earnings_2w >= 30       THEN 'CONCENTRATED'
          WHEN a.event_pct_earnings_2w >= 10       THEN 'MODERATE'
          ELSE                                          'SPARSE'
        END,
      'note', 'Fraction of sector constituents (is_delisted=false, '
           || 'days_to_earnings NOT NULL) with earnings within 14 calendar days. '
           || 'Denominator excludes symbols with NULL days_to_earnings.'
    ),

    'invalidation', JSONB_BUILD_OBJECT(
      'edge_evidence_seam', JSONB_BUILD_OBJECT(
        '_bridge_required', TRUE,
        '_bridge_note', 'Active convergence / Sentinel rolling WR / Coroner '
                     || 'decay posture must be resolved by application layer via SQLite. '
                     || 'Sector RSI / valuation crowding signals and analyst tilt available in deep mode (V5.2).'
      )
    ),

    'compliance', JSONB_BUILD_OBJECT(
      'disclaimer', 'Research Object (fast mode) describes historical patterns at the sector level. '
                 || 'Not an investment recommendation.',
      'not_advice',         TRUE,
      'pit_integrity',      TRUE,
      'survivorship_clean', TRUE
    )
  ) AS research_object,

  JSONB_BUILD_OBJECT(
    'target_sector',           a.target_sector,
    'target_date',             a.target_date,
    'raw_mean_composite',      a.mean_composite,
    'raw_base_avg_h60',        a.base_avg_h60,
    'raw_vix_close',           a.vix_close,
    'raw_event_pct_earnings_2w', a.event_pct_earnings_2w,
    'raw_base_median_h60',     a.base_median_h60,
    'raw_base_p25_h60',        a.base_p25_h60,
    'raw_base_p75_h60',        a.base_p75_h60,
    'raw_base_n',              a.base_n
  ) AS debug_payload

FROM assembled a;

-- ═════════════════════════════════════════════════════════════════════════════
-- END OF Research Object Query V6a SECTOR LIVE
-- ═════════════════════════════════════════════════════════════════════════════
