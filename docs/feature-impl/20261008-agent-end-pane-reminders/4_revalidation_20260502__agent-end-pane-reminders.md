# Re-validation (2026-05-02)

Status: re-validation of the idea-stage claims against current SDK source (Pi 1.0.0 —
unchanged host, same as 2026-10-08 notes). No code changes. Feature remains pre-scoping,
spike-pending.

## Verdict

The core mechanism claim (`agent_end` + `sendMessage(steer, {triggerTurn:true})` fires a
continuation turn) is **source-plausible and corroborated, but never run in this repo**.
The "timing flaw" raised during re-validation was re-framed: it is a **cost tradeoff of
the design** (one synthetic LLM turn per session end while any owned pane is open), not a
mechanism defect — the exact pattern `pi-self-reflect` runs as its cadence mechanism.

## Confirmed against current SDK source (re-read 2026-05-02)

- `agent_end` handler is `void` — confirmed (`types.d.ts`, `AgentEndEvent` has no
  `BoundaryResult`; `AgentBeforeSettleEvent` does).
- `sendMessage` options `{triggerTurn, deliverAs: "steer" | "followUp" | "nextTurn"}` —
  confirmed on `ExtensionAPI`.
- Continuation path: `agent-session.js` `sendCustomMessage()` → not streaming +
  `triggerTurn` → `_runAgentPrompt()` (fresh run); during `agent_settled` emission it is
  pushed to `_deferredSettledActions` and run after settle. Comment at
  in `agent-session.js` (search `agent_end handlers require a fresh run`): "Messages queued by
  agent_end handlers require a fresh run before pre-settlement handlers fire."
- `pi-self-reflect/src/index.ts` (search `agent_end` + `sendMessage`) uses exactly this pattern
  (`pi.sendMessage(buildSteeringMessage(...), { triggerTurn: true, deliverAs: "steer" })`
  from an `agent_end` handler). Corroborates the idiom, not live proof in this repo.

## Corrected / discarded alternatives

| Alternative | Earlier framing | Re-validation result |
|---|---|---|
| Append `custom_message` at `agent_settled` to feed next real turn | "Cheaper injection" | **Likely dead.** `agent_settled` is a plain event — no `entries`/`BoundaryResult` (only `agent_before_settle`/`turn_end` can append session entries). A `sendMessage` without `triggerTurn` at settle just appends a custom message; whether it reaches LLM context on the next turn is unverified, and the entry-append path is closed. Discard. |
| Piggyback owned-pane inventory on every `subagent_*` tool result | "Zero new hooks" | **A trade, not a win.** Changes every tool result shape, inflates all subagent calls, and does *not* help the handoff case where the final turn had no `subagent_*` call (exactly the leak scenario). Not hook-free in any meaningful sense. |
| Check `before_agent_start` and inject into the *next real* user turn | (not previously considered) | **Unexplored, unverified.** `BeforeAgentStartEvent` exposes `systemPromptOptions` (system-prompt sections only), not message append. Whether a handler there can get content into LLM context for the upcoming turn is unknown. If it works, this is the cheapest path: no synthetic turn cost, no loop risk — but it needs its own tiny spike to verify context reachability. |

## Carried-forward open items (unchanged unless noted)

1. **Spike A** (original): minimal `agent_end` + `sendMessage(steer, triggerTurn)`
   extension; observe whether a continuation turn actually fires on the live host; add a
   one-shot guard to confirm no loop. Still the primary blocking unknown.
2. **Spike B** (new, from re-validation): minimal `before_agent_start` handler that
   appends pane-inventory text; verify it reaches LLM context on the next real turn. If
   verified, this supersedes Design A (no synthetic-turn cost, no loop guard needed).
3. **Measure the leak** (new, from re-validation): before committing to either spike,
   check how stale `getOwned()` records actually accumulate in real sessions. If the leak
   is rare, neither feature may be worth building.
4. **Loop guard** (Design A only): one-shot latch per genuine user input still required if
   Spike A passes — an injected reminder re-triggers `agent_end`.
5. **Stale pruning** (deferred, independent): `getOwned()` pruned only on explicit
   `subagent_close`; externally-closed panes linger. Separate fix candidate.

## Cost framing (for the decision)

Design A's true cost: **one full synthetic LLM turn per session end** whenever any owned
pane is open — even when all panes are idle/done with nothing actionable. Model outcomes
on that turn range from "closes panes correctly" to "acknowledges and stops" (wasted
turn) to "acts on stale assumptions". That is acceptable for `pi-self-reflect`'s
periodic-reflection purpose; for low-urgency pane cleanup it is the central design
question, not a footnote.

## State

- No code exists for this feature (unchanged).
- No host/config changes.
- Next decision point: run Spike A, Spike B, or measure-the-leak first (user call).
