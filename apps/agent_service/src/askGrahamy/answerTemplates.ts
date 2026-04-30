import {
  DEFAULT_DISCLAIMER,
  EMPTY_PUBLIC_RESEARCH_VIEW,
  type AnswerObject,
  type AnswerType,
  type CachedResearchObject,
  type Classification,
  type PublicResearchView,
  type UiHints,
} from "./types";

const DEFAULT_FOLLOWUPS = [
  "What are the main risks?",
  "How does this compare to peers?",
  "What would invalidate the thesis?",
  "How does this fit the current market regime?",
];

// ─── Humanizer ───────────────────────────────────────────────────────────────
//
// Maps the v6 SQL bucket / band enum constants to natural prose. Every
// renderer goes through `humanize()` before emitting user-visible strings —
// the raw `MEGA_CAP`, `STRONG_OUTPERFORM`, `WITHIN_10_DAYS` etc. that leaked
// into earlier answers all get translated here.

const HUMANIZE_MAP: Record<string, string> = {
  // Time windows / catalyst proximity
  WITHIN_5_DAYS: "within 5 days",
  WITHIN_10_DAYS: "within 10 days",
  WITHIN_30_DAYS: "within 30 days",
  WITHIN_TWO_WEEKS: "within two weeks",
  WITHIN_SIX_WEEKS: "within six weeks",
  BEYOND_30_DAYS: "beyond 30 days",
  JUST_REPORTED: "just reported",
  NONE_SCHEDULED: "none scheduled",
  NONE_IN_90D: "none in the last 90 days",
  NO_NEAR_CATALYST: "no near-term catalyst",
  // Market cap / liquidity tiers
  MEGA_CAP: "mega-cap",
  LARGE_CAP: "large-cap",
  MID_CAP: "mid-cap",
  SMALL_CAP: "small-cap",
  MICRO_CAP: "micro-cap",
  MEGA: "very high (mega)",
  LARGE: "high (large)",
  MID: "moderate (mid)",
  SMALL: "small",
  MICRO: "micro",
  NANO: "nano",
  // Performance
  STRONG_UP: "strongly up",
  DOWN_HARD: "sharply down",
  PARABOLIC: "parabolic",
  STRONG_OUTPERFORM: "strongly outperforming",
  OUTPERFORM: "outperforming",
  STRONG_UNDERPERFORM: "strongly underperforming",
  UNDERPERFORM: "underperforming",
  IN_LINE: "in-line",
  STRONG_RALLY: "a strong rally",
  DRAWDOWN: "a drawdown",
  // Trend direction
  ACCELERATING: "accelerating",
  HYPER_GROWTH: "hyper-growth",
  EXPANDING: "expanding",
  COMPRESSING: "compressing",
  STABLE: "stable",
  RISING: "rising",
  FALLING: "falling",
  IMPROVING: "improving",
  DETERIORATING: "deteriorating",
  CONTRACTING: "contracting",
  GROWING: "growing",
  FLAT: "flat",
  DECLINING: "declining",
  LEVERAGING_UP: "leveraging up",
  AGGRESSIVE_LEVERAGING: "aggressively leveraging up",
  DELEVERAGING: "deleveraging",
  // Buy-back / shares
  BUYING_BACK_AGGRESSIVELY: "aggressively buying back shares",
  BUYING_BACK: "buying back shares",
  MILD_DILUTION: "mild dilution",
  HEAVY_DILUTION: "heavy dilution",
  // Quality / quintile / fit
  TOP_QUARTILE: "top quartile",
  ABOVE_MEDIAN: "above median",
  BELOW_MEDIAN: "below median",
  BOTTOM_QUARTILE: "bottom quartile",
  TOP_QUINTILE: "top quintile",
  HIGH_QUINTILE: "high quintile",
  MID_QUINTILE: "middle quintile",
  LOW_QUINTILE: "low quintile",
  BOTTOM_QUINTILE: "bottom quintile",
  ALIGNED: "regime-aligned",
  CHALLENGED: "regime-challenged",
  UNCERTAIN: "uncertain",
  // Earnings / catalyst
  LARGE_BEAT: "large beat",
  BEAT: "beat",
  MISS: "miss",
  LARGE_MISS: "large miss",
  WIDENING_BEAT: "widening beat margins",
  NARROWING_BEAT: "narrowing beat margins",
  // Capital allocation
  AGGRESSIVE: "aggressive",
  ACTIVE: "active",
  AT_OR_ABOVE_FCF: "at or above free-cash-flow",
  ABOVE_FCF: "above free-cash-flow",
  MAINTAINED: "maintained",
  CUTTING: "cut",
  // Quality bands
  STRONG_CONVERSION: "strong conversion",
  AT_PARITY: "at parity",
  BELOW_PARITY: "below parity",
  POOR_CONVERSION: "poor conversion (under 50%)",
  HEALTHY: "healthy",
  ELEVATED: "elevated",
  STRESSED: "stressed",
  AMPLE: "ample",
  COMFORTABLE: "comfortable",
  ADEQUATE: "adequate",
  ROBUST: "robust",
  WEAK: "weak",
  INSUFFICIENT: "insufficient (low sample)",
  THIN: "thin",
  CONSTRUCTIVE: "constructive",
  MIXED: "mixed",
  STRONG: "strong",
  MODERATE: "moderate",
  HIGH: "high",
  LOW: "low",
  MINIMAL: "minimal",
  EXCESSIVE: "excessive",
  NEGLIGIBLE: "negligible",
  NONE: "none",
  HEAVY_INVESTMENT: "heavy investment",
  CAPITAL_INTENSIVE: "capital-intensive",
  CAPITAL_LIGHT: "capital-light",
  NEGATIVE_FAVORABLE: "favorably negative (free working-capital funding)",
  TIGHT: "tight",
  NORMAL: "normal",
  EXCEPTIONAL_LOW: "unusually low",
  // Balance sheet
  SAFE_ZONE: "safe zone",
  GREY_ZONE: "grey zone",
  DISTRESS_ZONE: "distress zone",
  AVERAGE: "average",
  HIGH_VARIANCE: "high variance",
  // Valuation
  WELL_BELOW_OWN_HISTORY: "well below its own 10-year history",
  BELOW_OWN_HISTORY: "below its own 10-year history",
  AT_OWN_HISTORY: "in line with its own 10-year history",
  ABOVE_OWN_HISTORY: "above its own 10-year history",
  WELL_ABOVE_OWN_HISTORY: "well above its own 10-year history",
  IN_LINE_WITH_HISTORY: "in line with its own 5-year history",
  BELOW_HISTORY: "below its own 5-year history",
  SIGNIFICANTLY_BELOW: "significantly below its own 5-year history",
  SPIKE_FLAG: "unusually elevated (spike flag)",
  BELOW_ONE: "below 1.0",
  ONE_TO_ONEPOINTFIVE: "between 1.0 and 1.5",
  ONEPOINTFIVE_TO_TWOPOINTFIVE: "between 1.5 and 2.5",
  ABOVE_TWOPOINTFIVE: "above 2.5",
  // Sector buckets
  DEEP_VALUE: "deep value",
  VALUE: "value",
  FAIR: "fair value",
  RICH: "rich",
  EXPENSIVE: "expensive",
  // M&A
  BOLT_ON: "bolt-on (small)",
  MID_SIZED: "mid-sized",
  TRANSFORMATIVE: "transformative",
  // Regime
  NEUTRAL: "NEUTRAL",
  RISK_ON: "RISK-ON",
  RISK_OFF: "RISK-OFF",
  // VIX
  VERY_LOW: "very low",
  // Yield band
  // (uses LOW/MODERATE/HIGH already)
};

