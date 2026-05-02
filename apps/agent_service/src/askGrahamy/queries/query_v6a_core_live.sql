-- ═════════════════════════════════════════════════════════════════════════════
-- Research Object V6a — CORE LIVE QUERY (symbol-specific, no sector scans)
-- ═════════════════════════════════════════════════════════════════════════════
-- Purpose: return the symbol-local parts of the Research Object in <2s.
--          No sector-wide scans live here — those come from V6b materialized
--          view lookups and are merged by the API layer (or by a wrapping
--          query that UNIONs v6a + v6b outputs).
--
-- What this returns:
--   research_object_core (jsonb) — company_state, trajectory, event_context,
--                                  regime_context (own-stock portion),
--                                  analog_evidence.self_history,
--                                  Q4 own-stock regime/valuation tables
--   debug_payload_core (jsonb)   — raw server-side values for QA
--
-- What this does NOT return (handled by v6b):
--   portfolio_context (peer matrix) — from md_research_sector_peer_daily
--   regime_context.sector_by_regime — from md_research_sector_regime_fwd_agg
--   analog_evidence.sector_analogs  — from md_research_sector_analog_bucket
--   invalidation                    — from md_research_sector_analog_bucket
--
-- Usage:
--   docker exec -i stock_analyzer_db psql -U stock_user -d stock_analyzer \
--     -v SYMBOL="'MSFT'" < query_v6a_core_live.sql
--
-- PIT / MOAT guarantees same as V5:
--   - as_of_date <= target_date, is_delisted = false, data_known_at filters
--   - md_analyst_estimates.date > target_date (not look-ahead)
--   - md_ratios_ttm_snapshots <= target_date ORDER BY DESC LIMIT 1
--   - jsonb output is MOAT-clean (classifications/percentiles only)
-- ═════════════════════════════════════════════════════════════════════════════

WITH

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 0 — CONFIG
-- ═════════════════════════════════════════════════════════════════════════════

config AS (
  SELECT
    :SYMBOL::text                                           AS target_symbol,
    COALESCE(
      (SELECT MAX(as_of_date)
       FROM md_historical_features_daily
       WHERE symbol = :SYMBOL AND is_delisted = false),
      (CURRENT_DATE - INTERVAL '1 day')::date
    )                                                       AS target_date
),

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 1 — IDENTITY
-- ═════════════════════════════════════════════════════════════════════════════

symbol_info AS (
  SELECT
    s.symbol,
    s.name                                                  AS company_name,
    h.sector                                                AS sector,
    h.industry                                              AS industry
  FROM md_symbols s
  LEFT JOIN LATERAL (
    SELECT sector, industry
    FROM md_historical_features_daily
    WHERE symbol = s.symbol AND as_of_date <= (SELECT target_date FROM config)
    ORDER BY as_of_date DESC
    LIMIT 1
  ) h ON true
  WHERE s.symbol = (SELECT target_symbol FROM config)
),

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 2 — CURRENT SNAPSHOT (multi-source, PIT-corrected)
-- ═════════════════════════════════════════════════════════════════════════════

current_screening AS (
  SELECT
    f.symbol, f.price, f.market_cap, f.avg_volume, f.avg_dollar_volume,
    f.beta, f.piotroski_score, f.altman_z_score,
    f.eps_surprise_pct_latest, f.eps_growth_yoy, f.eps_growth_3y,
    f.revenue_growth_yoy, f.fcf_growth_yoy,
    f.relative_strength_4w, f.relative_strength_12w,
    f.price_vs_sma200_distance                              AS price_vs_sma_200,
    f.price_vs_52w_high, f.rsi_14,
    f.peg_ratio_ttm, f.peg_ratio_forward,
    f.analyst_rating, f.analyst_count, f.target_price,
    f.short_percent_of_float, f.market_regime, f.vix_at_snapshot,
    f.days_to_next_earnings
  FROM md_features_daily f
  WHERE f.symbol = (SELECT target_symbol FROM config)
    AND f.computed_date <= (SELECT target_date FROM config)   -- I-1 PIT guard
  ORDER BY f.computed_date DESC
  LIMIT 1
),

current_historical AS (
  SELECT
    h.symbol, h.as_of_date,
    h.price AS h_price, h.pe_ratio AS h_pe_ratio,
    h.pe_percentile_in_sector, h.pe_percentile_in_industry, h.pe_vs_10yr_avg,
    h.market_regime, h.vix_level, h.interest_rate_10y,
    h.days_to_earnings, h.days_from_earnings,
    h.sector, h.industry, h.sector_pe, h.industry_pe,
    h.rsi_14 AS h_rsi_14, h.price_vs_sma_200 AS h_sma_dist,
    h.gross_profit_margin AS h_gpm, h.operating_profit_margin AS h_opm,
    h.net_profit_margin AS h_npm,
    h.roe AS h_roe, h.roic AS h_roic, h.roa AS h_roa,
    h.free_cash_flow_yield AS h_fcf_yield,
    h.debt_to_equity AS h_d2e, h.current_ratio AS h_cr,
    h.interest_coverage AS h_ic,
    h.revenue_growth_yoy AS h_rev_yoy, h.eps_growth_yoy AS h_eps_yoy,
    h.fcf_growth_yoy AS h_fcf_yoy,
    h.perf_month, h.perf_quarter, h.perf_year,
    -- Pre-computed bin assignments for v6b lookup keys
    CASE
      WHEN h.pe_percentile_in_sector <= 0.20 THEN 1
      WHEN h.pe_percentile_in_sector <= 0.40 THEN 2
      WHEN h.pe_percentile_in_sector <= 0.60 THEN 3
      WHEN h.pe_percentile_in_sector <= 0.80 THEN 4
      WHEN h.pe_percentile_in_sector IS NULL  THEN NULL
      ELSE 5
    END                                                     AS pe_bin,
    CASE
      WHEN h.rsi_14 < 30 THEN 1
      WHEN h.rsi_14 < 45 THEN 2
      WHEN h.rsi_14 < 55 THEN 3
      WHEN h.rsi_14 < 70 THEN 4
      WHEN h.rsi_14 IS NULL THEN NULL
      ELSE 5
    END                                                     AS rsi_bin,
    CASE
      WHEN h.pe_percentile_in_sector <= 0.20 THEN 'DEEP_VALUE'
      WHEN h.pe_percentile_in_sector <= 0.40 THEN 'VALUE'
      WHEN h.pe_percentile_in_sector <= 0.60 THEN 'FAIR'
      WHEN h.pe_percentile_in_sector <= 0.80 THEN 'RICH'
      WHEN h.pe_percentile_in_sector IS NULL  THEN NULL
      ELSE 'EXPENSIVE'
    END                                                     AS valuation_bucket
  FROM md_historical_features_daily h
  WHERE h.symbol = (SELECT target_symbol FROM config)
    AND h.as_of_date = (SELECT target_date FROM config)
    AND h.is_delisted = false
),

