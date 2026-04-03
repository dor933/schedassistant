import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { sequelize, Skill, AgentSkill, SystemAgentSkill } from "@scheduling-agent/database";
import { z } from "zod";

const addSkillSchema = z.object({
  name: z.string().min(1).describe("Short display name for the skill"),
  skill_text: z
    .string()
    .min(1)
    .describe("Full skill instructions or procedural content the agent should follow when this skill applies"),
  slug: z
    .string()
    .min(1)
    .optional()
    .describe("Optional unique slug for lookup (letters, numbers, dashes)"),
  description: z
    .string()
    .optional()
    .describe("Optional one-line summary shown in skill lists (not the full skill body)"),
});

const getSkillSchema = z.object({
  skill_id: z.number().int().positive().describe("The numeric id of the skill (from list_agent_skills)"),
});

export function AddAgentSkillTool(agentId: string) {
  return tool(
    async (input) => {
      const parsed = addSkillSchema.parse(input);
      try {
        const result = await sequelize.transaction(async (transaction) => {
          if (parsed.slug) {
            const taken = await Skill.findOne({
              where: { slug: parsed.slug },
              attributes: ["id"],
              transaction,
            });
            if (taken) {
              return { error: `Slug "${parsed.slug}" is already in use. Choose another or omit slug.` };
            }
          }
          const skill = await Skill.create(
            {
              name: parsed.name,
              slug: parsed.slug ?? null,
              description: parsed.description?.trim() || null,
              skillText: parsed.skill_text,
            },
            { transaction },
          );
          await AgentSkill.create(
            { agentId, skillId: skill.id },
            { transaction },
          );
          return { skillId: skill.id };
        });
        if ("error" in result && result.error) return result.error;
        return `Skill added and linked to this agent. skill_id=${(result as { skillId: number }).skillId}.`;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `Error: ${msg}`;
      }
    },
    {
      name: "add_agent_skill",
      description:
        "Creates a new reusable skill (stored instructions/procedures) and attaches it to this agent. " +
        "Use list_agent_skills to see ids; use get_agent_skill to read the full text later.",
      schema: addSkillSchema,
    },
  );
}

export function ListAgentSkillsTool(agentId: string) {
  return tool(
    async () => {
      const rows = await AgentSkill.findAll({
        where: { agentId },
        include: [{ model: Skill, as: "skill", attributes: ["id", "name", "slug", "description"] }],
        order: [["createdAt", "DESC"]],
      });
      const list = rows.map((r) => {
        const s = r.get("skill") as Skill | null;
        if (!s) return null;
        return {
          id: s.id,
          name: s.name,
          slug: s.slug,
          description: s.description,
        };
      }).filter(Boolean);
      if (list.length === 0) {
        return "No skills are linked to this agent yet. Use add_agent_skill to create one.";
      }
      return JSON.stringify(list, null, 2);
    },
    {
      name: "list_agent_skills",
      description:
        "Lists skills available to this agent (id, name, slug, description). Does not include the full skill body — use get_agent_skill for that.",
      schema: z.object({}),
    },
  );
}

export function GetAgentSkillTool(agentId: string) {
  return tool(
    async (input) => {
      const { skill_id } = getSkillSchema.parse(input);
      const row = await AgentSkill.findOne({
        where: { agentId, skillId: skill_id },
        include: [{ model: Skill, as: "skill", attributes: ["id", "name", "slug", "description", "skillText"] }],
      });
      if (!row) {
        return `No skill with id ${skill_id} is linked to this agent. Use list_agent_skills to see valid ids.`;
      }
      const s = row.get("skill") as Skill | null;
      if (!s) return "Skill record missing.";
      return [
        `id: ${s.id}`,
        `name: ${s.name}`,
        s.slug ? `slug: ${s.slug}` : null,
        s.description ? `description: ${s.description}` : null,
        "",
        "## skill_text",
        s.skillText,
      ]
        .filter((line) => line != null)
        .join("\n");
    },
    {
      name: "get_agent_skill",
      description:
        "Loads the full skill text for a skill id that belongs to this agent. Use list_agent_skills first to obtain ids.",
      schema: getSkillSchema,
    },
  );
}