function humanize(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (HUMANIZE_MAP[trimmed]) return HUMANIZE_MAP[trimmed];
  // Generic fallback: lowercase + underscores → spaces.
  return trimmed.toLowerCase().replace(/_/g, " ");
}

/** Bucket a percentage hit-rate into a qualitative band (matches the buckets
 *  used by the v6 SQL — keeps language consistent across surfaces). */
function bucketHitRate(pct: number | undefined): string | undefined {
  if (pct == null || !Number.isFinite(pct)) return undefined;
  if (pct >= 60) return "strong";
  if (pct >= 52) return "constructive";
  if (pct >= 45) return "mixed";
  return "weak";
}

export function buildClarificationAnswer(): {
  answerType: AnswerType;
  answer: AnswerObject;
  researchView: PublicResearchView;
  ui: UiHints;
} {
  return {
    answerType: "clarification",
    answer: {
      headline: "I need one more detail.",
      summary: "What stock, sector, or market theme should I explain?",
      bullets: [],
      watchpoints: [],
      disclaimer: DEFAULT_DISCLAIMER,
    },
    researchView: EMPTY_PUBLIC_RESEARCH_VIEW,
    ui: { cards: [], tables: [], suggestedFollowups: [] },
  };
}

export function buildUnknownAnswer(): {
  answerType: AnswerType;
  answer: AnswerObject;
  researchView: PublicResearchView;
  ui: UiHints;
} {
  return {
    answerType: "unknown",
    answer: {
      headline: "Ask about a stock, sector, or market regime.",
      summary:
        "I can answer when the question is anchored to a ticker, a sector, or the current market setup.",
      bullets: [],
      watchpoints: [],
      disclaimer: DEFAULT_DISCLAIMER,
    },
    researchView: EMPTY_PUBLIC_RESEARCH_VIEW,
    ui: { cards: [], tables: [], suggestedFollowups: [] },
  };
}

export function generateAnswerObject(
  classification: Classification,
  researchView: PublicResearchView,
): { answerType: AnswerType; answer: AnswerObject; ui: UiHints } {
  const answerType = answerTypeForClassification(classification);

  // Stock / sector turns with a real Research Object → render the institutional
  // layout sourced from the rich publicSummary projection. Falls back to the
  // generic shape when no Research Object is present (snapshot-only path).
  const stockObject =
    answerType === "stock"
      ? researchView.researchObjects.find((item) => item.objectType === "stock")
      : undefined;
  if (stockObject) {
    return renderInstitutionalStockAnswer(researchView, stockObject);
  }
  const sectorObject =
    answerType === "sector"
      ? researchView.researchObjects.find((item) => item.objectType === "sector")
      : undefined;
  if (sectorObject) {
    return renderInstitutionalSectorAnswer(researchView, sectorObject.publicSummary);
  }
  const regimeObject =
    answerType === "regime"
      ? researchView.researchObjects.find((item) => item.objectType === "regime")
      : undefined;
  if (regimeObject) {
    return renderInstitutionalRegimeAnswer(researchView, regimeObject.publicSummary);
  }

  // Mixed turn (any combination of stock+sector+regime). Compose the
  // already-shipped institutional renderers so the user gets one unified
  // answer with labeled sections rather than the generic stub.
  if (answerType === "mixed") {
    const mixedStock = researchView.researchObjects.find((item) => item.objectType === "stock");
    const mixedSector = researchView.researchObjects.find((item) => item.objectType === "sector");
    const mixedRegime = researchView.researchObjects.find((item) => item.objectType === "regime");
    if (mixedStock || mixedSector || mixedRegime) {
      return renderInstitutionalMixedAnswer({
        researchView,
        stockObject: mixedStock,
        sectorSummary: mixedSector?.publicSummary,
        regimeSummary: mixedRegime?.publicSummary,
      });
    }
  }

  const headline = buildHeadline(classification, researchView);
  const bullets = buildBullets(researchView);
  const watchpoints = buildWatchpoints(researchView);

  return {
    answerType,
    answer: {
      headline,
      summary: buildSummary(classification, researchView),
      bullets,
      watchpoints,
      disclaimer: DEFAULT_DISCLAIMER,
    },
    ui: {
      cards: buildCards(researchView),
      tables: [],
      suggestedFollowups: DEFAULT_FOLLOWUPS,
    },
  };
}

