import { Request, Response } from "express";
import { McpServer } from "@scheduling-agent/database";
import { Op } from "sequelize";
import { CliMcpConfigService } from "../../services/admin/codexMcp.service";
import { getIO } from "../../sockets/server/socketServer";
import { logger } from "../../logger";

type EnvMap = Record<string, string>;

function httpError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function asString(value: unknown, field: string, required: boolean): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw httpError(`${field} is required.`, 400);
    return undefined;
  }
  if (typeof value !== "string") {
    throw httpError(`${field} must be a string.`, 400);
  }
  const trimmed = value.trim();
  if (required && !trimmed) throw httpError(`${field} is required.`, 400);
  return trimmed;
}

function asNullableString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw httpError(`${field} must be a string or null.`, 400);
  }
  return value.trim() || null;
}

function asScriptContent(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw httpError("scriptContent must be a string or null.", 400);
  }
  return value.trim() ? value : null;
}

function asArgs(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw httpError("args must be an array of strings.", 400);
  }
  return value;
}

function asEnv(value: unknown): EnvMap | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw httpError("env must be an object of string values or null.", 400);
  }

  const out: EnvMap = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (!key) throw httpError("env keys must be non-empty strings.", 400);
    if (typeof rawValue !== "string") {
      throw httpError(`env.${key} must be a string.`, 400);
    }
    out[key] = rawValue;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function asTransport(value: unknown, required: boolean): string | undefined {
  const transport = asString(value, "transport", required);
  if (!transport) return undefined;
  if (transport !== "stdio") {
    throw httpError("Only stdio MCP servers are currently supported.", 400);
  }
  return transport;
}

function toClient(row: McpServer, includeScript: boolean) {
  const plain = row.toJSON() as any;
  const scriptContent =
    typeof plain.scriptContent === "string" && plain.scriptContent.length > 0
      ? plain.scriptContent
      : null;

  return {
    id: plain.id as number,
    organizationId: (plain.organizationId ?? null) as string | null,
    name: plain.name as string,
    description: (plain.description ?? null) as string | null,
    transport: plain.transport as string,
    command: plain.command as string,
    args: Array.isArray(plain.args) ? (plain.args as string[]) : [],
    env: (plain.env ?? null) as EnvMap | null,
    scriptContent: includeScript ? scriptContent : undefined,
    isScript: scriptContent !== null,
  };
}

function broadcast(type: string, message: string, actorId?: number): void {
  try {
    getIO().emit("admin:change", { type, message, actorId });
  } catch (err) {
    logger.error("broadcastAdminChange (mcp servers)", { error: String(err) });
  }
}

function handleError(res: Response, err: any, scope: string) {
  if (err?.status) return res.status(err.status).json({ error: err.message });
  if (err?.name === "SequelizeUniqueConstraintError") {
    return res.status(409).json({ error: "An MCP server with that name already exists." });
  }
  logger.error(scope, { error: err?.message ?? String(err) });
  return res.status(500).json({ error: err?.message ?? "Internal server error." });
}

export class McpServersController {
  private cliMcp = new CliMcpConfigService();

  getAll = async (req: Request, res: Response) => {
    try {
      const servers = await McpServer.findAll({
        where: {
          [Op.or]: [
            { organizationId: null },
            { organizationId: req.user!.organizationId },
          ],
        },
        attributes: [
          "id",
          "organizationId",
          "name",
          "description",
          "transport",
          "command",
          "args",
          "env",
          "scriptContent",
        ],
        order: [
          ["organizationId", "DESC"],
          ["name", "ASC"],
        ],
      });
      return res.json(
        servers.map((row) => toClient(row, req.user!.role === "super_admin")),
      );
    } catch (err: any) {
      return handleError(res, err, "GET /mcp-servers error");
    }
  };

  create = async (req: Request, res: Response) => {
    try {
      const scriptContent = asScriptContent(req.body?.scriptContent);
      const isScript = typeof scriptContent === "string" && scriptContent.length > 0;

      const row = await McpServer.create({
        organizationId: req.user!.organizationId,
        name: asString(req.body?.name, "name", true)!,
        description: asNullableString(req.body?.description, "description") ?? null,
        transport: asTransport(req.body?.transport ?? "stdio", true)!,
        command: isScript ? "node" : asString(req.body?.command, "command", true)!,
        args: isScript ? [] : asArgs(req.body?.args) ?? [],
        env: asEnv(req.body?.env) ?? null,
        scriptContent: isScript ? scriptContent : null,
      });

      if (isScript) {
        try {
          const persisted = await this.cliMcp.persistScript(row.id, scriptContent);
          await row.update({ command: persisted.command, args: persisted.args });
        } catch (err) {
          await row.destroy().catch(() => undefined);
          throw err;
        }
      }

      await this.cliMcp.renderCliConfigsBestEffort("mcp-create");
      broadcast("mcp_server_created", `MCP server "${row.name}" created`, req.user!.userId);
      return res.status(201).json(toClient(row, true));
    } catch (err: any) {
      return handleError(res, err, "POST /mcp-servers error");
    }
  };

