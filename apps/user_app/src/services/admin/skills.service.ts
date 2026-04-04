import { Skill } from "@scheduling-agent/database";
import { getIO } from "../../sockets/server/socketServer";
import { logger } from "../../logger";
import type { UserId } from "@scheduling-agent/types";

export class SkillsService {
  async getAll() {
    const rows = await Skill.findAll({
      attributes: ["id", "name", "slug", "description", "skillText", "systemAgentAssignable", "createdAt", "updatedAt"],
      order: [["name", "ASC"]],
    });
    return rows.map((r) => r.toJSON());
  }

  async create(
    data: { name: string; slug?: string | null; description?: string | null; skillText: string },
    actorId?: UserId,
  ) {
    const skill = await Skill.create({
      name: data.name.trim(),
      slug: data.slug?.trim() || null,
      description: data.description?.trim() || null,
      skillText: data.skillText,
    });
    this.broadcast("skill_created", `Skill "${skill.name}" created`, actorId);
    return skill;
  }

  async update(
    id: number,
    data: { name?: string; slug?: string | null; description?: string | null; skillText?: string },
    actorId?: UserId,
  ) {
    const skill = await Skill.findByPk(id);
    if (!skill) throw Object.assign(new Error("Skill not found."), { status: 404 });

    const patch: Record<string, unknown> = {};
    if (data.name !== undefined) patch.name = data.name.trim();
    if (data.slug !== undefined) patch.slug = data.slug?.trim() || null;
    if (data.description !== undefined) patch.description = data.description?.trim() || null;
    if (data.skillText !== undefined) patch.skillText = data.skillText;
    await skill.update(patch);
    this.broadcast("skill_updated", `Skill "${skill.name}" updated`, actorId);
    return skill;
  }

  async remove(id: number, actorId?: UserId) {
    const skill = await Skill.findByPk(id);
    if (!skill) throw Object.assign(new Error("Skill not found."), { status: 404 });
    const name = skill.name;
    await skill.destroy();
    this.broadcast("skill_deleted", `Skill "${name}" deleted`, actorId);
    logger.info("Skill deleted", { id });
  }

  private broadcast(type: string, message: string, actorId?: UserId) {
    try {
      getIO().emit("admin:change", { type, message, actorId });
    } catch (err) {
      logger.error("broadcastAdminChange (skills)", { error: String(err) });
    }
  }
}
