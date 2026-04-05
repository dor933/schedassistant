import { Request, Response } from "express";
import { PersonsService } from "../../services/admin/persons.service";
import { logger } from "../../logger";

export class PersonsController {
  private personsService = new PersonsService();

  create = async (req: Request, res: Response) => {
    try {
      const result = await this.personsService.create(req.body, req.user!.userId);
      return res.status(201).json(result);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      if (err.name === "SequelizeUniqueConstraintError") {
        return res
          .status(409)
          .json({ error: "A person with the same unique field already exists (email / userName / jira id)." });
      }
      logger.error("POST /persons error:", err);
      return res.status(500).json({ error: err.message });
    }
  };
}