current_ratios_ttm AS (
  SELECT DISTINCT ON (r.symbol)
    r.symbol, r.as_of_date AS ratios_as_of,
    r.pe_ratio AS ttm_pe, r.pb_ratio AS ttm_pb,
    r.price_to_sales_ratio AS ttm_ps,
    r.gross_profit_margin AS ttm_gpm, r.operating_profit_margin AS ttm_opm,
    r.net_profit_margin AS ttm_npm, r.ebitda_margin AS ttm_ebitda_margin,
    r.current_ratio AS ttm_cr, r.quick_ratio AS ttm_qr,
    r.debt_to_equity AS ttm_d2e, r.interest_coverage AS ttm_ic,
    r.debt_service_coverage_ratio AS ttm_dscr,
    r.enterprise_value_multiple AS ttm_ev_mult,
    r.price_to_free_cash_flow_ratio AS ttm_p_fcf,
    r.peg_ratio_ttm AS ttm_peg, r.peg_ratio_forward AS ttm_peg_fwd,
    r.dividend_yield AS ttm_div_yield, r.payout_ratio AS ttm_payout,
    (r.raw_json->>'netIncomePerShareTTM')::numeric AS ttm_nips,
    (r.raw_json->>'operatingCashFlowPerShareTTM')::numeric AS ttm_ocfps,
    (r.raw_json->>'bookValuePerShareTTM')::numeric AS ttm_bvps
  FROM md_ratios_ttm_snapshots r
  WHERE r.symbol = (SELECT target_symbol FROM config)
    AND r.as_of_date <= (SELECT target_date FROM config)
  ORDER BY r.symbol, r.as_of_date DESC
),

current_key_metrics_ttm AS (
  SELECT DISTINCT ON (km.symbol)
    km.symbol, km.as_of_date AS km_as_of,
    km.return_on_equity AS km_roe, km.return_on_assets AS km_roa,
    km.return_on_capital_employed AS km_roce, km.roic AS km_roic,
    km.free_cash_flow_yield AS km_fcf_yield,
    km.graham_number AS km_graham,
    km.net_debt_to_ebitda AS km_nd_ebitda, km.income_quality AS km_iq,
    km.stock_based_compensation_to_revenue AS km_sbc_rev,
    km.ev_to_ebitda AS km_ev_ebitda, km.earnings_yield AS km_earnings_yield,
    km.capex_to_operating_cash_flow AS km_capex_ocf
  FROM md_key_metrics_ttm_snapshots km
  WHERE km.symbol = (SELECT target_symbol FROM config)
    AND km.as_of_date <= (SELECT target_date FROM config)
  ORDER BY km.symbol, km.as_of_date DESC
),

current_forward_consensus AS (
  SELECT DISTINCT ON (ae.symbol, ae.period)
    ae.symbol, ae.period, ae.date AS estimate_for_date,
    ae.estimated_revenue_avg, ae.estimated_eps_avg,
    ae.estimated_eps_high, ae.estimated_eps_low,
    ae.number_analyst_estimated_revenue, ae.number_analyst_estimated_eps
  FROM md_analyst_estimates ae
  WHERE ae.symbol = (SELECT target_symbol FROM config)
    AND ae.date >  (SELECT target_date FROM config)
    AND ae.date <= (SELECT target_date FROM config) + INTERVAL '2 years'
    AND (ae.fetched_at IS NULL OR ae.fetched_at <= (SELECT target_date FROM config))
    AND ae.period = 'annual'
    AND ae.estimated_eps_avg IS NOT NULL
  ORDER BY ae.symbol, ae.period, ae.date ASC
),

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 3 — Q1: COMPANY STATE + TRAJECTORY (symbol-local only)
-- ═════════════════════════════════════════════════════════════════════════════

hist_ratios_own_5y AS (
  SELECT ra.symbol,
    AVG(ra.pe_ratio) FILTER (WHERE ra.pe_ratio > 0 AND ra.pe_ratio < 200)         AS avg_pe_5y,
    STDDEV(ra.pe_ratio) FILTER (WHERE ra.pe_ratio > 0 AND ra.pe_ratio < 200)      AS stddev_pe_5y,
    AVG(ra.enterprise_value_multiple) FILTER (WHERE ra.enterprise_value_multiple > 0 AND ra.enterprise_value_multiple < 100) AS avg_ev_ebitda_5y,
    AVG(ra.gross_profit_margin)                                                    AS avg_gpm_5y,
    AVG(ra.net_profit_margin)                                                      AS avg_npm_5y,
    AVG(ra.operating_profit_margin)                                                AS avg_opm_5y
  FROM md_ratios_annual ra
  WHERE ra.symbol = (SELECT target_symbol FROM config)
    AND ra.fiscal_year >= EXTRACT(YEAR FROM (SELECT target_date FROM config)) - 5
    AND ra.fiscal_year <  EXTRACT(YEAR FROM (SELECT target_date FROM config))
  GROUP BY ra.symbol
),

hist_ratios_own_10y AS (
  SELECT ra.symbol,
    AVG(ra.pe_ratio) FILTER (WHERE ra.pe_ratio > 0 AND ra.pe_ratio < 200) AS avg_pe_10y
  FROM md_ratios_annual ra
  WHERE ra.symbol = (SELECT target_symbol FROM config)
    AND ra.fiscal_year >= EXTRACT(YEAR FROM (SELECT target_date FROM config)) - 10
    AND ra.fiscal_year <  EXTRACT(YEAR FROM (SELECT target_date FROM config))
  GROUP BY ra.symbol
),

hist_metrics_own_5y AS (
  SELECT km.symbol,
    AVG(km.roe)                                                                    AS avg_roe_5y,
    STDDEV(km.roe)                                                                 AS stddev_roe_5y,
    AVG(km.roic)                                                                   AS avg_roic_5y,
    AVG(km.free_cash_flow_yield)                                                   AS avg_fcf_yield_5y
  FROM md_key_metrics_annual km
  WHERE km.symbol = (SELECT target_symbol FROM config)
    AND km.fiscal_year >= EXTRACT(YEAR FROM (SELECT target_date FROM config)) - 5
    AND km.fiscal_year <  EXTRACT(YEAR FROM (SELECT target_date FROM config))
    AND km.roe IS NOT NULL
  GROUP BY km.symbol
),

-- Quarterly trajectory (revenue, debt, margins) — PIT via data_known_at
quarterly_series AS (
  SELECT
    iq.symbol, iq.fiscal_year, iq.fiscal_quarter, iq.report_date,
    iq.revenue, iq.gross_profit, iq.operating_income, iq.ebitda, iq.net_income,
    CASE WHEN iq.revenue > 0 THEN iq.gross_profit / iq.revenue ELSE NULL END      AS gpm_q,
    CASE WHEN iq.revenue > 0 THEN iq.operating_income / iq.revenue ELSE NULL END  AS opm_q,
    CASE WHEN iq.revenue > 0 THEN iq.net_income / iq.revenue ELSE NULL END        AS npm_q,
    ROW_NUMBER() OVER (PARTITION BY iq.symbol ORDER BY iq.fiscal_year DESC, iq.fiscal_quarter DESC) AS q_rank
  FROM md_income_quarterly iq
  WHERE iq.symbol = (SELECT target_symbol FROM config)
    AND (iq.data_known_at IS NULL OR iq.data_known_at::date <= (SELECT target_date FROM config))
    AND iq.report_date <= (SELECT target_date FROM config)
    AND iq.revenue IS NOT NULL
),

