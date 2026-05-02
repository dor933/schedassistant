/**
 * Translates the `claude_sub_agent` rows owned by a primary into Claude
 * Agent SDK sub-agent bundles, ready to be plugged into
 * `runAnthropicAgentSdk` via `opts.subAgents` (slice 17).
 *
 * Important: SYSTEM agents are deliberately excluded. They live behind
 * the `delegate_to_deep_agent` / `sync_delegate_to_deep_agent` tools,
 * which queue a separate executor-worker run; exposing them here would
 * let the model invoke a system agent inline (sub-agent style) and
 * bypass the worker/queue architecture entirely. `claude_sub_agent` is
 * the only row type that participates in the SDK's `agents:` map.
 *
 * Per the slice-17 design, each claude_sub_agent:
 *   - Is owned by exactly one Anthropic-vendor primary (NULL = available
 *     to attach but not in use). The visibility filter below requires
 *     `owning_primary_agent_id = primary.id` — never NULL, never any
 *     other primary's assignment.
 *   - Stays distinct from the primary in terms of tools, MCP servers,
 *     model, prompt, and per-(agentId, userId) permission grants.
 *   - Is exposed to the primary's model as one entry in `agents:` so it
 *     can call `Task("<sub-agent-slug>", "<task>")` to delegate.
 *
 * Tool list per sub-agent mirrors the per-agent slug allowlist convention
 * already used by the basic/epic graphs: `loadActiveToolSlugs(subAgentId)`
 * with the same `DEFAULT_TOOL_SLUGS` fallback when no rows exist.
 *
 * MCP servers per sub-agent are loaded fresh from `agent_available_mcp_servers`
 * for that sub-agent's id and translated into the SDK's stdio config
 * shape (`{ type: 'stdio', command, args, env }`).
 */

import { Op } from "sequelize";
import {
  Agent,
  AgentAvailableMcpServer,
  McpServer,
} from "@scheduling-agent/database";
import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";

import {
  createAgentToolsMcpServer,
  buildAllowedToolsForServer,
} from "../chat/anthropic/agentSdkAdapter";
import { ENABLED_BUILTIN_TOOLS } from "../chat/anthropic/agentSdkBuiltinHooks";
import type { SubAgentBundle } from "../chat/anthropic/agentSdkRunner";
import { logger } from "../logger";
import { loadActiveToolSlugs } from "../tools/resolveAgentTools";

// Tool factories — same imports the basic-graph callModel uses, but we'll
// construct each one with the sub-agent's id so per-agent grants apply.
import { ReadAgentNotesTool, AppendAgentNotesTool, EditAgentNotesTool } from "../tools/agentNotesTool";
import { SaveEpisodicMemoryTool, RecallEpisodicMemoryTool } from "../tools/episodicMemoryTool";
import { GetThreadSummaryTool } from "../tools/threadSummaryTool";
import { ReadSessionFileTool } from "../tools/readSessionFileTool";
import { GrepSessionFileTool } from "../tools/grepSessionFileTool";
import { ListCronJobsTool } from "../tools/listCronJobsTool";
import { ListGoogleWorkspaceGrantsTool } from "../tools/listGoogleWorkspaceGrantsTool";
import { agentSkillTools } from "../tools/skillsTools";
import { ConsultAgentTool } from "../tools/consultAgentTool";
import { ListAgentsTool } from "../tools/listAgentsTool";
import { ListSystemAgentsTool } from "../tools/listSystemAgentsTool";
import { ListProjectsTool, ListRepositoriesTool } from "../tools/epicTaskTools";
import { QueryDatabaseTool } from "../tools/queryDatabaseTool";
import { SendFileToUserTool } from "../tools/sendFileTool";
import { TavilySearchTool } from "../tools/tavilySearchTool";
import { googleTools } from "../tools/googleTools";

import type { StructuredToolInterface } from "@langchain/core/tools";

/**
 * Caller context for building the sub-agent map. The runner passes this
 * through from the calling LangGraph node so per-call identifiers (user,
 * thread, group/single chat) reach each sub-agent's tool factories — they
 * close over these to enforce per-(agentId, userId) grants the same way
 * the legacy primary-agent tool list does.
 */
export interface BuildSubAgentsContext {
  /** The primary calling out — used for the visibility filter. */
  primaryAgentId: string;
  userId: number;
  threadId: string;
  groupId: string | null;
  singleChatId: string | null;
}