  update = async (req: Request, res: Response) => {
    try {
      const row = await this.findOwned(req.params.id, req.user!.organizationId);
      const patch: Partial<{
        name: string;
        description: string | null;
        transport: string;
        command: string;
        args: string[];
        env: EnvMap | null;
        scriptContent: string | null;
      }> = {};

      const name = asString(req.body?.name, "name", false);
      if (name !== undefined) patch.name = name;

      const description = asNullableString(req.body?.description, "description");
      if (description !== undefined) patch.description = description;

      const transport = asTransport(req.body?.transport, false);
      if (transport !== undefined) patch.transport = transport;

      const env = asEnv(req.body?.env);
      if (env !== undefined) patch.env = env;

      const args = asArgs(req.body?.args);
      if (args !== undefined) patch.args = args;

      const scriptContent = asScriptContent(req.body?.scriptContent);
      if (typeof scriptContent === "string" && scriptContent.length > 0) {
        const persisted = await this.cliMcp.persistScript(row.id, scriptContent);
        patch.scriptContent = scriptContent;
        patch.command = persisted.command;
        patch.args = persisted.args;
      } else if (scriptContent === null) {
        await this.cliMcp.deleteScript(row.id).catch((err: any) => {
          logger.warn("Failed to delete Codex MCP script while updating row", {
            rowId: row.id,
            error: err?.message ?? String(err),
          });
        });
        patch.scriptContent = null;
      }

      if (patch.scriptContent !== undefined && patch.scriptContent === null) {
        const command = asString(req.body?.command, "command", true);
        patch.command = command!;
      } else if (patch.scriptContent === undefined) {
        const command = asString(req.body?.command, "command", false);
        if (command !== undefined) patch.command = command;
      }

      await row.update(patch);
      await this.cliMcp.renderCliConfigsBestEffort("mcp-update");
      broadcast("mcp_server_updated", `MCP server "${row.name}" updated`, req.user!.userId);
      return res.json(toClient(row, true));
    } catch (err: any) {
      return handleError(res, err, "PATCH /mcp-servers/:id error");
    }
  };

  remove = async (req: Request, res: Response) => {
    try {
      const row = await this.findOwned(req.params.id, req.user!.organizationId);
      const name = row.name;
      const hadScript = !!row.scriptContent;
      await row.destroy();
      if (hadScript) {
        await this.cliMcp.deleteScript(row.id).catch((err: any) => {
          logger.warn("Failed to delete Codex MCP script after row delete", {
            rowId: row.id,
            error: err?.message ?? String(err),
          });
        });
      }
      await this.cliMcp.renderCliConfigsBestEffort("mcp-delete");
      broadcast("mcp_server_deleted", `MCP server "${name}" deleted`, req.user!.userId);
      return res.json({ ok: true });
    } catch (err: any) {
      return handleError(res, err, "DELETE /mcp-servers/:id error");
    }
  };

  install = async (req: Request, res: Response) => {
    try {
      const sourceId = Number(req.params.id);
      if (!Number.isInteger(sourceId) || sourceId <= 0) {
        throw httpError("id must be a positive integer.", 400);
      }

      const source = await McpServer.findOne({
        where: { id: sourceId, organizationId: null },
      });
      if (!source) throw httpError("Public MCP server not found.", 404);

      const requestedName = asString(req.body?.name, "name", false);
      const row = await McpServer.create({
        organizationId: req.user!.organizationId,
        name: requestedName ?? source.name,
        description: source.description,
        transport: source.transport,
        command: source.scriptContent ? "node" : source.command,
        args: source.scriptContent ? [] : source.args ?? [],
        env: source.env,
        scriptContent: source.scriptContent,
      });

      if (source.scriptContent) {
        try {
          const persisted = await this.cliMcp.persistScript(row.id, source.scriptContent);
          await row.update({ command: persisted.command, args: persisted.args });
        } catch (err) {
          await row.destroy().catch(() => undefined);
          throw err;
        }
      }

      await this.cliMcp.renderCliConfigsBestEffort("mcp-install");
      broadcast(
        "mcp_server_installed",
        `MCP server "${row.name}" installed`,
        req.user!.userId,
      );
      return res.status(201).json(toClient(row, true));
    } catch (err: any) {
      return handleError(res, err, "POST /mcp-servers/:id/install error");
    }
  };

  private async findOwned(
    idParam: string | string[] | undefined,
    organizationId: string,
  ): Promise<McpServer> {
    if (typeof idParam !== "string") {
      throw httpError("id must be a positive integer.", 400);
    }
    const id = Number(idParam);
    if (!Number.isInteger(id) || id <= 0) {
      throw httpError("id must be a positive integer.", 400);
    }
    const row = await McpServer.findOne({ where: { id, organizationId } });
    if (!row) throw httpError("MCP server not found.", 404);
    return row;
  }
}