revenue_trajectory AS (
  SELECT
    symbol,
    AVG(CASE WHEN q_rank <= 4 THEN revenue END)                 AS rev_recent_4q,
    AVG(CASE WHEN q_rank BETWEEN 5 AND 8 THEN revenue END)      AS rev_prior_4q,
    AVG(CASE WHEN q_rank <= 4 THEN gpm_q END)                   AS gpm_recent_4q,
    AVG(CASE WHEN q_rank BETWEEN 5 AND 8 THEN gpm_q END)        AS gpm_prior_4q,
    AVG(CASE WHEN q_rank <= 4 THEN opm_q END)                   AS opm_recent_4q,
    AVG(CASE WHEN q_rank BETWEEN 5 AND 8 THEN opm_q END)        AS opm_prior_4q,
    AVG(CASE WHEN q_rank <= 4 THEN npm_q END)                   AS npm_recent_4q,
    AVG(CASE WHEN q_rank BETWEEN 5 AND 8 THEN npm_q END)        AS npm_prior_4q
  FROM quarterly_series
  GROUP BY symbol
),

debt_series AS (
  SELECT bq.symbol, bq.total_debt, bq.net_debt, bq.total_stockholders_equity,
    ROW_NUMBER() OVER (PARTITION BY bq.symbol ORDER BY bq.fiscal_year DESC, bq.fiscal_quarter DESC) AS q_rank
  FROM md_balance_quarterly bq
  WHERE bq.symbol = (SELECT target_symbol FROM config)
    AND (bq.data_known_at IS NULL OR bq.data_known_at::date <= (SELECT target_date FROM config))
    AND bq.report_date <= (SELECT target_date FROM config)
    AND bq.total_debt IS NOT NULL
),

debt_trajectory AS (
  SELECT symbol,
    MAX(CASE WHEN q_rank = 1 THEN total_debt END)                 AS debt_q1,
    MAX(CASE WHEN q_rank = 4 THEN total_debt END)                 AS debt_q4,
    MAX(CASE WHEN q_rank = 8 THEN total_debt END)                 AS debt_q8,
    MAX(CASE WHEN q_rank = 1 THEN net_debt END)                   AS net_debt_q1,
    MAX(CASE WHEN q_rank = 1 THEN total_stockholders_equity END)  AS equity_q1
  FROM debt_series
  WHERE q_rank <= 8
  GROUP BY symbol
),

-- Beat/miss streak
earnings_streak AS (
  SELECT ec.symbol, ec.date, ec.eps_actual, ec.eps_estimated,
    CASE WHEN ec.eps_actual IS NULL OR ec.eps_estimated IS NULL THEN NULL
         WHEN ec.eps_actual >= ec.eps_estimated THEN 'BEAT' ELSE 'MISS' END AS outcome,
    ROW_NUMBER() OVER (PARTITION BY ec.symbol ORDER BY ec.date DESC) AS e_rank
  FROM md_earnings_calendar ec
  WHERE ec.symbol = (SELECT target_symbol FROM config)
    AND ec.date <= (SELECT target_date FROM config)
    AND ec.eps_actual IS NOT NULL
),

earnings_streak_summary AS (
  SELECT symbol,
    COUNT(*) FILTER (WHERE outcome = 'BEAT' AND e_rank <= 8) AS beats_last_8,
    COUNT(*) FILTER (WHERE outcome = 'MISS' AND e_rank <= 8) AS misses_last_8,
    STRING_AGG(outcome, ',' ORDER BY e_rank) FILTER (WHERE e_rank <= 8) AS outcome_pattern
  FROM earnings_streak
  GROUP BY symbol
),

-- I-2 fix (2026-04-28, Dag): replaced MAX(...) with LAST-value in window.
-- Previous behaviour: if estimates were revised up then back down within the
-- 30d window, MAX preserved the up-spike, biasing eps_est_30d high.
-- Correct semantics: most-recent-as-of-cutoff value in each window bucket.
analyst_revision_trend AS (
  WITH ranked AS (
    SELECT ae.symbol, ae.fetched_at, ae.estimated_eps_avg,
           CASE
             WHEN ae.fetched_at >= (SELECT target_date FROM config) - INTERVAL '30 days'
               THEN '30d'
             WHEN ae.fetched_at <  (SELECT target_date FROM config) - INTERVAL '30 days'
              AND ae.fetched_at >= (SELECT target_date FROM config) - INTERVAL '120 days'
               THEN '120d'
             ELSE NULL
           END AS bucket,
           ROW_NUMBER() OVER (
             PARTITION BY ae.symbol,
                          CASE
                            WHEN ae.fetched_at >= (SELECT target_date FROM config) - INTERVAL '30 days'
                              THEN '30d'
                            WHEN ae.fetched_at <  (SELECT target_date FROM config) - INTERVAL '30 days'
                             AND ae.fetched_at >= (SELECT target_date FROM config) - INTERVAL '120 days'
                              THEN '120d'
                            ELSE NULL
                          END
             ORDER BY ae.fetched_at DESC
           ) AS rn
    FROM md_analyst_estimates ae
    WHERE ae.symbol = (SELECT target_symbol FROM config)
      AND ae.period = 'annual'
      AND ae.fetched_at <= (SELECT target_date FROM config)
      AND ae.date >  (SELECT target_date FROM config)
      AND ae.date <= (SELECT target_date FROM config) + INTERVAL '400 days'
  )
  SELECT symbol,
    MAX(estimated_eps_avg) FILTER (WHERE bucket = '30d'  AND rn = 1) AS eps_est_30d,
    MAX(estimated_eps_avg) FILTER (WHERE bucket = '120d' AND rn = 1) AS eps_est_120d
  FROM ranked
  WHERE bucket IS NOT NULL
  GROUP BY symbol
),

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 4 — Q2: EVENT + REGIME CONTEXT
-- ═════════════════════════════════════════════════════════════════════════════

regime_4w_ago AS (
  SELECT h.market_regime AS regime_4w, h.vix_level AS vix_4w, h.price AS price_4w
  FROM md_historical_features_daily h
  WHERE h.symbol = (SELECT target_symbol FROM config)
    AND h.as_of_date <= (SELECT target_date FROM config) - INTERVAL '28 days'
    AND h.is_delisted = false
  ORDER BY h.as_of_date DESC LIMIT 1
),

regime_12w_ago AS (
  SELECT h.market_regime AS regime_12w, h.price AS price_12w, h.pe_ratio AS pe_12w
  FROM md_historical_features_daily h
  WHERE h.symbol = (SELECT target_symbol FROM config)
    AND h.as_of_date <= (SELECT target_date FROM config) - INTERVAL '84 days'
    AND h.is_delisted = false
  ORDER BY h.as_of_date DESC LIMIT 1
),

recent_8k AS (
  -- I-3 PIT: upper bound is target_date (no +1 day forward peek).
  SELECT COUNT(*) AS filings_90d, MAX(filing_date) AS latest_8k_date
  FROM md_8k_filings
  WHERE symbol = (SELECT target_symbol FROM config)
    AND filing_date >= (SELECT target_date FROM config)::timestamp - INTERVAL '90 days'
    AND filing_date <= (SELECT target_date FROM config)::timestamp
),

