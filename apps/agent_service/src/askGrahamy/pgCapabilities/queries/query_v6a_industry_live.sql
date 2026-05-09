-- ═════════════════════════════════════════════════════════════════════════════
-- Grahamy — Research Object Query V6a INDUSTRY LIVE (Fast Path)
-- ═════════════════════════════════════════════════════════════════════════════
-- ANCHOR: an INDUSTRY (Semiconductors, Biotechnology, Homebuilders, ...).
-- Same 5-question contract as V6a SECTOR, but lighter — there are no
-- industry-level peer / regime-forward / analog-bucket materialised views the
-- way there are for sectors, so the SQL leans on:
--
--   md_industries           — dimension (id, name)
--   md_industry_features    — daily PE + avg % change (FMP industry snapshots)
--   md_symbols              — symbol→industry_id and symbol→sector_id linkage
--   md_historical_features_daily
--                           — per-symbol-per-day rows that already carry
--                             `industry`, `industry_pe`, `pe_percentile_in_industry`
--                             (FK to md_industries.name)
--   md_forward_returns      — for the historical_base_rate aggregation
--   md_historical_benchmark_daily
--                           — SP500 + VIX context (same as sector path)
--
-- "Under-which-conditions" (regime × valuation × bucket matrix) is intentionally
-- omitted — building it from raw rows would be expensive without the MV. The
-- agent surface explains industry-level historical performance in one
-- unconditional aggregate plus the per-day path-risk distribution.
--
-- PIT / MOAT / SURVIVORSHIP — same guarantees as V6a SECTOR (is_delisted=false,
-- pe_ratio>0 & price>0 on raw filters; Monday-sample on the unconditional
-- forward-return distribution).
--
-- USAGE:
--   docker exec -i stock_analyzer_db psql -U stock_user -d stock_analyzer \
--     -v INDUSTRY="'Semiconductors'" < query_v6a_industry_live.sql
-- ═════════════════════════════════════════════════════════════════════════════

WITH

config AS (
  SELECT
    :INDUSTRY::text                                         AS target_industry,
    -- Anchor on the most recent row in md_historical_features_daily that
    -- mentions this industry. Mirrors how the sector SQL anchors on
    -- md_research_sector_peer_daily — the most-recently-populated table
    -- governs target_date so freshness gauges line up.
    (SELECT MAX(as_of_date)
       FROM md_historical_features_daily
      WHERE industry = :INDUSTRY::text
        AND is_delisted = false)                            AS target_date
),

industry_dim AS (
  SELECT id AS industry_id, name AS industry_name
  FROM md_industries
  WHERE name = (SELECT target_industry FROM config)
),

-- Industry has no `sector_id` on the dimension table, so derive the dominant
-- parent sector from member symbols. Most industries map cleanly to a single
-- sector; tied / mixed industries fall back to the most-populated one.
parent_sector_lookup AS (
  SELECT s.name AS parent_sector
  FROM md_symbols sym
  JOIN md_sectors s ON s.id = sym.sector_id
  WHERE sym.industry_id = (SELECT industry_id FROM industry_dim)
    AND sym.is_active = true
  GROUP BY s.id, s.name
  ORDER BY COUNT(*) DESC NULLS LAST
  LIMIT 1
),

-- Today's market regime, anchored to SPY's row on target_date (same convention
-- as the sector SQL).
market_state_today AS (
  SELECT market_regime
  FROM md_historical_features_daily
  WHERE symbol = 'SPY'
    AND as_of_date = (SELECT target_date FROM config)
    AND is_delisted = false
),

benchmark_sp500 AS (
  SELECT perf_4w AS sp500_perf_4w, perf_12w AS sp500_perf_12w
  FROM md_historical_benchmark_daily
  WHERE symbol = '^GSPC' AND as_of_date <= (SELECT target_date FROM config)
  ORDER BY as_of_date DESC LIMIT 1
),

benchmark_vix AS (
  SELECT close AS vix_close
  FROM md_historical_benchmark_daily
  WHERE symbol = '^VIX' AND as_of_date <= (SELECT target_date FROM config)
  ORDER BY as_of_date DESC LIMIT 1
),

-- Today's industry-level PE + performance from FMP industry snapshots.
industry_today_features AS (
  SELECT pe AS industry_pe, avg_change_percent AS industry_avg_change_pct
  FROM md_industry_features
  WHERE industry_id = (SELECT industry_id FROM industry_dim)
    AND date <= (SELECT target_date FROM config)
  ORDER BY date DESC
  LIMIT 1
),

