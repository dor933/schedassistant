import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { tool } from "@langchain/core/tools";
import { Agent } from "@scheduling-agent/database";
import { z } from "zod";

/**
 * Lets an agent hand a file from its workspace to the user as a downloadable
 * attachment. Returns a signed-URL markdown link that the agent can place in
 * its reply; the link is rendered as an attachment chip in the chat UI and
 * streamed through `/claw/api/attachments` on download.
 *
 * The tool only references files the agent has already written to its
 * workspace via `workspace_write_file`. Storage lives in `agent.workspacePath`;
 * this tool does not copy or duplicate anything.
 *
 * Signed-URL model: stateless HMAC over `{agentId, file, exp}` using
 * `ATTACHMENT_SIGNING_SECRET`. Agents cannot forge URLs without the secret.
 */

const ALLOWED_EXT = new Set([".md", ".txt"]);

/** Default validity of a generated download URL (24 h). */
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

function getSigningSecret(): string {
  const s = process.env.ATTACHMENT_SIGNING_SECRET;
  if (!s) {
    throw new Error(
      "ATTACHMENT_SIGNING_SECRET is not configured on agent_service.",
    );
  }
  return s;
}

/**
 * Computes the HMAC signature for `{agentId, file, exp}`.
 * Exported so the HTTP endpoint can verify with the same canonicalisation.
 */
export function signAttachment(
  agentId: string,
  fileName: string,
  exp: number,
): string {
  const h = crypto.createHmac("sha256", getSigningSecret());
  h.update(`${agentId}:${fileName}:${exp}`);
  return h.digest("hex");
}

export function verifyAttachmentSignature(
  agentId: string,
  fileName: string,
  exp: number,
  sig: string,
): boolean {
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    return false;
  }
  const expected = signAttachment(agentId, fileName, exp);
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function buildAttachmentUrl(
  agentId: string,
  fileName: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = signAttachment(agentId, fileName, exp);
  const params = new URLSearchParams({
    a: agentId,
    f: fileName,
    e: String(exp),
    s: sig,
  });
  return `/claw/api/attachments?${params.toString()}`;
}

/**
 * Saves a user-uploaded attachment into the agent's workspace directory.
 * Uses direct `fs` access — agent_service runs in the same container as the
 * `/app/data` volume that the filesystem MCP server exposes, so no MCP round-
 * trip is needed for this server-side write.
 *
 * Applies a version-suffix collision policy: `notes.md` → `notes-2.md` → … (max 99).
 */
export async function saveUserAttachmentToAgentWorkspace(
  agentId: string,
  originalName: string,
  content: string,
): Promise<{ savedFileName: string }> {
  const agent = await Agent.findByPk(agentId, { attributes: ["id", "workspacePath"] });
  const workspace = agent?.workspacePath;
  if (!workspace) {
    throw new Error(`Agent ${agentId} has no workspace configured.`);
  }

  fs.mkdirSync(workspace, { recursive: true });

  const safeName = path.basename(originalName.trim());
  if (!safeName || safeName === "." || safeName === "..") {
    throw new Error("Invalid attachment file name.");
  }

  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext);
  let savedFileName = safeName;

  for (let i = 2; i <= 99; i++) {
    const full = path.resolve(workspace, savedFileName);
    if (!full.startsWith(workspace + path.sep) && full !== workspace) {
      throw new Error("Path traversal not allowed.");
    }
    if (!fs.existsSync(full)) break;
    savedFileName = `${base}-${i}${ext}`;
  }

  const finalPath = path.resolve(workspace, savedFileName);
  fs.writeFileSync(finalPath, content, "utf-8");
  return { savedFileName };
}

export function SendFileToUserTool(agentId: string | null | undefined) {
  return tool(
    async (input) => {
      if (!agentId) {
        return "This agent has no ID — cannot send files. Contact an admin.";
      }

      const agent = await Agent.findByPk(agentId, {
        attributes: ["id", "workspacePath"],
      });
      const workspace = agent?.workspacePath;
      if (!workspace) {
        return "Workspace not configured for this agent — cannot send files.";
      }

      const fileName = path.basename(String(input.fileName).trim());
      if (!fileName || fileName === "." || fileName === "..") {
        return "Invalid file name.";
      }
      const ext = path.extname(fileName).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) {
        return `Only ${[...ALLOWED_EXT].join(", ")} files can be sent.`;
      }

      const full = path.resolve(workspace, fileName);
      if (!full.startsWith(workspace + path.sep) && full !== workspace) {
        return "Invalid file name — path traversal is not allowed.";
      }
      if (!fs.existsSync(full)) {
        return (
          `File "${fileName}" does not exist in your workspace. ` +
          `Write it first using the filesystem MCP \`write_file\` tool (with your full WORKSPACE_PATH as prefix), then call send_file_to_user again.`
        );
      }

      const url = buildAttachmentUrl(agentId, fileName);
      const caption = input.caption?.trim();
      const markdown = `[📎 ${fileName}](${url})`;
      const intro = caption ? `${caption}\n\n${markdown}` : markdown;
      return (
        `Attachment link ready. Include the following markdown verbatim in your ` +
        `reply to the user so the chat UI renders it as a downloadable attachment:\n\n` +
        intro
      );
    },
    {
      name: "send_file_to_user",
      description:
        "Sends a file from your workspace to the user as a downloadable " +
        "attachment in the chat. The file must already exist in your " +
        "workspace (use workspace_write_file first). Only .md and .txt are " +
        "supported. Returns markdown you must paste verbatim into your reply.",
      schema: z.object({
        fileName: z
          .string()
          .min(1)
          .describe(
            "The file name in your workspace to send (e.g. 'report.md'). Must be .md or .txt. Use the filesystem MCP write_file tool to create it first if it does not already exist.",
          ),
        caption: z
          .string()
          .optional()
          .describe(
            "Optional short caption to show above the attachment chip.",
          ),
      }),
    },
  );
}
