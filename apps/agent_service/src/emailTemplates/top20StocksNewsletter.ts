import { mjmlToHtml } from "../utils/mjmlConverter";

export interface Top20Stock {
  rank: number;
  symbol: string;
  company: string;
  sector: string;
  industry: string;
  bucket: "standard" | "cyclical" | "financial";
  price: number;
  marketCapM: number;
  avgVolume: number;
  peTtm: number;
  cape: number;
  pb: number;
  roe: number;
  piotroski: number;
  scores: { v: number; q: number; h: number; g: number; m: number; total: number };
  flags: { hol: boolean; mpk: boolean; hm: boolean; bio: boolean; rng: boolean; drd: boolean };
}

export interface Top20NewsletterContent {
  recipientName?: string;
  asOfDate: string;
  sp500_12w_pct?: number | null;
  stocks: Top20Stock[];
  ctaText?: string;
  ctaUrl?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatNumber(n: number, decimals: number): string {
  return n.toFixed(decimals);
}

function formatMarketCap(marketCapM: number): string {
  if (marketCapM >= 1000) {
    return `${(marketCapM / 1000).toFixed(1)}B`;
  }
  return `${Math.round(marketCapM)}M`;
}

function formatSp500Pct(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

const Band = (inner: string, padding = "0 20px") => `
  <mj-section padding="${padding}">
    <mj-column width="100%">
      ${inner}
    </mj-column>
  </mj-section>
`;

const StockCard = (inner: string) => `
  <mj-section padding="0 20px 18px 20px">
    <mj-column width="100%" background-color="#151922" border="1px solid #2A3441" border-radius="8px" padding="0" css-class="stock-card">
      ${inner}
    </mj-column>
  </mj-section>
`;

function bucketColor(bucket: Top20Stock["bucket"]): string {
  switch (bucket) {
    case "cyclical":
      return "#E67E22";
    case "financial":
      return "#2E86C1";
    default:
      return "#27AE60";
  }
}

function renderFlagsHtml(flags: Top20Stock["flags"]): string {
  const active: Array<{ label: string; color: string }> = [];
  if (flags.hol) active.push({ label: "HOL", color: "#E67E22" });
  if (flags.mpk) active.push({ label: "MPK", color: "#E74C3C" });
  if (flags.hm)  active.push({ label: "HM",  color: "#F1C40F" });
  if (flags.bio) active.push({ label: "BIO", color: "#8E44AD" });
  if (flags.rng) active.push({ label: "RNG", color: "#2E86C1" });
  if (flags.drd) active.push({ label: "DRD", color: "#D63384" });

  if (!active.length) return "";

  return active
    .map(
      (f) =>
        `<span style="display:inline-block;background-color:${f.color};color:#FFFFFF;font-size:10px;font-weight:700;padding:2px 7px;border-radius:3px;margin-right:4px;letter-spacing:0.5px;">${f.label}</span>`,
    )
    .join("");
}

function renderStockCard(stock: Top20Stock): string {
  const bucketLabel = stock.bucket.toUpperCase();
  const bColor = bucketColor(stock.bucket);
  const mktCap = formatMarketCap(stock.marketCapM);
  const flagsHtml = renderFlagsHtml(stock.flags);
  const hasFlags = flagsHtml.length > 0;

  const flagsSection = hasFlags
    ? `
    <mj-section padding="8px 20px 0 20px">
      <mj-column width="100%" padding="0">
        <mj-divider border-width="1px" border-style="dashed" border-color="#2A3441" padding="0" />
      </mj-column>
    </mj-section>
    <mj-section padding="8px 20px 14px 20px">
      <mj-column width="100%" padding="0">
        <mj-text padding="0" color="#9AA6B2" font-size="12px" line-height="1.4" css-class="flags-row">
          ${flagsHtml}
        </mj-text>
      </mj-column>
    </mj-section>
    `
    : `
    <mj-section padding="0 20px 14px 20px">
      <mj-column width="100%" padding="0">
        <mj-text padding="0" color="transparent" font-size="1px">&nbsp;</mj-text>
      </mj-column>
    </mj-section>
    `;

  return StockCard(`
    <mj-section padding="20px 20px 0 20px">
      <mj-column width="50%" padding="0">
        <mj-text padding="0" color="#9AA6B2" font-size="12px" line-height="1.3" font-weight="500" css-class="rank-label">
          #${stock.rank}
        </mj-text>
        <mj-text padding="2px 0 0 0" color="#D4AF37" font-size="22px" line-height="1.1" font-weight="700" css-class="symbol-label">
          ${escapeHtml(stock.symbol)}
        </mj-text>
      </mj-column>
      <mj-column width="50%" padding="0">
        <mj-text padding="0" align="right" color="#4DD0C4" font-size="12px" line-height="1.3" font-weight="600" text-transform="uppercase" css-class="sector-label">
          ${escapeHtml(stock.sector)}
        </mj-text>
        <mj-text padding="2px 0 0 0" align="right" color="#9AA6B2" font-size="11px" line-height="1.3" css-class="industry-label">
          ${escapeHtml(stock.industry)}
        </mj-text>
      </mj-column>
    </mj-section>

    <mj-section padding="8px 20px 0 20px">
      <mj-column width="100%" padding="0">
        <mj-text padding="0 0 6px 0" color="#FFFFFF" font-size="15px" line-height="1.3" font-weight="500" css-class="company-name">
          ${escapeHtml(stock.company)}&nbsp;&nbsp;<span style="display:inline-block;background-color:${bColor};color:#FFFFFF;font-size:10px;font-weight:700;padding:2px 8px;border-radius:3px;letter-spacing:0.6px;vertical-align:middle;">${bucketLabel}</span>
        </mj-text>
      </mj-column>
    </mj-section>

    <mj-section padding="10px 20px 0 20px">
      <mj-column width="100%" padding="0">
        <mj-divider border-width="1px" border-style="solid" border-color="#2A3441" padding="0" />
      </mj-column>
    </mj-section>

    <mj-section padding="12px 20px 0 20px">
      <mj-column width="100%" padding="0">
        <mj-text padding="0" color="#9AA6B2" font-size="12px" line-height="1.5" css-class="score-bar">
          <span style="margin-right:10px;">V: <strong style="color:#D6DCE3;">${stock.scores.v}</strong></span>
          <span style="margin-right:10px;">Q: <strong style="color:#D6DCE3;">${stock.scores.q}</strong></span>
          <span style="margin-right:10px;">H: <strong style="color:#D6DCE3;">${stock.scores.h}</strong></span>
          <span style="margin-right:10px;">G: <strong style="color:#D6DCE3;">${stock.scores.g}</strong></span>
          <span style="margin-right:14px;">M: <strong style="color:#D6DCE3;">${stock.scores.m}</strong></span>
          <span>TOTAL: <strong style="color:#D4AF37;font-size:15px;">${stock.scores.total}</strong></span>
        </mj-text>
      </mj-column>
    </mj-section>

    <mj-section padding="10px 20px 0 20px">
      <mj-column width="100%" padding="0">
        <mj-divider border-width="1px" border-style="solid" border-color="#2A3441" padding="0" />
      </mj-column>
    </mj-section>

    <mj-section padding="12px 20px 0 20px">
      <mj-column width="100%" padding="0">
        <mj-text padding="0" color="#9AA6B2" font-size="12px" line-height="1.6" css-class="metrics-row">
          <span style="margin-right:12px;">Price: <strong style="color:#E9EEF4;">$${formatNumber(stock.price, 2)}</strong></span>
          <span style="margin-right:12px;">Mkt Cap: <strong style="color:#E9EEF4;">${mktCap}</strong></span>
          <span style="margin-right:12px;">P/E TTM: <strong style="color:#E9EEF4;">${formatNumber(stock.peTtm, 1)}</strong></span>
          <span style="margin-right:12px;">P/B: <strong style="color:#E9EEF4;">${formatNumber(stock.pb, 2)}</strong></span>
          <span style="margin-right:12px;">ROE%: <strong style="color:#E9EEF4;">${formatNumber(stock.roe, 1)}</strong></span>
          <span>Piotroski: <strong style="color:#E9EEF4;">${stock.piotroski}/9</strong></span>
        </mj-text>
      </mj-column>
    </mj-section>

    ${flagsSection}
  `);
}

export function generateTop20StocksNewsletter(content: Top20NewsletterContent): string {
  if ((content.ctaText && !content.ctaUrl) || (content.ctaUrl && !content.ctaText)) {
    throw new Error("'ctaText' and 'ctaUrl' must be provided together.");
  }

  const asOfDate = escapeHtml(content.asOfDate);
  const preview = `Top 20 Attractive Stocks as of ${asOfDate}`;

  const sp500Line =
    content.sp500_12w_pct != null
      ? `
      <mj-text align="center" padding="6px 0 0 0" color="#4DD0C4" font-size="13px" line-height="1.4" font-weight="600" css-class="sp500-line">
        S&amp;P 500 (12W): ${escapeHtml(formatSp500Pct(content.sp500_12w_pct))}
      </mj-text>
      `
      : "";

  const stockCards = content.stocks.map((stock) => renderStockCard(stock)).join("");

  const cta =
    content.ctaText && content.ctaUrl
      ? `
      <mj-text align="center" padding="8px 0 30px 0" font-family="Inter, 'Roboto', sans-serif">
        <a href="${escapeHtml(content.ctaUrl)}" class="newsletter-button" style="background: linear-gradient(135deg, #D4AF37 0%, #F4D03F 50%, #D4AF37 100%); color: #101419; text-decoration: none; padding: 16px 34px; border-radius: 6px; font-weight: 700; font-size: 14px; display: inline-block; letter-spacing: 0.6px; text-transform: uppercase; box-shadow: 0px 4px 15px rgba(212, 175, 55, 0.24); border: 1px solid #D4AF37; white-space: nowrap;">
          ${escapeHtml(content.ctaText)}
        </a>
      </mj-text>
      `
      : "";

  return mjmlToHtml(`
    <mjml>
      <mj-head>
        <mj-font name="Inter" href="https://fonts.googleapis.com/css?family=Inter:400,500,600,700" />
        <mj-font name="Roboto" href="https://fonts.googleapis.com/css?family=Roboto:400,500,600,700" />
        <mj-attributes>
          <mj-all font-family="Inter, 'Roboto', sans-serif" />
        </mj-attributes>
        <mj-breakpoint width="480px" />
        <mj-preview>${preview}</mj-preview>

        <mj-style inline="inline">
          .eyebrow { color: #78D6A3 !important; }
          .newsletter-title { color: #D4AF37 !important; }
          .newsletter-subtitle { color: #D6DCE3 !important; }
          .sp500-line { color: #4DD0C4 !important; }
          .rank-label { color: #9AA6B2 !important; }
          .symbol-label { color: #D4AF37 !important; }
          .sector-label { color: #4DD0C4 !important; }
          .industry-label { color: #9AA6B2 !important; }
          .company-name { color: #FFFFFF !important; }
          .score-bar { color: #9AA6B2 !important; }
          .metrics-row { color: #9AA6B2 !important; }
          .flags-row { color: #9AA6B2 !important; }
          .fine-print { font-size: 13px; color: #9AA6B2 !important; line-height: 1.5; }
          .footer-line { padding-bottom: 10px; }
        </mj-style>

        <mj-style>
          @media only screen and (max-width:600px) {
            .newsletter-title div { font-size: 26px !important; }
            .newsletter-subtitle div { font-size: 16px !important; }
            .symbol-label div { font-size: 18px !important; }
            .company-name div { font-size: 13px !important; }
            .score-bar div, .metrics-row div { font-size: 11px !important; }
            .fine-print { font-size: 12px !important; }
            .footer-line { padding-bottom: 14px !important; }
          }
        </mj-style>
      </mj-head>

      <mj-body width="640px" background-color="#0B0E12" css-class="top20-newsletter">

        ${Band(
          `
          <mj-image src="https://grahamy.com/assets/logo_horizontal-C-hWewqw.png"
            alt="Grahamy" width="200px" align="center" padding="0" />
          `,
          "44px 20px 24px 20px",
        )}

        ${Band(
          `
          <mj-divider border-width="2px" border-style="solid" border-color="#D4AF37" padding="0" />
          `,
          "0 42px 30px 42px",
        )}

        ${Band(
          `
          <mj-text align="center" padding="0 0 8px 0" color="#78D6A3" font-size="13px" line-height="1.4" font-weight="700" letter-spacing="1.2px" text-transform="uppercase" css-class="eyebrow">
            Stock Screener
          </mj-text>

          <mj-text align="center" padding="0 0 8px 0" color="#D4AF37" font-size="36px" line-height="1.1" font-weight="650" css-class="newsletter-title">
            Top 20 Attractive Stocks
          </mj-text>

          <mj-text align="center" padding="0 24px 0 24px" color="#D6DCE3" font-size="18px" line-height="1.45" font-weight="400" css-class="newsletter-subtitle">
            As of ${asOfDate}
          </mj-text>

          ${sp500Line}
          `,
          "0 20px 28px 20px",
        )}

        ${stockCards}

        ${cta}

        ${Band(
          `
          <mj-divider border-width="1px" border-style="solid" border-color="#2A3441" padding="20px 0" />

          <mj-text css-class="fine-print footer-line" align="center" padding="0 0 10px 0" color="#9AA6B2">
            Stock data is provided for informational purposes only and is not financial advice.
          </mj-text>

          <mj-text css-class="fine-print footer-line" align="center" padding="0 0 10px 0" color="#9AA6B2">
            Need assistance? Our team is available at
            <a href="mailto:office@grahamy.com" style="color: #D4AF37; text-decoration: none;">office@grahamy.com</a>
          </mj-text>

          <mj-text css-class="fine-print" align="center" padding="0" color="#657180">
            Copyright 2026 Grahamy.com. All rights reserved.
          </mj-text>
          `,
          "4px 20px 32px 20px",
        )}

        ${Band(`<mj-text>&nbsp;</mj-text>`, "10px 16px")}
      </mj-body>
    </mjml>
  `);
}
