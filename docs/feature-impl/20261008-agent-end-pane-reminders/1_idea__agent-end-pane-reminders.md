# agent-end-pane-reminders — idea

Date: 2026-10-08 · Status: idea (pre-scoping) · Owner: Firstmate (user owns requirements)

> Re-validated against current SDK source on 2026-05-02 — see
> `4_revalidation_20260502__agent-end-pane-reminders.md` (corrected alternatives, cost
> framing, new Spike B / measure-the-leak options).
>
> **Scope (settled 2026-05-02):** this feature is **`pi-self-reflect`'s mechanism applied
> to panes — and nothing else.** A bounded, guarded, conditional steer at `agent_end`
> that brings up the agent's own sub-agent panes so the agent makes the keep/close/wait
> decision it would otherwise skip. No workspace-scope redesign, no decision-authority
> reassignment, no completion/skipped-wait gate. See
> `2_requirements__agent-end-pane-reminders.md` → *Scope*.
>
> **Research findings (2026-05-02):** `5_research_sdk`, `5_research_selfreflect`,
> `5_research_core`, `5_research_crosscheck` — SDK mechanics, the exact self-reflect guard/
> reset pattern, core.ts data shapes + gaps, and a cross-check of these docs. **Open
> question OQ4** (who fetches the live status: the driving LLM vs the extension) is settled
> neither here nor in 1_idea; it lives in `2_requirements` → *Open questions*.

## One-liner

At the end of an agent run, bring up (via a `pi-self-reflect`-style bounded steer) a live
picture of the agent's own sub-agent panes — so that **before returning to the user** the
agent makes the keep/close/wait decision it owes itself instead of skipping it. The agent
is not auto-acting on the user's behalf; it gets the picture and then acts with its normal
authority. The user remains the override authority, as in any normal agentic flow.

## Problem

The subagent-herdr extension spawns worker panes (`subagent_start`) and tracks them in
`OwnedState` / `SubagentService.getOwned()` (`core.ts`). But nothing tells the
*driving* agent, at the moment it is about to hand control back to the user, which of the
panes it spawned are still open. Two failure modes:

1. **Leaked panes:** agent finishes its work and returns to the user, leaving worker panes
   running. User later notices stray panes; ownership records linger in the session.
2. **Premature return:** agent declares a delegated task done even though the worker pane is
   still `working` / `blocked`. It should have `subagent_wait`ed or `subagent_read` first.

The user wants the agent, **at the handoff moment before it returns control**, to actually
make the keep/close/wait decision on its own sub-agent panes — instead of narrating intent
and returning without having decided. The feature is the `pi-self-reflect`-style bounded
steer that brings the pane picture up at that moment, so the decision happens (the agent
then acts with its normal authority; the user remains the override authority).

## Key findings (verified 2026-10-08)

### Hook choice: `agent_end` + `pi.sendMessage(steer, triggerTurn)`

- `agent_end` handler return type is `void` — it can only do side effects. It **cannot**
  directly append to LLM context or force a turn by itself.
- The working injection path (proven by sibling `pi-self-reflect`, search `agent_end` +
  `sendMessage` in `src/index.ts`) is:
  in the `agent_end` handler, call
  `pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" })`.
  This queues a steering message and forces one more LLM turn, in which the agent sees the
  injected content and can act on it.
- `agent_before_settle` is the other candidate: it returns `BoundaryResult =
  { entries?: SessionBoundaryDraft[]; continue?: boolean }` and can atomically append a
  `custom_message` entry and request a continuation. **But** the `canContinue` gate
  the `canContinue` gate (`agent-session.js`, search `canContinue`) requires that the last
  LLM message is *not* a bare
  `assistant` message, **or** that a queued/pending custom message exists. Appending an
  `entries` draft with `display:false` counts as `pendingCustomContext` and flips
  `canContinue` true, so it is viable — but if you return `continue:true` *without* an
  entry and the last message is a final assistant text, it is rejected
  (`_reportInvalidBoundaryContinuation`).