function renderInstitutionalStockAnswer(
  researchView: PublicResearchView,
  stockObject: CachedResearchObject,
): { answerType: AnswerType; answer: AnswerObject; ui: UiHints } {
  const publicSummary = stockObject.publicSummary;
  const parts = stockObject.parts ?? {};
  const core = recordField(parts.core) ?? {};
  const fq = recordField(parts.financialQuality) ?? {};
  const sectorAggs = recordField(parts.sectorAggregates) ?? {};

  const symbol = stringField(publicSummary.symbol) ?? "Unknown";
  const company = stringField(publicSummary.company);
  const sector = stringField(publicSummary.sector);
  const regime = stringField(publicSummary.regime);
  const vixBand = stringField(publicSummary.vixBand);
  const regimeFit = stringField(publicSummary.regimeFit);
  const eventUrgency = stringField(publicSummary.eventUrgency);
  const signals = arrayOfRecords(publicSummary.activeSignals);
  const forward = recordField(publicSummary.forwardPerformance);
  const fundamentals = recordField(publicSummary.fundamentalsSnapshot);
  const events = arrayOfRecords(publicSummary.upcomingEvents);
  const invalidations = arrayOfStringsField(publicSummary.invalidationSignals);

  const valuation = recordField(core.company_state) && recordField(recordField(core.company_state)!.valuation);
  const profitability = recordField(core.company_state) && recordField(recordField(core.company_state)!.profitability);
  const balanceSheet = recordField(core.company_state) && recordField(recordField(core.company_state)!.balance_sheet);
  const trajectory = recordField(core.trajectory) ?? {};
  const trajectoryExt = recordField(fq.trajectory_extended) ?? {};
  const financialQuality = recordField(fq.financial_quality) ?? {};
  const growthCompound = recordField(fq.growth_compound) ?? {};
  const capitalAlloc = recordField(fq.capital_allocation) ?? {};
  const peerPerf = recordField(fq.peer_relative_perf) ?? {};
  const forwardCatalysts = recordField(fq.forward_catalysts) ?? {};
  const liquidityTier = recordField(fq.liquidity_tier) ?? {};
  const maActivity = recordField(fq.ma_activity) ?? {};
  const portfolio = recordField(sectorAggs.portfolio_context) ?? {};
  const portfolioComponents = recordField(portfolio.sector_rank_components) ?? {};
  const peers = arrayOfRecords(portfolio.better_state_peers_in_sector);
  const ownByRegime = arrayOfRecords(
    recordField(core.regime_context) ? recordField(core.regime_context)!.own_stock_by_regime : undefined,
  );

  const headline = company
    ? `${symbol} — ${company}${sector ? ` · ${sector}` : ""}`
    : `${symbol}${sector ? ` · ${sector}` : ""}`;

  // ── Summary (1-2 sentences, prose) ─────────────────────────────────────
  const summaryParts: string[] = [];
  if (regime) {
    const fitClause =
      regimeFit === "ALIGNED" ? "regime-aligned"
      : regimeFit === "CHALLENGED" ? "regime-challenged"
      : "regime-uncertain";
    const vixClause = vixBand ? ` with ${humanize(vixBand)} VIX` : "";
    summaryParts.push(`Backdrop is a ${regime} regime (${fitClause})${vixClause}.`);
  }
  // One-line opener: anchor key tension if any (rich valuation + accelerating
  // growth, deteriorating ROIC, narrowing beat, etc.).
  const tension = buildOpeningTension({
    valuationBucket: stringField(core.profile_keys && (core.profile_keys as Record<string, unknown>).valuation_bucket),
    revenueDir: stringField(trajectory.revenue_4q_vs_prior_4q),
    epsDir: stringField(trajectoryExt.eps_surprise_direction),
    fcfDir: stringField(growthCompound.fcf_growth_1y_band),
    roicDir: stringField(trajectoryExt.roic_direction),
    earningsWindow: stringField(forwardCatalysts.next_earnings_window),
  });
  if (tension) summaryParts.push(tension);
  if (researchView.warnings.length) {
    summaryParts.push("Some inputs are stale or missing — read with conservative confidence.");
  }
  const summary = summaryParts.join(" ");

  // ── Bullets ────────────────────────────────────────────────────────────
  const bullets: string[] = [];

  // Active signals
  if (signals.length) {
    bullets.push("**Active signals**");
    for (const sig of signals) {
      const family = stringField(sig.family) ?? "Signal";
      const strength = humanize(sig.signalStrength) ?? "moderate";
      const lang = stringField(sig.evidenceLanguage) ?? "Evidence available.";
      bullets.push(`- ${family} — ${strength}: ${lang}`);
    }
  }

  // Valuation
  if (valuation) {
    const peQuintile = humanize(valuation.pe_percentile_in_sector);
    const peVsHistory = humanize(valuation.pe_vs_own_10yr);
    const peg = humanize(valuation.peg_ttm_band);
    const valBucket = humanize(stringField((core.profile_keys as Record<string, unknown> | undefined)?.valuation_bucket));
    const valBits: string[] = [];
    if (peQuintile && sector) valBits.push(`P/E in the ${peQuintile} of ${sector}`);
    else if (peQuintile) valBits.push(`P/E in the ${peQuintile} of its sector`);
    if (peVsHistory) valBits.push(`P/E ${peVsHistory}`);
    if (peg) valBits.push(`PEG TTM ${peg}`);
    if (valBucket) valBits.push(`valuation bucket: ${valBucket}`);
    if (valBits.length) {
      bullets.push("**Valuation**");
      for (const bit of valBits) bullets.push(`- ${bit}`);
    }
  }

  // Quality & profitability
  if (profitability || balanceSheet) {
    bullets.push("**Quality & profitability**");
    if (profitability) {
      const piotroski = humanize(profitability.piotroski_band);
      const incomeQ = humanize(profitability.income_quality_band);
      const roeOwn = humanize(profitability.roe_vs_own_5y);
      const roeStability = humanize(profitability.roe_stability);
      const npm = humanize(profitability.net_margin_vs_own_5y);
      if (piotroski) bullets.push(`- Piotroski score: ${piotroski}`);
      if (incomeQ) bullets.push(`- Income quality: ${incomeQ}`);
      if (roeOwn) {
        const stability = roeStability ? ` (${roeStability})` : "";
        bullets.push(`- ROE ${roeOwn}${stability}`);
      }
      if (npm) bullets.push(`- Net margin ${npm}`);
    }
    if (balanceSheet) {
      const altman = humanize(balanceSheet.altman_z_band);
      const leverage = humanize(balanceSheet.leverage_band);
      const ic = humanize(balanceSheet.interest_coverage_band);
      const bsBits: string[] = [];
      if (leverage) bsBits.push(`leverage ${leverage}`);
      if (ic) bsBits.push(`interest coverage ${ic}`);
      if (altman) bsBits.push(`Altman-Z ${altman}`);
      if (bsBits.length) bullets.push(`- Balance sheet: ${bsBits.join(" · ")}`);
    }
  }

  // Cash conversion & investment
  if (Object.keys(financialQuality).length) {
    const cashBits: string[] = [];
    const fcfNi = humanize(financialQuality.fcf_to_ni_ratio_band);
    const fcfOcf = humanize(financialQuality.fcf_ocf_efficiency_band);
    const capex = humanize(financialQuality.capex_intensity_band);
    const ccc = humanize(financialQuality.cash_conversion_cycle_band);
    const sbc = humanize(financialQuality.sbc_to_revenue_band);
    if (fcfNi) cashBits.push(`FCF / net-income ratio: ${fcfNi}`);
    if (fcfOcf) cashBits.push(`FCF / OCF efficiency: ${fcfOcf}`);
    if (capex) cashBits.push(`capex intensity: ${capex}`);
    if (ccc) cashBits.push(`cash conversion cycle: ${ccc}`);
    if (sbc) cashBits.push(`SBC to revenue: ${sbc}`);
    if (cashBits.length) {
      bullets.push("**Cash conversion & investment**");
      for (const b of cashBits) bullets.push(`- ${b}`);
    }
  }

  // Growth (multi-period)
  if (Object.keys(growthCompound).length) {
    const rev1 = humanize(growthCompound.revenue_growth_1y_band);
    const eps1 = humanize(growthCompound.eps_growth_1y_band);
    const fcf1 = humanize(growthCompound.fcf_growth_1y_band);
    const rev3 = humanize(growthCompound.revenue_growth_3y_per_share_band);
    const rev5 = humanize(growthCompound.revenue_growth_5y_per_share_band);
    const shares = humanize(growthCompound.shares_growth_band);
    const debt = humanize(growthCompound.debt_growth_band);
    const growthBits: string[] = [];
    if (rev1) growthBits.push(`revenue ${rev1}`);
    if (eps1) growthBits.push(`EPS ${eps1}`);
    if (fcf1) growthBits.push(`FCF ${fcf1}`);
    if (growthBits.length) {
      bullets.push("**Growth**");
      bullets.push(`- 1Y: ${growthBits.join(" · ")}`);
    }
    if (rev3 || rev5) {
      const multi: string[] = [];
      if (rev3) multi.push(`3Y/share ${rev3}`);
      if (rev5) multi.push(`5Y/share ${rev5}`);
      bullets.push(`- Multi-year revenue: ${multi.join(" · ")}`);
    }
    if (shares) bullets.push(`- Share count: ${shares}`);
    if (debt) bullets.push(`- Debt: ${debt}`);
  }

  // Capital allocation
  if (Object.keys(capitalAlloc).length) {
    const buyback = humanize(capitalAlloc.buyback_activity);
    const buybackDir = humanize(capitalAlloc.buyback_direction);
    const div = humanize(capitalAlloc.dividend_activity);
    const divDir = humanize(capitalAlloc.dividend_direction);
    const debtDir = humanize(capitalAlloc.net_debt_direction);
    const totalReturn = humanize(capitalAlloc.total_return_to_shareholders_band);
    const allocBits: string[] = [];
    if (buyback && buyback !== "none") {
      const dirClause = buybackDir ? ` (${buybackDir})` : "";
      allocBits.push(`buybacks: ${buyback}${dirClause}`);
    } else if (buyback === "none") {
      allocBits.push("no active buybacks");
    }
    if (div && div !== "none") {
      const dirClause = divDir ? ` (${divDir})` : "";
      allocBits.push(`dividends: ${div}${dirClause}`);
    } else if (div === "none") {
      allocBits.push("no dividend");
    }
    if (debtDir) allocBits.push(`net debt ${debtDir}`);
    if (totalReturn) allocBits.push(`total return to shareholders: ${totalReturn}`);
    if (allocBits.length) {
      bullets.push("**Capital allocation**");
      for (const b of allocBits) bullets.push(`- ${b}`);
    }
  }

  // Peer rank in sector
  const composite = numberField(portfolio.composite_rank_in_sector);
  if (composite != null || peers.length) {
    bullets.push("**Sector rank**");
    if (composite != null) {
      bullets.push(`- Composite percentile in sector: ${composite.toFixed(0)}th`);
    }
    const components = pickTopBottomComponents(portfolioComponents);
    if (components.top.length) {
      bullets.push(`- Strongest dimensions: ${components.top.join(", ")}`);
    }
    if (components.bottom.length) {
      bullets.push(`- Weakest dimensions: ${components.bottom.join(", ")}`);
    }
    if (peers.length) {
      const names = peers
        .map((p) => stringField(p.symbol))
        .filter((s): s is string => !!s)
        .slice(0, 5);
      if (names.length) {
        bullets.push(`- Better-state peers in sector: ${names.join(", ")}`);
      }
    }
  }

  // Recent performance
  if (Object.keys(peerPerf).length) {
    const abs1y = humanize(peerPerf.absolute_perf_band_1y);
    const vsSpx4w = humanize(peerPerf.vs_spx_4w);
    const vsSpx12w = humanize(peerPerf.vs_spx_12w);
    const vsSec1m = humanize(peerPerf.vs_sector_1m);
    const vsSec3m = humanize(peerPerf.vs_sector_3m);
    const vsSec1y = humanize(peerPerf.vs_sector_1y);
    const perfBits: string[] = [];
    if (abs1y) perfBits.push(`absolute 1Y: ${abs1y}`);
    if (vsSpx4w || vsSpx12w) {
      const spx = [vsSpx4w && `4w ${vsSpx4w}`, vsSpx12w && `12w ${vsSpx12w}`].filter(Boolean).join(" · ");
      perfBits.push(`vs SPX: ${spx}`);
    }
    if (vsSec1m || vsSec3m || vsSec1y) {
      const sec = [
        vsSec1m && `1m ${vsSec1m}`,
        vsSec3m && `3m ${vsSec3m}`,
        vsSec1y && `1y ${vsSec1y}`,
      ].filter(Boolean).join(" · ");
      perfBits.push(`vs sector: ${sec}`);
    }
    if (perfBits.length) {
      bullets.push("**Recent performance**");
      for (const b of perfBits) bullets.push(`- ${b}`);
    }
  }

  // Regime conditioning (own history breakdown)
  if (ownByRegime.length) {
    bullets.push("**Regime conditioning** (own historical performance)");
    for (const row of ownByRegime) {
      const r = stringField(row.regime);
      const n = numberField(row.n);
      const hr = numberField(row.hit_rate_h60);
      if (!r) continue;
      const bucket = bucketHitRate(hr);
      const sample = n != null ? `${n} obs` : null;
      const hrLabel = bucket && hr != null ? `${bucket} (${hr.toFixed(0)}% 60d hit-rate)` : null;
      const isCurrent = regime && r === regime ? " — current" : "";
      const fragments = [hrLabel, sample].filter(Boolean).join(", ");
      bullets.push(`- ${r}${isCurrent}: ${fragments}`);
    }
  }

  // Forward setup (60-day analog)
  if (forward) {
    const wr = humanize(forward.forwardWrBucket);
    const outcome = humanize(forward.forwardOutcomeBucket);
    const sample = humanize(forward.sampleAdequacy);
    const horizon = stringField(forward.horizon) ?? "60-day";
    const fragments: string[] = [];
    if (sample) fragments.push(`sample ${sample}`);
    if (wr) fragments.push(`hit-rate ${wr}`);
    if (outcome) fragments.push(`outcome ${outcome}`);
    if (fragments.length) {
      bullets.push(`**Forward setup** (${horizon} historical analogs)`);
      bullets.push(`- ${fragments.join(" · ")}`);
    }
  }

  // Upcoming catalysts
  if (events.length || stringField(forwardCatalysts.recent_8k_density) || stringField(maActivity.acquisitions_band)) {
    bullets.push("**Upcoming catalysts**");
    for (const ev of events) {
      const type = stringField(ev.type) ?? "Event";
      const window = humanize(ev.windowBucket) ?? "scheduled";
      const niceType = type.toLowerCase().replace(/_/g, " ");
      bullets.push(`- ${niceType.charAt(0).toUpperCase()}${niceType.slice(1)} — ${window}`);
    }
    const eightK = humanize(forwardCatalysts.recent_8k_density);
    if (eightK && eightK !== "none in the last 90 days") {
      bullets.push(`- Recent 8-K filing density (90d): ${eightK}`);
    }
    const ma = humanize(maActivity.acquisitions_band);
    if (ma && ma !== "none") {
      bullets.push(`- Recent M&A activity: ${ma}`);
    }
  }

  // Liquidity (one line, optional)
  const flow = humanize(liquidityTier.flow_capacity);
  const mcap = humanize(liquidityTier.market_cap_tier ?? fundamentals?.marketCapTier);
  if (flow || mcap) {
    const liqBits: string[] = [];
    if (mcap) liqBits.push(mcap);
    if (flow) liqBits.push(`flow capacity ${flow}`);
    bullets.push(`**Liquidity** — ${liqBits.join(" · ")}`);
  }

  // ── Watchpoints ────────────────────────────────────────────────────────
  const watchpoints: string[] = [...invalidations];
  if (eventUrgency) {
    watchpoints.push(
      `Earnings ${humanize(eventUrgency) ?? eventUrgency.toLowerCase()} — outcome will materially update the setup.`,
    );
  }
  if (humanize(growthCompound.fcf_growth_1y_band) === "contracting" && humanize(growthCompound.eps_growth_1y_band)?.includes("strong")) {
    watchpoints.push("FCF growth is contracting while EPS is strong — gap between earnings quality and cash generation widening.");
  }
  if (humanize(trajectoryExt.roic_direction) === "deteriorating") {
    watchpoints.push("ROIC trend is deteriorating — capital efficiency under pressure.");
  }
  if (humanize(profitability?.income_quality_band) === "elevated") {
    watchpoints.push("Income quality band is elevated — accruals/non-cash items may be flattering reported earnings.");
  }
  if (humanize(profitability?.net_margin_vs_own_5y) === "unusually elevated (spike flag)") {
    watchpoints.push("Net margin is unusually high vs the 5-year history — verify it's structural, not one-off.");
  }
  if (researchView.freshness.stale && researchView.freshness.staleReason) {
    watchpoints.push(researchView.freshness.staleReason);
  }
  if (!watchpoints.length) {
    watchpoints.push("Watch whether next earnings confirm the same trajectory and quality picture.");
  }

  return {
    answerType: "stock",
    answer: {
      headline,
      summary,
      bullets: bullets.slice(0, 36),
      watchpoints: dedupe(watchpoints).slice(0, 6),
      disclaimer: DEFAULT_DISCLAIMER,
    },
    ui: {
      cards: buildInstitutionalCards(researchView, publicSummary),
      tables: [],
      suggestedFollowups: DEFAULT_FOLLOWUPS,
    },
  };
}

