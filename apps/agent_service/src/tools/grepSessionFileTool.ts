import { readFile, stat } from "node:fs/promises";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Agent } from "@scheduling-agent/database";
import type { AgentId } from "@scheduling-agent/types";

import { logger } from "../logger";
import { resolveSessionFilePath } from "../workspace/sessionWorkspace";
import { agentMayAccessThread } from "../utils/agentThreadAccess";

/** Absolute cap on matches per call — keeps the tool response bounded. */
const MAX_MATCHES = Number(process.env.GREP_SESSION_FILE_MAX_MATCHES ?? 200);

/** Hard cap on bytes returned to the LLM — prevents a degenerate pattern (e.g. ".") from dumping a whole file. */
const MAX_RESPONSE_BYTES = Number(process.env.GREP_SESSION_FILE_MAX_BYTES ?? 50_000);

/**
 * Agent-invoked tool for searching a file in a thread's session workspace
 * without pulling its entire body into context.
 *
 * The usual cascade for long session files is:
 *   1. `recall_episodic_memory` / `get_thread_summary` — vector hit + manifest.
 *   2. `grep_session_file` — locate the exact line range that matters.
 *   3. `read_session_file` with `offset` + `limit` — fetch just that slice.
 *
 * Access control mirrors `read_session_file`: the current thread is always in
 * scope (fast-path), past threads go through `agentMayAccessThread()` —
 * `threads.agent_id` ownership for single-chat / group threads, falling back
 * to `roundtable_agents` membership for roundtable threads.
 */