/**
 * Translates the DB-stored MCP-server `env` JSONB (which may include
 * `{{VAR}}` placeholder strings) into a flat string→string map suitable for
 * the SDK's stdio config. Same substitution semantics as
 * `mcpClient/index.ts:buildMcpEnv` so behavior parity between the two
 * runtimes is preserved.
 */
function buildMcpEnv(envJson: Record<string, string> | null): Record<string, string> {
  const base = { ...process.env } as Record<string, string>;
  if (!envJson) return base;
  for (const [key, val] of Object.entries(envJson)) {
    const match = val.match(/^\{\{(\w+)\}\}$/);
    base[key] = match ? (process.env[match[1]] ?? "") : val;
  }
  return base;
}

/**
 * Constructs the LangChain tool factories for one system agent using its
 * own slug allowlist. Mirrors the `basicGraph/nodes/callModel.ts` tool-list
 * construction, but every factory is instantiated with the sub-agent's id
 * so per-agent permission checks (e.g. `agent_user_scopes` for Google
 * Workspace, `consult_agent` org filtering, etc.) hit the correct row.
 */
async function buildSubAgentTools(
  subAgent: Agent,
  ctx: BuildSubAgentsContext,
): Promise<StructuredToolInterface[]> {
  const subAgentId = subAgent.id;
  const activeSlugs = await loadActiveToolSlugs(subAgentId);
  const has = (slug: string) => activeSlugs.has(slug);

  // Core tools — every system agent gets these regardless of slug grants,
  // matching the convention used for primary agents in basicGraph/callModel.
  // They are safe, low-privilege building blocks (notes, memory, session
  // files, cron/grant introspection) the sub-agent's reasoning depends on.
  const tools: StructuredToolInterface[] = [
    ReadAgentNotesTool(subAgentId),
    AppendAgentNotesTool(subAgentId),
    EditAgentNotesTool(subAgentId),
    SaveEpisodicMemoryTool(subAgentId, ctx.userId, ctx.threadId),
    RecallEpisodicMemoryTool(subAgentId),
    GetThreadSummaryTool(subAgentId),
    ReadSessionFileTool(subAgentId, ctx.threadId),
    GrepSessionFileTool(subAgentId, ctx.threadId),
    ListCronJobsTool(subAgentId),
    ListGoogleWorkspaceGrantsTool(subAgentId),
    ...agentSkillTools(subAgentId),
  ];

  // Configurable tools — gated by the sub-agent's own `agent_available_tools`.
  if (has("consult_agent"))
    tools.push(ConsultAgentTool(subAgentId, ctx.userId, ctx.groupId, ctx.singleChatId));
  if (has("list_agents"))
    tools.push(ListAgentsTool(subAgentId));
  if (has("list_system_agents"))
    tools.push(ListSystemAgentsTool(subAgentId));
  if (has("list_projects"))
    tools.push(ListProjectsTool(ctx.userId));
  if (has("list_repositories"))
    tools.push(ListRepositoriesTool());
  if (has("query_database"))
    tools.push(QueryDatabaseTool());
  if (has("send_file_to_user"))
    tools.push(SendFileToUserTool(subAgentId));

  // ── Specialty system agents: tool_config-flag gated ──────────────────────
  //
  // Mirrors `deepAgent.worker.ts`'s wiring of these two specialist surfaces.
  // Both are bound by the `agents.tool_config` JSONB flag, NOT by the
  // `agent_available_tools` slug allowlist — that's the convention the
  // legacy worker uses and we preserve it so the same DB row works under
  // either runtime.
  const tc = (subAgent.toolConfig ?? {}) as Record<string, unknown>;
  const useTavily = tc.useTavily === true;
  const useGoogleWorkspaceTools = tc.useGoogleWorkspaceTools === true;

  // Tavily web search — org-wide credential, no per-user scope. Gating on
  // `tool_config.useTavily` matches `deepAgent.worker.ts:541`.
  //
  // `TavilySearchTool()` throws synchronously when `TAVILY_API_KEY` env var
  // is missing. We wrap in a try/catch and just log+skip so a misconfigured
  // search key doesn't tank the entire sub-agent (and by extension the
  // whole primary's `query()` call). The system agent will simply be missing
  // its search tool — model-visible, not a hard fail.
  if (useTavily) {
    try {
      tools.push(TavilySearchTool());
    } catch (err) {
      logger.warn("Skipping Tavily tool on sub-agent — TAVILY_API_KEY not configured", {
        subAgentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Google Workspace (Gmail / Calendar / Drive) — domain-wide-delegation via
  // service account. Permission check uses the CALLING primary's agent id
  // (`ctx.primaryAgentId`), NOT the sub-agent's id, because per-user grants
  // in `agent_user_scopes` live on the primary. The sub-agent is only the
  // execution vehicle. This matches `deepAgent.worker.ts:535` exactly:
  //   `googleTools(callerAgentId)` — the caller, not the executor.
  if (useGoogleWorkspaceTools) {
    tools.push(...googleTools(ctx.primaryAgentId));
  }

  // We deliberately do NOT include `delegate_to_deep_agent` /
  // `delegate_to_epic_orchestrator` / `invoke_application_agent` here —
  // sub-agents that need to fan out further can be addressed in a later
  // iteration once the basic Task delegation is stable. Today system agents
  // running via the deepagents worker also do not delegate downward.

  return tools;
}

/**
 * Loads each system agent's external MCP servers (filesystem, github, etc.)
 * and translates them into the SDK's stdio config shape. Returns a flat
 * map keyed by server name.
 */
async function buildExternalMcpServersForAgent(
  subAgentId: string,
): Promise<Record<string, unknown>> {
  const links = await AgentAvailableMcpServer.findAll({
    where: { agentId: subAgentId, active: true },
    attributes: ["mcpServerId"],
  });
  if (links.length === 0) return {};

  const serverIds = links.map((l) => l.mcpServerId);
  const servers = await McpServer.findAll({
    where: { id: { [Op.in]: serverIds } },
  });
  if (servers.length === 0) return {};

  const out: Record<string, unknown> = {};
  for (const server of servers) {
    out[server.name] = {
      type: "stdio" as const,
      command: server.command,
      args: server.args ?? [],
      env: buildMcpEnv(server.env),
    };
  }
  return out;
}

/**
 * Renders the prompt fed to a sub-agent's `query()` invocation. Combines
 * the same DB fields the primary's contextBuilder reads when assembling
 * its system prompt:
 *   - `agentName` for an opening "You are..." line
 *   - `definition` (short role label)
 *   - `description` (free-form)
 *   - `coreInstructions` (long-form behavioral instructions)
 *   - `instructions` (system-agent-specific extra instructions)
 *
 * Sub-agents do NOT receive the primary's role block, delegation gate, or
 * org/library/workspace sections — those are scoped to the primary by design.
 * If a system agent needs library access it has the filesystem MCP attached,
 * exactly as today via the deepagents worker.
 */
function buildSubAgentPrompt(agent: Agent): string {
  const lines: string[] = [];
  const name = agent.agentName?.trim();
  const def = agent.definition?.trim();
  if (name) {
    lines.push(`Your name is ${name}.`);
  }
  if (def) {
    lines.push(`You are a ${def}.`);
  }
  if (agent.description?.trim()) {
    lines.push("");
    lines.push(agent.description.trim());
  }
  if (agent.coreInstructions?.trim()) {
    lines.push("");
    lines.push("## Instructions");
    lines.push(agent.coreInstructions.trim());
  }
  if (agent.instructions?.trim() && agent.instructions !== agent.coreInstructions) {
    lines.push("");
    lines.push("## Additional instructions");
    lines.push(agent.instructions.trim());
  }
  return lines.join("\n");
}

/**
 * Maps the model slug stored on the system agent (or its FK lookup) to the
 * SDK's accepted `model` enum on `AgentDefinition`. The SDK accepts only
 * 'sonnet' | 'opus' | 'haiku' | 'inherit'. We resolve by string contains
 * since slugs vary across Anthropic's model versioning (claude-sonnet-4-5,
 * claude-opus-4-7, etc.). Anything we don't recognise falls back to
 * 'inherit' so the parent's model is used.
 */
function mapModelSlugToSdkAgentModel(
  modelSlug: string | null | undefined,
): AgentDefinition["model"] {
  if (!modelSlug) return "inherit";
  const lower = modelSlug.toLowerCase();
  if (lower.includes("opus")) return "opus";
  if (lower.includes("haiku")) return "haiku";
  if (lower.includes("sonnet")) return "sonnet";
  return "inherit";
}

/**
 * Main entry point. Returns the bundle list ready to drop into the runner
 * options under `subAgents`. Empty array when the primary has no visible
 * system agents (or when DB lookups fail — never throws).
 */
export async function buildSubAgentDefinitions(
  ctx: BuildSubAgentsContext,
): Promise<SubAgentBundle[]> {
  const primary = await Agent.findByPk(ctx.primaryAgentId, {
    attributes: ["organizationId"],
  });
  if (!primary?.organizationId) return [];

  // SDK `agents:` surface is `claude_sub_agent` rows ONLY (slice 17).
  //
  // System agents are a different concept entirely — they're delegated
  // to via `delegate_to_deep_agent` / `sync_delegate_to_deep_agent`,
  // which spawn a separate executor worker process. They are NEVER
  // exposed in the SDK's `agents:` map; mixing the two would let a
  // primary's model invoke a system agent inline (sub-agent style)
  // instead of through the queued deep-agent path the system was
  // designed for, breaking the worker/queue architecture.
  //
  // Filter:
  //   - claude_sub_agent owned by this exact primary. Unassigned (NULL
  //     owner) rows stay in the "available to attach" pool and are NOT
  //     exposed. Other primaries' assignments are NEVER exposed.
  const visibleSystemAgents = await Agent.findAll({
    where: {
      type: "claude_sub_agent",
      organizationId: primary.organizationId,
      owningPrimaryAgentId: ctx.primaryAgentId,
    },
    order: [["agentName", "ASC"]],
  });

  if (visibleSystemAgents.length === 0) return [];

  const bundles: SubAgentBundle[] = [];
  for (const sa of visibleSystemAgents) {
    // claude_sub_agent rows are admin-created and the `slug` column is
    // typically empty for them. Derive a deterministic slug from the
    // agent id so the SDK's `agents:` map has a stable key — the
    // model-visible identifier is the agentName/description so the
    // synthetic slug never appears in prose. Same
    // `csa_<uuid_with_underscores>` shape we use for the in-process
    // MCP server name below, keeping the two derived identifiers
    // visually paired in trace logs.
    const effectiveSlug =
      sa.slug ?? `csa_${sa.id.replace(/-/g, "_")}`;

    try {
      const tools = await buildSubAgentTools(sa, ctx);
      // One in-process MCP server per sub-agent, namespaced by id so
      // multiple sub-agents in the same query() never collide.
      const mcpServerName = `sys_${sa.id.replace(/-/g, "_")}`;
      const mcpServer = await createAgentToolsMcpServer(tools, undefined, mcpServerName);

      const externalMcpServers = await buildExternalMcpServersForAgent(sa.id);

      // Sub-agent's tool whitelist: every in-process tool by full SDK name,
      // each external MCP server by wildcard prefix, plus built-ins iff
      // the sub-agent has `allow_sdk_builtins = true`. Explicit list (no
      // inheritance) so a sub-agent never accidentally calls a parent's tool.
      const inProcessToolNames = buildAllowedToolsForServer(tools, mcpServerName);
      const externalToolPrefixes = Object.keys(externalMcpServers).map(
        (name) => `mcp__${name}__*`,
      );
      const subAgentBuiltins = sa.allowSdkBuiltins ? [...ENABLED_BUILTIN_TOOLS] : [];
      // Sub-agents have their own per-row `allow_sdk_bash` flag — distinct
      // from the parent's. A sub-agent only sees the SDK's native Bash when
      // its OWN row has the flag set, so a primary that has Bash enabled
      // can't smuggle it into a sub-agent that wasn't granted access.
      const subAgentBash = sa.allowSdkBash ? ["Bash"] : [];

      const definition: AgentDefinition = {
        description: sa.description?.trim() || `${sa.agentName ?? sa.slug} specialist agent`,
        prompt: buildSubAgentPrompt(sa),
        tools: [
          ...inProcessToolNames,
          ...externalToolPrefixes,
          ...subAgentBuiltins,
          ...subAgentBash,
        ],
        model: mapModelSlugToSdkAgentModel(sa.modelSlug),
      };

      bundles.push({
        slug: effectiveSlug,
        // Source row type — the SDK runner uses this to enforce its
        // "claude_sub_agent only" activation guard. The query above
        // already filters to that type; we forward the row's actual
        // value so the guard can verify rather than trust.
        agentType: sa.type,
        definition,
        mcpServerName,
        mcpServer,
        externalMcpServers,
      });
    } catch (err) {
      // One failed sub-agent should not poison the rest. Log and skip — the
      // primary still gets the others.
      logger.error("Failed to build sub-agent bundle", {
        systemAgentId: sa.id,
        slug: sa.slug,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return bundles;
}
