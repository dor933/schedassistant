import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Agent } from "@scheduling-agent/database";
import type { AgentId, CliProvider, UserId } from "@scheduling-agent/types";
import { logger } from "../logger";
import {
  runCliExecution,
  findResumableSession,
  CliBusyError,
  formatBusyForTool,
} from "../utils/cliExecution";

/**
 * `run_claude_cli` / `run_codex_cli` — let any granted agent invoke a CLI
 * subprocess directly. Both tools are thin wrappers around `runCliExecution`,
 * which owns the cross-provider busy lock, the `cli_executions` ledger row,
 * and the spawn under `su-exec agent` with HOME pinned to /home/agent.
 *
 * What the tool exposes that the engine doesn't:
 *   - `cwd` defaults to the agent's `workspacePath` so the LLM doesn't need
 *     to know its own directory layout up-front.
 *   - `resume=true` (default) auto-looks-up the agent+thread's most-recent
 *     completed session id and forwards it as `resumeSessionId`. Agents get
 *     conversation continuity without managing session ids themselves.
 *   - The result is a terse human-readable summary the LLM can paste into
 *     its next reasoning step (cost, duration, session id, status, output).
 *
 * What this tool deliberately does NOT do (that the epic flow does):
 *   - No git diff capture.
 *   - No safety-net auto-commit.
 *   - No `agent_tasks` or `task_executions` row writes.
 *   - No `--resume` retry-on-session-expired (one shot — if the session is
 *     stale, the LLM sees the failure and decides whether to retry without
 *     resume).
 *
 * Concurrency: callers can race each other on `pgrep`. The losing call
 * surfaces a `BUSY:` prefix so the LLM can recognize and back off rather
 * than treat it as a hard failure.
 */

const SHARED_SCHEMA = z.object({
  prompt: z
    .string()
    .min(1)
    .describe("The prompt / instructions to send to the CLI."),
  cwd: z
    .string()
    .optional()
    .describe(
      "Absolute path to run the CLI in. Defaults to the agent's workspace " +
        "(`agents.workspace_path`). Use a repo path to operate on a specific codebase.",
    ),
  systemPrompt: z
    .string()
    .optional()
    .describe(
      "Optional extra system-level context. Claude appends it via " +
        "`--append-system-prompt`; Codex prepends it to the user prompt.",
    ),
  model: z
    .string()
    .optional()
    .describe(
      "Concrete model id (e.g. 'sonnet', 'opus', 'gpt-5-codex'). " +
        "Falls back to whatever the CLI's profile resolves to.",
    ),
  resume: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Auto-resume the most recent successful session for this " +
        "(provider, agent, thread). Set false to start a fresh session.",
    ),
});

const CODEX_SCHEMA = SHARED_SCHEMA.extend({
  mode: z
    .enum(["execute", "plan", "review"])
    .optional()
    .default("execute")
    .describe(
      "Codex run style. `execute` performs the requested work. `plan` asks " +
        "Codex to inspect and return an implementation plan only. `review` " +
        "asks a separate code-review style Codex run to look for bugs, " +
        "regressions, security risks, and missing tests without editing files.",
    ),
  profile: z
    .string()
    .optional()
    .describe(
      "Codex config profile to load from ~/.codex/config.toml (`--profile`).",
    ),
  reasoningEffort: z
    .enum(["minimal", "low", "medium", "high", "xhigh"])
    .optional()
    .describe(
      "Reasoning effort for supported Codex models. Forwarded as " +
        "`-c model_reasoning_effort=...`.",
    ),
  planModeReasoningEffort: z
    .enum(["none", "minimal", "low", "medium", "high", "xhigh"])
    .optional()
    .describe(
      "Plan-mode-specific reasoning override. Most useful with " +
        "`mode: 'plan'`; forwarded as `-c plan_mode_reasoning_effort=...`.",
    ),
  sandbox: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .optional()
    .describe(
      "Deprecated compatibility field. Codex CLI runs always use the full " +
        "permissions bypass in this service, so this value is ignored.",
    ),
  approvalPolicy: z
    .enum(["untrusted", "on-request", "never"])
    .optional()
    .describe(
      "Deprecated compatibility field. Codex CLI runs always use the full " +
        "permissions bypass in this service, so no approval policy is passed.",
    ),
  bypassApprovalsAndSandbox: z
    .boolean()
    .optional()
    .describe(
      "Deprecated compatibility field. Codex CLI runs always pass Codex's " +
        "dangerous full permissions bypass flag.",
    ),
  webSearch: z
    .enum(["disabled", "cached", "live"])
    .optional()
    .describe(
      "Codex web search mode. `live` passes `--search`; `cached`/`disabled` " +
        "are forwarded as config overrides.",
    ),
  imagePaths: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Absolute image paths to attach to the first Codex prompt (`--image`).",
    ),
  useSubagents: z
    .boolean()
    .optional()
    .describe(
      "Ask Codex to spawn subagents when the task can be split. Subagents " +
        "are prompt-driven in Codex; this also enables the multi_agent feature.",
  ),
});

