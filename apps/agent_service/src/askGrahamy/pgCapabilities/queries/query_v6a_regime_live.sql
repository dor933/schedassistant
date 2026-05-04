-- ═════════════════════════════════════════════════════════════════════════════
-- Grahamy — Research Object Query V6a REGIME LIVE (Fast Path, MV-only)
-- ═════════════════════════════════════════════════════════════════════════════
-- ANCHOR: a market REGIME (RISK_ON / NEUTRAL / RISK_OFF). Same 5-question
-- contract as V5.2 REGIME, but strictly MV-only — no gaps-and-islands timeline
-- scan, no live universe scan. Targets <300ms cold, <100ms warm.
--
-- When to use which:
--   V5.2 REGIME  — deep mode: episode-aware (SPY gaps-and-islands), onset-
--                  specific forward returns, current duration vs history. ~200ms.
--   V6a REGIME   — fast mode: MV-only base rates (aggregated forward returns
--                  over ALL historical rows in regime, not onset-specific),
--                  current state + macro context only. ~50ms.
--
-- The LLM layer can dispatch V6a as the default, and escalate to V5.2 when the
-- user asks for "duration", "episode history", "onset forward returns" or
-- similar episode-structural questions.
--
-- PIT GUARANTEES: same as V5.2 REGIME (MV is Monday-sampled, is_delisted=false,
-- pe_ratio>0 & price>0).
--
-- MOAT DISCIPLINE: same — bands / enums / percentile bands only.
--
-- USAGE:
--   docker exec -i stock_analyzer_db psql -U stock_user -d stock_analyzer \
--     -v REGIME="'NEUTRAL'" < query_v6a_regime_live.sql
-- ═════════════════════════════════════════════════════════════════════════════

WITH

config AS (
  SELECT
    UPPER(:REGIME)::text                                    AS target_regime,
    (SELECT MAX(as_of_date) FROM md_research_sector_peer_daily) AS target_date
),

-- Current market regime (one-row SPY lookup — indexed, O(1))
-- C-3: dropped vix_level / interest_rate_10y — never consumed downstream
-- (regime band comes from benchmark_vix; rates not surfaced).
market_state_today AS (
  SELECT market_regime
  FROM md_historical_features_daily
  WHERE symbol = 'SPY'
    AND as_of_date = (SELECT target_date FROM config)
    AND is_delisted = false
),

-- Macro context (3 indexed benchmark lookups, each O(log n))
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
benchmark_tnx AS (
  SELECT close AS tnx_close
  FROM md_historical_benchmark_daily
  WHERE symbol = '^TNX' AND as_of_date <= (SELECT target_date FROM config)
  ORDER BY as_of_date DESC LIMIT 1
),

-- Q1 (fast): sector leadership within today's regime — MV join, zero live scan.
-- md_research_sector_peer_daily carries composite_pct per symbol for TODAY only.
-- We join one history row per symbol to filter to :REGIME (symbol must be in
-- that regime right now — pk index hit).
regime_symbols_today AS (
  SELECT
    mp.symbol, mp.sector, mp.composite_pct
  FROM md_research_sector_peer_daily mp
  JOIN md_historical_features_daily h
    ON h.symbol = mp.symbol
   AND h.as_of_date = (SELECT target_date FROM config)
   AND h.is_delisted = false
   AND h.market_regime = (SELECT target_regime FROM config)
),

universe_census AS (
  SELECT
    COUNT(*)                                                AS n_symbols,
    COUNT(DISTINCT sector)                                  AS n_sectors,
    AVG(composite_pct)                                      AS mean_composite
  FROM regime_symbols_today
),

sector_leaders_today AS (
  SELECT
    sector,
    COUNT(*)                                                AS n,
    AVG(composite_pct)                                      AS mean_composite,
    RANK() OVER (ORDER BY AVG(composite_pct) DESC)          AS rnk
  FROM regime_symbols_today
  GROUP BY sector
),

top_leaders_today AS (
  SELECT
    rs.symbol, rs.sector, rs.composite_pct,
    RANK() OVER (ORDER BY rs.composite_pct DESC NULLS LAST) AS rnk
  FROM regime_symbols_today rs
),

