WITH config AS (
  SELECT
    (SELECT MAX(computed_date) FROM md_features_daily) AS target_date,
    LEAST(GREATEST(CAST(:MAX_ROWS AS integer), 1), 20) AS max_rows,
    LEAST(GREATEST(CAST(:CANDIDATE_POOL_SIZE AS integer), 1), 500) AS candidate_pool_size,
    CAST(:VALUATION_BUCKET AS text) AS valuation_bucket,
    CAST(:QUALITY_BUCKET AS text) AS quality_bucket,
    CAST(:MOMENTUM_BUCKET AS text) AS momentum_bucket,
    CAST(:GROWTH_BUCKET AS text) AS growth_bucket,
    CAST(:LEVERAGE_BUCKET AS text) AS leverage_bucket,
    CAST(:RISK_BUCKET AS text) AS risk_bucket,
    CAST(:SECTOR_FILTER AS text) AS sector_filter
),
current_rows AS (
  SELECT
    f.symbol,
    ms.name AS company_name,
    p.sector,
    f.computed_date AS as_of_date,
    f.price,
    f.market_cap,
    f.avg_dollar_volume,
    f.relative_strength_12w,
    f.perf_month,
    f.rsi_14,
    f.beta,
    f.short_percent_of_float,
    f.fcf_yield,
    f.piotroski_score,
    f.altman_z_score,
    f.revenue_growth_yoy,
    f.eps_growth_yoy,
    f.fcf_growth_yoy,
    f.pe_vs_10yr_avg,
    p.composite_pct
  FROM md_features_daily f
  JOIN config cfg ON f.computed_date = cfg.target_date
  JOIN md_symbols ms ON ms.symbol = f.symbol
  JOIN md_exchanges e ON e.id = ms.exchange_id
  LEFT JOIN md_research_sector_peer_daily p
    ON p.symbol = f.symbol
   AND p.as_of_date = cfg.target_date
  WHERE ms.is_active = true
    AND e.name IN ('NYSE', 'NASDAQ', 'AMEX')
    AND f.price >= 5
    AND COALESCE(f.market_cap, 0) >= 300000000
    AND COALESCE(f.avg_dollar_volume, 0) >= 5000000
    AND p.sector IS NOT NULL
),
bucketed AS (
  SELECT
    c.*,
    CASE
      WHEN c.composite_pct >= 0.75 THEN 'HIGH'
      WHEN c.composite_pct >= 0.60 THEN 'CONSTRUCTIVE'
      WHEN c.composite_pct >= 0.45 THEN 'MIXED'
      ELSE 'WEAK'
    END AS conviction_bucket,
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
    CASE
      WHEN COALESCE(c.revenue_growth_yoy, c.eps_growth_yoy, c.fcf_growth_yoy) >= 0.10 THEN 'STRONG'
      WHEN c.revenue_growth_yoy IS NULL AND c.eps_growth_yoy IS NULL AND c.fcf_growth_yoy IS NULL THEN NULL
      ELSE 'WEAK'
    END AS growth_bucket,
    CASE
      WHEN c.altman_z_score >= 3 THEN 'STRONG'
      WHEN c.altman_z_score IS NULL THEN NULL
      WHEN c.altman_z_score < 1.8 THEN 'STRESSED'
      ELSE 'CONSTRUCTIVE'
    END AS leverage_bucket,
    CASE
      WHEN c.beta >= 1.5 OR c.short_percent_of_float >= 0.15 THEN 'ELEVATED'
      WHEN c.beta IS NULL AND c.short_percent_of_float IS NULL THEN NULL
      WHEN COALESCE(c.beta, 1.0) <= 0.8 AND COALESCE(c.short_percent_of_float, 0) <= 0.05 THEN 'LOW'
      ELSE 'MODERATE'
    END AS risk_bucket
  FROM current_rows c
),
filtered AS (
  SELECT b.*
  FROM bucketed b
  JOIN config cfg ON true
  WHERE (cfg.valuation_bucket IS NULL OR b.valuation_bucket = cfg.valuation_bucket)
    AND (cfg.quality_bucket IS NULL OR b.quality_bucket = cfg.quality_bucket)
    AND (cfg.momentum_bucket IS NULL OR b.momentum_bucket = cfg.momentum_bucket)
    AND (cfg.growth_bucket IS NULL OR b.growth_bucket = cfg.growth_bucket)
    AND (cfg.leverage_bucket IS NULL OR b.leverage_bucket = cfg.leverage_bucket)
    AND (cfg.risk_bucket IS NULL OR b.risk_bucket = cfg.risk_bucket)
    AND (cfg.sector_filter IS NULL OR b.sector = cfg.sector_filter)
),
scored AS (
  SELECT
    f.*,
    (
      COALESCE(f.composite_pct, 0.50) * 35.0
      + CASE
          WHEN f.valuation_bucket = 'ATTRACTIVE' THEN 18
          WHEN f.valuation_bucket = 'FAIR' THEN 10
          ELSE 4
        END
      + CASE
          WHEN f.quality_bucket = 'STRONG' THEN 18
          WHEN f.quality_bucket = 'CONSTRUCTIVE' THEN 12
          ELSE 4
        END
      + CASE
          WHEN f.momentum_bucket = 'STRONG' THEN 14
          WHEN f.momentum_bucket = 'CONSTRUCTIVE' THEN 10
          WHEN f.momentum_bucket = 'MIXED' THEN 6
          ELSE 3
        END
      + CASE
          WHEN f.growth_bucket = 'STRONG' THEN 10
          ELSE 4
        END
      + CASE
          WHEN f.leverage_bucket = 'STRONG' THEN 5
          WHEN f.leverage_bucket = 'STRESSED' THEN -6
          ELSE 0
        END
    ) AS internal_rank_score
  FROM filtered f
),
candidate_pool AS (
  SELECT
    s.*,
    ROW_NUMBER() OVER (
      ORDER BY
        s.internal_rank_score DESC NULLS LAST,
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
    PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY fr.h60_return) * 100.0 AS median_return_pct
  FROM md_forward_returns fr
  JOIN candidate_pool cp
    ON cp.symbol = fr.symbol
   AND cp.pool_rank <= (SELECT candidate_pool_size FROM config)
  JOIN config cfg ON true
  WHERE fr.h60_return IS NOT NULL
    AND fr.as_of_date < cfg.target_date
    AND fr.as_of_date >= cfg.target_date - INTERVAL '5 years'
  GROUP BY fr.symbol
),
freshness AS (
  SELECT
    (SELECT MAX(computed_at) FROM md_features_daily f JOIN config cfg ON f.computed_date = cfg.target_date) AS features_completed_at,
    CASE WHEN (SELECT MAX(computed_date) FROM md_features_daily) >= CURRENT_DATE - INTERVAL '10 days'
      THEN 'FRESH'
      ELSE 'STALE'
    END AS features_freshness_state,
    MAX(last_success_at) FILTER (WHERE mv_name = 'md_research_sector_peer_daily') AS peer_completed_at,
    MAX(state) FILTER (WHERE mv_name = 'md_research_sector_peer_daily') AS peer_freshness_state
  FROM md_research_refresh_stale
  WHERE mv_name = 'md_research_sector_peer_daily'
),
metadata AS (
  SELECT
    (SELECT COUNT(*) FROM current_rows) AS current_row_count,
    (SELECT COUNT(*) FROM filtered) AS matched_row_count,
    (SELECT target_date FROM config) AS as_of_date
),
ranked AS (
  SELECT
    cp.*,
    fo.hit_rate_pct,
    fo.median_return_pct,
    ROW_NUMBER() OVER (
      PARTITION BY cp.sector
      ORDER BY
        cp.internal_rank_score DESC NULLS LAST,
        cp.avg_dollar_volume DESC NULLS LAST,
        cp.symbol ASC
    ) AS sector_rank
  FROM candidate_pool cp
  LEFT JOIN forward_overlay fo ON fo.symbol = cp.symbol
  WHERE cp.pool_rank <= (SELECT candidate_pool_size FROM config)
),
diversified AS (
  SELECT
    r.*,
    ROW_NUMBER() OVER (
      ORDER BY
        r.internal_rank_score DESC NULLS LAST,
        r.avg_dollar_volume DESC NULLS LAST,
        r.symbol ASC
    ) AS stock_rank
  FROM ranked r
  WHERE r.sector_rank <= 3
),
result_rows AS (
  SELECT
    d.symbol,
    d.company_name,
    d.sector,
    d.stock_rank AS rank,
    d.valuation_bucket,
    d.quality_bucket,
    d.momentum_bucket,
    d.growth_bucket,
    d.leverage_bucket,
    d.risk_bucket,
    d.conviction_bucket,
    ROUND(d.hit_rate_pct::numeric, 1) AS hit_rate_pct,
    ROUND(d.median_return_pct::numeric, 2) AS median_return_pct,
    d.as_of_date,
    m.current_row_count,
    m.matched_row_count,
    f.features_freshness_state,
    f.features_completed_at,
    f.peer_freshness_state,
    f.peer_completed_at,
    d.hit_rate_pct IS NOT NULL AS forward_overlay_available
  FROM diversified d
  CROSS JOIN metadata m
  CROSS JOIN freshness f
  WHERE d.stock_rank <= (SELECT max_rows FROM config)
)
SELECT *
FROM result_rows
UNION ALL
SELECT
  NULL AS symbol,
  NULL AS company_name,
  NULL AS sector,
  NULL AS rank,
  NULL AS valuation_bucket,
  NULL AS quality_bucket,
  NULL AS momentum_bucket,
  NULL AS growth_bucket,
  NULL AS leverage_bucket,
  NULL AS risk_bucket,
  NULL AS conviction_bucket,
  NULL AS hit_rate_pct,
  NULL AS median_return_pct,
  m.as_of_date,
  m.current_row_count,
  m.matched_row_count,
  f.features_freshness_state,
  f.features_completed_at,
  f.peer_freshness_state,
  f.peer_completed_at,
  false AS forward_overlay_available
FROM metadata m
CROSS JOIN freshness f
WHERE NOT EXISTS (SELECT 1 FROM result_rows)
ORDER BY rank NULLS LAST;
