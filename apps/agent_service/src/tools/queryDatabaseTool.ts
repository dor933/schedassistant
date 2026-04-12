import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Sequelize, QueryTypes } from "sequelize";
import { logger } from "../logger";

// ─── Lazy singleton connection to the external Postgres DB ──────────────────

let externalDb: Sequelize | null = null;

function getExternalDb(): Sequelize {
  if (externalDb) return externalDb;

  const host = process.env.EXTERNAL_PG_HOST;
  const port = process.env.EXTERNAL_PG_PORT ?? "5432";
  const database = process.env.EXTERNAL_PG_DATABASE;
  const user = process.env.EXTERNAL_PG_USER ?? "postgres";
  const password = process.env.EXTERNAL_PG_PASSWORD ?? "";

  if (!host || !database) {
    throw new Error(
      "External database not configured. Set EXTERNAL_PG_HOST and EXTERNAL_PG_DATABASE env vars.",
    );
  }

  externalDb = new Sequelize(database, user, password, {
    host,
    port: Number(port),
    dialect: "postgres",
    logging: false,
    pool: { max: 3, min: 0, acquire: 15_000, idle: 10_000 },
  });

  return externalDb;
}

// ─── Validation ─────────────────────────────────────────────────────────────

const FORBIDDEN_PATTERN =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COPY|EXECUTE|CALL)\b/i;

const MAX_ROWS = 200;

function validateSelectOnly(sql: string): string | null {
  const trimmed = sql.trim().replace(/;+$/, "").trim();

  if (!trimmed.toUpperCase().startsWith("SELECT")) {
    return "Only SELECT queries are allowed.";
  }

  if (FORBIDDEN_PATTERN.test(trimmed)) {
    return "Query contains a forbidden keyword. Only read-only SELECT queries are allowed.";
  }

  // Block multiple statements
  const withoutStrings = trimmed.replace(/'[^']*'/g, "''");
  if (withoutStrings.includes(";")) {
    return "Multiple statements are not allowed. Send one SELECT query at a time.";
  }

  return null;
}

// ─── Tool ───────────────────────────────────────────────────────────────────

export function QueryDatabaseTool() {
  return tool(
    async (input) => {
      const { query } = input;

      const validationError = validateSelectOnly(query);
      if (validationError) {
        return `Error: ${validationError}`;
      }

      let db: Sequelize;
      try {
        db = getExternalDb();
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }

      try {
        const limitedQuery = applyRowLimit(query, MAX_ROWS);

        const rows = await db.query(limitedQuery, {
          type: QueryTypes.SELECT,
          raw: true,
        });

        if (rows.length === 0) {
          return "Query returned 0 rows.";
        }

        const truncated = rows.length >= MAX_ROWS;
        const header = `${rows.length}${truncated ? "+" : ""} row${rows.length === 1 ? "" : "s"} returned${truncated ? ` (capped at ${MAX_ROWS})` : ""}:\n\n`;

        return header + formatAsTable(rows as Record<string, unknown>[]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("query_database tool error", { error: msg });
        return `Query failed: ${msg}`;
      }
    },
    {
      name: "query_database",
      description:
        "Run a read-only SQL SELECT query against the company's PostgreSQL database. " +
        "Use this to look up data, answer questions about business data, or investigate records. " +
        "Only SELECT statements are allowed — no INSERT, UPDATE, DELETE, or DDL. " +
        "Results are capped at 200 rows. " +
        "Load the database schema skill first to understand the available tables and columns.",
      schema: z.object({
        query: z
          .string()
          .min(1)
          .describe(
            "A SQL SELECT query to execute. Must start with SELECT. " +
            "Use proper PostgreSQL syntax. You can use JOINs, aggregations, subqueries, CTEs, etc.",
          ),
      }),
    },
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * If the query doesn't already have a LIMIT, wrap it in a subquery with one.
 * This prevents runaway result sets.
 */
function applyRowLimit(sql: string, limit: number): string {
  const upper = sql.toUpperCase().replace(/\s+/g, " ").trim();
  if (/\bLIMIT\s+\d+/i.test(upper)) return sql;
  return `SELECT * FROM (${sql.trim().replace(/;+$/, "")}) AS _limited LIMIT ${limit}`;
}

/**
 * Format rows as a simple aligned text table for the LLM.
 */
function formatAsTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";

  const columns = Object.keys(rows[0]);
  const stringRows = rows.map((row) =>
    columns.map((col) => {
      const val = row[col];
      if (val === null || val === undefined) return "NULL";
      if (typeof val === "object") return JSON.stringify(val);
      return String(val);
    }),
  );

  // Compute column widths
  const widths = columns.map((col, i) =>
    Math.min(
      60,
      Math.max(col.length, ...stringRows.map((r) => r[i].length)),
    ),
  );

  const pad = (s: string, w: number) =>
    s.length > w ? s.substring(0, w - 1) + "…" : s.padEnd(w);

  const headerLine = columns.map((c, i) => pad(c, widths[i])).join(" | ");
  const separator = widths.map((w) => "-".repeat(w)).join("-+-");
  const dataLines = stringRows.map((r) =>
    r.map((val, i) => pad(val, widths[i])).join(" | "),
  );

  return [headerLine, separator, ...dataLines].join("\n");
}