-- Q4 (fast): sector × valuation matrix from MV — O(1) index scan per row.
sector_valuation_matrix AS (
  SELECT
    sector, valuation_bucket, n_with_h60,
    median_h60, avg_h60, wins_h60, total_h60,
    median_h252, wins_h252, total_h252
  FROM md_research_sector_regime_fwd_agg
  WHERE market_regime = (SELECT target_regime FROM config)
    AND sector IS NOT NULL
    AND valuation_bucket IS NOT NULL
),

-- Q3 (fast, base-rate framing): aggregate all MV rows in :REGIME across sectors
-- to get overall "what did this regime do on average" forward returns.
regime_base_rate AS (
  SELECT
    SUM(n_with_h60)                                         AS n_with_h60,
    SUM(avg_h60 * n_with_h60) / NULLIF(SUM(n_with_h60), 0)  AS weighted_avg_h60,
    SUM(wins_h60)                                           AS wins_h60,
    SUM(total_h60)                                          AS total_h60,
    SUM(wins_h252)                                          AS wins_h252,
    SUM(total_h252)                                         AS total_h252
  FROM sector_valuation_matrix
),

-- Rollups (by sector, by valuation)
sector_rollup AS (
  SELECT
    sector,
    SUM(n_with_h60)                                         AS n_with_h60,
    SUM(avg_h60 * n_with_h60) / NULLIF(SUM(n_with_h60), 0)  AS weighted_avg_h60,
    SUM(wins_h60)                                           AS wins_h60,
    SUM(total_h60)                                          AS total_h60,
    SUM(wins_h252)                                          AS wins_h252,
    SUM(total_h252)                                         AS total_h252
  FROM sector_valuation_matrix
  GROUP BY sector
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
  FROM sector_valuation_matrix
  GROUP BY valuation_bucket
),

assembled AS (
  SELECT
    cfg.target_regime,
    cfg.target_date,
    mst.market_regime                                       AS current_market_regime,

    bs.sp500_perf_4w, bs.sp500_perf_12w,
    bv.vix_close,
    bt.tnx_close,

    uc.n_symbols, uc.n_sectors, uc.mean_composite,

    (SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
        'sector',              sector,
        'symbols_in_regime',   n,
        'mean_composite_percentile', ROUND((COALESCE(mean_composite,0)*100)::numeric, 1),
        'rank_composite',      rnk
      ) ORDER BY rnk)
     FROM sector_leaders_today)                             AS sector_table_json,

    (SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
        'symbol',               symbol,
        'sector',               sector,
        'composite_percentile', ROUND((composite_pct*100)::numeric, 1)
      ) ORDER BY rnk)
     FILTER (WHERE rnk <= 10) FROM top_leaders_today)       AS top_leaders_json,

    rbr.n_with_h60                                          AS base_n,
    rbr.weighted_avg_h60                                    AS base_avg_h60,
    rbr.wins_h60                                            AS base_wins_h60,
    rbr.total_h60                                           AS base_total_h60,
    rbr.wins_h252                                           AS base_wins_h252,
    rbr.total_h252                                          AS base_total_h252,

    (SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
        'sector',           sector,
        'n',                n_with_h60,
        'avg_h60_pct',      ROUND((weighted_avg_h60 * 100)::numeric, 2),
        'hit_rate_h60',     ROUND((wins_h60::numeric / NULLIF(total_h60, 0) * 100), 1),
        'hit_rate_h252',    ROUND((wins_h252::numeric / NULLIF(total_h252, 0) * 100), 1)
      ) ORDER BY weighted_avg_h60 DESC NULLS LAST)
     FROM sector_rollup)                                    AS sector_rollup_json,

    (SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
        'valuation_bucket', valuation_bucket,
        'n',                n_with_h60,
        'avg_h60_pct',      ROUND((weighted_avg_h60 * 100)::numeric, 2),
        'hit_rate_h60',     ROUND((wins_h60::numeric / NULLIF(total_h60, 0) * 100), 1),
        'hit_rate_h252',    ROUND((wins_h252::numeric / NULLIF(total_h252, 0) * 100), 1)
      ) ORDER BY valuation_bucket)
     FROM valuation_rollup)                                 AS valuation_rollup_json,

    (SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
        'sector',             sector,
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
      ) ORDER BY sector, valuation_bucket)
     FROM sector_valuation_matrix)                          AS matrix_json

  FROM config cfg
  -- LEFT JOIN (not CROSS JOIN) so the assembled row is emitted even when SPY
  -- is missing on target_date (data gap, delisted, etc). Otherwise the entire
  -- response collapses to zero rows with no error — silent 200-with-empty-body.
  LEFT JOIN market_state_today mst ON true
  LEFT JOIN benchmark_sp500 bs    ON true
  LEFT JOIN benchmark_vix bv      ON true
  LEFT JOIN benchmark_tnx bt      ON true
  LEFT JOIN universe_census uc    ON true
  LEFT JOIN regime_base_rate rbr  ON true
)

