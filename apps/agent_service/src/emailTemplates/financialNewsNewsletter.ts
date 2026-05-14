import { mjmlToHtml } from "../utils/mjmlConverter";

export type NewsletterDirection = "ltr" | "rtl";

export interface FinancialNewsEventImage {
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

export interface FinancialNewsEvent {
  /**
   * Short story label, for example "Asia-Pacific Markets" or "Central Banks".
   */
  title: string;
  /**
   * Main story headline rendered prominently in the card.
   */
  headline: string;
  /**
   * Plain-text story body. Newlines are preserved and escaped before rendering.
   */
  content: string;
  /**
   * Either a direct image URL or an object with src/alt/href metadata.
   */
  image?: string | FinancialNewsEventImage;
  region?: string;
  sourceName?: string;
  sourceUrl?: string;
}

export interface FinancialNewsNewsletterContent {
  recipientName?: string;
  newsletterTitle?: string;
  newsletterHeadline?: string;
  intro?: string;
  changeSummary?: string;
  issuedAt?: string;
  preview?: string;
  newsEvents: FinancialNewsEvent[];
  ctaText?: string;
  ctaUrl?: string;
  direction?: NewsletterDirection;
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

function normalizeImage(image?: FinancialNewsEvent["image"]): FinancialNewsEventImage | null {
  if (!image) return null;
  if (typeof image === "string") {
    const src = image.trim();
    return src ? { src } : null;
  }

  const src = image.src.trim();
  return src ? { ...image, src } : null;
}

function extractUnsplashCredit(image: FinancialNewsEventImage): {
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

function renderUnsplashCredit(image: FinancialNewsEventImage): string {
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

const Band = (inner: string, padding = "0 20px") => `
  <mj-section padding="${padding}">
    <mj-column width="100%">
      ${inner}
    </mj-column>
  </mj-section>
`;

const StoryCard = (inner: string, padding = "0 20px 20px 20px", cardPadding = "0") => `
  <mj-section padding="${padding}">
    <mj-column width="100%" background-color="#151922" border="1px solid #2A3441" border-radius="8px" padding="${cardPadding}" css-class="story-card">
      ${inner}
    </mj-column>
  </mj-section>
`;

function renderStoryImage(event: FinancialNewsEvent, fallbackAlt: string, featured = false): string {
  const image = normalizeImage(event.image);
  if (!image) return "";

  const imageAttrs = [
    `src="${escapeHtml(image.src)}"`,
    `alt="${escapeHtml(image.alt ?? fallbackAlt)}"`,
    featured ? 'height="250px"' : 'height="190px"',
    'align="center"',
    'padding="0"',
    'fluid-on-mobile="true"',
  ];

  if (image.href) {
    imageAttrs.push(`href="${escapeHtml(image.href)}"`);
  }

  return `
    <mj-image ${imageAttrs.join(" ")} />
    ${renderUnsplashCredit(image)}
  `;
}

function renderMeta(event: FinancialNewsEvent, align: "left" | "right"): string {
  const meta = [event.region, event.sourceName].filter(Boolean).map((item) => escapeHtml(item as string));
  if (!meta.length && !event.sourceUrl) return "";

  const sourceLink = event.sourceUrl
    ? `<a href="${escapeHtml(event.sourceUrl)}" style="color: #D4AF37; text-decoration: none;">${escapeHtml(event.sourceName ?? "Source")}</a>`
    : null;

  const text = sourceLink
    ? [event.region ? escapeHtml(event.region) : null, sourceLink].filter(Boolean).join(" / ")
    : meta.join(" / ");

  return `
    <mj-text css-class="story-meta" align="${align}" padding="4px 28px 0 28px" color="#9AA6B2" font-size="12px" line-height="1.4" font-weight="500" text-transform="uppercase">
      ${text}
    </mj-text>
  `;
}

function renderNewsEvent(event: FinancialNewsEvent, index: number, align: "left" | "right"): string {
  const featured = index === 0;
  const title = escapeHtml(event.title);
  const headline = escapeHtml(event.headline);
  const body = textToHtml(event.content);

  return StoryCard(
    `
      ${renderStoryImage(event, event.headline, featured)}

      <mj-text css-class="story-title" align="${align}" padding="${featured ? "28px" : "24px"} 28px 6px 28px" color="#D4AF37" font-size="13px" line-height="1.4" font-weight="700" text-transform="uppercase">
        ${title}
      </mj-text>

      <mj-text css-class="${featured ? "feature-headline" : "story-headline"}" align="${align}" padding="0 28px 10px 28px" color="#FFFFFF" font-size="${featured ? "26px" : "21px"}" line-height="1.25" font-weight="650">
        ${headline}
      </mj-text>

      ${renderMeta(event, align)}

      <mj-text css-class="story-content" align="${align}" padding="14px 28px 28px 28px" color="#E9EEF4" font-size="15px" line-height="1.65" font-weight="400">
        ${body}
      </mj-text>
    `,
    featured ? "0 20px 24px 20px" : "0 20px 18px 20px",
  );
}

function renderEmptyState(): string {
  return StoryCard(
    `
      <mj-text align="center" padding="30px 28px" color="#D6DCE3" font-size="15px" line-height="1.6">
        No financial news events were provided for this newsletter.
      </mj-text>
    `,
    "0 20px 20px 20px",
    "0",
  );
}

function renderChangeSummary(changeSummary: string | undefined, align: "left" | "right"): string {
  const body = changeSummary ? textToHtml(changeSummary) : "";
  if (!body) return "";

  return StoryCard(
    `
      <mj-text css-class="summary-title" align="${align}" padding="20px 28px 8px 28px" color="#78D6A3" font-size="12px" line-height="1.4" font-weight="700" letter-spacing="1.1px" text-transform="uppercase">
        Short Brief
      </mj-text>

      <mj-text css-class="summary-content" align="${align}" padding="0 28px 22px 28px" color="#E9EEF4" font-size="15px" line-height="1.65" font-weight="400">
        ${body}
      </mj-text>
    `,
    "0 20px 22px 20px",
  );
}

export const financialNewsNewsletterTemplate = (content: FinancialNewsNewsletterContent): string => {
  if ((content.ctaText && !content.ctaUrl) || (content.ctaUrl && !content.ctaText)) {
    throw new Error("'ctaText' and 'ctaUrl' must be provided together.");
  }

  const direction: NewsletterDirection = content.direction ?? "ltr";
  const align = direction === "rtl" ? "right" : "left";
  const newsletterTitle = content.newsletterTitle ?? "Global Financial News";
  const newsletterHeadline = content.newsletterHeadline ?? "Recent market-moving stories from around the world";
  const preview = escapeHtml(content.preview ?? newsletterHeadline);
  const issueLine = content.issuedAt ? escapeHtml(content.issuedAt) : "Latest issue";
  const changeSummary = renderChangeSummary(content.changeSummary, align);
  const stories = content.newsEvents.length
    ? content.newsEvents.map((event, index) => renderNewsEvent(event, index, align)).join("")
    : renderEmptyState();
  const cta = content.ctaText && content.ctaUrl
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
          .newsletter-title { color: #FFFFFF !important; }
          .newsletter-headline { color: #D6DCE3 !important; }
          .story-title { color: #D4AF37 !important; letter-spacing: 0.9px; }
          .story-headline, .feature-headline { color: #FFFFFF !important; }
          .story-content, .story-content * { color: #E9EEF4 !important; }
          .story-content p { margin: 0 0 12px 0; }
          .story-content p:last-child { margin-bottom: 0; }
          .summary-title { color: #78D6A3 !important; letter-spacing: 1.1px; }
          .summary-content, .summary-content * { color: #E9EEF4 !important; }
          .summary-content p { margin: 0 0 12px 0; }
          .summary-content p:last-child { margin-bottom: 0; }
          .story-meta { color: #9AA6B2 !important; letter-spacing: 0.6px; }
          .fine-print { font-size: 13px; color: #9AA6B2 !important; line-height: 1.5; }
          .footer-line { padding-bottom: 10px; }
        </mj-style>

        <mj-style>
          @media only screen and (max-width:600px) {
            .newsletter-title div { font-size: 30px !important; }
            .newsletter-headline div { font-size: 18px !important; }
            .feature-headline div { font-size: 22px !important; }
            .story-headline div { font-size: 19px !important; }
            .summary-content div, .summary-content p { font-size: 14px !important; }
            .story-content div, .story-content p { font-size: 14px !important; }
            .fine-print { font-size: 12px !important; }
            .footer-line { padding-bottom: 14px !important; }
          }
        </mj-style>
      </mj-head>

      <mj-body width="640px" background-color="#0B0E12" css-class="finance-newsletter">
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
            ${escapeHtml(issueLine)}
          </mj-text>

          <mj-text align="center" padding="0 0 8px 0" color="#FFFFFF" font-size="38px" line-height="1.1" font-weight="650" css-class="newsletter-title">
            ${escapeHtml(newsletterTitle)}
          </mj-text>

          <mj-text align="center" padding="0 24px" color="#D6DCE3" font-size="20px" line-height="1.45" font-weight="400" css-class="newsletter-headline">
            ${escapeHtml(newsletterHeadline)}
          </mj-text>
        `,
          "0 20px 28px 20px",
        )}

        ${changeSummary}

        ${stories}

        ${cta}

        ${Band(
          `
          <mj-divider border-width="1px" border-style="solid" border-color="#2A3441" padding="20px 0" />

          <mj-text css-class="fine-print footer-line" align="center" padding="0 0 10px 0" color="#9AA6B2">
            Market news is provided for informational purposes only and is not financial advice.
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
};
