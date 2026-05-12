import {
  loadCanonicalSectors,
  loadIndustriesBySector,
} from "./classification";
import {
  DEFAULT_DISCLAIMER,
  type AnswerObject,
  type HelpTopic,
  type UiHints,
} from "../types";

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
    ? `Ask Grahamy עונה על שאלות מחקר ציבוריות על מניות, סקטורים, תעשיות, משטר השוק, ושילובים של אלה. כל התשובות מבוססות ראיות ציבוריות בלבד — דליים, אחוזונים, מדגמי analog היסטוריים, ו־drawdown מהיסטוריית המחיר.

**מחקר על מניה אחת**
• למה היא מעניינת עכשיו, פרופיל פונדמנטלי (גדילה / איכות / מאזן), התאמה למשטר.
• ראיה היסטורית מקבילה ל־60 יום על המניה עצמה ועל הסקטור שלה.
• סיכון לירידה זמנית בדרך (path risk / drawdown) — הסתברות לירידה מעל 5/10/15/20%, p10 max drawdown, ושיעור התאוששות עד סוף הטווח.
• השוואה לסקטור או לתעשייה שלה — Grahamy טוען אוטומטית את אובייקט המחקר של הסקטור והתעשייה גם כשלא מציינים אותם.
• דוגמאות: "מה דעתך על NVDA?", "כמה בסיכון GSL?", "מה ההסתברות לאבד יותר מ־10% ב־AAPL?"

**שאלות סקטור**
• Sector conviction leaderboard — דירוג סקטורים לפי conviction השבוע.
• Week-over-week delta — אילו סקטורים התחזקו / נחלשו השבוע.
• Conviction-vs-momentum divergence — סקטורים עם פער בין ראיות למחיר.
• Sector leaders — המניות המובילות בתוך סקטור ספציפי.
• Sector regime playbook — איך הסקטור התנהג היסטורית במשטר הנוכחי.
• דוגמאות: "אילו סקטורים מובילים על conviction השבוע?", "אילו סקטורים התחזקו השבוע?", "המניות המובילות ב־Healthcare".

**שאלות תעשייה**
• פרופיל תעשייה (PE, שינוי יומי ממוצע, hit rate היסטורי).
• Industry leaders — המניות המובילות בתוך תעשייה ספציפית.
• דוגמאות: "מה קורה ב־Semiconductors?", "המניות המובילות ב־Biotechnology".

**משטר השוק**
• מה המשטר הנוכחי (RISK-ON / NEUTRAL / RISK-OFF) ומה ה־VIX band.
• Historical playbook — מה היסטורית עובד / חלש במשטר הזה, איזה סקטורים מובילים, איזה סיכונים בולטים.
• דוגמאות: "מה המשטר עכשיו?", "מה עובד היסטורית במשטר הזה?", "מה הסיכונים במשטר הנוכחי?"

**גילוי וסינון**
• Stock idea discovery — קבל מועמדי מחקר נוכחיים בלי להגדיר קריטריונים.
• Feature screen — סנן מניות לפי דליים ציבוריים (valuation, quality, momentum, growth, leverage, risk, sector).
• Factor-conditioned backtest — מה קרה היסטורית כששילוב דליים התקיים (אופקים: 20/40/60/120/252 ימים).
• דוגמאות: "תן לי מניה מעניינת", "מצא מניות זולות ואיכותיות", "מה קרה היסטורית כש־RSI נמוך ו־valuation אטרקטיבי?"

**שרשראות compound (workflow)**
• Regime → screen — סקטורים מובילים במשטר + מניות בהם.
• Sector delta → screen — סקטורים שהתחזקו השבוע + מניות בהם.
• Sector divergence → screen — סקטורים עם פער ראיות-מחיר + מניות בהם.
• Feature screen + backtest — סינון נוכחי + בדיקת אם השילוב עבד היסטורית.
• Stock deep-dive stack — ניתוח מלא למניה (פונדמנטל + סיכון + השוואה לסקטור / תעשייה + ראיה מאומתת).
• Idea → compare → risk — רעיון מניה + השוואה לסקטור + סיכון.

**ראיה מאומתת (Validated edge evidence)**
שכבת bonus נפרדת מ־Pipeline — מצב מאומת חזק / קיים / מעורב. שאל ישירות: "האם יש ראיה מאומתת ל־X?", "האם NVDA נתמך ב־pipeline?"

**שאלות פלטפורמה**
"אילו סקטורים יש לכם?", "אילו תעשיות זמינות?", "מה Ask Grahamy יודע לנתח?", "איך זה עובד?"`
    : `Ask Grahamy answers public research questions about stocks, sectors, industries, the market regime, and combinations of those. Every answer is grounded in public evidence only — buckets, percentile bands, historical analog samples, and drawdown evidence from price history.

**Single-stock research**
• Why it matters now, fundamental profile (growth / quality / balance sheet), regime fit.
• 60-day historical analog evidence — both stock-local and sector-conditioned.
• Path risk / drawdown — probability of drawdowns greater than 5%, 10%, 15%, 20%; p10 max drawdown; recovery rate by horizon.
• Peer comparison to the stock's own sector and industry — Grahamy auto-loads the sibling sector and industry research objects even when you don't name them.
• Examples: *"What do you think about NVDA?"*, *"How risky is GSL?"*, *"What is the probability of losing more than 10% on AAPL?"*

**Sector questions**
• Sector conviction leaderboard — sectors ranked by current conviction.
• Week-over-week delta — which sectors strengthened or weakened this week.
• Conviction-vs-momentum divergence — sectors where evidence and price disagree.
• Sector leaders — top stocks within a named sector.
• Sector regime playbook — how the sector has historically behaved in the current regime.
• Examples: *"Which sectors are leading on conviction this week?"*, *"Which sectors improved most versus last week?"*, *"Top stocks in Healthcare."*

**Industry questions**
• Industry profile (PE, average daily change, historical hit-rate bucket).
• Industry leaders — top stocks within a named industry.
• Examples: *"How are Semiconductors looking?"*, *"Top stocks in Biotechnology."*

**Market regime**
• Current regime label (RISK-ON / NEUTRAL / RISK-OFF) and the VIX band.
• Historical playbook — what works / underperforms in this regime, which sectors lead, which risks matter.
• Examples: *"What is the current market regime?"*, *"What historically works in this regime?"*, *"What are the regime risks now?"*

**Discovery and screens**
• Stock idea discovery — anchorless current research candidates with no criteria.
• Feature screen — filter stocks by public buckets (valuation, quality, momentum, growth, leverage, risk, sector).
• Factor-conditioned backtest — historical forward profile of factor-bucket combinations across 20 / 40 / 60 / 120 / 252-day horizons.
• Examples: *"Give me an interesting stock"*, *"Find cheap, high-quality stocks"*, *"What happens historically when RSI is low and valuation is attractive?"*

**Compound (multi-step) workflows**
• Regime → screen — leading sectors in this regime + the stocks inside them.
• Sector delta → screen — sectors that improved this week + the stocks inside them.
• Sector divergence → screen — divergence sectors + the stocks inside them.
• Feature screen + backtest — current screen + historical proof that the combination worked.
• Stock deep-dive stack — full analysis on one stock (fundamentals + risk + sibling sector / industry + optional validated evidence).
• Idea → compare → risk — stock idea + sibling sector comparison + risk on it.

**Validated edge evidence (Pipeline overlay)**
A separate optional layer on top of the public stack — flags whether a stock / sector / regime is *evidence-backed* by Grahamy's validation pipeline (states: edge_evidence_strong / edge_evidence_present / mixed / insufficient_data / unavailable). Ask directly: *"Is there validated edge evidence for X?"*, *"Is NVDA evidence-backed?"*

**Platform questions**
*"Which sectors do you cover?"*, *"What industries are available?"*, *"What can Ask Grahamy analyze?"*, *"How does Ask Grahamy work?"*`;
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
