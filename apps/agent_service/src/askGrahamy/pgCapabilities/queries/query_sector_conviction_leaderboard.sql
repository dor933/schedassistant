WITH config AS (
  SELECT
    (SELECT MAX(as_of_date) FROM md_research_sector_peer_daily) AS target_date,
    LEAST(GREATEST(CAST(:MAX_ROWS AS integer), 1), 20) AS max_rows,
    CAST(:RANK_BY AS text) AS rank_by
),
current_regime AS (
  SELECT h.market_regime
  FROM md_historical_features_daily h
  JOIN config c ON h.as_of_date = c.target_date
  WHERE h.symbol = 'SPY'
    AND h.is_delisted = false
  LIMIT 1
),
peer_sector AS (
  SELECT
    p.sector,
    COUNT(*) AS symbol_count,
    AVG(p.composite_pct) * 100.0 AS conviction_score_pct
  FROM md_research_sector_peer_daily p
  JOIN config c ON p.as_of_date = c.target_date
  WHERE p.sector IS NOT NULL
  GROUP BY p.sector
),
momentum AS (
  SELECT
    h.sector,
    AVG(h.relative_strength_4w) AS avg_rs_4w,
    AVG(h.perf_month) AS avg_perf_month,
    AVG(h.price_vs_sma_200) AS avg_price_vs_sma_200
  FROM md_historical_features_daily h
  JOIN config c ON h.as_of_date = c.target_date
  WHERE h.is_delisted = false
    AND h.sector IS NOT NULL
  GROUP BY h.sector
),
forward_overlay AS (
  SELECT
    f.sector,
    SUM(f.n_with_h60) AS sample_size,
    SUM(f.wins_h60)::numeric / NULLIF(SUM(f.total_h60), 0) * 100.0 AS hit_rate_pct
  FROM md_research_sector_regime_fwd_agg f
  JOIN current_regime r ON f.market_regime = r.market_regime
  WHERE f.sector IS NOT NULL
  GROUP BY f.sector
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
),
scored AS (
  SELECT
    ps.sector,
    ps.symbol_count,
    ps.conviction_score_pct,
    CASE
      WHEN ps.conviction_score_pct >= 75 THEN 'HIGH'
      WHEN ps.conviction_score_pct >= 60 THEN 'CONSTRUCTIVE'
      WHEN ps.conviction_score_pct >= 45 THEN 'MIXED'
      ELSE 'WEAK'
    END AS conviction_bucket,
    fo.sample_size,
    fo.hit_rate_pct,
    CASE
      WHEN COALESCE(fo.sample_size, ps.symbol_count) >= 2000 THEN 'ROBUST'
      WHEN COALESCE(fo.sample_size, ps.symbol_count) >= 500 THEN 'ADEQUATE'
      WHEN COALESCE(fo.sample_size, ps.symbol_count) >= 100 THEN 'WEAK'
      ELSE 'THIN'
    END AS evidence_strength,
    CASE
      WHEN m.avg_perf_month >= 0.05 OR m.avg_rs_4w >= 0.03 THEN 'STRONG'
      WHEN m.avg_perf_month >= 0.00 OR m.avg_rs_4w >= 0.00 THEN 'MIXED'
      WHEN m.avg_perf_month IS NULL AND m.avg_rs_4w IS NULL THEN NULL
      ELSE 'WEAK'
    END AS momentum_bucket,
    CASE
      WHEN ps.conviction_score_pct >= 60
       AND COALESCE(m.avg_perf_month, 0) < 0.00
        THEN 'conviction_but_weak_price_action'
      WHEN ps.conviction_score_pct >= 60
       AND (m.avg_perf_month >= 0.05 OR m.avg_rs_4w >= 0.03)
        THEN 'price_action_confirms_conviction'
      WHEN ps.conviction_score_pct < 45
       AND (m.avg_perf_month >= 0.05 OR m.avg_rs_4w >= 0.03)
        THEN 'price_momentum_without_conviction'
      ELSE 'in_line'
    END AS price_momentum_separation,
    CASE
      WHEN ps.sector IN ('Utilities', 'Consumer Defensive', 'Healthcare', 'Real Estate') THEN 'defensive'
      WHEN ps.sector IN ('Technology', 'Industrials', 'Consumer Cyclical', 'Financial Services', 'Energy', 'Basic Materials', 'Communication Services', 'Semiconductors') THEN 'cyclical'
      ELSE 'mixed'
    END AS defensive_cyclical_label,
    CASE
      WHEN m.avg_perf_month >= 0.10 OR m.avg_rs_4w >= 0.06 THEN 90
      WHEN m.avg_perf_month >= 0.05 OR m.avg_rs_4w >= 0.03 THEN 75
      WHEN m.avg_perf_month >= 0.00 OR m.avg_rs_4w >= 0.00 THEN 55
      WHEN m.avg_perf_month IS NULL AND m.avg_rs_4w IS NULL THEN NULL
      ELSE 30
    END AS momentum_score_pct,
    fo.sample_size IS NOT NULL AS overlay_available
  FROM peer_sector ps
  LEFT JOIN momentum m ON m.sector = ps.sector
  LEFT JOIN forward_overlay fo ON fo.sector = ps.sector
),
ranked AS (
  SELECT
    s.*,
    ROW_NUMBER() OVER (
      ORDER BY
        CASE
          WHEN (SELECT rank_by FROM config) = 'historical_forward' THEN s.hit_rate_pct
        END DESC NULLS LAST,
        CASE
          WHEN (SELECT rank_by FROM config) = 'divergence'
          THEN
            CASE
              WHEN s.price_momentum_separation = 'conviction_but_weak_price_action'
              THEN s.conviction_score_pct + (100 - COALESCE(s.momentum_score_pct, 50))
              ELSE -1
            END
        END DESC NULLS LAST,
        s.conviction_score_pct DESC NULLS LAST,
        s.sector ASC
    ) AS sector_rank
  FROM scored s
)
SELECT
  r.sector,
  r.sector_rank AS rank,
  ROUND(r.conviction_score_pct::numeric, 1) AS conviction_score_pct,
  r.conviction_bucket,
  r.evidence_strength,
  ROUND(r.hit_rate_pct::numeric, 1) AS hit_rate_pct,
  r.momentum_bucket,
  r.price_momentum_separation,
  r.defensive_cyclical_label,
  c.target_date AS as_of_date,
  cr.market_regime AS current_market_regime,
  f.peer_freshness_state,
  f.peer_completed_at,
  f.forward_freshness_state,
  f.forward_completed_at,
  r.overlay_available
FROM ranked r
CROSS JOIN config c
LEFT JOIN current_regime cr ON true
LEFT JOIN freshness f ON true
WHERE r.sector_rank <= (SELECT max_rows FROM config)
ORDER BY r.sector_rank;
