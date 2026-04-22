import fs from "node:fs";
import path from "node:path";
import { tool } from "@langchain/core/tools";
import { Agent } from "@scheduling-agent/database";
import { z } from "zod";

/**
 * Optional callback surface that observes durable file writes/edits/deletes.
 * Passed by the deep agent worker so it can report back to the caller which
 * files were modified in the caller's shared workspace.
 */
export interface WorkspaceWriteRecorder {
  record(action: "write" | "edit" | "delete", fileName: string): void;
}

/** Resolve and validate the workspace directory for an agent. */
async function resolveWorkspace(agentId: string): Promise<string | null> {
  const agent = await Agent.findByPk(agentId, {
    attributes: ["id", "workspacePath"],
  });
  return agent?.workspacePath ?? null;
}

/** Ensure workspace dir exists (idempotent). */
function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

/** Guard against path traversal — the resolved path must stay inside the workspace root. */
function safePath(workspace: string, fileName: string): string | null {
  const resolved = path.resolve(workspace, fileName);
  if (!resolved.startsWith(workspace + path.sep) && resolved !== workspace) {
    return null;
  }
  return resolved;
}

/** Restrict to allowed extensions. */
const ALLOWED_EXT = new Set([".md", ".txt"]);
function hasAllowedExt(filePath: string): boolean {
  return ALLOWED_EXT.has(path.extname(filePath).toLowerCase());
}

// ─── Tools ──────────────────────────────────────────────────────────────────

export function WorkspaceListFilesTool(agentId: string) {
  return tool(
    async () => {
      const workspace = await resolveWorkspace(agentId);
      if (!workspace) return "Workspace not configured for this agent.";
      ensureDir(workspace);

      const entries = fs.readdirSync(workspace).filter((f) => {
        const ext = path.extname(f).toLowerCase();
        return ALLOWED_EXT.has(ext);
      });

      if (entries.length === 0) return "Your workspace is empty — no files yet.";
      return "Files in your workspace:\n" + entries.map((f) => `- ${f}`).join("\n");
    },
    {
      name: "workspace_list_files",
      description:
        "Lists all files in your persistent workspace folder. " +
        "Use this to see what files you have saved.",
      schema: z.object({}),
    },
  );
}

export function WorkspaceReadFileTool(agentId: string) {
  return tool(
    async (input) => {
      const workspace = await resolveWorkspace(agentId);
      if (!workspace) return "Workspace not configured for this agent.";

      const filePath = safePath(workspace, input.fileName);
      if (!filePath) return "Invalid file name — path traversal is not allowed.";
      if (!hasAllowedExt(filePath))
        return `Only ${[...ALLOWED_EXT].join(", ")} files are supported.`;

      if (!fs.existsSync(filePath)) return `File "${input.fileName}" does not exist in your workspace.`;

      const content = fs.readFileSync(filePath, "utf-8");
      return `Contents of ${input.fileName}:\n\n${content}`;
    },
    {
      name: "workspace_read_file",
      description:
        "Reads the full content of a file from your persistent workspace. " +
        "Use this to review files you previously saved.",
      schema: z.object({
        fileName: z
          .string()
          .min(1)
          .describe("The file name to read (e.g. 'notes.md'). Must be .md or .txt."),
      }),
    },
  );
}

export function WorkspaceWriteFileTool(agentId: string, recorder?: WorkspaceWriteRecorder) {
  return tool(
    async (input) => {
      const workspace = await resolveWorkspace(agentId);
      if (!workspace) return "Workspace not configured for this agent.";
      ensureDir(workspace);

      const filePath = safePath(workspace, input.fileName);
      if (!filePath) return "Invalid file name — path traversal is not allowed.";
      if (!hasAllowedExt(filePath))
        return `Only ${[...ALLOWED_EXT].join(", ")} files are supported.`;

      fs.writeFileSync(filePath, input.content, "utf-8");
      recorder?.record("write", input.fileName);
      return `File "${input.fileName}" written successfully (${input.content.length} chars).`;
    },
    {
      name: "workspace_write_file",
      description:
        "Creates or overwrites a file in your persistent workspace. " +
        "Use this to save important documents, plans, research, or any information you want to persist across conversations. " +
        "If the file already exists it will be fully replaced.",
      schema: z.object({
        fileName: z
          .string()
          .min(1)
          .describe("The file name to write (e.g. 'project-plan.md'). Must be .md or .txt."),
        content: z
          .string()
          .describe("The full content to write to the file."),
      }),
    },
  );
}

