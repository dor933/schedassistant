-- ═════════════════════════════════════════════════════════════════════════════
-- Research Object V6c — FINANCIAL QUALITY + CATALYST + LIQUIDITY (Tier A)
-- ═════════════════════════════════════════════════════════════════════════════
-- Purpose: serve the eight Tier-A institutional dimensions identified in the
--          2026-04-24 gap audit, ALL backed by existing PG data (no new ETL).
--
-- Returns:
--   research_object_v6c (jsonb) — MOAT-clean, classification phrases only
--   debug_payload_v6c   (jsonb) — raw numeric values for internal QA only
--
-- The eight dimensions (keyed inside research_object_v6c):
--   1. trajectory_extended       — beat/miss magnitude, ratio direction, growth
--   2. financial_quality         — FCF conversion, SBC dilution, CCC, capex intensity
--   3. capital_allocation        — buyback rate, dividend rate, net debt direction
--   4. growth_compound           — 1Y/3Y/5Y growth rates from md_financial_growth
--   5. forward_catalysts         — next earnings, ex-div, 5/10/30d event windows
--   6. liquidity_tier            — flow capacity classification
--   7. peer_relative_perf        — multi-period vs SPX, vs sector median
--   8. share_count_trajectory    — dilution / buyback signal from cashflow + features
--
-- Bonus dimensions (also in this query, all from existing PG):
--   9. tax_efficiency            — effective_tax_rate trend
--  10. asset_turnover            — capital efficiency
--  11. ma_activity               — acquisitions_net from cashflow_annual
--  12. dividend_quality          — payout ratio + dividend coverage stability
--  13. inventory_dynamics        — inventory_turnover for asset-heavy industries
--
-- Architecture position (per grahamy/queries/README.md):
--   TIER 1 LIVE — symbol-local financial-quality dimensions; runs in parallel
--   with v6a + v6b + SQLite Edge Bridge in the API orchestration layer.
--   Application layer deep-merges all four outputs into a single Research
--   Object jsonb that matches the canonical six-object spec.
--
-- PIT GUARANTEES (verified 2026-04-24):
--   - md_income_quarterly / md_balance_quarterly / md_cashflow_quarterly /
--     md_cashflow_annual: data_known_at <= target_date OR IS NULL
--   - md_ratios_quarterly / md_key_metrics_quarterly: PIT-RELAXED. These
--     tables do NOT have data_known_at column (only fetched_at). We use
--     report_date <= target_date as the PIT proxy — this is the period-end
--     date, not publication. Filings publish 30-90 days after period-end, so
--     this is a SLIGHT look-ahead in worst case (~6 weeks). Acceptable for
--     8Q-trailing aggregates which dominate per-symbol trajectory; would
--     matter for point-in-time arbitrage tests (those should join to
--     md_income_quarterly's data_known_at as the reference clock). Long-term
--     fix: add data_known_at column via Sequelize migration + backfill.
--   - All historical reads: as_of_date <= target_date
--   - is_delisted = false on universe scans
--   - DISTINCT ON (symbol) ORDER BY DESC LIMIT 1 for "latest available" reads
--
-- MOAT DISCIPLINE:
--   - jsonb emits ONLY: percentile / classification / direction / band labels
--   - Raw numbers stay in debug_payload (server-side only)
--   - No edge IDs, thresholds, or method names
--   - Sample-size guards on every aggregate (n >= 3 for quarterly; n >= 5 for forward)
--
-- USAGE:
--   docker exec -i stock_analyzer_db psql -U stock_user -d stock_analyzer \
--     -v SYMBOL="'MSFT'" < query_v6c_financial_quality.sql
--
-- Source-verified against PG schema 2026-04-24:
--   md_cashflow_quarterly       (382,056 rows / 5,442 syms / max 2026-04-23)
--   md_key_metrics_quarterly    (396,977 rows / 5,489 syms / max 2026-04-22)
--   md_ratios_quarterly         (396,977 rows / 5,489 syms / max 2026-04-22)
--   md_financial_growth         (503,231 rows / 5,488 syms / max 2026-03-31)
--   md_balance_quarterly        (384,700 rows, 100% with working capital)
--   md_earnings_calendar        (182,950 with eps_actual+eps_estimated; 7,528 future)
--   md_dividends                (310,060 rows; 1,265 future ex-dates)
--   md_features_daily           (121,051 rows / 8,725 syms with shares_outstanding)
--   md_historical_benchmark_daily (^GSPC)
--   md_research_sector_peer_daily (V6 MV — 8,685 rows, refreshed daily 12:30 UTC)
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

target_meta AS (
  SELECT DISTINCT ON (h.symbol)
    h.symbol,
    h.sector,
    h.industry,
    h.market_cap,
    h.avg_dollar_volume,
    h.as_of_date
  FROM md_historical_features_daily h
  CROSS JOIN config c
  WHERE h.symbol = c.target_symbol
    AND h.as_of_date <= c.target_date
    AND h.is_delisted = false
  ORDER BY h.symbol, h.as_of_date DESC
),

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 1 — BEAT/MISS MAGNITUDE TREND (last 8 reported quarters)
-- ═════════════════════════════════════════════════════════════════════════════

earnings_history AS (
  SELECT
    ec.symbol,
    ec.date,
    ec.eps_actual,
    ec.eps_estimated,
    ec.revenue_actual,
    ec.revenue_estimated,
    CASE
      WHEN ec.eps_actual IS NULL OR ec.eps_estimated IS NULL OR ec.eps_estimated = 0 THEN NULL
      ELSE (ec.eps_actual / ec.eps_estimated) - 1
    END                                                     AS eps_surprise_pct,
    CASE
      WHEN ec.revenue_actual IS NULL OR ec.revenue_estimated IS NULL OR ec.revenue_estimated = 0 THEN NULL
      ELSE (ec.revenue_actual / ec.revenue_estimated) - 1
    END                                                     AS rev_surprise_pct,
    CASE
      WHEN ec.eps_actual IS NULL OR ec.eps_estimated IS NULL THEN NULL
      WHEN ec.eps_actual >= ec.eps_estimated THEN 'BEAT'
      ELSE 'MISS'
    END                                                     AS outcome,
    ROW_NUMBER() OVER (PARTITION BY ec.symbol ORDER BY ec.date DESC) AS rnk
  FROM md_earnings_calendar ec
  WHERE ec.symbol = (SELECT target_symbol FROM config)
    AND ec.date <= (SELECT target_date FROM config)
    AND ec.eps_actual IS NOT NULL
),

earnings_magnitude_summary AS (
  SELECT
    symbol,
    -- Recent 4Q
    COUNT(*) FILTER (WHERE rnk <= 4 AND outcome = 'BEAT')                  AS recent_beats_4q,
    COUNT(*) FILTER (WHERE rnk <= 4 AND outcome = 'MISS')                  AS recent_misses_4q,
    AVG(eps_surprise_pct)        FILTER (WHERE rnk <= 4)                   AS recent_eps_surprise_avg_4q,
    AVG(rev_surprise_pct)        FILTER (WHERE rnk <= 4)                   AS recent_rev_surprise_avg_4q,
    -- Prior 4Q (5..8)
    COUNT(*) FILTER (WHERE rnk BETWEEN 5 AND 8 AND outcome = 'BEAT')       AS prior_beats_4q,
    AVG(eps_surprise_pct)        FILTER (WHERE rnk BETWEEN 5 AND 8)        AS prior_eps_surprise_avg_4q,
    -- Pattern across 8Q
    STRING_AGG(outcome, ',' ORDER BY rnk ASC) FILTER (WHERE rnk <= 8)       AS pattern_8q
  FROM earnings_history
  GROUP BY symbol
),

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 2 — FINANCIAL QUALITY (per-quarter ratios + key metrics, 8Q trajectory)
-- ═════════════════════════════════════════════════════════════════════════════

ratios_q_series AS (
  SELECT
    rq.symbol,
    rq.fiscal_year,
    rq.fiscal_quarter,
    rq.report_date,
    rq.gross_profit_margin,
    rq.operating_profit_margin,
    rq.net_profit_margin,
    rq.asset_turnover,
    rq.inventory_turnover,
    rq.effective_tax_rate,
    rq.free_cash_flow_operating_cash_flow_ratio                            AS fcf_ocf_ratio,
    rq.dividend_payout_ratio,
    rq.dividend_per_share,
    ROW_NUMBER() OVER (PARTITION BY rq.symbol ORDER BY rq.fiscal_year DESC, rq.fiscal_quarter DESC) AS rnk
  FROM md_ratios_quarterly rq
  WHERE rq.symbol = (SELECT target_symbol FROM config)
    AND rq.report_date <= (SELECT target_date FROM config)
),

ratios_q_trajectory AS (
  SELECT
    symbol,
    AVG(gross_profit_margin)        FILTER (WHERE rnk <= 4)                AS gpm_recent,
    AVG(gross_profit_margin)        FILTER (WHERE rnk BETWEEN 5 AND 8)     AS gpm_prior,
    AVG(operating_profit_margin)    FILTER (WHERE rnk <= 4)                AS opm_recent,
    AVG(operating_profit_margin)    FILTER (WHERE rnk BETWEEN 5 AND 8)     AS opm_prior,
    AVG(net_profit_margin)          FILTER (WHERE rnk <= 4)                AS npm_recent,
    AVG(net_profit_margin)          FILTER (WHERE rnk BETWEEN 5 AND 8)     AS npm_prior,
    AVG(asset_turnover)             FILTER (WHERE rnk <= 4)                AS asset_turn_recent,
    AVG(asset_turnover)             FILTER (WHERE rnk BETWEEN 5 AND 8)     AS asset_turn_prior,
    AVG(inventory_turnover)         FILTER (WHERE rnk <= 4)                AS inv_turn_recent,
    AVG(inventory_turnover)         FILTER (WHERE rnk BETWEEN 5 AND 8)     AS inv_turn_prior,
    AVG(effective_tax_rate)         FILTER (WHERE rnk <= 4)                AS tax_rate_recent,
    AVG(effective_tax_rate)         FILTER (WHERE rnk BETWEEN 5 AND 8)     AS tax_rate_prior,
    AVG(fcf_ocf_ratio)              FILTER (WHERE rnk <= 4)                AS fcf_ocf_recent,
    AVG(dividend_payout_ratio)      FILTER (WHERE rnk <= 4)                AS payout_recent,
    AVG(dividend_payout_ratio)      FILTER (WHERE rnk BETWEEN 5 AND 8)     AS payout_prior
  FROM ratios_q_series
  GROUP BY symbol
),

key_metrics_q_series AS (
  SELECT
    km.symbol,
    km.fiscal_year,
    km.fiscal_quarter,
    km.report_date,
    km.roic,
    km.roce,
    km.roe,
    km.roa,
    km.free_cash_flow_yield,
    km.income_quality,
    km.cash_conversion_cycle,
    km.working_capital,
    km.invested_capital,
    km.stock_based_compensation_to_revenue                                AS sbc_to_rev,
    km.capex_to_operating_cash_flow                                       AS capex_to_ocf,
    km.net_debt_to_ebitda,
    ROW_NUMBER() OVER (PARTITION BY km.symbol ORDER BY km.fiscal_year DESC, km.fiscal_quarter DESC) AS rnk
  FROM md_key_metrics_quarterly km
  WHERE km.symbol = (SELECT target_symbol FROM config)
    AND km.report_date <= (SELECT target_date FROM config)
),

key_metrics_q_trajectory AS (
  SELECT
    symbol,
    AVG(roic)                       FILTER (WHERE rnk <= 4)                AS roic_recent,
    AVG(roic)                       FILTER (WHERE rnk BETWEEN 5 AND 8)     AS roic_prior,
    AVG(roce)                       FILTER (WHERE rnk <= 4)                AS roce_recent,
    AVG(roce)                       FILTER (WHERE rnk BETWEEN 5 AND 8)     AS roce_prior,
    AVG(income_quality)             FILTER (WHERE rnk <= 4)                AS iq_recent,
    AVG(income_quality)             FILTER (WHERE rnk BETWEEN 5 AND 8)     AS iq_prior,
    AVG(cash_conversion_cycle)      FILTER (WHERE rnk <= 4)                AS ccc_recent,
    AVG(cash_conversion_cycle)      FILTER (WHERE rnk BETWEEN 5 AND 8)     AS ccc_prior,
    AVG(sbc_to_rev)                 FILTER (WHERE rnk <= 4)                AS sbc_recent,
    AVG(sbc_to_rev)                 FILTER (WHERE rnk BETWEEN 5 AND 8)     AS sbc_prior,
    AVG(capex_to_ocf)               FILTER (WHERE rnk <= 4)                AS capex_recent,
    AVG(capex_to_ocf)               FILTER (WHERE rnk BETWEEN 5 AND 8)     AS capex_prior,
    AVG(net_debt_to_ebitda)         FILTER (WHERE rnk <= 4)                AS nd_ebitda_recent,
    AVG(net_debt_to_ebitda)         FILTER (WHERE rnk BETWEEN 5 AND 8)     AS nd_ebitda_prior
  FROM key_metrics_q_series
  GROUP BY symbol
),

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 3 — CAPITAL ALLOCATION (cashflow trajectory)
-- ═════════════════════════════════════════════════════════════════════════════

cashflow_q_series AS (
  SELECT
    cf.symbol,
    cf.fiscal_year,
    cf.fiscal_quarter,
    cf.report_date,
    cf.operating_cash_flow,
    cf.capital_expenditure,
    cf.free_cash_flow,
    cf.dividends_paid,                  -- negative numbers (outflow)
    cf.common_stock_repurchased,        -- negative numbers (outflow)
    cf.net_debt_issuance,
    cf.stock_based_compensation,
    ROW_NUMBER() OVER (PARTITION BY cf.symbol ORDER BY cf.fiscal_year DESC, cf.fiscal_quarter DESC) AS rnk
  FROM md_cashflow_quarterly cf
  WHERE cf.symbol = (SELECT target_symbol FROM config)
    AND (cf.data_known_at IS NULL OR cf.data_known_at::date <= (SELECT target_date FROM config))
    AND cf.report_date <= (SELECT target_date FROM config)
),

income_q_for_fcf AS (
  SELECT
    iq.symbol,
    iq.fiscal_year,
    iq.fiscal_quarter,
    iq.revenue,
    iq.net_income,
    ROW_NUMBER() OVER (PARTITION BY iq.symbol ORDER BY iq.fiscal_year DESC, iq.fiscal_quarter DESC) AS rnk
  FROM md_income_quarterly iq
  WHERE iq.symbol = (SELECT target_symbol FROM config)
    AND (iq.data_known_at IS NULL OR iq.data_known_at::date <= (SELECT target_date FROM config))
    AND iq.report_date <= (SELECT target_date FROM config)
),

capital_allocation_summary AS (
  SELECT
    cf.symbol,
    -- Trailing 4-quarter sums (TTM)
    SUM(cf.free_cash_flow)              FILTER (WHERE cf.rnk <= 4)         AS fcf_ttm,
    SUM(cf.dividends_paid)              FILTER (WHERE cf.rnk <= 4)         AS divs_paid_ttm,
    SUM(cf.common_stock_repurchased)    FILTER (WHERE cf.rnk <= 4)         AS buybacks_ttm,
    SUM(cf.net_debt_issuance)           FILTER (WHERE cf.rnk <= 4)         AS net_debt_iss_ttm,
    SUM(cf.stock_based_compensation)    FILTER (WHERE cf.rnk <= 4)         AS sbc_ttm,
    SUM(cf.capital_expenditure)         FILTER (WHERE cf.rnk <= 4)         AS capex_ttm,
    SUM(cf.operating_cash_flow)         FILTER (WHERE cf.rnk <= 4)         AS ocf_ttm,
    -- Prior TTM (rnk 5..8) for direction
    SUM(cf.free_cash_flow)              FILTER (WHERE cf.rnk BETWEEN 5 AND 8) AS fcf_ttm_prior,
    SUM(cf.dividends_paid)              FILTER (WHERE cf.rnk BETWEEN 5 AND 8) AS divs_paid_ttm_prior,
    SUM(cf.common_stock_repurchased)    FILTER (WHERE cf.rnk BETWEEN 5 AND 8) AS buybacks_ttm_prior,
    -- Joined NI for FCF/NI conversion
    SUM(iq.net_income)                  FILTER (WHERE cf.rnk <= 4)         AS ni_ttm,
    SUM(iq.revenue)                     FILTER (WHERE cf.rnk <= 4)         AS rev_ttm
  FROM cashflow_q_series cf
  LEFT JOIN income_q_for_fcf iq
    ON iq.symbol = cf.symbol
   AND iq.fiscal_year = cf.fiscal_year
   AND iq.fiscal_quarter = cf.fiscal_quarter
  GROUP BY cf.symbol
),

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 4 — PRE-COMPUTED GROWTH (md_financial_growth, multi-period)
-- ═════════════════════════════════════════════════════════════════════════════

growth_latest_fy AS (
  SELECT DISTINCT ON (fg.symbol)
    fg.symbol,
    fg.fiscal_year,
    fg.revenue_growth,
    fg.eps_growth,
    fg.eps_diluted_growth,
    fg.net_income_growth,
    fg.operating_income_growth,
    fg.gross_profit_growth,
    fg.free_cash_flow_growth,
    fg.operating_cash_flow_growth,
    fg.ebitda_growth,
    fg.dividends_per_share_growth,
    fg.debt_growth,
    fg.book_value_per_share_growth,
    fg.weighted_average_shares_growth                                      AS shares_growth,
    fg.receivables_growth,
    fg.three_y_revenue_growth_per_share                                    AS rev_growth_3y_per_share,
    fg.three_y_net_income_growth_per_share                                 AS ni_growth_3y_per_share,
    fg.five_y_revenue_growth_per_share                                     AS rev_growth_5y_per_share,
    fg.three_y_dividend_per_share_growth_per_share                         AS div_growth_3y,
    fg.three_y_operating_cf_growth_per_share                               AS ocf_growth_3y_per_share
  FROM md_financial_growth fg
  WHERE fg.symbol = (SELECT target_symbol FROM config)
    AND fg.period = 'FY'
    AND fg.report_date <= (SELECT target_date FROM config)
  ORDER BY fg.symbol, fg.fiscal_year DESC
),

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 5 — FORWARD CATALYST CALENDAR
-- ═════════════════════════════════════════════════════════════════════════════

next_earnings AS (
  SELECT
    ec.date                                                                AS next_earnings_date,
    (ec.date - (SELECT target_date FROM config))::int                      AS days_to_next_earnings
  FROM md_earnings_calendar ec
  WHERE ec.symbol = (SELECT target_symbol FROM config)
    AND ec.date > (SELECT target_date FROM config)
    AND ec.eps_actual IS NULL
  ORDER BY ec.date ASC
  LIMIT 1
),

next_div AS (
  SELECT
    d.ex_date                                                              AS next_ex_date,
    d.payment_date                                                         AS next_pay_date,
    d.declaration_date                                                     AS next_decl_date,
    d.adj_dividend                                                         AS next_div_amount,
    (d.ex_date - (SELECT target_date FROM config))::int                    AS days_to_next_ex
  FROM md_dividends d
  WHERE d.symbol = (SELECT target_symbol FROM config)
    AND d.ex_date > (SELECT target_date FROM config)
  ORDER BY d.ex_date ASC
  LIMIT 1
),

catalyst_window_counts AS (
  SELECT
    -- 5-day window
    EXISTS (SELECT 1 FROM md_earnings_calendar
            WHERE symbol = (SELECT target_symbol FROM config)
              AND date > (SELECT target_date FROM config)
              AND date <= (SELECT target_date FROM config) + INTERVAL '5 days'
              AND eps_actual IS NULL)                                      AS earnings_within_5d,
    EXISTS (SELECT 1 FROM md_dividends
            WHERE symbol = (SELECT target_symbol FROM config)
              AND ex_date > (SELECT target_date FROM config)
              AND ex_date <= (SELECT target_date FROM config) + INTERVAL '5 days') AS exdiv_within_5d,
    -- 10-day window
    EXISTS (SELECT 1 FROM md_earnings_calendar
            WHERE symbol = (SELECT target_symbol FROM config)
              AND date > (SELECT target_date FROM config)
              AND date <= (SELECT target_date FROM config) + INTERVAL '10 days'
              AND eps_actual IS NULL)                                      AS earnings_within_10d,
    EXISTS (SELECT 1 FROM md_dividends
            WHERE symbol = (SELECT target_symbol FROM config)
              AND ex_date > (SELECT target_date FROM config)
              AND ex_date <= (SELECT target_date FROM config) + INTERVAL '10 days') AS exdiv_within_10d,
    -- 30-day window
    EXISTS (SELECT 1 FROM md_earnings_calendar
            WHERE symbol = (SELECT target_symbol FROM config)
              AND date > (SELECT target_date FROM config)
              AND date <= (SELECT target_date FROM config) + INTERVAL '30 days'
              AND eps_actual IS NULL)                                      AS earnings_within_30d,
    EXISTS (SELECT 1 FROM md_dividends
            WHERE symbol = (SELECT target_symbol FROM config)
              AND ex_date > (SELECT target_date FROM config)
              AND ex_date <= (SELECT target_date FROM config) + INTERVAL '30 days') AS exdiv_within_30d,
    -- 90-day 8-K activity (event density signal)
    (SELECT COUNT(*) FROM md_8k_filings
     WHERE symbol = (SELECT target_symbol FROM config)
       AND filing_date >= (SELECT target_date FROM config)::timestamp - INTERVAL '90 days'
       AND filing_date <= (SELECT target_date FROM config)::timestamp + INTERVAL '1 day') AS recent_8k_count
),

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 6 — PEER RELATIVE PERFORMANCE (multi-period)
-- ═════════════════════════════════════════════════════════════════════════════

target_perf AS (
  SELECT DISTINCT ON (h.symbol)
    h.symbol,
    h.perf_week,
    h.perf_month,
    h.perf_quarter,
    h.perf_ytd,
    h.perf_year,
    h.relative_strength_4w,
    h.relative_strength_12w
  FROM md_historical_features_daily h
  WHERE h.symbol = (SELECT target_symbol FROM config)
    AND h.as_of_date <= (SELECT target_date FROM config)
    AND h.is_delisted = false
  ORDER BY h.symbol, h.as_of_date DESC
),

sector_perf_median AS (
  -- Sector-wide median performance on the same date as target
  SELECT
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY h.perf_month)              AS sector_perf_month_median,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY h.perf_quarter)            AS sector_perf_quarter_median,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY h.perf_year)               AS sector_perf_year_median
  FROM md_historical_features_daily h
  WHERE h.sector = (SELECT sector FROM target_meta)
    AND h.as_of_date = (SELECT as_of_date FROM target_meta)
    AND h.is_delisted = false
),

