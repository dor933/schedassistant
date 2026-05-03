# Epic Graph `callModel` Node — End-to-End Flow

This document traces every step the epic orchestrator takes from the moment
`epicCallModelNode` is entered until it returns a state patch to LangGraph,
including:

- Where messages are emitted to the user (and via what transport).
- How tool calls are dispatched, including tool calls that themselves call
  more tool calls (sub-agent fan-out, MCP servers).
- Every file write that happens (session ledger, summary file, attachment
  link).
- All three runtime branches (Anthropic SDK, Codex SDK, legacy LangChain
  loop) with their distinct behaviors.
- The external functions involved (the Claude Agent SDK's `query()`, the
  Codex bridge, the worker-level reply emitter, the synthetic-message queue).

> **Source-of-truth files (cite when reading the doc):**
> - `apps/agent_service/src/graphs/epicGraph/nodes/callModel.ts` — the node.
> - `apps/agent_service/src/chat/anthropic/agentSdkRunner.ts` — Anthropic
>   SDK runner.
> - `apps/agent_service/src/chat/codex/codexSdkRunner.ts` — Codex SDK
>   runner.
> - `apps/agent_service/src/tools/epicTaskTools.ts` — the epic lifecycle
>   tools (`start_epic_task`, `complete_epic_task`,
>   `start_epic_task_codex`, etc.).
> - `apps/agent_service/src/utils/epicTaskUtils.ts` — DB helpers,
>   `appendContinuationMarker`, `advanceNextTaskInStage`.
> - `apps/agent_service/src/worker/agentChat.worker.ts` — turns the graph
>   patch into a socket emit + handles continuation queues.
> - `apps/agent_service/src/socket.ts` — the actual socket emit
>   (`emitAgentReply`).

---

## 0. Where the node sits

The epic graph is a LangGraph state graph compiled in `epicGraph/index.ts`.
Each user turn flows through these nodes in order:

```
contextBuilder → epicCallModelNode → (terminal)
```

`contextBuilder` produces the system prompt, validates the agent's
configuration, and decides whether the model needs to be invoked at all.
`epicCallModelNode` is where the LLM call(s) and tool execution happen.

The node is invoked by LangGraph's compiled runtime once per orchestrator
turn. A single user message → one `epicCallModelNode` invocation → one
state patch returned. Auto-continuation between tasks is currently OFF
(per-task pause) — see §6.

The wrapping infrastructure is:

- The `agentChat.worker.ts` BullMQ worker pulls a chat job off the queue,
  runs the graph (`graph.invoke`), gets back the final state, then calls
  `emitAgentReply` to push the result to the user's socket.

---

## 1. Entry: `epicCallModelNode(state, config)`

Signature:

```ts
export async function epicCallModelNode(
  state: AgentState,
  config: RunnableConfig,
): Promise<Partial<AgentState>>
```

The node consumes the LangGraph state and returns a partial patch that
LangGraph merges into the canonical state.

### 1.1 Error short-circuit

```ts
if (state.error) return {};
```

If a previous node already populated `state.error` (e.g. context builder
failed), we exit immediately without doing any work. The graph terminates
and the error propagates up to the worker, which emits an error reply.

### 1.2 State extraction

Pulled out of `state`:

| Field | Used for |
|---|---|
| `agentId` | Tool factories that need per-agent grants (notes, episodic memory, send_file). |
| `threadId` | Session workspace path, file-write ledger, summary file location. |
| `userId` | Tool factories that need user scoping (consult, projects, episodic). |
| `modelSlug` | Resolves which actual LLM (`gpt-4o`, `claude-sonnet-4-6`, etc.). |
| `systemPrompt` | The system prompt assembled by `contextBuilder`. |
| `messages` | Historical message array (the conversation up to this turn). |
| `groupId` / `singleChatId` | Routing for synthetic messages and consultations. |
| `sessionWorkspacePath` | Per-thread workspace folder (`<agent.workspacePath>/threads/<threadId>/`) — used to scope FS-write capture. |

If `systemPrompt` is missing, the node returns
`{ error: "No system prompt assembled..." }` and the worker reports the
error to the user.

---

## 2. Vendor resolution: `resolveOrgVendor(modelSlug, agentId)`

Located in `apps/agent_service/src/utils/resolveOrgVendor.service.ts`.

This is the most important early decision — it determines which of the
three runtime branches the node will take.

It looks up:

1. The agent's organization.
2. The LLM model row matching `modelSlug`.
3. The vendor row owning that model (`anthropic`, `openai`, `google`, ...).
4. The org's stored API key for that vendor.

Returns `{ vendorSlug, modelName, apiKey }` or null/missing-key error.

If the org has no key for the selected vendor, the node short-circuits
with an "API key not configured" error.

### 2.1 Model construction (only used for the legacy LangChain branch)

```ts
const model = getModel(modelSlug, vendor.vendorSlug, vendor.apiKey);
```

`getModel` returns a `BaseChatModel` instance:
- `openai` → `ChatOpenAI`
- `anthropic` → `ChatAnthropic` with `anthropicBaseConfig()` (which sets
  context-management options like `extended-cache-control`).
- `google` → `ChatGoogle`

Note: this `model` is **only used** by the legacy LangChain branch in
§5. The Anthropic and Codex SDK branches use their own runners directly
and ignore this object.

---

## 3. Tool list assembly

### 3.1 MCP tool loading: `getMcpTools(agentId)`

```ts
const rawMcpTools = await getMcpTools(agentId);
```

Located in `apps/agent_service/src/mcpClient/index.ts`. It:

1. Looks up `agent_available_mcp_servers` rows for this agent.
2. For each active row, fetches the corresponding `mcp_servers` row
   (command, args, env JSONB).
3. Resolves `{{VAR}}` env placeholders against `process.env`.
4. Spawns each server as a child process and connects via the MCP
   protocol.
5. Wraps each server's tools as LangChain `StructuredToolInterface`
   objects.

Common MCP servers in our setup:
- `dev-in-house-workspace-mcp` — filesystem reads/writes scoped to the
  agent's workspace.
- `dev-in-house-library-mcp` — read-only org library.
- `dev-in-house-bash-codex` — shell execution (Codex variant).

### 3.2 Filesystem-write instrumentation: `instrumentFsWriteTools(...)`

```ts
const mcpTools = instrumentFsWriteTools(rawMcpTools, {
  threadId,
  sessionWorkspacePath,
  source: "epic_orchestrator",
});
```

Located in `apps/agent_service/src/workspace/instrumentFsWriteTools.ts`.
This is a wrapper around every MCP filesystem write tool that:

1. **Enforces an extension policy** — every write must end in `.md` or
   `.txt`. Other extensions are rejected at the tool boundary so the
   model can never write executable code into the agent's workspace.
