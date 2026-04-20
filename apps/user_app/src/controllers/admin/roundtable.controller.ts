import { Request, Response } from "express";
import { RoundtableService } from "../../services/admin/roundtable.service";
import { logger } from "../../logger";

export class RoundtableController {
  private service = new RoundtableService();

  getAll = async (req: Request, res: Response) => {
    try {
      const roundtables = await this.service.getAll(req.user!.userId);
      return res.json(roundtables);
    } catch (err: any) {
      logger.error("GET /roundtables error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  getById = async (req: Request, res: Response) => {
    try {
      const data = await this.service.getById(req.params.id as string);
      if (!data) {
        return res.status(404).json({ error: "Roundtable not found" });
      }
      return res.json(data);
    } catch (err: any) {
      logger.error("GET /roundtables/:id error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  create = async (req: Request, res: Response) => {
    try {
      // Back-compat: if the old `includeUser` flag is sent, treat the creator
      // as the sole participant. New clients send `participantUserIds` directly.
      const participantUserIds: number[] = Array.isArray(req.body.participantUserIds)
        ? (req.body.participantUserIds as unknown[])
            .map((v) => Number(v))
            .filter((n) => Number.isFinite(n))
        : req.body.includeUser
          ? [req.user!.userId]
          : [];

      const result = await this.service.create(
        req.user!.userId,
        req.user!.organizationId,
        req.body.topic,
        req.body.agentIds,
        req.body.maxTurnsPerAgent,
        participantUserIds,
      );
      return res.status(201).json(result);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("POST /roundtables error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  stop = async (req: Request, res: Response) => {
    try {
      const result = await this.service.stop(req.params.id as string, req.user!.userId);
      return res.json(result);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("POST /roundtables/:id/stop error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  submitUserTurn = async (req: Request, res: Response) => {
    try {
      const result = await this.service.submitUserTurn(
        req.params.id as string,
        req.user!.userId,
        req.body.content ?? "",
      );
      return res.json(result);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("POST /roundtables/:id/user-turn error:", err);
      return res.status(500).json({ error: err.message });
    }
  };
}
