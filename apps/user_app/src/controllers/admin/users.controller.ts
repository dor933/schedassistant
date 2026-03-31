import { Request, Response } from "express";
import { UsersService } from "../../services/admin/users.service";
import { logger } from "../../logger";

export class UsersController {
  private usersService = new UsersService();

  getAll = async (_req: Request, res: Response) => {
    try {
      const users = await this.usersService.getAll();
      return res.json(users);
    } catch (err: any) {
      logger.error("GET /users error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  update = async (req: Request, res: Response) => {
    try {
      const user = await this.usersService.update(
        Number(req.params.id),
        req.user!.role,
        req.user!.userId,
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