-- Industry constituents on target_date with the standard PIT filters.
industry_universe_today AS (
  SELECT
    h.symbol,
    h.market_cap,
    h.pe_ratio,
    h.pe_percentile_in_industry,
    h.perf_week,
    h.perf_month,
    h.days_to_earnings,
    h.rsi_14
  FROM md_historical_features_daily h
  WHERE h.industry = (SELECT target_industry FROM config)
    AND h.as_of_date = (SELECT target_date FROM config)
    AND h.is_delisted = false
    AND h.price > 0
),

industry_census AS (
  SELECT
    COUNT(*)                                                AS n_symbols,
    COUNT(*) FILTER (WHERE pe_ratio IS NOT NULL AND pe_ratio > 0) AS n_with_valuation,
    AVG(pe_percentile_in_industry)                          AS mean_pe_percentile,
    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY pe_percentile_in_industry)
      FILTER (WHERE pe_percentile_in_industry IS NOT NULL)  AS p25_pe_percentile,
    PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY pe_percentile_in_industry)
      FILTER (WHERE pe_percentile_in_industry IS NOT NULL)  AS p50_pe_percentile,
    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY pe_percentile_in_industry)
      FILTER (WHERE pe_percentile_in_industry IS NOT NULL)  AS p75_pe_percentile,
    AVG(perf_week)                                          AS mean_perf_week,
    AVG(perf_month)                                         AS mean_perf_month
  FROM industry_universe_today
),

industry_top_by_marketcap AS (
  SELECT
    symbol,
    market_cap,
    pe_percentile_in_industry,
    perf_month,
    RANK() OVER (ORDER BY market_cap DESC NULLS LAST) AS rnk
  FROM industry_universe_today
  WHERE market_cap IS NOT NULL AND market_cap > 0
),

-- Unconditional industry forward 60-day distribution (Monday-sampled, PIT).
industry_forward_pct AS (
  SELECT
    COUNT(*)                                                AS n,
    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY fr.h60_return) AS p25_h60,
    PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY fr.h60_return) AS median_h60,
    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY fr.h60_return) AS p75_h60,
    AVG(fr.h60_return)                                      AS avg_h60,
    -- Hit-rate proxy: positive 60-day return.
    SUM(CASE WHEN fr.h60_return > 0 THEN 1 ELSE 0 END)      AS wins_h60,
    COUNT(*) FILTER (WHERE fr.h60_return IS NOT NULL)       AS total_h60
  FROM md_historical_features_daily h
  JOIN md_forward_returns fr
    ON fr.symbol = h.symbol AND fr.as_of_date = h.as_of_date
  WHERE h.industry = (SELECT target_industry FROM config)
    AND h.as_of_date >= DATE '2010-01-01'
    AND h.as_of_date <= (SELECT target_date FROM config) - INTERVAL '60 days'
    AND h.is_delisted = false
    AND EXTRACT(DOW FROM h.as_of_date) = 1
    AND fr.h60_return IS NOT NULL
),

-- Industry earnings density today (mirrors sector_event_context).
industry_event_context AS (
  SELECT
    100.0
      * COUNT(*) FILTER (WHERE days_to_earnings BETWEEN 0 AND 14)
      / NULLIF(COUNT(*), 0) AS pct_constituents_earnings_within_2w
  FROM industry_universe_today
),

