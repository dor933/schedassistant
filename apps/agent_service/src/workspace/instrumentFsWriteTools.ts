import path from "node:path";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import { logger } from "../logger";
import { recordSessionFileWrite, statBytes } from "./sessionWorkspace";

/**
 * Tool names exposed by the filesystem MCP server that mutate files we want
 * to capture into the per-thread session workspace ledger. These are the
 * tools listed in the durable-workspace prompt section
 * (see basicGraph/nodes/contextBuilder.ts ~line 405).
 *
 * Read-side tools (`read_text_file`, `list_directory`, `search_files`) are
 * intentionally not wrapped — there is nothing to record.
 */
const WRITE_TOOL_NAMES = new Set(["write_file", "edit_file", "move_file"]);

/**
 * Per-call binding telling the wrapper which thread + workspace these tool
 * invocations belong to. Created fresh inside `callModelNode` and the deep
 * agent worker — never cached, since it closes over the thread id.
 */
export interface FsInstrumentationContext {
  /** The thread whose ledger should receive recorded writes. */
  threadId: string;
  /** Absolute path to the session workspace folder for this thread. */
  sessionWorkspacePath: string;
  /** Provenance tag attached to recorded entries (e.g. "primary_agent"). */
  source: string;
}

/**
 * Wraps the filesystem MCP write tools so that any successful write whose
 * resolved path lies inside `sessionWorkspacePath` is appended to the
 * per-thread ledger. Tools whose names are not in `WRITE_TOOL_NAMES` and any
 * write that lands outside the session workspace are passed through verbatim.
 *
 * The wrapper does NOT change tool semantics — it returns whatever the
 * underlying tool returned, only adding a side-effecting ledger push when the
 * call succeeded. A failure to record (e.g. stat failure) is logged but never
 * propagated to the LLM.
 */
export function instrumentFsWriteTools(
  tools: StructuredToolInterface[],
  ctx: FsInstrumentationContext,
): StructuredToolInterface[] {
  return tools.map((t) => {
    if (!WRITE_TOOL_NAMES.has(t.name)) return t;
    return wrapWriteTool(t, ctx);
  });
}

function wrapWriteTool(
  underlying: StructuredToolInterface,
  ctx: FsInstrumentationContext,
): StructuredToolInterface {
  return tool(
    async (args: unknown) => {
      const result = await underlying.invoke(args as never);

      try {
        const writtenPath = extractWrittenPath(underlying.name, args);
        if (writtenPath) {
          await maybeRecordWrite(writtenPath, ctx, underlying.name);
        }
      } catch (err) {
        logger.warn("FS-write instrumentation failed (non-fatal)", {
          tool: underlying.name,
          threadId: ctx.threadId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      return result;
    },
    {
      name: underlying.name,
      description: underlying.description,
      // Underlying schema is dynamic and provider-specific; passing it through
      // verbatim preserves the original argument validation. Cast through
      // `unknown` because LangChain's tool() accepts any Zod-compatible
      // schema but the underlying tool type carries a wider declaration.
      schema: (underlying.schema ?? z.object({}).passthrough()) as never,
    },
  );
}

/**
 * Extracts the destination path from a write-tool's arguments. Filesystem
 * MCP tools use these field names:
 *   - write_file: { path, content }
 *   - edit_file:  { path, edits, ... }
 *   - move_file:  { source, destination }
 *
 * Returns the absolute or relative path string, or null if the args don't
 * match a known shape (in which case we silently skip recording — it's
 * better to under-record than to corrupt the manifest with guesses).
 */
function extractWrittenPath(toolName: string, args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  if (toolName === "move_file") {
    return typeof a.destination === "string" ? a.destination : null;
  }
  return typeof a.path === "string" ? a.path : null;
}

async function maybeRecordWrite(
  writtenPath: string,
  ctx: FsInstrumentationContext,
  toolName: string,
): Promise<void> {
  const root = path.resolve(ctx.sessionWorkspacePath);
  const abs = path.isAbsolute(writtenPath)
    ? path.resolve(writtenPath)
    : path.resolve(root, writtenPath);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    // Write landed outside the session workspace — not ours to track.
    return;
  }

  const bytes = await statBytes(abs);
  recordSessionFileWrite(ctx.threadId, {
    path: rel.split(path.sep).join("/"),
    bytes,
    updatedAt: new Date().toISOString(),
    source: `${ctx.source}:${toolName}`,
  });
}
