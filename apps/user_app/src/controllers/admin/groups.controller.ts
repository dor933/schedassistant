import { Request, Response } from "express";
import { GroupsService } from "../../services/admin/groups.service";
import { logger } from "../../logger";

export class GroupsController {
  private groupsService = new GroupsService();

  getAll = async (_req: Request, res: Response) => {
    try {
      const groups = await this.groupsService.getAll();
      return res.json(groups);
    } catch (err: any) {
      logger.error("GET /groups error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  create = async (req: Request, res: Response) => {
    const { name, agentId, memberUserIds } = req.body;
    if (!name || !agentId) return res.status(400).json({ error: "name and agentId are required." });
    try {
      const group = await this.groupsService.create(name, agentId, memberUserIds, req.user!.userId);
      return res.status(201).json(group);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("POST /groups error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  rename = async (req: Request, res: Response) => {
    try {
      const group = await this.groupsService.rename(req.params.id as string, req.body.name, req.user!.userId);
      return res.json(group);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("PATCH /groups/:id error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  remove = async (req: Request, res: Response) => {
    try {
      const result = await this.groupsService.remove(req.params.id as string, req.user!.userId);
      return res.json(result);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("DELETE /groups/:id error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  getMembers = async (req: Request, res: Response) => {
    try {
      const members = await this.groupsService.getMembers(req.params.groupId as string);
      return res.json(members);
    } catch (err: any) {
      logger.error("GET /groups/:id/members error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  addMember = async (req: Request, res: Response) => {
    if (!req.body.userId) return res.status(400).json({ error: "userId is required." });
    try {
      const { member, created } = await this.groupsService.addMember(req.params.groupId as string, req.body.userId, req.user!.userId);
      return res.status(created ? 201 : 200).json(member);
    } catch (err: any) {
      logger.error("POST /groups/:id/members error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  removeMember = async (req: Request, res: Response) => {
    try {
      const result = await this.groupsService.removeMember(
        req.params.groupId as string,
        Number(req.params.userId),
        req.user!.userId,
      );
      return res.json(result);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("DELETE member error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

}