recent_dividends AS (
  SELECT COUNT(*) AS div_count_1y, MAX(payment_date) AS last_div_date,
    SUM(adj_dividend) AS total_div_1y, MAX(frequency) AS latest_frequency
  FROM md_dividends
  WHERE symbol = (SELECT target_symbol FROM config)
    AND COALESCE(payment_date, ex_date) >= (SELECT target_date FROM config) - INTERVAL '1 year'
    AND COALESCE(payment_date, ex_date) <= (SELECT target_date FROM config)
),

benchmark_sp500 AS (
  SELECT b.close AS sp500_close, b.perf_4w AS sp500_perf_4w, b.perf_12w AS sp500_perf_12w
  FROM md_historical_benchmark_daily b
  WHERE b.symbol = '^GSPC' AND b.as_of_date <= (SELECT target_date FROM config)
  ORDER BY b.as_of_date DESC LIMIT 1
),

benchmark_vix AS (
  SELECT b.close AS vix_close, b.perf_4w AS vix_perf_4w
  FROM md_historical_benchmark_daily b
  WHERE b.symbol = '^VIX' AND b.as_of_date <= (SELECT target_date FROM config)
  ORDER BY b.as_of_date DESC LIMIT 1
),

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 5 — Q3: SELF-ANALOGS (target_symbol vs own history) — NO sector scan
-- ═════════════════════════════════════════════════════════════════════════════

current_profile_vector AS (
  SELECT
    pe_percentile_in_sector   AS cv_pe_pct_sector,
    pe_percentile_in_industry AS cv_pe_pct_industry,
    h_rsi_14                  AS cv_rsi,
    h_sma_dist                AS cv_sma_dist,
    market_regime             AS cv_regime,
    h_roe                     AS cv_roe,
    h_d2e                     AS cv_d2e,
    h_rev_yoy                 AS cv_rev_yoy,
    sector                    AS cv_sector,
    industry                  AS cv_industry,
    pe_bin                    AS cv_pe_bin,
    rsi_bin                   AS cv_rsi_bin,
    valuation_bucket          AS cv_valuation_bucket
  FROM current_historical
),

self_analogs_raw AS (
  SELECT
    h.as_of_date AS analog_date,
    h.price AS analog_entry_price,
    h.market_regime AS analog_regime,
    h.pe_percentile_in_sector AS analog_pe_pct,
    h.rsi_14 AS analog_rsi,
    h.price_vs_sma_200 AS analog_sma_dist,
    h.roe AS analog_roe,
    h.revenue_growth_yoy AS analog_rev_yoy,
    (ABS(COALESCE(h.pe_percentile_in_sector, 0.5) - COALESCE(cv.cv_pe_pct_sector, 0.5)) * 100
     + ABS(COALESCE(h.rsi_14, 50) - COALESCE(cv.cv_rsi, 50)) * 0.5
     + CASE WHEN h.market_regime = cv.cv_regime THEN 0 ELSE 15 END
     + ABS(COALESCE(h.price_vs_sma_200, 0) - COALESCE(cv.cv_sma_dist, 0)) * 50
     + ABS(COALESCE(h.roe, 0) - COALESCE(cv.cv_roe, 0)) * 100) AS distance
  FROM md_historical_features_daily h
  CROSS JOIN current_profile_vector cv
  WHERE h.symbol = (SELECT target_symbol FROM config)
    AND h.as_of_date <  (SELECT target_date FROM config) - INTERVAL '180 days'
    AND h.as_of_date >= '2005-01-01'
    AND h.is_delisted = false
    AND h.pe_ratio IS NOT NULL AND h.pe_ratio > 0
    AND h.price > 0
),

self_analogs_top AS (
  SELECT * FROM self_analogs_raw ORDER BY distance ASC LIMIT 30
),

self_analogs_with_fwd AS (
  -- C-3: dropped fr.h20_return / fr.h120_return — never consumed downstream
  -- (only h60 + h252 surface in self_analog_summary).
  SELECT a.*, fr.h60_return, fr.h252_return
  FROM self_analogs_top a
  LEFT JOIN md_forward_returns fr
    ON fr.symbol = (SELECT target_symbol FROM config)
   AND fr.as_of_date = a.analog_date
),

self_analog_path_rows_raw AS (
  SELECT
    a.analog_date,
    p.as_of_date AS path_date,
    p.path_day,
    a.analog_entry_price::numeric AS entry_price,
    p.price::numeric AS path_price
  FROM self_analogs_top a
  JOIN LATERAL (
    SELECT
      h.as_of_date,
      h.price,
      ROW_NUMBER() OVER (ORDER BY h.as_of_date) - 1 AS path_day
    FROM md_historical_features_daily h
    WHERE h.symbol = (SELECT target_symbol FROM config)
      AND h.as_of_date >= a.analog_date
      AND h.as_of_date <= a.analog_date + INTERVAL '120 days'
      AND h.price > 0
    ORDER BY h.as_of_date
    LIMIT 61
  ) p ON true
  WHERE a.analog_entry_price > 0
),

self_analog_path_rows AS (
  SELECT
    r.*,
    (r.path_price / NULLIF(r.entry_price, 0) - 1) AS return_from_entry,
    (r.path_price / NULLIF(
      MAX(r.path_price) OVER (
        PARTITION BY r.analog_date
        ORDER BY r.path_day
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ),
      0
    ) - 1) AS drawdown_from_peak
  FROM self_analog_path_rows_raw r
),

self_analog_path_by_event AS (
  SELECT
    analog_date,
    COUNT(*) FILTER (WHERE path_day <= 60) AS observed_days,
    MIN(return_from_entry) FILTER (WHERE path_day BETWEEN 0 AND 60) AS max_adverse_excursion,
    MIN(drawdown_from_peak) FILTER (WHERE path_day BETWEEN 0 AND 60) AS max_drawdown,
    MIN(path_day) FILTER (WHERE path_day > 0 AND return_from_entry >= 0) AS first_recovery_day
  FROM self_analog_path_rows
  GROUP BY analog_date
),