/** Build the one-sentence "tension" that goes in the summary — picks the
 * most informative crosscut for the headline ("rich valuation but
 * accelerating revenue", "EPS strong while FCF contracting", etc.). */
function buildOpeningTension(input: {
  valuationBucket?: string;
  revenueDir?: string;
  epsDir?: string;
  fcfDir?: string;
  roicDir?: string;
  earningsWindow?: string;
}): string | undefined {
  const valuation = humanize(input.valuationBucket);
  const revenue = humanize(input.revenueDir);
  const fcf = humanize(input.fcfDir);
  const roic = humanize(input.roicDir);
  const earnings = humanize(input.earningsWindow);

  const fragments: string[] = [];
  if (revenue && (revenue === "accelerating" || revenue === "growing")) {
    fragments.push(`Revenue is ${revenue}`);
  } else if (revenue === "declining" || revenue === "flat") {
    fragments.push(`Revenue is ${revenue}`);
  }
  if (fcf === "contracting") {
    fragments.push("but FCF growth is contracting");
  }
  if (roic === "deteriorating" && !fcf) {
    fragments.push("with ROIC deteriorating");
  }
  if (valuation === "rich" || valuation === "expensive") {
    fragments.push(`while trading ${valuation}`);
  }
  if (fragments.length === 0) return undefined;
  let sentence = fragments.join(" ").replace(/^[a-z]/, (c) => c.toUpperCase());
  if (!sentence.endsWith(".")) sentence += ".";
  if (earnings && earnings !== "none scheduled") {
    sentence += ` Earnings ${earnings} will be a near-term catalyst.`;
  }
  return sentence;
}

