import { isLangfuseConfigured, startActiveObservation } from "../../langfuse";

const SQL_PREVIEW_MAX = 4000;
const SAMPLE_ROW_COUNT = 5;

export type TraceSqlExecutionInput<T> = {
  queryName: string;
  sql: string;
  replacements?: Record<string, unknown>;
  exec: () => Promise<T[]>;
};

/**
 * Runs a read-only SQL execution and emits a Langfuse span whose:
 *   - input  = { queryName, replacements, sqlPreview, sqlLength }
 *   - output = { rowCount, durationMs, sampleRows, columns } on success,
 *              { error, durationMs } on failure
 *
 * The caller still receives the full row set unchanged — span output is
 * a summary so Langfuse payloads stay small even when queries return
 * thousands of rows. No-op (just runs `exec`) when Langfuse is unconfigured.
 */
export async function traceSqlExecution<T extends Record<string, unknown>>(
  input: TraceSqlExecutionInput<T>,
): Promise<T[]> {
  if (!isLangfuseConfigured()) {
    return input.exec();
  }

  try {
    return await startActiveObservation(
      `pg_query: ${input.queryName}`,
      async (span) => {
        try {
          span.update({
            input: {
              queryName: input.queryName,
              replacements: input.replacements ?? {},
              sqlPreview:
                input.sql.length > SQL_PREVIEW_MAX
                  ? `${input.sql.slice(0, SQL_PREVIEW_MAX)}…`
                  : input.sql,
              sqlLength: input.sql.length,
            },
          });
        } catch {
          /* tracing must never break the call */
        }

        const start = Date.now();
        try {
          const rows = await input.exec();
          try {
            span.update({
              output: {
                rowCount: rows.length,
                durationMs: Date.now() - start,
                columns: rows[0] ? Object.keys(rows[0]) : [],
                sampleRows: rows.slice(0, SAMPLE_ROW_COUNT),
              },
            });
          } catch {
            span.update({
              output: { rowCount: rows.length, durationMs: Date.now() - start },
            });
          }
          return rows;
        } catch (err) {
          try {
            span.update({
              output: {
                error: err instanceof Error ? err.message : String(err),
                durationMs: Date.now() - start,
              },
            });
          } catch {
            /* swallow */
          }
          throw err;
        }
      },
    );
  } catch (outerErr) {
    if (
      outerErr instanceof Error &&
      outerErr.message.includes("startActiveObservation")
    ) {
      return input.exec();
    }
    throw outerErr;
  }
}
