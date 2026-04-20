import { Request, Response } from "express";
import { UsersService } from "../../services/admin/users.service";
import { logger } from "../../logger";

export class UsersController {
  private usersService = new UsersService();

  getAll = async (req: Request, res: Response) => {
    try {
      const users = await this.usersService.getAll(req.user!.organizationId);
      return res.json(users);
    } catch (err: any) {
      logger.error("GET /users error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  create = async (req: Request, res: Response) => {
    try {
      const user = await this.usersService.create(
        req.user!.role,
        req.user!.userId,
        req.user!.organizationId,
        {
          userName: req.body.userName,
          displayName: req.body.displayName,
          password: req.body.password,
          roleId: req.body.roleId ?? null,
        },
      );
      return res.status(201).json(user);
    } catch (err: any) {
      if (err?.issues) {
        // Zod error — surface the first message so the UI can render it.
        return res.status(400).json({ error: err.issues[0]?.message ?? "Invalid input." });
      }
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("POST /users error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  update = async (req: Request, res: Response) => {
    try {
      const user = await this.usersService.update(
        Number(req.params.id),
        req.user!.role,
        req.user!.userId,
        req.user!.organizationId,
        { displayName: req.body.displayName, userIdentity: req.body.userIdentity, roleId: req.body.roleId },
      );
      return res.json(user);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("PATCH /users/:id error:", err);
      return res.status(500).json({ error: err.message });
    }
  };
}