-- Path-risk distribution for industry constituents over the past 60 days.
industry_path_entries AS (
  SELECT
    h.symbol,
    h.as_of_date AS entry_date,
    h.price::numeric AS entry_price
  FROM md_historical_features_daily h
  WHERE h.industry = (SELECT target_industry FROM config)
    AND h.as_of_date = (SELECT target_date FROM config)
    AND h.is_delisted = false
    AND h.price > 0
),
industry_path_days AS (
  SELECT
    e.symbol,
    e.entry_date,
    e.entry_price,
    p.price::numeric AS path_price,
    p.as_of_date AS path_date,
    ROW_NUMBER() OVER (PARTITION BY e.symbol, e.entry_date ORDER BY p.as_of_date) - 1 AS path_day
  FROM industry_path_entries e
  JOIN LATERAL (
    SELECT h2.as_of_date, h2.price
    FROM md_historical_features_daily h2
    WHERE h2.symbol = e.symbol
      AND h2.as_of_date >= e.entry_date
      AND h2.as_of_date <= e.entry_date + INTERVAL '120 days'
      AND h2.price > 0
    ORDER BY h2.as_of_date
    LIMIT 61
  ) p ON true
),
industry_path_stats AS (
  SELECT
    symbol,
    entry_date,
    entry_price,
    COUNT(*) AS observed_days,
    MIN((path_price - entry_price) / NULLIF(entry_price, 0)) AS max_drawdown,
    MAX(path_day) AS last_day,
    MAX(CASE WHEN path_day = 60 THEN path_price ELSE NULL END) AS price_at_60,
    MAX(CASE WHEN (path_price - entry_price) / NULLIF(entry_price, 0) >= 0 THEN 1 ELSE 0 END) AS recovered
  FROM industry_path_days
  GROUP BY symbol, entry_date, entry_price
),
industry_path_risk AS (
  SELECT
    COUNT(*) FILTER (WHERE observed_days >= 40) AS path_n,
    AVG(CASE WHEN (price_at_60 - entry_price) / NULLIF(entry_price, 0) < 0 THEN 1.0 ELSE 0.0 END) * 100 AS loss_rate_h60_pct,
    AVG(CASE WHEN (price_at_60 - entry_price) / NULLIF(entry_price, 0) <= -0.10 THEN 1.0 ELSE 0.0 END) * 100 AS severe_loss_rate_h60_pct,
    PERCENTILE_CONT(0.10) WITHIN GROUP (ORDER BY max_drawdown DESC) * 100 AS p10_max_drawdown_pct,
    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY max_drawdown DESC) * 100 AS p25_max_drawdown_pct,
    MIN(max_drawdown) * 100 AS worst_max_drawdown_pct,
    AVG(CASE WHEN max_drawdown <= -0.05 THEN 1.0 ELSE 0.0 END) * 100 AS prob_drawdown_gt_5_pct,
    AVG(CASE WHEN max_drawdown <= -0.10 THEN 1.0 ELSE 0.0 END) * 100 AS prob_drawdown_gt_10_pct,
    AVG(CASE WHEN max_drawdown <= -0.15 THEN 1.0 ELSE 0.0 END) * 100 AS prob_drawdown_gt_15_pct,
    AVG(CASE WHEN max_drawdown <= -0.20 THEN 1.0 ELSE 0.0 END) * 100 AS prob_drawdown_gt_20_pct,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY CASE WHEN recovered = 1 THEN observed_days::float ELSE NULL END) AS median_recovery_days,
    AVG(CASE WHEN recovered = 1 THEN 1.0 ELSE 0.0 END) * 100 AS recovered_by_horizon_rate_pct,
    CASE
      WHEN COUNT(*) FILTER (WHERE observed_days >= 40) < 30  THEN 'INSUFFICIENT'
      WHEN COUNT(*) FILTER (WHERE observed_days >= 40) < 100 THEN 'WEAK'
      WHEN COUNT(*) FILTER (WHERE observed_days >= 40) < 500 THEN 'ADEQUATE'
      ELSE 'ROBUST'
    END AS sample_adequacy
  FROM industry_path_stats
  WHERE observed_days >= 40
),

assembled AS (
  SELECT
    cfg.target_industry,
    cfg.target_date,
    psl.parent_sector,
    mst.market_regime                                       AS current_market_regime,

    bs.sp500_perf_4w, bs.sp500_perf_12w,
    bv.vix_close,

    itf.industry_pe, itf.industry_avg_change_pct,

    ic.n_symbols, ic.n_with_valuation,
    ic.mean_pe_percentile, ic.p25_pe_percentile, ic.p50_pe_percentile, ic.p75_pe_percentile,
    ic.mean_perf_week, ic.mean_perf_month,

    (SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
        'symbol',                  symbol,
        'market_cap',              market_cap,
        'pe_percentile_in_industry',
          ROUND((COALESCE(pe_percentile_in_industry, 0) * 100)::numeric, 1),
        'perf_month_pct',          ROUND((COALESCE(perf_month, 0) * 100)::numeric, 2)
      ) ORDER BY rnk)
     FILTER (WHERE rnk <= 10) FROM industry_top_by_marketcap)   AS top_members_json,

    ifp.n                                                   AS base_n,
    ifp.avg_h60                                             AS base_avg_h60,
    ifp.median_h60                                          AS base_median_h60,
    ifp.p25_h60                                             AS base_p25_h60,
    ifp.p75_h60                                             AS base_p75_h60,
    ifp.wins_h60                                            AS base_wins_h60,
    ifp.total_h60                                           AS base_total_h60,

    iec.pct_constituents_earnings_within_2w                 AS event_pct_earnings_2w

  FROM config cfg
  -- LEFT JOINs so the row still emits when an upstream table is sparse for
  -- this industry (e.g. very new industry classification).
  LEFT JOIN industry_dim id              ON true
  LEFT JOIN parent_sector_lookup psl     ON true
  LEFT JOIN market_state_today mst       ON true
  LEFT JOIN benchmark_sp500 bs           ON true
  LEFT JOIN benchmark_vix bv             ON true
  LEFT JOIN industry_today_features itf  ON true
  LEFT JOIN industry_census ic           ON true
  LEFT JOIN industry_forward_pct ifp     ON true
  LEFT JOIN industry_event_context iec   ON true
)

