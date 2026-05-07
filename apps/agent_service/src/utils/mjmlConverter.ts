import mjmlImport from "mjml";
import type { MJMLParseResults } from "mjml-core";
import { logger } from "../logger";

// `@types/mjml` (v4) declares the return as `Promise<MJMLParseResults>`, but
// the actual mjml v4 runtime is synchronous. Cast through unknown to fix it.
const mjml2html = mjmlImport as unknown as (
  input: string,
  options?: { validationLevel?: "strict" | "soft" | "skip" },
) => MJMLParseResults;

export function mjmlToHtml(mjmlSource: string): string {
  const result = mjml2html(mjmlSource, { validationLevel: "soft" });
  if (result.errors?.length) {
    logger.warn("mjml compile produced warnings", {
      errors: result.errors.map((e) => ({ line: e.line, message: e.message, tagName: e.tagName })),
    });
  }
  return result.html;
}
