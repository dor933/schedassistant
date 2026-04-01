import { Request, Response } from "express";
import { McpServer } from "@scheduling-agent/database";
import { logger } from "../../logger";

export class McpServersController {
  getAll = async (_req: Request, res: Response) => {
    try {
      const servers = await McpServer.findAll({
        attributes: ["id", "name", "transport", "command", "args"],
        order: [["name", "ASC"]],
      });
      return res.json(servers);
    } catch (err: any) {
      logger.error("GET /mcp-servers error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  create = async (req: Request, res: Response) => {
    if (req.user!.role !== "super_admin") {
      return res.status(403).json({ error: "Only super admins can create MCP servers." });
    }

    const { name, transport, command, args, env } = req.body;

    if (!name?.trim() || !command?.trim()) {
      return res.status(400).json({ error: "Name and command are required." });
    }

    try {
      const server = await McpServer.create({
        name: name.trim(),
        transport: (transport || "stdio").trim(),
        command: command.trim(),
        args: Array.isArray(args) ? args : [],
        env: env && typeof env === "object" && Object.keys(env).length > 0 ? env : null,
      });
      return res.status(201).json(server);
    } catch (err: any) {
      if (err.name === "SequelizeUniqueConstraintError") {
        return res.status(409).json({ error: `An MCP server named "${name.trim()}" already exists.` });
      }
      logger.error("POST /mcp-servers error:", err);
      return res.status(500).json({ error: err.message });
    }
  };
}