SELECT
  JSONB_BUILD_OBJECT(
    'meta', JSONB_BUILD_OBJECT(
      'anchor_type',            'INDUSTRY',
      'mode',                   'FAST',
      'industry',               a.target_industry,
      'parent_sector',          a.parent_sector,
      'as_of_date',             a.target_date,
      'current_market_regime',  a.current_market_regime,
      'schema_version',         'research_object_v6a_industry',
      'canon',                  'institutional_intelligence_layer_2026_05_08'
    ),

    'what_matters', JSONB_BUILD_OBJECT(
      'symbols',                       a.n_symbols,
      'symbols_with_valuation_data',   a.n_with_valuation,
      'parent_sector',                 a.parent_sector,
      'industry_pe_today',             a.industry_pe,
      'industry_avg_change_today_pct', a.industry_avg_change_pct,
      'industry_pe_percentile_distribution', JSONB_BUILD_OBJECT(
        'p25',    ROUND((COALESCE(a.p25_pe_percentile, 0) * 100)::numeric, 1),
        'median', ROUND((COALESCE(a.p50_pe_percentile, 0) * 100)::numeric, 1),
        'p75',    ROUND((COALESCE(a.p75_pe_percentile, 0) * 100)::numeric, 1),
        'note',   'Distribution of constituent PE-in-industry percentiles. '
               || 'Higher = constituents trade at richer valuations relative to '
               || 'their own industry history.'
      ),
      'recent_perf', JSONB_BUILD_OBJECT(
        'mean_week_pct',  ROUND((COALESCE(a.mean_perf_week, 0) * 100)::numeric, 2),
        'mean_month_pct', ROUND((COALESCE(a.mean_perf_month, 0) * 100)::numeric, 2)
      ),
      'top_members_by_market_cap',     COALESCE(a.top_members_json, '[]'::jsonb)
    ),

    'why_now', JSONB_BUILD_OBJECT(
      'current_regime',          a.current_market_regime,
      'vix_band',
        CASE
          WHEN a.vix_close IS NULL THEN NULL
          WHEN a.vix_close < 13 THEN 'VERY_LOW'
          WHEN a.vix_close < 18 THEN 'LOW'
          WHEN a.vix_close < 25 THEN 'MODERATE'
          WHEN a.vix_close < 35 THEN 'ELEVATED'
          ELSE 'STRESSED'
        END,
      'sp500_perf_4w_band',
        CASE
          WHEN a.sp500_perf_4w IS NULL THEN NULL
          WHEN a.sp500_perf_4w < -0.05 THEN 'DRAWDOWN'
          WHEN a.sp500_perf_4w <  0.01 THEN 'WEAK'
          WHEN a.sp500_perf_4w <  0.05 THEN 'POSITIVE'
          ELSE 'STRONG_RALLY'
        END
    ),

    'historical_base_rate', JSONB_BUILD_OBJECT(
      'n_observations',          a.base_n,
      'h60_avg_pct',             ROUND((COALESCE(a.base_avg_h60, 0) * 100)::numeric, 2),
      'h60_median_pct',          ROUND((COALESCE(a.base_median_h60, 0) * 100)::numeric, 2),
      'h60_p25_pct',             ROUND((COALESCE(a.base_p25_h60, 0) * 100)::numeric, 2),
      'h60_p75_pct',             ROUND((COALESCE(a.base_p75_h60, 0) * 100)::numeric, 2),
      'h60_hit_rate',            ROUND((a.base_wins_h60::numeric / NULLIF(a.base_total_h60, 0) * 100), 1),
      'sample_adequacy',
        CASE
          WHEN COALESCE(a.base_n, 0) < 200  THEN 'INSUFFICIENT'
          WHEN a.base_n < 500               THEN 'WEAK'
          WHEN a.base_n < 2000              THEN 'ADEQUATE'
          ELSE                                   'ROBUST'
        END,
      'framing_note',            'Unconditional Monday-sampled forward-return aggregate '
                              || 'across ALL historical observations for this industry. '
                              || 'Industry-level peer/regime-conditioned MV is not yet built; '
                              || 'when it lands the regime / valuation rollups will be added.'
    ),

    'under_which_conditions', JSONB_BUILD_OBJECT(
      '_unavailable_note', 'Industry-level peer / regime-conditioned MV is not yet '
                        || 'populated. The current-regime / valuation rollups available '
                        || 'on sectors do not yet exist for industries.'
    ),

    'event_context', JSONB_BUILD_OBJECT(
      'pct_constituents_earnings_within_2w',
        ROUND(COALESCE(a.event_pct_earnings_2w, 0)::numeric, 1),
      'earnings_cluster_band',
        CASE
          WHEN a.event_pct_earnings_2w IS NULL     THEN NULL
          WHEN a.event_pct_earnings_2w >= 30       THEN 'CONCENTRATED'
          WHEN a.event_pct_earnings_2w >= 10       THEN 'MODERATE'
          ELSE                                          'SPARSE'
        END,
      'note', 'Fraction of industry constituents with earnings within 14 calendar days.'
    ),

    'invalidation', JSONB_BUILD_OBJECT(
      'edge_evidence_seam', JSONB_BUILD_OBJECT(
        '_bridge_required', TRUE,
        '_bridge_note', 'Industry-level validated edge evidence is not yet bridged. '
                     || 'When it is, the active convergence / Sentinel rolling WR / '
                     || 'Coroner decay posture will be exposed via the bridge layer.'
      )
    ),

    'path_risk_base', JSONB_BUILD_OBJECT(
      'source',                        'pg_daily_price_path',
      'horizon',                       '60-day',
      'n',                             (SELECT path_n FROM industry_path_risk),
      'loss_rate_h60_pct',             (SELECT ROUND(loss_rate_h60_pct::numeric, 2) FROM industry_path_risk),
      'severe_loss_rate_h60_pct',      (SELECT ROUND(severe_loss_rate_h60_pct::numeric, 2) FROM industry_path_risk),
      'p10_max_drawdown_pct',          (SELECT ROUND(p10_max_drawdown_pct::numeric, 2) FROM industry_path_risk),
      'p25_max_drawdown_pct',          (SELECT ROUND(p25_max_drawdown_pct::numeric, 2) FROM industry_path_risk),
      'worst_max_drawdown_pct',        (SELECT ROUND(worst_max_drawdown_pct::numeric, 2) FROM industry_path_risk),
      'prob_drawdown_gt_5_pct',        (SELECT ROUND(prob_drawdown_gt_5_pct::numeric, 2) FROM industry_path_risk),
      'prob_drawdown_gt_10_pct',       (SELECT ROUND(prob_drawdown_gt_10_pct::numeric, 2) FROM industry_path_risk),
      'prob_drawdown_gt_15_pct',       (SELECT ROUND(prob_drawdown_gt_15_pct::numeric, 2) FROM industry_path_risk),
      'prob_drawdown_gt_20_pct',       (SELECT ROUND(prob_drawdown_gt_20_pct::numeric, 2) FROM industry_path_risk),
      'median_recovery_days',          (SELECT ROUND(median_recovery_days::numeric, 1) FROM industry_path_risk),
      'recovered_by_horizon_rate_pct', (SELECT ROUND(recovered_by_horizon_rate_pct::numeric, 2) FROM industry_path_risk),
      'sample_adequacy',               (SELECT sample_adequacy FROM industry_path_risk)
    ),

    'compliance', JSONB_BUILD_OBJECT(
      'disclaimer', 'Research Object (fast mode) describes historical patterns at the industry level. '
                 || 'Not an investment recommendation.',
      'not_advice',         TRUE,
      'pit_integrity',      TRUE,
      'survivorship_clean', TRUE
    )
  ) AS research_object,

  JSONB_BUILD_OBJECT(
    'target_industry',           a.target_industry,
    'parent_sector',             a.parent_sector,
    'target_date',               a.target_date,
    'raw_industry_pe',           a.industry_pe,
    'raw_industry_avg_change_pct', a.industry_avg_change_pct,
    'raw_base_avg_h60',          a.base_avg_h60,
    'raw_base_median_h60',       a.base_median_h60,
    'raw_base_n',                a.base_n,
    'raw_event_pct_earnings_2w', a.event_pct_earnings_2w,
    'raw_vix_close',             a.vix_close,
    'raw_mean_perf_week',        a.mean_perf_week,
    'raw_mean_perf_month',       a.mean_perf_month
  ) AS debug_payload

FROM assembled a;

-- ═════════════════════════════════════════════════════════════════════════════
-- END OF Research Object Query V6a INDUSTRY LIVE
-- ═════════════════════════════════════════════════════════════════════════════
