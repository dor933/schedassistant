import type { Transaction } from "sequelize";
import {
  Agent,
  AgentAvailableMcpServer,
  AgentAvailableSkill,
  LLMModel,
  McpServer,
  Skill,
} from "@scheduling-agent/database";
import { type UserId, type WebSearchChoice } from "@scheduling-agent/types";
import { logger } from "../../logger";

/**
 * Every organization needs its OWN epic orchestrator + web-search agents.
 * Sharing them globally would cause memory/workspace bleed across tenants
 * (agent_id keys episodic memory, agent notes, workspace folders, and
 * deep-agent memory checkpoints — all of which must stay per-tenant).
 *
 * This seeder creates one fresh instance of each per org:
 *   - Epic Orchestrator (type=primary) — with its skills + MCP servers
 *   - Web Search Gemini (type=system)  — googleSearch tool_config
 *   - Web Search Brave  (type=system)  — brave-search MCP
 *
 * All rows are inserted inside the caller's transaction. Workspace folder
 * creation (filesystem side-effect) is the caller's responsibility — it
 * should run after the transaction commits.
 */

const EPIC_ORCHESTRATOR_DEFINITION = "Epic Task Orchestrator";
const EPIC_ORCHESTRATOR_AGENT_NAME = "Epic Orchestrator";
const EPIC_ORCHESTRATOR_CORE_INSTRUCTIONS =
  "You are the Epic Task Orchestrator — a specialized Project Manager agent. " +
  "Your job is to plan and execute multi-step coding tasks (epics) across locally cloned repositories. " +
  "Always load your Epic Task Workflow skill before starting work. " +
  "Follow the skill procedure exactly: clarify scope, plan the epic, execute tasks one at a time via Claude CLI, " +
  "review git diffs after each execution, and report progress to the user.";

const EPIC_ORCHESTRATOR_SKILL_SLUGS = [
  "epic-task-workflow",
  "mcp-bash-build-test",
  "mcp-filesystem-repo",
  "gh-cli",
] as const;

const EPIC_ORCHESTRATOR_MCP_SERVER_NAMES = ["bash", "filesystem"] as const;

const WEB_SEARCH_GEMINI_SLUG = "web_search";
const WEB_SEARCH_GEMINI_AGENT_NAME = "Web Search Agent";
const WEB_SEARCH_GEMINI_DESCRIPTION =
  "Searches the web using Google Search to find up-to-date information, articles, documentation, and answers to questions.";
const WEB_SEARCH_GEMINI_INSTRUCTIONS =
  "You are THE dedicated web-search system agent for this organization. " +
  "All web searches from other agents are routed directly to you. " +
  "Use the built-in Google Search tool (googleSearch toolConfig) to find " +
  "accurate, up-to-date information from the internet. Summarize clearly, " +
  "cite sources when possible, and return the most relevant findings.";
const WEB_SEARCH_GEMINI_MODEL_SLUG = "gemini-3.1-pro-preview";

const WEB_SEARCH_BRAVE_SLUG = "web_search_brave";
const WEB_SEARCH_BRAVE_AGENT_NAME = "Web Search Agent (Brave)";
const WEB_SEARCH_BRAVE_DESCRIPTION =
  "Searches the web using Brave Search (via MCP) to find up-to-date information, articles, documentation, and answers to questions.";
const WEB_SEARCH_BRAVE_INSTRUCTIONS =
  "You are THE dedicated web-search system agent for this organization. " +
  "All web searches from other agents are routed directly to you. " +
  "Use the `brave-search` MCP server's tools to run queries against " +
  "Brave Search and fetch pages, then summarize findings clearly, cite " +
  "sources when possible, and return the most relevant results.";
const WEB_SEARCH_BRAVE_MODEL_SLUG = "claude-sonnet-4-6";
const WEB_SEARCH_BRAVE_MCP_SERVER_NAME = "brave-search";

export interface SeedOrganizationAgentsInput {
  organizationId: string;
  actorId: UserId | null;
  webSearchChoice: WebSearchChoice;
  transaction: Transaction;
}

export interface SeedOrganizationAgentsResult {
  epicOrchestratorId: string;
  webSearchGeminiId: string;
  webSearchBraveId: string;
  /** The web-search agent id the org chose (already one of the above). */
  activeWebSearchAgentId: string;
}

/**
 * Seeds the three tenant-scoped standard agents for a newly created org.
 * Only creates row data; the caller is responsible for creating the epic
 * orchestrator's workspace directory on disk after the transaction commits.
 */