2. **Captures writes inside the per-thread session folder** (when one
   exists) into the `sessionFileLedger` — an in-memory map keyed by
   `threadId`. Used by `drainSessionFileLedger` later.

### 3.3 Active-tool slug allowlist: `loadActiveToolSlugs(agentId)`

```ts
const activeSlugs = await loadActiveToolSlugs(agentId);
const has = (slug: string) => activeSlugs.has(slug);
```

Located in `apps/agent_service/src/tools/resolveAgentTools.ts`. Reads
`agent_available_tools` rows for this agent and returns the set of
active tool slugs. Falls back to a small default set
(`consult_agent`, `list_agents`, `list_system_agents`) when the agent
has no rows.

### 3.4 Core epic-specific tool factories

The base list (always-on for epic agents):

```ts
const tools: StructuredToolInterface[] = [
  ReadAgentNotesTool(agentId),
  AppendAgentNotesTool(agentId),
  EditAgentNotesTool(agentId),
  SaveEpisodicMemoryTool(agentId, userId, threadId),
  RecallEpisodicMemoryTool(agentId),
  GetThreadSummaryTool(agentId),
  ListMyThreadsTool(agentId),
  ListMyRoundtablesTool(agentId),
  GetRoundtableOverviewTool(agentId),
  ReadSessionFileTool(agentId, threadId),
  GrepSessionFileTool(agentId, threadId),
  ListCronJobsTool(agentId),
  ListGoogleWorkspaceGrantsTool(agentId),
  ...agentSkillTools(agentId),
  CreateEpicPlanTool(userId, agentId),
  CompleteEpicTaskTool({ threadId, userId, groupId, singleChatId }),
  GetEpicStatusTool(),
  ReviewTaskDiffTool(),
  UpdateStagePrTool(),
  ForceApproveStagePrTool(),
  ApproveStageTool(),
  RequestStageChangesTool(),
  ResetStuckTaskTool(),
  CancelEpicTool(),
  ...mcpTools,
];
```

Each factory returns a LangChain `tool(...)` instance with a zod schema
and an async invoke handler. The handlers run in-process inside the
agent_service container.

### 3.5 Vendor-conditional epic-task surface

This is where the Anthropic vs Codex divergence appears at the tool
level:

```ts
...(vendor.vendorSlug === "anthropic"
  ? [StartAnthropicEpicTaskTool(agentId)]
  : vendor.vendorSlug === "openai"
    ? [
        PlanEpicTaskCodexTool(agentId),
        StartEpicTaskCodexTool(agentId, {
          threadId,
          sessionWorkspacePath,
          userId,
          groupId,
          singleChatId,
        }),
      ]
    : []),
```

- **Anthropic** gets `start_epic_task` — declares optional sub-agent
  assignments (or runs direct), snapshots HEAD, returns instructions
  for the model.
- **OpenAI/Codex** gets `plan_epic_task` (read-only Codex scout) +
  `start_epic_task_codex` (workspace-write detached Codex run that
  auto-finalizes server-side).
- **Other vendors** (e.g. Google) get neither — `complete_epic_task`
  is still bound but useless without a start tool.

### 3.6 Slug-gated configurable tools

```ts
if (has("list_agents"))               tools.push(ListAgentsTool(...));
if (has("consult_agent"))             tools.push(ConsultAgentTool(...));
if (has("list_system_agents"))        tools.push(ListSystemAgentsTool(...));
if (has("delegate_to_deep_agent"))    tools.push(DelegateToDeepAgentTool(...));
if (has("list_projects"))             tools.push(ListProjectsTool(...));
if (has("list_repositories"))         tools.push(ListRepositoriesTool());
if (has("get_repository"))            tools.push(GetRepositoryTool());
if (has("send_file_to_user"))         tools.push(SendFileToUserTool(agentId));
if (has("search_epic_tasks_by_date")) tools.push(SearchEpicTasksByDateTool());
if (has("get_epic_task_stages_and_tasks"))
                                       tools.push(GetEpicTaskStagesAndTasksTool());
```

Each entry is conditional on an admin-attached row in
`agent_available_tools`.

### 3.7 Anthropic-only `Task` discovery tool

```ts
if (vendor.vendorSlug === "anthropic") {
  tools.push(ListClaudeSubAgentsTool(agentId));
}
```

`list_claude_sub_agents` is only meaningful when the runner is the
Anthropic SDK (the SDK is what implements the `Task()` dispatch).
Codex agents never see it — listing it would let them call a tool they
can't follow up on.

---

## 4. Branch A — Anthropic SDK runtime

Activated by:

```ts
if (shouldUseAgentSdk(vendor.vendorSlug)) { ... }
```

`shouldUseAgentSdk` (in `agentSdkRunner.ts`) returns true only for
`anthropic`. This is the production path for all Anthropic-vendor
orchestrators.

### 4.1 Sub-agent bundles: `buildSubAgentDefinitions(...)`

```ts
const subAgents = await buildSubAgentDefinitions({
  primaryAgentId: agentId,
  userId, threadId, groupId, singleChatId,
});
```

Located in `apps/agent_service/src/utils/buildSubAgentDefinitions.service.ts`.
For every `claude_sub_agent` row attached to this primary, it produces a
`SubAgentBundle`:

```ts
{
  slug: effectiveSlug,            // sa.slug, or csa_<uuid> fallback
  agentType: "claude_sub_agent",
  definition: AgentDefinition,    // SDK shape: { description, prompt, tools, model }
  mcpServerName: "sys_<uuid>",    // namespaced in-process MCP server name
  mcpServer,                      // the in-process MCP server exposing the bundle's tools
  externalMcpServers,             // any external MCP servers the sub-agent has attached
}
```

Each sub-agent's `tools` whitelist is built from its own
`agent_available_tools` + Tavily/Google flags + optional SDK built-ins
(`Read`/`Write`/`Edit`/`Glob`/`Grep`) + optional `Bash`. Importantly,
this whitelist is per-sub-agent — the sub-agent only sees its own
surface, never the primary's.

### 4.2 The detected-continuation observer

```ts
let detectedContinuation: { ... } | null = null;
const sdkPatch = await runAnthropicAgentSdk({
  state, config, tools, vendor, modelSlug,
  maxTurns: MAX_TOOL_ROUNDS,        // 30
  source: "epic_orchestrator",
  subAgents,
  onToolResult: ({ text }) => {
    if (detectedContinuation) return;
    const cont = parseContinuationMarker(text);
    if (cont) detectedContinuation = cont;
  },
});
```

`onToolResult` fires for every tool result the SDK emits during its
loop. We scan each result text for the legacy `<!--EPIC_CONTINUATION:...-->`
marker. **In the current per-task pause flow, this marker is never
emitted** (`appendContinuationMarker` returns `""` when tasks remain) —
the observer is left in place as a defensive fallback in case any other
code path emits one.

