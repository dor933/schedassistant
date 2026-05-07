import { mjmlToHtml } from "../utils/mjmlConverter";

export type EmailLanguage = "en" | "he";

export interface GenericMessageContent {
  /**
   * Display name of the PERSON RECEIVING this email (the human in the `to`
   * field). Rendered as the top-of-email greeting: "Hello, <recipientName>".
   * Not the sender, not the agent. Omit to fall back to a generic "Hello".
   */
  recipientName?: string;
  headline: string;
  bodyHtml: string;
  ctaText?: string;
  ctaUrl?: string;
  preview?: string;
  /**
   * Language for fixed chrome strings (greeting, footer support line, copyright)
   * AND default text direction. 'he' forces RTL layout and Hebrew chrome;
   * 'en' uses LTR + English. Defaults to 'en'.
   */
  language?: EmailLanguage;
}

const STRINGS: Record<EmailLanguage, {
  greetingWithName: (name: string) => string;
  greetingNoName: string;
  supportPrefix: string;
  copyright: string;
}> = {
  en: {
    greetingWithName: (name) => `Hello, ${name}`,
    greetingNoName: "Hello",
    supportPrefix: "Need assistance? Our team is available at",
    copyright: "© 2025 Grahamy.com. All rights reserved.",
  },
  he: {
    greetingWithName: (name) => `שלום, ${name}`,
    greetingNoName: "שלום",
    supportPrefix: "זקוקים לסיוע? הצוות שלנו זמין בכתובת",
    copyright: "© 2025 Grahamy.com. כל הזכויות שמורות.",
  },
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const Band = (inner: string, padding = "0 16px") => `
  <mj-section padding="${padding}">
    <mj-column width="100%">
      ${inner}
    </mj-column>
  </mj-section>
`;

const Box = (inner: string, sectionPadding = "0 30px", boxPadding = "25px") => `
  <mj-section padding="${sectionPadding}">
    <mj-column width="100%" background-color="#1A1A1A" border="1px solid #333333" border-radius="8px" padding="${boxPadding}" css-class="premium-card">
      ${inner}
    </mj-column>
  </mj-section>
`;

export const genericMessageTemplate = (content: GenericMessageContent): string => {
  const language: EmailLanguage = content.language ?? "en";
  const strings = STRINGS[language];
  const greeting = content.recipientName
    ? strings.greetingWithName(escapeHtml(content.recipientName))
    : strings.greetingNoName;
  const preview = escapeHtml(content.preview ?? content.headline);
  const cta = content.ctaText && content.ctaUrl
    ? `
      <mj-text align="center" padding="0 0 30px 0" font-family="Inter, 'Roboto', sans-serif">
        <a href="${content.ctaUrl}" class="premium-button" style="background: linear-gradient(135deg, #D4AF37 0%, #F4D03F 50%, #D4AF37 100%); color: #1A1A1A; text-decoration: none; padding: 18px 40px; border-radius: 6px; font-weight: 600; font-size: 16px; display: inline-block; letter-spacing: 1px; text-transform: uppercase; box-shadow: 0px 4px 15px rgba(212, 175, 55, 0.3); border: 1px solid #D4AF37; white-space: nowrap;">
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
          .greeting { color: #D4AF37 !important; }
          .headline { color: #FFFFFF !important; }
          .gold-divider p { border-top-width: 2px !important; }
          .body-text, .body-text * { font-size: 15px; color: #FFFFFF !important; line-height: 1.65; font-weight: 300; }
          .fine-print { font-size: 13px; color: #A0A0A0 !important; line-height: 1.5; }
        </mj-style>

        <mj-style>
          @media only screen and (max-width:600px) {
            .greeting div { font-size: 22px !important; }
            .headline div { font-size: 18px !important; }
            .gold-divider p { border-top-width: 1px !important; }
            .body-text, .body-text * { font-size: 14px !important; }
            .fine-print { font-size: 12px !important; }
          }
        </mj-style>
      </mj-head>

      <mj-body width="600px" background-color="#0A0A0A">
        ${Band(
          `
          <mj-image src="https://grahamy.com/assets/logo_horizontal-C-hWewqw.png"
            alt="Grahamy" width="200px" align="center" padding="0" />
        `,
          "56px 20px 28px 20px"
        )}

        ${Band(
          `
          <mj-divider css-class="gold-divider" border-width="2px" border-style="solid" border-color="#D4AF37" padding="0" />
        `,
          "0 40px 36px 40px"
        )}

        ${Band(
          `
          <mj-text
            css-class="greeting"
            align="center"
            padding="0"
            color="#D4AF37"
            font-size="42px"
            line-height="1.15"
            font-weight="300"
            letter-spacing="1px">
            ${greeting}
          </mj-text>
        `,
          "0 20px 40px 20px"
        )}

        ${Box(
          `
          <mj-text
            css-class="headline"
            align="center"
            padding="0 0 20px 0"
            color="#FFFFFF"
            font-size="24px"
            line-height="1.3"
            font-weight="500"
            letter-spacing="0.5px">
            ${escapeHtml(content.headline)}
          </mj-text>

          <mj-text
            css-class="body-text"
            align="center"
            padding="0 0 20px 0"
            color="#FFFFFF"
            font-size="15px"
            line-height="1.65"
            font-weight="300">
            ${content.bodyHtml}
          </mj-text>

          ${cta}

          <mj-divider border-width="1px" border-style="solid" border-color="#333333" padding="20px 0" />
        `,
          "30px 20px",
          "40px"
        )}

        ${Band(
          `
          <mj-image src="https://grahamy.com/assets/logo-ECjQnHu_.png"
            alt="" width="36px" align="center" padding="32px 0 14px 0" />

          <mj-text css-class="fine-print" align="center" padding="0 0 6px 0" color="#999999">
            ${strings.supportPrefix}
          </mj-text>

          <mj-text css-class="fine-print" align="center" padding="6px 0 6px 0" color="#999999">
            <a href="mailto:office@grahamy.com" style="color: #D4AF37; text-decoration: none;">office@grahamy.com</a>
          </mj-text>

          <mj-divider border-width="1px" border-style="solid" border-color="#333333" padding="20px 0" />

          <mj-text css-class="fine-print" align="center" padding="0" color="#666666">
            ${strings.copyright}
          </mj-text>
        `,
          "0 20px 30px 20px"
        )}

        ${Band(`<mj-text>&nbsp;</mj-text>`, "10px 16px")}
      </mj-body>
    </mjml>
  `);
};
