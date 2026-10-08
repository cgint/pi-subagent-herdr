# agent-end-pane-reminders — idea

Date: 2026-10-08 · Status: idea (pre-scoping) · Owner: Firstmate (user owns requirements)

## One-liner

At the end of an agent run, remind the LLM which Herdr panes are still open (owned vs. in-flight vs. stale) so it can decide, before returning to the user, which panes to `subagent_close` and which to `subagent_wait` / `subagent_read`.

## Problem

The subagent-herdr extension spawns worker panes (`subagent_start`) and tracks them in
`OwnedState` / `SubagentService.getOwned()` (`core.ts` line ~446). But nothing tells the
*driving* agent, at the moment it is about to hand control back to the user, which of the
panes it spawned are still open. Two failure modes:

1. **Leaked panes:** agent finishes its work and returns to the user, leaving worker panes
   running. User later notices stray panes; ownership records linger in the session.
2. **Premature return:** agent declares a delegated task done even though the worker pane is
   still `working` / `blocked`. It should have `subagent_wait`ed or `subagent_read` first.

The user wants the LLM itself to make the keep/close/wait decision at the handoff moment,
not an automatic closer (we do **not** want to silently auto-close).

## Key findings (verified 2026-10-08)

### Hook choice: `agent_end` + `pi.sendMessage(steer, triggerTurn)`

- `agent_end` handler return type is `void` — it can only do side effects. It **cannot**
  directly append to LLM context or force a turn by itself.
- The working injection path (proven by sibling `pi-self-reflect`, `src/index.ts:276`) is:
  in the `agent_end` handler, call
  `pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" })`.
  This queues a steering message and forces one more LLM turn, in which the agent sees the
  injected content and can act on it.
- `agent_before_settle` is the other candidate: it returns `BoundaryResult =
  { entries?: SessionBoundaryDraft[]; continue?: boolean }` and can atomically append a
  `custom_message` entry and request a continuation. **But** the `canContinue` gate
  (`agent-session.js:600-620`) requires that the last LLM message is *not* a bare
  `assistant` message, **or** that a queued/pending custom message exists. Appending an
  `entries` draft with `display:false` counts as `pendingCustomContext` and flips
  `canContinue` true, so it is viable — but if you return `continue:true` *without* an
  entry and the last message is a final assistant text, it is rejected
  (`_reportInvalidBoundaryContinuation`).

### Data available at settle time

- `service.getOwned()` → `[{ pane_id, session?, ... }]` (in-memory, per `OwnedState` in
  `index.ts`). Cheap, no I/O.
- `getOwned()` does **not** carry live status. To know in-flight vs. done you must call
  `subagent_read` / `subagent_list` per pane (Herdr CLI, N calls).
- `getOwned()` is only pruned on explicit `subagent_close` (`core.ts` lines 899, 2726, 2737
  — all `pane_not_found`-driven). A pane closed **externally** (bash/herdr directly) stays
  in the owned map → the reminder could reference a stale pane. A live `subagent_read`
  returns `pane_not_found` for dead panes and can prune/filter them.

## Design forks (hook + trigger + status source resolved 2026-10-08; see Decisions)

1. **Hook:** *Resolved:* **Option A** — `agent_end` + `pi.sendMessage(steer, triggerTurn)`
   (proven `pi-self-reflect` idiom; robust to the `canContinue` gate). Option B
   (`agent_before_settle` `{entries, continue}`) dropped — the `canContinue` gate is a
   maintenance burden for no real gain. Rationale: see Decisions.
2. **Trigger scope:** *Resolved (2026-10-08, lead decision):* fire whenever **any** owned
   pane is still open — busy OR done-but-not-closed. A done/idle pane that was never closed
   is exactly the leak this feature exists to surface; an in-flight-only trigger would miss
   the most common leak. The LLM then decides per pane (wait / read / close).
3. **Status source:** *Resolved (2026-10-08, lead decision):* in-memory `getOwned()` for
   the **trigger** (cheap, no I/O). Bounded live `subagent_read`/`list` per owned pane is
   an optional enrichment for the reminder text ("pane X is working" vs. "pane X is idle")
   and for pruning stale records — not required to decide whether to remind.

## Loop / safety constraints (required in any implementation)

