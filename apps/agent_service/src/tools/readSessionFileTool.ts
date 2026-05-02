import { readFile, stat } from "node:fs/promises";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Agent, Thread } from "@scheduling-agent/database";
import type {
  AgentId,
  SessionFileEntry,
  SessionSummary,
} from "@scheduling-agent/types";

import { logger } from "../logger";
import { resolveSessionFilePath } from "../workspace/sessionWorkspace";
import { agentMayAccessThread } from "../utils/agentThreadAccess";

/** Hard cap on bytes returned to the LLM — prevents a huge file from blowing context. */
const MAX_READ_BYTES = Number(process.env.READ_SESSION_FILE_MAX_BYTES ?? 50_000);

/** Default number of lines returned when the caller passes `offset` but no `limit`. */
const DEFAULT_LIMIT_LINES = Number(process.env.READ_SESSION_FILE_DEFAULT_LINES ?? 500);

/** Absolute cap on lines per call, regardless of what the LLM asks for. */
const MAX_LIMIT_LINES = Number(process.env.READ_SESSION_FILE_MAX_LINES ?? 2_000);

/**
 * Agent-invoked tool for reading a file from this agent's per-thread session
 * workspace (`<agent.workspacePath>/threads/<threadId>/`).
 *
 * This is the third tier of the retrieval cascade:
 *   1. `recall_episodic_memory` returns vector hits (conversation + file_summary chunks).
 *   2. `get_thread_summary` fetches the thread's summary + file manifest.
 *   3. `read_session_file` opens a specific file when the summary isn't enough.
 *
 * Access control:
 *   - Current thread: always readable (fast-path, no DB roundtrip).
 *   - Other threads: gated by `agentMayAccessThread()` — passes when the
 *     agent owns the thread directly (`threads.agent_id == agentId`) or
 *     participated in it as a roundtable agent. Same helper used by
 *     `get_thread_summary` and `grep_session_file`, so all three tools stay
 *     in lockstep.
 *
 * Graceful drift: when the file is not found on disk but the thread's stored
 * summary has a matching `files[].summary`, we return that summary plus a
 * clear "file missing" marker. Manifests are a *hint*, not a source of truth;
 * agents should be told gently when a file has moved or been deleted rather
 * than getting an opaque ENOENT.
 */
