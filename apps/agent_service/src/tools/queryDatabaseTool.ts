import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../logger";
import {
  formatRowsAsTable,
  queryExternalReadonly,
  validateReadOnlySql,
} from "../utils/externalReadonlyDb";

const MAX_ROWS = 200;

// ─── Tool ───────────────────────────────────────────────────────────────────

export function QueryDatabaseTool() {
  return tool(
    async (input) => {
      const { query } = input;

      const validationError = validateReadOnlySql(query);
      if (validationError) {
        return `Error: ${validationError}`;
      }

      try {
        const rows = await queryExternalReadonly<Record<string, unknown>>(query, {
          maxRows: MAX_ROWS,
        });

        if (rows.length === 0) {
          return "Query returned 0 rows.";
        }

        const truncated = rows.length >= MAX_ROWS;
        const header = `${rows.length}${truncated ? "+" : ""} row${rows.length === 1 ? "" : "s"} returned${truncated ? ` (capped at ${MAX_ROWS})` : ""}:\n\n`;

        return header + formatRowsAsTable(rows);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("query_database tool error", { error: msg });
        return `Query failed: ${msg}`;
      }
    },
    {
      name: "query_database",
      description:
        "Run a read-only SQL query against the company's PostgreSQL database. " +
        "Use this to look up data, answer questions about business data, or investigate records. " +
        "Allowed statements: SELECT, WITH (CTEs), EXPLAIN, SHOW, TABLE, VALUES. " +
        "No INSERT, UPDATE, DELETE, or DDL. " +
        "Results are capped at 200 rows. " +
        "Load the database schema skill first to understand the available tables and columns.",
      schema: z.object({
        query: z
          .string()
          .min(1)
          .describe(
            "A read-only SQL query to execute. " +
            "Supports SELECT, WITH ... AS (CTEs), EXPLAIN / EXPLAIN ANALYZE, SHOW, TABLE, and VALUES. " +
            "Use proper PostgreSQL syntax. You can use JOINs, aggregations, subqueries, CTEs, window functions, etc.",
          ),
      }),
    },
  );
}
