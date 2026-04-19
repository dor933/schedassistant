import { Request, Response } from "express";
import { McpServer } from "@scheduling-agent/database";
import { logger } from "../../logger";

/**
 * MCP servers are a platform-wide registry (no `organizationId`). Now that
 * `super_admin` is strictly tenant-scoped, gating mutations on that role would
 * let any org creator edit config every tenant shares. Mutations therefore
 * happen out-of-band (direct DB access), matching the pattern documented in
 * `auth.service.ts`. The API stays read-only.
 */
export class McpServersController {
  getAll = async (_req: Request, res: Response) => {
    try {
      const servers = await McpServer.findAll({
        attributes: ["id", "name", "transport", "command", "args", "env"],
        order: [["name", "ASC"]],
      });
      return res.json(servers);
    } catch (err: any) {
      logger.error("GET /mcp-servers error:", err);
      return res.status(500).json({ error: err.message });
    }
  };
}
