import {
  loadCanonicalSectors,
  loadIndustriesBySector,
} from "./classification";
import {
  DEFAULT_DISCLAIMER,
  type AnswerObject,
  type HelpTopic,
  type UiHints,
} from "./types";

/**
 * Renders deterministic help-topic answers. Skips the deep agent entirely —
 * these turns answer from server-side data (canonical sectors / industries
 * tables) plus a curated capability inventory. Output shape mirrors the
 * normal answer path so finalizeResponse and SS persistence stay uniform.
 */

export type HelpAnswerResult = {
  answer: AnswerObject;
  ui: UiHints;
  warnings: string[];
};

const HELP_TOPIC_FOLLOWUPS: Record<HelpTopic, string[]> = {
  sectors: [
    "What industries are available?",
    "Which sectors are leading right now?",
    "What can you analyze about a stock?",
  ],
  industries: [
    "Which sectors do you cover?",
    "What can you analyze about a stock?",
    "How does Ask Grahamy work?",
  ],
  capabilities: [
    "Which sectors do you cover?",
    "What industries are available?",
    "How does Ask Grahamy work?",
  ],
  overview: [
    "What can you analyze about a stock?",
    "Which sectors do you cover?",
    "What industries are available?",
  ],
};

/**
 * Generic help-topic suggestions surfaced on `unknown`-intent turns so the
 * user has a clear next step instead of just a "couldn't classify" warning.
 */
export function genericHelpFollowUps(): string[] {
  return [
    "Which sectors do you cover?",
    "What industries are available?",
    "What can you analyze about a stock?",
    "How does Ask Grahamy work?",
  ];
}

export async function buildHelpAnswer(
  topic: HelpTopic,
  message: string,
): Promise<HelpAnswerResult> {
  const hebrew = /[֐-׿]/.test(message);
  switch (topic) {
    case "sectors":
      return await buildSectorsHelp(hebrew);
    case "industries":
      return await buildIndustriesHelp(hebrew);
    case "capabilities":
      return buildCapabilitiesHelp(hebrew);
    case "overview":
      return buildOverviewHelp(hebrew);
  }
}

async function buildSectorsHelp(hebrew: boolean): Promise<HelpAnswerResult> {
  const sectors = await loadCanonicalSectors();
  const summary = hebrew
    ? `אנחנו מכסים ${sectors.length} סקטורים קנוניים. ניתן לשאול שאלות סקטור־ספציפיות, להשוות סקטורים, או לבקש את המניות המובילות בכל סקטור.\n\n${sectors.map((s) => `• ${s}`).join("\n")}`
    : `Ask Grahamy covers ${sectors.length} canonical sectors. You can ask sector-specific questions, compare sectors, or request the leading stocks within any of them.\n\n${sectors.map((s) => `- ${s}`).join("\n")}`;
  return {
    answer: {
      headline: hebrew ? "סקטורים זמינים" : "Available sectors",
      summary,
      bullets: [...sectors],
      watchpoints: [],
      disclaimer: DEFAULT_DISCLAIMER,
    },
    ui: {
      cards: [],
      tables: [],
      suggestedFollowups: HELP_TOPIC_FOLLOWUPS.sectors,
    },
    warnings: [],
  };
}

async function buildIndustriesHelp(hebrew: boolean): Promise<HelpAnswerResult> {
  const grouped = await loadIndustriesBySector();
  if (!grouped.size) {
    return {
      answer: {
        headline: hebrew ? "תעשיות זמינות" : "Available industries",
        summary: hebrew
          ? "מיפוי התעשיות אינו זמין כרגע. נסה שוב בעוד רגע, או שאל על סקטור ספציפי."
          : "Industry mapping isn't available right now. Try again in a moment, or ask about a specific sector.",
        bullets: [],
        watchpoints: [],
        disclaimer: DEFAULT_DISCLAIMER,
      },
      ui: {
        cards: [],
        tables: [],
        suggestedFollowups: HELP_TOPIC_FOLLOWUPS.industries,
      },
      warnings: ["industries-by-sector mapping unavailable"],
    };
  }

  const totalIndustries = Array.from(grouped.values()).reduce(
    (sum, list) => sum + list.length,
    0,
  );
  const sortedSectors = Array.from(grouped.keys()).sort((a, b) =>
    a.localeCompare(b),
  );
  const blocks = sortedSectors.map((sector) => {
    const industries = grouped.get(sector) ?? [];
    const lines = industries.map((i) => `  - ${i}`).join("\n");
    return `**${sector}** (${industries.length})\n${lines}`;
  });

  const intro = hebrew
    ? `אנחנו מכסים ${totalIndustries} תעשיות, מקובצות תחת ${sortedSectors.length} הסקטורים הקנוניים שלנו:`
    : `Ask Grahamy covers ${totalIndustries} industries, grouped under our ${sortedSectors.length} canonical sectors:`;

  return {
    answer: {
      headline: hebrew ? "תעשיות זמינות (לפי סקטור)" : "Available industries (by sector)",
      summary: `${intro}\n\n${blocks.join("\n\n")}`,
      bullets: [],
      watchpoints: [],
      disclaimer: DEFAULT_DISCLAIMER,
    },
    ui: {
      cards: [],
      tables: [],
      suggestedFollowups: HELP_TOPIC_FOLLOWUPS.industries,
    },
    warnings: [],
  };
}