### Data available at settle time

- `service.getOwned()` → `[{ pane_id, session?, ... }]` (in-memory, per `OwnedState` in
  `index.ts`). Cheap, no I/O. **Identity only — no live status, no liveness flag.** Use it as
  a pre-filter, not the trigger.
- `getOwned()` does **not** carry live status. The live list (`subagent_list` → `list()` in
  `core.ts`) carries per-pane `agent_status` (raw: working/blocked/idle/done/"unknown") and an
  `owned` boolean computed in the wrapper. See 5_research_core for the exact fields and cost
  (2 Herdr CLI calls/workspace, or per-pane `read returnLines:0`).
- `getOwned()` is only pruned on explicit `subagent_close` (`core.ts` — search
  `owned.delete`). A pane closed **externally** stays in the owned map → **owned ≠ live-open**.
  The trigger must therefore gate on the live list (owned ∧ appears-in-list), not on
  `getOwned().length`. This is the stale-removal bug the feature fixes (2_requirements R5/R6).

## Design forks (hook + trigger + status source — see 2_requirements; this section lags the 2026-05-02 settlement and is superseded where it conflicts)

1. **Hook:** *Resolved:* **Option A** — `agent_end` + `pi.sendMessage(steer, triggerTurn)`
   (proven `pi-self-reflect` idiom; robust to the `canContinue` gate). Option B
   (`agent_before_settle` `{entries, continue}`) dropped — the `canContinue` gate is a
   maintenance burden for no real gain. Rationale: see Decisions.
2. **Trigger scope:** *Superseded by 2_requirements R5/R6.* Fire when any **owned sub-agent
   pane is live-open** (derived from the live list, not from `getOwned().length`). Busy OR
   done-but-not-closed. The driving LLM is brought up with the picture; it reflects and acts
   with its normal authority; the user remains the override authority.
3. **Status source:** *Superseded by 2_requirements R2/OQ4.* Live status is **required**
   (a stale in-memory list is not an acceptable picture). Who fetches it — the driving LLM
   calling `subagent_list` itself, or the extension embedding raw status in the steer — is
   open (OQ4); extension-embeds is the preferred, faithful self-reflect mirror.

## Loop / safety constraints (required in any implementation)

- **Loop guard:** an injected reminder re-triggers `agent_end`, so a guard is required.
  Mirror `pi-self-reflect`'s `consecutiveAutoContinues` counter (default max 3) + per-user-
  turn budget (default 1) + reset **only on genuine user input** (`event.source !==
  "extension"`); self-injected steers do NOT reset their own budget. See 2_requirements R7/R8
  and 5_research_selfreflect for the exact guard ordering and reset rules.
- **No-op fast path:** if **no owned sub-agent pane is live-open** (derived from the live
  list, NOT `getOwned().length > 0`), do nothing (zero latency, zero messages). See
  2_requirements R6.
- **Non-destructive:** reminder only; it never auto-closes or auto-waits *on the user's
  behalf*. It brings the picture up so the agent makes the decision with its normal
  authority; the user remains the override authority.

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

- **Design A (chosen):** `agent_end` + `sendMessage(steer, triggerTurn)`, fire when any
  **owned sub-agent pane is live-open** (derived from the live list), the driving LLM
  reflects on the raw pane picture and acts with its normal authority. Bounded by the
  `pi-self-reflect`-style `consecutiveAutoContinues` guard; no-op when no owned pane is
  live-open. See 2_requirements R5/R6/R7 for the current, authoritative form.
- **Design B (dropped):** via `agent_before_settle` `{entries, continue}` — rejected, see
  decisions above.