- **Loop guard (simplified):** an injected reminder re-triggers `agent_end`, so one
  "already reminded this turn" latch is required — a flag set when the reminder fires,
  reset only on genuine user input (not on the extension's own steer). This is sufficient;
  a `pi-self-reflect`-style `consecutiveAutoContinues` counter is overkill for this use case.
- **No-op fast path:** if `getOwned()` is empty, do nothing (zero latency, zero messages).
- **Non-destructive:** reminder only; it never auto-closes or auto-waits. The LLM decides.

## Unverified (empirical, before any build)

- Whether `agent_end`+`sendMessage(steer,triggerTurn)` actually fires a continuation turn on
  the live host (Pi 1.0.0 / Herdr 0.9.3). Inferred from SDK source + sibling repo, **not yet
  run here**. Suggested: 5-line spike extension to observe one fired turn.

## Decisions (2026-10-08)

- **Hook: Design A** — `agent_end` + `pi.sendMessage(steer, triggerTurn)`.
  *Design B (`agent_before_settle`) dropped:* the `canContinue` gate (`agent-session.js`) is
  a maintenance burden for no real gain, and the A path is already proven by `pi-self-reflect`.
- **Trigger scope:** any open owned pane (see fork #2 above).
- **Status source:** in-memory `getOwned()` for the trigger; live read optional enrichment
  (see fork #3 above).

## Candidate designs

- **Design A (chosen):** `agent_end` + `sendMessage(steer, triggerTurn)`, fire on any open
  owned pane, in-memory trigger with optional bounded live-status enrichment, one-shot
  latch per user turn, no-op when `getOwned()` is empty.
- **Design B (dropped):** via `agent_before_settle` `{entries, continue}` — rejected, see
  decisions above.
- **Design C (fallback):** no LLM turn at all — just a footer/status line
  (`ctx.ui.setStatus`) listing open panes, letting the *user* (not the LLM) decide. Cheapest,
  but does not satisfy the "let the AI decide" requirement.

## Re-entry guide (2026-10-08)

If you're resuming this feature in a fresh session, here is the exact state:

### What was done in this session

- Read and verified the Pi SDK event/hook system: `agent_end` (void return),
  `agent_before_settle` (BoundaryResult with `entries` + `continue`),
  `before_agent_start` (message injection, `systemPromptOptions`), `turn_end` (BoundaryResult),
  `sendMessage` (steer/followUp/nextTurn + triggerTurn), `sendUserMessage` (always triggers).
- Read `pi-self-reflect` (sibling repo) as reference: uses `agent_end` +
  `pi.sendMessage(buildSteeringMessage(...), { triggerTurn: true, deliverAs: "steer" })`.
  Has `consecutiveAutoContinues` counter, `MAX_AUTO_CONTINUES`, resets on user `input`.
  This is a proven working pattern for this exact use case on this host.
- Confirmed `getOwned()` in `core.ts` line ~446: in-memory `Map<string, OwnedRecord>`.
  Pruned only on `subagent_close` with `pane_not_found`. NOT pruned on external close.
  No status field — only `pane_id`, `workspace_id`, `session`, `launched_at`, `pending`.
- Confirmed `subagent_read` / `subagent_list` in `core.ts` can provide live status.
- Confirmed `session_shutdown` in `index.ts:752` already warns about remaining panes
  (visible notification only, no LLM involvement).
- No `agent_end` or `agent_before_settle` handler exists in the current extension.

### What needs to happen next

1. **Spike (do first):** Write a minimal spike extension that does exactly one thing:
   on `agent_end`, call `pi.sendMessage({customType:"test", content:"PING from agent_end",
   display:false}, {triggerTurn:true, deliverAs:"steer"})` and verify the LLM actually
   gets a new turn. Confirm it does NOT infinite-loop (add a one-shot guard). This is the
   single most important thing to verify before any real implementation.

2. **Design decision (needs user input):** Which of the three forks to take:
   - Hook: `agent_end`+sendMessage (A) vs `agent_before_settle`+continue (B)
   - Trigger: only in-flight panes vs any owned pane
   - Status: live read (accurate, costs N CLI calls) vs in-memory (fast, may be stale)

3. **Implementation:** Modify `index.ts` to add the hook. The handler will:
   - Call `ensureService(ctx)` to get the service
   - Call `service.getOwned()` — if empty, return (no-op)
   - Optionally: for each owned pane, call the service's read/list to get live status
   - Build a compact reminder message (pane ID, name, status, recommendation)
   - Inject via the chosen mechanism (sendMessage or BoundaryResult)
   - Set/clear the per-turn latch

4. **Loop guard:** Track how many auto-continues have happened since the last user input.
   Reset on `input` event where `source !== "extension"`. Cap at 1 (or 2).
   Without this, the reminder fires every agent_end → infinite loop.

5. **Verification:**
   - Unit test: mock service with owned panes, verify message content and trigger flag
   - Unit test: verify loop guard (second agent_end does NOT re-inject)
   - Unit test: verify no-op when no owned panes
   - Integration: run pi with extension, spawn a subagent, verify reminder appears
   - Live: run on real host, confirm the LLM actually sees and acts on the reminder

### Key file references

- `index.ts` — where the new `pi.on("agent_end", ...)` handler goes
- `core.ts` — `SubagentService.getOwned()` (line ~514), `SubagentService.list()` (line ~2595)
- `core.ts` — `OwnedRecord` type (line ~186): `{pane_id, workspace_id, session?, launched_at?, pending?}`
- `core.ts` — `close()` method (line ~2710): shows how pruning works
- `pi-self-reflect/src/index.ts:276` — the proven `agent_end` + `sendMessage` pattern
- `pi-self-reflect/src/steering.ts` — `buildSteeringMessage()` for message shape reference
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` — all event types
- `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1417-1434` —
  `agent_before_settle` handling (the `canContinue` gate logic)

### Gotchas / traps

- `agent_end` handler return value is `void` — you CANNOT return `{continue:true}` from it.
  You MUST use `pi.sendMessage()` or `pi.sendUserMessage()` to inject.
- `agent_before_settle` `continue:true` without entries → rejected if last msg is assistant.
  You MUST include an entry (e.g., a `custom_message` with `display:false`) alongside `continue`.
- `sendMessage` with `triggerTurn:true` in `agent_end` — the steer message lands in the
  steering queue. The session loop will pick it up and start a new turn. This is the
  mechanism `pi-self-reflect` relies on. NOT YET VERIFIED on this exact host version.
- The `input` event fires for ALL inputs including extension-generated ones.
  The `source` field distinguishes user input from extension injections.
  Use `event.source` to avoid resetting the loop guard on extension-generated messages.
- `session_shutdown` in `index.ts:752` already warns about remaining panes
  (visible notification only, no LLM involvement). The new reminder is a *complement*,
  not a replacement.
