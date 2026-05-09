-- Industry-internal "leading stocks" ranking. Mirrors query_sector_leaders.sql
-- but pre-filters to a single industry (case-insensitive) by joining through
-- `md_symbols.industry_id → md_industries.name`. Returns empty when
-- :INDUSTRY_FILTER is null/empty so the capability builder can fall back to
-- an unavailable view.
--
-- Note: there is no industry-level peer MV (md_research_industry_peer_daily
-- doesn't exist), so the conviction signal still comes from
-- md_research_sector_peer_daily.composite_pct — sector-relative, not
-- industry-relative. The agent surface explains this nuance to the user.
WITH config AS (
  SELECT
    (SELECT MAX(computed_date) FROM md_features_daily) AS target_date,
    LEAST(GREATEST(CAST(:MAX_ROWS AS integer), 1), 20) AS max_rows,
    LEAST(GREATEST(CAST(:CANDIDATE_POOL_SIZE AS integer), 1), 500) AS candidate_pool_size,
    CAST(:RANK_BY AS text) AS rank_by,
    NULLIF(TRIM(CAST(:INDUSTRY_FILTER AS text)), '') AS industry_filter
),
current_rows AS (
  SELECT
    f.symbol,
    ms.name AS company_name,
    p.sector,
    ind.name AS industry,
    f.computed_date AS as_of_date,
    f.price,
    f.market_cap,
    f.avg_dollar_volume,
    f.relative_strength_12w,
    f.perf_month,
    f.rsi_14,
    f.fcf_yield,
    f.piotroski_score,
    f.altman_z_score,
    f.revenue_growth_yoy,
    f.pe_vs_10yr_avg,
    p.composite_pct
  FROM md_features_daily f
  JOIN config c ON f.computed_date = c.target_date
  JOIN md_symbols ms ON ms.symbol = f.symbol
  JOIN md_exchanges e ON e.id = ms.exchange_id
  JOIN md_industries ind ON ind.id = ms.industry_id
  LEFT JOIN md_research_sector_peer_daily p
    ON p.symbol = f.symbol
   AND p.as_of_date = c.target_date
  WHERE ms.is_active = true
    AND e.name IN ('NYSE', 'NASDAQ', 'AMEX')
    AND f.price >= 5
    AND COALESCE(f.market_cap, 0) >= 300000000
    AND COALESCE(f.avg_dollar_volume, 0) >= 5000000
    AND c.industry_filter IS NOT NULL
    AND LOWER(ind.name) = LOWER(c.industry_filter)
),
scored AS (
  SELECT
    c.*,
    CASE
      WHEN c.composite_pct >= 0.75 THEN 'HIGH'
      WHEN c.composite_pct >= 0.60 THEN 'CONSTRUCTIVE'
      WHEN c.composite_pct >= 0.45 THEN 'MIXED'
      ELSE 'WEAK'
    END AS conviction_bucket,
    CASE
      WHEN c.composite_pct IS NOT NULL THEN 'CURRENT_PG_PEER_COMPOSITE'
      ELSE 'CURRENT_PG_FEATURES_ONLY'
    END AS evidence_strength,
    CASE
      WHEN COALESCE(c.relative_strength_12w, c.perf_month) >= 0.10 THEN 'STRONG'
      WHEN COALESCE(c.relative_strength_12w, c.perf_month) >= 0.03 THEN 'CONSTRUCTIVE'
      WHEN COALESCE(c.relative_strength_12w, c.perf_month) >= 0.00 THEN 'MIXED'
      WHEN c.relative_strength_12w IS NULL AND c.perf_month IS NULL THEN NULL
      ELSE 'WEAK'
    END AS momentum_bucket,
    CASE
      WHEN c.piotroski_score >= 7
        OR c.altman_z_score >= 3
        OR c.fcf_yield >= 0.05
        THEN 'STRONG'
      WHEN c.piotroski_score >= 5
        OR c.altman_z_score >= 1.8
        OR c.fcf_yield >= 0
        THEN 'CONSTRUCTIVE'
      WHEN c.piotroski_score IS NULL
       AND c.altman_z_score IS NULL
       AND c.fcf_yield IS NULL
        THEN NULL
      ELSE 'WEAK'
    END AS quality_bucket,
    CASE
      WHEN c.pe_vs_10yr_avg <= -0.20 OR c.fcf_yield >= 0.08 THEN 'ATTRACTIVE'
      WHEN c.pe_vs_10yr_avg <= 0.10 OR c.fcf_yield >= 0.03 THEN 'FAIR'
      WHEN c.pe_vs_10yr_avg IS NULL AND c.fcf_yield IS NULL THEN NULL
      ELSE 'RICH'
    END AS valuation_bucket,
    (
      COALESCE(c.composite_pct, 0.50) * 45.0
      + CASE
          WHEN COALESCE(c.relative_strength_12w, c.perf_month, 0) >= 0.10 THEN 25
          WHEN COALESCE(c.relative_strength_12w, c.perf_month, 0) >= 0.03 THEN 20
          WHEN COALESCE(c.relative_strength_12w, c.perf_month, 0) >= 0.00 THEN 12
          ELSE 5
        END
      + CASE
          WHEN c.piotroski_score >= 7 THEN 15
          WHEN c.piotroski_score >= 5 THEN 10
          ELSE 4
        END
      + CASE
          WHEN c.fcf_yield >= 0.05 OR COALESCE(c.revenue_growth_yoy, 0) >= 0.10 THEN 15
          WHEN c.fcf_yield >= 0 OR COALESCE(c.revenue_growth_yoy, 0) >= 0 THEN 8
          ELSE 3
        END
    ) AS setup_score
  FROM current_rows c
),
candidate_pool AS (
  SELECT
    s.*,
    ROW_NUMBER() OVER (
      ORDER BY
        CASE WHEN (SELECT rank_by FROM config) = 'conviction'
          THEN s.composite_pct * 100 END DESC NULLS LAST,
        CASE WHEN (SELECT rank_by FROM config) IN ('historical_forward', 'risk_adjusted')
          THEN s.setup_score END DESC NULLS LAST,
        s.setup_score DESC NULLS LAST,
        s.avg_dollar_volume DESC NULLS LAST,
        s.symbol ASC
    ) AS pool_rank
  FROM scored s
),
forward_overlay AS (
  SELECT
    fr.symbol,
    COUNT(fr.h60_return) AS sample_size,
    AVG(CASE WHEN fr.h60_return > 0 THEN 1.0 ELSE 0.0 END) * 100.0 AS hit_rate_pct,
    PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY fr.h60_return) * 100.0 AS median_return_pct,
    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY fr.h60_return) * 100.0 AS p25_return_pct,
    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY fr.h60_return) * 100.0 AS p75_return_pct
  FROM md_forward_returns fr
  JOIN candidate_pool cp
    ON cp.symbol = fr.symbol
   AND cp.pool_rank <= (SELECT candidate_pool_size FROM config)
  JOIN config c ON true
  WHERE fr.h60_return IS NOT NULL
    AND fr.as_of_date < c.target_date
    AND fr.as_of_date >= c.target_date - INTERVAL '5 years'
  GROUP BY fr.symbol
),
freshness AS (
  -- Industry has no dedicated peer MV, so freshness keys off md_features_daily
  -- only. peer_freshness_state is still surfaced (sector composite_pct comes
  -- from the sector MV) so the agent can warn if the conviction signal is
  -- stale.
  SELECT
    (SELECT MAX(computed_at) FROM md_features_daily f JOIN config c ON f.computed_date = c.target_date) AS features_completed_at,
    CASE WHEN (SELECT MAX(computed_date) FROM md_features_daily) >= CURRENT_DATE - INTERVAL '10 days'
      THEN 'FRESH'
      ELSE 'STALE'
    END AS features_freshness_state,
    MAX(last_success_at) FILTER (WHERE mv_name = 'md_research_sector_peer_daily') AS peer_completed_at,
    MAX(state) FILTER (WHERE mv_name = 'md_research_sector_peer_daily') AS peer_freshness_state
  FROM md_research_refresh_stale
  WHERE mv_name = 'md_research_sector_peer_daily'
),
ranked AS (
  -- Single-industry ranking — all rows belong to one industry, so partitioning
  -- by industry reduces to a global ORDER BY across the filtered pool. Keep
  -- the structure parallel to query_sector_leaders for readability.
  SELECT
    cp.*,
    fo.sample_size,
    fo.hit_rate_pct,
    fo.median_return_pct,
    fo.p25_return_pct,
    fo.p75_return_pct,
    ROW_NUMBER() OVER (
      ORDER BY
        CASE WHEN (SELECT rank_by FROM config) = 'historical_forward'
          THEN fo.hit_rate_pct END DESC NULLS LAST,
        CASE WHEN (SELECT rank_by FROM config) = 'risk_adjusted'
          THEN COALESCE(fo.median_return_pct, 0) - ABS(COALESCE(fo.p25_return_pct, 0)) END DESC NULLS LAST,
        CASE WHEN (SELECT rank_by FROM config) = 'conviction'
          THEN cp.composite_pct * 100 END DESC NULLS LAST,
        cp.setup_score DESC NULLS LAST,
        cp.avg_dollar_volume DESC NULLS LAST,
        cp.symbol ASC
    ) AS stock_rank
  FROM candidate_pool cp
  LEFT JOIN forward_overlay fo ON fo.symbol = cp.symbol
  WHERE cp.pool_rank <= (SELECT candidate_pool_size FROM config)
)
SELECT
  d.symbol,
  d.company_name,
  d.sector,
  d.industry,
  d.stock_rank AS rank,
  ROUND((d.composite_pct * 100.0)::numeric, 1) AS conviction_score_pct,
  d.conviction_bucket,
  CASE
    WHEN COALESCE(d.sample_size, 0) >= 100 THEN 'ROBUST'
    WHEN COALESCE(d.sample_size, 0) >= 30 THEN 'ADEQUATE'
    WHEN d.sample_size IS NULL THEN 'CURRENT_ONLY'
    ELSE 'THIN'
  END AS evidence_strength,
  ROUND(d.hit_rate_pct::numeric, 1) AS hit_rate_pct,
  ROUND(d.median_return_pct::numeric, 2) AS median_return_pct,
  ROUND(d.p25_return_pct::numeric, 2) AS p25_return_pct,
  ROUND(d.p75_return_pct::numeric, 2) AS p75_return_pct,
  d.momentum_bucket,
  d.quality_bucket,
  d.valuation_bucket,
  'Numeric daily path-risk is unavailable in V1.' AS path_risk_bucket,
  d.as_of_date,
  f.features_freshness_state,
  f.features_completed_at,
  f.peer_freshness_state,
  f.peer_completed_at,
  d.sample_size IS NOT NULL AS forward_overlay_available
FROM ranked d
CROSS JOIN freshness f
WHERE d.stock_rank <= (SELECT max_rows FROM config)
ORDER BY d.stock_rank;
