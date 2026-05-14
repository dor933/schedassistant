import type { NewsletterIssueType } from "@scheduling-agent/database";

export type { NewsletterIssueType };

export function normalizeNewsletterIssueType(input: string): NewsletterIssueType | null {
  const key = input.trim().toLowerCase().replace(/[\s-]+/g, "_");
  switch (key) {
    case "top20":
    case "top_20":
    case "top20_stocks":
    case "top_20_stocks":
    case "top20_stocks_newsletter":
    case "top_20_stocks_newsletter":
      return "top20_stocks";
    case "news":
    case "financial":
    case "financial_news":
    case "financial_newsletter":
    case "global_financial_news":
      return "financial_news";
    default:
      return null;
  }
}

export function currentUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function normalizeIssueDate(input: string | undefined | null): string {
  const trimmed = input?.trim();
  if (!trimmed) return currentUtcDate();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  throw new Error("issueDate must use YYYY-MM-DD format.");
}

export function compactSummary(input: string | undefined | null, maxChars = 3000): string | null {
  const trimmed = input?.trim();
  if (!trimmed) return null;
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}...` : trimmed;
}
