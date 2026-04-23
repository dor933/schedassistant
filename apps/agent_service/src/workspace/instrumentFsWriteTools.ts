import path from "node:path";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import { logger } from "../logger";
import {
  recordSessionFileWrite,
  statBytes,
  isWriteAllowedExtension,
  rejectExtensionMessage,
} from "./sessionWorkspace";

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
 *
 * `threadId` and `sessionWorkspacePath` are optional: when both are present
 * the wrapper records writes inside the per-thread folder into the ledger;
 * when either is missing only the extension gate fires (the wrapper is
 * applied unconditionally to enforce the .md/.txt write policy).
 */
export interface FsInstrumentationContext {
  /** The thread whose ledger should receive recorded writes (when set). */
  threadId?: string;
  /** Absolute path to the session workspace folder for this thread (when set). */
  sessionWorkspacePath?: string;
  /** Provenance tag attached to recorded entries (e.g. "primary_agent"). */
  source: string;
}

/**
 * Wraps the filesystem MCP write tools to do two things:
 *
 *  1. **Extension gate (always on).** Reject any write whose target path
 *     doesn't end in an allowed extension (.md/.txt — see
 *     `ALLOWED_WRITE_EXTENSIONS`). The rejection returns a friendly message
 *     to the LLM without invoking the underlying tool, so the agent can fix
 *     the extension and retry without polluting the disk with stray formats.
 *
 *  2. **Per-thread manifest capture (when ctx has session workspace).** Any
 *     successful write whose resolved path lies inside `sessionWorkspacePath`
 *     is appended to the per-thread ledger so it flows into the session
 *     summary's file manifest.
 *
 * Tools whose names are not in `WRITE_TOOL_NAMES` are returned verbatim.
 * Successful writes outside the session workspace pass through untracked.
 *
 * The wrapper does NOT otherwise change tool semantics — for an allowed
 * extension it returns whatever the underlying tool returned, only adding a
 * side-effecting ledger push when applicable. A failure to record (e.g. stat
 * failure) is logged but never propagated to the LLM.
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
      // Extension gate first — reject before we touch disk so the LLM gets
      // a clean error message and can retry with a .md/.txt path.
      const writtenPath = extractWrittenPath(underlying.name, args);
      if (writtenPath && !isWriteAllowedExtension(writtenPath)) {
        return rejectExtensionMessage(writtenPath);
      }

      const result = await underlying.invoke(args as never);

      // Manifest capture only fires when both the threadId and the per-thread
      // session workspace are bound — otherwise the wrapper is acting purely
      // as the extension gate.
      if (ctx.threadId && ctx.sessionWorkspacePath && writtenPath) {
        try {
          await maybeRecordWrite(
            writtenPath,
            { threadId: ctx.threadId, sessionWorkspacePath: ctx.sessionWorkspacePath, source: ctx.source },
            underlying.name,
          );
        } catch (err) {
          logger.warn("FS-write instrumentation failed (non-fatal)", {
            tool: underlying.name,
            threadId: ctx.threadId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
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
  ctx: { threadId: string; sessionWorkspacePath: string; source: string },
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
