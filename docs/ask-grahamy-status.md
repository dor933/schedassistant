# Ask Grahamy — Implementation Status (Handoff for Future Models)

**Last updated:** 2026-04-29
**Scope:** the Ask Grahamy answer pipeline inside `apps/agent_service`. NOT the BFF (`StocksScanner/Web/server`) or the React UI (`StocksScanner/Web/client`).

This doc is the source of truth for what's shipped, how it's wired, what to be careful about, and what comes next. Read it before touching `apps/agent_service/src/askGrahamy/*`.

---

## 1. The end-to-end flow (so you don't re-derive it)

```
React Analyze page (StocksScanner/Web/client/src/components/pages/Analyze/index.tsx)
   ↓ POST /ask/stream  (SSE)
Express BFF (StocksScanner/Web/server/src/services/ask.service.ts)
   ↓ axios.post  →  http://agent_service:3001/api/application/ask-grahamy
schedassistant agent_service
   apps/agent_service/src/routes/application.routes.ts
   ↓
   askGrahamy/http.ts  →  handleAskGrahamy
   ↓
   askGrahamy/graph.ts  →  runAskGrahamyGraph
       1. loadConversationContext       (per-conversation memory, userId-scoped)
       2. classifyIntent                (LLM-based — see §3)
       3. fetchBaseSnapshots            (from grahamy-client-api at :8766)
       4. selectTools / executeTools
       5. loadResearchObjects           (PG queries → cached in Redis)
       6. compilePublicResearchView     (allowlist projection — see §4)
       7. generateAnswerObject          (institutional answer renderer — see §5)
       8. moatGuard                     (final allowlist enforcement)
       9. persist conversation context
```

The BFF is request/response. It fakes streaming for the UI by emitting SSE frames (`open`, `meta`, `complete`, `done`) around a single synchronous JSON response from agent_service. The client paces a typer animation locally — there are no `delta` events.

---

## 2. What was wrong before this work

1. **Classifier was pure regex** (only matched `$TICKER`, UPPERCASE tokens, a hardcoded sector alias list, regime keywords). Anything natural-language (`"what about nvidia?"`) → `intent: unknown` → blocked clarification answer.
2. **Research Object SQL templates were not mounted** into the `agent_service` container. Every Research Object lookup ENOENT'd and fell through to a generic snapshot-only answer. Both warnings (`Research Object query failed for X` and `No stock snapshot context for X`) had this single root cause.
3. **`buildStockSummary` extracted only ~11 surface fields** from a `parts.core` payload that already contained ~8 rich sub-objects (trajectory, regime_context, company_state, event_context, analog_evidence_self, plus financialQuality and sectorAggregates). The downstream answer template rendered 3 generic bullets.

All three are fixed.

---

## 3. LLM-based classifier (`askGrahamy/classification.ts`)

### Wiring
- Replaces the regex classifier entirely.
- Uses `ChatOpenAI` from `@langchain/openai`, model **`gpt-4o`**, with `withStructuredOutput` against a Zod schema.
- API key resolved via **`resolveOrgVendorByOrg(modelSlug, ASK_GRAHAMY_ORG_ID)`** — the same DB-backed pattern (`organization_vendor_api_keys`) used by every other call-model node in the service. **Do not** re-introduce `process.env.ANTHROPIC_API_KEY` / `OPENAI_API_KEY` reads here; that bypasses the per-org key model.

### Defaults (overridable via env)
- `ASK_GRAHAMY_CLASSIFIER_MODEL` → defaults to `gpt-4o`
- `ASK_GRAHAMY_ORG_ID` → defaults to `acf0cbab-3aed-42cf-872d-63cba24e61c3` (the platform org with the OpenAI key registered for the public Ask Grahamy endpoint)

### Schema
```ts
{ intent, symbols[], sectors[], regimeRequested, isFollowUp, confidence }
```
- `intent` is constrained to the same `INTENTS` enum as the rest of the system.
- `sectors` is constrained to the canonical Yahoo-style set + `"Semiconductors"`.

