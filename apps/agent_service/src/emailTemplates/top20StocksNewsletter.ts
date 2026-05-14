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

export interface Top20NewsletterHeroImage {
  src: string;
  alt?: string;
  href?: string;
  photographerName?: string;
  photographerUrl?: string;
  unsplashUrl?: string;
  photographer?: {
    name?: string;
    username?: string | null;
    profileUrl?: string | null;
  };
  attribution?: {
    text?: string;
    photographerUrl?: string | null;
    unsplashUrl?: string;
  };
}

export interface Top20NewsletterContent {
  recipientName?: string;
  asOfDate: string;
  sp500_12w_pct?: number | null;
  changeSummary?: string;
  heroImage?: string | Top20NewsletterHeroImage;
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

function textToHtml(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return "";

  return trimmed
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br />")}</p>`)
    .join("");
}

function formatNumber(n: number, decimals: number): string {
  return n.toFixed(decimals);
}

function formatMarketCap(marketCapM: number): string {
  if (marketCapM >= 1000) {
    return `$${(marketCapM / 1000).toFixed(1)}B`;
  }
  return `$${Math.round(marketCapM)}M`;
}

function formatSp500Pct(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function logoUrl(symbol: string): string {
  return `https://financialmodelingprep.com/image-stock/${encodeURIComponent(symbol)}.png`;
}

function normalizeHeroImage(image?: Top20NewsletterContent["heroImage"]): Top20NewsletterHeroImage | null {
  if (!image) return null;
  if (typeof image === "string") {
    const src = image.trim();
    return src ? { src } : null;
  }

  const src = image.src.trim();
  return src ? { ...image, src } : null;
}

function extractUnsplashCredit(image: Top20NewsletterHeroImage): {
  photographerName: string;
  photographerUrl?: string;
  unsplashUrl: string;
} | null {
  const photographerName =
    image.photographerName?.trim() ||
    image.photographer?.name?.trim() ||
    image.attribution?.text?.match(/^Photo by (.+) on Unsplash$/)?.[1]?.trim();

  if (!photographerName) return null;

  const photographerUrl =
    image.photographerUrl?.trim() ||
    image.photographer?.profileUrl?.trim() ||
    image.attribution?.photographerUrl?.trim() ||
    (image.photographer?.username
      ? `https://unsplash.com/@${encodeURIComponent(image.photographer.username)}?utm_source=grahamy&utm_medium=referral`
      : undefined);
  const unsplashUrl = image.unsplashUrl?.trim() || image.attribution?.unsplashUrl?.trim() || "https://unsplash.com/?utm_source=grahamy&utm_medium=referral";

  return {
    photographerName,
    ...(photographerUrl ? { photographerUrl } : {}),
    unsplashUrl,
  };
}

function renderUnsplashCredit(image: Top20NewsletterHeroImage): string {
  const credit = extractUnsplashCredit(image);
  if (!credit) return "";

  const photographer = credit.photographerUrl
    ? `<a href="${escapeHtml(credit.photographerUrl)}" style="color: #D4AF37; text-decoration: none;">${escapeHtml(credit.photographerName)}</a>`
    : escapeHtml(credit.photographerName);

  return `
    <mj-text css-class="unsplash-credit" align="center" padding="8px 28px 0 28px" color="#9AA6B2" font-size="11px" line-height="1.4">
      Photo by ${photographer} on <a href="${escapeHtml(credit.unsplashUrl)}" style="color: #D4AF37; text-decoration: none;">Unsplash</a>
    </mj-text>
  `;
}

function renderHeroImage(image?: Top20NewsletterContent["heroImage"]): string {
  const normalized = normalizeHeroImage(image);
  if (!normalized) return "";

  const imageAttrs = [
    `src="${escapeHtml(normalized.src)}"`,
    `alt="${escapeHtml(normalized.alt ?? "Top 20 Attractive Stocks")}"`,
    'height="220px"',
    'align="center"',
    'padding="0"',
    'fluid-on-mobile="true"',
  ];

  if (normalized.href) {
    imageAttrs.push(`href="${escapeHtml(normalized.href)}"`);
  }

  return StockCard(`
    <mj-image ${imageAttrs.join(" ")} />
    ${renderUnsplashCredit(normalized)}
    <mj-spacer height="18px" />
  `);
}

const LOGO_AVAILABILITY_CACHE = new Map<string, boolean>();
const LOGO_HEAD_TIMEOUT_MS = 2500;

async function symbolHasLogo(symbol: string): Promise<boolean> {
  const cached = LOGO_AVAILABILITY_CACHE.get(symbol);
  if (cached !== undefined) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOGO_HEAD_TIMEOUT_MS);
  try {
    const res = await fetch(logoUrl(symbol), { method: "HEAD", signal: controller.signal });
    const ok = res.ok;
    LOGO_AVAILABILITY_CACHE.set(symbol, ok);
    return ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveLogoAvailability(symbols: string[]): Promise<Map<string, boolean>> {
  const unique = Array.from(new Set(symbols));
  const results = await Promise.all(unique.map(async (s) => [s, await symbolHasLogo(s)] as const));
  return new Map(results);
}

function initialsChipHtml(symbol: string): string {
  const letters = escapeHtml(symbol.slice(0, 4));
  const fontSize = letters.length >= 4 ? 13 : letters.length === 3 ? 16 : 18;
  return `
    <div style="background-color:#1F2530;border:1px solid #2A3441;border-radius:10px;width:56px;height:56px;line-height:56px;text-align:center;color:#F4D55F;font-size:${fontSize}px;font-weight:700;letter-spacing:0.5px;">
      ${letters}
    </div>
  `;
}

const Band = (inner: string, padding = "0 20px") => `
  <mj-section padding="${padding}">
    <mj-column width="100%">
      ${inner}
    </mj-column>
  </mj-section>
`;

const StockCard = (inner: string) => `
  <mj-section padding="0 20px 16px 20px">
    <mj-column width="100%" background-color="#151922" border="1px solid #232B38" border-radius="12px" padding="0" css-class="stock-card">
      ${inner}
    </mj-column>
  </mj-section>
`;

function renderChangeSummary(changeSummary?: string): string {
  const body = changeSummary ? textToHtml(changeSummary) : "";
  if (!body) return "";

  return `
    <mj-section padding="0 20px 22px 20px">
      <mj-column width="100%" background-color="#10161D" border="1px solid #253140" border-radius="8px" padding="0" css-class="summary-card">
        <mj-text padding="18px 22px 8px 22px" color="#78D6A3" font-size="11px" line-height="1.4" font-weight="700" letter-spacing="1.4px" text-transform="uppercase" css-class="summary-title">
          Short Brief
        </mj-text>
        <mj-text padding="0 22px 18px 22px" color="#E9EEF4" font-size="14px" line-height="1.65" font-weight="400" css-class="summary-content">
          ${body}
        </mj-text>
      </mj-column>
    </mj-section>
  `;
}

function bucketColor(bucket: Top20Stock["bucket"]): string {
  switch (bucket) {
    case "cyclical":
      return "#F59E0B";
    case "financial":
      return "#3B82F6";
    default:
      return "#22C55E";
  }
}

function renderFlagsHtml(flags: Top20Stock["flags"]): string {
  const active: Array<{ label: string; color: string }> = [];
  if (flags.hol) active.push({ label: "HOL", color: "#E67E22" });
  if (flags.mpk) active.push({ label: "MPK", color: "#E74C3C" });
  if (flags.hm) active.push({ label: "HM", color: "#F1C40F" });
  if (flags.bio) active.push({ label: "BIO", color: "#8E44AD" });
  if (flags.rng) active.push({ label: "RNG", color: "#2E86C1" });
  if (flags.drd) active.push({ label: "DRD", color: "#D63384" });

  if (!active.length) return "";

  return active
    .map(
      (f) =>
        `<span style="display:inline-block;background-color:${f.color};color:#FFFFFF;font-size:10px;font-weight:700;padding:3px 8px;border-radius:4px;margin:0 4px 4px 0;letter-spacing:0.6px;line-height:1.4;">${f.label}</span>`,
    )
    .join("");
}

function metricCell(label: string, value: string): string {
  return `
    <td style="width:33.33%;padding:0 8px 14px 0;vertical-align:top;">
      <div style="color:#6B7785;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;line-height:1.3;">${label}</div>
      <div style="color:#E9EEF4;font-size:15px;font-weight:600;line-height:1.2;padding-top:4px;">${value}</div>
    </td>
  `;
}

function renderStockCard(stock: Top20Stock, hasLogo: boolean): string {
  const bucketLabel = stock.bucket.toUpperCase();
  const bColor = bucketColor(stock.bucket);
  const mktCap = formatMarketCap(stock.marketCapM);
  const flagsHtml = renderFlagsHtml(stock.flags);
  const hasFlags = flagsHtml.length > 0;

  const logoCellHtml = hasLogo
    ? `
        <div style="background-color:#FFFFFF;border-radius:10px;padding:6px;width:56px;height:56px;line-height:0;">
          <img src="${escapeHtml(logoUrl(stock.symbol))}" alt="${escapeHtml(stock.symbol)}" width="56" height="56" style="display:block;width:56px;height:56px;border:0;outline:none;" />
        </div>
      `
    : initialsChipHtml(stock.symbol);

  const headerRow = `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
      <tr>
        <td align="left" style="color:#6B7785;font-size:11px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;line-height:1.3;">
          Rank #${stock.rank}
        </td>
        <td align="right" style="color:#4DD0C4;font-size:11px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;line-height:1.3;">
          ${escapeHtml(stock.sector)}
        </td>
      </tr>
    </table>
  `;

  const heroRow = `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
      <tr>
        <td width="68" valign="middle" style="width:68px;padding-right:14px;">
          ${logoCellHtml}
        </td>
        <td valign="middle" style="vertical-align:middle;">
          <div style="color:#F4D55F;font-size:24px;line-height:1.1;font-weight:700;">${escapeHtml(stock.symbol)}</div>
          <div style="color:#D6DCE3;font-size:13px;line-height:1.35;font-weight:500;padding-top:4px;">${escapeHtml(stock.company)}</div>
          <div style="padding-top:8px;line-height:1.4;">
            <span style="display:inline-block;background-color:${bColor};color:#0B0E12;font-size:10px;font-weight:700;padding:3px 9px;border-radius:4px;letter-spacing:0.6px;vertical-align:middle;">${bucketLabel}</span>
            <span style="color:#6B7785;font-size:11px;margin-left:8px;vertical-align:middle;">${escapeHtml(stock.industry)}</span>
          </div>
        </td>
      </tr>
    </table>
  `;

  const scoreRow = `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;background-color:#0E1219;border-radius:10px;">
      <tr>
        <td valign="middle" style="padding:14px 0 14px 18px;vertical-align:middle;width:40%;">
          <div style="color:#6B7785;font-size:10px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;line-height:1.2;">Total</div>
          <div style="color:#F4D55F;font-size:32px;line-height:1;font-weight:700;padding-top:4px;">${stock.scores.total}</div>
        </td>
        <td valign="middle" align="right" style="padding:14px 18px 14px 0;vertical-align:middle;color:#9AA6B2;font-size:12px;line-height:1.85;text-align:right;">
          <span style="margin-left:10px;">V <strong style="color:#E9EEF4;font-weight:600;">${stock.scores.v}</strong></span>
          <span style="margin-left:10px;">Q <strong style="color:#E9EEF4;font-weight:600;">${stock.scores.q}</strong></span>
          <span style="margin-left:10px;">H <strong style="color:#E9EEF4;font-weight:600;">${stock.scores.h}</strong></span>
          <span style="margin-left:10px;">G <strong style="color:#E9EEF4;font-weight:600;">${stock.scores.g}</strong></span>
          <span style="margin-left:10px;">M <strong style="color:#E9EEF4;font-weight:600;">${stock.scores.m}</strong></span>
        </td>
      </tr>
    </table>
  `;

  const metricsRow = `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
      <tr>
        ${metricCell("Price", `$${formatNumber(stock.price, 2)}`)}
        ${metricCell("Market Cap", mktCap)}
        ${metricCell("P/E TTM", formatNumber(stock.peTtm, 1))}
      </tr>
      <tr>
        ${metricCell("P/B", formatNumber(stock.pb, 2))}
        ${metricCell("ROE", `${formatNumber(stock.roe, 1)}%`)}
        ${metricCell("Piotroski", `${stock.piotroski}/9`)}
      </tr>
    </table>
  `;

  return StockCard(`
    <mj-text padding="18px 22px 0 22px" css-class="card-header">
      ${headerRow}
    </mj-text>

    <mj-text padding="14px 22px 0 22px" css-class="card-hero">
      ${heroRow}
    </mj-text>

    <mj-text padding="18px 22px 0 22px" css-class="card-score">
      ${scoreRow}
    </mj-text>

    <mj-text padding="18px 22px 4px 22px" css-class="card-metrics">
      ${metricsRow}
    </mj-text>

    ${
      hasFlags
        ? `
    <mj-text padding="6px 22px 18px 22px" css-class="card-flags">
      ${flagsHtml}
    </mj-text>
    `
        : `<mj-spacer height="14px" />`
    }
  `);
}

export async function generateTop20StocksNewsletter(content: Top20NewsletterContent): Promise<string> {
  if ((content.ctaText && !content.ctaUrl) || (content.ctaUrl && !content.ctaText)) {
    throw new Error("'ctaText' and 'ctaUrl' must be provided together.");
  }

  const asOfDate = escapeHtml(content.asOfDate);
  const preview = `Top 20 Attractive Stocks as of ${asOfDate}`;

  const logoMap = await resolveLogoAvailability(content.stocks.map((s) => s.symbol));
  const changeSummaryBlock = renderChangeSummary(content.changeSummary);
  const heroImage = renderHeroImage(content.heroImage);

  const sp500Line =
    content.sp500_12w_pct != null
      ? `
      <mj-text align="center" padding="10px 0 0 0" color="#4DD0C4" font-size="13px" line-height="1.4" font-weight="600" letter-spacing="0.4px" css-class="sp500-line">
        S&amp;P 500 · 12 Weeks &nbsp;<strong style="color:#E9EEF4;">${escapeHtml(formatSp500Pct(content.sp500_12w_pct))}</strong>
      </mj-text>
      `
      : "";

  const stockCards = content.stocks
    .map((stock) => renderStockCard(stock, logoMap.get(stock.symbol) ?? true))
    .join("");

  const cta =
    content.ctaText && content.ctaUrl
      ? `
      <mj-text align="center" padding="14px 0 30px 0" font-family="Inter, 'Roboto', sans-serif">
        <a href="${escapeHtml(content.ctaUrl)}" class="newsletter-button" style="background: linear-gradient(135deg, #D4AF37 0%, #F4D55F 50%, #D4AF37 100%); color: #101419; text-decoration: none; padding: 16px 34px; border-radius: 6px; font-weight: 700; font-size: 14px; display: inline-block; letter-spacing: 0.6px; text-transform: uppercase; box-shadow: 0px 4px 15px rgba(212, 175, 55, 0.24); border: 1px solid #D4AF37; white-space: nowrap;">
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
          .newsletter-title { color: #F4D55F !important; }
          .newsletter-subtitle { color: #D6DCE3 !important; }
          .sp500-line { color: #4DD0C4 !important; }
          .summary-title { color: #78D6A3 !important; }
          .summary-content, .summary-content * { color: #E9EEF4 !important; }
          .summary-content p { margin: 0 0 12px 0; }
          .summary-content p:last-child { margin-bottom: 0; }
          .fine-print { font-size: 13px; color: #9AA6B2 !important; line-height: 1.5; }
          .footer-line { padding-bottom: 10px; }
        </mj-style>

        <mj-style>
          @media only screen and (max-width:600px) {
            .newsletter-title div { font-size: 28px !important; }
            .newsletter-subtitle div { font-size: 15px !important; }
            .summary-content div, .summary-content p { font-size: 13.5px !important; }
            .stock-card { border-radius: 10px !important; }
            .card-header td { font-size: 10px !important; }
            .card-hero td > div:first-child { font-size: 20px !important; }
            .card-hero td > div:nth-child(2) { font-size: 12.5px !important; }
            .card-score td:first-child > div:nth-child(2) { font-size: 28px !important; }
            .card-score td:last-child { font-size: 11px !important; line-height: 1.7 !important; }
            .card-score td:last-child span { margin-left: 7px !important; }
            .card-metrics td > div:first-child { font-size: 9.5px !important; }
            .card-metrics td > div:nth-child(2) { font-size: 13.5px !important; }
            .fine-print { font-size: 12px !important; }
            .footer-line { padding-bottom: 14px !important; }
          }
          @media only screen and (max-width:420px) {
            .card-hero td:first-child { width: 56px !important; padding-right: 10px !important; }
            .card-hero td:first-child > div { width: 44px !important; height: 44px !important; padding: 4px !important; }
            .card-hero td:first-child img { width: 44px !important; height: 44px !important; }
            .card-score td:first-child { padding-left: 14px !important; }
            .card-score td:last-child { padding-right: 14px !important; font-size: 10.5px !important; }
            .card-score td:last-child span { margin-left: 5px !important; }
          }
        </mj-style>
      </mj-head>

      <mj-body width="640px" background-color="#0B0E12" css-class="top20-newsletter">

        ${Band(
          `
          <mj-image src="https://grahamy.com/assets/logo_horizontal-C-hWewqw.png"
            alt="Grahamy" width="200px" align="center" padding="0" />
          `,
          "44px 20px 22px 20px",
        )}

        ${Band(
          `
          <mj-divider border-width="2px" border-style="solid" border-color="#D4AF37" padding="0" />
          `,
          "0 42px 30px 42px",
        )}

        ${Band(
          `
          <mj-text align="center" padding="0 0 10px 0" color="#78D6A3" font-size="12px" line-height="1.4" font-weight="700" letter-spacing="2px" text-transform="uppercase" css-class="eyebrow">
            Stock Screener
          </mj-text>

          <mj-text align="center" padding="0 0 10px 0" color="#F4D55F" font-size="34px" line-height="1.1" font-weight="700" letter-spacing="-0.3px" css-class="newsletter-title">
            Top 20 Attractive Stocks
          </mj-text>

          <mj-text align="center" padding="0 24px 0 24px" color="#D6DCE3" font-size="16px" line-height="1.45" font-weight="400" css-class="newsletter-subtitle">
            As of ${asOfDate}
          </mj-text>

          ${sp500Line}
          `,
          "0 20px 30px 20px",
        )}

        ${changeSummaryBlock}

        ${heroImage}

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
            <a href="mailto:office@grahamy.com" style="color: #F4D55F; text-decoration: none;">office@grahamy.com</a>
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