export async function seedOrganizationAgents(
  input: SeedOrganizationAgentsInput,
): Promise<SeedOrganizationAgentsResult> {
  const { organizationId, actorId, webSearchChoice, transaction } = input;

  const [geminiModel, braveModel] = await Promise.all([
    LLMModel.findOne({
      where: { slug: WEB_SEARCH_GEMINI_MODEL_SLUG },
      attributes: ["id"],
      transaction,
    }),
    LLMModel.findOne({
      where: { slug: WEB_SEARCH_BRAVE_MODEL_SLUG },
      attributes: ["id"],
      transaction,
    }),
  ]);

  // ── Epic Orchestrator (primary) ─────────────────────────────────────────
  const epic = await Agent.create(
    {
      type: "primary",
      definition: EPIC_ORCHESTRATOR_DEFINITION,
      agentName: EPIC_ORCHESTRATOR_AGENT_NAME,
      coreInstructions: EPIC_ORCHESTRATOR_CORE_INSTRUCTIONS,
      createdByUserId: actorId ?? null,
      organizationId,
    },
    { transaction },
  );

  await linkSkills(epic.id, [...EPIC_ORCHESTRATOR_SKILL_SLUGS], transaction);
  await linkMcpServers(epic.id, [...EPIC_ORCHESTRATOR_MCP_SERVER_NAMES], transaction);

  // ── Web Search Gemini (system) ──────────────────────────────────────────
  const gemini = await Agent.create(
    {
      type: "system",
      slug: WEB_SEARCH_GEMINI_SLUG,
      agentName: WEB_SEARCH_GEMINI_AGENT_NAME,
      description: WEB_SEARCH_GEMINI_DESCRIPTION,
      instructions: WEB_SEARCH_GEMINI_INSTRUCTIONS,
      modelSlug: WEB_SEARCH_GEMINI_MODEL_SLUG,
      modelId: geminiModel?.id ?? null,
      toolConfig: { googleSearch: true, locked: true },
      isLocked: true,
      organizationId,
    },
    { transaction },
  );

  // ── Web Search Brave (system) ───────────────────────────────────────────
  const brave = await Agent.create(
    {
      type: "system",
      slug: WEB_SEARCH_BRAVE_SLUG,
      agentName: WEB_SEARCH_BRAVE_AGENT_NAME,
      description: WEB_SEARCH_BRAVE_DESCRIPTION,
      instructions: WEB_SEARCH_BRAVE_INSTRUCTIONS,
      modelSlug: WEB_SEARCH_BRAVE_MODEL_SLUG,
      modelId: braveModel?.id ?? null,
      toolConfig: { locked: true },
      isLocked: true,
      organizationId,
    },
    { transaction },
  );

  await linkMcpServers(brave.id, [WEB_SEARCH_BRAVE_MCP_SERVER_NAME], transaction);

  const activeWebSearchAgentId =
    webSearchChoice === "brave" ? brave.id : gemini.id;

  logger.info("Seeded per-org standard agents", {
    organizationId,
    epicOrchestratorId: epic.id,
    webSearchGeminiId: gemini.id,
    webSearchBraveId: brave.id,
    activeWebSearchAgentId,
  });

  return {
    epicOrchestratorId: epic.id,
    webSearchGeminiId: gemini.id,
    webSearchBraveId: brave.id,
    activeWebSearchAgentId,
  };
}

async function linkSkills(
  agentId: string,
  skillSlugs: string[],
  transaction: Transaction,
): Promise<void> {
  if (skillSlugs.length === 0) return;
  const skills = await Skill.findAll({
    where: { slug: skillSlugs },
    attributes: ["id", "slug"],
    transaction,
  });
  if (skills.length === 0) return;
  await AgentAvailableSkill.bulkCreate(
    skills.map((s) => ({ agentId, skillId: s.id, active: true })),
    { transaction, ignoreDuplicates: true },
  );
}

async function linkMcpServers(
  agentId: string,
  serverNames: string[],
  transaction: Transaction,
): Promise<void> {
  if (serverNames.length === 0) return;
  const servers = await McpServer.findAll({
    where: { name: serverNames },
    attributes: ["id", "name"],
    transaction,
  });
  if (servers.length === 0) return;
  await AgentAvailableMcpServer.bulkCreate(
    servers.map((s) => ({ agentId, mcpServerId: s.id, active: true })),
    { transaction, ignoreDuplicates: true },
  );
}