- **Design C (fallback, NON-CONFORMING to settled scope):** no LLM turn at all — just a
  footer/status line (`ctx.ui.setStatus`) listing open panes, letting the *user* (not the
  LLM) decide. Cheapest, but does **not** satisfy the settled requirement that the *driving
  LLM* reflects at handoff. Out of scope unless the requirement is re-opened.

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
- Confirmed `getOwned()` in `core.ts`: in-memory `Map<string, OwnedRecord>`.
  Pruned only on `subagent_close` with `pane_not_found`. NOT pruned on external close.
  No status field — only `pane_id`, `workspace_id`, `session`, `launched_at`, `pending`.
- Confirmed `subagent_read` / `subagent_list` in `core.ts` can provide live status.
- Confirmed `session_shutdown` in `index.ts` already warns about remaining panes
  (visible notification only, no LLM involvement).
- No `agent_end` or `agent_before_settle` handler exists in the current extension.

### What needs to happen next

1. **Spike (do first):** Write a minimal spike extension that does exactly one thing:
   on `agent_end`, call `pi.sendMessage({customType:"test", content:"PING from agent_end",
   display:false}, {triggerTurn:true, deliverAs:"steer"})` and verify the LLM actually
   gets a new turn. Confirm it does NOT infinite-loop (add a one-shot guard). This is the
   single most important thing to verify before any real implementation.

2. ~~Design decision (needs user input)~~ — **SUPERSEDED.** The three forks (hook, trigger,
   status) are settled in 2_requirements: Design A; live-open trigger (R5/R6); live status
   required (R2), fetch-side open as OQ4. See 2_requirements + 5_research_* for the current
   state; do not re-litigate these from this section.

3. **Implementation:** Modify `index.ts` to add the `agent_end` handler. The handler will:
   - Call `ensureService(ctx)` to get the service
   - `getOwned()` as a cheap pre-filter; if empty, return (no-op)
   - Otherwise fetch live status (OQ4: extension-embeds via `execute("list")`/`read`, or
     instruct the driving LLM to call `subagent_list`) and keep **only owned + live-open**
     panes (this is the R5 gate — NOT `getOwned().length > 0`)
   - Build the steer message carrying **raw pane status** (no verdict), in the self-reflect
     steering envelope (`role:custom, display:false`, "EXTENSION-GENERATED…NOT FROM USER" preamble)
   - Inject via `pi.sendMessage(steer, {triggerTurn:true})`
   - Apply the `consecutiveAutoContinues` + per-user-turn budget guard (R7/R8), reset only on
     genuine user input (`event.source !== "extension"`)

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
- `core.ts` — `SubagentService.getOwned()`, `SubagentService.list()`
- `core.ts` — `OwnedRecord` type: `{pane_id, workspace_id, session?, launched_at?, pending?}`
- `core.ts` — `close()` method: shows how pruning works
- `pi-self-reflect/src/index.ts` — the proven `agent_end` + `sendMessage` pattern (search
  `agent_end`)
- `pi-self-reflect/src/steering.ts` — `buildSteeringMessage()` for message shape reference
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` — all event types
- `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` —
  `agent_before_settle` handling (search `canContinue` for the gate logic)

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
- **Loop-guard ignore-case (identified by external critique, 2026-10-10):** if the LLM
  *ignores* the injected steer reminder on the continuation turn (does not close/wait on
  open panes), `agent_end` fires again, the one-shot latch is still set, and no second
  reminder fires. The user is left with open panes and no notification. Mitigations to
  consider: (a) allow a bounded second reminder (e.g. max 2 auto-continues, like
  `pi-self-reflect`'s `consecutiveAutoContinues`), (b) detect "panes still open after the
  steer turn" and surface it via a non-LLM channel (footer/status line), or (c) accept the
  risk and rely on `session_shutdown`'s existing warning as the backstop. Decision needed
  before implementation.
- `session_shutdown` in `index.ts` already warns about remaining panes
  (visible notification only, no LLM involvement). The new reminder is a *complement*,
  not a replacement.