const CLAUDE_SCHEMA = SHARED_SCHEMA.extend({
  mode: z
    .enum(["execute", "plan", "review"])
    .optional()
    .default("execute")
    .describe(
      "Claude Code run style. `execute` performs the requested work. " +
        "`plan` starts Claude in plan permission mode and asks for an " +
        "implementation plan only. `review` starts read-only/planning " +
        "behavior and asks for code-review findings without edits.",
    ),
  permissionMode: z
    .enum(["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"])
    .optional()
    .describe(
      "Claude Code permission mode (`--permission-mode`). If omitted, " +
        "execute mode keeps the historical bypass behavior; plan/review use `plan`.",
    ),
  bypassPermissions: z
    .boolean()
    .optional()
    .describe(
      "When true, passes `--dangerously-skip-permissions`. Defaults to true " +
        "for execute mode unless `permissionMode` is set; defaults to false " +
        "for plan/review.",
    ),
  effort: z
    .enum(["low", "medium", "high", "xhigh", "max"])
    .optional()
    .describe("Claude Code effort level for the current session (`--effort`)."),
  maxTurns: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe("Maximum agentic turns for print mode (`--max-turns`). Default is 200."),
  maxBudgetUsd: z
    .number()
    .positive()
    .optional()
    .describe("Maximum API spend for this print-mode run (`--max-budget-usd`)."),
  fallbackModel: z
    .string()
    .optional()
    .describe("Fallback model for overloaded defaults (`--fallback-model`)."),
  sessionName: z
    .string()
    .optional()
    .describe("Display name for the Claude Code session (`--name`)."),
  claudeAgent: z
    .string()
    .optional()
    .describe("Configured Claude Code agent to use (`--agent`)."),
  allowedTools: z
    .array(z.string().min(1))
    .optional()
    .describe("Claude Code permission rules that execute without prompting (`--allowedTools`)."),
  disallowedTools: z
    .array(z.string().min(1))
    .optional()
    .describe("Claude Code tools/rules removed from context (`--disallowedTools`)."),
  tools: z
    .array(z.string().min(1))
    .optional()
    .describe("Restrict available built-in tools (`--tools`), e.g. ['Read','Grep','Bash']."),
  addDirs: z
    .array(z.string().min(1))
    .optional()
    .describe("Additional directories Claude may read/edit (`--add-dir`)."),
  useDbMcpConfig: z
    .boolean()
    .optional()
    .describe(
      "Load the generated Claude MCP config from the admin DB registry. Defaults to true.",
    ),
  mcpConfigPaths: z
    .array(z.string().min(1))
    .optional()
    .describe("Additional Claude MCP config JSON files/strings to load (`--mcp-config`)."),
  strictMcpConfig: z
    .boolean()
    .optional()
    .describe("Only use MCP servers from provided MCP configs (`--strict-mcp-config`)."),
  agentsJson: z
    .string()
    .optional()
    .describe(
      "JSON string defining dynamic Claude Code subagents (`--agents`). Use only when the run needs custom subagents.",
    ),
  useSubagents: z
    .boolean()
    .optional()
    .describe(
      "Prompt Claude to use subagents/agent teams when useful. For custom subagent definitions, also pass `agentsJson`.",
    ),
  bare: z
    .boolean()
    .optional()
    .describe("Use Claude bare mode (`--bare`), which skips MCP/plugins/skills/CLAUDE.md discovery."),
  chrome: z
    .boolean()
    .optional()
    .describe("Enable or disable Claude's Chrome integration for this run (`--chrome` / `--no-chrome`)."),
  forkSession: z
    .boolean()
    .optional()
    .describe("When resuming, create a new Claude session id (`--fork-session`)."),
  settingSources: z
    .array(z.enum(["user", "project", "local"]))
    .optional()
    .describe("Claude setting sources to load (`--setting-sources`)."),
});