/** Pick the strongest 2 and weakest 1 component percentiles from the
 * portfolio.sector_rank_components map, formatted for prose. */
function pickTopBottomComponents(
  components: Record<string, unknown>,
): { top: string[]; bottom: string[] } {
  const labels: Record<string, string> = {
    npm_pct: "net margin",
    roe_pct: "return on equity",
    fcf_yield_pct: "FCF yield",
    rev_growth_pct: "revenue growth",
    low_leverage_pct: "low leverage",
  };
  const rows: Array<{ key: string; label: string; pct: number }> = [];
  for (const [key, value] of Object.entries(components)) {
    if (!labels[key]) continue;
    const n = numberField(value);
    if (n == null) continue;
    rows.push({ key, label: labels[key], pct: n });
  }
  if (rows.length === 0) return { top: [], bottom: [] };
  const sorted = [...rows].sort((a, b) => b.pct - a.pct);
  const top = sorted.slice(0, 2).map((r) => `${r.label} (${r.pct.toFixed(0)}th pct)`);
  const lowest = sorted[sorted.length - 1];
  const bottom = lowest && lowest.pct < 50
    ? [`${lowest.label} (${lowest.pct.toFixed(0)}th pct)`]
    : [];
  return { top, bottom };
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    if (!seen.has(it)) {
      seen.add(it);
      out.push(it);
    }
  }
  return out;
}

