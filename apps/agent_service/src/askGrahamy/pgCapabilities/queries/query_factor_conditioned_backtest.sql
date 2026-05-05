WITH config AS (
  SELECT
    (SELECT MAX(as_of_date) FROM sweep_universe) AS target_date,
    (SELECT MAX(as_of_date) FROM sweep_universe) - INTERVAL '10 years' AS lookback_start,
    CAST(:HORIZON AS text) AS horizon,
    CASE CAST(:HORIZON AS text)
      WHEN '20-day' THEN (SELECT MAX(as_of_date) FROM sweep_universe) - INTERVAL '20 days'
      WHEN '40-day' THEN (SELECT MAX(as_of_date) FROM sweep_universe) - INTERVAL '40 days'
      WHEN '60-day' THEN (SELECT MAX(as_of_date) FROM sweep_universe) - INTERVAL '60 days'
      WHEN '120-day' THEN (SELECT MAX(as_of_date) FROM sweep_universe) - INTERVAL '120 days'
      WHEN '252-day' THEN (SELECT MAX(as_of_date) FROM sweep_universe) - INTERVAL '252 days'
      ELSE (SELECT MAX(as_of_date) FROM sweep_universe)
    END AS sample_end_date,
    LEAST(GREATEST(CAST(:MAX_SAMPLE_SIZE AS integer), 30), 250000) AS max_sample_size,
    50000 AS source_row_cap,
    CAST(:VALUATION_BUCKET AS text) AS valuation_bucket,
    CAST(:QUALITY_BUCKET AS text) AS quality_bucket,
    CAST(:MOMENTUM_BUCKET AS text) AS momentum_bucket,
    CAST(:GROWTH_BUCKET AS text) AS growth_bucket,
    CAST(:LEVERAGE_BUCKET AS text) AS leverage_bucket,
    CAST(:SECTOR_FILTER AS text) AS sector_filter
),
source_candidates AS (
  SELECT
    s.symbol,
    s.as_of_date,
    s.sector,
    s.price,
    s.market_cap,
    s.rsi_14,
    s.relative_strength_12w,
    s.perf_month,
    s.pe_vs_10yr_avg,
    s.pe_percentile_in_sector,
    s.free_cash_flow_yield,
    s.roe,
    s.roic,
    s.net_profit_margin,
    s.revenue_growth_yoy,
    s.eps_growth_yoy,
    s.fcf_growth_yoy,
    s.debt_to_equity,
    s.current_ratio,
    s.interest_coverage,
    s.h20_return,
    s.h40_return,
    s.h60_return,
    s.h120_return,
    s.h252_return
  FROM sweep_universe s
  JOIN config cfg ON true
  WHERE s.as_of_date >= cfg.lookback_start
    AND s.as_of_date <= cfg.sample_end_date
    AND s.price >= 5
    AND COALESCE(s.market_cap, 0) >= 300000000
    AND s.sector IS NOT NULL
  ORDER BY s.as_of_date DESC, s.symbol ASC
  LIMIT (SELECT source_row_cap FROM config)
),
source_rows AS (
  SELECT
    c.symbol,
    c.as_of_date,
    c.sector,
    c.price,
    c.market_cap,
    c.rsi_14,
    c.relative_strength_12w,
    c.perf_month,
    c.pe_vs_10yr_avg,
    c.pe_percentile_in_sector,
    c.free_cash_flow_yield,
    c.roe,
    c.roic,
    c.net_profit_margin,
    c.revenue_growth_yoy,
    c.eps_growth_yoy,
    c.fcf_growth_yoy,
    c.debt_to_equity,
    c.current_ratio,
    c.interest_coverage,
    CASE cfg.horizon
      WHEN '20-day' THEN c.h20_return
      WHEN '40-day' THEN c.h40_return
      WHEN '60-day' THEN c.h60_return
      WHEN '120-day' THEN c.h120_return
      WHEN '252-day' THEN c.h252_return
      ELSE NULL
    END AS forward_return
  FROM source_candidates c
  JOIN config cfg ON true
),
bucketed AS (
  SELECT
    r.*,
    CASE
      WHEN r.pe_percentile_in_sector <= 0.35
        OR r.pe_vs_10yr_avg <= -0.20
        OR r.free_cash_flow_yield >= 0.08
        THEN 'ATTRACTIVE'
      WHEN r.pe_percentile_in_sector <= 0.70
        OR r.pe_vs_10yr_avg <= 0.10
        OR r.free_cash_flow_yield >= 0.03
        THEN 'FAIR'
      WHEN r.pe_percentile_in_sector IS NULL
       AND r.pe_vs_10yr_avg IS NULL
       AND r.free_cash_flow_yield IS NULL
        THEN NULL
      ELSE 'RICH'
    END AS valuation_bucket,
    CASE
      WHEN r.roic >= 0.10
        OR r.roe >= 0.12
        OR r.free_cash_flow_yield >= 0.05
        OR r.net_profit_margin >= 0.10
        THEN 'STRONG'
      WHEN r.roic >= 0.04
        OR r.roe >= 0.06
        OR r.free_cash_flow_yield >= 0
        OR r.net_profit_margin >= 0.03
        THEN 'CONSTRUCTIVE'
      WHEN r.roic IS NULL
       AND r.roe IS NULL
       AND r.free_cash_flow_yield IS NULL
       AND r.net_profit_margin IS NULL
        THEN NULL
      ELSE 'WEAK'
    END AS quality_bucket,
    CASE
      WHEN COALESCE(r.relative_strength_12w, r.perf_month) >= 0.10
        AND COALESCE(r.rsi_14, 50) >= 45
        THEN 'STRONG'
      WHEN COALESCE(r.relative_strength_12w, r.perf_month) >= 0.03
        AND COALESCE(r.rsi_14, 50) >= 35
        THEN 'CONSTRUCTIVE'
      WHEN r.relative_strength_12w IS NULL
       AND r.perf_month IS NULL
       AND r.rsi_14 IS NULL
        THEN NULL
      WHEN r.rsi_14 <= 35
        OR COALESCE(r.relative_strength_12w, r.perf_month) < 0.00
        THEN 'WEAK'
      ELSE 'CONSTRUCTIVE'
    END AS momentum_bucket,
    CASE
      WHEN COALESCE(r.revenue_growth_yoy, r.eps_growth_yoy, r.fcf_growth_yoy) >= 0.10 THEN 'STRONG'
      WHEN r.revenue_growth_yoy IS NULL AND r.eps_growth_yoy IS NULL AND r.fcf_growth_yoy IS NULL THEN NULL
      ELSE 'WEAK'
    END AS growth_bucket,
    CASE
      WHEN COALESCE(r.debt_to_equity, 0) <= 0.75
        OR COALESCE(r.interest_coverage, 0) >= 5
        OR COALESCE(r.current_ratio, 0) >= 1.5
        THEN 'STRONG'
      WHEN r.debt_to_equity IS NULL
       AND r.interest_coverage IS NULL
       AND r.current_ratio IS NULL
        THEN NULL
      WHEN r.debt_to_equity >= 2.5
        OR COALESCE(r.interest_coverage, 999) < 1.5
        OR COALESCE(r.current_ratio, 999) < 1.0
        THEN 'STRESSED'
      ELSE 'STRONG'
    END AS leverage_bucket
  FROM source_rows r
),
filtered AS (
  SELECT b.*
  FROM bucketed b
  JOIN config cfg ON true
  WHERE b.forward_return IS NOT NULL
    AND (cfg.valuation_bucket IS NULL OR b.valuation_bucket = cfg.valuation_bucket)
    AND (cfg.quality_bucket IS NULL OR b.quality_bucket = cfg.quality_bucket)
    AND (cfg.momentum_bucket IS NULL OR b.momentum_bucket = cfg.momentum_bucket)
    AND (cfg.growth_bucket IS NULL OR b.growth_bucket = cfg.growth_bucket)
    AND (cfg.leverage_bucket IS NULL OR b.leverage_bucket = cfg.leverage_bucket)
    AND (cfg.sector_filter IS NULL OR b.sector = cfg.sector_filter)
),
bounded AS (
  SELECT *
  FROM filtered f
  ORDER BY f.as_of_date DESC, f.symbol ASC
  LIMIT (SELECT max_sample_size FROM config)
),
aggregate_stats AS (
  SELECT
    COUNT(*) AS sample_size,
    AVG(CASE WHEN b.forward_return > 0 THEN 1.0 ELSE 0.0 END) * 100.0 AS hit_rate_pct,
    PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY b.forward_return) * 100.0 AS median_return_pct,
    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY b.forward_return) * 100.0 AS p25_return_pct,
    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY b.forward_return) * 100.0 AS p75_return_pct
  FROM bounded b
),
metadata AS (
  SELECT
    (SELECT sample_end_date::date FROM config) AS as_of_date,
    (SELECT horizon FROM config) AS horizon,
    (SELECT COUNT(*) FROM bounded) AS matched_row_count,
    (SELECT COUNT(*) FROM source_candidates) AS source_row_count,
    (SELECT COUNT(*) FROM source_candidates) >= (SELECT source_row_cap FROM config)
      OR (SELECT COUNT(*) FROM bounded) >= (SELECT max_sample_size FROM config) AS capped_sample
)
SELECT
  m.as_of_date,
  m.horizon,
  a.sample_size,
  ROUND(a.hit_rate_pct::numeric, 1) AS hit_rate_pct,
  ROUND(a.median_return_pct::numeric, 2) AS median_return_pct,
  ROUND(a.p25_return_pct::numeric, 2) AS p25_return_pct,
  ROUND(a.p75_return_pct::numeric, 2) AS p75_return_pct,
  m.matched_row_count,
  m.source_row_count,
  m.capped_sample
FROM metadata m
CROSS JOIN aggregate_stats a;
