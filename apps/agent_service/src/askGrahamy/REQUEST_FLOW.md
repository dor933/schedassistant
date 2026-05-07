# Ask Grahamy — Request Flow

End-to-end trace of one `POST /api/ask-grahamy` turn, from the moment the
client-app hits the route through to the JSON envelope returned to the
caller. Every numbered step lists the file/symbol that owns it so you can
jump straight to the source.

---

## 0. Network → Express router

Inbound request: `POST /api/ask-grahamy` with header
`x-application-agent-token` and body
`{ userId, conversationId?, message, classification }`.

1. `server.ts` mounts the router at `/api/ask-grahamy`.
2. `routes/askGrahamy.routes.ts` applies `requireApplicationToken`
   middleware to every method on the router, then dispatches `POST /` to
   `AskGrahamyController.ask`.

### 0a. `requireApplicationToken` (middleware/requireApplicationToken.ts)

- Reads `process.env.APPLICATION_AGENT_API_TOKEN`. **Fail-closed**: if
  the env var is missing or empty, the request is rejected `401`.
- Compares the env value to the `x-application-agent-token` header
  (string-equal). Any mismatch → `401 Unauthorized`.
- On match: `next()`.

### 0b. `AskGrahamyController.ask` (controllers/askGrahamy.controller.ts)

- `askGrahamyRequestSchema.safeParse(req.body)` (Zod). Missing/empty
  `userId`, `message`, or `classification` -> `400` with a *safe error envelope*
  (`buildSafeErrorEnvelope`). The envelope is an `AskGrahamyResponse`
  with `answerType: "error"` and a generic safe answer — the upstream
  caller never has to special-case error responses.
- On valid body: calls `runAskGrahamyForExternalUser(parsed.data)`.
- On `result.ok === true`: `200` with `result.response`.
- On `result.ok === false`: `result.status` with safe envelope.
- On any thrown error: `500` with safe envelope.

---

## 1. `runAskGrahamyForExternalUser` (services/askGrahamy.service.ts)

This is the service-level adapter between "external client app user" and
"internal `users.id`".

1. **Resolve the singleton client_application** via
   `resolveDefaultClientApplication()` (utils/clientApplicationUser.service.ts):
   - Looks up `process.env.DEFAULT_CLIENT_APPLICATION_ID` and fetches the
     `client_applications` row.
   - If env var missing or row missing → returns `{ ok: false, status: 500 }`.
2. **JIT-resolve the upstream user → internal users.id** via
   `resolveOrCreateClientUser({ clientApplication, externalUserId: request.userId })`:
   - `findOrCreate` on `users` keyed by `(clientApplicationId, externalSub)`.
   - On first sight, creates a row with `auth_provider='client_app'`,
     `password=null`, deterministic `userName = "<slug>:<externalUserId>"`,
     `displayName = "grahamy_app_user_<externalSub>"` (overrideable).
   - On subsequent calls, opportunistically refreshes `displayName` /
     `externalMetadata` / `externalSyncedAt` if the caller passed fresher
     metadata. Otherwise zero writes.
   - Returns the `User` Sequelize row.
3. **Run the graph** with the canonical internal id:
   `runAskGrahamyGraph(request, user.id)`.
4. Wraps the call in try/catch. On throw → returns
   `{ ok: false, status: 500, error: message }`.
5. On success → `{ ok: true, response }`.

---

## 2. `runAskGrahamyGraph` (askGrahamy/graph.ts)

This is the LangGraph orchestrator entry point.

1. **Accept supplied classification / prior objects** (StocksScanner
   pre-flight contract). `classification` is required on `request`:
   - `classification` — produced by `/api/ask-grahamy/classify`.
   - `priorResearchObjects` — treat as cache hits, avoid rebuild.
   - `priorCapabilityViews` — treat as cache hits for pg capabilities.
2. **Build initial `AskGrahamyState`** (typed in `types.ts`):
   ```
   { internalUserId, conversationId, message, warnings: [], classification,
     priorResearchObjects?, priorCapabilityViews? }
   ```
