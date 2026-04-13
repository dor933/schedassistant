import { Router, Request, Response } from "express";
import { Tool } from "@scheduling-agent/database";

const router = Router();

router.get("/", async (_req: Request, res: Response) => {
  try {
    const tools = await Tool.findAll({
      attributes: ["id", "name", "slug", "description", "category"],
      order: [["category", "ASC"], ["name", "ASC"]],
    });
    return res.json(tools);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export { router as toolsRouter };
