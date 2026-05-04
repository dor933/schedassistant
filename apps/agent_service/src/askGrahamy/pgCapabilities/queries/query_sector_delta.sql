WITH config AS (
  SELECT
    (SELECT MAX(as_of_date) FROM md_research_sector_monday_hist) AS current_as_of_date,
    LEAST(GREATEST(CAST(:MAX_ROWS AS integer), 1), 20) AS max_rows,
    CAST(:RANK_BY AS text) AS rank_by,
    CAST(:DIRECTION_FILTER AS text) AS direction_filter
),
dates AS (
  SELECT
    c.current_as_of_date,
    (
      SELECT MAX(h.as_of_date)
      FROM md_research_sector_monday_hist h
      WHERE h.as_of_date < c.current_as_of_date
        AND h.as_of_date >= c.current_as_of_date - INTERVAL '10 days'
    ) AS prior_as_of_date,
    c.max_rows,
    c.rank_by,
    c.direction_filter
  FROM config c
),
sector_base AS (
  SELECT
    h.as_of_date,
    h.sector,
    COUNT(*) AS symbol_count,
    AVG(h.roe) AS avg_roe,
    AVG(h.net_profit_margin) AS avg_net_profit_margin,
    AVG(h.revenue_growth_yoy) AS avg_revenue_growth_yoy,
    AVG(h.debt_to_equity) AS avg_debt_to_equity,
    AVG(h.pe_percentile_in_sector) AS avg_pe_percentile,
    AVG(h.price_vs_sma_200) AS avg_price_vs_sma_200,
    AVG(h.rsi_14) AS avg_rsi_14
  FROM md_research_sector_monday_hist h
  JOIN dates d ON h.as_of_date IN (d.current_as_of_date, d.prior_as_of_date)
  WHERE h.sector IS NOT NULL
  GROUP BY h.as_of_date, h.sector
),
ranked_components AS (
  SELECT
    b.*,
    CASE
      WHEN b.avg_roe IS NULL THEN NULL
      ELSE 100.0 * PERCENT_RANK() OVER (
        PARTITION BY b.as_of_date ORDER BY b.avg_roe NULLS FIRST
      )
    END AS roe_score,
    CASE
      WHEN b.avg_net_profit_margin IS NULL THEN NULL
      ELSE 100.0 * PERCENT_RANK() OVER (
        PARTITION BY b.as_of_date ORDER BY b.avg_net_profit_margin NULLS FIRST
      )
    END AS margin_score,
    CASE
      WHEN b.avg_revenue_growth_yoy IS NULL THEN NULL
      ELSE 100.0 * PERCENT_RANK() OVER (
        PARTITION BY b.as_of_date ORDER BY b.avg_revenue_growth_yoy NULLS FIRST
      )
    END AS growth_score,
    CASE
      WHEN b.avg_debt_to_equity IS NULL THEN NULL
      ELSE 100.0 * (1.0 - PERCENT_RANK() OVER (
        PARTITION BY b.as_of_date ORDER BY b.avg_debt_to_equity NULLS LAST
      ))
    END AS balance_sheet_score,
    CASE
      WHEN b.avg_pe_percentile IS NULL THEN NULL
      ELSE 100.0 * (1.0 - PERCENT_RANK() OVER (
        PARTITION BY b.as_of_date ORDER BY b.avg_pe_percentile NULLS LAST
      ))
    END AS valuation_score,
    CASE
      WHEN b.avg_price_vs_sma_200 IS NULL THEN NULL
      ELSE 100.0 * PERCENT_RANK() OVER (
        PARTITION BY b.as_of_date ORDER BY b.avg_price_vs_sma_200 NULLS FIRST
      )
    END AS price_trend_score,
    CASE
      WHEN b.avg_rsi_14 IS NULL THEN NULL
      ELSE 100.0 * PERCENT_RANK() OVER (
        PARTITION BY b.as_of_date ORDER BY b.avg_rsi_14 NULLS FIRST
      )
    END AS rsi_score
  FROM sector_base b
),
sector_scores AS (
  SELECT
    r.as_of_date,
    r.sector,
    (
      COALESCE(r.roe_score, 0) +
      COALESCE(r.margin_score, 0) +
      COALESCE(r.growth_score, 0) +
      COALESCE(r.balance_sheet_score, 0) +
      COALESCE(r.valuation_score, 0)
    ) / NULLIF(
      (r.roe_score IS NOT NULL)::int +
      (r.margin_score IS NOT NULL)::int +
      (r.growth_score IS NOT NULL)::int +
      (r.balance_sheet_score IS NOT NULL)::int +
      (r.valuation_score IS NOT NULL)::int,
      0
    ) AS conviction_score_pct,
    (
      COALESCE(r.price_trend_score, 0) +
      COALESCE(r.rsi_score, 0)
    ) / NULLIF(
      (r.price_trend_score IS NOT NULL)::int +
      (r.rsi_score IS NOT NULL)::int,
      0
    ) AS momentum_score_pct
  FROM ranked_components r
),
joined AS (
  SELECT
    cur.sector,
    cur.conviction_score_pct AS current_conviction_score_pct,
    prior.conviction_score_pct AS prior_conviction_score_pct,
    cur.conviction_score_pct - prior.conviction_score_pct AS conviction_delta_pct,
    cur.momentum_score_pct AS current_momentum_score_pct,
    prior.momentum_score_pct AS prior_momentum_score_pct,
    cur.momentum_score_pct - prior.momentum_score_pct AS momentum_delta_pct,
    CASE
      WHEN cur.conviction_score_pct >= 75 THEN 'HIGH'
      WHEN cur.conviction_score_pct >= 60 THEN 'CONSTRUCTIVE'
      WHEN cur.conviction_score_pct >= 45 THEN 'MIXED'
      ELSE 'WEAK'
    END AS current_conviction_bucket,
    CASE
      WHEN prior.conviction_score_pct >= 75 THEN 'HIGH'
      WHEN prior.conviction_score_pct >= 60 THEN 'CONSTRUCTIVE'
      WHEN prior.conviction_score_pct >= 45 THEN 'MIXED'
      ELSE 'WEAK'
    END AS prior_conviction_bucket,
    CASE
      WHEN cur.momentum_score_pct >= 75 THEN 'STRONG'
      WHEN cur.momentum_score_pct >= 55 THEN 'MIXED'
      ELSE 'WEAK'
    END AS current_momentum_bucket,
    CASE
      WHEN prior.momentum_score_pct >= 75 THEN 'STRONG'
      WHEN prior.momentum_score_pct >= 55 THEN 'MIXED'
      ELSE 'WEAK'
    END AS prior_momentum_bucket
  FROM sector_scores cur
  JOIN dates d ON cur.as_of_date = d.current_as_of_date
  JOIN sector_scores prior
    ON prior.sector = cur.sector
   AND prior.as_of_date = d.prior_as_of_date
),
scored_base AS (
  SELECT
    j.*,
    CASE
      WHEN COALESCE(j.conviction_delta_pct, 0) + COALESCE(j.momentum_delta_pct, 0) >= 2.0 THEN 'improved'
      WHEN COALESCE(j.conviction_delta_pct, 0) + COALESCE(j.momentum_delta_pct, 0) <= -2.0 THEN 'deteriorated'
      ELSE 'flat'
    END AS direction,
    CASE
      WHEN (SELECT direction_filter FROM dates) = 'momentum_deteriorated'
        THEN -1.0 * j.momentum_delta_pct
      WHEN (SELECT direction_filter FROM dates) = 'momentum_improved'
        THEN j.momentum_delta_pct
      WHEN (SELECT rank_by FROM dates) = 'conviction_delta'
        THEN j.conviction_delta_pct
      WHEN (SELECT rank_by FROM dates) = 'momentum_delta'
        THEN ABS(j.momentum_delta_pct)
      WHEN (SELECT rank_by FROM dates) = 'deterioration'
        THEN -1.0 * LEAST(COALESCE(j.conviction_delta_pct, 0), COALESCE(j.momentum_delta_pct, 0))
      ELSE ABS(COALESCE(j.conviction_delta_pct, 0)) + ABS(COALESCE(j.momentum_delta_pct, 0))
    END AS rank_metric
  FROM joined j
),
scored AS (
  SELECT
    b.*,
    (
      CASE
        WHEN (SELECT rank_by FROM dates) = 'conviction_delta'
          THEN COALESCE(b.conviction_delta_pct >= 2.0, false)
        WHEN (SELECT rank_by FROM dates) = 'momentum_delta'
          THEN COALESCE(ABS(b.momentum_delta_pct) >= 2.0, false)
        WHEN (SELECT rank_by FROM dates) = 'deterioration'
          THEN COALESCE(b.conviction_delta_pct <= -2.0 OR b.momentum_delta_pct <= -2.0, false)
        ELSE COALESCE(ABS(b.conviction_delta_pct) >= 2.0 OR ABS(b.momentum_delta_pct) >= 2.0, false)
      END
      AND CASE
        WHEN (SELECT direction_filter FROM dates) = 'improved'
          THEN b.direction = 'improved'
        WHEN (SELECT direction_filter FROM dates) = 'deteriorated'
          THEN b.direction = 'deteriorated'
        WHEN (SELECT direction_filter FROM dates) = 'momentum_improved'
          THEN COALESCE(b.momentum_delta_pct >= 2.0, false)
        WHEN (SELECT direction_filter FROM dates) = 'momentum_deteriorated'
          THEN COALESCE(b.momentum_delta_pct <= -2.0, false)
        ELSE true
      END
    ) AS include_in_public
  FROM scored_base b
),
ranked AS (
  SELECT
    s.*,
    COUNT(*) OVER () AS evaluated_sector_count,
    COUNT(*) FILTER (WHERE s.include_in_public) OVER () AS meaningful_delta_count,
    ROW_NUMBER() OVER (
      ORDER BY s.include_in_public DESC, s.rank_metric DESC NULLS LAST, s.sector ASC
    ) AS sector_rank
  FROM scored s
),
freshness AS (
  SELECT
    MAX(last_success_at) FILTER (WHERE mv_name = 'md_research_sector_monday_hist') AS weekly_completed_at,
    MAX(state) FILTER (WHERE mv_name = 'md_research_sector_monday_hist') AS weekly_freshness_state
  FROM md_research_refresh_stale
  WHERE mv_name = 'md_research_sector_monday_hist'
)
SELECT
  r.sector,
  r.sector_rank AS rank,
  ROUND(r.current_conviction_score_pct::numeric, 1) AS current_conviction_score_pct,
  ROUND(r.prior_conviction_score_pct::numeric, 1) AS prior_conviction_score_pct,
  ROUND(r.conviction_delta_pct::numeric, 1) AS conviction_delta_pct,
  r.current_conviction_bucket,
  r.prior_conviction_bucket,
  ROUND(r.current_momentum_score_pct::numeric, 1) AS current_momentum_score_pct,
  ROUND(r.prior_momentum_score_pct::numeric, 1) AS prior_momentum_score_pct,
  ROUND(r.momentum_delta_pct::numeric, 1) AS momentum_delta_pct,
  r.current_momentum_bucket,
  r.prior_momentum_bucket,
  r.direction,
  r.include_in_public,
  d.current_as_of_date,
  d.prior_as_of_date,
  f.weekly_freshness_state,
  f.weekly_completed_at,
  r.evaluated_sector_count,
  r.meaningful_delta_count
FROM ranked r
CROSS JOIN dates d
LEFT JOIN freshness f ON true
WHERE r.sector_rank <= (SELECT max_rows FROM dates)
ORDER BY r.sector_rank;
