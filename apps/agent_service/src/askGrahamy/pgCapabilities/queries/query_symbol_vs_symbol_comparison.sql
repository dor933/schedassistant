WITH config AS (
  SELECT
    (SELECT MAX(computed_date) FROM md_features_daily) AS target_date,
    NULLIF(UPPER(CAST(:LEFT_SYMBOL AS text)), '') AS left_symbol,
    NULLIF(UPPER(CAST(:RIGHT_SYMBOL AS text)), '') AS right_symbol
),
requested AS (
  SELECT 'left'::text AS side, c.left_symbol AS symbol FROM config c
  UNION ALL
  SELECT 'right'::text AS side, c.right_symbol AS symbol FROM config c
),
stock_current AS (
  SELECT
    req.side,
    req.symbol AS requested_symbol,
    f.symbol,
    ms.name AS company_name,
    p.sector,
    f.computed_date AS as_of_date,
    f.relative_strength_12w,
    f.perf_month,
    f.fcf_yield,
    f.piotroski_score,
    f.altman_z_score,
    f.revenue_growth_yoy,
    f.pe_vs_10yr_avg,
    p.roe_pct,
    p.fcf_pct,
    p.npm_pct,
    p.d2e_pct_lowbetter,
    p.rev_growth_pct,
    p.composite_pct
  FROM requested req
  JOIN config c ON TRUE
  LEFT JOIN md_features_daily f
    ON f.computed_date = c.target_date
   AND f.symbol = req.symbol
  LEFT JOIN md_symbols ms ON ms.symbol = f.symbol
  LEFT JOIN md_research_sector_peer_daily p
    ON p.symbol = f.symbol
   AND p.as_of_date = c.target_date
),
stock_forward AS (
  SELECT
    fr.symbol,
    COUNT(fr.h60_return) AS sample_size,
    AVG(CASE WHEN fr.h60_return > 0 THEN 1.0 ELSE 0.0 END) * 100.0 AS hit_rate_pct,
    PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY fr.h60_return) * 100.0 AS median_return_pct
  FROM md_forward_returns fr
  JOIN config c ON fr.symbol IN (c.left_symbol, c.right_symbol)
  WHERE fr.h60_return IS NOT NULL
    AND fr.as_of_date < c.target_date
    AND fr.as_of_date >= c.target_date - INTERVAL '5 years'
  GROUP BY fr.symbol
),
side_metrics AS (
  SELECT
    sc.side,
    sc.requested_symbol,
    sc.symbol,
    sc.symbol IS NOT NULL AS symbol_found,
    sc.company_name,
    sc.sector,
    sc.as_of_date,
    ROUND((sc.composite_pct * 100.0)::numeric, 1) AS conviction_score_pct,
    CASE
      WHEN sc.composite_pct >= 0.75 THEN 'HIGH'
      WHEN sc.composite_pct >= 0.60 THEN 'CONSTRUCTIVE'
      WHEN sc.composite_pct >= 0.45 THEN 'MIXED'
      WHEN sc.composite_pct IS NULL THEN NULL
      ELSE 'WEAK'
    END AS conviction_bucket,
    CASE
      WHEN sc.pe_vs_10yr_avg <= -0.20 OR sc.fcf_yield >= 0.08 THEN 'ATTRACTIVE'
      WHEN sc.pe_vs_10yr_avg <= 0.10 OR sc.fcf_yield >= 0.03 THEN 'FAIR'
      WHEN sc.pe_vs_10yr_avg IS NULL AND sc.fcf_yield IS NULL THEN NULL
      ELSE 'RICH'
    END AS valuation_bucket,
    CASE
      WHEN COALESCE(sc.relative_strength_12w, sc.perf_month) >= 0.10 THEN 'STRONG'
      WHEN COALESCE(sc.relative_strength_12w, sc.perf_month) >= 0.03 THEN 'CONSTRUCTIVE'
      WHEN COALESCE(sc.relative_strength_12w, sc.perf_month) >= 0.00 THEN 'MIXED'
      WHEN sc.relative_strength_12w IS NULL AND sc.perf_month IS NULL THEN NULL
      ELSE 'WEAK'
    END AS momentum_bucket,
    CASE
      WHEN ((COALESCE(sc.roe_pct, 0.5) + COALESCE(sc.fcf_pct, 0.5) + COALESCE(sc.npm_pct, 0.5)) / 3.0) >= 0.70 THEN 'STRONG'
      WHEN ((COALESCE(sc.roe_pct, 0.5) + COALESCE(sc.fcf_pct, 0.5) + COALESCE(sc.npm_pct, 0.5)) / 3.0) >= 0.55 THEN 'CONSTRUCTIVE'
      WHEN sc.roe_pct IS NULL AND sc.fcf_pct IS NULL AND sc.npm_pct IS NULL THEN NULL
      ELSE 'WEAK'
    END AS quality_bucket,
    CASE
      WHEN sc.rev_growth_pct >= 0.70 THEN 'STRONG'
      WHEN sc.rev_growth_pct >= 0.55 THEN 'CONSTRUCTIVE'
      WHEN sc.rev_growth_pct IS NULL THEN NULL
      ELSE 'WEAK'
    END AS growth_bucket,
    CASE
      WHEN sc.d2e_pct_lowbetter >= 0.70 OR sc.altman_z_score >= 3 THEN 'STRONG'
      WHEN sc.d2e_pct_lowbetter >= 0.55 OR sc.altman_z_score >= 1.8 THEN 'CONSTRUCTIVE'
      WHEN sc.d2e_pct_lowbetter IS NULL AND sc.altman_z_score IS NULL THEN NULL
      ELSE 'WEAK'
    END AS leverage_bucket,
    ROUND(sf.hit_rate_pct::numeric, 1) AS hit_rate_pct,
    ROUND(sf.median_return_pct::numeric, 2) AS median_return_pct,
    sf.sample_size IS NOT NULL AS forward_overlay_available
  FROM stock_current sc
  LEFT JOIN stock_forward sf ON sf.symbol = sc.symbol
),
freshness AS (
  SELECT
    (SELECT MAX(computed_at) FROM md_features_daily f JOIN config c ON f.computed_date = c.target_date) AS features_completed_at,
    CASE WHEN (SELECT MAX(computed_date) FROM md_features_daily) >= CURRENT_DATE - INTERVAL '10 days'
      THEN 'FRESH'
      ELSE 'STALE'
    END AS features_freshness_state,
    MAX(last_success_at) FILTER (WHERE mv_name = 'md_research_sector_peer_daily') AS peer_completed_at,
    MAX(state) FILTER (WHERE mv_name = 'md_research_sector_peer_daily') AS peer_freshness_state,
    MAX(last_success_at) FILTER (WHERE mv_name = 'md_forward_returns') AS forward_completed_at,
    MAX(state) FILTER (WHERE mv_name = 'md_forward_returns') AS forward_freshness_state
  FROM md_research_refresh_stale
  WHERE mv_name IN (
    'md_research_sector_peer_daily',
    'md_forward_returns'
  )
)
SELECT
  c.left_symbol AS left_requested_symbol,
  c.right_symbol AS right_requested_symbol,
  c.target_date AS as_of_date,
  l.symbol AS left_symbol,
  r.symbol AS right_symbol,
  l.symbol_found AS left_symbol_found,
  r.symbol_found AS right_symbol_found,
  l.company_name AS left_company_name,
  r.company_name AS right_company_name,
  l.sector AS left_sector,
  r.sector AS right_sector,
  l.conviction_score_pct AS left_conviction_score_pct,
  l.conviction_bucket AS left_conviction_bucket,
  l.valuation_bucket AS left_valuation_bucket,
  l.momentum_bucket AS left_momentum_bucket,
  l.quality_bucket AS left_quality_bucket,
  l.growth_bucket AS left_growth_bucket,
  l.leverage_bucket AS left_leverage_bucket,
  l.hit_rate_pct AS left_hit_rate_pct,
  l.median_return_pct AS left_median_return_pct,
  r.conviction_score_pct AS right_conviction_score_pct,
  r.conviction_bucket AS right_conviction_bucket,
  r.valuation_bucket AS right_valuation_bucket,
  r.momentum_bucket AS right_momentum_bucket,
  r.quality_bucket AS right_quality_bucket,
  r.growth_bucket AS right_growth_bucket,
  r.leverage_bucket AS right_leverage_bucket,
  r.hit_rate_pct AS right_hit_rate_pct,
  r.median_return_pct AS right_median_return_pct,
  f.features_freshness_state,
  f.features_completed_at,
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