/** Inputs the LangChain runtime hands to the tool callback. */
type SharedInput = z.infer<typeof SHARED_SCHEMA>;
type CodexInput = z.infer<typeof CODEX_SCHEMA>;
type ClaudeInput = z.infer<typeof CLAUDE_SCHEMA>;

interface ToolBinding {
  agentId: AgentId;
  userId: UserId | null;
  threadId: string | null;
}

async function resolveCwd(
  inputCwd: string | undefined,
  agentId: AgentId,
): Promise<{ cwd: string; defaulted: boolean } | { error: string }> {
  if (inputCwd) return { cwd: inputCwd, defaulted: false };
  const agent = await Agent.findByPk(agentId, { attributes: ["workspacePath"] });
  const workspacePath =
    (agent as { workspacePath?: string | null } | null)?.workspacePath ?? null;
  if (!workspacePath) {
    return {
      error:
        "No `cwd` provided and the agent has no `workspace_path` configured. " +
        "Pass an explicit `cwd` (absolute path) or ask an admin to set the agent's workspace.",
    };
  }
  return { cwd: workspacePath, defaulted: true };
}

function formatResult(args: {
  provider: CliProvider;
  status: string;
  exitCode: number | null;
  costUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  sessionId: string | null;
  defaultedCwd: boolean;
  cwd: string;
  resultText: string;
  stderr: string;
}): string {
  const lines: string[] = [];
  const ok = args.status === "completed";
  const tag = ok ? "✓" : "✗";
  lines.push(`${tag} ${args.provider} CLI ${args.status}`);

  const meta: string[] = [];
  if (args.costUsd !== null) meta.push(`cost $${args.costUsd.toFixed(4)}`);
  if (args.durationMs !== null) {
    meta.push(`${(args.durationMs / 1000).toFixed(1)}s`);
  }
  if (args.numTurns !== null) meta.push(`${args.numTurns} turn(s)`);
  if (args.exitCode !== null) meta.push(`exit ${args.exitCode}`);
  if (meta.length > 0) lines.push(`(${meta.join(" • ")})`);

  if (args.sessionId) {
    lines.push(
      `Session: ${args.sessionId} — pass \`resume: true\` next call to continue this conversation.`,
    );
  }
  lines.push(`cwd: ${args.cwd}${args.defaultedCwd ? " (defaulted to workspace)" : ""}`);

  if (ok) {
    lines.push("");
    lines.push("--- output ---");
    lines.push(args.resultText.trim() || "(empty)");
  } else {
    lines.push("");
    lines.push("--- stderr ---");
    lines.push(args.stderr.trim() || "(no stderr)");
    if (args.resultText.trim()) {
      lines.push("");
      lines.push("--- partial output ---");
      lines.push(args.resultText.trim());
    }
  }

  return lines.join("\n");
}