SELECT
  JSONB_BUILD_OBJECT(
    'meta', JSONB_BUILD_OBJECT(
      'anchor_type',             'REGIME',
      'mode',                    'FAST',
      'regime',                  a.target_regime,
      'as_of_date',              a.target_date,
      'is_current_market_regime', (a.target_regime = a.current_market_regime),
      'current_market_regime',   a.current_market_regime,
      'schema_version',          'research_object_v6a_regime',
      'canon',                   'institutional_intelligence_layer_2026_04_23',
      'deep_mode_available',     'query_v5_2_regime.sql'
    ),

    'why_now', JSONB_BUILD_OBJECT(
      'current_market_regime',   a.current_market_regime,
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
        END,
      'ten_year_yield_band',
        CASE
          WHEN a.tnx_close IS NULL THEN NULL
          WHEN a.tnx_close < 2   THEN 'VERY_LOW'
          WHEN a.tnx_close < 3.5 THEN 'LOW'
          WHEN a.tnx_close < 5   THEN 'MODERATE'
          ELSE 'HIGH'
        END
    ),

    'what_matters', JSONB_BUILD_OBJECT(
      'symbols_in_regime_today', a.n_symbols,
      'sectors_active_today',    a.n_sectors,
      'sector_leadership_today', COALESCE(a.sector_table_json, '[]'::jsonb),
      'top_leaders_today',       COALESCE(a.top_leaders_json, '[]'::jsonb)
    ),

    -- Base-rate framing (MV-only). Deep mode (V5.2) provides onset-specific
    -- forward returns computed from SP500 at each episode's start date.
    'historical_base_rate', JSONB_BUILD_OBJECT(
      'n_observations',          a.base_n,
      'h60_avg_pct',             ROUND((COALESCE(a.base_avg_h60,0) * 100)::numeric, 2),
      'h60_hit_rate',            ROUND((a.base_wins_h60::numeric / NULLIF(a.base_total_h60, 0) * 100), 1),
      'h252_hit_rate',           ROUND((a.base_wins_h252::numeric / NULLIF(a.base_total_h252, 0) * 100), 1),
      'framing_note',            'Unconditional Monday-sampled forward-return aggregate '
                              || 'across ALL historical observations where regime matched. '
                              || 'For episode-onset-specific returns, use deep mode (V5.2).'
    ),

    'under_which_conditions', JSONB_BUILD_OBJECT(
      'sector_rollup',           COALESCE(a.sector_rollup_json, '[]'::jsonb),
      'valuation_rollup',        COALESCE(a.valuation_rollup_json, '[]'::jsonb),
      'sector_valuation_matrix', COALESCE(a.matrix_json, '[]'::jsonb)
    ),

    'invalidation', JSONB_BUILD_OBJECT(
      'edge_evidence_seam', JSONB_BUILD_OBJECT(
        '_bridge_required', TRUE,
        '_bridge_note', 'Active convergence / Sentinel rolling WR / Coroner '
                     || 'decay posture must be resolved by application layer via SQLite. '
                     || 'Regime episode structure & exit precursors available in deep mode (V5.2).'
      )
    ),

    'compliance', JSONB_BUILD_OBJECT(
      'disclaimer', 'Research Object (fast mode) describes historical patterns at the regime level. '
                 || 'Not an investment recommendation.',
      'not_advice',         TRUE,
      'pit_integrity',      TRUE,
      'survivorship_clean', TRUE
    )
  ) AS research_object,

  JSONB_BUILD_OBJECT(
    'target_regime',           a.target_regime,
    'target_date',             a.target_date,
    'current_market_regime',   a.current_market_regime,
    'raw_vix_close',           a.vix_close,
    'raw_sp500_perf_4w',       a.sp500_perf_4w,
    'raw_base_avg_h60',        a.base_avg_h60
  ) AS debug_payload

FROM assembled a;

-- ═════════════════════════════════════════════════════════════════════════════
-- END OF Research Object Query V6a REGIME LIVE
-- ═════════════════════════════════════════════════════════════════════════════
