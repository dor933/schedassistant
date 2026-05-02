import type { Request, Response } from "express";
import {
  deleteMcpScript,
  persistMcpScript,
  renderCodexConfigToml as renderCodexConfigTomlFile,
} from "../services/codexConfigToml.service";
import { renderClaudeMcpConfig as renderClaudeMcpConfigFile } from "../services/claudeMcpConfig.service";
import { logger } from "../logger";

function handleError(res: Response, err: unknown, scope: string): Response {
  const message = (err as any)?.message ?? "Internal error";
  logger.error(scope, { error: message });
  return res.status(500).json({ error: message });
}

export class SystemController {
  // System-wide `/codex-api-key` endpoints removed (slice 22 follow-up):
  // the legacy `runCliExecution` engine that consumed the deployment-level
  // OPENAI_API_KEY env var was deleted. SDK helpers pin per-org credentials
  // per-call via env scrubbing + injection, so no host-level fallback is
  // consumed anywhere in the runtime. Per-org Codex credentials live as
  // `keyType: "api_key"` (or `"embedding"`) rows on
  // `organization_vendor_api_keys` for the OpenAI vendor.
  //
  // System-wide `/codex-auth-json` endpoints removed in slice 14:
  // the auth.json is now stored per-org on `organization_vendor_api_keys`
  // (key_type='auth_object'). The runner materialises it to a per-turn
  // temp $HOME at invocation time. No system-wide file, no admin
  // endpoint here.

  /** Re-render /home/agent/.codex/config.toml from the mcp_servers table. */
  renderCodexConfigToml = async (_req: Request, res: Response) => {
    try {
      return res.json(await renderCodexConfigTomlFile());
    } catch (err) {
      return handleError(res, err, "POST /system/codex-config-toml/render error");
    }
  };

  /** Re-render /home/agent/.claude/mcp-from-db.json from the mcp_servers table. */
  renderClaudeMcpConfig = async (_req: Request, res: Response) => {
    try {
      return res.json(await renderClaudeMcpConfigFile());
    } catch (err) {
      return handleError(res, err, "POST /system/claude-mcp-config/render error");
    }
  };

  /** Persist a custom JS MCP script inside the Codex home volume. */
  persistCodexMcpScript = async (req: Request, res: Response) => {
    const rowId = Number(req.params.id);
    const { scriptContent } = req.body ?? {};
    if (!Number.isInteger(rowId) || rowId <= 0) {
      return res.status(400).json({ error: "id must be a positive integer." });
    }
    if (typeof scriptContent !== "string" || !scriptContent.trim()) {
      return res.status(400).json({ error: "scriptContent must be a non-empty string." });
    }
    try {
      return res.json(persistMcpScript(rowId, scriptContent));
    } catch (err) {
      return handleError(res, err, "PUT /system/codex-mcp-scripts/:id error");
    }
  };

  /** Delete a previously persisted custom JS MCP script. */
  deleteCodexMcpScript = async (req: Request, res: Response) => {
    const rowId = Number(req.params.id);
    if (!Number.isInteger(rowId) || rowId <= 0) {
      return res.status(400).json({ error: "id must be a positive integer." });
    }
    try {
      deleteMcpScript(rowId);
      return res.json({ ok: true });
    } catch (err) {
      return handleError(res, err, "DELETE /system/codex-mcp-scripts/:id error");
    }
  };
}
