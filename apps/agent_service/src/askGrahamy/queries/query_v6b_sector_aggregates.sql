-- ═════════════════════════════════════════════════════════════════════════════
-- Research Object V6b — SECTOR AGGREGATES (materialized view lookups)
-- ═════════════════════════════════════════════════════════════════════════════
-- Purpose: serve the sector-wide portions of the Research Object in <100ms
--          by looking up 4 pre-materialized views instead of scanning 5-8M
--          rows live.
--
-- Returns:
--   portfolio_context  — target's sector rank + top-5 better-state peers
--   sector_by_regime   — sector-wide forward-return stats per regime
--   sector_analogs     — profile-bucket analog stats (Q3 sector)
--   invalidation       — win-vs-loss profile from bucket (Q5)
--
-- Inputs (psql -v):
--   SYMBOL           : target symbol (string, quoted)
--   SECTOR           : sector name (e.g. 'Technology')
--   CURRENT_REGIME   : NEUTRAL | RISK_ON | RISK_OFF
--   PE_BIN           : 1..5 (computed client-side from pe_percentile_in_sector)
--   RSI_BIN          : 1..5 (computed client-side from rsi_14)
--   VALUATION_BUCKET : DEEP_VALUE | VALUE | FAIR | RICH | EXPENSIVE
--
-- Typical usage (after v6a returns profile_keys):
--   docker exec -i stock_analyzer_db psql -U stock_user -d stock_analyzer \
--     -v SYMBOL="'MSFT'" -v SECTOR="'Technology'" \
--     -v CURRENT_REGIME="'NEUTRAL'" -v PE_BIN=3 -v RSI_BIN=4 \
--     -v VALUATION_BUCKET="'FAIR'" < query_v6b_sector_aggregates.sql
--
-- Runtime: <100ms (lookup on 4 MVs, all indexed on exact-match keys)
-- ═════════════════════════════════════════════════════════════════════════════

WITH

-- ─────────────────────────────────────────────────────────────────────────────
-- Target's own row in the peer_daily view (single-row lookup)
-- ─────────────────────────────────────────────────────────────────────────────

target_peer AS (
  SELECT p.*
  FROM md_research_sector_peer_daily p
  WHERE p.symbol = :SYMBOL
),

-- ─────────────────────────────────────────────────────────────────────────────
-- Top-5 peers in the same sector with a strictly higher composite percentile
-- ─────────────────────────────────────────────────────────────────────────────

top_peers AS (
  SELECT p.symbol, p.composite_pct,
         ROW_NUMBER() OVER (ORDER BY p.composite_pct DESC) AS rnk
  FROM md_research_sector_peer_daily p
  WHERE p.sector = :SECTOR
    AND p.symbol != :SYMBOL
    AND p.composite_pct > COALESCE((SELECT composite_pct FROM target_peer), 0)
),

top_peers_json AS (
  SELECT JSONB_AGG(
           JSONB_BUILD_OBJECT(
             'symbol', symbol,
             'composite_pct', ROUND((composite_pct * 100)::numeric, 1)
           ) ORDER BY composite_pct DESC
         ) FILTER (WHERE rnk <= 5) AS peers
  FROM top_peers
),

-- ─────────────────────────────────────────────────────────────────────────────
-- Sector-by-regime forward aggregates — filtered to this sector
-- ─────────────────────────────────────────────────────────────────────────────

sector_regime_rows AS (
  SELECT *
  FROM md_research_sector_regime_fwd_agg
  WHERE sector = :SECTOR
),

sector_by_regime_json AS (
  SELECT JSONB_AGG(
           JSONB_BUILD_OBJECT(
             'regime',       market_regime,
             'valuation_bucket', valuation_bucket,
             'n',            n,
             'median_h60',   ROUND((median_h60 * 100)::numeric, 2),
             'avg_h60',      ROUND((avg_h60 * 100)::numeric, 2),
             'hit_rate_h60', ROUND((wins_h60::numeric / NULLIF(total_h60, 0) * 100), 1),
             'median_h252',  ROUND((median_h252 * 100)::numeric, 2),
             'hit_rate_h252',ROUND((wins_h252::numeric / NULLIF(total_h252, 0) * 100), 1)
           )
           ORDER BY market_regime, valuation_bucket
         ) AS rows
  FROM sector_regime_rows
),

-- ─────────────────────────────────────────────────────────────────────────────
-- Target's profile bucket — single row from analog_bucket MV
-- ─────────────────────────────────────────────────────────────────────────────

