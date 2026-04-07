import { Skill, AgentSkill, SystemAgentSkill } from "@scheduling-agent/database";
import { getIO } from "../../sockets/server/socketServer";
import { logger } from "../../logger";
import type { UserId } from "@scheduling-agent/types";

export class SkillsService {
  async getAll() {
    const rows = await Skill.findAll({
      attributes: ["id", "name", "slug", "description", "skillText", "systemAgentAssignable", "primaryAgentAssignable", "createdAt", "updatedAt"],
      order: [["name", "ASC"]],
    });
    return rows.map((r) => r.toJSON());
  }

  async create(
    data: {
      name: string;
      slug?: string | null;
      description?: string | null;
      skillText: string;
      primaryAgentAssignable?: boolean;
      systemAgentAssignable?: boolean;
    },
    actorId?: UserId,
  ) {
    const primary = data.primaryAgentAssignable ?? true;
    const system = data.systemAgentAssignable ?? true;
    if (!primary && !system) {
      throw Object.assign(new Error("At least one of primaryAgentAssignable or systemAgentAssignable must be true."), { status: 400 });
    }
    const skill = await Skill.create({
      name: data.name.trim(),
      slug: data.slug?.trim() || null,
      description: data.description?.trim() || null,
      skillText: data.skillText,
      primaryAgentAssignable: primary,
      systemAgentAssignable: system,
    });
    this.broadcast("skill_created", `Skill "${skill.name}" created`, actorId);
    return skill;
  }

  async update(
    id: number,
    data: {
      name?: string;
      slug?: string | null;
      description?: string | null;
      skillText?: string;
      primaryAgentAssignable?: boolean;
      systemAgentAssignable?: boolean;
    },
    actorId?: UserId,
  ) {
    const skill = await Skill.findByPk(id);
    if (!skill) throw Object.assign(new Error("Skill not found."), { status: 404 });

    const patch: Record<string, unknown> = {};
    if (data.name !== undefined) patch.name = data.name.trim();
    if (data.slug !== undefined) patch.slug = data.slug?.trim() || null;
    if (data.description !== undefined) patch.description = data.description?.trim() || null;
    if (data.skillText !== undefined) patch.skillText = data.skillText;
    if (data.primaryAgentAssignable !== undefined) patch.primaryAgentAssignable = data.primaryAgentAssignable;
    if (data.systemAgentAssignable !== undefined) patch.systemAgentAssignable = data.systemAgentAssignable;

    const finalPrimary = (patch.primaryAgentAssignable as boolean | undefined) ?? skill.primaryAgentAssignable;
    const finalSystem = (patch.systemAgentAssignable as boolean | undefined) ?? skill.systemAgentAssignable;
    if (!finalPrimary && !finalSystem) {
      throw Object.assign(new Error("At least one of primaryAgentAssignable or systemAgentAssignable must be true."), { status: 400 });
    }

    await skill.update(patch);

    // Cascade-delete junction rows when assignability flips to false
    if (data.primaryAgentAssignable === false && skill.primaryAgentAssignable === false) {
      const deleted = await AgentSkill.destroy({ where: { skillId: id } });
      if (deleted > 0) {
        logger.info(`Unlinked skill ${id} ("${skill.name}") from ${deleted} primary agent(s) — primaryAgentAssignable set to false`);
      }
    }
    if (data.systemAgentAssignable === false && skill.systemAgentAssignable === false) {
      const deleted = await SystemAgentSkill.destroy({ where: { skillId: id } });
      if (deleted > 0) {
        logger.info(`Unlinked skill ${id} ("${skill.name}") from ${deleted} system agent(s) — systemAgentAssignable set to false`);
      }
    }

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