### Post-processing rules (do not remove)
1. **Self-anchored short-circuit** — if `isFollowUp=true` AND the message names a symbol/sector/regime, treat as self-anchored and DON'T require prior context. Returns `isFollowUp: false` so downstream sees a clean turn.
2. **Follow-up + prior context** — fill missing symbols/sectors/regime from `previousContext.lastSymbols/lastSectors/lastIntent`.
3. **Follow-up + no prior context + no anchors in message** → `intent: "follow_up"`, low confidence, warning. The UI shows the clarification copy.
4. **LLM throws** → safe fallback `intent: "unknown"` with warning `"Classifier unavailable — please retry."` Logged via Winston.

### Test seam
- `ClassifyOptions.classifier` lets unit tests inject a stub. Default invoker is module-level lazy.
- `RunAskGrahamyGraphOptions.classifier` propagates the seam into `runAskGrahamyGraph` so `graph.test.ts` runs without a live LLM.

### Conversation context is per-conversation, NOT per-user-globally
- Store keyed by `conversationId` with a `userId` ownership check (`conversationStore.ts:19-25` rejects cross-user reads).
- BFF passes `conversationId` when one exists. New conversations start clean — that's the right shape for the sidebar UX in `Analyze/index.tsx`.

---

## 4. Public Research View compiler (`askGrahamy/researchObjectBuilder.ts`)

### MOAT principles (enforce on every change)
1. **No peer symbol names** anywhere in the public projection or the answer text. Aggregate counts and percentile buckets only.
2. **No raw hit rates, no raw median outcomes, no raw composite percentiles, no raw VIX or yields.** Bucket everything via the helpers below.
3. **No pipeline internals.** `parts.core / parts.financialQuality / parts.sectorAggregates` stay server-only — only the `publicSummary` projection leaves the box.
4. **Allowlist first**, not "remove what's dangerous". If you don't deliberately project a field, it doesn't appear.

### Bucket helpers (consistent across stock/sector/regime)

| Helper | Input | Buckets |
|---|---|---|
| `bucketHitRatePct` | percentage 0–100 | `STRONG (≥60) / CONSTRUCTIVE (≥52) / MIXED (≥45) / WEAK (<45)` |
| `bucketMedianOutcomePct` | percentage | `CONSTRUCTIVE (≥5) / MIXED (≥0) / WEAK (<0)` |
| `bucketPercentileRank` | 0–100 | `TOP_QUARTILE / ABOVE_MEDIAN / BELOW_MEDIAN / BOTTOM_QUARTILE` |
| `bucketSampleAdequacy` | sample size | `ROBUST (≥50k) / ADEQUATE (≥5k) / THIN (≥500) / INSUFFICIENT (<500)` |

User-confirmed thresholds. Don't change without explicit approval.

### Stock summary fields produced (`buildStockSummary`)
- Identity: `symbol`, `company`, `sector`, `asOfDate`
- Regime: `regime`, `vixBand`, **`regimeFit`** (ALIGNED/CHALLENGED/UNCERTAIN — derived from `own_stock_by_regime` hit-rate vs. avg of other regimes), `regimeShiftDetected`
- `eventUrgency` (e.g. `WITHIN_5_DAYS`)
- `evidenceBadge`, `evidenceCount`, `convergence`
- `peerRankPercentile` — quartile bucket only
- **`activeSignals[]`** — `{ family, signalStrength, evidenceLanguage }`. Signal families currently fired: `Trajectory`, `Quality`, `Capital Allocation`, `Catalyst`. **These are PG-derived, NOT pipeline-validated edges** — see §7 for the Phase 2 plan.
- **`forwardPerformance`** — bucketed h60 hit-rate + outcome + sample adequacy. No raw percentages.
- **`fundamentalsSnapshot`** — `marketCapTier / growthProfile / financialQualityBand / balanceSheetBand / peerRankPercentile`. All buckets.
- `upcomingEvents[]` — earnings + ex-div with bucketed windows.
- `invalidationSignals[]` — derived from regime hit-rate gap, sector-relative perf, earnings proximity, interest-coverage stress.
- `whyNow` — composed prose using top signal + regime fit + catalyst proximity.