target_bucket AS (
  SELECT *
  FROM md_research_sector_analog_bucket
  WHERE sector          = :SECTOR
    AND pe_bin          = :PE_BIN
    AND rsi_bin         = :RSI_BIN
    AND market_regime   = :CURRENT_REGIME
),

-- ─────────────────────────────────────────────────────────────────────────────
-- Adjacent buckets (for sample-size fallback when target bucket is sparse)
-- ─────────────────────────────────────────────────────────────────────────────

adjacent_buckets AS (
  SELECT
    SUM(n)                                                     AS n,
    SUM(wins_h60)::numeric / NULLIF(SUM(total_h60), 0) * 100   AS hit_rate_h60,
    SUM(wins_h252)::numeric / NULLIF(SUM(total_h252), 0) * 100 AS hit_rate_h252,
    AVG(median_h60)                                            AS avg_median_h60
  FROM md_research_sector_analog_bucket
  WHERE sector        = :SECTOR
    AND market_regime = :CURRENT_REGIME
    AND ABS(pe_bin  - :PE_BIN)  <= 1
    AND ABS(rsi_bin - :RSI_BIN) <= 1
),

sector_analog_sample AS (
  SELECT
    h.symbol,
    h.as_of_date AS analog_date,
    h.price::numeric AS entry_price,
    fr.h60_return
  FROM md_historical_features_daily h
  LEFT JOIN md_forward_returns fr
    ON fr.symbol = h.symbol
   AND fr.as_of_date = h.as_of_date
  WHERE h.sector = :SECTOR
    AND h.market_regime = :CURRENT_REGIME
    AND h.as_of_date >= '2010-01-01'
    AND h.as_of_date < CURRENT_DATE - INTERVAL '180 days'
    AND h.is_delisted = false
    AND h.price > 0
    AND CASE
      WHEN h.pe_percentile_in_sector <= 0.20 THEN 1
      WHEN h.pe_percentile_in_sector <= 0.40 THEN 2
      WHEN h.pe_percentile_in_sector <= 0.60 THEN 3
      WHEN h.pe_percentile_in_sector <= 0.80 THEN 4
      WHEN h.pe_percentile_in_sector IS NULL  THEN NULL
      ELSE 5
    END = :PE_BIN
    AND CASE
      WHEN h.rsi_14 < 30 THEN 1
      WHEN h.rsi_14 < 45 THEN 2
      WHEN h.rsi_14 < 55 THEN 3
      WHEN h.rsi_14 < 70 THEN 4
      WHEN h.rsi_14 IS NULL THEN NULL
      ELSE 5
    END = :RSI_BIN
  ORDER BY h.as_of_date DESC
  LIMIT 300
),

sector_analog_path_rows_raw AS (
  SELECT
    a.symbol,
    a.analog_date,
    p.as_of_date AS path_date,
    p.path_day,
    a.entry_price,
    p.price::numeric AS path_price
  FROM sector_analog_sample a
  JOIN LATERAL (
    SELECT
      h.as_of_date,
      h.price,
      ROW_NUMBER() OVER (ORDER BY h.as_of_date) - 1 AS path_day
    FROM md_historical_features_daily h
    WHERE h.symbol = a.symbol
      AND h.as_of_date >= a.analog_date
      AND h.as_of_date <= a.analog_date + INTERVAL '120 days'
      AND h.price > 0
    ORDER BY h.as_of_date
    LIMIT 61
  ) p ON true
),

sector_analog_path_rows AS (
  SELECT
    r.*,
    (r.path_price / NULLIF(r.entry_price, 0) - 1) AS return_from_entry,
    (r.path_price / NULLIF(
      MAX(r.path_price) OVER (
        PARTITION BY r.symbol, r.analog_date
        ORDER BY r.path_day
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ),
      0
    ) - 1) AS drawdown_from_peak
  FROM sector_analog_path_rows_raw r
),

sector_analog_path_by_event AS (
  SELECT
    symbol,
    analog_date,
    COUNT(*) FILTER (WHERE path_day <= 60) AS observed_days,
    MIN(return_from_entry) FILTER (WHERE path_day BETWEEN 0 AND 60) AS max_adverse_excursion,
    MIN(drawdown_from_peak) FILTER (WHERE path_day BETWEEN 0 AND 60) AS max_drawdown,
    MIN(path_day) FILTER (WHERE path_day > 0 AND return_from_entry >= 0) AS first_recovery_day
  FROM sector_analog_path_rows
  GROUP BY symbol, analog_date
),