### 4.3 Inside `runAnthropicAgentSdk` (the SDK loop)

This is the key external function. Located in `agentSdkRunner.ts` —
~1000 lines but the flow boils down to:

#### 4.3.1 Pre-flight: build the in-process MCP server for the primary's tools

```ts
const mcpServer = await createAgentToolsMcpServer(tools, ...);
```

Every LangChain tool we built in §3 is wrapped into ONE in-process MCP
server (`AGENT_TOOLS_MCP_SERVER_NAME`) with a corresponding `mcp__<name>__*`
tool surface for the SDK. This is how the SDK calls our LangChain tools —
the SDK speaks MCP, not LangChain, so we adapt.

#### 4.3.2 Build `allowedTools`, `extraMcpServers`, `agents`

The allowlist is explicit — the model can never call a tool we didn't
list:

```ts
const allowedTools: string[] = [
  ...buildAllowedToolsForServer(tools, AGENT_TOOLS_MCP_SERVER_NAME),  // mcp__<name>__<tool> per LangChain tool
  ...(allowBuiltins ? ENABLED_BUILTIN_TOOLS : []),                     // Read/Write/Edit/Glob/Grep iff allow_sdk_builtins
  ...(allowSdkBash ? ["Bash"] : []),                                   // SDK Bash iff allow_sdk_bash
  ...(useAnthropicWebSearch ? ["WebSearch"] : []),
];
if (hasSubAgents) {
  allowedTools.push("Task");                                           // Sub-agent dispatch
  for (const sa of subAgents!) {
    allowedTools.push(`mcp__${sa.mcpServerName}__*`);                  // Sub-agent's own tool prefixes
  }
}
```

The `agents:` map is built only when sub-agents are present:

```ts
const agents: Record<string, AgentDefinition> = {};
if (hasSubAgents) {
  for (const sa of subAgents!) {
    extraMcpServers[sa.mcpServerName] = sa.mcpServer;
    agents[sa.slug] = sa.definition;
  }
}
```

This is what turns a `Task("<slug>", "<scope>")` call from the model into
an actual sub-agent run inside the SDK's binary.

#### 4.3.3 Hooks (write capture)

```ts
const hooks = allowBuiltins
  ? buildBuiltinWriteHooks({ threadId, sessionWorkspacePath, source })
  : {};
```

`buildBuiltinWriteHooks` (`agentSdkBuiltinHooks.ts`) registers
`PreToolUse` (extension gate) and `PostToolUse` (session-file ledger)
hooks for the SDK's built-in `Write` / `Edit` / `MultiEdit`. Mirrors
`instrumentFsWriteTools` — every write through the SDK's native tools
goes through the same gate as the MCP filesystem writes.

#### 4.3.4 The actual call: `sdk.query({ ... })` (line ~555)

```ts
for await (const message of sdk.query({
  prompt: args.userInput,
  options: {
    model, systemPrompt, maxTurns,
    mcpServers: { [AGENT_TOOLS_MCP_SERVER_NAME]: mcpServer, ...extraMcpServers },
    allowedTools,
    env: buildSdkEnv(apiKey, keyType),
    spawnClaudeCodeProcess: makeSpawnClaudeCodeAsAgent(workingDirectory),
    stderr: onStderr,
    ...(resume ? { resume } : {}),
    ...(hasSubAgents ? { agents } : {}),
    ...(hooksKeys ? { hooks } : {}),
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  },
}))
```

The SDK spawns a Claude Code subprocess (the `claude` CLI binary
shipped inside the SDK package) and pumps a message stream back into
our generator loop. **All work happens inside that subprocess** — every
LLM call, every tool dispatch, every sub-agent run.

#### 4.3.5 Message types the SDK yields

The for-await loop classifies each message:

| Type | What it is | What we do |
|---|---|---|
| `system` (init) | Subprocess startup; carries `session_id`. | Persist `session_id` for trace + resume. |
| `assistant` | One assistant turn (intermediate or final). May contain text + `tool_use` blocks. | Convert to `AIMessage`, push onto `streamMessages`. Track `tool_use` ids in `pendingToolCalls` for Langfuse. Emit a Langfuse `generation` span. |
| `user` (tool_result wrapper) | Tool results being relayed back to the model. | Convert each `tool_result` block into a `ToolMessage`. Push onto `streamMessages`. **Fire `onToolResult` callback with the result text** (this is where the epic continuation observer runs). Pair with pending `tool_use` to emit a Langfuse `tool` span. |
| `result` (success) | Final SDK answer; carries aggregated usage + cost. | Stamp as `finalText`. Stamp usage/cost on the outer Langfuse span. |
| `result` (error_max_turns) | SDK ran out of turns. | Set `hitMaxTurns = true`, set error text. |
| `result` (other error) | SDK errored mid-loop. | Capture error text. |

#### 4.3.6 Tool execution path (sub-agent fan-out case)

When the orchestrator's LLM emits an assistant message with one or more
`tool_use` blocks named `Task`, the SDK looks each one up in
`options.agents`. For each match it:

1. Spawns a sub-agent run with that `AgentDefinition` (its own prompt,
   tools, MCP servers, model).
2. Streams the sub-agent's own assistant turns + tool calls + tool
   results — but those internal events stay inside the SDK; we only see
   the final `tool_result` block coming back to the parent.
3. Multiple `Task()` calls in one assistant message run **concurrently**.

The result block content is the sub-agent's final assistant text (its
`## Files changed` summary + any prose). It comes back as a `user`-typed
message containing a `tool_result` block, which we convert to a
`ToolMessage` and feed back into the orchestrator's reasoning.

#### 4.3.7 Tool execution path (in-process MCP tools)

For LangChain tools wrapped in our in-process MCP server (everything in
§3.4–3.6 except Bash/builtins), the SDK speaks MCP to the in-process
server, which adapts to LangChain's `tool.invoke()` and runs the
original handler — DB queries, git operations, queue pushes, etc.

#### 4.3.8 Tool execution path (SDK built-ins + Bash)

`Read`/`Write`/`Edit`/`MultiEdit`/`Glob`/`Grep` are built into the
Claude Code subprocess and run there directly. Same for `Bash` (a
persistent shell within the subprocess).

The `PreToolUse` hook intercepts every `Write`/`Edit`/`MultiEdit` call
and rejects writes to anything other than `.md`/`.txt`. The
`PostToolUse` hook captures successful writes into the session-file
ledger (same one MCP writes go into).

#### 4.3.9 The runner's return value

When the `result` event arrives, the for-await loop exits and the
runner builds:

