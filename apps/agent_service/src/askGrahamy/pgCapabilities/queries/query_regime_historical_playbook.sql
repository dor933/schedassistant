WITH config AS (
  SELECT
    LEAST(GREATEST(CAST(:MAX_ROWS AS integer), 1), 20) AS max_rows,
    COALESCE(NULLIF(CAST(:ROLE_FILTER AS text), ''), 'general') AS role_filter
),
current_regime AS (
  SELECT
    h.as_of_date,
    h.market_regime
  FROM md_historical_features_daily h
  WHERE h.symbol = 'SPY'
    AND h.is_delisted = false
    AND h.market_regime IS NOT NULL
  ORDER BY h.as_of_date DESC
  LIMIT 1
),
sector_rollup AS (
  SELECT
    f.sector,
    SUM(f.n_with_h60) AS sample_size,
    SUM(f.avg_h60 * f.n_with_h60)::numeric / NULLIF(SUM(f.n_with_h60), 0) AS weighted_avg_h60,
    SUM(f.wins_h60)::numeric / NULLIF(SUM(f.total_h60), 0) * 100.0 AS hit_rate_pct,
    SUM(f.total_h60) AS total_h60
  FROM md_research_sector_regime_fwd_agg f
  JOIN current_regime r ON f.market_regime = r.market_regime
  WHERE f.sector IS NOT NULL
  GROUP BY f.sector
),
ranked AS (
  SELECT
    s.*,
    ROW_NUMBER() OVER (
      ORDER BY s.weighted_avg_h60 DESC NULLS LAST, s.hit_rate_pct DESC NULLS LAST, s.sector
    ) AS leader_rank,
    ROW_NUMBER() OVER (
      ORDER BY s.weighted_avg_h60 ASC NULLS LAST, s.hit_rate_pct ASC NULLS LAST, s.sector
    ) AS laggard_rank,
    COUNT(*) OVER () AS evaluated_sector_count,
    COUNT(*) FILTER (WHERE s.total_h60 >= 30) OVER () AS meaningful_sector_count
  FROM sector_rollup s
),
selected AS (
  SELECT
    r.*,
    CASE
      WHEN c.role_filter = 'laggards' THEN 'laggard'
      WHEN c.role_filter = 'leaders' THEN 'leader'
      WHEN r.leader_rank <= CEIL(c.max_rows / 2.0) THEN 'leader'
      WHEN r.laggard_rank <= FLOOR(c.max_rows / 2.0) THEN 'laggard'
      ELSE 'mixed'
    END AS role,
    CASE
      WHEN c.role_filter = 'laggards' THEN r.laggard_rank
      WHEN c.role_filter = 'leaders' THEN r.leader_rank
      WHEN r.leader_rank <= CEIL(c.max_rows / 2.0) THEN r.leader_rank
      ELSE r.laggard_rank
    END AS public_rank,
    CASE
      WHEN c.role_filter = 'laggards' THEN r.laggard_rank <= c.max_rows
      WHEN c.role_filter = 'leaders' THEN r.leader_rank <= c.max_rows
      ELSE r.leader_rank <= CEIL(c.max_rows / 2.0)
        OR r.laggard_rank <= FLOOR(c.max_rows / 2.0)
    END AS include_in_public
  FROM ranked r
  CROSS JOIN config c
),
vix_context AS (
  SELECT b.close AS vix_close
  FROM md_historical_benchmark_daily b
  JOIN current_regime r ON b.as_of_date <= r.as_of_date
  WHERE b.symbol = '^VIX'
  ORDER BY b.as_of_date DESC
  LIMIT 1
),
spx_context AS (
  SELECT b.perf_4w AS spx_perf_4w
  FROM md_historical_benchmark_daily b
  JOIN current_regime r ON b.as_of_date <= r.as_of_date
  WHERE b.symbol = '^GSPC'
  ORDER BY b.as_of_date DESC
  LIMIT 1
),
macro_context AS (
  SELECT
    m.pct_above_50dma,
    m.sector_perf_4w_stddev,
    m.sector_perf_4w_spread
  FROM md_macro_daily_snapshot m
  JOIN current_regime r ON m.as_of_date <= r.as_of_date
  ORDER BY m.as_of_date DESC
  LIMIT 1
),
risk_context AS (
  SELECT
    CASE
      WHEN (SELECT vix_close FROM vix_context) IS NULL THEN 'UNKNOWN'
      WHEN (SELECT vix_close FROM vix_context) >= 30 THEN 'STRESSED'
      WHEN (SELECT vix_close FROM vix_context) >= 22 THEN 'ELEVATED'
      WHEN (SELECT vix_close FROM vix_context) >= 16 THEN 'MODERATE'
      ELSE 'LOW'
    END AS vix_risk_bucket,
    CASE
      WHEN (SELECT pct_above_50dma FROM macro_context) IS NULL THEN 'UNKNOWN'
      WHEN (SELECT pct_above_50dma FROM macro_context) >= 0.60 THEN 'BROAD'
      WHEN (SELECT pct_above_50dma FROM macro_context) >= 0.40 THEN 'MIXED'
      ELSE 'NARROW'
    END AS breadth_risk_bucket,
    CASE
      WHEN (SELECT sector_perf_4w_spread FROM macro_context) IS NULL
        AND (SELECT sector_perf_4w_stddev FROM macro_context) IS NULL THEN 'UNKNOWN'
      WHEN (SELECT sector_perf_4w_spread FROM macro_context) >= 0.20
        OR (SELECT sector_perf_4w_stddev FROM macro_context) >= 0.05 THEN 'ELEVATED'
      ELSE 'NORMAL'
    END AS dispersion_risk_bucket,
    CASE
      WHEN (SELECT spx_perf_4w FROM spx_context) IS NULL THEN 'UNKNOWN'
      WHEN (SELECT spx_perf_4w FROM spx_context) <= -0.05 THEN 'DRAWDOWN'
      WHEN (SELECT spx_perf_4w FROM spx_context) < 0.00 THEN 'WEAK'
      WHEN (SELECT spx_perf_4w FROM spx_context) >= 0.08 THEN 'STRONG_RALLY'
      ELSE 'POSITIVE'
    END AS trend_risk_bucket,
    (
      (SELECT vix_close FROM vix_context) IS NOT NULL
      OR (SELECT pct_above_50dma FROM macro_context) IS NOT NULL
      OR (SELECT sector_perf_4w_spread FROM macro_context) IS NOT NULL
      OR (SELECT spx_perf_4w FROM spx_context) IS NOT NULL
    ) AS risk_context_available
),
freshness AS (
  SELECT
    MAX(last_success_at) FILTER (WHERE mv_name = 'md_research_sector_regime_fwd_agg') AS regime_completed_at,
    MAX(state) FILTER (WHERE mv_name = 'md_research_sector_regime_fwd_agg') AS regime_freshness_state,
    MAX(last_success_at) FILTER (WHERE mv_name = 'md_macro_daily_snapshot') AS macro_completed_at,
    MAX(state) FILTER (WHERE mv_name = 'md_macro_daily_snapshot') AS macro_freshness_state
  FROM md_research_refresh_stale
  WHERE mv_name IN (
    'md_research_sector_regime_fwd_agg',
    'md_macro_daily_snapshot'
  )
)
SELECT
  cr.market_regime AS regime,
  cr.as_of_date,
  s.sector,
  s.public_rank AS rank,
  s.role,
  s.include_in_public,
  s.sample_size,
  ROUND(s.hit_rate_pct::numeric, 1) AS hit_rate_pct,
  NULL::numeric AS median_forward_return_pct,
  CASE
    WHEN s.sample_size >= 5000 THEN 'ROBUST'
    WHEN s.sample_size >= 1000 THEN 'ADEQUATE'
    WHEN s.sample_size >= 100 THEN 'THIN'
    ELSE 'SPARSE'
  END AS evidence_strength,
  rc.vix_risk_bucket,
  rc.breadth_risk_bucket,
  rc.dispersion_risk_bucket,
  rc.trend_risk_bucket,
  rc.risk_context_available,
  f.regime_freshness_state,
  f.regime_completed_at,
  f.macro_freshness_state,
  f.macro_completed_at,
  s.evaluated_sector_count,
  s.meaningful_sector_count
FROM current_regime cr
JOIN selected s ON true
CROSS JOIN risk_context rc
CROSS JOIN freshness f
WHERE s.include_in_public
ORDER BY
  CASE WHEN s.role = 'leader' THEN 0 WHEN s.role = 'laggard' THEN 1 ELSE 2 END,
  s.public_rank,
  s.sector;
