# agent-end-pane-reminders — requirements

Date: 2026-05-02 · Status: requirements (post idea-correction) · Owner: Firstmate (user owns requirements)

Companion to `1_idea__agent-end-pane-reminders.md`. This file states the requirement as
clarified in the 2026-05-02 re-discussion, which corrected two mis-reads in the idea doc:
(1) the decision-maker is the **agent**, not the user — it makes the same keep/close/wait
judgment it would have made inline, but forced to do it *at the handoff moment* with the
picture in front of it, instead of silently returning and leaving the decision implicit;
(2) the trigger axis is **not** the in-memory `getOwned()` ledger alone — it is the panes
in the current **workspace**, with `owned` used as a *filter*, not the *status source*.

## One-line requirement

At the end of an agent run, before it returns control to the user, the agent must be given
a live picture of its sub-agent panes and be forced to make the keep/close/wait decision it
owes itself — instead of narrating intent and returning without having decided.

## Functional requirements

- **R1 — Handoff picture.** Before the agent returns control to the user at the end of a
  run, it must have a current, live picture of its sub-agent panes and fold that decision
  into what it hands back.
- **R2 — Live status, not a name list.** The picture must carry *live* status per pane
  (in-flight / done-but-open / idle / gone), not merely which pane IDs are owned. A stale
  in-memory `getOwned()` with no status is not an acceptable picture — the agent must call
  `subagent_list` / `subagent_read` (live workspace query) to get real status.
- **R3 — Agent is the decision-maker.** The agent decides keep/close/wait — the same
  judgment it would make anywhere else in the session. The feature does not change *who*
  decides; it changes *when* the decision is forced to happen (at handoff, not skipped).
  The user can still override after the fact, exactly as in any normal agentic flow.
- **R4 — Non-destructive.** The feature never auto-closes or auto-waits a pane *on the
  user's behalf without the agent's own decision*. It forces the agent to decide; it does
  not decide for it, and it does not act silently behind the agent's back.

## Trigger / scope requirements

- **R5 — Fire when any owned sub-agent pane is live-open at handoff** (busy *or*
  done-but-not-closed). Trigger = `owned` ledger **∩** live workspace list (i.e. panes that
  are both owned *and* still actually open) — concretely, `subagent_list` items where
  `owned === true` (field verified present in `core.ts` `listWorkspace()`). Status and
  liveness come from the live list's `agent_status`, not the ledger. A done/idle pane that
  was never closed is exactly the case to surface; an in-flight-only trigger would miss the
  most common leak.
  - *Note:* "owned" is the **filter** (answers "which panes does this agent have
    keep/close/wait authority over?"), not the **status source** (which goes stale).
    Whole-workspace panes the agent did not spawn (manual panes, buddy pane, other
    sessions) are out of scope — the agent is not deciding about those.
- **R6 — No-op fast path.** When the owned∩live intersection is empty (no owned sub-agent
  pane actually open), do nothing — zero extra turns, zero latency, zero messages.

## Safety requirements

- **R7 — Loop guard.** The injected reminder re-triggers `agent_end`, so a latch must
  prevent re-firing on the agent's own continuation. Reset only on genuine user input, not
  on the extension's own steer.
- **R8 — Ignored-reminder is first-class, not an edge case.** If the agent gets the
  picture and *still* ends the continuation turn without making the decision (no
  close/wait/read), the user gets a skipped decision — the original bug, one turn later.
  Mitigations on the table: (a) allow a bounded second reminder (e.g. max 2
  auto-continues, à la `pi-self-reflect`'s `consecutiveAutoContinues`), (b) detect "panes
  still open after the steer turn" and surface via a non-LLM channel (footer/status line),
  (c) accept the risk and rely on `session_shutdown`'s existing warning as backstop.
  Decision needed before implementation.

## Mechanism (settled, re-validated 2026-05-02)

- **R9 — Hook = Design A.** `agent_end` + `pi.sendMessage(steer, {triggerTurn:true})`.
  The extra turn is where the agent gathers live status and makes the keep/close/wait
  decision it owes, then returns to the user having *decided* — not just narrated.

## Open questions (not yet requirements)

- **OQ1 — Live workspace list signal. RESOLVED (2026-05-02, from `core.ts` `listWorkspace()`):**
  The live workspace list (the `subagent_list` tool) makes two Herdr calls — `pane list
  --workspace <id>` + `agent list` — joins them by `pane_id`, and returns per-pane items
  carrying: `pane_id`, `workspace_id`, `terminal_id`, `cwd`, `name`, `agent`, `agent_status`
  (working / blocked / idle / done / "unknown"), `terminal_title`, `focused`, and an **`owned`
  boolean computed in the wrapper** (`this.isOwned(pane_id) !== undefined`). Therefore:
  - **R5 trigger is directly expressible:** `items.filter(i => i.owned && i.pane_id)`;
    status read from `i.agent_status`.
  - **Self-pruning is free:** a pane closed externally is absent from `pane list`, so it is
    absent from the items — no stale-ledger entries reach the trigger. The "owned ∩ live"
    intersection is exactly `items` where `owned === true`.
  - **ID matching:** both the live list and the owned ledger key on the same `pane_id`
    string (the ledger is populated from `subagent_start`'s pane_id), so the join is
    lossless — no handle-vs-UUID impedance mismatch.
  - **"unknown" status:** `agent_status` is `"unknown"` when the agent was not detectable.
    For the trigger, "unknown" still counts as open-and-needs-a-decision (an unreadable pane
    is exactly what we must not silently return past). Hence **R6's no-op is "no items with
    `owned && pane_id` at all", not "no *working* items"**.
  - **Residual (spike concern, not a shape question):** whether the live Herdr CLI is
    *actually populating* `agent_status` for sub-agent panes in practice (vs. the TS wrapper
    exposing the field). Reading `core.ts` confirms the field reaches the extension; a live
    call confirms Herdr fills it. Deferred to the spike.
- **OQ2 — Picture shown to user.** Confirm the agent's return message *shows* the user
  what it decided (e.g. "waited on p2, closed p3") so the user can override. Believed yes;
  not yet explicit in the idea doc.
- **OQ3 — Adjacent: premature-return gate.** The related-but-distinct failure where the
  agent narrates a wait ("I'll now wait for the worker") but never actually calls
  `subagent_wait` before `agent_end`. Currently out of scope for this feature; may
  deserve its own requirement if the handoff picture is meant to also catch *skipped*
  waits, not just *unclosed* panes.

## Explicitly out of scope

- Auto-cleanup on the user's behalf (no silent close/wait without the agent's own decision).
- Whole-workspace visibility including manual / buddy / other-session panes.
- The premature-return "completion gate" (see OQ3) — adjacent, not yet in scope.