3. **Stamp identifiers**:
   - `state.conversationId ||= crypto.randomUUID()` — used as
     PostgresSaver `thread_id` inside the deep agent.
   - `state.messageId = crypto.randomUUID()`.
4. **Wrap the rest in `observeWithContext("ask_grahamy_turn", ...)`**
   (langfuse.ts) — opens a parent OTel/Langfuse span around the graph
   invocation. No-op when `LANGFUSE_*_KEY` env is not set.
5. **Build the LangGraph state envelope** `AskGrahamyGraphState`
   (askGrahamyState.ts) by merging `AskGrahamyState` with graph-only
   fields: `options`, `snapshotClient`, `plannerHandled`.
6. **Get a Langfuse callback handler** for the LangChain runtime (so each
   LangGraph node and any nested LLM call inside emits child spans).
7. **Invoke the compiled workflow**:
   `compiledAskGrahamyWorkflow.invoke(graphState, { callbacks: [handler] })`.
8. After the workflow returns:
   - If `finalState.response` is set → return it (happy path).
   - If not but `finalState.error` exists → wrap in `Error` and call
     `finalizeSafeGraphError(...)` to synthesize a safe envelope.
   - On any thrown error → also `finalizeSafeGraphError(...)`.

The graph itself never throws into this caller in the normal path — the
`safeErrorResponse` node catches per-node errors. The catch here is the
last-resort net for compile/invoke failures.

---

## 3. The LangGraph workflow (askGrahamy/graph.ts + nodes/)

State annotation lives in `askGrahamyState.ts`
(`AskGrahamyGraphAnnotation`). Routing uses two helpers:

- `routeAfterNode(state)` → `"next" | "error"` based on whether
  `state.error` was set.
- `routeAfterResearchPlanner(state)` → `"plannerHandled" | "standardLoaders" | "error"`.

Every node is wrapped in `runGraphNode(...)` (askGrahamyState.ts), which:
- Short-circuits to `{}` if `state.error` is already set (so a failure
  upstream skips all downstream work).
- Catches throws and returns `{ error: errorMessage(err) }`, which the
  next conditional edge routes to `safeErrorResponse`.

The full edge map (graph.ts):

```
START
  → requireClassification
  → fetchBaseSnapshots
  → selectTools
  → executeTools
  → researchPlanner
        ├─ plannerHandled → compileEvidence
        └─ standardLoaders → loadResearchObjects
                              → loadPgCapabilities
                              → loadPipelineOverlays
                              → compileEvidence
  → buildAnswer
  → buildMeta
  → finalizeResponse
  → END

(any node error) → safeErrorResponse → END
```

### 3.1 `requireClassificationNode` (nodes/requireClassification.ts)

Requires `state.classification` to already be populated by
`/api/ask-grahamy/classify`. If it is missing, the node returns an error and
the graph routes to `safeErrorResponse`; the graph does not call
`classifyMessage`.

The supplied classification contains:
- `intent` — one of the 30+ enum values (sector_conviction_leaderboard,
  stock_idea_discovery, factor_conditioned_backtest, comparison, etc.).
- `symbols`, `sectors`, `regimeRequested`, `isFollowUp`, `focus?`,
  `featureCriteria?`, `factorBacktest?`, `requiresTools`,
  `confidence`, `warnings`.

### 3.2 `fetchBaseSnapshotsNode` (nodes/fetchBaseSnapshots.ts)

Calls `snapshotClient.fetchPublishedSnapshots()`
(`GrahamySnapshotClient`, snapshotClient.ts). Wrapped in
`observeToolCall("fetch_published_snapshots", ...)`.

The snapshot client fans out fetches for: `daily_brief`, `metadata`,
`clusters`, `track_record`, `transparency` from
`GRAHAMY_AGENTS_BASE_URL`. Returns a `SnapshotBundle` with per-name
`errors: {}`, `latencyMs: {}`, and a `freshness` summary.

