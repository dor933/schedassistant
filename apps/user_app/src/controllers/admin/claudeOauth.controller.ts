import { Request, Response } from "express";
import { ClaudeOauthService } from "../../services/admin/claudeOauth.service";
import { logger } from "../../logger";

function handleError(res: Response, err: any, scope: string) {
  if (err?.status) return res.status(err.status).json({ error: err.message });
  logger.error(`Admin claude-oauth-token ${scope} error`, { error: err?.message });
  return res.status(500).json({ error: "Internal server error." });
}

export class ClaudeOauthController {
  private service = new ClaudeOauthService();

  get = async (_req: Request, res: Response) => {
    try {
      return res.json(await this.service.get());
    } catch (err: any) {
      return handleError(res, err, "GET");
    }
  };

  set = async (req: Request, res: Response) => {
    const { token } = req.body ?? {};
    if (typeof token !== "string") {
      return res.status(400).json({ error: "token must be a string." });
    }
    try {
      return res.json(await this.service.set(token));
    } catch (err: any) {
      return handleError(res, err, "PUT");
    }
  };

  remove = async (_req: Request, res: Response) => {
    try {
      return res.json(await this.service.remove());
    } catch (err: any) {
      return handleError(res, err, "DELETE");
    }
  };
}