```ts
return {
  messages: streamMessages,           // every AIMessage + ToolMessage observed
  sessionFiles: drainSessionFileLedger(threadId),
  ...(sessionId ? { claudeSessionId: sessionId } : {}),
  ...(hitMaxTurns ? { error: "Too many tool calls in one turn." } : {}),
  ...(errorText ? { error: errorText } : {}),
};
```

This is the state patch returned to the LangGraph node.

### 4.4 Back in `epicCallModelNode`: applying the continuation observer

```ts
if (detectedContinuation && !sdkPatch.error) {
  return { ...sdkPatch, epicContinuation: detectedContinuation };
}
return sdkPatch;
```

In the current per-task pause flow this branch never fires — the
observer is dead code when no marker is emitted. The path remains
defensive in case a future code path re-introduces a marker.

---

## 5. Branch B — Codex SDK runtime

Activated by:

```ts
if (shouldUseCodexSdk(vendor.vendorSlug)) { ... }
```

`shouldUseCodexSdk` (in `codexSdkRunner.ts`) returns true for `openai`
when the agent's modelSlug is a Codex-routable one. The Codex flow is
operationally very different from Anthropic's.

### 5.1 No sub-agents

The Codex SDK has no parallel `Task()` equivalent and concurrent Codex
sessions on one repo race on the git index. So this branch passes
**no** `subAgents` argument — the `agents:` map is empty.

### 5.2 Continuation observer (same shape, defensive)

```ts
const sdkPatch = await runOpenAiCodexSdk({
  state, config, tools, vendor, modelSlug,
  maxTurns: MAX_TOOL_ROUNDS,
  source: "epic_orchestrator",
  onToolResult: ({ text }) => {
    if (detectedContinuation) return;
    const cont = parseContinuationMarker(text);
    if (cont) detectedContinuation = cont;
  },
});
```

Same purpose as the Anthropic observer, same dead-in-current-flow
status.

### 5.3 Inside `runOpenAiCodexSdk`

The Codex runner bridges the Anthropic-style runner contract over to the
Codex SDK. Major differences from the Anthropic path:

- The orchestrator's tool loop runs inside a Codex `mcp_tool_call`
  bridge — Codex's session calls our LangChain tools via MCP, similar
  to how the Anthropic runner's in-process MCP server works, but the
  underlying LLM is OpenAI's Codex model.
- No `Task` dispatch (no sub-agents).
- The runner forwards each tool result text to `onToolResult` so the
  contract with `epicCallModelNode` is identical to the Anthropic
  branch.
- Returns the same `{ messages, sessionFiles, error? }` shape.

### 5.4 Asymmetric work pattern: detached task execution

The big architectural difference is in the **tools** the Codex flow
calls, not the runner itself:

- `start_epic_task_codex` does NOT block. It marks the task
  `in_progress`, snapshots HEAD, opens a `task_executions` row, then
  spawns a **detached** Codex run (`void Promise.resolve().then(() => ...)`)
  that finishes in the background. The tool returns immediately to the
  orchestrator with text saying "Codex is running detached."
- The orchestrator's turn ends naturally — the model has nothing more
  to do and emits a closing assistant message.
- Later, when the detached Codex run finishes, the worker calls
  `finalizeEpicTaskExecution` (capture diff, write summary, advance
  next task in stage) and then `enqueueEpicPostCodexFinalizeTurn` —
  which puts a synthetic system message onto the BullMQ queue. That
  message wakes a NEW orchestrator turn (going back through the entire
  `contextBuilder → epicCallModelNode` flow) carrying the heading +
  summary + attachment markdown + pause hint.

So a Codex epic task is split across **two** orchestrator turns:
1. Turn A: model calls `start_epic_task_codex` → tool returns "running
   detached" → model writes a brief "starting the task" message → exit.
2. Turn B (asynchronously triggered by the system follow-up message):
   model produces a closing message that includes the attachment + the
   pause hint → exit.

---

## 6. Branch C — Legacy LangChain loop (fallback)

Reached only when neither `shouldUseAgentSdk(vendor)` nor
`shouldUseCodexSdk(vendor)` is true. Today this means Google or any
non-anthropic-non-openai vendor — there's no current epic flow there
(no start tool is bound in §3.5), so this is essentially dormant.

Even though it's dormant for epic, the loop is still useful to
understand because (a) it's the exact same machinery the basic graph
uses, and (b) it documents the "manual" shape of what the SDK runners
encapsulate.

### 6.1 Tool name lookup

```ts
const toolByName = new Map<string, StructuredToolInterface>(
  tools.map((t) => [t.name, t]),
);
```

### 6.2 Tool binding

```ts
const modelWithTools = bindTools.call(model, tools);
```

LangChain's `bindTools` adds the tool schemas to every subsequent
`invoke()` request. The model now knows what tools are available.

### 6.3 Message normalization

```ts
const llmMessages: BaseMessage[] = [new SystemMessage(systemPrompt)];
for (const msg of stateMessages) { ... }
const llmMessagesForProvider =
  vendor.vendorSlug === "openai" ? normalizeHistoryForOpenAI(llmMessages) : llmMessages;
```

