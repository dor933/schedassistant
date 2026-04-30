import {
  DEFAULT_DISCLAIMER,
  EMPTY_PUBLIC_RESEARCH_VIEW,
  type AnswerObject,
  type AnswerType,
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
    return renderInstitutionalStockAnswer(researchView, stockObject.publicSummary);
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
        stockSummary: mixedStock?.publicSummary,
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
  publicSummary: Record<string, unknown>,
): { answerType: AnswerType; answer: AnswerObject; ui: UiHints } {
  const symbol = stringField(publicSummary.symbol) ?? "Unknown";
  const company = stringField(publicSummary.company);
  const sector = stringField(publicSummary.sector);
  const regime = stringField(publicSummary.regime);
  const vixBand = stringField(publicSummary.vixBand);
  const regimeFit = stringField(publicSummary.regimeFit);
  const eventUrgency = stringField(publicSummary.eventUrgency);
  const whyNow = stringField(publicSummary.whyNow);
  const signals = arrayOfRecords(publicSummary.activeSignals);
  const forward = recordField(publicSummary.forwardPerformance);
  const fundamentals = recordField(publicSummary.fundamentalsSnapshot);
  const events = arrayOfRecords(publicSummary.upcomingEvents);
  const invalidations = arrayOfStringsField(publicSummary.invalidationSignals);

  const headline = company
    ? `${symbol} — ${company}${sector ? ` · ${sector}` : ""}`
    : `${symbol}${sector ? ` · ${sector}` : ""}`;

  const summaryParts: string[] = [];
  if (regime) {
    const fitClause =
      regimeFit === "ALIGNED"
        ? "regime-aligned"
        : regimeFit === "CHALLENGED"
        ? "regime-challenged"
        : "regime-neutral";
    summaryParts.push(
      `Regime: ${regime} (${fitClause}${vixBand ? ` · ${vixBand} VIX band` : ""}).`,
    );
  }
  if (whyNow) summaryParts.push(whyNow);
  if (researchView.warnings.length) {
    summaryParts.push("Some inputs are stale or missing — read with conservative confidence.");
  }
  const summary = summaryParts.join(" ");

  const bullets: string[] = [];

  if (signals.length) {
    bullets.push("**Active signals**");
    for (const sig of signals) {
      const family = stringField(sig.family) ?? "Signal";
      const strength = stringField(sig.signalStrength) ?? "MODERATE";
      const lang = stringField(sig.evidenceLanguage) ?? "Evidence available.";
      bullets.push(`• ${family} — ${strength}: ${lang}`);
    }
  }

  if (forward) {
    const wr = stringField(forward.forwardWrBucket);
    const outcome = stringField(forward.forwardOutcomeBucket);
    const sample = stringField(forward.sampleAdequacy);
    const horizon = stringField(forward.horizon) ?? "60-day";
    const fragments: string[] = [];
    if (sample) fragments.push(`sample ${sample}`);
    if (wr) fragments.push(`hit-rate bucket ${wr}`);
    if (outcome) fragments.push(`outcome bucket ${outcome}`);
    if (fragments.length) {
      bullets.push(`**Forward performance** (${horizon}, historically supported)`);
      bullets.push(`• ${fragments.join(" · ")}`);
    }
  }

  if (fundamentals) {
    const fundamentalFragments = [
      stringField(fundamentals.marketCapTier)
        ? `market-cap ${stringField(fundamentals.marketCapTier)}`
        : undefined,
      stringField(fundamentals.growthProfile)
        ? `growth ${stringField(fundamentals.growthProfile)}`
        : undefined,
      stringField(fundamentals.financialQualityBand)
        ? `quality ${stringField(fundamentals.financialQualityBand)}`
        : undefined,
      stringField(fundamentals.balanceSheetBand)
        ? `balance-sheet ${stringField(fundamentals.balanceSheetBand)}`
        : undefined,
      stringField(fundamentals.peerRankPercentile)
        ? `peer rank ${stringField(fundamentals.peerRankPercentile)}`
        : undefined,
    ].filter(Boolean) as string[];
    if (fundamentalFragments.length) {
      bullets.push("**Fundamentals snapshot**");
      bullets.push(`• ${fundamentalFragments.join(" · ")}`);
    }
  }

  if (events.length) {
    bullets.push("**Upcoming catalysts**");
    for (const ev of events) {
      const type = stringField(ev.type) ?? "EVENT";
      const window = stringField(ev.windowBucket) ?? "TBD";
      bullets.push(`• ${type} — ${window.toLowerCase().replace(/_/g, " ")}`);
    }
  }

  const watchpoints: string[] = [...invalidations];
  if (researchView.freshness.stale && researchView.freshness.staleReason) {
    watchpoints.push(researchView.freshness.staleReason);
  }
  if (eventUrgency && watchpoints.length === 0) {
    watchpoints.push(
      `Earnings ${eventUrgency.toLowerCase().replace(/_/g, " ")} — outcome will materially update the setup.`,
    );
  }

  return {
    answerType: "stock",
    answer: {
      headline,
      summary,
      bullets: bullets.slice(0, 24),
      watchpoints: watchpoints.slice(0, 6),
      disclaimer: DEFAULT_DISCLAIMER,
    },
    ui: {
      cards: buildInstitutionalCards(researchView, publicSummary),
      tables: [],
      suggestedFollowups: DEFAULT_FOLLOWUPS,
    },
  };
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
    if (vixBand) fragments.push(`${vixBand} VIX`);
    if (sp500PerfBand) fragments.push(`SPX 4w ${sp500PerfBand.toLowerCase().replace(/_/g, " ")}`);
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
      sampleAdequacy ? `sample ${sampleAdequacy}` : undefined,
      baseHitBucket ? `hit-rate bucket ${baseHitBucket}` : undefined,
      baseOutcomeBucket ? `outcome bucket ${baseOutcomeBucket}` : undefined,
    ].filter(Boolean);
    if (fragments.length) bullets.push(`• ${fragments.join(" · ")}`);
  }

  if (bestRegime || currentRegimeBucket) {
    bullets.push("**Regime conditioning**");
    if (bestRegime && bestBucket) {
      bullets.push(`• Most favorable historical regime: ${bestRegime} (hit-rate bucket ${bestBucket})`);
    }
    if (regime && currentRegimeBucket) {
      bullets.push(`• Current regime ${regime} hit-rate bucket: ${currentRegimeBucket}`);
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
      sample ? `sample ${sample}` : undefined,
      hitBucket ? `60d hit-rate bucket ${hitBucket}` : undefined,
      outcomeBucket ? `60d outcome bucket ${outcomeBucket}` : undefined,
      longHitBucket ? `12m hit-rate bucket ${longHitBucket}` : undefined,
    ].filter(Boolean);
    if (fragments.length) bullets.push(`• ${fragments.join(" · ")}`);
  }

  if (topHistorical.length) {
    bullets.push(`**Sectors that historically work in ${regime}**`);
    for (const row of topHistorical) {
      const sector = stringField(row.sector);
      const bucket = stringField(row.bucket);
      if (sector) bullets.push(`• ${sector} — hit-rate bucket ${bucket ?? "MIXED"}`);
    }
  }

  if (bottomHistorical.length) {
    bullets.push(`**Sectors that historically struggle in ${regime}**`);
    for (const row of bottomHistorical) {
      const sector = stringField(row.sector);
      const bucket = stringField(row.bucket);
      if (sector) bullets.push(`• ${sector} — hit-rate bucket ${bucket ?? "WEAK"}`);
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
  stockSummary?: Record<string, unknown>;
  sectorSummary?: Record<string, unknown>;
  regimeSummary?: Record<string, unknown>;
}): { answerType: AnswerType; answer: AnswerObject; ui: UiHints } {
  const { researchView, stockSummary, sectorSummary, regimeSummary } = input;

  const stockBlock = stockSummary
    ? renderInstitutionalStockAnswer(researchView, stockSummary)
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
