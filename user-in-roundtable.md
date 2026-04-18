User-in-the-Loop Roundtable
Problem
Currently roundtables are fully autonomous — agents talk to each other in round-robin with no human input. The user wants an option to include themselves as a participant in the roundtable, getting a dedicated turn in each round (with a 5-minute timer) to type their own contribution.

Architecture Overview
The roundtable turn flow is:

user_app creates Roundtable + RoundtableAgents → calls agent_service /api/roundtable/start
    → BullMQ enqueues first turn job
    → Worker processes turn (LangGraph invoke) → saves message → emits via socket
    → Worker determines next turn → enqueues next job (round-robin)
    → After all rounds → generates summary → marks completed
The critical insight: the user's turn cannot be processed by the BullMQ worker because it requires waiting for user input from the browser. Instead, the worker must pause when it's the user's turn, emit a socket event to tell the frontend "it's your turn", and then the frontend submits the user's input via a new API endpoint that resumes the queue.

Proposed Changes
DB: Roundtable Model
[MODIFY] 
Roundtable.ts
Add includeUser: boolean column (default false)
[NEW] Migration
Add include_user boolean column to roundtables table
Backend: user_app service
[MODIFY] 
roundtable.service.ts
Accept includeUser param in create(), persist it on the roundtable row
Pass includeUser flag when calling agent_service's /api/roundtable/start
[MODIFY] 
roundtable.controller.ts
Pass req.body.includeUser to create()
Add new endpoint: POST /admin/roundtables/:id/user-turn that accepts the user's text and forwards it to agent_service
Backend: agent_service
[MODIFY] 
roundtableContextBuilder.ts
The "### Participants" section currently lists only agents (`agentOrder`). When `includeUser` is true, introduce the participating user as a first-class participant so every agent sees them in the roster — same as the current `**(you)**` treatment for the speaking agent.
Specifically:
- Extend `roundtableConfig` in `AgentState` with `includeUser: boolean` and `participantUser: { id: UserId; displayName: string; userIdentity: UserIdentity | null } | null`.
- The worker loads the user row (`User.findByPk(roundtable.createdBy)`) once when starting the roundtable and threads `participantUser` through every turn's config.
- In the context builder, after the agent loop that prints participants, append one line for the user, e.g.:
  `- ${participantUser.displayName || "The user"} — human participant (contributes at the end of each round)`
- Add a short paragraph under "### Discussion guidelines" (only when `includeUser` is true):
  "A human participant is in this roundtable. Address them by name when relevant, react to their input just as you would another agent's, and remember they speak last in each round."
[MODIFY] 
roundtable.worker.ts
In the "determine next turn" logic (line 225+):
After all agents have spoken in a round, if includeUser is true, don't enqueue the next round immediately
Instead, emit roundtable:user_turn via socket and update the roundtable status to waiting_for_user
The queue pauses — no more jobs until user submits
[MODIFY] 
roundtable.routes.ts
Add POST /api/roundtable/user-turn endpoint:
Receives { roundtableId, content, userId }
Validates that `userId === roundtable.createdBy` (only the roundtable's owner-participant can submit)
Saves user's message as a RoundtableMessage with `agentId: null, userId: <userId>, roundNumber: <current>`
Enqueues the next round's first agent turn
Emits `roundtable:message` with the user's content, including `senderType: "user"`, `userId`, and `displayName` so the frontend can render it with user styling and so downstream agents loading message history can correctly attribute it
[MODIFY] 
roundtable.bull.ts
No structural changes needed — the queue just won't have a new job until the user submits
DB: RoundtableMessage Model
[MODIFY] 
RoundtableMessage.ts
Make `agentId` nullable (AgentId | null) — a user message has no agent.
Add `userId: UserId | null` — nullable FK to `users.id`. Populated when a message is authored by the participating user; null for agent messages.
Invariant (enforced at the service layer, optionally via a CHECK constraint): exactly one of `agentId` / `userId` is non-null on any given row.
Add `RoundtableMessage.belongsTo(User, { foreignKey: "userId", as: "user" })` alongside the existing Agent association so message rows can be loaded with sender identity in one query.
[NEW] Migration
Alter `roundtable_messages`:
- `agent_id` → allowNull: true
- Add column `user_id` (INTEGER, nullable, FK → users.id)
- (Optional) Add CHECK constraint: `(agent_id IS NOT NULL) <> (user_id IS NOT NULL)`
IMPORTANT

Using a nullable `user_id` FK (not just nullable `agent_id`) is the requested shape — it *identifies* the participating user on every user-authored message, so joins to the users table are trivial and we never have to guess "which user spoke" from context. The participating user is the roundtable's `createdBy` (see below) — we do not add a separate participant column on the Roundtable row because the creator IS the participant.

Frontend
[MODIFY] 
api/index.ts
Add includeUser to createRoundtable() payload
Add submitUserTurn(roundtableId: string, content: string) API call
Add includeUser to RoundtableSummary type
[MODIFY] 
RoundtablePage.tsx
Create form (RoundtableListView):

Add a toggle/switch: "Include yourself in the discussion"
Pass includeUser: true when creating
Detail view (RoundtableDetailView):

Listen for new socket event roundtable:user_turn → activate "Your Turn" input panel
Show a 5-minute countdown timer when it's the user's turn
Show a text input area with a submit button
On submit: call submitUserTurn() API, clear input, timer stops
On timeout (5 min): auto-submit a skip message or auto-submit whatever they typed
User messages render differently from agent messages — resolve the sender from `message.userId` (load `displayName` from the users table or reuse the current session user), and show a "You" badge when `message.userId === currentUser.id`, otherwise show the participant's displayName (future-proofs the detail view for the case where a non-owner viewer watches the roundtable)
User Turn UX Flow
All agents speak in round N
    │
    ├─ includeUser = false → continue to round N+1
    │
    └─ includeUser = true →
         Worker emits "roundtable:user_turn" socket event
         Worker sets roundtable.status = "waiting_for_user"
         Frontend shows input panel + 5min timer
              │
              ├─ User submits text → POST /user-turn → message saved → next round starts
              │
              └─ Timer expires → auto-submit skip text → next round starts
Open Questions
IMPORTANT

User turn position: Should the user always go last in each round (after all agents), or should they be insertable at any position in the turn order? Going last is simpler and more natural (user responds after hearing all agents). Planning for "last" unless you say otherwise.

IMPORTANT

Timer expiry behavior: When the 5-minute timer runs out, should we:

A) Auto-submit whatever text they've typed so far (even if empty → "User did not respond")
B) Skip the user's turn silently and continue
C) Show a "Time's up!" prompt and give them 30 more seconds?
Verification Plan
Automated Tests
npx tsc --noEmit on both user_app/client and agent_service
Manual Verification
Create roundtable WITHOUT user → verify it works exactly as before (no regression)
Create roundtable WITH user → verify:
User turn input appears after all agents speak in round 1
Timer counts down from 5:00
Submitting text saves it as a message and resumes agent turns
User's message renders with distinct styling (not an agent bubble)
Timer expiry auto-submits
Final summary includes user contributions