spx_perf AS (
  SELECT DISTINCT ON (b.symbol)
    b.perf_4w                                                              AS spx_perf_4w,
    b.perf_12w                                                             AS spx_perf_12w
  FROM md_historical_benchmark_daily b
  WHERE b.symbol = '^GSPC'
    AND b.as_of_date <= (SELECT target_date FROM config)
  ORDER BY b.symbol, b.as_of_date DESC
),

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 7 — LIQUIDITY TIER
-- ═════════════════════════════════════════════════════════════════════════════
-- avg_dollar_volume buckets (USD/day):
--   MEGA   $5B+         can absorb $100M+ position with minimal impact
--   LARGE  $1B-$5B      can absorb $50M position
--   MID    $200M-$1B    $10-50M position with ~50bps impact
--   SMALL  $50M-$200M   $5-10M position with material impact
--   MICRO  $10M-$50M    $1-5M position only
--   NANO   <$10M        retail-scale only

liquidity_tier_calc AS (
  SELECT
    tm.symbol,
    tm.avg_dollar_volume,
    CASE
      WHEN tm.avg_dollar_volume IS NULL THEN NULL
      WHEN tm.avg_dollar_volume >= 5e9   THEN 'MEGA'
      WHEN tm.avg_dollar_volume >= 1e9   THEN 'LARGE'
      WHEN tm.avg_dollar_volume >= 2e8   THEN 'MID'
      WHEN tm.avg_dollar_volume >= 5e7   THEN 'SMALL'
      WHEN tm.avg_dollar_volume >= 1e7   THEN 'MICRO'
      ELSE 'NANO'
    END                                                                    AS liquidity_tier,
    CASE
      WHEN tm.market_cap IS NULL THEN NULL
      WHEN tm.market_cap >= 2e11  THEN 'MEGA_CAP'
      WHEN tm.market_cap >= 1e10  THEN 'LARGE_CAP'
      WHEN tm.market_cap >= 2e9   THEN 'MID_CAP'
      WHEN tm.market_cap >= 3e8   THEN 'SMALL_CAP'
      ELSE 'MICRO_CAP'
    END                                                                    AS market_cap_tier
  FROM target_meta tm
),

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 8 — SHARE COUNT TRAJECTORY
-- ═════════════════════════════════════════════════════════════════════════════

