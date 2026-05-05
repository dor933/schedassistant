import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BaseMessage } from "@langchain/core/messages";

import { Agent } from "@scheduling-agent/database";
import type { SessionFileEntry } from "@scheduling-agent/types";

import type { AgentState } from "../../state";
import { logger } from "../../logger";
import {
  recordSessionFileWrite,
  resolveSessionWorkspacePath,
} from "../../workspace/sessionWorkspace";

/**
 * Inbound-message spill node.
 *
 * Runs at the very top of each graph, before the summarization guard. When the
 * latest HumanMessage exceeds `INBOUND_SPILL_CHAR_THRESHOLD`, the full body is
 * written into the per-thread session folder as `user_<iso>_<sender>.md` and
 * the message content is replaced in place by a short reference + preview.
 * Origin is carried by the `user_` filename prefix and the
 * `source: "inbound_spill"` manifest tag — no separate sub-folder needed since
 * the per-thread folder already scopes the session. This caps the
 * per-turn token cost of oversized user pastes (long SQL, log dumps, pasted
 * docs) without losing the content — the file is captured into the session
 * manifest and becomes retrievable by reading the listed path with the
 * agent's built-in file tools, the same way agent-written artifacts are.
 *
 * Design notes:
 *   - We operate only on the LAST message, which is the one appended this
 *     turn by `executeChatTurn` / `storeMessageOnly`. Historical messages are
 *     already persisted; rewriting them is neither safe nor necessary (they
 *     will age out via `sessionSummarization`).
 *   - Mutation is deliberate: the HumanMessage reference in `state.messages`
 *     is the same object appended upstream; LangGraph serializes channel
 *     values on checkpoint save, so overwriting `.content` lands in Postgres
 *     alongside a fresh `{ sessionFiles }` return that surfaces the new file
 *     through the annotation reducer.
 *   - The spill marker on the replacement content lets the node recognise
 *     an already-processed message on a graph replay and skip it idempotently.
 */

const SPILL_CHAR_THRESHOLD = parseInt(
  process.env.INBOUND_SPILL_CHAR_THRESHOLD ?? "8000",
  10,
);

const PREVIEW_CHARS = parseInt(
  process.env.INBOUND_SPILL_PREVIEW_CHARS ?? "500",
  10,
);

const SPILL_MARKER = "[LARGE_INBOUND_SPILLED]";

function sanitizeFilenamePart(raw: string): string {
  const cleaned = (raw || "user")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return cleaned.length > 0 ? cleaned : "user";
}

function isoForFilename(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function isHumanMessage(m: BaseMessage): boolean {
  const t = (m as unknown as { _getType?: () => string })._getType;
  if (typeof t === "function" && t.call(m) === "human") return true;
  return (m as unknown as { role?: string }).role === "user";
}

function getStringContent(m: BaseMessage): string | null {
  return typeof m.content === "string" ? m.content : null;
}

async function resolveWorkspacePath(state: AgentState): Promise<string | null> {
  if (state.sessionWorkspacePath) return state.sessionWorkspacePath;
  if (!state.agentId || !state.threadId) return null;
  try {
    const agent = await Agent.findByPk(state.agentId, {
      attributes: ["workspacePath"],
    });
    return resolveSessionWorkspacePath(
      agent?.workspacePath ?? null,
      state.threadId,
    );
  } catch (err) {
    logger.warn("Inbound spill: failed to load agent workspace", {
      agentId: state.agentId,
      threadId: state.threadId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function inboundMessageSpillNode(
  state: AgentState,
): Promise<Partial<AgentState>> {
  const { messages, threadId } = state;
  if (!messages || messages.length === 0) return {};

  const last = messages[messages.length - 1];
  if (!isHumanMessage(last)) return {};

  const content = getStringContent(last);
  if (!content) return {};
  if (content.length <= SPILL_CHAR_THRESHOLD) return {};
  if (content.startsWith(SPILL_MARKER)) return {};

  const sessionWorkspacePath = await resolveWorkspacePath(state);
  if (!sessionWorkspacePath) return {};

  const senderRaw =
    (last as unknown as { name?: string }).name?.trim() ||
    (state.userId != null ? String(state.userId) : "user");
  const sender = sanitizeFilenamePart(senderRaw);
  const relPath = `user_${isoForFilename()}_${sender}.md`;
  const absPath = path.join(sessionWorkspacePath, relPath);

  const frontMatter =
    `---\n` +
    `sender: ${senderRaw}\n` +
    `threadId: ${threadId}\n` +
    `capturedAt: ${new Date().toISOString()}\n` +
    `originalChars: ${content.length}\n` +
    `source: inbound_spill\n` +
    `---\n\n`;
  const fileBody = frontMatter + content;

  try {
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, fileBody, "utf8");
  } catch (err) {
    logger.error("Inbound spill write failed — leaving message intact", {
      threadId,
      relPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }

  const preview = content.slice(0, PREVIEW_CHARS);
  const elided = content.length - preview.length;
  const reference =
    `${SPILL_MARKER} Original message from ${senderRaw} was ${content.length} chars — ` +
    `saved verbatim to \`${relPath}\` under this thread's session folder. ` +
    `Open that exact path with your built-in file tools (\`Read\` for Anthropic SDK, ` +
    `\`shell\` cat/sed for Codex SDK) to load the full body when you need it.\n\n` +
    `Preview (first ${preview.length} chars):\n${preview}` +
    (elided > 0 ? `\n\n[... ${elided} more chars in the saved file ...]` : "");

  // In-place mutation: the BaseMessage reference in state.messages is the one
  // appended this turn; LangGraph serializes the channel on checkpoint save,
  // so overwriting .content persists alongside the returned partial below.
  (last as unknown as { content: string }).content = reference;

  const bytes = Buffer.byteLength(fileBody, "utf8");
  const updatedAt = new Date().toISOString();

  // Record into the per-thread ledger so any downstream drain still sees it,
  // AND surface immediately through state.sessionFiles so sessionSummarization
  // can pick it up this turn without waiting for the callModel drain.
  recordSessionFileWrite(threadId, {
    path: relPath,
    bytes,
    updatedAt,
    source: "inbound_spill",
  });

  const entry: SessionFileEntry = {
    path: relPath,
    bytes,
    updatedAt,
    source: "inbound_spill",
  };

  logger.info("Inbound message spilled to session folder", {
    threadId,
    relPath,
    originalChars: content.length,
    previewChars: preview.length,
    bytes,
  });

  return {
    sessionWorkspacePath,
    sessionFiles: [entry],
  };
}