const systemGetSkillSchema = z.object({
  skill_id: z.number().int().positive().describe("The numeric id of the skill (from list_system_agent_skills)"),
});

export function AddSystemAgentSkillTool(systemAgentId: number) {
  return tool(
    async (input) => {
      const parsed = addSkillSchema.parse(input);
      try {
        const result = await sequelize.transaction(async (transaction) => {
          if (parsed.slug) {
            const taken = await Skill.findOne({
              where: { slug: parsed.slug },
              attributes: ["id"],
              transaction,
            });
            if (taken) {
              return { error: `Slug "${parsed.slug}" is already in use. Choose another or omit slug.` };
            }
          }
          const skill = await Skill.create(
            {
              name: parsed.name,
              slug: parsed.slug ?? null,
              description: parsed.description?.trim() || null,
              skillText: parsed.skill_text,
            },
            { transaction },
          );
          await SystemAgentSkill.create(
            { systemAgentId, skillId: skill.id },
            { transaction },
          );
          return { skillId: skill.id };
        });
        if ("error" in result && result.error) return result.error;
        return `Skill added and linked to this system agent. skill_id=${(result as { skillId: number }).skillId}.`;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `Error: ${msg}`;
      }
    },
    {
      name: "add_system_agent_skill",
      description:
        "Creates a new skill and attaches it to this system (deep) agent. Use list_system_agent_skills / get_system_agent_skill to read skills later.",
      schema: addSkillSchema,
    },
  );
}

export function ListSystemAgentSkillsTool(systemAgentId: number) {
  return tool(
    async () => {
      const rows = await SystemAgentSkill.findAll({
        where: { systemAgentId },
        include: [{ model: Skill, as: "skill", attributes: ["id", "name", "slug", "description"] }],
        order: [["createdAt", "DESC"]],
      });
      const list = rows.map((r) => {
        const s = r.get("skill") as Skill | null;
        if (!s) return null;
        return {
          id: s.id,
          name: s.name,
          slug: s.slug,
          description: s.description,
        };
      }).filter(Boolean);
      if (list.length === 0) {
        return "No skills are linked to this system agent yet. Use add_system_agent_skill to create one.";
      }
      return JSON.stringify(list, null, 2);
    },
    {
      name: "list_system_agent_skills",
      description:
        "Lists skills for this system agent (metadata only). Use get_system_agent_skill for full skill text.",
      schema: z.object({}),
    },
  );
}

export function GetSystemAgentSkillTool(systemAgentId: number) {
  return tool(
    async (input) => {
      const { skill_id } = systemGetSkillSchema.parse(input);
      const row = await SystemAgentSkill.findOne({
        where: { systemAgentId, skillId: skill_id },
        include: [{ model: Skill, as: "skill", attributes: ["id", "name", "slug", "description", "skillText"] }],
      });
      if (!row) {
        return `No skill with id ${skill_id} is linked to this system agent. Use list_system_agent_skills.`;
      }
      const s = row.get("skill") as Skill | null;
      if (!s) return "Skill record missing.";
      return [
        `id: ${s.id}`,
        `name: ${s.name}`,
        s.slug ? `slug: ${s.slug}` : null,
        s.description ? `description: ${s.description}` : null,
        "",
        "## skill_text",
        s.skillText,
      ]
        .filter((line) => line != null)
        .join("\n");
    },
    {
      name: "get_system_agent_skill",
      description:
        "Loads the full skill body for a skill id linked to this system agent.",
      schema: systemGetSkillSchema,
    },
  );
}

/** Tools bound to a chat agent (UUID). */
export function agentSkillTools(agentId: string): StructuredToolInterface[] {
  return [
    AddAgentSkillTool(agentId),
    ListAgentSkillsTool(agentId),
    GetAgentSkillTool(agentId),
  ];
}

/** Tools bound to a system agent (deep agent) id. */
export function systemAgentSkillTools(systemAgentId: number): StructuredToolInterface[] {
  return [
    AddSystemAgentSkillTool(systemAgentId),
    ListSystemAgentSkillsTool(systemAgentId),
    GetSystemAgentSkillTool(systemAgentId),
  ];
}
