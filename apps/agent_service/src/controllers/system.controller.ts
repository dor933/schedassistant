import type { Request, Response } from "express";
import {
  ClaudeOauthTokenError,
  clear as clearClaudeOauthToken,
  describe as describeClaudeOauthToken,
  probeAgentSideEnv as probeClaudeOauthAgentSide,
  set as setClaudeOauthToken,
} from "../services/claudeOauthToken.service";
import { logger } from "../logger";

function handleError(res: Response, err: unknown, scope: string): Response {
  if (err instanceof ClaudeOauthTokenError) {
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

  /**
   * Diagnostic probe — confirms (a) the running Node process has the env var
   * set, and (b) it propagates through `su-exec agent` exactly the way the
   * Claude CLI is spawned. Never returns the token value; only presence +
   * length. Useful for triage when the CLI claims it's not authenticated.
   */
  probeClaudeOauthToken = async (_req: Request, res: Response) => {
    try {
      return res.json(probeClaudeOauthAgentSide());
    } catch (err) {
      return handleError(res, err, "POST /system/claude-oauth-token/probe error");
    }
  };
}
