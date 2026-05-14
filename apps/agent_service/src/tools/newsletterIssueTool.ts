import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Agent, NewsletterIssue } from "@scheduling-agent/database";
import { logger } from "../logger";
import {
  compactSummary,
  normalizeIssueDate,
  normalizeNewsletterIssueType,
} from "../services/newsletterIssue.service";

const issueTypeSchema = z.string().min(1).describe(
  "Newsletter type. Accepted values/aliases: 'top20_stocks', 'top20', 'top_20', 'financial_news', 'news'.",
);

const metadataSchema = z.record(z.unknown()).optional().describe(
  "Optional structured metadata, for example recipient counts or Gmail send identifiers.",
);

async function organizationIdForAgent(agentId: string): Promise<string | null> {
  const agent = await Agent.findByPk(agentId, {
    attributes: ["id", "organizationId"],
  });
  return agent?.organizationId ?? null;
}

function parseSentAt(sentAt: string | undefined | null, status: string | undefined): Date | null {
  if (!sentAt?.trim()) return status === "sent" || status === undefined ? new Date() : null;
  const date = new Date(sentAt);
  if (Number.isNaN(date.getTime())) {
    throw new Error("sentAt must be a valid ISO date-time string.");
  }
  return date;
}

export function RecordNewsletterIssueTool(agentId: string | null | undefined) {
  return tool(
    async (input) => {
      if (!agentId) {
        return "Error: this agent has no ID, so newsletter issues cannot be scoped to an organization.";
      }

      try {
        const normalizedType = normalizeNewsletterIssueType(input.type);
        if (!normalizedType) {
          return "Error: unknown newsletter type. Use 'top20_stocks' or 'financial_news'.";
        }

        const organizationId = await organizationIdForAgent(agentId);
        if (!organizationId) {
          return `Error: agent ${agentId} was not found.`;
        }

        const status = input.status ?? "sent";
        const issueDate = normalizeIssueDate(input.issueDate);
        const sentAt = parseSentAt(input.sentAt, status);

        const issue = await NewsletterIssue.create({
          organizationId,
          type: normalizedType,
          status,
          subject: input.subject?.trim() || null,
          issueDate,
          asOfDate: input.asOfDate?.trim() || null,
          fileUri: input.fileUri,
          htmlUri: input.htmlUri?.trim() || input.fileUri,
          payloadUri: input.payloadUri?.trim() || null,
          summary: compactSummary(input.summary),
          sentMessageId: input.sentMessageId?.trim() || null,
          sentThreadId: input.sentThreadId?.trim() || null,
          createdByAgentId: agentId,
          sentAt,
          metadata: input.metadata ?? {},
        });

        return JSON.stringify({
          ok: true,
          id: issue.id,
          type: issue.type,
          status: issue.status,
          issueDate: issue.issueDate,
          fileUri: issue.fileUri,
          htmlUri: issue.htmlUri,
          payloadUri: issue.payloadUri,
          sentAt: issue.sentAt?.toISOString() ?? null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("record_newsletter_issue failed", {
          agentId,
          error: message,
        });
        return `Error recording newsletter issue: ${message}`;
      }
    },
    {
      name: "record_newsletter_issue",
      description:
        "Create a newsletter issue record after a newsletter file is prepared or sent. " +
        "Use this to persist the latest newsletter path/context for future newsletter runs.",
      schema: z.object({
        type: issueTypeSchema,
        fileUri: z.string().min(1).describe("Canonical path or URI of the latest newsletter file."),
        htmlUri: z.string().optional().describe("Optional rendered HTML path or URI. Defaults to fileUri."),
        payloadUri: z.string().optional().describe("Optional raw payload JSON path or URI."),
        issueDate: z.string().optional().describe("Issue date in YYYY-MM-DD. Defaults to today's UTC date."),
        status: z.enum(["generated", "sent", "failed"]).optional().describe("Issue status. Defaults to 'sent'."),
        subject: z.string().optional().describe("Newsletter email subject or issue title."),
        asOfDate: z.string().optional().describe("Human-readable issue/report date shown in the newsletter."),
        summary: z.string().optional().describe("Short previous-context summary for the next newsletter run."),
        sentMessageId: z.string().optional().describe("Gmail message id returned by the send tool."),
        sentThreadId: z.string().optional().describe("Gmail thread id returned by the send tool."),
        sentAt: z.string().optional().describe("ISO date-time when the newsletter was sent. Defaults to now for sent records."),
        metadata: metadataSchema,
      }),
    },
  );
}

export function UpdateNewsletterIssuePathTool(agentId: string | null | undefined) {
  return tool(
    async (input) => {
      if (!agentId) {
        return "Error: this agent has no ID, so newsletter issues cannot be scoped to an organization.";
      }

      try {
        const organizationId = await organizationIdForAgent(agentId);
        if (!organizationId) {
          return `Error: agent ${agentId} was not found.`;
        }

        let issue: NewsletterIssue | null = null;
        if (input.issueId?.trim()) {
          issue = await NewsletterIssue.findOne({
            where: {
              id: input.issueId.trim(),
              organizationId,
            },
          });
        } else {
          const normalizedType = normalizeNewsletterIssueType(input.type ?? "");
          if (!normalizedType) {
            return "Error: provide issueId, or provide a valid type ('top20_stocks' or 'financial_news').";
          }
          const issueDate = normalizeIssueDate(input.issueDate);
          issue = await NewsletterIssue.findOne({
            where: {
              organizationId,
              type: normalizedType,
              issueDate,
            },
            order: [["createdAt", "DESC"]],
          });
        }

        if (!issue) {
          return JSON.stringify({
            ok: false,
            found: false,
            message: "No matching newsletter issue was found to update.",
          });
        }

        issue.fileUri = input.fileUri;
        issue.htmlUri = input.htmlUri?.trim() || input.fileUri;
        issue.payloadUri = input.payloadUri?.trim() || issue.payloadUri;
        await issue.save();

        return JSON.stringify({
          ok: true,
          id: issue.id,
          type: issue.type,
          issueDate: issue.issueDate,
          fileUri: issue.fileUri,
          htmlUri: issue.htmlUri,
          payloadUri: issue.payloadUri,
          updatedAt: issue.updatedAt.toISOString(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("update_newsletter_issue_path failed", {
          agentId,
          error: message,
        });
        return `Error updating newsletter issue path: ${message}`;
      }
    },
    {
      name: "update_newsletter_issue_path",
      description:
        "Update the file path fields for an existing newsletter issue. " +
        "Use issueId when known; otherwise it updates the latest record for the given type and issueDate. " +
        "This is intended for same-day replacement versions where only the stored path changed.",
      schema: z.object({
        issueId: z.string().optional().describe("Specific newsletter issue id to update. Preferred when known."),
        type: issueTypeSchema.optional(),
        issueDate: z.string().optional().describe("Issue date in YYYY-MM-DD. Defaults to today's UTC date when issueId is omitted."),
        fileUri: z.string().min(1).describe("New canonical path or URI of the latest newsletter file."),
        htmlUri: z.string().optional().describe("Optional new rendered HTML path or URI. Defaults to fileUri."),
        payloadUri: z.string().optional().describe("Optional new raw payload JSON path or URI."),
      }),
    },
  );
}

export function GetLatestNewsletterIssueTool(agentId: string | null | undefined) {
  return tool(
    async ({ type }) => {
      if (!agentId) {
        return "Error: this agent has no ID, so newsletter issues cannot be scoped to an organization.";
      }

      const normalizedType = normalizeNewsletterIssueType(type);
      if (!normalizedType) {
        return "Error: unknown newsletter type. Use 'top20_stocks' or 'financial_news'.";
      }

      try {
        const agent = await Agent.findByPk(agentId, {
          attributes: ["id", "organizationId"],
        });
        if (!agent) {
          return `Error: agent ${agentId} was not found.`;
        }

        const issue = await NewsletterIssue.findOne({
          where: {
            organizationId: agent.organizationId,
            type: normalizedType,
          },
          order: [
            ["issueDate", "DESC"],
            ["createdAt", "DESC"],
          ],
        });

        if (!issue) {
          return JSON.stringify({
            found: false,
            type: normalizedType,
            issueDate: null,
            message: `No archived ${normalizedType} newsletter issue was found for this organization.`,
          });
        }

        return JSON.stringify({
          found: true,
          id: issue.id,
          type: issue.type,
          status: issue.status,
          subject: issue.subject,
          issueDate: issue.issueDate,
          asOfDate: issue.asOfDate,
          fileUri: issue.fileUri,
          htmlUri: issue.htmlUri,
          payloadUri: issue.payloadUri,
          summary: issue.summary,
          sentMessageId: issue.sentMessageId,
          sentThreadId: issue.sentThreadId,
          sentAt: issue.sentAt?.toISOString() ?? null,
          createdAt: issue.createdAt.toISOString(),
          metadata: issue.metadata ?? {},
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("get_latest_newsletter_issue failed", {
          agentId,
          type,
          normalizedType,
          error: message,
        });
        return `Error retrieving latest newsletter issue: ${message}`;
      }
    },
    {
      name: "get_latest_newsletter_issue",
      description:
        "Retrieve the latest archived newsletter issue for this organization by type. " +
        "Use it to get the previous newsletter's file path and summary context before preparing the next newsletter. " +
        "Read-only: it cannot create, edit, or delete newsletter records.",
      schema: z.object({
        type: issueTypeSchema,
      }),
    },
  );
}
