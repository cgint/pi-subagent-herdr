# Research: Pi SDK mechanics (agent-end-pane-reminders)

Worker: research-sdk (readonly) · Source: Pi 1.0.0 dist (extensions/types.d.ts, agent-session.js)

## Verified (symbol anchors, no line numbers)

- **`agent_end` handler is `void`.** No `BoundaryResult`; can only do side effects. Must inject
  via `pi.sendMessage` / `pi.sendUserMessage`. Confirmed.
- **`agent_settled` is a plain event** (`AgentSettledEvent` carries no entries/BoundaryResult).
  Only `agent_before_settle` / `turn_end` can append session entries. Confirmed the earlier
  "append a custom_message at agent_settled" idea is a dead end.
- **`sendMessage` options:** `{ triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }`.
  Confirmed on `ExtensionAPI`.
- **Correction to 4_revalidation:** at `agent_end`, a `triggerTurn` steer does NOT call
  `_runAgentPrompt` directly. It goes through the **low-level queue + fresh-run continue path**:
  the steer is queued, the session loop drains it, and a *fresh* agent run is started before
  pre-settlement handlers fire. (Search `agent_end handlers require a fresh run`,
  `sendCustomMessage`, `_deferredSettledActions` in agent-session.js.) The net effect is the
  same — a continuation turn fires — but the mechanism is queue+continue, not direct prompt.
- **`canContinue` gate for `agent_before_settle`:** confirmed (search `canContinue`,
  `_reportInvalidBoundaryContinuation`). A queued steer satisfies `canContinue`, so Design A's
  steer path does NOT trip the gate. Design B (entries+continue) would.
- **`before_agent_start` is more capable than 4_revalidation stated.**
  `BeforeAgentStartEventResult.message` provides a *typed* custom-message injection into the
  upcoming turn (in addition to `systemPromptOptions` mutation and full systemPrompt override).
  So Spike B's mechanism (inject pane picture into the next real user turn, no synthetic turn)
  is *available*, not "merely unexplored." Whether the injected message reaches LLM context on
  the next real turn still needs a live spike.
- **`input` event `source` field** distinguishes user vs extension-originated input — the R7
  loop-guard reset predicate is expressible (mirror self-reflect's `event.source !== "extension"`).
- **R6 no-op fast path costs nothing** at `agent_end` (sync `getOwned()` check, no CLI).

## Contradictions-with-docs

1. 4_revalidation says the `agent_end` steer "calls `_runAgentPrompt()` directly." **Correction:**
   it's the queue + fresh-run continue path. Same outcome, different mechanism. Low severity —
   the "fires a continuation turn" conclusion stands.
2. 4_revalidation lists `before_agent_start` as "system-prompt sections only" and leaves Spike B
   "unknown." **Correction:** `BeforeAgentStartEventResult.message` is a typed message-injection
   hook. Spike B is a viable, cheaper alternative (no synthetic turn), pending a live context-
   reachability spike.

## Open-unknowns

1. **Spike A (primary, unchanged):** does a steer queued from an `agent_end` handler actually
   trigger a continuation turn on live Pi 1.0.0? Source-plausible, never run in this repo.
2. **`InputEvent.source` exact label** for extension-originated prompts (e.g. `sendUserMessage`
   default flags) vs interactive/rpc — needed to pin the R7 reset predicate precisely.
3. **`agent_end` → `willRetry` interplay:** the public `agent_end` listener event is augmented
   with `willRetry` (`_willRetryAfterAgentEnd`). Whether an auto-retry of a failed run re-fires
   `agent_end` (and thus re-triggers the feature) before `agent_settled` is unverified — could
   inflate R7/R8 budget accounting.
4. **`nextTurn` semantics:** what `_pendingNextTurnMessages` delivers on (the next real user
   turn?) and whether such a message reaches LLM context — relevant only if a no-synthetic-turn
   variant (Spike B) is ever preferred over Design A.
5. **`_reportInvalidBoundaryContinuation` UX:** it only emits an error event; confirm no console/
   TUI noise on this feature's normal path (it should not fire, since queued steers satisfy
   `canContinue`).