function renderInstitutionalSectorAnswer(
  researchView: PublicResearchView,
  publicSummary: Record<string, unknown>,
): { answerType: AnswerType; answer: AnswerObject; ui: UiHints } {
  const sector = stringField(publicSummary.sector) ?? "Sector";
  const regime = stringField(publicSummary.regime);
  const vixBand = stringField(publicSummary.vixBand);
  const sp500PerfBand = stringField(publicSummary.sp500PerfBand);
  const symbolsCovered = numberField(publicSummary.symbolsCovered);
  const industries = numberField(publicSummary.industries);
  const leaderCount = numberField(publicSummary.leaderCount);
  const laggardCount = numberField(publicSummary.laggardCount);
  const sampleAdequacy = stringField(publicSummary.sampleAdequacy);
  const baseHitBucket = stringField(publicSummary.unconditionalHitRateBucket);
  const baseOutcomeBucket = stringField(publicSummary.unconditionalOutcomeBucket);
  const bestRegime = stringField(publicSummary.bestRegimeForSector);
  const bestBucket = stringField(publicSummary.bestRegimeBucket);
  const currentRegimeBucket = stringField(publicSummary.currentRegimeBucket);
  const currentBelowBest = publicSummary.currentRegimeBelowBest === true;
  const favorable = arrayOfStringsField(publicSummary.favorableConditions);
  const unfavorable = arrayOfStringsField(publicSummary.unfavorableConditions);
  const whyNow = stringField(publicSummary.whyNow);

  const headline = `${sector} — Sector context`;

  const summaryParts: string[] = [];
  if (regime) {
    const fragments = [`Backdrop: ${regime} regime`];
    if (vixBand) fragments.push(`${humanize(vixBand) ?? vixBand} VIX`);
    if (sp500PerfBand) fragments.push(`SPX 4w ${humanize(sp500PerfBand) ?? sp500PerfBand}`);
    summaryParts.push(fragments.join(" · ") + ".");
  }
  if (whyNow) summaryParts.push(whyNow);
  if (symbolsCovered != null && symbolsCovered > 0) {
    const industriesStr = industries != null ? ` across ${industries} industries` : "";
    summaryParts.push(`${symbolsCovered} symbols covered${industriesStr}.`);
  }
  const summary = summaryParts.join(" ");

  const bullets: string[] = [];

  if (baseHitBucket || baseOutcomeBucket || sampleAdequacy) {
    bullets.push("**Historical baseline** (unconditional, 60-day forward)");
    const fragments = [
      sampleAdequacy ? `sample ${humanize(sampleAdequacy) ?? sampleAdequacy}` : undefined,
      baseHitBucket ? `hit-rate ${humanize(baseHitBucket) ?? baseHitBucket}` : undefined,
      baseOutcomeBucket ? `outcome ${humanize(baseOutcomeBucket) ?? baseOutcomeBucket}` : undefined,
    ].filter(Boolean);
    if (fragments.length) bullets.push(`- ${fragments.join(" · ")}`);
  }

  if (bestRegime || currentRegimeBucket) {
    bullets.push("**Regime conditioning**");
    if (bestRegime && bestBucket) {
      bullets.push(`- Most favorable historical regime: ${bestRegime} (hit-rate ${humanize(bestBucket) ?? bestBucket})`);
    }
    if (regime && currentRegimeBucket) {
      bullets.push(`- Current ${regime} regime hit-rate: ${humanize(currentRegimeBucket) ?? currentRegimeBucket}`);
    }
  }

  if (favorable.length) {
    bullets.push("**Conditions historically favoring this sector**");
    for (const cond of favorable) bullets.push(`• ${cond}`);
  }

  if (leaderCount != null && leaderCount > 0) {
    const laggardClause =
      laggardCount != null && laggardCount > 0 ? `, ${laggardCount} laggards` : "";
    bullets.push("**Breadth**");
    bullets.push(
      `• ${leaderCount} top-quartile composite leaders${laggardClause} (names not surfaced).`,
    );
  }

  const watchpoints: string[] = [];
  if (currentBelowBest && bestRegime && regime && bestRegime !== regime) {
    watchpoints.push(
      `Current ${regime} hit-rate is below the sector's ${bestRegime} history — regime sensitivity is meaningful here.`,
    );
  }
  if (sp500PerfBand === "STRONG_RALLY") {
    watchpoints.push(
      "S&P 500 4-week move is bucketed STRONG_RALLY — late-cycle momentum can compress mean-reversion edges.",
    );
  }
  for (const cond of unfavorable.slice(0, 2)) {
    watchpoints.push(`Historically unfavorable backdrop for this sector: ${cond}.`);
  }
  if (researchView.freshness.stale && researchView.freshness.staleReason) {
    watchpoints.push(researchView.freshness.staleReason);
  }
  if (!watchpoints.length) {
    watchpoints.push("Watch whether fresh snapshots confirm the same regime and breadth picture.");
  }

  return {
    answerType: "sector",
    answer: {
      headline,
      summary: summary || `${sector} sector context.`,
      bullets: bullets.slice(0, 24),
      watchpoints: watchpoints.slice(0, 6),
      disclaimer: DEFAULT_DISCLAIMER,
    },
    ui: {
      cards: [
        researchView.marketContext.regime
          ? {
              type: "market_regime",
              title: "Market Regime",
              value: researchView.marketContext.regime,
              vixBand,
              sp500PerfBand,
            }
          : undefined,
        {
          type: "sector_summary",
          sector,
          regime,
          symbolsCovered,
          industries,
          unconditionalHitRateBucket: baseHitBucket,
          unconditionalOutcomeBucket: baseOutcomeBucket,
          bestRegimeForSector: bestRegime,
          bestRegimeBucket: bestBucket,
          currentRegimeBucket,
          favorableConditions: favorable,
          unfavorableConditions: unfavorable,
        },
      ].filter(Boolean),
      tables: [],
      suggestedFollowups: DEFAULT_FOLLOWUPS,
    },
  };
}