export function GrepSessionFileTool(
  agentId: AgentId | null,
  currentThreadId: string,
) {
  return tool(
    async (input) => {
      const targetThreadId = (input.threadId?.trim() || currentThreadId).trim();
      const relativePath = input.path?.trim();
      const rawPattern = input.pattern;
      if (!agentId) return "No agent context — cannot grep session files.";
      if (!targetThreadId) return "No thread_id provided and no current thread in scope.";
      if (!relativePath) return "No path provided.";
      if (!rawPattern || rawPattern.length === 0) return "No pattern provided.";

      try {
        const agent = await Agent.findByPk(agentId, {
          attributes: ["id", "workspacePath"],
        });
        if (!agent?.workspacePath) {
          return "This agent has no workspace configured, so it has no session files to grep.";
        }

        if (targetThreadId !== currentThreadId) {
          if (!(await agentMayAccessThread(agentId, targetThreadId))) {
            return `No access — thread ${targetThreadId} is not one of your conversations.`;
          }
        }

        const sessionRoot = `${agent.workspacePath}/threads/${targetThreadId}`;
        let absolutePath: string;
        try {
          absolutePath = resolveSessionFilePath(sessionRoot, relativePath);
        } catch (err) {
          return `Invalid path: ${err instanceof Error ? err.message : String(err)}`;
        }

        let content: string;
        let bytes: number;
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
            return (
              `File not found at threads/${targetThreadId}/${relativePath}. ` +
              `Check \`get_thread_summary\` for the current file manifest.`
            );
          }
          throw err;
        }

        // Build the matcher. Default is a literal substring match (safest for
        // agent-supplied patterns — no accidental regex explosions); `regex`
        // flips it to a real RegExp compiled with optional `caseInsensitive`.
        const caseInsensitive = input.caseInsensitive === true;
        const useRegex = input.regex === true;

        let matcher: (line: string) => boolean;
        if (useRegex) {
          let re: RegExp;
          try {
            re = new RegExp(rawPattern, caseInsensitive ? "i" : "");
          } catch (err) {
            return `Invalid regex: ${err instanceof Error ? err.message : String(err)}`;
          }
          matcher = (line) => re.test(line);
        } else {
          const needle = caseInsensitive ? rawPattern.toLowerCase() : rawPattern;
          matcher = caseInsensitive
            ? (line) => line.toLowerCase().includes(needle)
            : (line) => line.includes(needle);
        }

        const lines = content.split(/\r?\n/);
        const totalLines = lines.length;

        const contextBefore = Math.max(0, Math.floor(input.contextBefore ?? 0));
        const contextAfter = Math.max(0, Math.floor(input.contextAfter ?? 0));
        const requestedMax = input.maxMatches != null
          ? Math.max(1, Math.floor(input.maxMatches))
          : MAX_MATCHES;
        const maxMatches = Math.min(requestedMax, MAX_MATCHES);

        // First pass: collect matching line indexes.
        const matchIdxs: number[] = [];
        for (let i = 0; i < totalLines && matchIdxs.length < maxMatches; i++) {
          if (matcher(lines[i])) matchIdxs.push(i);
        }

        // Second pass: expand each match with requested context, merging
        // overlapping windows so we don't repeat lines across hits.
        type Window = { start: number; end: number; matchLine: number };
        const windows: Window[] = [];
        for (const idx of matchIdxs) {
          const start = Math.max(0, idx - contextBefore);
          const end = Math.min(totalLines - 1, idx + contextAfter);
          const last = windows[windows.length - 1];
          if (last && start <= last.end + 1) {
            last.end = Math.max(last.end, end);
          } else {
            windows.push({ start, end, matchLine: idx });
          }
        }

        if (windows.length === 0) {
          return (
            `[threads/${targetThreadId}/${relativePath} — ${bytes} bytes, ${totalLines} lines] ` +
            `No matches for ${useRegex ? "regex" : "pattern"} \`${rawPattern}\`` +
            `${caseInsensitive ? " (case-insensitive)" : ""}.`
          );
        }

        // Render windows with line numbers. Use the raw line index (0-based)
        // so callers can plug it straight into `read_session_file` as `offset`.
        const out: string[] = [];
        out.push(
          `[threads/${targetThreadId}/${relativePath} — ${bytes} bytes, ${totalLines} lines, ` +
            `${matchIdxs.length} match${matchIdxs.length === 1 ? "" : "es"}` +
            `${matchIdxs.length >= maxMatches ? ` (capped at ${maxMatches})` : ""}]`,
        );
        for (const w of windows) {
          out.push("");
          out.push(`── lines ${w.start}-${w.end} ──`);
          for (let i = w.start; i <= w.end; i++) {
            const marker = matchIdxs.includes(i) ? ">" : " ";
            out.push(`${marker} ${i}: ${lines[i]}`);
          }
        }
        let rendered = out.join("\n");
        if (rendered.length > MAX_RESPONSE_BYTES) {
          rendered =
            rendered.slice(0, MAX_RESPONSE_BYTES) +
            `\n\n[BYTE-CAP — showing first ${MAX_RESPONSE_BYTES} of ${rendered.length} bytes. ` +
            `Narrow the pattern or lower \`maxMatches\`/\`contextBefore\`/\`contextAfter\`.]`;
        }
        return rendered;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("grep_session_file failed", {
          agentId,
          threadId: targetThreadId,
          path: relativePath,
          pattern: rawPattern,
          error: message,
        });
        return `Error grepping session file: ${message}`;
      }
    },
    {
      name: "grep_session_file",
      description:
        "Searches a file in a thread's session workspace for a pattern and returns matching " +
        "lines with line numbers. Use this BEFORE `read_session_file` whenever you know what " +
        "string/term you're looking for — it lets you locate the relevant slice without pulling " +
        "the whole file into context.\n\n" +
        "Typical flow for a large file:\n" +
        "  1. `grep_session_file` to find matching line numbers.\n" +
        "  2. `read_session_file` with `offset`=<match line> and `limit`=<desired window> to " +
        "read that slice in full.\n\n" +
        "By default the pattern is a literal substring match (safest). Set `regex: true` for " +
        "regex. Set `caseInsensitive: true` either way. `contextBefore` / `contextAfter` expand " +
        "each match with surrounding lines (like grep's -B / -A). Same access control as " +
        "`read_session_file` — current thread always, past threads only when you actually " +
        "participated in them (single-chat / group threads you own, or roundtable threads " +
        "you joined).",
      schema: z.object({
        threadId: z
          .string()
          .optional()
          .describe(
            "The thread id the file belongs to. Omit to grep the current thread's file. " +
              "When provided, must be a thread you participated in (single-chat / group " +
              "thread you own, or a roundtable thread you joined).",
          ),
        path: z
          .string()
          .min(1)
          .describe(
            "Path of the file relative to the thread's session workspace folder. " +
              "Must not traverse outside the folder.",
          ),
        pattern: z
          .string()
          .min(1)
          .describe(
            "Text to search for. Literal substring by default; set `regex: true` to interpret " +
              "as a JavaScript regular expression.",
          ),
        regex: z
          .boolean()
          .optional()
          .describe(
            "When true, `pattern` is compiled as a JavaScript regex. When false/omitted it " +
              "is matched as a literal substring (safer for one-off searches).",
          ),
        caseInsensitive: z
          .boolean()
          .optional()
          .describe("Case-insensitive matching. Defaults to case-sensitive."),
        maxMatches: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            `Cap on matches returned. Default ${MAX_MATCHES}. The tool always stops at this ceiling.`,
          ),
        contextBefore: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Lines of context to include before each match (grep -B). Default 0."),
        contextAfter: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Lines of context to include after each match (grep -A). Default 0."),
      }),
    },
  );
}