### Sector summary fields (`buildSectorSummary`)
- Identity + `asOfDate`
- Backdrop: `regime`, `vixBand`, `sp500PerfBand`
- Breadth: `symbolsCovered`, `industries`, `leaderCount`, `laggardCount` — **counts only, no named leaders/laggards**.
- Historical baseline: `unconditionalHitRateBucket`, `unconditionalOutcomeBucket`, `sampleAdequacy`
- Regime conditioning: `bestRegimeForSector`, `bestRegimeBucket`, `currentRegimeBucket`, `currentRegimeBelowBest`
- `favorableConditions[]` / `unfavorableConditions[]` — qualitative phrases like `"RISK_OFF + low RSI + high P/E"`. Raw hit rates / median %s NOT exposed.
- `whyNow`

### Regime summary fields (`buildRegimeSummary`)
- Identity + `asOfDate`, `isCurrentRegime`
- Backdrop: `vixBand`, `sp500PerfBand`, `tenYearYieldBand`
- Historical baseline (bucketed): `unconditionalHitRateBucket`, `unconditionalOutcomeBucket`, `longHorizonHitRateBucket`, `sampleAdequacy`
- Sector conditioning under this regime (top 3 / bottom 3 by hit-rate, **bucketed**, sector names only)
- `sectorsActiveToday`, `topSectorsTodayRank` (top 3 sector names by today's leadership rank — symbols hidden)
- `leaderCount` (count only)
- `whyNow`

---

## 5. Institutional answer renderers (`askGrahamy/answerTemplates.ts`)

`generateAnswerObject` switches into the institutional layout when a Research Object of the matching type exists in `researchView.researchObjects`. Otherwise it falls back to the legacy generic builders (`buildHeadline / buildBullets / buildSummary`) — that fallback is **kept on purpose** for snapshot-only paths where SQL queries fail.

### Renderers
- `renderInstitutionalStockAnswer` — Active signals / Forward perf / Fundamentals / Catalysts / Invalidation watchpoints.
- `renderInstitutionalSectorAnswer` — Historical baseline / Regime conditioning / Favorable conditions / Breadth / Regime-sensitivity watchpoints.
- `renderInstitutionalRegimeAnswer` — Historical baseline / Sectors that work / Sectors that struggle / Today's snapshot / Watchpoints.
- `renderInstitutionalMixedAnswer` — composes the three above into one answer with `### Stock — X` / `### Sector — Y` / `### Regime — Z` section headers. Watchpoints deduped, prioritized stock → sector → regime.

### Switching logic at the top of `generateAnswerObject`
```
if answerType==="stock"  AND has stock RO   → renderInstitutionalStockAnswer
if answerType==="sector" AND has sector RO  → renderInstitutionalSectorAnswer
if answerType==="regime" AND has regime RO  → renderInstitutionalRegimeAnswer
if answerType==="mixed"  AND has any RO     → renderInstitutionalMixedAnswer
otherwise → legacy generic path (snapshot-only fallback)
```

### UI cards
Each renderer emits structured cards (`stock_summary`, `sector_summary`, `regime_summary`, `market_regime`) so the FE can lay them out as panels. The cards carry the same buckets as the bullets — keep them in sync.

---

## 6. Operational state

### Container
The running `schedassistant-agent_service-1` has the new compiled JS files **`docker cp`'d in** — they survive restarts but **NOT** a clean `docker compose build`. To bake:
```bash
cd /home/office/Dev/schedassistant
docker compose build agent_service
docker compose up -d --no-deps agent_service
```

### `docker-compose.yml` changes already made (committed to file, NOT yet rebuilt)
1. Bind mount for SQL templates so the container can read them at runtime:
   ```yaml
   - /home/office/.openclaw/shared-tools/grahamy/queries:/home/office/.openclaw/shared-tools/grahamy/queries:ro
   ```
   Without this, `researchQueryClient.ts` ENOENTs on every Research Object query. Don't remove.

### Redis cache
- Research Objects are cached at `ask-grahamy:research-object:{TYPE}:{ANCHOR}:{DATE}` with a per-day key.
- After changing `buildStockSummary` / `buildSectorSummary` / `buildRegimeSummary`, **flush the relevant keys** or you'll keep serving the old projection until the date rolls over:
  ```bash
  docker exec schedassistant-redis-1 redis-cli --scan --pattern 'ask-grahamy:research-object:*' | \
    xargs -r docker exec -i schedassistant-redis-1 redis-cli DEL
  ```

### Test command
```bash
cd /home/office/Dev/schedassistant/apps/agent_service
LOG_DIR=/tmp/ag-svc-test-logs node --test --test-reporter=spec \
  dist/askGrahamy/classification.test.js dist/askGrahamy/graph.test.js
```
- `LOG_DIR` override is necessary because the default logger path (`/app/data/logs/agent_service`) is container-only.
- 8 tests should pass: 7 classifier tests with stubbed LLM + 1 graph e2e with mocked snapshots.

### Smoke testing the live endpoint (from inside the container)
```bash
CN=$(docker ps --format '{{.Names}}' | grep agent_service)
docker exec "$CN" sh -c 'wget -qO- \
  --post-data="{\"userId\":\"smoke\",\"message\":\"how is apple doing\"}" \
  --header="Content-Type: application/json" \
  http://localhost:3001/api/application/ask-grahamy'
```

---

## 7. What's NOT done — the Phase 2 Epic

Per the planning doc at `/home/office/grahamy-gui-plan (1).txt` (sections "Agentic AI Architecture" and onward), Phase 2 is a separate, larger build:

### 7.1 Pipeline adapter
The current `activeSignals[]` (Trajectory / Quality / Capital Allocation / Catalyst) are **PG-derived**, not pipeline-validated edges. The plan calls for:
- A pipeline → PG join on `asset_key` so the Research Object can carry true `tier` (HIGH_CONVICTION / CORE / EMERGING / SPECULATIVE) and `convergence` count.
- Pipeline-validated `active_edges[]` with `family`, `signal_strength`, `regime_aligned`, `evidence_language`. These would supersede or augment the PG-derived signals we ship today.

The publicSummary already has placeholders for `evidenceCount` and `convergence` — when Phase 2 wires real values, downstream just consumes them.

### 7.2 Conversation memory — Δ since last ask
The plan describes a 3-layer memory model:
1. Short-term — current conversation (already partially handled by `conversationStore.ts`).
2. Session-level — user preferences, sectors of interest, past research questions.
3. Long-term — research state Δ ("since you last asked about NVDA the regime shifted from RISK_ON to NEUTRAL").

Today only layer 1 exists, and only as `lastSymbols / lastSectors / lastIntent`. Layers 2 and 3 are unimplemented. The plan suggests storing these in a PG `agent_sessions`-style table, NOT in the LLM context.

### 7.3 Agentic tool layer (the 9 tools from the plan)
Today's graph runs deterministic snapshot tools. The plan calls for an agentic loop where the LLM picks tools based on intent:
1. `get_research_object(symbol)` — already implicitly done via `loadResearchObjects`
2. `get_market_context()` — already done via snapshots
3. `get_peer_comparison(symbol, n=5)` — NOT done; currently the peer detail comes from `sectorAggregates.portfolio_context` and we hide names by policy
4. `get_sector_landscape(sector)` — partial; we have sector RO data but not a "find me dominant peers" path
5. `get_historical_analogs(symbol, top_k=3)` — NOT done; data is in `parts.core.analog_evidence_self`
6. `get_event_calendar(symbol?, sector?, days_ahead=30)` — NOT done; only earnings_proximity bucket exists
7. `search_stocks_by_criteria(criteria)` — NOT done; would require a parametric query layer over PG (the plan calls this "Rung 2 — Parametric flexibility")
8. `get_invalidation_check(symbol)` — partial; we already derive `invalidationSignals[]` deterministically
9. `compare_stocks(symbols[])` — NOT done

The plan is explicit: the LLM **never writes raw SQL** — all data access goes through these tool functions. Whitelist-only.

### 7.4 Homepage-wide aggregate endpoints
Plan §"Homepage" calls for:
- `GET /api/homepage/screening` returning an array of Public Research View slices, sorted by tier/convergence/regime_fit.
- `GET /api/research/{symbol}` returning the full Public Research View for one symbol.

Today the Research Objects are produced per-request inside `runAskGrahamyGraph`. They're not exposed as standalone endpoints. The Homepage likely runs on mock data still — verify before assuming.

---

## 8. Footguns / things to be careful about

1. **Cache before code.** If you change a publicSummary field, flush Redis. Otherwise you'll smoke-test against yesterday's cached projection and chase phantom bugs.
2. **The fallback path is intentional.** When SQL fails or no Research Object loads, we fall through to the generic builders. Don't delete them — the snapshot-only path is the safety net.
3. **Don't widen the public projection without a MOAT review.** Anything you add to `publicSummary` is by default visible to the user. Match every new field against the plan's allowlist.
4. **`firstStringValue` was removed** from the stock summary path. If you see lingering references in older diffs, ignore them.
5. **The classifier uses an OpenAI key registered to `acf0cbab-…`.** That org must keep that key valid. The Anthropic key on the same org is also configured but currently unused (and was out of credit when we tested earlier). If you switch the model, switch the vendor check too (`vendor.vendorSlug !== "openai"` guard in `classification.ts`).
6. **Mixed-turn composer reuses the three single-anchor renderers.** If you change a renderer's output shape, the mixed answer follows automatically — but also test mixed turns explicitly because section trimming logic lives only in the composer.
7. **Sector "Semiconductors" returns mostly-empty data** because the underlying SQL likely matches Yahoo standard sector names (`"Technology"`). If a user asks about Semiconductors, the answer's sector section will be sparse. This is data-side, not a code bug.
8. **Tests need `LOG_DIR=/tmp/ag-svc-test-logs`** when run on the host because the default logger path is `/app/data/logs/agent_service` (container-only). Tests inside the container don't need it.
9. **`process.env.GRAHAMY_QUERIES_DIR`** can override the default queries path. The compose mount uses the same default path so the env var stays unset; if you change one, change both.

---

## 9. Files of interest (TL;DR map)

| Concern | File |
|---|---|
| Live entry point | `apps/agent_service/src/routes/application.routes.ts` |
| HTTP handler | `apps/agent_service/src/askGrahamy/http.ts` |
| Graph orchestration | `apps/agent_service/src/askGrahamy/graph.ts` |
| **LLM classifier** | `apps/agent_service/src/askGrahamy/classification.ts` |
| Per-org key resolver | `apps/agent_service/src/services/resolveOrgVendor.ts` |
| Snapshot client (grahamy-client-api) | `apps/agent_service/src/askGrahamy/snapshotClient.ts` |
| **Public Research View compiler** | `apps/agent_service/src/askGrahamy/researchObjectBuilder.ts` |
| **Institutional answer renderers** | `apps/agent_service/src/askGrahamy/answerTemplates.ts` |
| Conversation context store | `apps/agent_service/src/askGrahamy/conversationStore.ts` |
| MoatGuard (final allowlist enforcement) | `apps/agent_service/src/askGrahamy/moatGuard.ts` |
| SQL templates location | `/home/office/.openclaw/shared-tools/grahamy/queries/` (host) — bind-mounted into container |
| Plan source of truth | `/home/office/grahamy-gui-plan (1).txt` |
| BFF layer | `StocksScanner/Web/server/src/services/ask.service.ts` |
| React UI | `StocksScanner/Web/client/src/components/pages/Analyze/index.tsx` + `client/src/api/ask.ts` |

---

## 10. One-line summary

**Phase 1 is shipped.** Stock / sector / regime / mixed turns all render institutional-grade answers from the Research Object data, with strict MOAT enforcement (no peer symbols, no raw stats). **Phase 2 is the agentic tool layer + pipeline adapter + cross-conversation memory** — separate Epic, untouched by this work.