function renderInstitutionalRegimeAnswer(
  researchView: PublicResearchView,
  publicSummary: Record<string, unknown>,
): { answerType: AnswerType; answer: AnswerObject; ui: UiHints } {
  const regime = stringField(publicSummary.regime) ?? "Unknown";
  const isCurrent = publicSummary.isCurrentRegime === true;
  const vixBand = stringField(publicSummary.vixBand);
  const sp500PerfBand = stringField(publicSummary.sp500PerfBand);
  const tenYearYieldBand = stringField(publicSummary.tenYearYieldBand);
  const sample = stringField(publicSummary.sampleAdequacy);
  const hitBucket = stringField(publicSummary.unconditionalHitRateBucket);
  const outcomeBucket = stringField(publicSummary.unconditionalOutcomeBucket);
  const longHitBucket = stringField(publicSummary.longHorizonHitRateBucket);
  const topHistorical = arrayOfRecords(publicSummary.topSectorsHistorical);
  const bottomHistorical = arrayOfRecords(publicSummary.bottomSectorsHistorical);
  const sectorsActiveToday = numberField(publicSummary.sectorsActiveToday);
  const topSectorsTodayRank = arrayOfStringsField(publicSummary.topSectorsTodayRank);
  const leaderCount = numberField(publicSummary.leaderCount);
  const whyNow = stringField(publicSummary.whyNow);

  const headline = isCurrent
    ? `Market regime: ${regime} (current)`
    : `Market regime context: ${regime}`;

  const summaryParts: string[] = [];
  if (whyNow) summaryParts.push(whyNow);
  const backdrop: string[] = [];
  if (vixBand) backdrop.push(`${vixBand} VIX`);
  if (sp500PerfBand) backdrop.push(`SPX 4w ${sp500PerfBand.toLowerCase().replace(/_/g, " ")}`);
  if (tenYearYieldBand) backdrop.push(`10y yield ${tenYearYieldBand}`);
  if (backdrop.length) summaryParts.push(`Backdrop: ${backdrop.join(" · ")}.`);
  const summary = summaryParts.join(" ");

  const bullets: string[] = [];

  if (sample || hitBucket || outcomeBucket || longHitBucket) {
    bullets.push(`**Historical baseline** under ${regime} regime`);
    const fragments = [
      sample ? `sample ${humanize(sample) ?? sample}` : undefined,
      hitBucket ? `60d hit-rate ${humanize(hitBucket) ?? hitBucket}` : undefined,
      outcomeBucket ? `60d outcome ${humanize(outcomeBucket) ?? outcomeBucket}` : undefined,
      longHitBucket ? `12m hit-rate ${humanize(longHitBucket) ?? longHitBucket}` : undefined,
    ].filter(Boolean);
    if (fragments.length) bullets.push(`- ${fragments.join(" · ")}`);
  }

  if (topHistorical.length) {
    bullets.push(`**Sectors that historically work in ${regime}**`);
    for (const row of topHistorical) {
      const sector = stringField(row.sector);
      const bucket = stringField(row.bucket);
      if (sector) bullets.push(`- ${sector} — hit-rate ${humanize(bucket) ?? "mixed"}`);
    }
  }

  if (bottomHistorical.length) {
    bullets.push(`**Sectors that historically struggle in ${regime}**`);
    for (const row of bottomHistorical) {
      const sector = stringField(row.sector);
      const bucket = stringField(row.bucket);
      if (sector) bullets.push(`- ${sector} — hit-rate ${humanize(bucket) ?? "weak"}`);
    }
  }

  if (topSectorsTodayRank.length || sectorsActiveToday != null) {
    bullets.push("**Today's snapshot**");
    if (sectorsActiveToday != null) {
      bullets.push(`• ${sectorsActiveToday} sectors active`);
    }
    if (topSectorsTodayRank.length) {
      bullets.push(`• Leading sectors today: ${topSectorsTodayRank.join(", ")}`);
    }
    if (leaderCount != null && leaderCount > 0) {
      bullets.push(`• ${leaderCount} top-percentile composite leaders (names not surfaced).`);
    }
  }

  const watchpoints: string[] = [];
  if (sp500PerfBand === "STRONG_RALLY" && hitBucket === "MIXED") {
    watchpoints.push(
      "SPX 4-week move is bucketed STRONG_RALLY while regime baseline hit-rate is only MIXED — momentum may be running ahead of the regime's historical edge.",
    );
  }
  if (vixBand === "LOW" && (regime === "RISK_OFF" || regime === "NEUTRAL")) {
    watchpoints.push(
      "Low VIX in a non-risk-on regime can compress upside but raises tail-event risk if regime flips.",
    );
  }
  if (tenYearYieldBand === "ELEVATED" || tenYearYieldBand === "HIGH") {
    watchpoints.push(
      `Elevated 10-year yield is a structural drag — duration-sensitive sectors face headwinds in ${regime}.`,
    );
  }
  if (researchView.freshness.stale && researchView.freshness.staleReason) {
    watchpoints.push(researchView.freshness.staleReason);
  }
  if (!watchpoints.length) {
    watchpoints.push("Watch whether fresh snapshots confirm the same regime classification.");
  }

  return {
    answerType: "regime",
    answer: {
      headline,
      summary: summary || `${regime} regime context.`,
      bullets: bullets.slice(0, 24),
      watchpoints: watchpoints.slice(0, 6),
      disclaimer: DEFAULT_DISCLAIMER,
    },
    ui: {
      cards: [
        {
          type: "market_regime",
          title: "Market Regime",
          value: regime,
          isCurrent,
          vixBand,
          sp500PerfBand,
          tenYearYieldBand,
        },
        {
          type: "regime_summary",
          regime,
          unconditionalHitRateBucket: hitBucket,
          unconditionalOutcomeBucket: outcomeBucket,
          longHorizonHitRateBucket: longHitBucket,
          topSectorsHistorical: topHistorical,
          bottomSectorsHistorical: bottomHistorical,
          topSectorsTodayRank,
          sectorsActiveToday,
        },
      ],
      tables: [],
      suggestedFollowups: DEFAULT_FOLLOWUPS,
    },
  };
}