The history is reconstructed from `state.messages`. Each historical
message gets sanitized:
- `name` is sanitized (strip whitespace, slashes, etc.).
- AI messages have any `thinking` blocks with signatures stripped (they
  can't be sent back to the model).
- For OpenAI, content arrays of just text are flattened to strings, and
  the first non-system message is forced to be a `HumanMessage` (OpenAI
  rejects assistant-first histories).

### 6.4 The tool loop

```ts
for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
  const response = await modelWithTools.invoke(working, config);

  // Strip thinking signatures
  if (response instanceof AIMessage && Array.isArray(response.content)) {
    (response as any).content = stripThinkingSignatures(response.content);
  }

  const toolCalls = response instanceof AIMessage ? response.tool_calls : undefined;

  if (!toolCalls?.length) {
    // Final answer — stamp metadata and return
    response.additional_kwargs = { ...modelSlug, vendorSlug, modelName };
    newMessages.push(response);
    const sessionFiles = drainSessionFileLedger(threadId);
    return sessionFiles.length > 0
      ? { messages: newMessages, sessionFiles }
      : { messages: newMessages };
  }

  newMessages.push(response);

  // Execute each tool call
  for (const tc of toolCalls) {
    const t = toolByName.get(tc.name);
    let content: string;
    if (!t) {
      content = `Error: unknown tool "${tc.name}".`;
    } else {
      const rawResult = await observeToolCall(tc.name, tc.args,
        () => t.invoke(tc.args ?? {}));
      // Coerce to string for the LangChain ToolMessage contract
      content = typeof rawResult === "string" ? rawResult : ...
    }
    toolMsgs.push(new ToolMessage({ content, tool_call_id: tc.id ?? "" }));
  }

  newMessages.push(...toolMsgs);
  working = [...working, response, ...toolMsgs];

  // Check for the legacy continuation marker (defensive)
  for (const tm of toolMsgs) {
    const continuation = parseContinuationMarker(content);
    if (continuation) {
      // Append a wrap-up hint message and ask the model for a closing reply
      const hintMsg = new HumanMessage({
        content: `[System: Task "${continuation.completedTaskTitle}" is done...]`,
        name: "system",
      });
      working.push(hintMsg);
      const wrapUpResponse = await modelWithTools.invoke(working, config);
      newMessages.push(wrapUpResponse);
      return { messages: newMessages, epicContinuation: continuation, ... };
    }
  }
}
```

Capped at `MAX_TOOL_ROUNDS = 30`. Hitting the cap returns
`{ error: "Too many tool calls in one turn." }`.

In the current per-task pause flow the legacy continuation block at the
end is dead code (no marker emitted) — same defensive fallback as the
SDK runners.

### 6.5 Session file draining

`drainSessionFileLedger(threadId)` pops every captured FS write from
the in-memory ledger for this thread. The result becomes
`state.sessionFiles` on the patch — used by the worker to surface the
file as a chat attachment.

---

## 7. The lifecycle tools called inside the loop

These are not part of `epicCallModelNode` itself but are the most
important tool handlers it dispatches through any of the three branches.

### 7.1 `start_epic_task` (Anthropic) — `epicTaskTools.ts:681`

When the orchestrator calls this tool inside the SDK loop:

1. **Validate `assignments`** if non-empty (deduplicate ids, check each
   id is a `claude_sub_agent` row owned by the caller).
2. **Resolve the active epic** via `resolveActiveEpic()`.
3. **Resolve the next ready task** via `resolveNextRetryableTask(epic.id)`.
4. **Resolve the working directory** from the epic's repository's
   `localPath`.
5. **`preExecutionSync(epic.id, next.id)`** — checks out the stage's
   feature branch, syncs from origin, creates the branch if it doesn't
   exist yet.
6. **Mark the task `in_progress`** with `await next.update(...)`.
7. **Snapshot HEAD** via `gitAsAgent(cwd, ["rev-parse", "HEAD"])` — this
   is the diff anchor.
8. **Create the `task_executions` row** with `startExecution(...)` —
   stores the prompt + the validated assignments in metadata.
9. **Return the instruction text** to the model: working directory,
   base SHA, the validated dispatch plan (or "do it yourself"
   instructions if assignments is empty), and the next steps.

The tool returns. The model sees the instruction text as a tool result
and continues its loop — either emitting `Task()` calls or directly
invoking filesystem MCP / Bash tools.

### 7.2 `complete_epic_task` — `epicTaskTools.ts:919`

When the orchestrator calls this tool (Anthropic flow only — Codex
auto-finalizes server-side):

1. **`resolveInProgressExecution()`** — finds the unique `in_progress`
   task + its `task_executions` row.
2. **Validate input** — non-empty `summary`, `failureReason` if status
   is `failed`.
3. **Call `finalizeEpicTaskExecution(...)`** — the shared finalize
   path. See §7.3.
4. **Compose the return text** — heading + summary + attachment
   markdown block + (optional) stage-completed PR/plan text +
   per-task pause hint.

The tool returns to the model, which sees:
- A copy of its own summary.
- An attachment link of the form `[📎 task-…-summary.md](signed-url)`
  it should paste verbatim into its reply.
- A pause hint instructing it not to call any more tools.

### 7.3 `finalizeEpicTaskExecution(...)` — the shared finalize path (`epicTaskTools.ts:373`)

Called both by `CompleteEpicTaskTool` (Anthropic, synchronous) and by
the detached Codex worker (asynchronous, server-side after a
`start_epic_task_codex` background run finishes).

Sequence of side effects:

1. **Auto-commit working tree** (success path only) —
   `ensureWorkingTreeCommitted(cwd, task.title)` runs `git add -A` +
   `git commit` if there are uncommitted changes in the repo. Records
   `auto_committed` + `auto_commit_message` in metadata.
2. **Capture git diff** — `captureGitDiff(cwd, preRunSha)` runs
   `git diff <preRunSha>..HEAD --stat` plus the full diff and recent
   commits. Stored in metadata as `git_diff_stat`, `git_diff`,
   `git_recent_commits`, `git_diff_base_sha`.
3. **Write `task_executions` row** — `completeExecution(...)` for
   success, `failExecution(...)` for failure. Each writes status,
   result/error, completedAt, and merges metadata.
4. **Flip task status** — `updateTaskStatus(task.id, status)` writes
   the new status and runs `propagateStatus` (computes derived stage
   + epic statuses).
5. **Write the summary file** —
   `<workspace>/threads/<threadId>/task-<8charid>-summary.md`.
   The header is `# <title>\n\n**Status:** <status>...\n\n` and the
   body is the orchestrator's `summary`. Path is recorded on
   `agent_tasks.summary_file_path` via `recordTaskSummaryFilePath(...)`.
6. **Build the attachment markdown** —
   `buildAttachmentUrl(epicAgentId, "threads/<threadId>/<basename>")`
   returns a signed `/claw/api/attachments?...` URL with HMAC. Wrapped
   as `[📎 <basename>](<url>)`. Stored on the return shape's
   `attachmentMarkdown` field.
7. **Advance the next task in the stage** (success only) —
   `advanceNextTaskInStage(task.id)` finds the next `pending` sibling
   in the same stage (by `sortOrder`) and flips it to `ready`.
   `propagateStatus` is run again to keep derived statuses consistent.
8. **`appendContinuationMarker(task.id)`** — under per-task pause this
   returns `""` when tasks remain, or the PR-created / plan-stage
   text when the stage has just finished.
9. Return `{ heading, summary, continuation, attachmentMarkdown }`.

### 7.4 `start_epic_task_codex` (OpenAI) — `epicTaskTools.ts:1282`

Different shape from the Anthropic start tool because the actual run is
detached:

1. Validate vendor/modelSlug + repo localPath + active epic.
2. Resolve the next ready task. Mark `in_progress`. Snapshot HEAD.
   Create execution row with `codex_run_in_flight: true`.
3. **Spawn the detached run** —
   `void Promise.resolve().then(() => (async () => { await runCodexInRepo(...); ... }))()`.
   Inside the detached IIFE:
   - Call `runCodexInRepo(...)` (the Codex SDK in workspace-write mode).
   - When it returns, call `finalizeEpicTaskExecution(...)` exactly like
     the Anthropic path.
   - Call `enqueueEpicPostCodexFinalizeTurn(...)` to enqueue a synthetic
     system message that wakes the orchestrator with the summary +
     attachment.
4. **Return immediately** to the synchronous tool result with text
   like "Codex is running detached. Polling get_epic_status will
   reflect status changes; when finalize completes, a follow-up turn
   will deliver the summary."

The orchestrator's current turn ends naturally with whatever closing
message the model writes after seeing this tool result.

### 7.5 `enqueueEpicPostCodexFinalizeTurn(...)` — `epicTaskTools.ts:497`

Called from the detached Codex worker after `finalizeEpicTaskExecution`.
Its only job is to put a system follow-up message on the BullMQ
`agentChat` queue:

```ts
const body = `${heading}\n\n${summary}${attachmentBlock}${stageFollowup}${pauseHint}`;
await agentChatQueue.add("epic_codex_finalize_followup", {
  userId, message: body, requestId, groupId, singleChatId, agentId,
  mentionsAgent: true, displayName: "System",
});
```

This synthetic message goes through the full chat pipeline — the worker
picks it up, runs the orchestrator's graph again with this as the
"user" message, and the orchestrator emits a closing reply that
includes the attachment markdown.

---

## 8. The state patch returned by `epicCallModelNode`

Three possible shapes:

```ts
// Success, no continuation, no captured session files
{ messages: [...] }

// Success, captured session-file writes for this turn
{ messages: [...], sessionFiles: [...] }

// (Currently dead code path) success + continuation marker detected
{ messages: [...], epicContinuation: { ... } }

// Error
{ error: "..." }
```

`messages` is the list of `AIMessage` + `ToolMessage` instances from
this turn — appended to the canonical `state.messages` by LangGraph's
default reducer.

`sessionFiles` is the per-thread file-write ledger drained for this
turn — used by the worker to surface attachments.

`epicContinuation` is set only when the legacy marker is detected; the
worker turns it into a synthetic user message that re-invokes the
graph. Today this is a defensive code path (no callsite emits the
marker).

---

## 9. After exit: the worker → user transport

The graph's compiled runtime returns the final state to
`agentChat.worker.ts:processChatJob`. The relevant section (line
~390-450):

```ts
const { turnResult, threadId } = result;

emitAgentReply({
  requestId, userId, threadId, groupId, singleChatId,
  ok: true,
  reply: turnResult.reply,
  systemPrompt: turnResult.systemPrompt,
  modelSlug, vendorSlug, modelName,
});

// Auto-continuation (today: dead branch with the marker disabled).
if (turnResult.epicContinuation) {
  await agentChatQueue.add("epic_continuation", {
    userId,
    message: `[Automatic continuation] ...`,
    ...
  });
}
```

### 9.1 The reply emit: `emitAgentReply` (`socket.ts:121`)

```ts
io.emit("agent:reply", payload);
```

This is the single point where text reaches the user's chat UI. The
payload is:

```ts
{
  requestId, userId, threadId, groupId, singleChatId,
  ok: true,
  reply: "<the orchestrator's final assistant text>",
  systemPrompt, modelSlug, vendorSlug, modelName,
}
```

The user_app socket listener routes `agent:reply` to the active chat
window. The `reply` string is rendered as Markdown — which is how the
attachment link `[📎 task-…-summary.md](url)` becomes a clickable
download. Clicking the link hits the agent_service's `/claw/api/attachments`
endpoint, which validates the HMAC signature and streams the file.

Important: the user only ever sees the **final** assistant text from
the turn — they do not see intermediate tool calls, sub-agent turns,
or anything from inside the SDK loop. The whole `for await` over
`sdk.query(...)` happens silently while the chat appears idle.

### 9.2 Synthetic continuation messages

Two paths still enqueue synthetic system messages today:
- **`epicTask.service.handlePrApproval`** — when a stage's PR is
  approved (webhook or chat), this enqueues an "epic_pr_continuation"
  message instructing the orchestrator to call the next stage's first
  task. (After our recent change `advanceNextStageReadyTasks` only
  flips one task per stage, so this auto-runs exactly one task and
  then pauses.)
- **`epicTask.service.handlePrChangesRequested`** — when a PR is
  rejected, enqueues an "epic_pr_review_retry" message with the review
  feedback.

Both write to the same BullMQ queue the user's chat messages flow
through. The worker picks them up indistinguishably and the graph runs
again from the top.

---

## 10. Side-effects glossary (everything that mutates state)

| Side effect | Triggered by | Callsite |
|---|---|---|
| Spawn MCP server subprocesses | `getMcpTools(agentId)` (§3.1) | `mcpClient/index.ts` |
| Spawn Claude Code subprocess | `runAnthropicAgentSdk` → `sdk.query` (§4.3.4) | `@anthropic-ai/claude-agent-sdk` |
| Spawn Codex subprocess | `runOpenAiCodexSdk` → Codex bridge (§5.3) | `@openai-codex/sdk` (or whichever package) |
| Spawn detached Codex run | `start_epic_task_codex` (§7.4) | `epicTaskTools.ts:~1370` |
| Spawn sub-agent runs | SDK's `Task()` dispatch (§4.3.6) | inside Claude Code subprocess |
| `git rev-parse HEAD` | `start_epic_task` / `start_epic_task_codex` | `epicTaskTools.ts` (snapshot) |
| `git checkout` / `git fetch` | `preExecutionSync` | `epicTaskUtils.ts` |
| `git add -A` + `git commit` | `ensureWorkingTreeCommitted` (in finalize) | `epicTaskUtils.ts` |
| `git diff ...` | `captureGitDiff` (in finalize) | `epicTaskUtils.ts` |
| `git push` + `gh pr create` | `autoCreateStagePr` (when stage completes) | `epicTaskUtils.ts` |
| Write summary file `task-<id>-summary.md` | `finalizeEpicTaskExecution` (§7.3) | `epicTaskTools.ts:436` |
| Write any `.md`/`.txt` to session workspace | filesystem MCP `write_file` / SDK `Write` (instrumented) | hooks in `instrumentFsWriteTools` / `agentSdkBuiltinHooks` |
| DB: `agent_tasks.status` flip | `updateTaskStatus` (in finalize) | `epicTaskUtils.ts` |
| DB: `task_stages.status` derived flip | `propagateStatus` (in finalize) | `epicTaskUtils.ts` |
| DB: `epic_tasks.status` derived flip | `propagateStatus` | `epicTaskUtils.ts` |
| DB: `task_executions` insert | `startExecution` (in `start_epic_task`) | `epicTaskUtils.ts` |
| DB: `task_executions` complete/fail | `completeExecution` / `failExecution` | `epicTaskUtils.ts` |
| DB: next sibling task → `ready` | `advanceNextTaskInStage` (success only) | `epicTaskUtils.ts` |
| DB: first task of next stage → `ready` | `advanceNextStageReadyTasks` (PR approval / plan auto-clear) | `epicTaskUtils.ts` |
| BullMQ: `epic_codex_finalize_followup` | detached Codex run finishes | `enqueueEpicPostCodexFinalizeTurn` |
| BullMQ: `epic_pr_continuation` | PR approved | `EpicTaskService.handlePrApproval` |
| BullMQ: `epic_pr_review_retry` | PR rejected | `EpicTaskService.handlePrChangesRequested` |
| Socket: `agent:reply` | every turn end | `agentChat.worker → emitAgentReply` |
| Socket: `agent:typing` | turn start | `agentChat.worker → emitAgentTyping` |

---

## 11. The per-task pause flow, end-to-end

Putting all the above together for the most important flow:

### 11.1 Anthropic, sub-agent fan-out

1. User says "start the epic" (or the orchestrator naturally calls
   `start_epic_task` after the user approves the plan).
2. **Turn N enters** `epicCallModelNode`.
3. Vendor resolves to `anthropic` → §4 branch.
4. `runAnthropicAgentSdk` spawns the SDK subprocess.
5. Inside SDK: model emits `start_epic_task({ assignments: [...] })`
   tool call.
6. SDK calls our in-process MCP server, which calls
   `StartAnthropicEpicTaskTool` handler. Side effects: branch sync,
   task → `in_progress`, snapshot HEAD, execution row created.
7. Tool returns instruction text. SDK relays it to the model as a
   `tool_result`.
8. Model emits an assistant message with N parallel `Task("<id>",
   "<scope>")` calls.
9. SDK runs those N sub-agents concurrently. Each sub-agent has its
   own MCP server, tools, prompt, model. They edit files in `cwd`,
   commit locally.
10. Each sub-agent returns its final text. SDK relays each as a
    `tool_result`. Model now has all N results.
11. Model emits `complete_epic_task({ summary, status: "completed" })`.
12. SDK calls our in-process MCP server →
    `finalizeEpicTaskExecution`:
    - auto-commit leftover changes
    - capture diff
    - write `task_executions` row with metadata
    - flip task status (`updateTaskStatus`) + propagate
    - write `task-<id>-summary.md`
    - build `[📎 ...](url)` markdown
    - **`advanceNextTaskInStage(task.id)`** — flip next sibling to
      `ready`, rest stay `pending`
    - `appendContinuationMarker` returns `""` (tasks remain)
13. Tool returns text containing heading + summary + attachment block
    + pause hint. Relayed to model as `tool_result`.
14. Model emits a final assistant message: a brief progress update
    with the attachment markdown pasted verbatim. **No more tool
    calls** (per the pause hint).
15. SDK emits a `result` event. Runner exits the for-await loop.
16. **Turn N exits** `epicCallModelNode` with `{ messages: [...],
    sessionFiles: [...] }`.
17. Worker calls `emitAgentReply` → user sees the assistant message
    with a clickable summary attachment.
18. **Chat pauses.** No queue push, no continuation. The next ready
    task in the stage is sitting at `ready` waiting for the user.
19. User says "continue" (or "next task", etc.). New turn begins.
    Orchestrator calls `start_epic_task` again. Loop repeats from
    step 2.

### 11.2 Anthropic, direct execution (no sub-agents)

Same as 11.1 except step 5–10 are different:

5. Model emits `start_epic_task({})` (empty assignments) or omits
   `assignments` entirely.
6–7. Same as before, but the instruction text says "do it yourself".
8. Model uses its own bound tools directly: `mcp__<filesystem>__read_file`,
   `Bash` for `git status`, `mcp__<filesystem>__write_file`, etc.,
   across multiple tool rounds inside the same SDK loop.
9. Model emits `complete_epic_task({ summary })`.
10–19. Identical to 11.1.

### 11.3 Codex

Different shape because the run is detached:

1. User says "start the epic".
2. **Turn N enters** `epicCallModelNode`. Vendor → `openai`. §5 branch.
3. `runOpenAiCodexSdk` spawns the Codex subprocess.
4. Model emits `start_epic_task_codex({})`.
5. Tool: branch sync, mark task `in_progress`, snapshot HEAD,
   create execution row with `codex_run_in_flight: true`, **fork the
   detached IIFE**, return immediately with "Codex is running detached."
6. Model emits a closing message: "Started task X via Codex; will
   update when finalize completes."
7. **Turn N exits** with that message. User sees "Started task X..."
8. Time passes. The detached IIFE continues running Codex in the
   background.
9. Codex finishes. The IIFE awaits → calls
   `finalizeEpicTaskExecution`: auto-commit, capture diff, write
   `task-<id>-summary.md`, advance next task in stage (sequential),
   etc. Same side-effects as 11.1 step 12.
10. IIFE calls `enqueueEpicPostCodexFinalizeTurn(...)`. Body =
    heading + summary + attachment + pause hint. Pushed to BullMQ.
11. Worker pulls the synthetic system message. New chat job.
12. **Turn N+1 enters** `epicCallModelNode`. The "user" message this
    turn is the synthetic system body.
13. Model emits a closing assistant message that pastes the
    attachment markdown verbatim and writes a brief progress update.
    **No tool calls** — it has been told not to start the next task.
14. **Turn N+1 exits** with `{ messages: [...] }`.
15. Worker → `emitAgentReply` → user sees the attachment.
16. **Chat pauses.** Same waiting state as 11.1 step 18.
17. User says "continue". Orchestrator calls `start_epic_task_codex`
    again. Loop repeats from step 2.

---

## 12. Failure modes & how the node degrades

| Scenario | Where it surfaces | What the user sees |
|---|---|---|
| `state.error` set by a prior node | Top of `epicCallModelNode` (§1.1) | Worker emits an error reply with the prior error text. |
| `systemPrompt` missing | §1.2 | Error reply: "No system prompt assembled..." |
| Vendor not configured | `resolveOrgVendor` (§2) | Error reply: `Unknown model "<slug>" or agent has no organization.` |
| Org has no API key for vendor | §2 | Error reply: `Your organization has not configured an API key for <vendor>.` |
| MCP server fails to spawn | `getMcpTools` (§3.1) | Logged as warning; the tool just isn't bound. Model may complain mid-loop. |
| Anthropic SDK loop hits `max_turns` | `runAnthropicAgentSdk` (§4.3.5) | State patch carries `error: "Too many tool calls..."`. Worker emits error reply. |
| SDK subprocess crashes | runner stderr → captured into outer error | Error reply with truncated stderr text. |
| `start_epic_task` rejects assignments | inside the tool handler | Tool returns an error string. Model usually retries with corrected input within the same loop. |
| `finalizeEpicTaskExecution` git diff fails | inside finalize | Logged warning; metadata fields are absent but the task still flips to `completed`. |
| Summary file write fails | finalize (§7.3 step 5) | Logged warning; `attachmentMarkdown` becomes `null`. Tool result still returned, just without the link. |
| Detached Codex run crashes | Codex IIFE catch block | `finalizeEpicTaskExecution` is invoked with `status: "failed"`, then `enqueueEpicPostCodexFinalizeTurn` posts the failure summary the same way. The orchestrator gets a "Task X failed: ..." follow-up. |
| Worker dies mid-turn | BullMQ requeues based on retry policy | The task may be left at `in_progress` with the snapshot SHA preserved on the execution row. Recovery: `reset_stuck_task` tool. |

---

## 13. Configuration knobs that affect this flow

| Knob | Where it lives | Effect |
|---|---|---|
| `MAX_TOOL_ROUNDS` | `callModel.ts:88` (constant `30`) | Caps the SDK loop turns + the legacy LangChain loop rounds. |
| `agent_available_tools` rows | DB | Decides which slug-gated tools (§3.6) are bound. `create_epic_plan` presence is also what triggers the epic-orchestrator skill auto-injection. |
| `agent_available_mcp_servers` rows | DB | Decides which MCP servers are spawned. |
| `claude_sub_agent` rows owned by this primary | DB | Populates `subAgents:` for the SDK, enabling `Task()` fan-out. |
| `agents.allow_sdk_builtins` | DB | Whether SDK built-in `Read`/`Write`/etc are exposed. |
| `agents.allow_sdk_bash` | DB | Whether SDK `Bash` is exposed. |
| `agents.use_anthropic_web_search` | DB | Whether SDK `WebSearch` is exposed. |
| Vendor key in org settings | DB | Without one, the node short-circuits with an error. |
| Per-thread session workspace path | `state.sessionWorkspacePath` (set by `contextBuilder`) | Determines where summary files + ledger writes land. |

---

## 14. Cheat sheet: "what does the orchestrator do at moment X?"

- **At entry**: validate state, resolve vendor, build the tool list,
  pick a runtime branch.
- **Inside the SDK loop**: the model alternates between assistant
  turns and tool calls until it produces a final text or hits the
  cap. Tool calls run synchronously inside the loop; sub-agent
  `Task()` calls run concurrently inside the SDK's process.
- **When `start_epic_task` is called**: bookkeeping only — fast DB
  writes + a `git rev-parse`. Returns instructions, no real work.
- **Between `start_epic_task` and `complete_epic_task`**: the model
  either dispatches `Task()` calls (sub-agent fan-out) or directly
  uses filesystem MCP / Bash tools (direct path). Either way, work
  happens inside the same SDK loop.
- **When `complete_epic_task` is called**: capture diff, write
  summary file, build attachment URL, advance next sibling task
  → `ready`, return text with attachment + pause hint.
- **When `start_epic_task_codex` is called**: same bookkeeping as
  Anthropic, then forks a detached IIFE and returns "running
  detached" immediately. The model writes a brief "started" reply;
  turn ends.
- **When the detached Codex run finishes**: server-side calls
  `finalizeEpicTaskExecution` then enqueues a follow-up system
  message. The orchestrator wakes for a brand-new turn that just
  emits a closing message with the attachment. No tools called.
- **At exit**: state patch returned. Worker emits `agent:reply`.
  No auto-continuation between tasks (per-task pause). Stage-level
  PR approval/rejection still trigger a one-task auto-continuation
  via `EpicTaskService`.

---

## 15. File / function index

| Symbol | File | Role |
|---|---|---|
| `epicCallModelNode` | `apps/agent_service/src/graphs/epicGraph/nodes/callModel.ts` | The node itself. |
| `resolveOrgVendor` | `apps/agent_service/src/utils/resolveOrgVendor.service.ts` | Vendor + key lookup. |
| `getMcpTools` | `apps/agent_service/src/mcpClient/index.ts` | Spawn + wrap MCP servers. |
| `instrumentFsWriteTools` | `apps/agent_service/src/workspace/instrumentFsWriteTools.ts` | Extension gate + ledger capture. |
| `loadActiveToolSlugs` | `apps/agent_service/src/tools/resolveAgentTools.ts` | Per-agent tool grants. |
| `buildSubAgentDefinitions` | `apps/agent_service/src/utils/buildSubAgentDefinitions.service.ts` | Translate `claude_sub_agent` rows → SDK `AgentDefinition`s. |
| `runAnthropicAgentSdk` | `apps/agent_service/src/chat/anthropic/agentSdkRunner.ts` | Anthropic SDK runner. |
| `runOpenAiCodexSdk` | `apps/agent_service/src/chat/codex/codexSdkRunner.ts` | Codex SDK runner. |
| `StartAnthropicEpicTaskTool` | `apps/agent_service/src/tools/epicTaskTools.ts` (~681) | Anthropic `start_epic_task`. |
| `StartEpicTaskCodexTool` | `apps/agent_service/src/tools/epicTaskTools.ts` (~1282) | Codex `start_epic_task_codex`. |
| `CompleteEpicTaskTool` | `apps/agent_service/src/tools/epicTaskTools.ts` (~919) | Anthropic `complete_epic_task`. |
| `finalizeEpicTaskExecution` | `apps/agent_service/src/tools/epicTaskTools.ts` (~373) | Shared finalize: diff, summary, attachment, advance next task. |
| `enqueueEpicPostCodexFinalizeTurn` | `apps/agent_service/src/tools/epicTaskTools.ts` (~497) | Push system follow-up to BullMQ after detached Codex run. |
| `appendContinuationMarker` | `apps/agent_service/src/utils/epicTaskUtils.ts` (~1454) | Returns `""` between tasks (per-task pause); PR/plan text at stage end. |
| `parseContinuationMarker` | `apps/agent_service/src/utils/epicTaskUtils.ts` (~1579) | Defensive fallback; reads the legacy marker if anything emits one. |
| `advanceNextTaskInStage` | `apps/agent_service/src/utils/epicTaskUtils.ts` | Sequential-within-stage helper. |
| `advanceNextStageReadyTasks` | `apps/agent_service/src/utils/epicTaskUtils.ts` | First-task-of-next-stage helper. |
| `drainSessionFileLedger` | `apps/agent_service/src/workspace/sessionWorkspace.ts` | Pop captured FS writes for this turn. |
| `agentChat.worker` | `apps/agent_service/src/worker/agentChat.worker.ts` | BullMQ consumer; runs the graph; calls `emitAgentReply`. |
| `emitAgentReply` | `apps/agent_service/src/socket.ts` (121) | Socket.IO emit to the user's chat UI. |
| `EpicTaskService` | `apps/agent_service/src/services/epicTask.service.ts` | PR webhook handlers; enqueue stage-level continuation. |