If `snapshots.freshness.staleReason` is set, push it to `state.warnings`.

### 3.3 `selectToolsNode` (nodes/selectTools.ts)

Pure: `state.selectedTools = state.classification?.requiresTools ?? []`.

`requiresTools` comes from the classifier and lists which snapshot tools
the next node should run.

### 3.4 `executeToolsNode` (nodes/executeTools.ts)

Calls `executeSnapshotTools(state.selectedTools, state.snapshots,
state.classification)` (tools.ts).

Each iteration in `executeSnapshotTools` is wrapped in its own
`observeToolCall("<tool_name>", args, ...)` so each shows up as a
separate Langfuse span:
- `get_market_context` — extracts regime/vix/edges/etc. from the
  daily_brief + transparency snapshots.
- `get_stock_snapshot_context(symbols)` — per-symbol slice of
  daily_brief + track_record signals.
- `get_sector_snapshot_context(sectors)` — sector landscape derived from
  the snapshots.
- `get_homepage_focus_context` — homepage-style focus list.

Output written to `state.toolOutputs`. These outputs are *evidence
inputs* — they feed the deep agent's system prompt later.

### 3.5 `researchPlannerNode` (nodes/researchPlanner.ts)

This is the conditional fork.

1. Check `shouldRunResearchPlanner(state.message, classification)`. If
   the message doesn't pattern-match an approved compound research
   workflow, return `false` → route to `standardLoaders`.
2. Pick the proposer:
   `options.researchPlanProposer ?? proposeResearchPlan`. The proposer
   asks the LLM (via the agent stack) to draft a plan. Wrapped in
   `observeToolCall("propose_research_plan", ...)` and
   `withPlannerTimeout(..., 10s default)`.
   - Timeout / proposer failure → fall back to
     `buildFallbackResearchPlan(message)` (a deterministic shape match
     against `RESEARCH_WORKFLOW_REGISTRY`). If no fallback exists, throw.
3. `validateResearchWorkflow(plan)`:
   - If invalid AND we used the default proposer, retry validation with
     the deterministic fallback plan.
   - Still invalid → push a user-facing warning and return
     `false` (standard path).
4. Pick the executor:
   `options.researchPlanExecutor ?? executeResearchPlan`. Wrapped in
   `observeToolCall("execute_research_plan", ...)`.
5. The executor runs the plan, optionally invoking
   `researchObjectBuilder`, `pgCapabilityRunner`,
   `pipelineOverlayRunner` (test seams default to real impls). It
   returns an `execution` packet with `pgCapabilityViews`,
   `pipelineOverlayViews`, `researchObjects`, cache stats, and a
   `workflowExecutionResult`.
6. If `execution.handled === false` → push warnings, return `false`
   (standard path).
7. Otherwise: merge results into state, set
   `state.workflowExecutionResult`, set `state.compoundResearchContext`,
   and return `true` → route to `plannerHandled` (skip the standard
   loaders, go straight to `compileEvidence`).
8. Any throw is caught: push a generic compound-research warning, return
   `false`.

### 3.6 Standard-path loaders (only when `plannerHandled === false`)

#### 3.6a `loadResearchObjectsNode` (nodes/loadResearchObjects.ts)

- If `classification.focus === "validated_evidence"` → empty out and
  return (no research objects in this mode).
- Otherwise call `buildResearchObjects(...)`
  (researchObjectBuilder.ts), wrapped in
  `observeToolCall("build_research_objects", ...)`.
- Builder synthesizes `CachedResearchObject[]` from the
  classification + snapshots + tool outputs, reusing
  `priorResearchObjects` as cache.
- Sets `state.researchObjects`, `state.researchObjectsUpdated`, and
  `state.researchObjectCacheStats`. Pushes any warnings.

#### 3.6b `loadPgCapabilitiesNode` (nodes/loadPgCapabilities.ts)

