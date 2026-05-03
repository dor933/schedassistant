import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { sequelize, Skill, AgentAvailableSkill, Agent, LLMModel, Vendor } from "@scheduling-agent/database";
import { Op } from "sequelize";
import { z } from "zod";
import {
  CORE_AUTO_ASSIGNED_SKILL_SLUGS,
  FILESYSTEM_SKILL_SLUGS_SDK,
  FILESYSTEM_SKILL_SLUGS_MCP,
  filesystemSkillSlugsForVendor,
  bashSkillSlugForVendor,
  epicOrchestratorSkillSlugForVendor,
} from "@scheduling-agent/types";
import { hasFilesystemMcp } from "./hasFilesystemMcp";
import { loadActiveToolSlugs } from "./resolveAgentTools";
import { logger } from "../logger";

/**
 * Best-effort vendor + bash-flag lookup for an agent. Reads the
 * agent's modelId → llm_models row → vendorId → vendors row → slug,
 * and `allow_sdk_bash` from the agent row. Returns null fields when
 * the lookup fails so the caller can fall back to safe defaults.
 *
 * Not cached at module scope: the agent's model and flags can change
 * at runtime (admin UI), and a stale cache would point at the wrong
 * skill surface.
 */
async function resolveAgentVendorAndFlags(
  agentId: string,
): Promise<{ vendorSlug: string | null; allowSdkBash: boolean }> {
  try {
    const agent = await Agent.findByPk(agentId, {
      attributes: ["modelId", "allowSdkBash"],
    });
    if (!agent) return { vendorSlug: null, allowSdkBash: false };
    const allowSdkBash = agent.allowSdkBash !== false;
    if (!agent.modelId) return { vendorSlug: null, allowSdkBash };
    const model = await LLMModel.findByPk(agent.modelId, {
      attributes: ["vendorId"],
    });
    if (!model?.vendorId) return { vendorSlug: null, allowSdkBash };
    const vendor = await Vendor.findByPk(model.vendorId, {
      attributes: ["slug"],
    });
    return { vendorSlug: vendor?.slug ?? null, allowSdkBash };
  } catch (err) {
    logger.warn("Failed to resolve agent vendor/flags for skill auto-assignment", {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { vendorSlug: null, allowSdkBash: false };
  }
}

/**
 * Returns the auto-assigned skill slugs actually visible to this agent.
 * Always the core set; plus vendor- and flag-conditional surfaces:
 *   - Filesystem skill (workspace + library):
 *       - Anthropic agents → Surface A (SDK built-in file tools).
 *         Always injected — Anthropic agents always run through the
 *         Claude Agent SDK with built-ins enabled, so the SDK file
 *         tools are always present and the workspace skill is always
 *         relevant.
 *       - Non-Anthropic agents → Surface B (filesystem MCP) ONLY when
 *         the filesystem MCP server is attached.
 *   - Bash skill (vendor-split, gated by `allow_sdk_bash`):
 *       - When the agent's `allow_sdk_bash` is on, inject the
 *         vendor-matched bash skill (`-sdk` for Anthropic's `Bash`
 *         tool; `-codex` for Codex's native `shell`). Other shell-
 *         related skills (`gh-cli`, `mcp-bash-build-test`, etc.) are
 *         admin-attached, not auto-assigned — admins pick the right
 *         vendor variant per agent in the admin UI.
 *   - Epic-orchestrator skill (vendor-split, gated by `create_epic_plan`):
 *       - When the agent has the `create_epic_plan` tool granted (i.e.
 *         it's an epic orchestrator), inject the vendor-matched
 *         workflow skill: `epic-orchestrator-sdk` for Anthropic
 *         (sub-agent fan-out + `complete_epic_task` inside one sync
 *         turn) or `epic-orchestrator-codex` for Codex (detached run +
 *         server auto-finalize, no `complete_epic_task`). Tool grant
 *         is the source of truth — no separate `is_epic_orchestrator`
 *         flag.
 */
async function autoSlugsForAgent(agentId: string): Promise<string[]> {
  const slugs: string[] = [...CORE_AUTO_ASSIGNED_SKILL_SLUGS];
  const { vendorSlug, allowSdkBash } = await resolveAgentVendorAndFlags(agentId);

  if (vendorSlug === "anthropic") {
    slugs.push(...FILESYSTEM_SKILL_SLUGS_SDK);
  } else if (await hasFilesystemMcp(agentId)) {
    slugs.push(...FILESYSTEM_SKILL_SLUGS_MCP);
  }

  if (allowSdkBash) {
    slugs.push(bashSkillSlugForVendor(vendorSlug));
  }

  // Epic-orchestrator skill — vendor-split, gated by `create_epic_plan`
  // tool grant. `applyDefaults: false` so the default set (`consult_agent`,
  // `list_agents`, `list_system_agents`) doesn't accidentally make every
  // agent without explicit tool rows look like an epic orchestrator.
  try {
    const toolSlugs = await loadActiveToolSlugs(agentId, { applyDefaults: false });
    if (toolSlugs.has("create_epic_plan")) {
      slugs.push(epicOrchestratorSkillSlugForVendor(vendorSlug));
    }
  } catch (err) {
    logger.warn("Failed to resolve agent tool grants for epic-skill auto-assignment", {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return slugs;
}

// Re-export for callers that still want vendor-pinned slug lists.
export { filesystemSkillSlugsForVendor, bashSkillSlugForVendor };

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
  skill_id: z.number().int().min(1).describe("The numeric id of the skill (from list_agent_skills)"),
});

const editSkillBodySchema = z
  .object({
    skill_id: z.number().int().min(1).describe("The numeric id of the skill to update"),
    name: z.string().min(1).optional().describe("New display name"),
    slug: z
      .string()
      .optional()
      .describe('New unique slug, or empty string "" to clear; omit to leave unchanged'),
    description: z
      .string()
      .optional()
      .describe('New one-line summary, or empty string "" to clear; omit to leave unchanged'),
    skill_text: z
      .string()
      .min(1)
      .optional()
      .describe("Replace the full skill instructions body"),
  })
  .refine(
    (d) =>
      d.name !== undefined ||
      d.slug !== undefined ||
      d.description !== undefined ||
      d.skill_text !== undefined,
    { message: "Provide at least one of: name, slug, description, skill_text" },
  );

async function applySkillUpdates(skill: Skill, parsed: z.infer<typeof editSkillBodySchema>): Promise<string | null> {
  if (parsed.slug !== undefined) {
    const trimmed = parsed.slug.trim();
    const newSlug = trimmed.length === 0 ? null : trimmed;
    if (newSlug) {
      const taken = await Skill.findOne({
        where: { slug: newSlug, id: { [Op.ne]: skill.id } },
        attributes: ["id"],
      });
      if (taken) {
        return `Slug "${newSlug}" is already in use by another skill.`;
      }
    }
    skill.slug = newSlug;
  }
  if (parsed.name !== undefined) {
    skill.name = parsed.name;
  }
  if (parsed.description !== undefined) {
    const t = parsed.description.trim();
    skill.description = t.length === 0 ? null : t;
  }
  if (parsed.skill_text !== undefined) {
    skill.skillText = parsed.skill_text;
  }
  await skill.save();
  return null;
}

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
          await AgentAvailableSkill.create(
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
      const autoSlugs = await autoSlugsForAgent(agentId);
      const [rows, autoSkills] = await Promise.all([
        AgentAvailableSkill.findAll({
          where: { agentId, active: true },
          include: [
            {
              model: Skill,
              as: "skill",
              attributes: ["id", "name", "slug", "description"],
            },
          ],
          order: [["createdAt", "DESC"]],
        }),
        autoSlugs.length === 0
          ? Promise.resolve([])
          : Skill.findAll({
              where: { slug: { [Op.in]: autoSlugs } },
              attributes: ["id", "name", "slug", "description"],
              order: [["name", "ASC"]],
            }),
      ]);

      const byId = new Map<number, { id: number; name: string; slug: string | null; description: string | null }>();
      for (const r of rows) {
        const s = r.get("skill") as Skill | null;
        if (!s) continue;
        byId.set(s.id, {
          id: s.id,
          name: s.name,
          slug: s.slug,
          description: s.description,
        });
      }
      for (const s of autoSkills) {
        byId.set(s.id, {
          id: s.id,
          name: s.name,
          slug: s.slug,
          description: s.description,
        });
      }
      const list = [...byId.values()];
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
      const row = await AgentAvailableSkill.findOne({
        where: { agentId, skillId: skill_id },
        include: [{ model: Skill, as: "skill", attributes: ["id", "name", "slug", "description", "skillText"] }],
      });
      let s: Skill | null = row ? ((row.get("skill") as Skill | null) ?? null) : null;
      if (!s) {
        // Auto-assigned skills are accessible to every agent regardless of
        // linking. Filesystem-MCP skills are only accessible when the agent
        // actually has the filesystem MCP attached.
        const autoSlugs = await autoSlugsForAgent(agentId);
        if (autoSlugs.length > 0) {
          const autoSkill = await Skill.findOne({
            where: {
              id: skill_id,
              slug: { [Op.in]: autoSlugs },
            },
            attributes: ["id", "name", "slug", "description", "skillText"],
          });
          s = autoSkill;
        }
      }
      if (!s) {
        return `No skill with id ${skill_id} is linked to this agent. Use list_agent_skills to see valid ids.`;
      }
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

export function EditAgentSkillTool(agentId: string) {
  return tool(
    async (input) => {
      const parsed = editSkillBodySchema.parse(input);
      try {
        const row = await AgentAvailableSkill.findOne({
          where: { agentId, skillId: parsed.skill_id },
          include: [{ model: Skill, as: "skill" }],
        });
        if (!row) {
          return `No skill with id ${parsed.skill_id} is linked to this agent. Use list_agent_skills for valid ids.`;
        }
        const s = row.get("skill") as Skill | null;
        if (!s) return "Skill record missing.";
        const err = await applySkillUpdates(s, parsed);
        if (err) return err;
        return `Updated skill id=${parsed.skill_id}. Use get_agent_skill to read the latest text.`;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `Error: ${msg}`;
      }
    },
    {
      name: "edit_agent_skill",
      description:
        "Updates metadata and/or the full body of a skill linked to this agent. " +
        "At least one of name, slug, description, skill_text must be provided. " +
        "Use list_agent_skills / get_agent_skill first. " +
        "Warning: skills are shared rows — if the same skill is linked to other agents, they all see the update.",
      schema: editSkillBodySchema,
    },
  );
}

/** Tools bound to any agent (primary or system) by UUID. */
export function agentSkillTools(agentId: string): StructuredToolInterface[] {
  return [
    AddAgentSkillTool(agentId),
    EditAgentSkillTool(agentId),
    ListAgentSkillsTool(agentId),
    GetAgentSkillTool(agentId),
  ];
}

/** Read-only skill tools for system agents (deep agents). Same table, same UUID key. */
export function systemAgentSkillTools(agentId: string): StructuredToolInterface[] {
  return [
    ListAgentSkillsTool(agentId),
    GetAgentSkillTool(agentId),
  ];
}