sector_path_risk_summary AS (
  SELECT
    COUNT(*) FILTER (WHERE p.observed_days >= 40) AS path_n,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY p.max_adverse_excursion)
      FILTER (WHERE p.observed_days >= 40 AND p.max_adverse_excursion IS NOT NULL) AS median_adverse_excursion,
    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY p.max_adverse_excursion)
      FILTER (WHERE p.observed_days >= 40 AND p.max_adverse_excursion IS NOT NULL) AS p25_adverse_excursion,
    PERCENTILE_CONT(0.10) WITHIN GROUP (ORDER BY p.max_adverse_excursion)
      FILTER (WHERE p.observed_days >= 40 AND p.max_adverse_excursion IS NOT NULL) AS p10_adverse_excursion,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY p.max_drawdown)
      FILTER (WHERE p.observed_days >= 40 AND p.max_drawdown IS NOT NULL) AS median_max_drawdown,
    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY p.max_drawdown)
      FILTER (WHERE p.observed_days >= 40 AND p.max_drawdown IS NOT NULL) AS p25_max_drawdown,
    PERCENTILE_CONT(0.10) WITHIN GROUP (ORDER BY p.max_drawdown)
      FILTER (WHERE p.observed_days >= 40 AND p.max_drawdown IS NOT NULL) AS p10_max_drawdown,
    MIN(p.max_drawdown)
      FILTER (WHERE p.observed_days >= 40 AND p.max_drawdown IS NOT NULL) AS worst_max_drawdown,
    AVG(CASE WHEN p.observed_days >= 40 AND p.max_drawdown IS NOT NULL
      THEN CASE WHEN p.max_drawdown <= -0.05 THEN 1.0 ELSE 0.0 END END) AS prob_drawdown_gt_5,
    AVG(CASE WHEN p.observed_days >= 40 AND p.max_drawdown IS NOT NULL
      THEN CASE WHEN p.max_drawdown <= -0.10 THEN 1.0 ELSE 0.0 END END) AS prob_drawdown_gt_10,
    AVG(CASE WHEN p.observed_days >= 40 AND p.max_drawdown IS NOT NULL
      THEN CASE WHEN p.max_drawdown <= -0.15 THEN 1.0 ELSE 0.0 END END) AS prob_drawdown_gt_15,
    AVG(CASE WHEN p.observed_days >= 40 AND p.max_drawdown IS NOT NULL
      THEN CASE WHEN p.max_drawdown <= -0.20 THEN 1.0 ELSE 0.0 END END) AS prob_drawdown_gt_20,
    AVG(CASE WHEN s.h60_return IS NULL THEN NULL WHEN s.h60_return < 0 THEN 1.0 ELSE 0.0 END) AS loss_rate_h60,
    AVG(CASE WHEN s.h60_return IS NULL THEN NULL WHEN s.h60_return <= -0.10 THEN 1.0 ELSE 0.0 END) AS severe_loss_rate_h60,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY p.first_recovery_day)
      FILTER (WHERE p.observed_days >= 40 AND p.first_recovery_day IS NOT NULL) AS median_recovery_days,
    AVG(CASE WHEN p.observed_days >= 40 AND p.max_adverse_excursion IS NOT NULL
      THEN CASE
        WHEN p.max_adverse_excursion >= 0 THEN 1.0
        WHEN p.first_recovery_day IS NOT NULL AND p.first_recovery_day <= 60 THEN 1.0
        ELSE 0.0
      END END) AS recovered_by_horizon_rate
  FROM sector_analog_path_by_event p
  LEFT JOIN sector_analog_sample s
    ON s.symbol = p.symbol
   AND s.analog_date = p.analog_date
)

-- ═════════════════════════════════════════════════════════════════════════════
-- OUTPUT: one-row jsonb carrying the sector-side portions of Research Object
-- ═════════════════════════════════════════════════════════════════════════════