- Calls `executePgCapabilitiesWithCache(input, priorCapabilityViews,
  runner)` (pgCapabilities/registry.ts). Wrapped in
  `observeToolCall("execute_pg_capabilities", ...)`.
- The registry decides which capability SQL views to run based on
  intent + message — sector_leaderboard, sector_divergence,
  sector_delta, stock_idea, feature_screen, factor_backtest,
  comparison, regime_historical_playbook.
- Sets `state.pgCapabilityViews`, `capabilityViewsUpdated`,
  `capabilityViewCacheStats`. Pushes warnings.

#### 3.6c `loadPipelineOverlaysNode` (nodes/loadPipelineOverlays.ts)

- Calls `executePipelineOverlays(input)` (pipelineOverlays/registry.ts),
  wrapped in `observeToolCall("execute_pipeline_overlays", ...)`.
- Currently produces `validatedEdgeEvidenceView` when the classification
  asks for validated-evidence overlays.
- Sets `state.pipelineOverlayViews`. Pushes warnings.

### 3.7 `compileEvidenceNode` (nodes/compileEvidence.ts)

Both paths (planner-handled and standard) converge here.

1. **Compile a public-facing research view** via
   `compilePublicResearchView({...})` (publicResearch.ts). This is the
   filtered, citation-friendly view that ships back to the client in
   `response.research.publicResearchView`. It hides internal scaffolding
   (raw snapshots, internal thresholds, etc.) and keeps only what the
   answer can quote.
2. **Build the evidence pack**:
   - If `state.workflowExecutionResult` is set (planner ran) →
     `buildEvidencePackFromWorkflowExecution(...)` (workflowEvidencePack.ts).
   - Otherwise → `buildEvidencePack(state)` (analystOrchestration.ts).
3. **Build the analyst-brief contract**:
   `buildAnalystBriefContract(evidencePack)` (analystOrchestration.ts) —
   the schema/structure the brief must satisfy.

### 3.8 `answerNode` / `buildAnswer` (nodes/answer.ts)

Two answer paths depending on whether the planner ran:

#### Planner-handled path (`state.workflowExecutionResult` is set)

1. Re-derive `evidencePack` if missing.
2. Pick the synthesizer:
   `options.analystBriefSynthesizer ?? synthesizeAnalystBriefFromEvidencePack`
   (analystBriefSynthesizer.ts). Wrapped in
   `observeToolCall("synthesize_analyst_brief", ...)`.
3. The synthesizer asks the LLM to fill the `AnalystBrief` contract from
   the evidence pack and the user's message.
4. `renderAnalystBriefToAnswer(synthesis.brief)`
   (analystBriefRenderer.ts) → produces:
   - `answer` — `{ headline, summary, bullets, watchpoints, disclaimer }`.
   - `ui` — `{ cards, tables, suggestedFollowups }`.

#### Standard path (no planner)

1. Pick the agent runner:
   `options.grahamyAgentRunner ?? runGrahamyDeepAgent`
   (grahamyAgent.ts). Wrapped in
   `observeToolCall("grahamy_deep_agent", ...)`.
2. `runGrahamyDeepAgent(state)`:
   - Resolves the model via `resolveGrahamyModel()` (org-scoped key).
   - Builds the system prompt from the state's evidence (snapshots,
     research objects, capability views, etc.).
   - Creates a `createDeepAgent({ model, tools: [], systemPrompt,
     checkpointer })` — uses **PostgresSaver** keyed by
     `thread_id = "grahamy:<conversationId>"`. Conversation memory is
     handled by the saver, NOT by a separate JSON store.
   - Attaches its own Langfuse callback handler so the deep agent's
     LangGraph emits nested generation spans under the parent
     `tool: grahamy_deep_agent` span.
   - `withTimeout(agent.invoke(...), GRAHAMY_TIMEOUT_MS)` → final AI
     message text.
   - `parseAgentResponse(text)` splits the markdown on a
     "Suggested follow-ups" header into `answerText` and
     `suggestedFollowups`.
   - On error: returns a safe error string, no follow-ups, and a warning.