function makeRunCliTool(
  provider: CliProvider,
  binding: ToolBinding,
  toolMeta: { name: string; description: string },
) {
  return tool(
    async (rawInput: SharedInput): Promise<string> => {
      const input = SHARED_SCHEMA.parse(rawInput);

      const cwdResult = await resolveCwd(input.cwd, binding.agentId);
      if ("error" in cwdResult) return `Error: ${cwdResult.error}`;
      const { cwd, defaulted } = cwdResult;

      // Auto-resume lookup. We pass the prior session id through; if it has
      // since expired the engine simply forwards the CLI's "No conversation
      // found" error — the LLM can decide to retry with `resume: false`.
      let resumeSessionId: string | null = null;
      if (input.resume) {
        try {
          resumeSessionId = await findResumableSession({
            provider,
            agentId: binding.agentId,
            threadId: binding.threadId,
          });
        } catch (err: any) {
          logger.warn("runCliTool: resume lookup failed (non-fatal)", {
            provider,
            agentId: binding.agentId,
            threadId: binding.threadId,
            error: err?.message,
          });
        }
      }

      try {
        const result = await runCliExecution(
          {
            cwd,
            prompt: input.prompt,
            systemPrompt: input.systemPrompt,
            model: input.model,
            resumeSessionId: resumeSessionId ?? undefined,
          },
          {
            provider,
            agentId: binding.agentId,
            userId: binding.userId,
            threadId: binding.threadId,
            invokedVia: "run_cli_tool",
            parentSessionId: resumeSessionId,
          },
        );

        return formatResult({
          provider,
          status: result.status,
          exitCode: result.exitCode,
          costUsd: result.costUsd,
          durationMs: result.durationMs,
          numTurns: result.numTurns,
          sessionId: result.sessionId,
          defaultedCwd: defaulted,
          cwd,
          resultText: result.resultText,
          stderr: result.stderr,
        });
      } catch (err: any) {
        if (err instanceof CliBusyError) {
          // formatBusyForTool produces the kind-aware multi-line text
          // (own_agent / cross_agent / untracked) — see cliExecution.ts.
          // Returning it as the tool result lets the LLM decide what to do
          // (wait, ask user about killing, surface to admin) based on
          // ownership rather than us guessing.
          return formatBusyForTool(err);
        }
        logger.error("runCliTool: engine error", {
          provider,
          agentId: binding.agentId,
          error: err?.message,
        });
        return `Error invoking ${provider} CLI: ${err?.message ?? String(err)}`;
      }
    },
    {
      name: toolMeta.name,
      description: toolMeta.description,
      schema: SHARED_SCHEMA,
    },
  );
}

function makeRunClaudeCliTool(
  binding: ToolBinding,
  toolMeta: { name: string; description: string },
) {
  return tool(
    async (rawInput: ClaudeInput): Promise<string> => {
      const input = CLAUDE_SCHEMA.parse(rawInput);

      const cwdResult = await resolveCwd(input.cwd, binding.agentId);
      if ("error" in cwdResult) return `Error: ${cwdResult.error}`;
      const { cwd, defaulted } = cwdResult;

      let resumeSessionId: string | null = null;
      if (input.resume) {
        try {
          resumeSessionId = await findResumableSession({
            provider: "claude",
            agentId: binding.agentId,
            threadId: binding.threadId,
          });
        } catch (err: any) {
          logger.warn("runClaudeCliTool: resume lookup failed (non-fatal)", {
            agentId: binding.agentId,
            threadId: binding.threadId,
            error: err?.message,
          });
        }
      }

      const { prompt, systemPrompt, providerOpts } = buildClaudeRun(input);

      try {
        const result = await runCliExecution(
          {
            cwd,
            prompt,
            systemPrompt,
            model: input.model,
            resumeSessionId: resumeSessionId ?? undefined,
            providerOpts,
          },
          {
            provider: "claude",
            agentId: binding.agentId,
            userId: binding.userId,
            threadId: binding.threadId,
            invokedVia: "run_cli_tool",
            parentSessionId: resumeSessionId,
          },
        );

        return formatResult({
          provider: "claude",
          status: result.status,
          exitCode: result.exitCode,
          costUsd: result.costUsd,
          durationMs: result.durationMs,
          numTurns: result.numTurns,
          sessionId: result.sessionId,
          defaultedCwd: defaulted,
          cwd,
          resultText: result.resultText,
          stderr: result.stderr,
        });
      } catch (err: any) {
        if (err instanceof CliBusyError) return formatBusyForTool(err);
        logger.error("runClaudeCliTool: engine error", {
          agentId: binding.agentId,
          error: err?.message,
        });
        return `Error invoking claude CLI: ${err?.message ?? String(err)}`;
      }
    },
    {
      name: toolMeta.name,
      description: toolMeta.description,
      schema: CLAUDE_SCHEMA,
    },
  );
}

