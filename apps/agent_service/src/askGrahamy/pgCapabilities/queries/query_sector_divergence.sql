WITH config AS (
  SELECT
    (SELECT MAX(as_of_date) FROM md_research_sector_peer_daily) AS target_date,
    LEAST(GREATEST(CAST(:MAX_ROWS AS integer), 1), 20) AS max_rows
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
    COUNT(*) AS momentum_count,
    AVG(h.relative_strength_4w) AS avg_rs_4w,
    AVG(h.relative_strength_12w) AS avg_rs_12w,
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
      WHEN COALESCE(fo.sample_size, ps.symbol_count, m.momentum_count) >= 2000 THEN 'ROBUST'
      WHEN COALESCE(fo.sample_size, ps.symbol_count, m.momentum_count) >= 500 THEN 'ADEQUATE'
      WHEN COALESCE(fo.sample_size, ps.symbol_count, m.momentum_count) >= 100 THEN 'WEAK'
      ELSE 'THIN'
    END AS evidence_strength,
    CASE
      WHEN m.avg_perf_month >= 0.05 OR m.avg_rs_4w >= 0.03 THEN 'STRONG'
      WHEN m.avg_perf_month >= 0.00 OR m.avg_rs_4w >= 0.00 THEN 'MIXED'
      WHEN m.avg_perf_month IS NULL AND m.avg_rs_4w IS NULL THEN NULL
      ELSE 'WEAK'
    END AS momentum_bucket,
    CASE
      WHEN m.avg_perf_month >= 0.10 OR m.avg_rs_4w >= 0.06 THEN 90
      WHEN m.avg_perf_month >= 0.05 OR m.avg_rs_4w >= 0.03 THEN 75
      WHEN m.avg_perf_month >= 0.00 OR m.avg_rs_4w >= 0.00 THEN 55
      WHEN m.avg_perf_month IS NULL AND m.avg_rs_4w IS NULL THEN NULL
      ELSE 30
    END AS momentum_score_pct,
    CASE
      WHEN ps.conviction_score_pct >= 60
       AND COALESCE(
         CASE
           WHEN m.avg_perf_month >= 0.10 OR m.avg_rs_4w >= 0.06 THEN 90
           WHEN m.avg_perf_month >= 0.05 OR m.avg_rs_4w >= 0.03 THEN 75
           WHEN m.avg_perf_month >= 0.00 OR m.avg_rs_4w >= 0.00 THEN 55
           WHEN m.avg_perf_month IS NULL AND m.avg_rs_4w IS NULL THEN NULL
           ELSE 30
         END,
         50
       ) <= 55
        THEN 'conviction_but_weak_price_action'
      WHEN ps.conviction_score_pct >= 60
       AND (m.avg_perf_month >= 0.05 OR m.avg_rs_4w >= 0.03)
        THEN 'price_action_confirms_conviction'
      WHEN ps.conviction_score_pct < 45
       AND (m.avg_perf_month >= 0.05 OR m.avg_rs_4w >= 0.03)
        THEN 'price_momentum_without_conviction'
      ELSE 'in_line'
    END AS divergence_type,
    fo.sample_size IS NOT NULL AS overlay_available
  FROM peer_sector ps
  LEFT JOIN momentum m ON m.sector = ps.sector
  LEFT JOIN forward_overlay fo ON fo.sector = ps.sector
),
ranked AS (
  SELECT
    s.*,
    COUNT(*) OVER () AS evaluated_sector_count,
    COUNT(*) FILTER (
      WHERE s.divergence_type = 'conviction_but_weak_price_action'
    ) OVER () AS clear_divergence_count,
    ROW_NUMBER() OVER (
      ORDER BY
        CASE
          WHEN s.divergence_type = 'conviction_but_weak_price_action'
          THEN s.conviction_score_pct + (100 - COALESCE(s.momentum_score_pct, 50))
          ELSE -1
        END DESC NULLS LAST,
        s.conviction_score_pct DESC NULLS LAST,
        s.hit_rate_pct DESC NULLS LAST,
        s.sector ASC
    ) AS sector_rank
  FROM scored s
)
SELECT
  r.sector,
  r.sector_rank AS rank,
  ROUND(r.conviction_score_pct::numeric, 1) AS conviction_score_pct,
  r.conviction_bucket,
  ROUND(r.momentum_score_pct::numeric, 1) AS momentum_score_pct,
  r.momentum_bucket,
  r.divergence_type,
  r.evidence_strength,
  ROUND(r.hit_rate_pct::numeric, 1) AS hit_rate_pct,
  c.target_date AS as_of_date,
  f.peer_freshness_state,
  f.peer_completed_at,
  f.forward_freshness_state,
  f.forward_completed_at,
  r.overlay_available,
  r.evaluated_sector_count,
  r.clear_divergence_count
FROM ranked r
CROSS JOIN config c
LEFT JOIN freshness f ON true
WHERE r.sector_rank <= (SELECT max_rows FROM config)
ORDER BY r.sector_rank;