self_path_risk_summary AS (
  SELECT
    COUNT(*) FILTER (WHERE p.observed_days >= 40) AS path_n,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY p.max_adverse_excursion)
      FILTER (WHERE p.observed_days >= 40 AND p.max_adverse_excursion IS NOT NULL) AS median_adverse_excursion,
    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY p.max_adverse_excursion)
      FILTER (WHERE p.observed_days >= 40 AND p.max_adverse_excursion IS NOT NULL) AS p25_adverse_excursion,
    PERCENTILE_CONT(0.10) WITHIN GROUP (ORDER BY p.max_adverse_excursion)
      FILTER (WHERE p.observed_days >= 40 AND p.max_adverse_excursion IS NOT NULL) AS p10_adverse_excursion,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY p.max_drawdown)
      FILTER (WHERE p.observed_days >= 40 AND p.max_drawdown IS NOT NULL) AS median_max_drawdown,
    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY p.max_drawdown)
      FILTER (WHERE p.observed_days >= 40 AND p.max_drawdown IS NOT NULL) AS p25_max_drawdown,
    PERCENTILE_CONT(0.10) WITHIN GROUP (ORDER BY p.max_drawdown)
      FILTER (WHERE p.observed_days >= 40 AND p.max_drawdown IS NOT NULL) AS p10_max_drawdown,
    MIN(p.max_drawdown)
      FILTER (WHERE p.observed_days >= 40 AND p.max_drawdown IS NOT NULL) AS worst_max_drawdown,
    AVG(CASE WHEN p.observed_days >= 40 AND p.max_drawdown IS NOT NULL
      THEN CASE WHEN p.max_drawdown <= -0.05 THEN 1.0 ELSE 0.0 END END) AS prob_drawdown_gt_5,
    AVG(CASE WHEN p.observed_days >= 40 AND p.max_drawdown IS NOT NULL
      THEN CASE WHEN p.max_drawdown <= -0.10 THEN 1.0 ELSE 0.0 END END) AS prob_drawdown_gt_10,
    AVG(CASE WHEN p.observed_days >= 40 AND p.max_drawdown IS NOT NULL
      THEN CASE WHEN p.max_drawdown <= -0.15 THEN 1.0 ELSE 0.0 END END) AS prob_drawdown_gt_15,
    AVG(CASE WHEN p.observed_days >= 40 AND p.max_drawdown IS NOT NULL
      THEN CASE WHEN p.max_drawdown <= -0.20 THEN 1.0 ELSE 0.0 END END) AS prob_drawdown_gt_20,
    AVG(CASE WHEN f.h60_return IS NULL THEN NULL WHEN f.h60_return < 0 THEN 1.0 ELSE 0.0 END) AS loss_rate_h60,
    AVG(CASE WHEN f.h60_return IS NULL THEN NULL WHEN f.h60_return <= -0.10 THEN 1.0 ELSE 0.0 END) AS severe_loss_rate_h60,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY p.first_recovery_day)
      FILTER (WHERE p.observed_days >= 40 AND p.first_recovery_day IS NOT NULL) AS median_recovery_days,
    AVG(CASE WHEN p.observed_days >= 40 AND p.max_adverse_excursion IS NOT NULL
      THEN CASE
        WHEN p.max_adverse_excursion >= 0 THEN 1.0
        WHEN p.first_recovery_day IS NOT NULL AND p.first_recovery_day <= 60 THEN 1.0
        ELSE 0.0
      END END) AS recovered_by_horizon_rate
  FROM self_analog_path_by_event p
  LEFT JOIN self_analogs_with_fwd f ON f.analog_date = p.analog_date
),

self_analog_summary AS (
  SELECT
    COUNT(*)                                                       AS n_self,
    COUNT(h60_return)                                              AS n_self_h60,
    PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY h60_return)       AS median_h60,
    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY h60_return)       AS p25_h60,
    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY h60_return)       AS p75_h60,
    AVG(h60_return)                                                AS avg_h60,
    STDDEV(h60_return)                                             AS stddev_h60,
    COUNT(*) FILTER (WHERE h60_return > 0)                         AS wins_h60,
    COUNT(*) FILTER (WHERE h60_return IS NOT NULL)                 AS total_h60,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY h252_return)       AS median_h252,
    COUNT(*) FILTER (WHERE h252_return > 0)                        AS wins_h252,
    COUNT(*) FILTER (WHERE h252_return IS NOT NULL)                AS total_h252
  FROM self_analogs_with_fwd
),

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 6 — Q4: OWN-STOCK CONDITIONAL (regime + valuation) — NO sector scan
-- ═════════════════════════════════════════════════════════════════════════════
-- One-pass over symbol's own history, joined to md_forward_returns.
-- Derive by-regime and by-valuation from the same base scan.
-- ═════════════════════════════════════════════════════════════════════════════

own_history_base AS (
  SELECT
    h.as_of_date,
    h.market_regime,
    h.pe_percentile_in_sector,
    CASE
      WHEN h.pe_percentile_in_sector <= 0.20 THEN 'DEEP_VALUE'
      WHEN h.pe_percentile_in_sector <= 0.40 THEN 'VALUE'
      WHEN h.pe_percentile_in_sector <= 0.60 THEN 'FAIR'
      WHEN h.pe_percentile_in_sector <= 0.80 THEN 'RICH'
      WHEN h.pe_percentile_in_sector IS NULL THEN NULL
      ELSE 'EXPENSIVE'
    END AS valuation_bucket,
    fr.h60_return, fr.h252_return
  FROM md_historical_features_daily h
  LEFT JOIN md_forward_returns fr ON fr.symbol = h.symbol AND fr.as_of_date = h.as_of_date
  WHERE h.symbol = (SELECT target_symbol FROM config)
    AND h.as_of_date >= '2010-01-01'
    AND h.as_of_date <  (SELECT target_date FROM config) - INTERVAL '365 days'
    AND h.is_delisted = false
    AND EXTRACT(DOW FROM h.as_of_date) = 1
),

own_by_regime AS (
  SELECT
    market_regime,
    COUNT(*)                                                       AS n,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY h60_return)        AS median_h60,
    AVG(h60_return)                                                AS avg_h60,
    COUNT(*) FILTER (WHERE h60_return > 0)                         AS wins_h60,
    COUNT(*) FILTER (WHERE h60_return IS NOT NULL)                 AS total_h60,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY h252_return)       AS median_h252,
    COUNT(*) FILTER (WHERE h252_return > 0)                        AS wins_h252,
    COUNT(*) FILTER (WHERE h252_return IS NOT NULL)                AS total_h252
  FROM own_history_base
  WHERE market_regime IS NOT NULL
  GROUP BY market_regime
),

own_by_valuation AS (
  SELECT
    valuation_bucket,
    COUNT(*)                                                       AS n,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY h60_return)        AS median_h60,
    AVG(h60_return)                                                AS avg_h60,
    COUNT(*) FILTER (WHERE h60_return > 0)                         AS wins_h60,
    COUNT(*) FILTER (WHERE h60_return IS NOT NULL)                 AS total_h60,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY h252_return)       AS median_h252,
    COUNT(*) FILTER (WHERE h252_return > 0)                        AS wins_h252,
    COUNT(*) FILTER (WHERE h252_return IS NOT NULL)                AS total_h252
  FROM own_history_base
  WHERE valuation_bucket IS NOT NULL
  GROUP BY valuation_bucket
),

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 7 — ASSEMBLY (symbol-local portion of Research Object)
-- ═════════════════════════════════════════════════════════════════════════════