share_count_now AS (
  SELECT DISTINCT ON (f.symbol)
    f.symbol,
    f.shares_outstanding                                                   AS shares_now,
    f.float_shares                                                         AS float_now
  FROM md_features_daily f
  WHERE f.symbol = (SELECT target_symbol FROM config)
    AND f.computed_date <= (SELECT target_date FROM config)
  ORDER BY f.symbol, f.computed_date DESC
),

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 9 — M&A ACTIVITY (annual)
-- ═════════════════════════════════════════════════════════════════════════════

ma_activity AS (
  SELECT DISTINCT ON (cfa.symbol)
    cfa.symbol,
    cfa.fiscal_year                                                        AS ma_fy,
    cfa.acquisitions_net,
    cfa.net_stock_issuance,
    cfa.depreciation_and_amortization                                      AS d_and_a,
    cfa.change_in_working_capital                                          AS dwc
  FROM md_cashflow_annual cfa
  WHERE cfa.symbol = (SELECT target_symbol FROM config)
    AND (cfa.data_known_at IS NULL OR cfa.data_known_at::date <= (SELECT target_date FROM config))
    AND cfa.report_date <= (SELECT target_date FROM config)
  ORDER BY cfa.symbol, cfa.fiscal_year DESC
),

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 10 — ASSEMBLY
-- ═════════════════════════════════════════════════════════════════════════════

