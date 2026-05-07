import {
  McpServer,
  Skill,
  LLMModel,
  Vendor,
  Agent,
} from "@scheduling-agent/database";
import { getIO } from "../../sockets/server/socketServer";
import { logger } from "../../logger";

/**
 * All create/update/delete operations on platform-wide catalogs — MCP
 * servers, skills, models, vendor API keys. The tenant-facing admin API
 * is strictly read-only for these tables (see `mcpServers.controller.ts`
 * for the rationale); mutation lives here behind the platform-admin auth
 * surface instead.
 *
 * Broadcasts are emitted without an `actorId` because platform admins are
 * not users — the socket event's `actorId` field is tenant-user-shaped and
 * would be meaningless here. Clients already render these events as
 * "something changed, refetch" regardless of the actor.
 */

function shellQuoteArg(arg: string): string {
  if (/[\s"'\\]/.test(arg)) return JSON.stringify(arg);
  return arg;
}

function buildLaunchSummary(server: McpServer) {
  const args = Array.isArray(server.args) ? server.args : [];
  const humanReadable = [server.command, ...args.map(shellQuoteArg)].join(" ");
  return {
    transport: server.transport,
    executable: server.command,
    arguments: args,
    argv: [server.command, ...args],
    humanReadable,
  };
}

function broadcast(type: string, message: string, data?: Record<string, unknown>) {
  try {
    getIO().emit("admin:change", { type, message, data });
  } catch (err) {
    logger.error("platform broadcast failed", { error: String(err) });
  }
}

export class PlatformCatalogService {
  // ── MCP servers ────────────────────────────────────────────────────────

  async listMcpServers() {
    return McpServer.findAll({
      attributes: ["id", "name", "transport", "command", "args", "env"],
      order: [["name", "ASC"]],
    });
  }

  async createMcpServer(data: {
    name: string;
    transport?: string;
    command: string;
    args?: unknown;
    env?: unknown;
  }) {
    if (!data.name?.trim() || !data.command?.trim()) {
      throw Object.assign(new Error("Name and command are required."), { status: 400 });
    }
    const args = Array.isArray(data.args) && data.args.every((a) => typeof a === "string")
      ? (data.args as string[])
      : [];
    const env = data.env && typeof data.env === "object" && !Array.isArray(data.env)
      ? (data.env as Record<string, string>)
      : null;

    try {
      const server = await McpServer.create({
        name: data.name.trim(),
        transport: (data.transport || "stdio").trim(),
        command: data.command.trim(),
        args,
        env,
      });
      broadcast("mcp_server_created", `MCP server "${server.name}" was created.`, {
        serverId: server.id,
        name: server.name,
      });
      return server;
    } catch (err: any) {
      if (err.name === "SequelizeUniqueConstraintError") {
        throw Object.assign(
          new Error(`An MCP server named "${data.name.trim()}" already exists.`),
          { status: 409 },
        );
      }
      throw err;
    }
  }

  async updateMcpServer(
    id: number,
    patch: {
      args?: unknown;
      command?: unknown;
      transport?: unknown;
      env?: unknown;
    },
  ) {
    if (
      patch.args === undefined &&
      patch.command === undefined &&
      patch.transport === undefined &&
      patch.env === undefined
    ) {
      throw Object.assign(
        new Error("Provide at least one of: args, command, transport, env."),
        { status: 400 },
      );
    }

    const server = await McpServer.findByPk(id);
    if (!server) throw Object.assign(new Error("MCP server not found."), { status: 404 });

    const updates: Partial<{
      args: string[];
      command: string;
      transport: string;
      env: Record<string, string> | null;
    }> = {};

    if (patch.args !== undefined) {
      if (!Array.isArray(patch.args) || !patch.args.every((a) => typeof a === "string")) {
        throw Object.assign(new Error("args must be an array of strings."), { status: 400 });
      }
      updates.args = patch.args;
    }
    if (patch.command !== undefined) {
      if (typeof patch.command !== "string" || !patch.command.trim()) {
        throw Object.assign(new Error("command must be a non-empty string."), { status: 400 });
      }
      updates.command = patch.command.trim();
    }
    if (patch.transport !== undefined) {
      if (typeof patch.transport !== "string" || !patch.transport.trim()) {
        throw Object.assign(new Error("transport must be a non-empty string."), { status: 400 });
      }
      updates.transport = patch.transport.trim();
    }
    if (patch.env !== undefined) {
      if (patch.env === null) {
        updates.env = null;
      } else if (patch.env && typeof patch.env === "object" && !Array.isArray(patch.env)) {
        updates.env = patch.env as Record<string, string>;
      } else {
        throw Object.assign(
          new Error("env must be null or a JSON object of string key/value pairs."),
          { status: 400 },
        );
      }
    }

    await server.update(updates);
    await server.reload();

    const launchSummary = buildLaunchSummary(server);
    broadcast("mcp_server_updated", `MCP server "${server.name}" was updated.`, {
      serverId: server.id,
      name: server.name,
      launchSummary,
    });
    return { server, launchSummary };
  }

  async deleteMcpServer(id: number) {
    const server = await McpServer.findByPk(id);
    if (!server) throw Object.assign(new Error("MCP server not found."), { status: 404 });
    const name = server.name;
    await server.destroy();
    broadcast("mcp_server_deleted", `MCP server "${name}" was deleted.`, { serverId: id });
    return { deleted: true };
  }

  // ── Skills ─────────────────────────────────────────────────────────────

  async listSkills() {
    const rows = await Skill.findAll({
      attributes: [
        "id",
        "name",
        "slug",
        "description",
        "skillText",
        "locked",
        "createdAt",
        "updatedAt",
      ],
      order: [["name", "ASC"]],
    });
    return rows.map((r) => r.toJSON());
  }

  async createSkill(data: {
    name: string;
    slug?: string | null;
    description?: string | null;
    skillText: string;
  }) {
    if (!data.name?.trim() || !data.skillText?.trim()) {
      throw Object.assign(new Error("name and skillText are required."), { status: 400 });
    }
    try {
      const skill = await Skill.create({
        name: data.name.trim(),
        slug: data.slug?.trim() || null,
        description: data.description?.trim() || null,
        skillText: data.skillText,
      });
      broadcast("skill_created", `Skill "${skill.name}" created`);
      return skill;
    } catch (err: any) {
      if (err.name === "SequelizeUniqueConstraintError") {
        throw Object.assign(new Error("That slug is already in use."), { status: 409 });
      }
      throw err;
    }
  }

  async updateSkill(
    id: number,
    data: {
      name?: string;
      slug?: string | null;
      description?: string | null;
      skillText?: string;
    },
  ) {
    const skill = await Skill.findByPk(id);
    if (!skill) throw Object.assign(new Error("Skill not found."), { status: 404 });
    // Locked skills are seed-managed (see migration
    // 20240101000049-add-locked-to-skills-and-seed-epic-task-workflow.js) and
    // referenced by downstream code via `slug`. Platform admins can edit
    // body fields (name, description, skillText) — slug stays immutable on
    // locked rows so the seed-by-slug invariant the rest of the system
    // depends on is preserved.
    const patch: Record<string, unknown> = {};
    if (data.name !== undefined) patch.name = data.name.trim();
    if (data.slug !== undefined && !skill.locked) {
      patch.slug = data.slug?.trim() || null;
    }
    if (data.description !== undefined) patch.description = data.description?.trim() || null;
    if (data.skillText !== undefined) patch.skillText = data.skillText;
    try {
      await skill.update(patch);
    } catch (err: any) {
      if (err.name === "SequelizeUniqueConstraintError") {
        throw Object.assign(new Error("That slug is already in use."), { status: 409 });
      }
      throw err;
    }
    broadcast("skill_updated", `Skill "${skill.name}" updated`);
    return skill;
  }

  async deleteSkill(id: number) {
    const skill = await Skill.findByPk(id);
    if (!skill) throw Object.assign(new Error("Skill not found."), { status: 404 });
    if (skill.locked) {
      throw Object.assign(
        new Error("This skill is locked and cannot be deleted."),
        { status: 403 },
      );
    }
    const name = skill.name;
    await skill.destroy();
    broadcast("skill_deleted", `Skill "${name}" deleted`);
    return { deleted: true };
  }

  // ── Models + vendors ───────────────────────────────────────────────────

  async listModels() {
    const models = await LLMModel.findAll({
      attributes: ["id", "vendorId", "name", "slug"],
      order: [["name", "ASC"]],
    });
    const vendors = await Vendor.findAll({ attributes: ["id", "name", "slug"] });
    const vendorMap = Object.fromEntries(
      vendors.map((v) => [v.id, { id: v.id, name: v.name, slug: v.slug }]),
    );
    return models.map((m) => ({
      id: m.id,
      name: m.name,
      slug: m.slug,
      vendor: vendorMap[m.vendorId] ?? null,
    }));
  }

  async listVendors() {
    // Platform catalog only knows *which* vendors exist — API keys now live
    // per-organization in `organization_vendor_api_keys` and are managed by
    // each org's super-admin, not the platform. Callers that need to know
    // whether a given org has configured a key should hit the tenant-facing
    // admin API at /admin/vendor-api-keys.
    const vendors = await Vendor.findAll({
      attributes: ["id", "name", "slug"],
      order: [["name", "ASC"]],
    });
    return vendors.map((v) => ({
      id: v.id,
      name: v.name,
      slug: v.slug,
    }));
  }

  async createModel(input: { vendorId: string; name: string; slug: string }) {
    if (!input.vendorId || !input.name || !input.slug) {
      throw Object.assign(new Error("vendorId, name, and slug are required."), { status: 400 });
    }
    const vendor = await Vendor.findByPk(input.vendorId);
    if (!vendor) throw Object.assign(new Error("Vendor not found."), { status: 404 });
    if (vendor.slug === "google") {
      // Google (Gemini) models are discovered dynamically through the
      // Google client; adding one manually would shadow that catalog.
      throw Object.assign(
        new Error("Google (Gemini) models cannot be added manually."),
        { status: 400 },
      );
    }
    const existingSlug = await LLMModel.findOne({ where: { slug: input.slug } });
    if (existingSlug) {
      throw Object.assign(
        new Error(`A model with slug "${input.slug}" already exists.`),
        { status: 409 },
      );
    }
    const existingName = await LLMModel.findOne({
      where: { vendorId: input.vendorId, name: input.name },
    });
    if (existingName) {
      throw Object.assign(
        new Error(`A model named "${input.name}" already exists for ${vendor.name}.`),
        { status: 409 },
      );
    }
    const model = await LLMModel.create({
      vendorId: input.vendorId,
      name: input.name,
      slug: input.slug,
    });
    const result = {
      id: model.id,
      name: model.name,
      slug: model.slug,
      vendor: { id: vendor.id, name: vendor.name, slug: vendor.slug },
    };
    broadcast("model_created", `Model "${input.name}" added`, { model: result });
    return result;
  }

  async deleteModel(modelId: string) {
    const model = await LLMModel.findByPk(modelId);
    if (!model) throw Object.assign(new Error("Model not found."), { status: 404 });
    const agentCount = await Agent.count({ where: { modelId } });
    if (agentCount > 0) {
      throw Object.assign(
        new Error(
          `Cannot delete — this model is in use by ${agentCount} agent(s). Switch them to a different model first.`,
        ),
        { status: 409 },
      );
    }
    const sysAgentCount = await Agent.count({
      where: { modelSlug: model.slug, type: "system" },
    });
    if (sysAgentCount > 0) {
      throw Object.assign(
        new Error(`Cannot delete — this model is in use by ${sysAgentCount} system agent(s).`),
        { status: 409 },
      );
    }
    const modelName = model.name;
    await model.destroy();
    broadcast("model_deleted", `Model "${modelName}" deleted`, { modelId });
    return { deleted: true };
  }

}