assembled AS (
  SELECT
    si.symbol, si.company_name, si.sector, si.industry, cfg.target_date,
    -- Profile lookup keys for v6b
    ch.pe_bin, ch.rsi_bin, ch.valuation_bucket, ch.market_regime,
    -- Q1 COMPANY STATE
    ch.pe_percentile_in_sector, ch.pe_percentile_in_industry, ch.pe_vs_10yr_avg,
    cr.ttm_pe, hr5.avg_pe_5y, hr10.avg_pe_10y,
    cr.ttm_pb, cr.ttm_ev_mult, cr.ttm_peg, cr.ttm_peg_fwd,
    km.km_roe, km.km_roic, km.km_roce, km.km_fcf_yield, km.km_iq,
    hm5.avg_roe_5y, hm5.stddev_roe_5y, hm5.avg_roic_5y,
    cr.ttm_gpm, cr.ttm_opm, cr.ttm_npm, cr.ttm_ebitda_margin,
    hr5.avg_gpm_5y, hr5.avg_npm_5y, hr5.avg_opm_5y,
    cs.piotroski_score, cs.altman_z_score,
    cr.ttm_cr, cr.ttm_qr, cr.ttm_d2e, cr.ttm_ic, cr.ttm_dscr,
    km.km_nd_ebitda, km.km_sbc_rev,
    -- Q1 TRAJECTORY
    rt.rev_recent_4q, rt.rev_prior_4q,
    rt.gpm_recent_4q, rt.gpm_prior_4q,
    rt.opm_recent_4q, rt.opm_prior_4q,
    rt.npm_recent_4q, rt.npm_prior_4q,
    dt.debt_q1, dt.debt_q4, dt.debt_q8, dt.net_debt_q1,
    es.beats_last_8, es.misses_last_8, es.outcome_pattern,
    art.eps_est_30d, art.eps_est_120d,
    -- Q2 EVENT + REGIME
    ch.vix_level, ch.interest_rate_10y,
    r4w.regime_4w, r12w.regime_12w,
    ch.days_to_earnings, ch.days_from_earnings,
    r8k.filings_90d, r8k.latest_8k_date,
    rd.div_count_1y, rd.last_div_date, rd.total_div_1y, rd.latest_frequency,
    bs.sp500_perf_4w, bs.sp500_perf_12w, bv.vix_close, bv.vix_perf_4w,
    cfc.estimated_revenue_avg, cfc.estimated_eps_avg, cfc.number_analyst_estimated_eps,
    -- Q3 SELF-ANALOGS
    sas.n_self, sas.n_self_h60,
    sas.median_h60 AS self_median_h60, sas.avg_h60 AS self_avg_h60,
    sas.p25_h60 AS self_p25_h60, sas.p75_h60 AS self_p75_h60,
    sas.wins_h60 AS self_wins_h60, sas.total_h60 AS self_total_h60,
    sas.median_h252 AS self_median_h252,
    sas.wins_h252 AS self_wins_h252, sas.total_h252 AS self_total_h252,
    sprs.path_n AS self_path_n,
    sprs.median_adverse_excursion AS self_median_adverse_excursion,
    sprs.p25_adverse_excursion AS self_p25_adverse_excursion,
    sprs.p10_adverse_excursion AS self_p10_adverse_excursion,
    sprs.median_max_drawdown AS self_median_max_drawdown,
    sprs.p25_max_drawdown AS self_p25_max_drawdown,
    sprs.p10_max_drawdown AS self_p10_max_drawdown,
    sprs.worst_max_drawdown AS self_worst_max_drawdown,
    sprs.prob_drawdown_gt_5 AS self_prob_drawdown_gt_5,
    sprs.prob_drawdown_gt_10 AS self_prob_drawdown_gt_10,
    sprs.prob_drawdown_gt_15 AS self_prob_drawdown_gt_15,
    sprs.prob_drawdown_gt_20 AS self_prob_drawdown_gt_20,
    sprs.loss_rate_h60 AS self_loss_rate_h60,
    sprs.severe_loss_rate_h60 AS self_severe_loss_rate_h60,
    sprs.median_recovery_days AS self_median_recovery_days,
    sprs.recovered_by_horizon_rate AS self_recovered_by_horizon_rate,
    -- Q4 OWN-STOCK CONDITIONAL
    (SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
      'regime', market_regime, 'n', n,
      'median_h60', ROUND((median_h60 * 100)::numeric, 2),
      'avg_h60', ROUND((avg_h60 * 100)::numeric, 2),
      'hit_rate_h60', ROUND((wins_h60::numeric / NULLIF(total_h60, 0) * 100), 1),
      'median_h252', ROUND((median_h252 * 100)::numeric, 2),
      'hit_rate_h252', ROUND((wins_h252::numeric / NULLIF(total_h252, 0) * 100), 1)
    )) FROM own_by_regime) AS q4_own_by_regime,
    (SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
      'bucket', valuation_bucket, 'n', n,
      'median_h60', ROUND((median_h60 * 100)::numeric, 2),
      'avg_h60', ROUND((avg_h60 * 100)::numeric, 2),
      'hit_rate_h60', ROUND((wins_h60::numeric / NULLIF(total_h60, 0) * 100), 1),
      'median_h252', ROUND((median_h252 * 100)::numeric, 2),
      'hit_rate_h252', ROUND((wins_h252::numeric / NULLIF(total_h252, 0) * 100), 1)
    ) ORDER BY valuation_bucket) FROM own_by_valuation) AS q4_own_by_valuation
  FROM symbol_info si
  CROSS JOIN config cfg
  LEFT JOIN current_screening cs          ON cs.symbol = si.symbol
  LEFT JOIN current_historical ch         ON ch.symbol = si.symbol
  LEFT JOIN current_ratios_ttm cr         ON cr.symbol = si.symbol
  LEFT JOIN current_key_metrics_ttm km    ON km.symbol = si.symbol
  LEFT JOIN current_forward_consensus cfc ON cfc.symbol = si.symbol
  LEFT JOIN hist_ratios_own_5y hr5        ON hr5.symbol = si.symbol
  LEFT JOIN hist_ratios_own_10y hr10      ON hr10.symbol = si.symbol
  LEFT JOIN hist_metrics_own_5y hm5       ON hm5.symbol = si.symbol
  LEFT JOIN revenue_trajectory rt         ON rt.symbol = si.symbol
  LEFT JOIN debt_trajectory dt            ON dt.symbol = si.symbol
  LEFT JOIN earnings_streak_summary es    ON es.symbol = si.symbol
  LEFT JOIN analyst_revision_trend art    ON art.symbol = si.symbol
  LEFT JOIN regime_4w_ago r4w             ON true
  LEFT JOIN regime_12w_ago r12w           ON true
  LEFT JOIN recent_8k r8k                 ON true
  LEFT JOIN recent_dividends rd           ON true
  LEFT JOIN benchmark_sp500 bs            ON true
  LEFT JOIN benchmark_vix bv              ON true
  LEFT JOIN self_analog_summary sas       ON true
  LEFT JOIN self_path_risk_summary sprs   ON true
)

