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
 * Tool surface per sub-agent is INTENTIONALLY MINIMAL. Sub-agents are
 * pure specialists: they get NO auto-bound LangChain tools (no agent
 * notes, episodic memory, thread/session helpers, skills, list_*,
 * consult_agent, send_file, Tavily, Google Workspace, etc.). The
 * model-visible surface is exactly:
 *   - External MCP servers attached to the sub-agent's row via
 *     `agent_available_mcp_servers` (filesystem, github, bash, …).
 *   - SDK built-ins (Read/Write/Edit/Glob/Grep/MultiEdit/WebFetch) iff
 *     the row's `allow_sdk_builtins=true`.
 *   - SDK `Bash` iff the row's `allow_sdk_bash=true`.
 *
 * If the admin attaches no MCP servers and leaves both flags off, the
 * sub-agent has zero tools and can only reason. That is by design —
 * sub-agents are configured per-row in the admin UI, not by inheritance.
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
import { getAgentSdkCapabilities } from "./sdkCapabilities.service";

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
 * `claude_sub_agent` rows are PURE — they get NO auto-bound LangChain tools.
 * Their entire model-visible tool surface comes from:
 *
 *   1. External MCP servers attached to their own row via
 *      `agent_available_mcp_servers` (filesystem, github, bash, etc.) —
 *      built separately by `buildExternalMcpServersForAgent`.
 *   2. SDK built-ins (Read/Write/Edit/Glob/Grep/MultiEdit/WebFetch) when
 *      the row's `allow_sdk_builtins=true`.
 *   3. SDK `Bash` when the row's `allow_sdk_bash=true`.
 *
 * Everything else (agent notes, episodic memory, thread summary, session
 * files, cron, Google grants, skills, consult_agent, list_*, send_file,
 * Tavily, Google Workspace, …) is intentionally NOT bound. Sub-agents are
 * specialists that operate on whatever MCP surface the admin explicitly
 * attaches — there is no "every agent gets these for free" baseline.
 *
 * This function returns an empty list so the caller's in-process MCP
 * server registers with zero tools (cheap no-op) and the sub-agent's
 * `definition.tools` whitelist consists only of items 1–3 above.
 */
async function buildSubAgentTools(
  _subAgent: Agent,
  _ctx: BuildSubAgentsContext,
): Promise<StructuredToolInterface[]> {
  return [];
}

/**
 * Loads each sub-agent's external MCP servers (github, etc.) and translates
 * them into the SDK's stdio config shape. Returns a flat map keyed by
 * server name.
 *
 * **Filesystem MCP servers are deliberately stripped here.** Sub-agents
 * do filesystem work via the SDK's native built-ins (Read / Write / Edit /
 * MultiEdit / Glob / Grep), gated by `agents.allow_sdk_builtins`. Exposing
 * the MCP filesystem server alongside would (a) duplicate the surface
 * the model has to choose between, and (b) re-introduce the
 * allowed-directory mismatch class of bug — the seeded `filesystem` MCP
 * is rooted at `/app/data` and would reject writes to the per-epic
 * workspace folder if it lives elsewhere. If a sub-agent row has a
 * filesystem-named MCP server attached in the admin UI, we log a warning
 * and skip it; the row's `allow_sdk_builtins` flag is the only sanctioned
 * filesystem path.
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
  const skippedFilesystem: string[] = [];
  for (const server of servers) {
    const lowerName = (server.name ?? "").toLowerCase();
    if (lowerName.includes("filesystem")) {
      skippedFilesystem.push(server.name);
      continue;
    }
    out[server.name] = {
      type: "stdio" as const,
      command: server.command,
      args: server.args ?? [],
      env: buildMcpEnv(server.env),
    };
  }
  if (skippedFilesystem.length > 0) {
    logger.warn(
      "Stripped filesystem MCP server(s) from claude_sub_agent — sub-agents " +
        "use SDK built-ins for filesystem (allow_sdk_builtins) instead.",
      { subAgentId, skipped: skippedFilesystem },
    );
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
    // `?.trim() ||` (not `??`) so empty-string slugs also fall back to the
    // synthetic id-derived form. `??` would let `slug = ""` through as the
    // SDK `agents:` map key, which silently breaks Task("", ...) dispatch.
    const effectiveSlug =
      sa.slug?.trim() || `csa_${sa.id.replace(/-/g, "_")}`;

    try {
      const tools = await buildSubAgentTools(sa, ctx);
      // One in-process MCP server per sub-agent, namespaced by id so
      // multiple sub-agents in the same query() never collide.
      const mcpServerName = `sys_${sa.id.replace(/-/g, "_")}`;
      const mcpServer = await createAgentToolsMcpServer(tools, undefined, mcpServerName);

      const externalMcpServers = await buildExternalMcpServersForAgent(sa.id);

      // Sub-agent's tool whitelist: every in-process tool by full SDK name,
      // each external MCP server by wildcard prefix, plus built-ins iff
      // the sub-agent has the `filesystem` SDK capability attached, plus
      // Bash iff it has the `bash` SDK capability. Explicit list (no
      // inheritance) so a sub-agent never accidentally calls a parent's tool.
      // Per-sub-agent capabilities live on the same `agent_sdk_capabilities`
      // junction as primaries — each sub-agent has independent grants, so a
      // primary that has Bash can't smuggle it into a sub-agent without one.
      const inProcessToolNames = buildAllowedToolsForServer(tools, mcpServerName);
      const externalToolPrefixes = Object.keys(externalMcpServers).map(
        (name) => `mcp__${name}__*`,
      );
      const subCaps = await getAgentSdkCapabilities(sa.id);
      const subAgentBuiltins = subCaps.hasFilesystem ? [...ENABLED_BUILTIN_TOOLS] : [];
      const subAgentBash = subCaps.hasBash ? ["Bash"] : [];

      const definition: AgentDefinition = {
        description: sa.description?.trim() || `${sa.agentName?.trim() || effectiveSlug} specialist agent`,
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
        slug: effectiveSlug,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return bundles;
}