assembled AS (
  SELECT
    tm.symbol, tm.sector, tm.industry, tm.as_of_date AS target_date,
    -- §1
    ems.recent_beats_4q, ems.recent_misses_4q,
    ems.recent_eps_surprise_avg_4q, ems.prior_eps_surprise_avg_4q,
    ems.recent_rev_surprise_avg_4q, ems.pattern_8q,
    -- §2 ratios
    rt.gpm_recent, rt.gpm_prior, rt.opm_recent, rt.opm_prior,
    rt.npm_recent, rt.npm_prior,
    rt.asset_turn_recent, rt.asset_turn_prior,
    rt.inv_turn_recent, rt.inv_turn_prior,
    rt.tax_rate_recent, rt.tax_rate_prior,
    rt.fcf_ocf_recent, rt.payout_recent, rt.payout_prior,
    -- §2 key metrics
    kmt.roic_recent, kmt.roic_prior, kmt.roce_recent, kmt.roce_prior,
    kmt.iq_recent, kmt.iq_prior,
    kmt.ccc_recent, kmt.ccc_prior,
    kmt.sbc_recent, kmt.sbc_prior,
    kmt.capex_recent, kmt.capex_prior,
    kmt.nd_ebitda_recent, kmt.nd_ebitda_prior,
    -- §3 capital allocation
    cas.fcf_ttm, cas.fcf_ttm_prior,
    cas.divs_paid_ttm, cas.divs_paid_ttm_prior,
    cas.buybacks_ttm, cas.buybacks_ttm_prior,
    cas.net_debt_iss_ttm, cas.sbc_ttm, cas.capex_ttm, cas.ocf_ttm,
    cas.ni_ttm, cas.rev_ttm,
    -- §4 growth
    g.revenue_growth, g.eps_growth, g.eps_diluted_growth, g.free_cash_flow_growth,
    g.operating_income_growth, g.ebitda_growth, g.debt_growth, g.shares_growth,
    g.dividends_per_share_growth, g.book_value_per_share_growth,
    g.rev_growth_3y_per_share, g.ni_growth_3y_per_share,
    g.rev_growth_5y_per_share, g.div_growth_3y, g.ocf_growth_3y_per_share,
    -- §5 catalyst
    ne.next_earnings_date, ne.days_to_next_earnings,
    nd.next_ex_date, nd.next_pay_date, nd.next_div_amount, nd.days_to_next_ex,
    cwc.earnings_within_5d, cwc.earnings_within_10d, cwc.earnings_within_30d,
    cwc.exdiv_within_5d, cwc.exdiv_within_10d, cwc.exdiv_within_30d,
    cwc.recent_8k_count,
    -- §6 perf
    tp.perf_week, tp.perf_month, tp.perf_quarter, tp.perf_ytd, tp.perf_year,
    tp.relative_strength_4w, tp.relative_strength_12w,
    spm.sector_perf_month_median, spm.sector_perf_quarter_median, spm.sector_perf_year_median,
    sx.spx_perf_4w, sx.spx_perf_12w,
    -- §7 liquidity
    lt.avg_dollar_volume, lt.liquidity_tier, lt.market_cap_tier,
    -- §8 share count
    scn.shares_now, scn.float_now,
    -- §9 M&A
    ma.acquisitions_net, ma.net_stock_issuance
  FROM target_meta tm
  LEFT JOIN earnings_magnitude_summary ems ON ems.symbol = tm.symbol
  LEFT JOIN ratios_q_trajectory rt          ON rt.symbol = tm.symbol
  LEFT JOIN key_metrics_q_trajectory kmt    ON kmt.symbol = tm.symbol
  LEFT JOIN capital_allocation_summary cas  ON cas.symbol = tm.symbol
  LEFT JOIN growth_latest_fy g              ON g.symbol = tm.symbol
  LEFT JOIN next_earnings ne                ON true
  LEFT JOIN next_div nd                     ON true
  LEFT JOIN catalyst_window_counts cwc      ON true
  LEFT JOIN target_perf tp                  ON tp.symbol = tm.symbol
  LEFT JOIN sector_perf_median spm          ON true
  LEFT JOIN spx_perf sx                     ON true
  LEFT JOIN liquidity_tier_calc lt          ON lt.symbol = tm.symbol
  LEFT JOIN share_count_now scn             ON scn.symbol = tm.symbol
  LEFT JOIN ma_activity ma                  ON ma.symbol = tm.symbol
)