function makeRunCodexCliTool(
  binding: ToolBinding,
  toolMeta: { name: string; description: string },
) {
  return tool(
    async (rawInput: CodexInput): Promise<string> => {
      const input = CODEX_SCHEMA.parse(rawInput);

      const cwdResult = await resolveCwd(input.cwd, binding.agentId);
      if ("error" in cwdResult) return `Error: ${cwdResult.error}`;
      const { cwd, defaulted } = cwdResult;

      let resumeSessionId: string | null = null;
      if (input.resume) {
        try {
          resumeSessionId = await findResumableSession({
            provider: "codex",
            agentId: binding.agentId,
            threadId: binding.threadId,
          });
        } catch (err: any) {
          logger.warn("runCodexCliTool: resume lookup failed (non-fatal)", {
            agentId: binding.agentId,
            threadId: binding.threadId,
            error: err?.message,
          });
        }
      }

      const { prompt, systemPrompt, providerOpts } = buildCodexRun(input);

      try {
        const result = await runCliExecution(
          {
            cwd,
            prompt,
            systemPrompt,
            model: input.model,
            resumeSessionId: resumeSessionId ?? undefined,
            providerOpts,
          },
          {
            provider: "codex",
            agentId: binding.agentId,
            userId: binding.userId,
            threadId: binding.threadId,
            invokedVia: "run_cli_tool",
            parentSessionId: resumeSessionId,
          },
        );

        return formatResult({
          provider: "codex",
          status: result.status,
          exitCode: result.exitCode,
          costUsd: result.costUsd,
          durationMs: result.durationMs,
          numTurns: result.numTurns,
          sessionId: result.sessionId,
          defaultedCwd: defaulted,
          cwd,
          resultText: result.resultText,
          stderr: result.stderr,
        });
      } catch (err: any) {
        if (err instanceof CliBusyError) return formatBusyForTool(err);
        logger.error("runCodexCliTool: engine error", {
          agentId: binding.agentId,
          error: err?.message,
        });
        return `Error invoking codex CLI: ${err?.message ?? String(err)}`;
      }
    },
    {
      name: toolMeta.name,
      description: toolMeta.description,
      schema: CODEX_SCHEMA,
    },
  );
}

function buildClaudeRun(input: ClaudeInput): {
  prompt: string;
  systemPrompt: string | undefined;
  providerOpts: Record<string, unknown>;
} {
  const mode = input.mode ?? "execute";
  const modeInstructions: string[] = [];

  if (mode === "plan") {
    modeInstructions.push(
      "Run in planning mode. Inspect the repository as needed and return a concise, ordered implementation plan. Do not edit files, run formatters, run migrations, or make persistent changes. If you discover blockers, include them in the plan.",
    );
  } else if (mode === "review") {
    modeInstructions.push(
      "Run as a code reviewer. Do not edit files. Prioritize correctness bugs, behavior regressions, security risks, migration/data risks, and missing tests. Return findings first with file/line references when possible, then a short residual-risk summary.",
    );
  }

  if (input.useSubagents) {
    modeInstructions.push(
      "Use Claude Code subagents or agent teams when the task has independent parts. Keep each delegation focused, wait for results, and consolidate the final answer.",
    );
  }

  const systemPrompt = [input.systemPrompt, ...modeInstructions]
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n\n");

  const hasPermissionControls =
    input.permissionMode !== undefined || input.bypassPermissions !== undefined;
  const bypassPermissions =
    input.bypassPermissions ??
    (hasPermissionControls || mode === "plan" || mode === "review" ? false : true);

  return {
    prompt: input.prompt,
    systemPrompt: systemPrompt || undefined,
    providerOpts: {
      mode,
      permissionMode:
        input.permissionMode ?? (mode === "plan" || mode === "review" ? "plan" : undefined),
      bypassPermissions,
      effort: input.effort,
      maxTurns: input.maxTurns,
      maxBudgetUsd: input.maxBudgetUsd,
      fallbackModel: input.fallbackModel,
      sessionName: input.sessionName,
      claudeAgent: input.claudeAgent,
      allowedTools: input.allowedTools,
      disallowedTools:
        input.disallowedTools ??
        (mode === "review" ? ["Edit", "MultiEdit", "Write"] : undefined),
      tools: input.tools,
      addDirs: input.addDirs,
      useDbMcpConfig: input.useDbMcpConfig,
      mcpConfigPaths: input.mcpConfigPaths,
      strictMcpConfig: input.strictMcpConfig,
      agentsJson: input.agentsJson,
      useSubagents: input.useSubagents ?? false,
      bare: input.bare,
      chrome: input.chrome,
      forkSession: input.forkSession,
      settingSources: input.settingSources,
    },
  };
}

