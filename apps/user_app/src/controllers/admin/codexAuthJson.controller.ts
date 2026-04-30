import { Request, Response } from "express";
import { CodexAuthJsonService } from "../../services/admin/codexAuthJson.service";
import { logger } from "../../logger";

function handleError(res: Response, err: any, scope: string) {
  if (err?.status) return res.status(err.status).json({ error: err.message });
  logger.error(`Admin codex-auth-json ${scope} error`, { error: err?.message });
  return res.status(500).json({ error: "Internal server error." });
}

export class CodexAuthJsonController {
  private service = new CodexAuthJsonService();

  get = async (_req: Request, res: Response) => {
    try {
      return res.json(await this.service.get());
    } catch (err: any) {
      return handleError(res, err, "GET");
    }
  };

  set = async (req: Request, res: Response) => {
    const { blob } = req.body ?? {};
    if (typeof blob !== "string" && (typeof blob !== "object" || blob === null)) {
      return res
        .status(400)
        .json({ error: "blob must be a JSON string or object." });
    }
    try {
      return res.json(await this.service.set(blob));
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
