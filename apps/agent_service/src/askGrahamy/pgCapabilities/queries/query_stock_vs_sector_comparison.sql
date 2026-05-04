WITH config AS (
  SELECT
    (SELECT MAX(computed_date) FROM md_features_daily) AS target_date,
    NULLIF(UPPER(CAST(:SYMBOL AS text)), '') AS symbol,
    NULLIF(CAST(:SECTOR AS text), '') AS requested_sector
),
stock_current AS (
  SELECT
    f.symbol,
    ms.name AS company_name,
    p.sector AS stock_sector,
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
  FROM md_features_daily f
  JOIN config c
    ON f.computed_date = c.target_date
   AND f.symbol = c.symbol
  JOIN md_symbols ms ON ms.symbol = f.symbol
  LEFT JOIN md_research_sector_peer_daily p
    ON p.symbol = f.symbol
   AND p.as_of_date = c.target_date
),
resolved AS (
  SELECT
    sc.*,
    c.requested_sector,
    COALESCE(c.requested_sector, sc.stock_sector) AS resolved_sector
  FROM stock_current sc
  CROSS JOIN config c
),
sector_peer AS (
  SELECT
    p.sector,
    COUNT(*) AS sector_symbol_count,
    AVG(p.composite_pct) * 100.0 AS sector_conviction_score_pct,
    AVG((COALESCE(p.roe_pct, 0.5) + COALESCE(p.fcf_pct, 0.5) + COALESCE(p.npm_pct, 0.5)) / 3.0) * 100.0 AS sector_quality_score_pct,
    AVG(p.rev_growth_pct) * 100.0 AS sector_growth_score_pct,
    AVG(p.d2e_pct_lowbetter) * 100.0 AS sector_leverage_score_pct
  FROM md_research_sector_peer_daily p
  JOIN config c ON p.as_of_date = c.target_date
  JOIN resolved r ON r.resolved_sector = p.sector
  GROUP BY p.sector
),
sector_momentum AS (
  SELECT
    h.sector,
    AVG(h.relative_strength_4w) AS avg_rs_4w,
    AVG(h.perf_month) AS avg_perf_month
  FROM md_historical_features_daily h
  JOIN config c ON h.as_of_date = c.target_date
  JOIN resolved r ON r.resolved_sector = h.sector
  WHERE h.is_delisted = false
    AND h.sector IS NOT NULL
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
stock_forward AS (
  SELECT
    fr.symbol,
    COUNT(fr.h60_return) AS sample_size,
    AVG(CASE WHEN fr.h60_return > 0 THEN 1.0 ELSE 0.0 END) * 100.0 AS hit_rate_pct,
    PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY fr.h60_return) * 100.0 AS median_return_pct
  FROM md_forward_returns fr
  JOIN config c ON fr.symbol = c.symbol
  WHERE fr.h60_return IS NOT NULL
    AND fr.as_of_date < c.target_date
    AND fr.as_of_date >= c.target_date - INTERVAL '5 years'
  GROUP BY fr.symbol
),
sector_forward AS (
  SELECT
    f.sector,
    SUM(f.n_with_h60) AS sample_size,
    SUM(f.wins_h60)::numeric / NULLIF(SUM(f.total_h60), 0) * 100.0 AS hit_rate_pct
  FROM md_research_sector_regime_fwd_agg f
  JOIN current_regime r ON f.market_regime = r.market_regime
  JOIN resolved rs ON rs.resolved_sector = f.sector
  WHERE f.sector IS NOT NULL
  GROUP BY f.sector
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
    MAX(last_success_at) FILTER (WHERE mv_name = 'md_research_sector_regime_fwd_agg') AS forward_completed_at,
    MAX(state) FILTER (WHERE mv_name = 'md_research_sector_regime_fwd_agg') AS forward_freshness_state
  FROM md_research_refresh_stale
  WHERE mv_name IN (
    'md_research_sector_peer_daily',
    'md_research_sector_regime_fwd_agg'
  )
)
SELECT
  r.symbol,
  r.company_name,
  r.stock_sector,
  r.requested_sector,
  r.resolved_sector,
  (r.requested_sector IS NULL OR sp.sector IS NOT NULL) AS explicit_sector_valid,
  (sp.sector IS NOT NULL) AS comparison_sector_found,
  r.as_of_date,
  ROUND((r.composite_pct * 100.0)::numeric, 1) AS stock_conviction_score_pct,
  CASE
    WHEN r.composite_pct >= 0.75 THEN 'HIGH'
    WHEN r.composite_pct >= 0.60 THEN 'CONSTRUCTIVE'
    WHEN r.composite_pct >= 0.45 THEN 'MIXED'
    WHEN r.composite_pct IS NULL THEN NULL
    ELSE 'WEAK'
  END AS stock_conviction_bucket,
  CASE
    WHEN r.pe_vs_10yr_avg <= -0.20 OR r.fcf_yield >= 0.08 THEN 'ATTRACTIVE'
    WHEN r.pe_vs_10yr_avg <= 0.10 OR r.fcf_yield >= 0.03 THEN 'FAIR'
    WHEN r.pe_vs_10yr_avg IS NULL AND r.fcf_yield IS NULL THEN NULL
    ELSE 'RICH'
  END AS stock_valuation_bucket,
  CASE
    WHEN COALESCE(r.relative_strength_12w, r.perf_month) >= 0.10 THEN 'STRONG'
    WHEN COALESCE(r.relative_strength_12w, r.perf_month) >= 0.03 THEN 'CONSTRUCTIVE'
    WHEN COALESCE(r.relative_strength_12w, r.perf_month) >= 0.00 THEN 'MIXED'
    WHEN r.relative_strength_12w IS NULL AND r.perf_month IS NULL THEN NULL
    ELSE 'WEAK'
  END AS stock_momentum_bucket,
  CASE
    WHEN ((COALESCE(r.roe_pct, 0.5) + COALESCE(r.fcf_pct, 0.5) + COALESCE(r.npm_pct, 0.5)) / 3.0) >= 0.70 THEN 'STRONG'
    WHEN ((COALESCE(r.roe_pct, 0.5) + COALESCE(r.fcf_pct, 0.5) + COALESCE(r.npm_pct, 0.5)) / 3.0) >= 0.55 THEN 'CONSTRUCTIVE'
    WHEN r.roe_pct IS NULL AND r.fcf_pct IS NULL AND r.npm_pct IS NULL THEN NULL
    ELSE 'WEAK'
  END AS stock_quality_bucket,
  CASE
    WHEN r.rev_growth_pct >= 0.70 THEN 'STRONG'
    WHEN r.rev_growth_pct >= 0.55 THEN 'CONSTRUCTIVE'
    WHEN r.rev_growth_pct IS NULL THEN NULL
    ELSE 'WEAK'
  END AS stock_growth_bucket,
  CASE
    WHEN r.d2e_pct_lowbetter >= 0.70 OR r.altman_z_score >= 3 THEN 'STRONG'
    WHEN r.d2e_pct_lowbetter >= 0.55 OR r.altman_z_score >= 1.8 THEN 'CONSTRUCTIVE'
    WHEN r.d2e_pct_lowbetter IS NULL AND r.altman_z_score IS NULL THEN NULL
    ELSE 'WEAK'
  END AS stock_leverage_bucket,
  ROUND(sf.hit_rate_pct::numeric, 1) AS stock_hit_rate_pct,
  ROUND(sf.median_return_pct::numeric, 2) AS stock_median_return_pct,
  ROUND(sp.sector_conviction_score_pct::numeric, 1) AS sector_conviction_score_pct,
  CASE
    WHEN sp.sector_conviction_score_pct >= 75 THEN 'HIGH'
    WHEN sp.sector_conviction_score_pct >= 60 THEN 'CONSTRUCTIVE'
    WHEN sp.sector_conviction_score_pct >= 45 THEN 'MIXED'
    WHEN sp.sector_conviction_score_pct IS NULL THEN NULL
    ELSE 'WEAK'
  END AS sector_conviction_bucket,
  CASE
    WHEN sm.avg_perf_month >= 0.05 OR sm.avg_rs_4w >= 0.03 THEN 'STRONG'
    WHEN sm.avg_perf_month >= 0.00 OR sm.avg_rs_4w >= 0.00 THEN 'MIXED'
    WHEN sm.avg_perf_month IS NULL AND sm.avg_rs_4w IS NULL THEN NULL
    ELSE 'WEAK'
  END AS sector_momentum_bucket,
  CASE
    WHEN sp.sector_quality_score_pct >= 70 THEN 'STRONG'
    WHEN sp.sector_quality_score_pct >= 55 THEN 'CONSTRUCTIVE'
    WHEN sp.sector_quality_score_pct IS NULL THEN NULL
    ELSE 'WEAK'
  END AS sector_quality_bucket,
  CASE
    WHEN sp.sector_growth_score_pct >= 70 THEN 'STRONG'
    WHEN sp.sector_growth_score_pct >= 55 THEN 'CONSTRUCTIVE'
    WHEN sp.sector_growth_score_pct IS NULL THEN NULL
    ELSE 'WEAK'
  END AS sector_growth_bucket,
  CASE
    WHEN sp.sector_leverage_score_pct >= 70 THEN 'STRONG'
    WHEN sp.sector_leverage_score_pct >= 55 THEN 'CONSTRUCTIVE'
    WHEN sp.sector_leverage_score_pct IS NULL THEN NULL
    ELSE 'WEAK'
  END AS sector_leverage_bucket,
  ROUND(sef.hit_rate_pct::numeric, 1) AS sector_hit_rate_pct,
  f.features_freshness_state,
  f.features_completed_at,
  f.peer_freshness_state,
  f.peer_completed_at,
  f.forward_freshness_state,
  f.forward_completed_at,
  sf.sample_size IS NOT NULL AS stock_forward_overlay_available,
  sef.sample_size IS NOT NULL AS sector_forward_overlay_available
FROM resolved r
LEFT JOIN sector_peer sp ON sp.sector = r.resolved_sector
LEFT JOIN sector_momentum sm ON sm.sector = r.resolved_sector
LEFT JOIN stock_forward sf ON sf.symbol = r.symbol
LEFT JOIN sector_forward sef ON sef.sector = r.resolved_sector
CROSS JOIN freshness f;
