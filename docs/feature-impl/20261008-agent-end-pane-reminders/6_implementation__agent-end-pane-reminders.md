# Implementation: agent-end-pane-reminders

Status: **implemented + live-verified** (Pi 1.0.0, branch `feat/agent-end-pane-reminders`)
Date: 2026-05-02

## What was built

An `agent_end` handler in `index.ts` that, when owned sub-agent panes are live-open,
injects a one-line steer so the driving LLM reflects and decides keep/close/wait.

### Steering message (visible, one-line)

```
[pane-reminder] open: w43:pD (pane-rem-test):idle — decide per pane: keep, close, or wait. (extension nudge, not user input)
```

- `display: true` — visible in the TUI (user sees the nudge, not just the outcome).
- `customType: "pi-subagent-herdr-pane-reminder"` — renderer-able, no renderer registered
  (falls back to plain-text rendering of `content`).
- Raw status only, no verdict (anti-magic constraint).
- Multiple panes: comma-separated in the single line.

### Handler flow (symbol: `pi.on("agent_end", ...)`)

1. Re-entrancy latch (`isReminding`) → return if in flight.
2. Per-user-turn budget (`remindersSinceUserInput >= 2`) → return.
3. Max auto-continues (`consecutiveAutoContinues >= 3`) → reset + return.
4. `getOwned().length === 0` → return (no-op, zero I/O).
5. `service.execute("list", {workspace:"current"})` → live workspace items.
6. Filter `item.owned === true` (the R5 gate: owned ∧ live-open).
7. Empty → return (no live-owned panes).
8. Build steer (raw status, one line).
9. Increment guards **before** `sendMessage` (closes double-injection race).
10. `pi.sendMessage(steer, {triggerTurn:true, deliverAs:"steer"})` in try/catch/finally
    (latch clears in finally).

### Guard reset (symbol: `pi.on("input", ...)`)

`consecutiveAutoContinues = 0; remindersSinceUserInput = 0;` only when
`event.source !== "extension"` (genuine user input, not self-injected steer).

## Live verification (2026-05-02, Pi 1.0.0)

Test session `w43:pC` confirmed the full R1–R5 loop:
1. `subagent_start` → pane `w43:pD` owned by the session.
2. Turn ends → `agent_end` fires → live query detects owned pane → steer injected.
3. Agent woken with raw pane picture (`w43:pD (pane-rem-test):idle`).
4. Agent decided to close → `subagent_close` → verified absence.
5. Next turn: no owned live panes → no-op fast path (R6 confirmed).

Spike A (`triggerTurn` fires a continuation turn on live Pi 1.0.0): **PASS**.
Spike B (`before_agent_start` context reachability): not needed (Design A works).

## Review (3 concurrent sub-agents, 2026-05-02)

Findings and fixes (commit `2f1c203`):
- **B4** (race): increment-before-act — guards increment before `sendMessage`. ✅ fixed.
- **1a** (re-entrancy): `isReminding` latch set/clear in try/finally. ✅ fixed.
- **2a** (filter): use `item.owned === true` instead of `getOwned()` set. ✅ fixed.
- **V6/R8** (dead cap): `MAX_REMINDERS_PER_USER_TURN` 1→2, making both caps active. ✅ fixed.

Remaining (noted, low-priority, not fixed):
- No `lastAssistantWasAborted` guard (self-reflect has one; minor: steer after abort).
- No AbortSignal to the `list()` call (a wedged Herdr CLI could hang the handler).
- `list` scoped to `workspace: "current"` (other-workspace owned panes not surfaced — scope limit).

## Commits (branch `feat/agent-end-pane-reminders`)

| Hash | Subject |
|---|---|
| `6a1d65c` | feat: bounded steer at agent_end for live owned panes (initial) |
| `2f1c203` | fix: close race window, use item.owned, enable R8 retry |
| `e243ac6` | feat: compact one-line steer, visible to user |
