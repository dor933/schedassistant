WITH config AS (
  SELECT
    (SELECT MAX(as_of_date) FROM md_research_sector_peer_daily) AS target_date,
    NULLIF(CAST(:LEFT_SECTOR AS text), '') AS left_sector,
    NULLIF(CAST(:RIGHT_SECTOR AS text), '') AS right_sector
),
requested AS (
  SELECT 'left'::text AS side, c.left_sector AS sector FROM config c
  UNION ALL
  SELECT 'right'::text AS side, c.right_sector AS sector FROM config c
),
sector_peer AS (
  SELECT
    p.sector,
    COUNT(*) AS sector_symbol_count,
    AVG(p.composite_pct) * 100.0 AS conviction_score_pct,
    AVG((COALESCE(p.roe_pct, 0.5) + COALESCE(p.fcf_pct, 0.5) + COALESCE(p.npm_pct, 0.5)) / 3.0) * 100.0 AS quality_score_pct,
    AVG(p.rev_growth_pct) * 100.0 AS growth_score_pct,
    AVG(p.d2e_pct_lowbetter) * 100.0 AS leverage_score_pct
  FROM md_research_sector_peer_daily p
  JOIN config c ON p.as_of_date = c.target_date
  WHERE p.sector IN (c.left_sector, c.right_sector)
  GROUP BY p.sector
),
sector_momentum AS (
  SELECT
    h.sector,
    AVG(h.relative_strength_4w) AS avg_rs_4w,
    AVG(h.perf_month) AS avg_perf_month
  FROM md_historical_features_daily h
  JOIN config c ON h.as_of_date = c.target_date
  WHERE h.is_delisted = false
    AND h.sector IN (c.left_sector, c.right_sector)
  GROUP BY h.sector
),
current_regime AS (
  SELECT h.market_regime
  FROM md_historical_features_daily h
  JOIN config c ON h.as_of_date = c.target_date
  WHERE h.symbol = 'SPY'
    AND h.is_delisted = false
  LIMIT 1
),
sector_forward AS (
  SELECT
    f.sector,
    SUM(f.n_with_h60) AS sample_size,
    SUM(f.wins_h60)::numeric / NULLIF(SUM(f.total_h60), 0) * 100.0 AS hit_rate_pct
  FROM md_research_sector_regime_fwd_agg f
  JOIN current_regime r ON f.market_regime = r.market_regime
  JOIN config c ON f.sector IN (c.left_sector, c.right_sector)
  WHERE f.sector IS NOT NULL
  GROUP BY f.sector
),
side_metrics AS (
  SELECT
    req.side,
    req.sector,
    sp.sector IS NOT NULL AS sector_found,
    ROUND(sp.conviction_score_pct::numeric, 1) AS conviction_score_pct,
    CASE
      WHEN sp.conviction_score_pct >= 75 THEN 'HIGH'
      WHEN sp.conviction_score_pct >= 60 THEN 'CONSTRUCTIVE'
      WHEN sp.conviction_score_pct >= 45 THEN 'MIXED'
      WHEN sp.conviction_score_pct IS NULL THEN NULL
      ELSE 'WEAK'
    END AS conviction_bucket,
    CASE
      WHEN sm.avg_perf_month >= 0.05 OR sm.avg_rs_4w >= 0.03 THEN 'STRONG'
      WHEN sm.avg_perf_month >= 0.00 OR sm.avg_rs_4w >= 0.00 THEN 'MIXED'
      WHEN sm.avg_perf_month IS NULL AND sm.avg_rs_4w IS NULL THEN NULL
      ELSE 'WEAK'
    END AS momentum_bucket,
    CASE
      WHEN sp.quality_score_pct >= 70 THEN 'STRONG'
      WHEN sp.quality_score_pct >= 55 THEN 'CONSTRUCTIVE'
      WHEN sp.quality_score_pct IS NULL THEN NULL
      ELSE 'WEAK'
    END AS quality_bucket,
    CASE
      WHEN sp.growth_score_pct >= 70 THEN 'STRONG'
      WHEN sp.growth_score_pct >= 55 THEN 'CONSTRUCTIVE'
      WHEN sp.growth_score_pct IS NULL THEN NULL
      ELSE 'WEAK'
    END AS growth_bucket,
    CASE
      WHEN sp.leverage_score_pct >= 70 THEN 'STRONG'
      WHEN sp.leverage_score_pct >= 55 THEN 'CONSTRUCTIVE'
      WHEN sp.leverage_score_pct IS NULL THEN NULL
      ELSE 'WEAK'
    END AS leverage_bucket,
    ROUND(sf.hit_rate_pct::numeric, 1) AS hit_rate_pct,
    sf.sample_size IS NOT NULL AS forward_overlay_available
  FROM requested req
  LEFT JOIN sector_peer sp ON sp.sector = req.sector
  LEFT JOIN sector_momentum sm ON sm.sector = req.sector
  LEFT JOIN sector_forward sf ON sf.sector = req.sector
),
freshness AS (
  SELECT
    MAX(last_success_at) FILTER (WHERE mv_name = 'md_research_sector_peer_daily') AS peer_completed_at,
    MAX(state) FILTER (WHERE mv_name = 'md_research_sector_peer_daily') AS peer_freshness_state,
    MAX(last_success_at) FILTER (WHERE mv_name = 'md_research_sector_regime_fwd_agg') AS forward_completed_at,
    MAX(state) FILTER (WHERE mv_name = 'md_research_sector_regime_fwd_agg') AS forward_freshness_state
  FROM md_research_refresh_stale
  WHERE mv_name IN (
    'md_research_sector_peer_daily',
    'md_research_sector_regime_fwd_agg'
  )
)
SELECT
  c.left_sector,
  c.right_sector,
  c.target_date AS as_of_date,
  l.sector_found AS left_sector_found,
  r.sector_found AS right_sector_found,
  l.conviction_score_pct AS left_conviction_score_pct,
  l.conviction_bucket AS left_conviction_bucket,
  l.momentum_bucket AS left_momentum_bucket,
  l.quality_bucket AS left_quality_bucket,
  l.growth_bucket AS left_growth_bucket,
  l.leverage_bucket AS left_leverage_bucket,
  l.hit_rate_pct AS left_hit_rate_pct,
  r.conviction_score_pct AS right_conviction_score_pct,
  r.conviction_bucket AS right_conviction_bucket,
  r.momentum_bucket AS right_momentum_bucket,
  r.quality_bucket AS right_quality_bucket,
  r.growth_bucket AS right_growth_bucket,
  r.leverage_bucket AS right_leverage_bucket,
  r.hit_rate_pct AS right_hit_rate_pct,
  f.peer_freshness_state,
  f.peer_completed_at,
  f.forward_freshness_state,
  f.forward_completed_at,
  l.forward_overlay_available AS left_forward_overlay_available,
  r.forward_overlay_available AS right_forward_overlay_available
FROM config c
LEFT JOIN side_metrics l ON l.side = 'left'
LEFT JOIN side_metrics r ON r.side = 'right'
CROSS JOIN freshness f;