function renderInstitutionalMixedAnswer(input: {
  researchView: PublicResearchView;
  stockObject?: CachedResearchObject;
  sectorSummary?: Record<string, unknown>;
  regimeSummary?: Record<string, unknown>;
}): { answerType: AnswerType; answer: AnswerObject; ui: UiHints } {
  const { researchView, stockObject, sectorSummary, regimeSummary } = input;
  const stockSummary = stockObject?.publicSummary;

  const stockBlock = stockObject
    ? renderInstitutionalStockAnswer(researchView, stockObject)
    : undefined;
  const sectorBlock = sectorSummary
    ? renderInstitutionalSectorAnswer(researchView, sectorSummary)
    : undefined;
  const regimeBlock = regimeSummary
    ? renderInstitutionalRegimeAnswer(researchView, regimeSummary)
    : undefined;

  // Compact headline: anchor identifiers only, not the full per-section ones.
  const headlineParts: string[] = [];
  if (stockSummary) {
    const sym = stringField(stockSummary.symbol);
    const company = stringField(stockSummary.company);
    if (sym) headlineParts.push(company ? `${sym} (${company})` : sym);
  }
  if (sectorSummary) {
    const sec = stringField(sectorSummary.sector);
    if (sec) headlineParts.push(sec);
  }
  if (regimeSummary) {
    const reg = stringField(regimeSummary.regime);
    if (reg) headlineParts.push(`${reg} regime`);
  }
  const headline = headlineParts.join(" · ") || "Cross-anchor research";

  // Lead summary: stock-first when present (deepest content), then sector,
  // then regime. We use just one block's summary line — the section bullets
  // below carry the rest. Keeps the top-of-answer scannable.
  const summary = stockBlock?.answer.summary
    ?? sectorBlock?.answer.summary
    ?? regimeBlock?.answer.summary
    ?? "";

  const bullets: string[] = [];
  if (stockBlock) {
    const sym = stringField(stockSummary?.symbol) ?? "Stock";
    bullets.push(`### Stock — ${sym}`);
    bullets.push(...stockBlock.answer.bullets);
  }
  if (sectorBlock) {
    const sec = stringField(sectorSummary?.sector) ?? "Sector";
    bullets.push(`### Sector — ${sec}`);
    // Trim sector section when it's the secondary anchor — keep the top-of-
    // section header bullets, drop the breadth section if stock is the lead.
    const secBullets = stockBlock
      ? sectorBlock.answer.bullets.slice(0, 8)
      : sectorBlock.answer.bullets;
    bullets.push(...secBullets);
  }
  if (regimeBlock) {
    const reg = stringField(regimeSummary?.regime) ?? "Regime";
    bullets.push(`### Regime — ${reg}`);
    const regBullets = stockBlock || sectorBlock
      ? regimeBlock.answer.bullets.slice(0, 8)
      : regimeBlock.answer.bullets;
    bullets.push(...regBullets);
  }

  // Watchpoints — unique, in priority order (stock invalidations first since
  // they're most actionable when a specific symbol is in scope).
  const seen = new Set<string>();
  const watchpoints: string[] = [];
  for (const block of [stockBlock, sectorBlock, regimeBlock]) {
    if (!block) continue;
    for (const wp of block.answer.watchpoints) {
      if (!seen.has(wp)) {
        seen.add(wp);
        watchpoints.push(wp);
      }
    }
  }
  if (researchView.freshness.stale && researchView.freshness.staleReason && !seen.has(researchView.freshness.staleReason)) {
    watchpoints.push(researchView.freshness.staleReason);
  }
  if (!watchpoints.length) {
    watchpoints.push("Watch whether fresh snapshots confirm the same anchors and regime backdrop.");
  }

  // Combine UI cards in the same order — the FE can render each section card.
  const cards: unknown[] = [];
  for (const block of [stockBlock, sectorBlock, regimeBlock]) {
    if (block) cards.push(...(block.ui.cards ?? []));
  }

  return {
    answerType: "mixed",
    answer: {
      headline,
      summary,
      bullets: bullets.slice(0, 36),
      watchpoints: watchpoints.slice(0, 6),
      disclaimer: DEFAULT_DISCLAIMER,
    },
    ui: {
      cards,
      tables: [],
      suggestedFollowups: DEFAULT_FOLLOWUPS,
    },
  };
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildInstitutionalCards(
  researchView: PublicResearchView,
  publicSummary: Record<string, unknown>,
): unknown[] {
  const cards: unknown[] = [];
  if (researchView.marketContext.regime) {
    cards.push({
      type: "market_regime",
      title: "Market Regime",
      value: researchView.marketContext.regime,
      regimeFit: stringField(publicSummary.regimeFit),
      vixBand: stringField(publicSummary.vixBand),
    });
  }
  cards.push({
    type: "stock_summary",
    symbol: stringField(publicSummary.symbol),
    company: stringField(publicSummary.company),
    sector: stringField(publicSummary.sector),
    activeSignals: arrayOfRecords(publicSummary.activeSignals),
    forwardPerformance: recordField(publicSummary.forwardPerformance),
    fundamentalsSnapshot: recordField(publicSummary.fundamentalsSnapshot),
    upcomingEvents: arrayOfRecords(publicSummary.upcomingEvents),
  });
  return cards;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

function recordField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
    : [];
}

function arrayOfStringsField(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function buildSafeErrorAnswer(): AnswerObject {
  return {
    headline: "Ask Grahamy is temporarily unavailable.",
    summary:
      "The request could not be completed safely. Please try again, or ask a narrower stock, sector, or regime question.",
    bullets: [],
    watchpoints: ["If this continues, check snapshot freshness and schedassistant upstream connectivity."],
    disclaimer: DEFAULT_DISCLAIMER,
  };
}

function answerTypeForClassification(classification: Classification): AnswerType {
  const hasStock = classification.symbols.length > 0;
  const hasSector = classification.sectors.length > 0;
  if (classification.intent === "unknown") return "unknown";
  if (hasStock && !hasSector && !classification.regimeRequested) return "stock";
  if (hasSector && !hasStock && !classification.regimeRequested) return "sector";
  if (classification.regimeRequested && !hasStock && !hasSector) return "regime";
  return "mixed";
}

function buildHeadline(classification: Classification, researchView: PublicResearchView): string {
  if (classification.symbols.length) {
    return researchView.researchObjects.some((item) => item.objectType === "stock")
      ? `${classification.symbols.join(", ")} Research Object`
      : `${classification.symbols.join(", ")} in published Grahamy context`;
  }
  if (classification.sectors.length) {
    return `${classification.sectors.join(", ")} sector context`;
  }
  if (classification.regimeRequested) {
    return `Market regime: ${researchView.marketContext.regime ?? "not available"}`;
  }
  return "Published Grahamy context";
}

function buildSummary(classification: Classification, researchView: PublicResearchView): string {
  const parts: string[] = [];
  const market = researchView.marketContext;
  if (market.regime) {
    parts.push(`The current published regime is ${market.regime}.`);
  }
  if (market.forwardWinRateBucket) {
    parts.push(`Forward tracking is currently ${market.forwardWinRateBucket}.`);
  }
  if (classification.symbols.length && researchView.stockContext.symbols.length) {
    const symbols = researchView.stockContext.symbols.map((item) => item.symbol).join(", ");
    parts.push(
      researchView.researchObjects.some((item) => item.objectType === "stock")
        ? `${symbols} has a current public Research Object available.`
        : `${symbols} has published snapshot context available.`,
    );
  }
  if (classification.sectors.length && researchView.sectorContext.sectors.length) {
    const sectors = researchView.sectorContext.sectors.map((item) => item.sector).join(", ");
    parts.push(`${sectors} has sector-level focus in the published snapshots.`);
  }
  if (researchView.warnings.length) {
    parts.push("Some data is missing or stale, so confidence should be treated conservatively.");
  }
  return parts.join(" ") || "The published snapshots do not contain enough context for a specific view.";
}

function buildBullets(researchView: PublicResearchView): string[] {
  const bullets: string[] = [];
  const market = researchView.marketContext;
  if (market.activeEdges != null) {
    bullets.push(`Published active edge count: ${market.activeEdges}.`);
  }
  if (market.stocksWithConvergence != null) {
    bullets.push(`${market.stocksWithConvergence} stocks currently show convergence in the published daily brief.`);
  }
  for (const stock of researchView.stockContext.symbols) {
    const details = [
      stock.company ? `${stock.symbol} (${stock.company})` : stock.symbol,
      stock.sector ? `sector: ${stock.sector}` : undefined,
      stock.confluenceLevel ? `confluence: ${stock.confluenceLevel}` : undefined,
      stock.completedWinRateBucket ? `completed signal bucket: ${stock.completedWinRateBucket}` : undefined,
    ].filter(Boolean);
    bullets.push(details.join(" · "));
  }
  for (const sector of researchView.sectorContext.sectors) {
    bullets.push(
      `${sector.sector}: ${sector.stocksInFocus} stocks in focus${
        sector.exampleSymbols.length ? ` (${sector.exampleSymbols.join(", ")})` : ""
      }.`,
    );
  }
  return bullets.slice(0, 8);
}

function buildWatchpoints(researchView: PublicResearchView): string[] {
  const watchpoints: string[] = [];
  if (researchView.freshness.stale) {
    watchpoints.push(researchView.freshness.staleReason ?? "Snapshot freshness is stale or incomplete.");
  }
  if (researchView.stockContext.missingSymbols.length) {
    watchpoints.push(`No stock snapshot context for ${researchView.stockContext.missingSymbols.join(", ")}.`);
  }
  if (researchView.sectorContext.missingSectors.length) {
    watchpoints.push(`No sector snapshot context for ${researchView.sectorContext.missingSectors.join(", ")}.`);
  }
  if (!watchpoints.length) {
    watchpoints.push("Watch whether fresh snapshots confirm the same regime and focus list.");
  }
  return watchpoints.slice(0, 6);
}

function buildCards(researchView: PublicResearchView): unknown[] {
  const cards: unknown[] = [];
  if (researchView.marketContext.regime) {
    cards.push({
      type: "market_regime",
      title: "Market Regime",
      value: researchView.marketContext.regime,
    });
  }
  for (const stock of researchView.stockContext.symbols) {
    cards.push({
      type: "stock",
      symbol: stock.symbol,
      title: stock.company ?? stock.symbol,
      subtitle: stock.sector,
    });
  }
  return cards;
}