SELECT JSONB_BUILD_OBJECT(
  'meta', JSONB_BUILD_OBJECT(
    'schema_version', 'research_object_v6b_sector_aggregates',
    'canon',          'institutional_intelligence_layer_2026_04_23',
    'sector',         :SECTOR,
    'current_regime', :CURRENT_REGIME,
    'pe_bin',         :PE_BIN,
    'rsi_bin',        :RSI_BIN,
    'valuation_bucket', :VALUATION_BUCKET
  ),

  -- Object 6: PORTFOLIO CONTEXT (peer matrix)
  'portfolio_context', JSONB_BUILD_OBJECT(
    'composite_rank_in_sector',
      ROUND((COALESCE((SELECT composite_pct FROM target_peer), 0) * 100)::numeric, 1),
    'sector_rank_components', JSONB_BUILD_OBJECT(
      'roe_pct',            ROUND((COALESCE((SELECT roe_pct FROM target_peer), 0) * 100)::numeric, 1),
      'fcf_yield_pct',      ROUND((COALESCE((SELECT fcf_pct FROM target_peer), 0) * 100)::numeric, 1),
      'npm_pct',            ROUND((COALESCE((SELECT npm_pct FROM target_peer), 0) * 100)::numeric, 1),
      'low_leverage_pct',   ROUND((COALESCE((SELECT d2e_pct_lowbetter FROM target_peer), 0) * 100)::numeric, 1),
      'rev_growth_pct',     ROUND((COALESCE((SELECT rev_growth_pct FROM target_peer), 0) * 100)::numeric, 1)
    ),
    'better_state_peers_in_sector', COALESCE((SELECT peers FROM top_peers_json), '[]'::jsonb)
  ),

  -- Regime context supplement: sector forward performance under every regime×valuation
  'regime_context_sector', JSONB_BUILD_OBJECT(
    'sector_by_regime_valuation', COALESCE((SELECT rows FROM sector_by_regime_json), '[]'::jsonb)
  ),

  -- Object 5 input (Q3 sector analogs — bucket aggregate)
  'analog_evidence_sector', JSONB_BUILD_OBJECT(
    'bucket_key', JSONB_BUILD_OBJECT(
      'sector', :SECTOR, 'pe_bin', :PE_BIN, 'rsi_bin', :RSI_BIN,
      'regime', :CURRENT_REGIME
    ),
    'n',            (SELECT n FROM target_bucket),
    'n_with_h60',   (SELECT n_with_h60 FROM target_bucket),
    'h60_median_pct', ROUND(((SELECT median_h60 FROM target_bucket) * 100)::numeric, 2),
    'h60_p25_pct',    ROUND(((SELECT p25_h60    FROM target_bucket) * 100)::numeric, 2),
    'h60_p75_pct',    ROUND(((SELECT p75_h60    FROM target_bucket) * 100)::numeric, 2),
    'h60_hit_rate',   ROUND(((SELECT wins_h60::numeric / NULLIF(total_h60, 0) * 100 FROM target_bucket)), 1),
    'h252_median_pct',ROUND(((SELECT median_h252 FROM target_bucket) * 100)::numeric, 2),
    'h252_hit_rate',  ROUND(((SELECT wins_h252::numeric / NULLIF(total_h252, 0) * 100 FROM target_bucket)), 1),
    'sample_adequacy', CASE
      WHEN (SELECT n_with_h60 FROM target_bucket) IS NULL OR (SELECT n_with_h60 FROM target_bucket) < 30  THEN 'INSUFFICIENT'
      WHEN (SELECT n_with_h60 FROM target_bucket) < 100 THEN 'WEAK'
      WHEN (SELECT n_with_h60 FROM target_bucket) < 500 THEN 'ADEQUATE'
      ELSE 'ROBUST'
    END,
    'adjacent_bucket_fallback', JSONB_BUILD_OBJECT(
      'n',             (SELECT n FROM adjacent_buckets),
      'h60_hit_rate',  ROUND(((SELECT hit_rate_h60  FROM adjacent_buckets))::numeric, 1),
      'h252_hit_rate', ROUND(((SELECT hit_rate_h252 FROM adjacent_buckets))::numeric, 1),
      'avg_median_h60',ROUND(((SELECT avg_median_h60 FROM adjacent_buckets) * 100)::numeric, 2)
    ),
    'path_risk_base', JSONB_BUILD_OBJECT(
      'source', 'pg_daily_price_path_sector_analogs',
      'horizon', '60-day',
      'n', (SELECT path_n FROM sector_path_risk_summary),
      'loss_rate_h60_pct', ROUND(((SELECT loss_rate_h60 FROM sector_path_risk_summary) * 100)::numeric, 1),
      'severe_loss_rate_h60_pct', ROUND(((SELECT severe_loss_rate_h60 FROM sector_path_risk_summary) * 100)::numeric, 1),
      'median_adverse_excursion_pct', ROUND(((SELECT median_adverse_excursion FROM sector_path_risk_summary) * 100)::numeric, 2),
      'p25_adverse_excursion_pct', ROUND(((SELECT p25_adverse_excursion FROM sector_path_risk_summary) * 100)::numeric, 2),
      'p10_adverse_excursion_pct', ROUND(((SELECT p10_adverse_excursion FROM sector_path_risk_summary) * 100)::numeric, 2),
      'median_max_drawdown_pct', ROUND(((SELECT median_max_drawdown FROM sector_path_risk_summary) * 100)::numeric, 2),
      'p25_max_drawdown_pct', ROUND(((SELECT p25_max_drawdown FROM sector_path_risk_summary) * 100)::numeric, 2),
      'p10_max_drawdown_pct', ROUND(((SELECT p10_max_drawdown FROM sector_path_risk_summary) * 100)::numeric, 2),
      'worst_max_drawdown_pct', ROUND(((SELECT worst_max_drawdown FROM sector_path_risk_summary) * 100)::numeric, 2),
      'prob_drawdown_gt_5_pct', ROUND(((SELECT prob_drawdown_gt_5 FROM sector_path_risk_summary) * 100)::numeric, 1),
      'prob_drawdown_gt_10_pct', ROUND(((SELECT prob_drawdown_gt_10 FROM sector_path_risk_summary) * 100)::numeric, 1),
      'prob_drawdown_gt_15_pct', ROUND(((SELECT prob_drawdown_gt_15 FROM sector_path_risk_summary) * 100)::numeric, 1),
      'prob_drawdown_gt_20_pct', ROUND(((SELECT prob_drawdown_gt_20 FROM sector_path_risk_summary) * 100)::numeric, 1),
      'median_recovery_days', ROUND((SELECT median_recovery_days FROM sector_path_risk_summary)::numeric, 0),
      'recovered_by_horizon_rate_pct', ROUND(((SELECT recovered_by_horizon_rate FROM sector_path_risk_summary) * 100)::numeric, 1),
      'sample_adequacy', CASE
        WHEN COALESCE((SELECT path_n FROM sector_path_risk_summary), 0) < 30 THEN 'INSUFFICIENT'
        WHEN (SELECT path_n FROM sector_path_risk_summary) < 100 THEN 'WEAK'
        WHEN (SELECT path_n FROM sector_path_risk_summary) < 300 THEN 'ADEQUATE'
        ELSE 'ROBUST'
      END
    )
  ),

  -- Object: INVALIDATION (Q5) — win vs loss profile from target's bucket
  'invalidation', JSONB_BUILD_OBJECT(
    'win_vs_loss_profile', JSONB_BUILD_OBJECT(
      'pe_pct_in_wins',     ROUND(((SELECT win_pe_pct_mean  FROM target_bucket) * 100)::numeric, 1),
      'pe_pct_in_losses',   ROUND(((SELECT loss_pe_pct_mean FROM target_bucket) * 100)::numeric, 1),
      'rsi_in_wins',        ROUND((SELECT win_rsi_mean  FROM target_bucket)::numeric, 1),
      'rsi_in_losses',      ROUND((SELECT loss_rsi_mean FROM target_bucket)::numeric, 1),
      'sma_dist_in_wins',   ROUND(((SELECT win_sma_mean  FROM target_bucket) * 100)::numeric, 2),
      'sma_dist_in_losses', ROUND(((SELECT loss_sma_mean FROM target_bucket) * 100)::numeric, 2),
      'roe_in_wins',        ROUND(((SELECT win_roe_mean  FROM target_bucket) * 100)::numeric, 2),
      'roe_in_losses',      ROUND(((SELECT loss_roe_mean FROM target_bucket) * 100)::numeric, 2)
    ),
    'total_wins',   (SELECT n_wins   FROM target_bucket),
    'total_losses', (SELECT n_losses FROM target_bucket),
    'sample_adequacy', CASE
      WHEN (COALESCE((SELECT n_wins FROM target_bucket), 0) + COALESCE((SELECT n_losses FROM target_bucket), 0)) < 30 THEN 'INSUFFICIENT'
      WHEN (COALESCE((SELECT n_wins FROM target_bucket), 0) + COALESCE((SELECT n_losses FROM target_bucket), 0)) < 100 THEN 'WEAK'
      WHEN (COALESCE((SELECT n_wins FROM target_bucket), 0) + COALESCE((SELECT n_losses FROM target_bucket), 0)) < 300 THEN 'ADEQUATE'
      ELSE 'ROBUST'
    END
  ),

  -- Edge evidence seam — API layer populates from SQLite grahamy_discovery.db
  'edge_evidence', JSONB_BUILD_OBJECT(
    '_bridge_required', TRUE,
    '_bridge_note',     'Application layer must resolve: active CONFIRMED edges × symbol × current regime, convergence count, Sentinel forward WR, Coroner decay state from SQLite grahamy_discovery.db.'
  )
) AS research_object_sector;
