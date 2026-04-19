import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { resolveScopedSubject } from "../google/authz";
import { fetchAsSubject, DWDNotConfiguredError } from "../google/dwdClient";
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

function b64url(s: string): string {
  return Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
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
    async ({ subjectEmail, to, subject, body }) => {
      const authz = await authorizeOrError(authorityAgentId, subjectEmail, "gmail.send");
      if ("error" in authz) return authz.error;
      try {
        const raw = b64url(
          `To: ${to.join(", ")}\r\n` +
          `From: ${authz.email}\r\n` +
          `Subject: ${subject}\r\n` +
          `Content-Type: text/plain; charset="UTF-8"\r\n` +
          `MIME-Version: 1.0\r\n\r\n` +
          body,
        );
        const res = await fetchAsSubject(
          authz.email,
          [GMAIL_SEND],
          "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
          { method: "POST", body: JSON.stringify({ raw }) },
        );
        const json = (await res.json()) as { id?: string; threadId?: string };
        return JSON.stringify({ ok: true, id: json.id, threadId: json.threadId });
      } catch (err) {
        return `Error sending gmail: ${formatError(err)}`;
      }
    },
    {
      name: "google_send_gmail",
      description:
        "Send an email from another user's Gmail account. Requires a 'gmail.send' grant. " +
        "The 'From' address is always the subject user — you cannot spoof other senders.",
      schema: z.object({
        subjectEmail: z.string().email().describe("Email of the user whose Gmail account sends the message."),
        to: z.array(z.string().email()).min(1),
        subject: z.string().min(1),
        body: z.string().min(1),
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
  ];
}