SELECT
  JSONB_BUILD_OBJECT(
    'meta', JSONB_BUILD_OBJECT(
      'symbol', a.symbol, 'company_name', a.company_name,
      'sector', a.sector, 'industry', a.industry,
      'as_of_date', a.target_date,
      'schema_version', 'research_object_v6a_core_live',
      'canon', 'institutional_intelligence_layer_2026_04_23'
    ),
    -- Profile keys to feed v6b
    'profile_keys', JSONB_BUILD_OBJECT(
      'sector', a.sector,
      'current_regime', a.market_regime,
      'pe_bin', a.pe_bin,
      'rsi_bin', a.rsi_bin,
      'valuation_bucket', a.valuation_bucket
    ),
    -- Object 1: COMPANY STATE (MOAT-clean)
    'company_state', JSONB_BUILD_OBJECT(
      'valuation', JSONB_BUILD_OBJECT(
        'pe_percentile_in_sector', CASE WHEN a.pe_percentile_in_sector IS NULL THEN NULL
          WHEN a.pe_percentile_in_sector <= 0.20 THEN 'BOTTOM_QUINTILE'
          WHEN a.pe_percentile_in_sector <= 0.40 THEN 'LOW_QUINTILE'
          WHEN a.pe_percentile_in_sector <= 0.60 THEN 'MID_QUINTILE'
          WHEN a.pe_percentile_in_sector <= 0.80 THEN 'HIGH_QUINTILE'
          ELSE 'TOP_QUINTILE' END,
        'pe_vs_own_10yr', CASE WHEN a.pe_vs_10yr_avg IS NULL THEN NULL
          WHEN a.pe_vs_10yr_avg < 0.8 THEN 'WELL_BELOW_OWN_HISTORY'
          WHEN a.pe_vs_10yr_avg < 1.0 THEN 'BELOW_OWN_HISTORY'
          WHEN a.pe_vs_10yr_avg < 1.2 THEN 'AT_OWN_HISTORY'
          WHEN a.pe_vs_10yr_avg < 1.5 THEN 'ABOVE_OWN_HISTORY'
          ELSE 'WELL_ABOVE_OWN_HISTORY' END,
        'peg_ttm_band', CASE WHEN a.ttm_peg IS NULL THEN NULL
          WHEN a.ttm_peg < 1 THEN 'BELOW_ONE'
          WHEN a.ttm_peg < 1.5 THEN 'ONE_TO_ONEPOINTFIVE'
          WHEN a.ttm_peg < 2.5 THEN 'ONEPOINTFIVE_TO_TWOPOINTFIVE'
          ELSE 'ABOVE_TWOPOINTFIVE' END
      ),
      'profitability', JSONB_BUILD_OBJECT(
        'roe_vs_own_5y', CASE WHEN a.km_roe IS NULL OR a.avg_roe_5y IS NULL THEN NULL
          WHEN a.km_roe < a.avg_roe_5y * 0.8 THEN 'BELOW_OWN_HISTORY'
          WHEN a.km_roe < a.avg_roe_5y * 1.1 THEN 'IN_LINE_WITH_HISTORY'
          ELSE 'ABOVE_OWN_HISTORY' END,
        'roe_stability', CASE WHEN a.stddev_roe_5y IS NULL OR a.avg_roe_5y IS NULL
            OR ABS(a.avg_roe_5y) < 0.03 THEN NULL
          WHEN ABS(a.stddev_roe_5y / a.avg_roe_5y) < 0.15 THEN 'STABLE'
          WHEN ABS(a.stddev_roe_5y / a.avg_roe_5y) < 0.35 THEN 'MODERATE_VARIANCE'
          ELSE 'HIGH_VARIANCE' END,
        'net_margin_vs_own_5y', CASE WHEN a.ttm_npm IS NULL OR a.avg_npm_5y IS NULL THEN NULL
          WHEN a.ttm_npm < a.avg_npm_5y * 0.7 THEN 'SIGNIFICANTLY_BELOW'
          WHEN a.ttm_npm < a.avg_npm_5y * 0.95 THEN 'BELOW_HISTORY'
          WHEN a.ttm_npm < a.avg_npm_5y * 1.1 THEN 'IN_LINE'
          WHEN a.ttm_npm < a.avg_npm_5y * 1.5 THEN 'EXPANDING'
          ELSE 'SPIKE_FLAG' END,
        'income_quality_band', CASE WHEN a.km_iq IS NULL THEN NULL
          WHEN a.km_iq < 0.7 THEN 'LOW'
          WHEN a.km_iq < 1.0 THEN 'MODERATE'
          WHEN a.km_iq < 1.3 THEN 'HEALTHY'
          ELSE 'ELEVATED' END,
        'piotroski_band', CASE WHEN a.piotroski_score IS NULL THEN NULL
          WHEN a.piotroski_score <= 3 THEN 'WEAK'
          WHEN a.piotroski_score <= 6 THEN 'AVERAGE'
          ELSE 'STRONG' END
      ),
      'balance_sheet', JSONB_BUILD_OBJECT(
        'leverage_band', CASE WHEN a.ttm_d2e IS NULL THEN NULL
          WHEN a.ttm_d2e < 0.3 THEN 'LOW'
          WHEN a.ttm_d2e < 0.8 THEN 'MODERATE'
          WHEN a.ttm_d2e < 1.5 THEN 'ELEVATED' ELSE 'HIGH' END,
        'interest_coverage_band', CASE WHEN a.ttm_ic IS NULL THEN NULL
          WHEN a.ttm_ic < 2 THEN 'STRESSED'
          WHEN a.ttm_ic < 5 THEN 'ADEQUATE'
          WHEN a.ttm_ic < 15 THEN 'COMFORTABLE' ELSE 'AMPLE' END,
        'altman_z_band', CASE WHEN a.altman_z_score IS NULL THEN NULL
          WHEN a.altman_z_score < 1.8 THEN 'DISTRESS_ZONE'
          WHEN a.altman_z_score < 3.0 THEN 'GREY_ZONE' ELSE 'SAFE_ZONE' END
      )
    ),
    -- Object 2: TRAJECTORY
    'trajectory', JSONB_BUILD_OBJECT(
      'revenue_4q_vs_prior_4q', CASE
        WHEN a.rev_prior_4q IS NULL OR a.rev_prior_4q <= 0 OR a.rev_recent_4q IS NULL THEN NULL
        WHEN a.rev_recent_4q / a.rev_prior_4q - 1 < -0.05 THEN 'DECLINING'
        WHEN a.rev_recent_4q / a.rev_prior_4q - 1 <  0.02 THEN 'FLAT'
        WHEN a.rev_recent_4q / a.rev_prior_4q - 1 <  0.10 THEN 'GROWING'
        WHEN a.rev_recent_4q / a.rev_prior_4q - 1 <  0.25 THEN 'ACCELERATING'
        ELSE 'STRONG_ACCELERATION' END,
      'operating_margin_direction', CASE
        WHEN a.opm_recent_4q IS NULL OR a.opm_prior_4q IS NULL THEN NULL
        WHEN a.opm_recent_4q - a.opm_prior_4q < -0.01 THEN 'COMPRESSING'
        WHEN a.opm_recent_4q - a.opm_prior_4q <  0.005 THEN 'STABLE'
        ELSE 'EXPANDING' END,
      'debt_trajectory_4q', CASE
        WHEN a.debt_q1 IS NULL OR a.debt_q4 IS NULL OR a.debt_q4 <= 0 THEN NULL
        WHEN a.debt_q1 / a.debt_q4 - 1 < -0.05 THEN 'DELEVERAGING'
        WHEN a.debt_q1 / a.debt_q4 - 1 <  0.05 THEN 'STABLE'
        ELSE 'LEVERAGING_UP' END,
      'beat_miss_pattern_8q', JSONB_BUILD_OBJECT(
        'beats', a.beats_last_8, 'misses', a.misses_last_8, 'pattern', a.outcome_pattern
      ),
      'analyst_revision_direction', CASE
        WHEN a.eps_est_30d IS NULL OR a.eps_est_120d IS NULL OR a.eps_est_120d = 0 THEN NULL
        WHEN a.eps_est_30d > a.eps_est_120d * 1.02 THEN 'RISING'
        WHEN a.eps_est_30d < a.eps_est_120d * 0.98 THEN 'FALLING' ELSE 'STABLE' END
    ),
    -- Object 3: EVENT CONTEXT
    'event_context', JSONB_BUILD_OBJECT(
      'earnings_proximity', CASE
        WHEN a.days_to_earnings BETWEEN 0 AND 14 THEN 'WITHIN_TWO_WEEKS'
        WHEN a.days_to_earnings BETWEEN 15 AND 45 THEN 'WITHIN_SIX_WEEKS'
        WHEN a.days_from_earnings BETWEEN 0 AND 14 THEN 'JUST_REPORTED'
        ELSE 'NO_NEAR_CATALYST' END,
      'recent_8k_activity', CASE WHEN a.filings_90d IS NULL OR a.filings_90d = 0 THEN 'NONE_IN_90D'
        WHEN a.filings_90d <= 2 THEN 'LOW'
        WHEN a.filings_90d <= 5 THEN 'NORMAL' ELSE 'ELEVATED' END,
      'dividend_activity', JSONB_BUILD_OBJECT(
        'payments_1y', a.div_count_1y, 'frequency', a.latest_frequency
      ),
      'consensus_coverage', CASE WHEN a.number_analyst_estimated_eps IS NULL THEN NULL
        WHEN a.number_analyst_estimated_eps >= 20 THEN 'HIGH'
        WHEN a.number_analyst_estimated_eps >= 10 THEN 'MODERATE'
        WHEN a.number_analyst_estimated_eps >=  3 THEN 'LOW'
        ELSE 'SPARSE' END
    ),
    -- Object 4: REGIME CONTEXT (own-stock only — sector comes from v6b)
    'regime_context', JSONB_BUILD_OBJECT(
      'current_regime', a.market_regime,
      'regime_4w_ago', a.regime_4w,
      'regime_12w_ago', a.regime_12w,
      'regime_shift_detected', CASE WHEN a.regime_4w IS NULL OR a.market_regime IS NULL THEN NULL
        WHEN a.regime_4w != a.market_regime THEN TRUE ELSE FALSE END,
      'vix_band', CASE WHEN a.vix_level IS NULL THEN NULL
        WHEN a.vix_level < 15 THEN 'LOW'
        WHEN a.vix_level < 25 THEN 'MODERATE'
        WHEN a.vix_level < 35 THEN 'ELEVATED' ELSE 'STRESSED' END,
      'own_stock_by_regime', a.q4_own_by_regime,
      'own_stock_by_valuation', a.q4_own_by_valuation
    ),
    -- Q3 self-analogs (symbol-local portion)
    'analog_evidence_self', JSONB_BUILD_OBJECT(
      'self_history', JSONB_BUILD_OBJECT(
        'n', a.n_self, 'n_with_h60', a.n_self_h60,
        'h60_median_pct', ROUND((a.self_median_h60 * 100)::numeric, 2),
        'h60_p25_pct', ROUND((a.self_p25_h60 * 100)::numeric, 2),
        'h60_p75_pct', ROUND((a.self_p75_h60 * 100)::numeric, 2),
        'h60_hit_rate', ROUND((a.self_wins_h60::numeric / NULLIF(a.self_total_h60, 0) * 100), 1),
        'h252_median_pct', ROUND((a.self_median_h252 * 100)::numeric, 2),
        'h252_hit_rate', ROUND((a.self_wins_h252::numeric / NULLIF(a.self_total_h252, 0) * 100), 1),
        'path_risk_base', JSONB_BUILD_OBJECT(
          'source', 'pg_daily_price_path_self_analogs',
          'horizon', '60-day',
          'n', a.self_path_n,
          'loss_rate_h60_pct', ROUND((a.self_loss_rate_h60 * 100)::numeric, 1),
          'severe_loss_rate_h60_pct', ROUND((a.self_severe_loss_rate_h60 * 100)::numeric, 1),
          'median_adverse_excursion_pct', ROUND((a.self_median_adverse_excursion * 100)::numeric, 2),
          'p25_adverse_excursion_pct', ROUND((a.self_p25_adverse_excursion * 100)::numeric, 2),
          'p10_adverse_excursion_pct', ROUND((a.self_p10_adverse_excursion * 100)::numeric, 2),
          'median_max_drawdown_pct', ROUND((a.self_median_max_drawdown * 100)::numeric, 2),
          'p25_max_drawdown_pct', ROUND((a.self_p25_max_drawdown * 100)::numeric, 2),
          'p10_max_drawdown_pct', ROUND((a.self_p10_max_drawdown * 100)::numeric, 2),
          'worst_max_drawdown_pct', ROUND((a.self_worst_max_drawdown * 100)::numeric, 2),
          'prob_drawdown_gt_5_pct', ROUND((a.self_prob_drawdown_gt_5 * 100)::numeric, 1),
          'prob_drawdown_gt_10_pct', ROUND((a.self_prob_drawdown_gt_10 * 100)::numeric, 1),
          'prob_drawdown_gt_15_pct', ROUND((a.self_prob_drawdown_gt_15 * 100)::numeric, 1),
          'prob_drawdown_gt_20_pct', ROUND((a.self_prob_drawdown_gt_20 * 100)::numeric, 1),
          'median_recovery_days', ROUND(a.self_median_recovery_days::numeric, 0),
          'recovered_by_horizon_rate_pct', ROUND((a.self_recovered_by_horizon_rate * 100)::numeric, 1),
          'sample_adequacy', CASE
            WHEN COALESCE(a.self_path_n, 0) < 10 THEN 'INSUFFICIENT'
            WHEN a.self_path_n < 20 THEN 'WEAK'
            WHEN a.self_path_n < 50 THEN 'ADEQUATE'
            ELSE 'ROBUST'
          END
        ),
        'sample_adequacy', CASE WHEN COALESCE(a.n_self_h60, 0) < 10 THEN 'INSUFFICIENT'
          WHEN a.n_self_h60 < 20 THEN 'WEAK'
          WHEN a.n_self_h60 < 50 THEN 'ADEQUATE' ELSE 'ROBUST' END
      )
    ),
    -- Compliance
    'compliance', JSONB_BUILD_OBJECT(
      'disclaimer', 'Research Object describes historical patterns and point-in-time state. Not an investment recommendation.',
      'not_advice', TRUE, 'pit_integrity', TRUE, 'survivorship_clean', TRUE
    )
  ) AS research_object_core,
  JSONB_BUILD_OBJECT('raw', TO_JSONB(a.*)) AS debug_payload_core
FROM assembled a;
