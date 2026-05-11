import { tool } from "@langchain/core/tools";
import { z } from "zod";
import MailComposer from "nodemailer/lib/mail-composer";
import { resolveScopedSubject } from "../google/authz";
import { fetchAsSubject, DWDNotConfiguredError } from "../google/dwdClient";
import { genericMessageTemplate } from "../emailTemplates/genericMessage";
import {
  financialNewsNewsletterTemplate,
  type FinancialNewsEvent,
} from "../emailTemplates/financialNewsNewsletter";
import {
  generateTop20StocksNewsletter,
  type Top20Stock,
} from "../emailTemplates/top20StocksNewsletter";
import { queryExternalReadonly } from "../utils/externalReadonlyDb";
import { logger } from "../logger";

/**
 * Google tools — calendar, drive, gmail — gated by the `agent_user_scopes`
 * table. Every tool takes an explicit `subjectEmail`: the email of the *owner
 * of the data*, not the caller. Before each call we look up the user by
 * `userName` (= workspace email), check
 * `AgentUserScope.findOne({ agentId: authorityAgentId, subjectUserId, scope })`,
 * and impersonate the subject via DWD only on allow.
 *
 * `authorityAgentId` is the agent whose grants apply. For the primary chat
 * graph this is the agent the user is talking to; for deep agents (including
 * the google_workspace_agent) it is the caller agent, because executor/system
 * agents do not own grants.
 */

const CALENDAR_READ = "https://www.googleapis.com/auth/calendar.readonly";
const CALENDAR_WRITE = "https://www.googleapis.com/auth/calendar.events";
const DRIVE_READ = "https://www.googleapis.com/auth/drive.readonly";
const DRIVE_WRITE = "https://www.googleapis.com/auth/drive.file";
const GMAIL_READ = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";