export function WorkspaceEditFileTool(agentId: string, recorder?: WorkspaceWriteRecorder) {
  return tool(
    async (input) => {
      const workspace = await resolveWorkspace(agentId);
      if (!workspace) return "Workspace not configured for this agent.";

      const filePath = safePath(workspace, input.fileName);
      if (!filePath) return "Invalid file name — path traversal is not allowed.";
      if (!hasAllowedExt(filePath))
        return `Only ${[...ALLOWED_EXT].join(", ")} files are supported.`;

      if (!fs.existsSync(filePath))
        return `File "${input.fileName}" does not exist. Use workspace_write_file to create it first.`;

      const current = fs.readFileSync(filePath, "utf-8");

      if (!current.includes(input.oldText)) {
        return `The old_text was not found in "${input.fileName}". Make sure it matches exactly (including whitespace).`;
      }

      const updated = current.replace(input.oldText, input.newText);
      fs.writeFileSync(filePath, updated, "utf-8");
      recorder?.record("edit", input.fileName);
      return `File "${input.fileName}" edited successfully. Replaced ${input.oldText.length} chars with ${input.newText.length} chars.`;
    },
    {
      name: "workspace_edit_file",
      description:
        "Edits a file in your workspace by replacing a specific text snippet. " +
        "First read the file with workspace_read_file, then provide the exact text to find and its replacement. " +
        "Only the first occurrence is replaced.",
      schema: z.object({
        fileName: z
          .string()
          .min(1)
          .describe("The file name to edit (e.g. 'notes.md'). Must be .md or .txt."),
        oldText: z
          .string()
          .min(1)
          .describe("The exact text to find in the file."),
        newText: z
          .string()
          .describe("The replacement text."),
      }),
    },
  );
}

export function WorkspaceDeleteFileTool(agentId: string, recorder?: WorkspaceWriteRecorder) {
  return tool(
    async (input) => {
      const workspace = await resolveWorkspace(agentId);
      if (!workspace) return "Workspace not configured for this agent.";

      const filePath = safePath(workspace, input.fileName);
      if (!filePath) return "Invalid file name — path traversal is not allowed.";
      if (!hasAllowedExt(filePath))
        return `Only ${[...ALLOWED_EXT].join(", ")} files are supported.`;

      if (!fs.existsSync(filePath))
        return `File "${input.fileName}" does not exist in your workspace.`;

      fs.unlinkSync(filePath);
      recorder?.record("delete", input.fileName);
      return `File "${input.fileName}" deleted.`;
    },
    {
      name: "workspace_delete_file",
      description:
        "Deletes a file from your persistent workspace. This cannot be undone.",
      schema: z.object({
        fileName: z
          .string()
          .min(1)
          .describe("The file name to delete (e.g. 'old-notes.md')."),
      }),
    },
  );
}

/**
 * Saves a user-uploaded attachment into the agent's workspace with a
 * version-suffix collision policy: `notes.md` → `notes-2.md` → `notes-3.md`.
 * Returns the final file name actually written (callers need it to build the
 * attachment URL and the conversation message).
 *
 * Shares `resolveWorkspace` / `ensureDir` / `safePath` / `hasAllowedExt` with
 * the agent-facing workspace tools so the constraints stay in lockstep
 * (`.md`/`.txt` only, no path traversal).
 */
export async function saveUserAttachmentToAgentWorkspace(
  agentId: string,
  originalName: string,
  content: string,
): Promise<{ savedFileName: string; workspacePath: string }> {
  const workspace = await resolveWorkspace(agentId);
  if (!workspace) {
    throw new Error("Workspace not configured for this agent.");
  }
  ensureDir(workspace);

  const baseName = path.basename(String(originalName).trim());
  if (!baseName || baseName === "." || baseName === "..") {
    throw new Error("Invalid file name.");
  }
  const ext = path.extname(baseName).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error(`Only ${[...ALLOWED_EXT].join(", ")} files are supported.`);
  }
  const stem = baseName.slice(0, baseName.length - ext.length);

  let candidate = baseName;
  let n = 2;
  while (fs.existsSync(path.join(workspace, candidate))) {
    candidate = `${stem}-${n}${ext}`;
    n += 1;
  }

  const filePath = safePath(workspace, candidate);
  if (!filePath) throw new Error("Invalid file path.");

  fs.writeFileSync(filePath, content, "utf-8");
  return { savedFileName: candidate, workspacePath: workspace };
}

/**
 * Convenience: returns all workspace tools for an agent.
 *
 * The optional `recorder` is used when a system/executor agent writes to a
 * caller's workspace on its behalf — the deep agent worker passes a recorder
 * so it can summarise the writes back to the caller in the delegation result.
 */
export function workspaceTools(agentId: string, recorder?: WorkspaceWriteRecorder) {
  return [
    WorkspaceListFilesTool(agentId),
    WorkspaceReadFileTool(agentId),
    WorkspaceWriteFileTool(agentId, recorder),
    WorkspaceEditFileTool(agentId, recorder),
    WorkspaceDeleteFileTool(agentId, recorder),
  ];
}