export function ReadSessionFileTool(
  agentId: AgentId | null,
  currentThreadId: string,
) {
  return tool(
    async (input) => {
      const targetThreadId = (input.threadId?.trim() || currentThreadId).trim();
      const relativePath = input.path?.trim();
      if (!agentId) return "No agent context — cannot read session files.";
      if (!targetThreadId) return "No thread_id provided and no current thread in scope.";
      if (!relativePath) return "No path provided.";

      try {
        // 1. Load this agent's workspacePath — files live under it.
        const agent = await Agent.findByPk(agentId, {
          attributes: ["id", "workspacePath"],
        });
        if (!agent?.workspacePath) {
          return "This agent has no workspace configured, so it has no session files to read.";
        }

        // 2. Access control. Current thread is always in scope (fast-path);
        // past threads go through agentMayAccessThread() which checks
        // threads.agent_id (single-chat / group ownership) and falls back
        // to roundtable_agents for multi-agent roundtable threads.
        if (targetThreadId !== currentThreadId) {
          if (!(await agentMayAccessThread(agentId, targetThreadId))) {
            return `No access — thread ${targetThreadId} is not one of your conversations.`;
          }
        }

        // 3. Resolve the path against the per-thread folder. Throws if the
        // path tries to escape (traversal, absolute paths outside root).
        const sessionRoot = `${agent.workspacePath}/threads/${targetThreadId}`;
        let absolutePath: string;
        try {
          absolutePath = resolveSessionFilePath(sessionRoot, relativePath);
        } catch (err) {
          return `Invalid path: ${err instanceof Error ? err.message : String(err)}`;
        }

        // 4. Try to read. On ENOENT we look up the stored manifest summary
        // so the agent at least knows what the file *was* before it moved
        // or was deleted.
        let bytes: number;
        let content: string;
        try {
          const s = await stat(absolutePath);
          if (!s.isFile()) {
            return `Path ${relativePath} is not a regular file.`;
          }
          bytes = s.size;
          content = await readFile(absolutePath, "utf8");
        } catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === "ENOENT") {
            const fallback = await loadManifestSummary(targetThreadId, relativePath);
            if (fallback) {
              return (
                `File not found at threads/${targetThreadId}/${relativePath}. ` +
                `It may have been moved or deleted. Recorded summary from the last session:\n\n${fallback}`
              );
            }
            return (
              `File not found at threads/${targetThreadId}/${relativePath}. ` +
              `No recorded summary is available either — the manifest has no entry for this path.`
            );
          }
          throw err;
        }

        // 5. Line-based pagination. When the caller passes `offset` or `limit`
        // we slice by line number; otherwise we fall back to byte-capped read
        // of the whole file (historical behavior). Line slicing is done on the
        // full file in memory — session files are small enough (.md / .txt
        // artifacts) that this is fine; for truly huge reads the byte cap
        // below still applies as a safety net.
        const offset = Math.max(0, Math.floor(input.offset ?? 0));
        const requestedLimit = input.limit != null
          ? Math.max(1, Math.floor(input.limit))
          : DEFAULT_LIMIT_LINES;
        const limit = Math.min(requestedLimit, MAX_LIMIT_LINES);
        const paginated = offset > 0 || input.limit != null;

        if (paginated) {
          const lines = content.split(/\r?\n/);
          const totalLines = lines.length;
          if (offset >= totalLines) {
            return (
              `[threads/${targetThreadId}/${relativePath} — ${bytes} bytes, ` +
              `${totalLines} lines total] offset ${offset} is past end of file.`
            );
          }
          const end = Math.min(offset + limit, totalLines);
          const slice = lines.slice(offset, end).join("\n");
          const hasMore = end < totalLines;
          const cappedSlice = slice.length > MAX_READ_BYTES
            ? slice.slice(0, MAX_READ_BYTES) +
              `\n\n[BYTE-CAP — returned ${MAX_READ_BYTES} of ${slice.length} bytes in this slice; lower \`limit\` for shorter output]`
            : slice;
          return (
            `[threads/${targetThreadId}/${relativePath} — lines ${offset}-${end - 1} of ${totalLines} ` +
            `(${bytes} bytes total)${hasMore ? `, more available — call again with offset=${end}` : ", end of file"}]\n\n` +
            cappedSlice
          );
        }

        // Default path: return the whole file, byte-capped. The agent is told
        // the total size + line count so it can switch to paginated reads if
        // it needs to see past the cap.
        const totalLines = content.split(/\r?\n/).length;
        if (content.length > MAX_READ_BYTES) {
          const head = content.slice(0, MAX_READ_BYTES);
          return (
            `[threads/${targetThreadId}/${relativePath} — ${bytes} bytes, ${totalLines} lines total, ` +
            `showing first ${MAX_READ_BYTES} bytes]\n\n${head}\n\n` +
            `[BYTE-CAP — ${bytes - MAX_READ_BYTES} bytes not shown. Call again with ` +
            `\`offset\` (line number) and \`limit\` (max lines) to page through, or use ` +
            `\`grep_session_file\` to search for a specific pattern.]`
          );
        }

        return (
          `[threads/${targetThreadId}/${relativePath} — ${bytes} bytes, ${totalLines} lines]\n\n${content}`
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("read_session_file failed", {
          agentId,
          threadId: targetThreadId,
          path: relativePath,
          error: message,
        });
        return `Error reading session file: ${message}`;
      }
    },
    {
      name: "read_session_file",
      description:
        "Reads a file from a thread's session workspace " +
        "(`<your workspace>/threads/<threadId>/<path>`). Use this as the third and heaviest " +
        "tier of retrieval, after `recall_episodic_memory` (vector search) and " +
        "`get_thread_summary` (summary + file manifest):\n\n" +
        "  1. If an episodic chunk or a manifest entry points at a specific file that looks " +
        "relevant to the user's question, call this tool with that path.\n" +
        "  2. Omit `threadId` to read from the current thread. Otherwise pass the exact thread_id " +
        "shown in episodic chunk metadata or the manifest.\n" +
        "  3. You can only read files from threads you actually participated in — single-chat / " +
        "group threads where you are the agent, or roundtable threads where you were a " +
        "participant. The tool enforces this server-side.\n\n" +
        "**Pagination.** For large files, pass `offset` (0-based line number to start at) and " +
        "`limit` (max lines to return). Omit both to read the whole file (byte-capped — the " +
        "header tells you if content was cut off and what the total size is). When you need " +
        "to find a specific string instead of paging blindly, use `grep_session_file` first.\n\n" +
        "The tool returns the file contents with a header line naming the thread + path + " +
        "line range + total size. If the file has been moved or deleted since summarisation, " +
        "you will get the recorded summary back instead of an opaque error.",
      schema: z.object({
        threadId: z
          .string()
          .optional()
          .describe(
            "The thread id the file belongs to. Omit to read from the current thread. " +
              "When provided, must be a thread you participated in (single-chat / group " +
              "thread you own, or a roundtable thread you joined).",
          ),
        path: z
          .string()
          .min(1)
          .describe(
            "Path of the file relative to the thread's session workspace folder " +
              "(e.g. \"research/pricing_brief.md\"). Must not traverse outside the folder.",
          ),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "0-based line number to start reading at. Omit to start from the beginning. " +
              "Use this to page through a large file across multiple calls.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            `Maximum number of lines to return. Default ${DEFAULT_LIMIT_LINES} when ` +
              `\`offset\` is set; capped at ${MAX_LIMIT_LINES}. Lower this if prior reads ` +
              `returned very wide lines and hit the byte cap.`,
          ),
      }),
    },
  );
}

async function loadManifestSummary(
  threadId: string,
  path: string,
): Promise<string | null> {
  try {
    const thread = await Thread.findByPk(threadId, { attributes: ["summary"] });
    const files = (thread?.summary as SessionSummary | null | undefined)?.files;
    const entry = files?.find((f: SessionFileEntry) => f.path === path);
    return entry?.summary?.trim() || null;
  } catch {
    return null;
  }
}