function formatError(err: unknown): string {
  if (err instanceof DWDNotConfiguredError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

async function authorizeOrError(
  authorityAgentId: string,
  subjectEmail: string,
  scope: Parameters<typeof resolveScopedSubject>[2],
): Promise<{ email: string } | { error: string }> {
  const result = await resolveScopedSubject(authorityAgentId, subjectEmail, scope);
  if (!result.ok) return { error: result.reason };
  return { email: result.email };
}

function b64url(input: string | Buffer): string {
  const encoded = typeof input === "string"
    ? Buffer.from(input, "utf8").toString("base64")
    : input.toString("base64");

  return encoded
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const publicHttpsUrlSchema = z.string().trim().url().refine(
  (url) => url.startsWith("https://"),
  "Must be a public HTTPS URL.",
);

const financialNewsEventImageSchema = z.object({
  src: publicHttpsUrlSchema.describe("Public HTTPS image URL for the story."),
  alt: z.string().trim().min(1).optional().describe("Short accessible image description."),
  href: publicHttpsUrlSchema.optional().describe("Optional HTTPS URL to open if the reader clicks the image."),
  width: z.number().int().positive().optional().describe(
    "Optional source image width from research. Accepted for compatibility with the newsletter skill; not rendered.",
  ),
  height: z.number().int().positive().optional().describe(
    "Optional source image height from research. Accepted for compatibility with the newsletter skill; not rendered.",
  ),
  aspectRatio: z.string().trim().min(1).optional().describe(
    "Optional source image aspect ratio from research, for example '2.4:1'. Accepted but not rendered.",
  ),
  imageSuitability: z.string().trim().min(1).optional().describe(
    "Optional research note explaining why the image fits the email crop. Accepted but not rendered.",
  ),
}).passthrough();

const financialNewsEventSchema = z.object({
  title: z.string().min(1).describe("Short story label, such as 'Asia-Pacific Markets' or 'Central Banks'."),
  headline: z.string().min(1).describe("Main story headline shown prominently in the newsletter card."),
  content: z.string().min(1).describe(
    "Plain-text story body. Do not pass HTML. Use concise paragraphs; line breaks are preserved.",
  ),
  image: z.union([publicHttpsUrlSchema, financialNewsEventImageSchema]).nullish().describe(
    "Optional public HTTPS image URL, or an object with src/alt/href plus optional width/height/aspectRatio/imageSuitability metadata. Use null or omit when no suitable image exists.",
  ),
  region: z.string().optional().describe("Optional geographic or market region label."),
  sourceName: z.string().optional().describe("Optional source or desk name to show under the headline."),
  sourceUrl: z.string().url().optional().describe("Optional source URL linked in the story metadata."),
});

type FinancialNewsEventInput = z.infer<typeof financialNewsEventSchema>;

function normalizeFinancialNewsEventImage(image: FinancialNewsEventInput["image"]): FinancialNewsEvent["image"] | undefined {
  if (!image) return undefined;
  if (typeof image === "string") {
    const src = image.trim();
    return src ? { src } : undefined;
  }

  const src = image.src.trim();
  if (!src) return undefined;

  const alt = image.alt?.trim();
  const href = image.href?.trim();

  return {
    src,
    ...(alt ? { alt } : {}),
    ...(href ? { href } : {}),
  };
}

function normalizeFinancialNewsEvents(newsEvents: FinancialNewsEventInput[]): FinancialNewsEvent[] {
  return newsEvents.map((event) => {
    const image = normalizeFinancialNewsEventImage(event.image);
    return {
      title: event.title,
      headline: event.headline,
      content: event.content,
      ...(image ? { image } : {}),
      ...(event.region ? { region: event.region } : {}),
      ...(event.sourceName ? { sourceName: event.sourceName } : {}),
      ...(event.sourceUrl ? { sourceUrl: event.sourceUrl } : {}),
    };
  });
}

const top20StockSchema: z.ZodType<Top20Stock> = z.object({
  rank: z.number().int().min(1).max(20).describe("Rank position in the top 20 list (1-20)."),
  symbol: z.string().trim().min(1).describe("Ticker symbol, for example 'AAPL'."),
  company: z.string().trim().min(1).describe("Company name."),
  sector: z.string().trim().min(1).describe("Sector classification."),
  industry: z.string().trim().min(1).describe("Industry classification."),
  bucket: z.enum(["standard", "cyclical", "financial"]).describe(
    "Valuation bucket; controls the colored badge on the stock card.",
  ),
  price: z.number().describe("Latest close price in USD."),
  marketCapM: z.number().describe("Market capitalization in millions of USD."),
  avgVolume: z.number().describe("Average daily trading volume (shares)."),
  peTtm: z.number().describe("Trailing twelve months P/E ratio."),
  cape: z.number().describe("Cyclically adjusted P/E (Shiller CAPE)."),
  pb: z.number().describe("Price-to-book ratio."),
  roe: z.number().describe("Return on equity as a percent value (e.g. 18.4 for 18.4%)."),
  piotroski: z.number().int().min(0).max(9).describe("Piotroski F-score (0-9)."),
  scores: z.object({
    v: z.number().describe("Value sub-score."),
    q: z.number().describe("Quality sub-score."),
    h: z.number().describe("Health sub-score."),
    g: z.number().describe("Growth sub-score."),
    m: z.number().describe("Momentum sub-score."),
    total: z.number().describe("Composite total score; highlighted on the card."),
  }),
  flags: z.object({
    hol: z.boolean().describe("HOL flag (rendered as the HOL badge when true)."),
    mpk: z.boolean().describe("MPK flag (rendered as the MPK badge when true)."),
    hm: z.boolean().describe("HM flag (rendered as the HM badge when true)."),
    bio: z.boolean().describe("BIO flag (rendered as the BIO badge when true)."),
    rng: z.boolean().describe("RNG flag (rendered as the RNG badge when true)."),
    drd: z.boolean().describe("DRD flag (rendered as the DRD badge when true)."),
  }),
});

type NewsletterRegistrationRow = Record<string, unknown> & {
  id: unknown;
  email: unknown;
};

const newsletterRecipientEmailSchema = z.string().trim().email();

async function loadNewsletterRecipientEmails(): Promise<string[]> {
  const rows = await queryExternalReadonly<NewsletterRegistrationRow>(
    "SELECT id, email FROM newsletter_registrations",
  );

  const recipients: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (typeof row.email !== "string") continue;

    const parsed = newsletterRecipientEmailSchema.safeParse(row.email);
    if (!parsed.success) {
      logger.warn("Skipping invalid newsletter registration email", {
        id: row.id,
        email: row.email,
      });
      continue;
    }

    const email = parsed.data;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push(email);
  }

  return recipients;
}

export function googleTools(authorityAgentId: string) {
  // ── Calendar ────────────────────────────────────────────────────────

  const listCalendarEvents = tool(
    async ({ subjectEmail, timeMin, timeMax, maxResults }) => {
      const authz = await authorizeOrError(authorityAgentId, subjectEmail, "calendar.read");
      if ("error" in authz) return authz.error;
      try {
        const params = new URLSearchParams({
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: String(maxResults ?? 25),
        });
        if (timeMin) params.set("timeMin", timeMin);
        if (timeMax) params.set("timeMax", timeMax);
        const res = await fetchAsSubject(
          authz.email,
          [CALENDAR_READ],
          `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
        );
        const json = (await res.json()) as { items?: any[] };
        const items = (json.items ?? []).map((e) => ({
          id: e.id,
          summary: e.summary,
          start: e.start,
          end: e.end,
          attendees: e.attendees?.map((a: any) => a.email),
          hangoutLink: e.hangoutLink,
          htmlLink: e.htmlLink,
        }));
        return JSON.stringify({ count: items.length, events: items });
      } catch (err) {
        logger.warn("googleTools list_calendar_events failed", {
          authorityAgentId,
          subjectEmail,
          error: formatError(err),
        });
        return `Error listing calendar events: ${formatError(err)}`;
      }
    },
    {
      name: "google_list_calendar_events",
      description:
        "List upcoming events from another user's primary Google Calendar. Requires " +
        "a 'calendar.read' grant on the subject user. Returns JSON with start/end/attendees. " +
        "Times are ISO 8601 (e.g. '2026-04-20T00:00:00Z').",
      schema: z.object({
        subjectEmail: z.string().email().describe("Email of the user whose calendar to read."),
        timeMin: z.string().optional().describe("Lower bound (ISO 8601). Defaults to now."),
        timeMax: z.string().optional().describe("Upper bound (ISO 8601)."),
        maxResults: z.number().int().min(1).max(250).optional(),
      }),
    },
  );

  const createCalendarEvent = tool(
    async ({ subjectEmail, summary, startIso, endIso, description, attendees, timeZone }) => {
      const authz = await authorizeOrError(authorityAgentId, subjectEmail, "calendar.write");
      if ("error" in authz) return authz.error;
      try {
        const body = {
          summary,
          description,
          start: { dateTime: startIso, timeZone: timeZone ?? "UTC" },
          end: { dateTime: endIso, timeZone: timeZone ?? "UTC" },
          attendees: attendees?.map((email) => ({ email })),
        };
        const res = await fetchAsSubject(
          authz.email,
          [CALENDAR_WRITE],
          "https://www.googleapis.com/calendar/v3/calendars/primary/events",
          { method: "POST", body: JSON.stringify(body) },
        );
        const json = (await res.json()) as { id?: string; htmlLink?: string };
        return JSON.stringify({ ok: true, id: json.id, htmlLink: json.htmlLink });
      } catch (err) {
        logger.warn("googleTools create_calendar_event failed", {
          authorityAgentId,
          subjectEmail,
          error: formatError(err),
        });
        return `Error creating calendar event: ${formatError(err)}`;
      }
    },
    {
      name: "google_create_calendar_event",
      description:
        "Create an event on another user's primary Google Calendar. Requires a " +
        "'calendar.write' grant on the subject user. Start/end must be ISO 8601.",
      schema: z.object({
        subjectEmail: z.string().email().describe("Email of the user whose calendar to write."),
        summary: z.string().min(1),
        startIso: z.string().describe("Start time, ISO 8601 (e.g. '2026-04-20T14:00:00-07:00')."),
        endIso: z.string().describe("End time, ISO 8601."),
        description: z.string().optional(),
        attendees: z.array(z.string().email()).optional(),
        timeZone: z.string().optional().describe("IANA tz, e.g. 'America/Los_Angeles'."),
      }),
    },
  );

  // ── Drive ──────────────────────────────────────────────────────────

  const listDriveFiles = tool(
    async ({ subjectEmail, query, pageSize }) => {
      const authz = await authorizeOrError(authorityAgentId, subjectEmail, "drive.read");
      if ("error" in authz) return authz.error;
      try {
        const params = new URLSearchParams({
          pageSize: String(pageSize ?? 25),
          fields: "files(id,name,mimeType,modifiedTime,owners(emailAddress))",
        });
        if (query) params.set("q", query);
        const res = await fetchAsSubject(
          authz.email,
          [DRIVE_READ],
          `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
        );
        const json = (await res.json()) as { files?: any[] };
        return JSON.stringify({ count: json.files?.length ?? 0, files: json.files ?? [] });
      } catch (err) {
        return `Error listing drive files: ${formatError(err)}`;
      }
    },
    {
      name: "google_list_drive_files",
      description:
        "List files visible in another user's Google Drive. Requires a 'drive.read' grant. " +
        "Supports Drive search syntax in the 'query' arg (e.g. \"name contains 'report'\").",
      schema: z.object({
        subjectEmail: z.string().email().describe("Email of the user whose drive to list."),
        query: z.string().optional(),
        pageSize: z.number().int().min(1).max(1000).optional(),
      }),
    },
  );

  const readDriveFile = tool(
    async ({ subjectEmail, fileId }) => {
      const authz = await authorizeOrError(authorityAgentId, subjectEmail, "drive.read");
      if ("error" in authz) return authz.error;
      try {
        // First fetch metadata to learn the mimeType, then pick the right
        // endpoint. Google Docs need /export; everything else uses ?alt=media.
        const metaRes = await fetchAsSubject(
          authz.email,
          [DRIVE_READ],
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType`,
        );
        const meta = (await metaRes.json()) as { name: string; mimeType: string };

        let contentUrl: string;
        if (meta.mimeType === "application/vnd.google-apps.document") {
          contentUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=text/plain`;
        } else if (meta.mimeType === "application/vnd.google-apps.spreadsheet") {
          contentUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=text/csv`;
        } else if (meta.mimeType.startsWith("text/") || meta.mimeType === "application/json") {
          contentUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
        } else {
          return `File "${meta.name}" has mimeType ${meta.mimeType} which is not directly readable as text. Use a different tool or export it manually.`;
        }

        const contentRes = await fetchAsSubject(authz.email, [DRIVE_READ], contentUrl);
        const text = await contentRes.text();
        return JSON.stringify({ name: meta.name, mimeType: meta.mimeType, content: text });
      } catch (err) {
        return `Error reading drive file: ${formatError(err)}`;
      }
    },
    {
      name: "google_read_drive_file",
      description:
        "Read the text content of a Google Drive file owned by another user. Requires " +
        "a 'drive.read' grant. Google Docs are exported as plain text; Sheets as CSV. " +
        "Binary formats (images, PDFs) are rejected.",
      schema: z.object({
        subjectEmail: z.string().email().describe("Email of the user who owns the file."),
        fileId: z.string().min(1),
      }),
    },
  );

  const writeDriveTextFile = tool(
    async ({ subjectEmail, name, content, mimeType }) => {
      const authz = await authorizeOrError(authorityAgentId, subjectEmail, "drive.write");
      if ("error" in authz) return authz.error;
      try {
        // Multipart upload: one JSON metadata part + one media part.
        const boundary = `boundary-${Date.now()}`;
        const metaPart = JSON.stringify({ name, mimeType: mimeType ?? "text/plain" });
        const body =
          `--${boundary}\r\n` +
          `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
          metaPart + `\r\n` +
          `--${boundary}\r\n` +
          `Content-Type: ${mimeType ?? "text/plain"}\r\n\r\n` +
          content + `\r\n` +
          `--${boundary}--`;
        const res = await fetchAsSubject(
          authz.email,
          [DRIVE_WRITE],
          "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
          {
            method: "POST",
            headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
            body,
          },
        );
        const json = (await res.json()) as { id?: string; name?: string };
        return JSON.stringify({ ok: true, id: json.id, name: json.name });
      } catch (err) {
        return `Error writing drive file: ${formatError(err)}`;
      }
    },
    {
      name: "google_write_drive_file",
      description:
        "Create a new text file in another user's Google Drive. Requires a 'drive.write' " +
        "grant. Only creates files the agent has scoped access to (drive.file scope) — " +
        "cannot modify pre-existing files the subject owns unless they were created via " +
        "this tool.",
      schema: z.object({
        subjectEmail: z.string().email().describe("Email of the user who will own the new file."),
        name: z.string().min(1),
        content: z.string(),
        mimeType: z.string().optional().describe("Defaults to text/plain."),
      }),
    },
  );

  // ── Gmail ──────────────────────────────────────────────────────────

  const listGmailMessages = tool(
    async ({ subjectEmail, query, maxResults }) => {
      const authz = await authorizeOrError(authorityAgentId, subjectEmail, "gmail.read");
      if ("error" in authz) return authz.error;
      try {
        const params = new URLSearchParams({
          maxResults: String(maxResults ?? 10),
        });
        if (query) params.set("q", query);
        const listRes = await fetchAsSubject(
          authz.email,
          [GMAIL_READ],
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`,
        );
        const listJson = (await listRes.json()) as { messages?: { id: string }[] };
        const ids = (listJson.messages ?? []).map((m) => m.id);

        // Metadata-only fetch per message so we don't pull bodies (fast +
        // cheap + the agent rarely needs bodies in a list view).
        const details = await Promise.all(
          ids.slice(0, 10).map(async (id) => {
            const r = await fetchAsSubject(
              authz.email,
              [GMAIL_READ],
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
            );
            const j = (await r.json()) as { payload?: { headers?: { name: string; value: string }[] }; snippet?: string };
            const headers = j.payload?.headers ?? [];
            const get = (n: string) => headers.find((h) => h.name === n)?.value ?? null;
            return { id, subject: get("Subject"), from: get("From"), date: get("Date"), snippet: j.snippet };
          }),
        );
        return JSON.stringify({ count: details.length, messages: details });
      } catch (err) {
        return `Error listing gmail messages: ${formatError(err)}`;
      }
    },
    {
      name: "google_list_gmail_messages",
      description:
        "List recent Gmail messages for another user. Requires a 'gmail.read' grant. " +
        "Supports Gmail search syntax in 'query' (e.g. 'from:boss@x.com after:2026/04/01').",
      schema: z.object({
        subjectEmail: z.string().email().describe("Email of the user whose inbox to list."),
        query: z.string().optional(),
        maxResults: z.number().int().min(1).max(50).optional(),
      }),
    },
  );

  const sendGmail = tool(
    async ({ subjectEmail, to, cc, bcc, subject, recipientName, headline, bodyHtml, ctaText, ctaUrl, fromName, language }) => {
      if ((ctaText && !ctaUrl) || (ctaUrl && !ctaText)) {
        return "Error sending gmail: 'ctaText' and 'ctaUrl' must be provided together.";
      }
      const authz = await authorizeOrError(authorityAgentId, subjectEmail, "gmail.send");
      if ("error" in authz) return authz.error;
      try {
        const html = genericMessageTemplate({
          recipientName,
          headline,
          bodyHtml,
          ctaText,
          ctaUrl,
          preview: subject,
          language,
        });
        const composer = new MailComposer({
          from: `${fromName ?? "Grahamy"} <${authz.email}>`,
          to,
          cc,
          bcc,
          subject,
          html,
        });
        const mime = await composer.compile().build();
        const raw = b64url(mime);
        const res = await fetchAsSubject(
          authz.email,
          [GMAIL_SEND],
          "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
          { method: "POST", body: JSON.stringify({ raw }) },
        );
        const json = (await res.json()) as { id?: string; threadId?: string };
        return JSON.stringify({ ok: true, id: json.id, threadId: json.threadId });
      } catch (err) {
        logger.warn("googleTools send_gmail failed", {
          authorityAgentId,
          subjectEmail,
          error: formatError(err),
        });
        return `Error sending gmail: ${formatError(err)}`;
      }
    },
    {
      name: "google_send_gmail",
      description:
        "Send a Grahamy-branded HTML email from another user's Gmail account. Requires a " +
        "'gmail.send' grant. The 'From' address is always the subject user (only the display " +
        "name is configurable via 'fromName') — you cannot spoof other senders. The body is " +
        "always rendered through the shared generic MJML template: pass 'headline' and " +
        "'bodyHtml' (HTML allowed inside the message body), and optionally a CTA button via " +
        "'ctaText' + 'ctaUrl'.",
      schema: z.object({
        subjectEmail: z.string().email().describe("Email of the user whose Gmail account sends the message."),
        to: z.array(z.string().email()).min(1),
        cc: z.array(z.string().email()).optional(),
        bcc: z.array(z.string().email()).optional(),
        subject: z.string().min(1),
        recipientName: z.string().optional().describe(
          "Display name of the PERSON RECEIVING this email (i.e. the human listed in 'to'), " +
          "used as the greeting at the top: 'Hello, <recipientName>'. NOT the sender's name " +
          "and NOT the agent's name. If you don't know the recipient's name, omit this field " +
          "and the greeting will fall back to a generic 'Hello'.",
        ),
        headline: z.string().min(1).describe("Main headline shown at the top of the message card."),
        bodyHtml: z.string().min(1).describe("Message body. Inline HTML (e.g. <strong>, <a>, <br/>) is allowed."),
        ctaText: z.string().optional().describe("Label for the CTA button. Required if 'ctaUrl' is set."),
        ctaUrl: z.string().url().optional().describe("Target URL for the CTA button. Required if 'ctaText' is set."),
        fromName: z.string().optional().describe("Display name for the From header. Defaults to 'Grahamy'."),
        language: z.enum(["en", "he"]).optional().describe(
          "Language for the email's fixed chrome (greeting, support line, copyright) and " +
          "default text direction. 'he' renders the email RTL with Hebrew strings " +
          "(שלום, זקוקים לסיוע..., כל הזכויות שמורות); 'en' is LTR English. " +
          "Defaults to 'en'. Pick this based on the language of the recipient.",
        ),
      }),
    },
  );

  const sendFinancialNewsNewsletter = tool(
    async ({
      subjectEmail,
      cc,
      bcc,
      subject,
      recipientName,
      newsletterTitle,
      newsletterHeadline,
      intro,
      issuedAt,
      preview,
      newsEvents,
      ctaText,
      ctaUrl,
      fromName,
      direction,
    }) => {
      if ((ctaText && !ctaUrl) || (ctaUrl && !ctaText)) {
        return "Error sending financial newsletter: 'ctaText' and 'ctaUrl' must be provided together.";
      }

      const authz = await authorizeOrError(authorityAgentId, subjectEmail, "gmail.send");
      if ("error" in authz) return authz.error;

      try {
        const recipients = await loadNewsletterRecipientEmails();
        if (recipients.length === 0) {
          return "Error sending financial newsletter: no valid emails found in newsletter_registrations.";
        }

        const normalizedNewsEvents = normalizeFinancialNewsEvents(newsEvents);

        const html = financialNewsNewsletterTemplate({
          recipientName,
          newsletterTitle,
          newsletterHeadline,
          intro,
          issuedAt,
          preview: preview ?? subject,
          newsEvents: normalizedNewsEvents,
          ctaText,
          ctaUrl,
          direction,
        });

        const composer = new MailComposer({
          from: `${fromName ?? "Grahamy Markets"} <${authz.email}>`,
          to: recipients,
          cc,
          bcc,
          subject,
          html,
        });
        const mime = await composer.compile().build();
        const raw = b64url(mime);
        const res = await fetchAsSubject(
          authz.email,
          [GMAIL_SEND],
          "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
          { method: "POST", body: JSON.stringify({ raw }) },
        );
        const json = (await res.json()) as { id?: string; threadId?: string };
        return JSON.stringify({
          ok: true,
          id: json.id,
          threadId: json.threadId,
          newsEventCount: normalizedNewsEvents.length,
          recipientCount: recipients.length,
        });
      } catch (err) {
        logger.warn("googleTools send_financial_newsletter failed", {
          authorityAgentId,
          subjectEmail,
          error: formatError(err),
        });
        return `Error sending financial newsletter: ${formatError(err)}`;
      }
    },
    {
      name: "google_send_financial_newsletter",
      description:
        "Send a Grahamy-branded global financial-news newsletter from another user's Gmail account. " +
        "Requires a 'gmail.send' grant. This tool does not fetch news by itself: pass curated, recent " +
        "financial news events in 'newsEvents', each with title, headline, plain-text content, and optional " +
        "image/source metadata. Recipients are loaded automatically from the external database table " +
        "'newsletter_registrations' (email column) and sent in one Gmail message. The 'From' address is " +
        "always the subject user; only the display name is configurable via 'fromName'.",
      schema: z.object({
        subjectEmail: z.string().email().describe("Email of the user whose Gmail account sends the newsletter."),
        cc: z.array(z.string().email()).optional(),
        bcc: z.array(z.string().email()).optional(),
        subject: z.string().min(1).describe("Email subject line."),
        recipientName: z.string().optional().describe(
          "Display name of the PERSON RECEIVING this email. If omitted, the newsletter uses a generic greeting.",
        ),
        newsletterTitle: z.string().optional().describe("Newsletter masthead. Defaults to 'Global Financial News'."),
        newsletterHeadline: z.string().optional().describe(
          "Top summary line under the masthead. Defaults to a recent global market-news headline.",
        ),
        intro: z.string().optional().describe("Optional plain-text introductory note shown before the news cards."),
        issuedAt: z.string().optional().describe(
          "Human-readable issue label, for example 'May 5, 2026' or 'Tuesday Market Brief'.",
        ),
        preview: z.string().optional().describe("Inbox preview text. Defaults to the email subject."),
        newsEvents: z.array(financialNewsEventSchema).min(1).max(12).describe(
          "Curated recent financial news events. The first item is rendered as the lead story.",
        ),
        ctaText: z.string().optional().describe("Optional CTA button label. Required if 'ctaUrl' is set."),
        ctaUrl: z.string().url().optional().describe("Optional CTA button target URL. Required if 'ctaText' is set."),
        fromName: z.string().optional().describe("Display name for the From header. Defaults to 'Grahamy Markets'."),
        direction: z.enum(["ltr", "rtl"]).optional().describe("Layout direction. Defaults to 'ltr'."),
      }),
    },
  );

  const sendTop20StocksNewsletter = tool(
    async ({
      subjectEmail,
      cc,
      bcc,
      subject,
      recipientName,
      asOfDate,
      sp500_12w_pct,
      stocks,
      ctaText,
      ctaUrl,
      fromName,
    }) => {
      if ((ctaText && !ctaUrl) || (ctaUrl && !ctaText)) {
        return "Error sending top 20 stocks newsletter: 'ctaText' and 'ctaUrl' must be provided together.";
      }

      const authz = await authorizeOrError(authorityAgentId, subjectEmail, "gmail.send");
      if ("error" in authz) return authz.error;

      try {
        const recipients = await loadNewsletterRecipientEmails();
        if (recipients.length === 0) {
          return "Error sending top 20 stocks newsletter: no valid emails found in newsletter_registrations.";
        }

        const html = generateTop20StocksNewsletter({
          recipientName,
          asOfDate,
          sp500_12w_pct: sp500_12w_pct ?? null,
          stocks,
          ctaText,
          ctaUrl,
        });

        const composer = new MailComposer({
          from: `${fromName ?? "Grahamy Markets"} <${authz.email}>`,
          to: recipients,
          cc,
          bcc,
          subject,
          html,
        });
        const mime = await composer.compile().build();
        const raw = b64url(mime);
        const res = await fetchAsSubject(
          authz.email,
          [GMAIL_SEND],
          "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
          { method: "POST", body: JSON.stringify({ raw }) },
        );
        const json = (await res.json()) as { id?: string; threadId?: string };
        return JSON.stringify({
          ok: true,
          id: json.id,
          threadId: json.threadId,
          stockCount: stocks.length,
          recipientCount: recipients.length,
        });
      } catch (err) {
        logger.warn("googleTools send_top20_stocks_newsletter failed", {
          authorityAgentId,
          subjectEmail,
          error: formatError(err),
        });
        return `Error sending top 20 stocks newsletter: ${formatError(err)}`;
      }
    },
    {
      name: "google_send_top20_stocks_newsletter",
      description:
        "Send a Grahamy-branded 'Top 20 Attractive Stocks' newsletter from another user's Gmail account. " +
        "Requires a 'gmail.send' grant. This tool does not screen or fetch stock data by itself: pass the " +
        "ranked list of 20 stocks in 'stocks', each with full metrics, sub-scores, and flag booleans, plus " +
        "the report 'asOfDate' and optional 'sp500_12w_pct'. Recipients are loaded automatically from the " +
        "external database table 'newsletter_registrations' (email column) and sent in one Gmail message. " +
        "The 'From' address is always the subject user; only the display name is configurable via 'fromName'.",
      schema: z.object({
        subjectEmail: z.string().email().describe("Email of the user whose Gmail account sends the newsletter."),
        cc: z.array(z.string().email()).optional(),
        bcc: z.array(z.string().email()).optional(),
        subject: z.string().min(1).describe("Email subject line."),
        recipientName: z.string().optional().describe(
          "Reserved for future personalized greeting. Currently not rendered by the template.",
        ),
        asOfDate: z.string().min(1).describe(
          "Human-readable report date shown in the header, for example 'May 11, 2026'.",
        ),
        sp500_12w_pct: z.number().nullish().describe(
          "Optional S&P 500 12-week change in percent (e.g. 4.2 for +4.2%, -1.5 for -1.5%). " +
          "Omit or pass null to hide the S&P 500 line.",
        ),
        stocks: z.array(top20StockSchema).min(1).max(20).describe(
          "Ranked list of stocks to render as cards, in display order. Up to 20 entries.",
        ),
        ctaText: z.string().optional().describe("Optional CTA button label. Required if 'ctaUrl' is set."),
        ctaUrl: z.string().url().optional().describe("Optional CTA button target URL. Required if 'ctaText' is set."),
        fromName: z.string().optional().describe("Display name for the From header. Defaults to 'Grahamy Markets'."),
      }),
    },
  );

  return [
    listCalendarEvents,
    createCalendarEvent,
    listDriveFiles,
    readDriveFile,
    writeDriveTextFile,
    listGmailMessages,
    sendGmail,
    sendFinancialNewsNewsletter,
    sendTop20StocksNewsletter,
  ];
}