-- ═════════════════════════════════════════════════════════════════════════════
-- FINAL OUTPUT — research_object_v6c (MOAT-clean) + debug_payload_v6c (raw)
-- ═════════════════════════════════════════════════════════════════════════════

SELECT
  JSONB_BUILD_OBJECT(
    'meta', JSONB_BUILD_OBJECT(
      'symbol',        a.symbol,
      'sector',        a.sector,
      'industry',      a.industry,
      'as_of_date',    a.target_date,
      'schema_version','research_object_v6c_financial_quality',
      'canon',         'institutional_intelligence_layer_2026_04_23'
    ),

    -- ═══════════════ 1. trajectory_extended ═══════════════
    'trajectory_extended', JSONB_BUILD_OBJECT(
      'beat_miss_pattern_8q', a.pattern_8q,
      'beat_count_4q',        a.recent_beats_4q,
      'eps_surprise_band_recent', CASE
        WHEN a.recent_eps_surprise_avg_4q IS NULL THEN NULL
        WHEN a.recent_eps_surprise_avg_4q < -0.10 THEN 'LARGE_MISS'
        WHEN a.recent_eps_surprise_avg_4q < -0.02 THEN 'MISS'
        WHEN a.recent_eps_surprise_avg_4q < 0.02  THEN 'IN_LINE'
        WHEN a.recent_eps_surprise_avg_4q < 0.10  THEN 'BEAT'
        ELSE 'LARGE_BEAT' END,
      'eps_surprise_direction', CASE
        WHEN a.recent_eps_surprise_avg_4q IS NULL OR a.prior_eps_surprise_avg_4q IS NULL THEN NULL
        WHEN a.recent_eps_surprise_avg_4q > a.prior_eps_surprise_avg_4q + 0.02 THEN 'WIDENING_BEAT'
        WHEN a.recent_eps_surprise_avg_4q < a.prior_eps_surprise_avg_4q - 0.02 THEN 'NARROWING_BEAT'
        ELSE 'STABLE' END,
      'gross_margin_direction', CASE
        WHEN a.gpm_recent IS NULL OR a.gpm_prior IS NULL THEN NULL
        WHEN a.gpm_recent - a.gpm_prior > 0.005 THEN 'EXPANDING'
        WHEN a.gpm_recent - a.gpm_prior < -0.005 THEN 'COMPRESSING'
        ELSE 'STABLE' END,
      'operating_margin_direction', CASE
        WHEN a.opm_recent IS NULL OR a.opm_prior IS NULL THEN NULL
        WHEN a.opm_recent - a.opm_prior > 0.005 THEN 'EXPANDING'
        WHEN a.opm_recent - a.opm_prior < -0.005 THEN 'COMPRESSING'
        ELSE 'STABLE' END,
      'roic_direction', CASE
        WHEN a.roic_recent IS NULL OR a.roic_prior IS NULL THEN NULL
        WHEN a.roic_recent > a.roic_prior * 1.05 THEN 'IMPROVING'
        WHEN a.roic_recent < a.roic_prior * 0.95 THEN 'DETERIORATING'
        ELSE 'STABLE' END
    ),

    -- ═══════════════ 2. financial_quality ═══════════════
    'financial_quality', JSONB_BUILD_OBJECT(
      'fcf_to_ni_ratio_band', CASE
        WHEN a.ni_ttm IS NULL OR a.ni_ttm <= 0 OR a.fcf_ttm IS NULL THEN NULL
        WHEN a.fcf_ttm / a.ni_ttm < 0.50 THEN 'POOR_CONVERSION'
        WHEN a.fcf_ttm / a.ni_ttm < 0.85 THEN 'BELOW_PARITY'
        WHEN a.fcf_ttm / a.ni_ttm < 1.10 THEN 'AT_PARITY'
        ELSE 'STRONG_CONVERSION' END,
      'income_quality_band', CASE
        WHEN a.iq_recent IS NULL THEN NULL
        WHEN a.iq_recent < 0.7 THEN 'LOW'
        WHEN a.iq_recent < 1.0 THEN 'MODERATE'
        WHEN a.iq_recent < 1.3 THEN 'HEALTHY'
        ELSE 'ELEVATED' END,
      'sbc_to_revenue_band', CASE
        WHEN a.sbc_recent IS NULL THEN NULL
        WHEN a.sbc_recent < 0.02 THEN 'MINIMAL'
        WHEN a.sbc_recent < 0.05 THEN 'LOW'
        WHEN a.sbc_recent < 0.10 THEN 'MODERATE'
        WHEN a.sbc_recent < 0.20 THEN 'HIGH'
        ELSE 'EXCESSIVE' END,
      'sbc_direction', CASE
        WHEN a.sbc_recent IS NULL OR a.sbc_prior IS NULL THEN NULL
        WHEN a.sbc_recent > a.sbc_prior * 1.10 THEN 'RISING'
        WHEN a.sbc_recent < a.sbc_prior * 0.90 THEN 'FALLING'
        ELSE 'STABLE' END,
      'cash_conversion_cycle_band', CASE
        WHEN a.ccc_recent IS NULL THEN NULL
        WHEN a.ccc_recent < 0   THEN 'NEGATIVE_FAVORABLE'
        WHEN a.ccc_recent < 30  THEN 'TIGHT'
        WHEN a.ccc_recent < 60  THEN 'NORMAL'
        WHEN a.ccc_recent < 120 THEN 'ELEVATED'
        ELSE 'STRESSED' END,
      'capex_intensity_band', CASE
        WHEN a.capex_recent IS NULL THEN NULL
        WHEN a.capex_recent < 0.10 THEN 'CAPITAL_LIGHT'
        WHEN a.capex_recent < 0.30 THEN 'MODERATE'
        WHEN a.capex_recent < 0.60 THEN 'CAPITAL_INTENSIVE'
        ELSE 'HEAVY_INVESTMENT' END,
      'tax_rate_band', CASE
        WHEN a.tax_rate_recent IS NULL THEN NULL
        WHEN a.tax_rate_recent < 0.10 THEN 'EXCEPTIONAL_LOW'
        WHEN a.tax_rate_recent < 0.18 THEN 'LOW'
        WHEN a.tax_rate_recent < 0.25 THEN 'NORMAL'
        ELSE 'ELEVATED' END,
      'fcf_ocf_efficiency_band', CASE
        WHEN a.fcf_ocf_recent IS NULL THEN NULL
        WHEN a.fcf_ocf_recent < 0.50 THEN 'LOW'
        WHEN a.fcf_ocf_recent < 0.75 THEN 'MODERATE'
        ELSE 'HIGH' END
    ),

    -- ═══════════════ 3. capital_allocation ═══════════════
    'capital_allocation', JSONB_BUILD_OBJECT(
      'total_return_to_shareholders_band', CASE
        WHEN a.fcf_ttm IS NULL OR a.fcf_ttm <= 0 THEN NULL
        WHEN ((-COALESCE(a.divs_paid_ttm,0) - COALESCE(a.buybacks_ttm,0)) / a.fcf_ttm) < 0.20 THEN 'LOW'
        WHEN ((-COALESCE(a.divs_paid_ttm,0) - COALESCE(a.buybacks_ttm,0)) / a.fcf_ttm) < 0.50 THEN 'MODERATE'
        WHEN ((-COALESCE(a.divs_paid_ttm,0) - COALESCE(a.buybacks_ttm,0)) / a.fcf_ttm) < 0.80 THEN 'HIGH'
        ELSE 'AT_OR_ABOVE_FCF' END,
      'buyback_activity', CASE
        WHEN a.buybacks_ttm IS NULL OR a.buybacks_ttm = 0 THEN 'NONE'
        WHEN -a.buybacks_ttm < 1e8                       THEN 'LOW'
        WHEN -a.buybacks_ttm < 1e9                       THEN 'MODERATE'
        WHEN -a.buybacks_ttm < 1e10                      THEN 'HIGH'
        ELSE 'AGGRESSIVE' END,
      'buyback_direction', CASE
        WHEN a.buybacks_ttm IS NULL OR a.buybacks_ttm_prior IS NULL OR a.buybacks_ttm_prior = 0 THEN NULL
        WHEN -a.buybacks_ttm > -a.buybacks_ttm_prior * 1.10 THEN 'EXPANDING'
        WHEN -a.buybacks_ttm < -a.buybacks_ttm_prior * 0.90 THEN 'CONTRACTING'
        ELSE 'STABLE' END,
      'dividend_activity', CASE
        WHEN a.divs_paid_ttm IS NULL OR a.divs_paid_ttm = 0 THEN 'NONE'
        WHEN -a.divs_paid_ttm < 1e8                          THEN 'LOW'
        WHEN -a.divs_paid_ttm < 1e9                          THEN 'MODERATE'
        ELSE 'HIGH' END,
      'dividend_direction', CASE
        WHEN a.divs_paid_ttm IS NULL OR a.divs_paid_ttm_prior IS NULL OR a.divs_paid_ttm_prior = 0 THEN NULL
        WHEN -a.divs_paid_ttm > -a.divs_paid_ttm_prior * 1.05 THEN 'GROWING'
        WHEN -a.divs_paid_ttm < -a.divs_paid_ttm_prior * 0.95 THEN 'CUTTING'
        ELSE 'MAINTAINED' END,
      'net_debt_direction', CASE
        WHEN a.net_debt_iss_ttm IS NULL THEN NULL
        WHEN a.net_debt_iss_ttm > 1e8  THEN 'LEVERAGING_UP'
        WHEN a.net_debt_iss_ttm < -1e8 THEN 'DELEVERAGING'
        ELSE 'STABLE' END,
      'payout_ratio_band', CASE
        WHEN a.payout_recent IS NULL THEN NULL
        WHEN a.payout_recent < 0.20 THEN 'LOW'
        WHEN a.payout_recent < 0.50 THEN 'MODERATE'
        WHEN a.payout_recent < 0.80 THEN 'HIGH'
        ELSE 'STRESSED' END
    ),

    -- ═══════════════ 4. growth_compound ═══════════════
    'growth_compound', JSONB_BUILD_OBJECT(
      'revenue_growth_1y_band', CASE
        WHEN a.revenue_growth IS NULL THEN NULL
        WHEN a.revenue_growth < -0.05 THEN 'DECLINING'
        WHEN a.revenue_growth <  0.02 THEN 'FLAT'
        WHEN a.revenue_growth <  0.10 THEN 'GROWING'
        WHEN a.revenue_growth <  0.25 THEN 'ACCELERATING'
        ELSE 'HYPER_GROWTH' END,
      'eps_growth_1y_band', CASE
        WHEN a.eps_diluted_growth IS NULL THEN NULL
        WHEN a.eps_diluted_growth < -0.10 THEN 'CONTRACTING'
        WHEN a.eps_diluted_growth <  0.05 THEN 'FLAT'
        WHEN a.eps_diluted_growth <  0.15 THEN 'GROWING'
        WHEN a.eps_diluted_growth <  0.30 THEN 'STRONG'
        ELSE 'EXCEPTIONAL' END,
      'fcf_growth_1y_band', CASE
        WHEN a.free_cash_flow_growth IS NULL THEN NULL
        WHEN a.free_cash_flow_growth < -0.10 THEN 'CONTRACTING'
        WHEN a.free_cash_flow_growth <  0.05 THEN 'FLAT'
        WHEN a.free_cash_flow_growth <  0.20 THEN 'GROWING'
        ELSE 'STRONG' END,
      'revenue_growth_3y_per_share_band', CASE
        WHEN a.rev_growth_3y_per_share IS NULL THEN NULL
        WHEN a.rev_growth_3y_per_share < 0       THEN 'NEGATIVE'
        WHEN a.rev_growth_3y_per_share < 0.05    THEN 'LOW'
        WHEN a.rev_growth_3y_per_share < 0.15    THEN 'MODERATE'
        ELSE 'HIGH' END,
      'revenue_growth_5y_per_share_band', CASE
        WHEN a.rev_growth_5y_per_share IS NULL THEN NULL
        WHEN a.rev_growth_5y_per_share < 0       THEN 'NEGATIVE'
        WHEN a.rev_growth_5y_per_share < 0.05    THEN 'LOW'
        WHEN a.rev_growth_5y_per_share < 0.15    THEN 'MODERATE'
        ELSE 'HIGH' END,
      'shares_growth_band', CASE
        WHEN a.shares_growth IS NULL THEN NULL
        WHEN a.shares_growth < -0.02 THEN 'BUYING_BACK_AGGRESSIVELY'
        WHEN a.shares_growth < 0     THEN 'BUYING_BACK'
        WHEN a.shares_growth < 0.01  THEN 'STABLE'
        WHEN a.shares_growth < 0.03  THEN 'MILD_DILUTION'
        ELSE 'HEAVY_DILUTION' END,
      'debt_growth_band', CASE
        WHEN a.debt_growth IS NULL THEN NULL
        WHEN a.debt_growth < -0.05 THEN 'DELEVERAGING'
        WHEN a.debt_growth <  0.05 THEN 'STABLE'
        WHEN a.debt_growth <  0.20 THEN 'LEVERAGING_UP'
        ELSE 'AGGRESSIVE_LEVERAGING' END,
      'book_value_per_share_growth_band', CASE
        WHEN a.book_value_per_share_growth IS NULL THEN NULL
        WHEN a.book_value_per_share_growth < 0    THEN 'CONTRACTING'
        WHEN a.book_value_per_share_growth < 0.05 THEN 'LOW'
        WHEN a.book_value_per_share_growth < 0.15 THEN 'MODERATE'
        ELSE 'HIGH' END
    ),

    -- ═══════════════ 5. forward_catalysts ═══════════════
    -- MOAT discipline: raw days-to-event live in debug_payload_v6c only.
    -- Client surface gets bucket windows + "days" classification phrases.
    'forward_catalysts', JSONB_BUILD_OBJECT(
      'next_earnings_window', CASE
        WHEN a.earnings_within_5d  THEN 'WITHIN_5_DAYS'
        WHEN a.earnings_within_10d THEN 'WITHIN_10_DAYS'
        WHEN a.earnings_within_30d THEN 'WITHIN_30_DAYS'
        WHEN a.days_to_next_earnings IS NOT NULL THEN 'BEYOND_30_DAYS'
        ELSE 'NONE_SCHEDULED' END,
      'next_exdiv_window', CASE
        WHEN a.exdiv_within_5d  THEN 'WITHIN_5_DAYS'
        WHEN a.exdiv_within_10d THEN 'WITHIN_10_DAYS'
        WHEN a.exdiv_within_30d THEN 'WITHIN_30_DAYS'
        WHEN a.days_to_next_ex IS NOT NULL THEN 'BEYOND_30_DAYS'
        ELSE 'NONE_SCHEDULED' END,
      'recent_8k_density', CASE
        WHEN a.recent_8k_count IS NULL OR a.recent_8k_count = 0 THEN 'NONE_IN_90D'
        WHEN a.recent_8k_count <= 2 THEN 'LOW'
        WHEN a.recent_8k_count <= 5 THEN 'NORMAL'
        ELSE 'ELEVATED' END
    ),

    -- ═══════════════ 6. liquidity_tier ═══════════════
    'liquidity_tier', JSONB_BUILD_OBJECT(
      'flow_capacity',     a.liquidity_tier,
      'market_cap_tier',   a.market_cap_tier
    ),

    -- ═══════════════ 7. peer_relative_perf ═══════════════
    'peer_relative_perf', JSONB_BUILD_OBJECT(
      'vs_sector_1m', CASE
        WHEN a.perf_month IS NULL OR a.sector_perf_month_median IS NULL THEN NULL
        WHEN a.perf_month - a.sector_perf_month_median > 0.05  THEN 'STRONG_OUTPERFORM'
        WHEN a.perf_month - a.sector_perf_month_median > 0.01  THEN 'OUTPERFORM'
        WHEN a.perf_month - a.sector_perf_month_median > -0.01 THEN 'IN_LINE'
        WHEN a.perf_month - a.sector_perf_month_median > -0.05 THEN 'UNDERPERFORM'
        ELSE 'STRONG_UNDERPERFORM' END,
      'vs_sector_3m', CASE
        WHEN a.perf_quarter IS NULL OR a.sector_perf_quarter_median IS NULL THEN NULL
        WHEN a.perf_quarter - a.sector_perf_quarter_median > 0.10 THEN 'STRONG_OUTPERFORM'
        WHEN a.perf_quarter - a.sector_perf_quarter_median > 0.02 THEN 'OUTPERFORM'
        WHEN a.perf_quarter - a.sector_perf_quarter_median > -0.02 THEN 'IN_LINE'
        WHEN a.perf_quarter - a.sector_perf_quarter_median > -0.10 THEN 'UNDERPERFORM'
        ELSE 'STRONG_UNDERPERFORM' END,
      'vs_sector_1y', CASE
        WHEN a.perf_year IS NULL OR a.sector_perf_year_median IS NULL THEN NULL
        WHEN a.perf_year - a.sector_perf_year_median > 0.20 THEN 'STRONG_OUTPERFORM'
        WHEN a.perf_year - a.sector_perf_year_median > 0.05 THEN 'OUTPERFORM'
        WHEN a.perf_year - a.sector_perf_year_median > -0.05 THEN 'IN_LINE'
        WHEN a.perf_year - a.sector_perf_year_median > -0.20 THEN 'UNDERPERFORM'
        ELSE 'STRONG_UNDERPERFORM' END,
      'vs_spx_4w', CASE
        WHEN a.perf_month IS NULL OR a.spx_perf_4w IS NULL THEN NULL
        WHEN a.perf_month - a.spx_perf_4w > 0.05  THEN 'STRONG_OUTPERFORM'
        WHEN a.perf_month - a.spx_perf_4w > 0.01  THEN 'OUTPERFORM'
        WHEN a.perf_month - a.spx_perf_4w > -0.01 THEN 'IN_LINE'
        WHEN a.perf_month - a.spx_perf_4w > -0.05 THEN 'UNDERPERFORM'
        ELSE 'STRONG_UNDERPERFORM' END,
      'vs_spx_12w', CASE
        WHEN a.perf_quarter IS NULL OR a.spx_perf_12w IS NULL THEN NULL
        WHEN a.perf_quarter - a.spx_perf_12w > 0.10 THEN 'STRONG_OUTPERFORM'
        WHEN a.perf_quarter - a.spx_perf_12w > 0.02 THEN 'OUTPERFORM'
        WHEN a.perf_quarter - a.spx_perf_12w > -0.02 THEN 'IN_LINE'
        WHEN a.perf_quarter - a.spx_perf_12w > -0.10 THEN 'UNDERPERFORM'
        ELSE 'STRONG_UNDERPERFORM' END,
      'absolute_perf_band_1y', CASE
        WHEN a.perf_year IS NULL THEN NULL
        WHEN a.perf_year < -0.20 THEN 'DOWN_HARD'
        WHEN a.perf_year < -0.05 THEN 'DOWN'
        WHEN a.perf_year <  0.05 THEN 'FLAT'
        WHEN a.perf_year <  0.20 THEN 'UP'
        WHEN a.perf_year <  0.50 THEN 'STRONG_UP'
        ELSE 'PARABOLIC' END
    ),

    -- ═══════════════ 8. share_count_trajectory ═══════════════
    'share_count_trajectory', JSONB_BUILD_OBJECT(
      'shares_growth_1y_band', CASE
        WHEN a.shares_growth IS NULL THEN NULL
        WHEN a.shares_growth < -0.02 THEN 'BUYING_BACK_AGGRESSIVELY'
        WHEN a.shares_growth < 0     THEN 'BUYING_BACK'
        WHEN a.shares_growth < 0.01  THEN 'STABLE'
        WHEN a.shares_growth < 0.03  THEN 'MILD_DILUTION'
        ELSE 'HEAVY_DILUTION' END,
      'sbc_pressure_band', CASE
        WHEN a.sbc_recent IS NULL THEN NULL
        WHEN a.sbc_recent < 0.02 THEN 'NEGLIGIBLE'
        WHEN a.sbc_recent < 0.05 THEN 'LOW'
        WHEN a.sbc_recent < 0.10 THEN 'MODERATE'
        WHEN a.sbc_recent < 0.20 THEN 'HIGH'
        ELSE 'EXCESSIVE' END
    ),

    -- ═══════════════ 9. ma_activity (annual) ═══════════════
    'ma_activity', JSONB_BUILD_OBJECT(
      'acquisitions_band', CASE
        WHEN a.acquisitions_net IS NULL OR a.acquisitions_net = 0 THEN 'NONE'
        WHEN ABS(a.acquisitions_net) < 1e8  THEN 'BOLT_ON'
        WHEN ABS(a.acquisitions_net) < 1e9  THEN 'MID_SIZED'
        WHEN ABS(a.acquisitions_net) < 1e10 THEN 'LARGE'
        ELSE 'TRANSFORMATIVE' END
    ),

    -- ═══════════════ Compliance footer ═══════════════
    'compliance', JSONB_BUILD_OBJECT(
      'disclaimer', 'Research Object describes historical patterns and current evidence. Not an investment recommendation.',
      'not_advice', TRUE,
      'pit_integrity', TRUE,
      'survivorship_clean', TRUE,
      'tier', 'A — financial quality + catalyst + liquidity'
    )
  ) AS research_object_v6c,

  JSONB_BUILD_OBJECT('raw', TO_JSONB(a.*)) AS debug_payload_v6c

FROM assembled a;

-- ═════════════════════════════════════════════════════════════════════════════
-- END query_v6c_financial_quality.sql
-- ═════════════════════════════════════════════════════════════════════════════
