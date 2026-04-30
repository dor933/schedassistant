import { QueryTypes, Sequelize } from "sequelize";

let externalDb: Sequelize | null = null;

export type QueryExternalReadonlyOptions = {
  replacements?: Record<string, unknown>;
  maxRows?: number;
};

export function getExternalDb(): Sequelize {
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
    pool: { max: 3, min: 0, acquire: 20_000, idle: 10_000 },
  });

  return externalDb;
}

const FORBIDDEN_PATTERN =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COPY|EXECUTE|CALL)\b/i;

const ALLOWED_PREFIXES = ["SELECT", "WITH", "EXPLAIN", "SHOW", "TABLE", "VALUES"];

export function validateReadOnlySql(sql: string): string | null {
  const trimmed = stripTrailingStatementTerminator(sql);
  const normalized = stripCommentsForValidation(trimmed)
    .trim()
    .replace(/;+$/, "")
    .trim();
  const upper = normalized.toUpperCase();

  if (!ALLOWED_PREFIXES.some((p) => upper.startsWith(p))) {
    return "Only read-only queries are allowed (SELECT, WITH, EXPLAIN, SHOW, TABLE, VALUES).";
  }

  if (FORBIDDEN_PATTERN.test(normalized)) {
    return "Query contains a forbidden keyword. Only read-only SELECT queries are allowed.";
  }

  const withoutStrings = normalized.replace(/'[^']*'/g, "''");
  if (withoutStrings.includes(";")) {
    return "Multiple statements are not allowed. Send one SELECT query at a time.";
  }

  return null;
}

export async function queryExternalReadonly<T extends Record<string, unknown>>(
  sql: string,
  options: QueryExternalReadonlyOptions = {},
): Promise<T[]> {
  const validationError = validateReadOnlySql(sql);
  if (validationError) {
    throw new Error(validationError);
  }

  const query = options.maxRows ? applyRowLimit(sql, options.maxRows) : sql;
  return getExternalDb().query(query, {
    type: QueryTypes.SELECT,
    raw: true,
    replacements: options.replacements,
  }) as Promise<T[]>;
}

export function applyRowLimit(sql: string, limit: number): string {
  const clean = stripCommentsForValidation(sql).toUpperCase().replace(/\s+/g, " ").trim();
  if (clean.startsWith("EXPLAIN") || clean.startsWith("SHOW")) return sql;
  if (/\bLIMIT\s+\d+/i.test(clean)) return sql;
  return `SELECT * FROM (${stripTrailingStatementTerminator(sql)}) AS _limited LIMIT ${limit}`;
}

export function formatRowsAsTable(rows: Record<string, unknown>[]): string {
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

  const widths = columns.map((col, i) =>
    Math.min(60, Math.max(col.length, ...stringRows.map((r) => r[i].length))),
  );

  const pad = (s: string, w: number) =>
    s.length > w ? `${s.substring(0, w - 3)}...` : s.padEnd(w);

  const headerLine = columns.map((c, i) => pad(c, widths[i])).join(" | ");
  const separator = widths.map((w) => "-".repeat(w)).join("-+-");
  const dataLines = stringRows.map((r) =>
    r.map((val, i) => pad(val, widths[i])).join(" | "),
  );

  return [headerLine, separator, ...dataLines].join("\n");
}

function stripCommentsForValidation(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*--.*$/gm, " ");
}

function stripTrailingStatementTerminator(sql: string): string {
  let next = sql.trim();
  let previous: string;
  do {
    previous = next;
    next = next
      .replace(/(?:\s*--[^\n\r]*)+$/g, "")
      .replace(/(?:\s*\/\*[\s\S]*?\*\/\s*)+$/g, "")
      .trim();
  } while (next !== previous);
  return next.replace(/;+$/, "").trim();
}
