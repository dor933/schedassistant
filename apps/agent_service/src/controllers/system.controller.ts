import type { Request, Response } from "express";
import {
  ClaudeOauthTokenError,
  clear as clearClaudeOauthToken,
  describe as describeClaudeOauthToken,
  set as setClaudeOauthToken,
} from "../services/claudeOauthToken.service";
import {
  CodexAuthTokenError,
  clear as clearCodexAuthToken,
  describe as describeCodexAuthToken,
  set as setCodexAuthToken,
} from "../services/codexAuthToken.service";
import {
  CodexAuthJsonError,
  clear as clearCodexAuthJson,
  describe as describeCodexAuthJson,
  set as setCodexAuthJson,
} from "../services/codexAuthJson.service";
import {
  deleteMcpScript,
  persistMcpScript,
  renderCodexConfigToml as renderCodexConfigTomlFile,
} from "../services/codexConfigToml.service";
import { renderClaudeMcpConfig as renderClaudeMcpConfigFile } from "../services/claudeMcpConfig.service";
import { logger } from "../logger";

function handleError(res: Response, err: unknown, scope: string): Response {
  if (
    err instanceof ClaudeOauthTokenError ||
    err instanceof CodexAuthTokenError ||
    err instanceof CodexAuthJsonError
  ) {
    return res.status(err.status).json({ error: err.message });
  }
  const message = (err as any)?.message ?? "Internal error";
  logger.error(scope, { error: message });
  return res.status(500).json({ error: message });
}

export class SystemController {
  /** Status of the persisted CLAUDE_CODE_OAUTH_TOKEN — never returns the raw value. */
  getClaudeOauthToken = async (_req: Request, res: Response) => {
    try {
      return res.json(describeClaudeOauthToken());
    } catch (err) {
      return handleError(res, err, "GET /system/claude-oauth-token error");
    }
  };

  /** Persist a new token to disk and load it into process.env. */
  setClaudeOauthToken = async (req: Request, res: Response) => {
    const { token } = req.body ?? {};
    if (typeof token !== "string") {
      return res.status(400).json({ error: "token must be a string." });
    }
    try {
      return res.json(setClaudeOauthToken(token));
    } catch (err) {
      return handleError(res, err, "PUT /system/claude-oauth-token error");
    }
  };

  /** Remove the token (CLI falls back to interactive login next time). */
  deleteClaudeOauthToken = async (_req: Request, res: Response) => {
    try {
      return res.json(clearClaudeOauthToken());
    } catch (err) {
      return handleError(res, err, "DELETE /system/claude-oauth-token error");
    }
  };

  /** Status of the persisted OPENAI_API_KEY for the codex CLI — never returns the raw value. */
  getCodexApiKey = async (_req: Request, res: Response) => {
    try {
      return res.json(describeCodexAuthToken());
    } catch (err) {
      return handleError(res, err, "GET /system/codex-api-key error");
    }
  };

  /** Persist a new key to disk and load it into process.env as OPENAI_API_KEY. */
  setCodexApiKey = async (req: Request, res: Response) => {
    const { token } = req.body ?? {};
    if (typeof token !== "string") {
      return res.status(400).json({ error: "token must be a string." });
    }
    try {
      return res.json(setCodexAuthToken(token));
    } catch (err) {
      return handleError(res, err, "PUT /system/codex-api-key error");
    }
  };

  /** Remove the key. CLI then falls back to ~/.codex/auth.json or fails. */
  deleteCodexApiKey = async (_req: Request, res: Response) => {
    try {
      return res.json(clearCodexAuthToken());
    } catch (err) {
      return handleError(res, err, "DELETE /system/codex-api-key error");
    }
  };

  /** Status of the persisted /home/agent/.codex/auth.json — never returns secrets. */
  getCodexAuthJson = async (_req: Request, res: Response) => {
    try {
      return res.json(describeCodexAuthJson());
    } catch (err) {
      return handleError(res, err, "GET /system/codex-auth-json error");
    }
  };

  /** Persist a fresh auth.json blob (paste of `~/.codex/auth.json` from a logged-in workstation). */
  setCodexAuthJson = async (req: Request, res: Response) => {
    const { blob } = req.body ?? {};
    if (typeof blob !== "string" && (typeof blob !== "object" || blob === null)) {
      return res
        .status(400)
        .json({ error: "blob must be a JSON string or object." });
    }
    try {
      return res.json(setCodexAuthJson(blob));
    } catch (err) {
      return handleError(res, err, "PUT /system/codex-auth-json error");
    }
  };

  /** Remove the auth.json file. The CLI then falls back to OPENAI_API_KEY or fails. */
  deleteCodexAuthJson = async (_req: Request, res: Response) => {
    try {
      return res.json(clearCodexAuthJson());
    } catch (err) {
      return handleError(res, err, "DELETE /system/codex-auth-json error");
    }
  };

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
