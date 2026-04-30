import fs from "node:fs";
import path from "node:path";
import { queryExternalReadonly } from "../utils/externalReadonlyDb";

export const RESEARCH_QUERY_NAMES = [
  "query_v6a_core_live",
  "query_v6b_sector_aggregates",
  "query_v6c_financial_quality",
  "query_v6a_regime_live",
  "query_v6a_sector_live",
] as const;

export type ResearchQueryName = (typeof RESEARCH_QUERY_NAMES)[number];

const QUERY_FILES: Record<ResearchQueryName, string> = {
  query_v6a_core_live: "query_v6a_core_live.sql",
  query_v6b_sector_aggregates: "query_v6b_sector_aggregates.sql",
  query_v6c_financial_quality: "query_v6c_financial_quality.sql",
  query_v6a_regime_live: "query_v6a_regime_live.sql",
  query_v6a_sector_live: "query_v6a_sector_live.sql",
};

const DEFAULT_QUERIES_DIR = "/home/office/.openclaw/shared-tools/grahamy/queries";

const queryTextCache = new Map<ResearchQueryName, string>();

export async function runResearchQuery<T extends Record<string, unknown>>(
  name: ResearchQueryName,
  replacements: Record<string, unknown>,
): Promise<T | undefined> {
  const rows = await queryExternalReadonly<T>(loadResearchQuery(name), {
    replacements,
    maxRows: 1,
  });
  return rows[0];
}

export function loadResearchQuery(name: ResearchQueryName): string {
  const cached = queryTextCache.get(name);
  if (cached) return cached;

  const filePath = path.join(getQueriesDir(), QUERY_FILES[name]);
  const query = fs.readFileSync(filePath, "utf8");
  queryTextCache.set(name, query);
  return query;
}

export function getQueriesDir(): string {
  return process.env.GRAHAMY_QUERIES_DIR || DEFAULT_QUERIES_DIR;
}
