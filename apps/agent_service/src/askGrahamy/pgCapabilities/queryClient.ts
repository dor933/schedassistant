import fs from "node:fs";
import path from "node:path";
import { queryExternalReadonly } from "../../utils/externalReadonlyDb";
import type { PgCapabilityQueryName } from "./types";

const QUERY_FILES: Record<PgCapabilityQueryName, string> = {
  query_sector_conviction_leaderboard: "query_sector_conviction_leaderboard.sql",
  query_sector_divergence: "query_sector_divergence.sql",
  query_sector_delta: "query_sector_delta.sql",
  query_stock_idea_discovery: "query_stock_idea_discovery.sql",
  query_stock_vs_sector_comparison: "query_stock_vs_sector_comparison.sql",
};

const DEFAULT_QUERIES_DIR = path.join(__dirname, "queries");
const queryTextCache = new Map<PgCapabilityQueryName, string>();

export async function runPgCapabilityQuery<T extends Record<string, unknown>>(
  name: PgCapabilityQueryName,
  replacements: Record<string, unknown>,
): Promise<T[]> {
  return queryExternalReadonly<T>(loadPgCapabilityQuery(name), {
    replacements,
  });
}

export function loadPgCapabilityQuery(name: PgCapabilityQueryName): string {
  const cached = queryTextCache.get(name);
  if (cached) return cached;

  const filePath = path.join(getPgCapabilityQueriesDir(), QUERY_FILES[name]);
  const query = fs.readFileSync(filePath, "utf8");
  queryTextCache.set(name, query);
  return query;
}

export function getPgCapabilityQueriesDir(): string {
  return process.env.GRAHAMY_PG_CAPABILITY_QUERIES_DIR || DEFAULT_QUERIES_DIR;
}
