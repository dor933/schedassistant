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
 *   - Web Search Tavily (type=system)  — tavily_search (native LangChain tool)
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

const WEB_SEARCH_TAVILY_SLUG = "web_search_tavily";
const WEB_SEARCH_TAVILY_AGENT_NAME = "Web Search Agent (Tavily)";
const WEB_SEARCH_TAVILY_DESCRIPTION =
  "Searches the web using Tavily to find up-to-date information, articles, documentation, and answers to questions.";
const WEB_SEARCH_TAVILY_INSTRUCTIONS =
  "You are THE dedicated web-search system agent for this organization. " +
  "All web searches from other agents are routed directly to you. " +
  "Use the `tavily_search` tool to run queries against Tavily and fetch " +
  "results, then summarize findings clearly, cite sources when possible, " +
  "and return the most relevant results.";
const WEB_SEARCH_TAVILY_MODEL_SLUG = "claude-sonnet-4-6";

// ── Google Workspace Agent ──────────────────────────────────────────────
// The organization's single dedicated specialist for Google's SaaS suite —
// Gmail, Google Calendar, Google Drive. Every primary agent delegates those
// ops to this agent; the google_* tools are ONLY bound to this agent's tool
// list (gated via toolConfig.useGoogleWorkspaceTools in the deep agent
// worker). Permissions still inherit from the caller via
// `authorityAgentId = callerAgentId` — so the calling primary's
// AgentUserScope grants are what actually authorize the operation, not
// grants attached to this system agent.
//
// NOTE: this is DISTINCT from each agent's personal "workspace folder" (the
// .md/.txt scratch area managed by workspace_* tools). Don't conflate them.
const GOOGLE_WORKSPACE_AGENT_SLUG = "google_workspace_agent";
const GOOGLE_WORKSPACE_AGENT_NAME = "Google Workspace Agent";
const GOOGLE_WORKSPACE_AGENT_DESCRIPTION =
  "Performs Google Workspace operations on behalf of primary agents — Gmail (list/send), Google Calendar (list/create events), and Google Drive (list/read/write files). Inherits permissions from the calling agent.";
const GOOGLE_WORKSPACE_AGENT_INSTRUCTIONS =
  "You are THE dedicated Google Workspace system agent for this organization. " +
  "All Gmail, Google Calendar, and Google Drive operations from other agents are routed directly to you.\n\n" +
  "You have access to these tools:\n" +
  "- `google_list_calendar_events`, `google_create_calendar_event` (Calendar)\n" +
  "- `google_list_drive_files`, `google_read_drive_file`, `google_write_drive_file` (Drive)\n" +
  "- `google_list_gmail_messages`, `google_send_gmail` (Gmail)\n\n" +
  "Each tool takes a `subjectEmail` — the workspace email of the user whose data " +
  "you are acting on. The delegating agent always hands off the target user's EMAIL " +
  "ADDRESS plus the operation to perform; your job is to translate that into the " +
  "correct tool call. Never ask for or invent an internal user id — always use the " +
  "email the caller gave you.\n\n" +
  "If a tool returns an authorization error, report it clearly to the caller — do NOT " +
  "retry with a different email. Permissions are gated per (calling agent, subject " +
  "user, scope); the authorization check runs against the calling agent, not you, so " +
  "you inherit its grants.\n\n" +
  "Be precise: return the data you fetched or the ID of the resource you created/sent, " +
  "and keep responses structured so the calling agent can use them directly.";
const GOOGLE_WORKSPACE_AGENT_MODEL_SLUG = "claude-sonnet-4-6";

export interface SeedOrganizationAgentsInput {
  organizationId: string;
  actorId: UserId | null;
  webSearchChoice: WebSearchChoice;
  transaction: Transaction;
}

export interface SeedOrganizationAgentsResult {
  epicOrchestratorId: string;
  webSearchGeminiId: string;
  webSearchTavilyId: string;
  /** The web-search agent id the org chose (already one of the above). */
  activeWebSearchAgentId: string;
  googleWorkspaceAgentId: string;
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

  const [geminiModel, tavilyModel, googleWorkspaceModel] = await Promise.all([
    LLMModel.findOne({
      where: { slug: WEB_SEARCH_GEMINI_MODEL_SLUG },
      attributes: ["id"],
      transaction,
    }),
    LLMModel.findOne({
      where: { slug: WEB_SEARCH_TAVILY_MODEL_SLUG },
      attributes: ["id"],
      transaction,
    }),
    LLMModel.findOne({
      where: { slug: GOOGLE_WORKSPACE_AGENT_MODEL_SLUG },
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

  // ── Web Search Tavily (system) ──────────────────────────────────────────
  // Tavily is a native LangChain tool injected at runtime by the deep agent
  // worker when it sees `toolConfig.useTavily` — NOT an MCP server. That is
  // why there's no linkMcpServers call here.
  const tavily = await Agent.create(
    {
      type: "system",
      slug: WEB_SEARCH_TAVILY_SLUG,
      agentName: WEB_SEARCH_TAVILY_AGENT_NAME,
      description: WEB_SEARCH_TAVILY_DESCRIPTION,
      instructions: WEB_SEARCH_TAVILY_INSTRUCTIONS,
      modelSlug: WEB_SEARCH_TAVILY_MODEL_SLUG,
      modelId: tavilyModel?.id ?? null,
      toolConfig: { useTavily: true },
      isLocked: false,
      organizationId,
    },
    { transaction },
  );

  const activeWebSearchAgentId =
    webSearchChoice === "tavily" ? tavily.id : gemini.id;

  // ── Google Workspace Agent (system) ─────────────────────────────────────
  // The google_* tools are bound ONLY to this agent at runtime (see
  // deepAgent.worker.ts). Primary agents delegate Gmail / Calendar / Drive
  // ops to it via delegate_to_deep_agent; the permission check still runs
  // against the caller's agent id, not this one. Note: unrelated to each
  // agent's own workspace FOLDER (managed by workspace_* tools).
  const googleWorkspace = await Agent.create(
    {
      type: "system",
      slug: GOOGLE_WORKSPACE_AGENT_SLUG,
      agentName: GOOGLE_WORKSPACE_AGENT_NAME,
      description: GOOGLE_WORKSPACE_AGENT_DESCRIPTION,
      instructions: GOOGLE_WORKSPACE_AGENT_INSTRUCTIONS,
      modelSlug: GOOGLE_WORKSPACE_AGENT_MODEL_SLUG,
      modelId: googleWorkspaceModel?.id ?? null,
      toolConfig: { useGoogleWorkspaceTools: true },
      isLocked: false,
      organizationId,
    },
    { transaction },
  );

  logger.info("Seeded per-org standard agents", {
    organizationId,
    epicOrchestratorId: epic.id,
    webSearchGeminiId: gemini.id,
    webSearchTavilyId: tavily.id,
    activeWebSearchAgentId,
    googleWorkspaceAgentId: googleWorkspace.id,
  });

  return {
    epicOrchestratorId: epic.id,
    webSearchGeminiId: gemini.id,
    webSearchTavilyId: tavily.id,
    activeWebSearchAgentId,
    googleWorkspaceAgentId: googleWorkspace.id,
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
