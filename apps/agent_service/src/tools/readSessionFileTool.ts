import { readFile, stat } from "node:fs/promises";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Agent, EpisodicMemory, Thread } from "@scheduling-agent/database";
import type {
  AgentId,
  SessionFileEntry,
  SessionSummary,
} from "@scheduling-agent/types";

import { logger } from "../logger";
import { resolveSessionFilePath } from "../workspace/sessionWorkspace";

/** Hard cap on bytes returned to the LLM — prevents a huge file from blowing context. */
const MAX_READ_BYTES = Number(process.env.READ_SESSION_FILE_MAX_BYTES ?? 50_000);

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
 *   - Current thread: always readable (the agent owns it).
 *   - Other threads: the agent must have at least one episodic memory chunk
 *     from that thread (same gate as `get_thread_summary`). This ensures an
 *     agent can only read files from conversations it participated in.
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

        // 2. Access control. Current thread is always in scope; past threads
        // require the agent to have at least one episodic memory chunk from
        // that thread (same gate used by get_thread_summary).
        if (targetThreadId !== currentThreadId) {
          const memoryRow = await EpisodicMemory.findOne({
            where: { threadId: targetThreadId, agentId },
            attributes: ["id"],
          });
          if (!memoryRow) {
            return `No access — thread ${targetThreadId} is not in your episodic memory.`;
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

        // 5. Truncate over-long reads so a single file can't blow the LLM's
        // context window. The agent is told explicitly that truncation
        // happened so it can ask for a narrower slice if needed.
        if (content.length > MAX_READ_BYTES) {
          const head = content.slice(0, MAX_READ_BYTES);
          return (
            `[threads/${targetThreadId}/${relativePath} — ${bytes} bytes total, ` +
            `showing first ${MAX_READ_BYTES}]\n\n${head}\n\n` +
            `[TRUNCATED — ${bytes - MAX_READ_BYTES} bytes not shown]`
          );
        }

        return `[threads/${targetThreadId}/${relativePath} — ${bytes} bytes]\n\n${content}`;
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
        "  3. You can only read files from threads where you have at least one stored memory — " +
        "the tool enforces this.\n\n" +
        "The tool returns the file contents (truncated if very large) with a header line naming " +
        "the thread + path. If the file has been moved or deleted since summarisation, you will " +
        "get the recorded summary back instead of an opaque error.",
      schema: z.object({
        threadId: z
          .string()
          .optional()
          .describe(
            "The thread id the file belongs to. Omit to read from the current thread. " +
              "When provided, must be a thread where you have stored episodic memory.",
          ),
        path: z
          .string()
          .min(1)
          .describe(
            "Path of the file relative to the thread's session workspace folder " +
              "(e.g. \"research/pricing_brief.md\"). Must not traverse outside the folder.",
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
