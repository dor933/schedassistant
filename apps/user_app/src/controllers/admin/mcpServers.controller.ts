import { Request, Response } from "express";
import { McpServer } from "@scheduling-agent/database";
import { logger } from "../../logger";
import { getIO } from "../../sockets/server/socketServer";

function shellQuoteArg(arg: string): string {
  if (/[\s"'\\]/.test(arg)) return JSON.stringify(arg);
  return arg;
}

/** How the agent_service will spawn this MCP server (stdio: argv = [command, ...args]). */
function buildLaunchSummary(server: McpServer) {
  const args = Array.isArray(server.args) ? server.args : [];
  const humanReadable = [server.command, ...args.map(shellQuoteArg)].join(" ");
  return {
    transport: server.transport,
    executable: server.command,
    arguments: args,
    /** Full argv passed to spawn (command is argv[0]). */
    argv: [server.command, ...args],
    humanReadable,
    envNote:
      "Custom env from the DB is merged on top of the agent_service process environment when the MCP child starts; " +
      "values like {{VAR_NAME}} are replaced from the host at runtime.",
  };
}

export class McpServersController {
  getAll = async (_req: Request, res: Response) => {
    try {
      const servers = await McpServer.findAll({
        attributes: ["id", "name", "transport", "command", "args", "env", "primaryAgentAssignable", "systemAgentAssignable"],
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

  update = async (req: Request, res: Response) => {
    if (req.user!.role !== "super_admin") {
      return res.status(403).json({ error: "Only super admins can update MCP servers." });
    }

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: "Invalid server id." });
    }

    const { args, command, transport, env } = req.body as {
      args?: unknown;
      command?: unknown;
      transport?: unknown;
      env?: unknown;
    };

    if (
      args === undefined &&
      command === undefined &&
      transport === undefined &&
      env === undefined
    ) {
      return res.status(400).json({
        error: "Provide at least one of: args, command, transport, env.",
      });
    }

    try {
      const server = await McpServer.findByPk(id);
      if (!server) {
        return res.status(404).json({ error: "MCP server not found." });
      }

      const updates: Partial<{
        args: string[];
        command: string;
        transport: string;
        env: Record<string, string> | null;
      }> = {};

      if (args !== undefined) {
        if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
          return res.status(400).json({ error: "args must be an array of strings." });
        }
        updates.args = args;
      }
      if (command !== undefined) {
        if (typeof command !== "string" || !command.trim()) {
          return res.status(400).json({ error: "command must be a non-empty string." });
        }
        updates.command = command.trim();
      }
      if (transport !== undefined) {
        if (typeof transport !== "string" || !transport.trim()) {
          return res.status(400).json({ error: "transport must be a non-empty string." });
        }
        updates.transport = transport.trim();
      }
      if (env !== undefined) {
        if (env === null) {
          updates.env = null;
        } else if (env && typeof env === "object" && !Array.isArray(env)) {
          updates.env = env as Record<string, string>;
        } else {
          return res.status(400).json({
            error: "env must be null or a JSON object of string key/value pairs.",
          });
        }
      }

      await server.update(updates);
      await server.reload();

      const launchSummary = buildLaunchSummary(server);
      const actorId = req.user!.userId;
      try {
        getIO().emit("admin:change", {
          type: "mcp_server_updated",
          message: `MCP server "${server.name}" was updated.`,
          data: { serverId: server.id, name: server.name, launchSummary },
          actorId,
        });
      } catch (emitErr) {
        logger.warn("admin:change emit failed after MCP update", { error: String(emitErr) });
      }

      return res.json({
        server,
        launchSummary,
      });
    } catch (err: any) {
      logger.error("PATCH /mcp-servers/:id error:", err);
      return res.status(500).json({ error: err.message });
    }
  };
}