3. The node converts the returned `{ answerText, suggestedFollowups,
   warnings }` into:
   - `answer` — headline=`""`, `summary=answerText`, `bullets=[]`,
     `watchpoints=[]`, `disclaimer=DEFAULT_DISCLAIMER`.
   - `ui` — `cards=[]`, `tables=[]`, `suggestedFollowups`.

### 3.9 `buildMetaNode` (nodes/buildMeta.ts)

Calls `buildMeta(...)` (also exported from this file) which assembles
`ResponseMeta`:
- `sourcesUsed` — `researchObjects.cacheKey` entries plus per-pg-capability
  and pipeline-overlay names. Snapshots are deliberately *not* listed
  here (they're scaffolding, not citations).
- `freshness` — copied from `snapshots.freshness`.
- `warnings` — deduped union of `state.warnings`,
  `classification.warnings`, and snapshot fetch errors.
- `toolsUsed` — the snapshot tool list.
- `researchObjectKeys`, `researchObjectCache`, `researchObjectsUpdated`.
- `capabilityViewKeys`, `capabilityViewCache`, `capabilityViewsUpdated`.
- `upstreamLatency` — `snapshots.latencyMs`.

### 3.10 `finalizeResponseNode` (nodes/finalizeResponse.ts)

Calls `finalizeResponse(state)`. Steps:

1. Derive `meta` (use `state.meta` if buildMeta already ran; otherwise
   recompute as a safety net).
2. Construct `AskGrahamyResponse`:
   ```
   { conversationId, messageId, answerType, classification, answer,
     research: { publicResearchView }, ui, meta }
   ```
   `answerType` is computed via `inferAnswerType(classification)` from
   the classification's `intent` (and falls back to symbol/sector/regime
   shape when intent is generic).
3. **Run moat guard** via `runMoatGuard(response)` (moatGuard.ts):
   - Recursively scrubs strings that match a denylist of internal
     terms (internal_threshold, threshold_rule, sql, query text,
     pipeline implementation details, etc.).
   - Returns `{ value, result: "clean" | "cleaned" | "failed", warnings }`.
4. Merge guard warnings into `meta.warnings` (deduped) and stamp
   `meta.moatGuardResult`.
5. Log the completed turn with `logger.info("Ask Grahamy turn completed", ...)`.
6. Return the guarded response — this becomes `finalState.response`.

### 3.11 `safeErrorResponseNode` (nodes/safeErrorResponse.ts)

Reached whenever any prior node set `state.error`.

Calls `finalizeSafeGraphError(state, new Error(state.error))` which:
1. Logs the failure (`logger.error("Ask Grahamy graph failed", ...)`).
2. Replaces `state.answer` with `buildSafeErrorAnswer()` (a generic safe
   message + the standard disclaimer).
3. Defaults missing pieces (`classification = EMPTY_CLASSIFICATION`,
   `publicResearchView = EMPTY_PUBLIC_RESEARCH_VIEW`, empty `ui`).
4. Builds `meta` with the warnings list plus
   `"Ask Grahamy failed before a safe answer could be completed."`.
5. Calls `finalizeResponse(state, "error")` — runs moat guard, logs,
   returns the guarded envelope.

The result is set on `state.response`, the graph reaches `END`.

---

## 4. Back in `runAskGrahamyGraph` (graph.ts)

After `compiledAskGrahamyWorkflow.invoke(...)` resolves:

- `finalState.response` set → return it. (Happy path or
  `safeErrorResponse` produced it.)
- `finalState.response` missing but `finalState.error` set → wrap in
  `Error`, call `finalizeSafeGraphError(...)` to synthesize an envelope.
- `finalState.response` missing and no error → defensive
  `"Ask Grahamy graph completed without a response."` error +
  `finalizeSafeGraphError(...)`.

