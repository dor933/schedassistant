import { Request, Response } from "express";
import {
  AgentUserScopesService,
  listGoogleAuthedUsers,
} from "../../services/admin/agentUserScopes.service";
import { logger } from "../../logger";

export class AgentUserScopesController {
  private service = new AgentUserScopesService();

  /**
   * GET /admin/google-users
   * Users in the caller's org that have authenticated via Google — the only
   * users eligible to be scope subjects.
   */
  listGoogleUsers = async (req: Request, res: Response) => {
    try {
      const users = await listGoogleAuthedUsers(req.user!.organizationId);
      return res.json(users);
    } catch (err: any) {
      logger.error("GET /admin/google-users error", { error: err?.message });
      return res.status(500).json({ error: err.message });
    }
  };

  /**
   * GET /admin/agents/:agentId/user-scopes
   * Matrix of (subjectUserId, scope) for one agent, scoped to caller's org.
   */
  listForAgent = async (req: Request, res: Response) => {
    try {
      const result = await this.service.listByAgent(
        String(req.params.agentId),
        req.user!.organizationId,
      );
      return res.json(result);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("GET agent scopes error", { error: err?.message });
      return res.status(500).json({ error: err.message });
    }
  };

  /**
   * POST /admin/agents/:agentId/user-scopes
   * Body: { subjectUserId: number, scope: string }
   */
  grant = async (req: Request, res: Response) => {
    const { subjectUserId, scope } = req.body ?? {};
    if (typeof subjectUserId !== "number" || typeof scope !== "string") {
      return res
        .status(400)
        .json({ error: "subjectUserId (number) and scope (string) required." });
    }
    try {
      const row = await this.service.grant({
        agentId: String(req.params.agentId),
        subjectUserId,
        scope,
        grantedByUserId: req.user!.userId,
        organizationId: req.user!.organizationId,
      });
      return res.status(201).json(row);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("POST agent scopes error", { error: err?.message });
      return res.status(500).json({ error: err.message });
    }
  };

  /**
   * DELETE /admin/agents/:agentId/user-scopes
   * Body: { subjectUserId: number, scope: string }
   */
  revoke = async (req: Request, res: Response) => {
    const { subjectUserId, scope } = req.body ?? {};
    if (typeof subjectUserId !== "number" || typeof scope !== "string") {
      return res
        .status(400)
        .json({ error: "subjectUserId (number) and scope (string) required." });
    }
    try {
      const removed = await this.service.revoke({
        agentId: String(req.params.agentId),
        subjectUserId,
        scope,
        organizationId: req.user!.organizationId,
        actorId: req.user!.userId,
      });
      return res.json({ removed });
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("DELETE agent scopes error", { error: err?.message });
      return res.status(500).json({ error: err.message });
    }
  };
}