function buildCapabilitiesHelp(hebrew: boolean): HelpAnswerResult {
  const summary = hebrew
    ? `Ask Grahamy עונה על שאלות מחקר ציבוריות על מניות, סקטורים, תעשיות ומשטר השוק. אפשר לשאול:

• **על מניה ספציפית** — למה היא מעניינת עכשיו, פרופיל פונדמנטלי, ראיה היסטורית מקבילה (60 ימים), סיכון מסלול / drawdown, השוואה לסקטור ולתעשייה שלה.
• **על סקטור** — כיצד מתפקד היסטורית במשטר הנוכחי, mtm לעומת שבוע שעבר, פער בין conviction למחיר, מניות מובילות בתוכו.
• **על תעשייה** — אותה תמונה כמו לסקטור אבל ברמת תעשייה.
• **על משטר השוק** — מה המשטר הנוכחי, מה היסטורית עובד בו, איזה סקטורים מובילים/חלשים בו.
• **חיפושים** — feature screen לפי buckets ציבוריים (valuation, quality, momentum, growth, leverage, risk).
• **Backtest פקטור משולב** — מה קרה היסטורית כששילוב של buckets התקיים.
• **שאלות compound** — למשל "סקטורים מובילים במשטר הנוכחי, ומניות מעניינות בהם".`
    : `Ask Grahamy answers public research questions about stocks, sectors, industries, and the market regime. You can ask about:

• **A specific stock** — why it matters now, fundamental profile, 60-day historical analog evidence, drawdown / path risk, comparison to its own sector and industry peers.
• **A sector** — current-regime historical playbook, week-over-week change, conviction-vs-price divergence, leading stocks within it.
• **An industry** — same shape as sectors but at the finer industry granularity.
• **The market regime** — what the current regime is, what historically works in it, which sectors lead/lag.
• **Screens** — feature screens over public buckets (valuation, quality, momentum, growth, leverage, risk).
• **Factor backtests** — historical forward profile of factor-bucket combinations.
• **Compound questions** — e.g. "leading sectors in this regime, and the stocks worth looking at in them".`;
  return {
    answer: {
      headline: hebrew ? "מה Ask Grahamy יודע לנתח" : "What Ask Grahamy can analyze",
      summary,
      bullets: [],
      watchpoints: [],
      disclaimer: DEFAULT_DISCLAIMER,
    },
    ui: {
      cards: [],
      tables: [],
      suggestedFollowups: HELP_TOPIC_FOLLOWUPS.capabilities,
    },
    warnings: [],
  };
}

function buildOverviewHelp(hebrew: boolean): HelpAnswerResult {
  const summary = hebrew
    ? `Ask Grahamy הוא עוזר מחקר מניות ציבורי של StocksScanner. הוא משלב נתוני מחקר ציבוריים — Research Objects לכל מניה / סקטור / תעשייה / משטר — עם capabilities של Postgres (סקטור leaderboard, screens, backtest פקטורים, drawdown risk, ועוד) כדי לענות על שאלות בצורה מבוססת ראיות.

שאל על מניה ספציפית, סקטור, תעשייה, משטר השוק, או על שילובים שלהם. השאלות יכולות להיות באנגלית או בעברית.`
    : `Ask Grahamy is StocksScanner's public stock-research assistant. It combines public research data — per-stock, per-sector, per-industry, and per-regime Research Objects — with Postgres capabilities (sector leaderboards, current-feature screens, factor-conditioned backtests, drawdown-risk evidence, and more) to answer questions in an evidence-grounded way.

Ask about a specific stock, a sector, an industry, the current market regime, or compound questions that combine them. Questions can be in English or Hebrew.`;
  return {
    answer: {
      headline: hebrew ? "מה זה Ask Grahamy" : "What is Ask Grahamy",
      summary,
      bullets: [],
      watchpoints: [],
      disclaimer: DEFAULT_DISCLAIMER,
    },
    ui: {
      cards: [],
      tables: [],
      suggestedFollowups: HELP_TOPIC_FOLLOWUPS.overview,
    },
    warnings: [],
  };
}