`observeWithContext` then closes the `ask_grahamy_turn` parent span and
flushes Langfuse. The final `AskGrahamyResponse` returns to the service.

---

## 5. Back in `runAskGrahamyForExternalUser` (services/askGrahamy.service.ts)

- Returned response → wrap in `{ ok: true, response }`.
- Throw → log, wrap in `{ ok: false, status: 500, error: message }`.

---

## 6. Back in `AskGrahamyController.ask` (controllers/askGrahamy.controller.ts)

- `result.ok === true` → `res.status(200).json(result.response)`.
- `result.ok === false` →
  `res.status(result.status).json(buildSafeErrorEnvelope(...))`.
- Any uncaught throw → `res.status(500).json(buildSafeErrorEnvelope(...))`.

The response shape returned to the client is always a full
`AskGrahamyResponse`:

```
{
  conversationId,
  messageId,
  answerType,                  // "stock" | "sector" | "regime" | "mixed" | "unknown" | "error"
  classification,
  answer: { headline, summary, bullets, watchpoints, disclaimer },
  research: { publicResearchView },
  ui: { cards, tables, suggestedFollowups },
  meta: {
    sourcesUsed, freshness, warnings, toolsUsed,
    researchObjectKeys?, researchObjectCache?, researchObjectsUpdated?,
    capabilityViewKeys?, capabilityViewCache?, capabilityViewsUpdated?,
    upstreamLatency, moatGuardResult
  }
}
```

---

## Cross-cutting concerns

### Persistence

- **Conversation memory** lives in PostgresSaver inside the deep agent,
  keyed by `thread_id = "grahamy:<conversationId>"`. There is no
  separate JSON conversation store; follow-up resolution is the agent's
  natural memory recall.
- **Research-object caching** is in-DB; `priorResearchObjects` from the
  request are treated as cache hits. Updates flow back via
  `researchObjectsUpdated` so the upstream caller can persist them.
- **Capability-view caching** mirrors the same pattern via
  `priorCapabilityViews` / `capabilityViewsUpdated`.

### Observability (Langfuse)

- One parent span per turn: `ask_grahamy_turn`
  (`observeWithContext` in `runAskGrahamyGraph`).
- LangChain `CallbackHandler` attached to the LangGraph invoke → each
  node + nested LLM call gets a child generation/chain span
  automatically.
- Per-operation `observeToolCall` spans:
  `fetch_published_snapshots`, the four snapshot
  tools, `propose_research_plan`, `execute_research_plan`,
  `build_research_objects`, `execute_pg_capabilities`,
  `execute_pipeline_overlays`, `synthesize_analyst_brief`,
  `grahamy_deep_agent`.
- The deep agent attaches its own callback handler internally, so its
  inner LangGraph turns nest under the parent
  `tool: grahamy_deep_agent` span.
- Everything is no-op when `LANGFUSE_SECRET_KEY` /
  `LANGFUSE_PUBLIC_KEY` are unset.

### Error handling layers (defense in depth)

1. **Per-node**: `runGraphNode` traps throws → sets `state.error` →
   conditional edge routes to `safeErrorResponse`.
2. **`safeErrorResponse` node**: synthesizes a safe envelope via
   `finalizeSafeGraphError`.
3. **`runAskGrahamyGraph` try/catch**: handles graph compile/invoke
   failures and any state where the workflow ended without producing a
   response.
4. **Service**: try/catch around `runAskGrahamyGraph` for top-level
   throws.
5. **Controller**: try/catch around the service call, plus Zod schema
   guard, plus a final `buildSafeErrorEnvelope` so the client *always*
   receives a structurally-valid `AskGrahamyResponse`.

### Moat guard

Every successful response goes through `runMoatGuard` in
`finalizeResponse` — it scrubs strings matching the denylist of
internal-terminology regexes and stamps `meta.moatGuardResult`
(`clean` / `cleaned` / `failed`). Scrubbing is silent to the user;
detection is recorded in telemetry.
