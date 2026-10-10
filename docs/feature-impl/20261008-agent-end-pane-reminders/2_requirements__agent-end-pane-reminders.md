# agent-end-pane-reminders — requirements

Date: 2026-05-02 · Status: requirements (post idea-correction) · Owner: Firstmate (user owns requirements)

Companion to `1_idea__agent-end-pane-reminders.md`. This file states the requirement as
clarified in the 2026-05-02 re-discussion.

## Scope — what this feature IS (settled 2026-05-02)

This feature is **`pi-self-reflect`'s mechanism applied to panes — and nothing else.**

- **Mechanism:** the same bounded, guarded, conditional steer at `agent_end` that
  `pi-self-reflect` uses — `consecutiveAutoContinues` counter + per-user-turn reflection
  budget + reset on genuine user input, injecting via
  `pi.sendMessage(steer, {triggerTurn:true})` only when the nudge is warranted, and
  hard-stopping at the auto-continue limit. (See `pi-self-reflect/src/index.ts`, search
  `agent_end` + `consecutiveAutoContinues`.)
- **Content:** the nudge brings up the **pane picture** — the state of the agent's own
  sub-agent panes (live status) — so the agent makes the keep/close/wait decision it would
  otherwise skip at the handoff moment.
- **The driving LLM reflects; nothing decides for it.** The reflection — "what do I do
  about these panes?" — is performed by the **driving LLM itself**, in the turn the steer
  triggers. The extension's entire role is to *get the status in front of that LLM and
  prompt it to reflect*. Concretely forbidden ("no magic, no hidden agent"):  
  - **No second model call** that judges the panes and returns a verdict (this is where
    `pi-self-reflect` *diverges*: it runs a reflector model; this feature must not — the
    driving LLM *is* the reflector).  
  - **No hidden agent / sub-agent** that reads the status and decides close/wait on the
    driving LLM's behalf.  
  - **No extension-side decision logic** that interprets the status ("pane X is done, so
    close it"). The extension may *gather* status (call `subagent_list`) and *embed the
    raw status* in the steer message — that is plumbing, not deciding. The steer message
    carries **raw status, not a verdict**. The moment the extension computes "you should
    close p2", it has crossed from *bring-it-up* into *decide-for-it*, which is out of
    scope.
- **"Nothing else"** — explicitly out of scope:
  - No **workspace-scope redesign.** The trigger is the agent's *own* sub-agent panes, not
    a re-derived `owned ∩ live-workspace` axis. (The `owned`-as-filter / live-as-status
    phrasing in R5 below is an implementation detail of *how* to read the agent's own panes
    accurately, not a scope expansion to whole-workspace reporting.)
  - No **decision-authority reassignment.** The mechanism does not change *who* decides;
    it surfaces the picture at the moment the agent would otherwise skip the judgment. The
    agent then acts with its normal authority, exactly as it would anywhere else. The user
    remains the override authority, as in any normal agentic flow.
  - No **completion / skipped-wait gate** (the "agent narrates a wait but never calls
    `subagent_wait`" case). Adjacent, distinct feature — not this one.

## One-line requirement

At the end of an agent run, before it returns control to the user, the agent is brought up
with a live picture of its own sub-agent panes (via the `pi-self-reflect`-style bounded
steer) so it makes the keep/close/wait decision it owes itself — instead of narrating
intent and returning without having decided.

## Functional requirements

- **R1 — Handoff picture.** Before the agent returns control to the user at the end of a
  run, it must have a current, live picture of its sub-agent panes and fold that decision
  into what it hands back.
- **R2 — Live status, not a name list.** The picture the driving LLM reflects on must carry
  *live* status per pane (in-flight / done-but-open / idle / gone), not merely which pane
  IDs are owned. A stale in-memory `getOwned()` with no status is not an acceptable
  picture. *How* the live status reaches the LLM is an open implementation choice (see
  OQ4): (a) the steer message tells the driving LLM to call `subagent_list` itself, or
  (b) the extension calls `subagent_list` and embeds the **raw status** in the steer
  message. Both keep the *reflection* with the driving LLM (R3 / Scope); they differ only
  in who does the data-gathering. (b) is preferred for fidelity — it removes the LLM's
  ability to skip the data-gathering, which is the failure this feature exists to catch —
  but the choice is deferred, not settled.
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
  pane actually open), do nothing — zero extra turns, zero latency, zero messages. This is the
  *derived live-open* check (R5), **not** `getOwned().length > 0` — the latter is true for
  dead-but-owned and restored-but-dead panes and would fire the nudge on stale ownership (the
  exact bug this feature should fix). `getOwned()` is the cheap pre-filter; the live list is
  the actual gate.

## Safety requirements

- **R7 — Loop guard.** The injected reminder re-triggers `agent_end`, so a latch must
  prevent re-firing on the agent's own continuation. Reset only on genuine user input, not
  on the extension's own steer.
- **R8 — Ignored-reminder is first-class, not an edge case.** If the agent gets the
  picture and *still* ends the continuation turn without making the decision (no
  close/wait/read), the user gets a skipped decision — the original bug, one turn later.
  **Resolved (implemented):** mitigation (a) — bounded second reminder. `MAX_REMINDERS_PER_USER_TURN = 2`
  allows one retry; `MAX_AUTO_CONTINUES = 3` bounds total auto-continues. Both caps are
  active. Mitigation (b) (footer visibility on skip) is not implemented; (c) (session_shutdown
  backstop) already exists.

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
    status read from `i.agent_status`. **Implemented:** the handler filters on `item.owned === true`.
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
  - **Residual (spike concern): RESOLVED (live-verified 2026-05-02 on Pi 1.0.0).** A test
    session confirmed Herdr populates `agent_status` (observed "idle" for a spawned pane).
- **OQ2 — Picture shown to user. RESOLVED (implemented):** The steer message is
  `display: true` — a single compact line visible in the TUI:
  `[pane-reminder] open: w43:pD (name):idle — decide per pane: keep, close, or wait.`
  The user sees the nudge and the agent's subsequent decision. The agent's return message
  also narrates what it decided (e.g. "closed w43:pD").
- **OQ3 — Adjacent: premature-return gate.** The related-but-distinct failure where the
  agent narrates a wait ("I'll now wait for the worker") but never actually calls
  `subagent_wait` before `agent_end`. Currently out of scope for this feature; may
  deserve its own requirement if the handoff picture is meant to also catch *skipped*
  waits, not just *unclosed* panes.
- **OQ4 — Who fetches the live status? RESOLVED (implemented): (b) the extension fetches.**
  The `agent_end` handler calls `service.execute("list", {workspace:"current"})` and embeds
  the raw status in the steer message. This removes the driving LLM's ability to skip the
  fetch (the failure this feature exists to catch) and is the faithful `pi-self-reflect`
  mirror (self-reflect does its work in the handler and the steer carries the *result*).

## Explicitly out of scope

- Auto-cleanup on the user's behalf (no silent close/wait without the agent's own decision).
- Whole-workspace visibility including manual / buddy / other-session panes.
- The premature-return "completion gate" (see OQ3) — adjacent, not yet in scope.
- **Any second-model verdict, hidden agent, or extension-side interpretation of the pane
  status** (see Scope → "The driving LLM reflects; nothing decides for it"). The steer
  carries raw status, not a verdict.