function buildCodexRun(input: CodexInput): {
  prompt: string;
  systemPrompt: string | undefined;
  providerOpts: Record<string, unknown>;
} {
  const mode = input.mode ?? "execute";
  const modeInstructions: string[] = [];

  if (mode === "plan") {
    modeInstructions.push(
      "Run in planning mode. Inspect the repository as needed and return a concise, ordered implementation plan. Do not edit files, run formatters, run migrations, or make persistent changes. If you discover blockers, include them in the plan.",
    );
  } else if (mode === "review") {
    modeInstructions.push(
      "Run as a code reviewer. Do not edit files. Prioritize correctness bugs, behavior regressions, security risks, migration/data risks, and missing tests. Return findings first with file/line references when possible, then a short residual-risk summary.",
    );
  }

  if (input.useSubagents) {
    modeInstructions.push(
      "Use Codex subagents when the task has independent parts. Spawn focused explorer/worker/reviewer agents, wait for their results, and consolidate the answer. Keep delegation bounded and avoid duplicate work.",
    );
  }

  const systemPrompt = [input.systemPrompt, ...modeInstructions]
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n\n");

  const configOverrides: Record<string, unknown> = {};
  if (input.reasoningEffort) {
    configOverrides.model_reasoning_effort = input.reasoningEffort;
  }
  if (input.planModeReasoningEffort) {
    configOverrides.plan_mode_reasoning_effort = input.planModeReasoningEffort;
  }
  if (input.webSearch === "cached" || input.webSearch === "disabled") {
    configOverrides.web_search = input.webSearch;
  }
  if (input.useSubagents) {
    configOverrides["features.multi_agent"] = true;
  }

  return {
    prompt: input.prompt,
    systemPrompt: systemPrompt || undefined,
    providerOpts: {
      profile: input.profile,
      bypassApprovalsAndSandbox: true,
      webSearch: input.webSearch,
      imagePaths: input.imagePaths,
      configOverrides,
      mode,
      useSubagents: input.useSubagents ?? false,
    },
  };
}

export function RunClaudeCliTool(
  agentId: AgentId,
  userId: UserId | null,
  threadId: string | null,
) {
  return makeRunClaudeCliTool(
    { agentId, userId, threadId },
    {
      name: "run_claude_cli",
      description:
        "Spawn a non-interactive Claude Code CLI session (`claude -p`) and " +
        "return its output. Supports model selection, effort, max turns/" +
        "budget, permission modes including plan mode, tool allow/deny/" +
        "restriction flags, additional directories, dynamic subagents, " +
        "Chrome toggle, custom Claude agents, generated DB-backed MCP " +
        "config, and explicit run modes: `execute`, `plan`, and `review`. " +
        "Use `mode: 'plan'` to ask Claude for a plan only; use " +
        "`mode: 'review'` for a read-only code review. By default resumes " +
        "the most recent session in this thread. Only one CLI process can " +
        "run at a time across the whole host (claude + codex share the lock). " +
        "If the result starts with `BUSY:`, read the message to decide " +
        "whether to wait or ask the user about killing your own stuck execution.",
    },
  );
}

export function RunCodexCliTool(
  agentId: AgentId,
  userId: UserId | null,
  threadId: string | null,
) {
  return makeRunCodexCliTool(
    { agentId, userId, threadId },
    {
      name: "run_codex_cli",
      description:
        "Spawn a non-interactive OpenAI Codex CLI session (`codex exec`) " +
        "and return its output. Supports model selection, Codex config " +
        "profiles, reasoning effort, sandbox/approval policy, live/cached/" +
        "disabled web search, image inputs, and explicit run modes: " +
        "`execute`, `plan`, and `review`. Use `mode: 'plan'` to ask Codex " +
        "for a plan only; use `mode: 'review'` for a read-only code review. " +
        "Use `useSubagents: true` when the prompt should explicitly ask " +
        "Codex to fan out to subagents; subagents are prompt-driven and " +
        "inherit sandbox policy. By default resumes the most recent session " +
        "in this thread. Only one CLI process can run at a time across the " +
        "whole host (claude + codex share the lock). If the result starts " +
        "with `BUSY:`, read the message to decide whether to wait or ask " +
        "the user about killing your own stuck execution.",
    },
  );
}
