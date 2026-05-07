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

sector_path_entries AS (
  SELECT
    h.symbol,
    h.as_of_date AS entry_date,
    h.price::numeric AS entry_price
  FROM md_historical_features_daily h
  WHERE h.sector = (SELECT target_sector FROM config)
    AND h.as_of_date = (SELECT target_date FROM config)
    AND h.is_delisted = false
    AND h.price > 0
),
sector_path_days AS (
  SELECT
    e.symbol,
    e.entry_date,
    e.entry_price,
    p.price::numeric AS path_price,
    p.as_of_date AS path_date,
    ROW_NUMBER() OVER (PARTITION BY e.symbol, e.entry_date ORDER BY p.as_of_date) - 1 AS path_day
  FROM sector_path_entries e
  JOIN LATERAL (
    SELECT h2.as_of_date, h2.price
    FROM md_historical_features_daily h2
    WHERE h2.symbol = e.symbol
      AND h2.as_of_date >= e.entry_date
      AND h2.as_of_date <= e.entry_date + INTERVAL '120 days'
      AND h2.price > 0
    ORDER BY h2.as_of_date
    LIMIT 61
  ) p ON true
),
sector_path_stats AS (
  SELECT
    symbol,
    entry_date,
    entry_price,
    COUNT(*) AS observed_days,
    MIN((path_price - entry_price) / NULLIF(entry_price, 0)) AS max_drawdown,
    MAX(path_day) AS last_day,
    MAX(CASE WHEN path_day = 60 THEN path_price ELSE NULL END) AS price_at_60,
    MAX(CASE WHEN (path_price - entry_price) / NULLIF(entry_price, 0) >= 0 THEN 1 ELSE 0 END) AS recovered
  FROM sector_path_days
  GROUP BY symbol, entry_date, entry_price
),
sector_path_risk AS (
  SELECT
    COUNT(*) FILTER (WHERE observed_days >= 40) AS path_n,
    AVG(CASE WHEN (price_at_60 - entry_price) / NULLIF(entry_price, 0) < 0 THEN 1.0 ELSE 0.0 END) * 100 AS loss_rate_h60_pct,
    AVG(CASE WHEN (price_at_60 - entry_price) / NULLIF(entry_price, 0) <= -0.10 THEN 1.0 ELSE 0.0 END) * 100 AS severe_loss_rate_h60_pct,
    PERCENTILE_CONT(0.10) WITHIN GROUP (ORDER BY max_drawdown DESC) * 100 AS p10_max_drawdown_pct,
    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY max_drawdown DESC) * 100 AS p25_max_drawdown_pct,
    MIN(max_drawdown) * 100 AS worst_max_drawdown_pct,
    AVG(CASE WHEN max_drawdown <= -0.05 THEN 1.0 ELSE 0.0 END) * 100 AS prob_drawdown_gt_5_pct,
    AVG(CASE WHEN max_drawdown <= -0.10 THEN 1.0 ELSE 0.0 END) * 100 AS prob_drawdown_gt_10_pct,
    AVG(CASE WHEN max_drawdown <= -0.15 THEN 1.0 ELSE 0.0 END) * 100 AS prob_drawdown_gt_15_pct,
    AVG(CASE WHEN max_drawdown <= -0.20 THEN 1.0 ELSE 0.0 END) * 100 AS prob_drawdown_gt_20_pct,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY CASE WHEN recovered = 1 THEN observed_days::float ELSE NULL END) AS median_recovery_days,
    AVG(CASE WHEN recovered = 1 THEN 1.0 ELSE 0.0 END) * 100 AS recovered_by_horizon_rate_pct,
    CASE
      WHEN COUNT(*) FILTER (WHERE observed_days >= 40) < 30  THEN 'INSUFFICIENT'
      WHEN COUNT(*) FILTER (WHERE observed_days >= 40) < 100 THEN 'WEAK'
      WHEN COUNT(*) FILTER (WHERE observed_days >= 40) < 500 THEN 'ADEQUATE'
      ELSE 'ROBUST'
    END AS sample_adequacy
  FROM sector_path_stats
  WHERE observed_days >= 40
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
    ))                                                      AS bucket_extremes_json

  FROM config cfg
  -- LEFT JOIN (not CROSS JOIN) so the assembled row is emitted even when SPY
  -- is missing on target_date (data gap, delisted, etc). Otherwise the entire
  -- response collapses to zero rows with no error — silent 200-with-empty-body.
  LEFT JOIN market_state_today mst ON true
  LEFT JOIN benchmark_sp500 bs    ON true
  LEFT JOIN benchmark_vix bv      ON true
  LEFT JOIN sector_census sc      ON true
  LEFT JOIN sector_base_rate sbr  ON true
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

    'invalidation', JSONB_BUILD_OBJECT(
      'edge_evidence_seam', JSONB_BUILD_OBJECT(
        '_bridge_required', TRUE,
        '_bridge_note', 'Active convergence / Sentinel rolling WR / Coroner '
                     || 'decay posture must be resolved by application layer via SQLite. '
                     || 'Sector RSI / valuation crowding signals and analyst tilt available in deep mode (V5.2).'
      )
    ),

    'path_risk_base', JSONB_BUILD_OBJECT(
      'source',                        'pg_daily_price_path',
      'horizon',                       '60-day',
      'n',                             (SELECT path_n FROM sector_path_risk),
      'loss_rate_h60_pct',             (SELECT ROUND(loss_rate_h60_pct::numeric, 2) FROM sector_path_risk),
      'severe_loss_rate_h60_pct',      (SELECT ROUND(severe_loss_rate_h60_pct::numeric, 2) FROM sector_path_risk),
      'p10_max_drawdown_pct',          (SELECT ROUND(p10_max_drawdown_pct::numeric, 2) FROM sector_path_risk),
      'p25_max_drawdown_pct',          (SELECT ROUND(p25_max_drawdown_pct::numeric, 2) FROM sector_path_risk),
      'worst_max_drawdown_pct',        (SELECT ROUND(worst_max_drawdown_pct::numeric, 2) FROM sector_path_risk),
      'prob_drawdown_gt_5_pct',        (SELECT ROUND(prob_drawdown_gt_5_pct::numeric, 2) FROM sector_path_risk),
      'prob_drawdown_gt_10_pct',       (SELECT ROUND(prob_drawdown_gt_10_pct::numeric, 2) FROM sector_path_risk),
      'prob_drawdown_gt_15_pct',       (SELECT ROUND(prob_drawdown_gt_15_pct::numeric, 2) FROM sector_path_risk),
      'prob_drawdown_gt_20_pct',       (SELECT ROUND(prob_drawdown_gt_20_pct::numeric, 2) FROM sector_path_risk),
      'median_recovery_days',          (SELECT ROUND(median_recovery_days::numeric, 1) FROM sector_path_risk),
      'recovered_by_horizon_rate_pct', (SELECT ROUND(recovered_by_horizon_rate_pct::numeric, 2) FROM sector_path_risk),
      'sample_adequacy',               (SELECT sample_adequacy FROM sector_path_risk)
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
    'raw_vix_close',           a.vix_close
  ) AS debug_payload

FROM assembled a;

-- ═════════════════════════════════════════════════════════════════════════════
-- END OF Research Object Query V6a SECTOR LIVE
-- ═════════════════════════════════════════════════════════════════════════════
