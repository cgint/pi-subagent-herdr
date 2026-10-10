# Research: pi-self-reflect pattern (agent-end-pane-reminders)

Worker: research-selfreflect (readonly) · Source: /Users/cgint/dev-external/pi-self-reflect/src/

## The pattern (guards, taxonomy, injection, reset)

### agent_end guard ordering (mirror this order)
1. `isReflecting` re-entrancy latch → return.
2. `suspended` (user disabled) → return.
3. `!agentEndReflectionEnabled` → return.
4. `lastAssistantWasAborted(contextMessages)` → return (don't reflect after an abort).
5. `iterationsSinceUserInput < MIN_AGENT_END_ITERATIONS_SINCE_USER_INPUT` → return (skip trivial turns).
6. `agentEndReflectionsSinceUserInput >= MAX_AGENT_END_REFLECTIONS_PER_USER_TURN` (default 1) →
   record SKIPPED checkpoint, return. Per-user-input budget, incremented *before* the reflection runs.
7. Post-result: `STEER`/`PAUSE_USER` with `consecutiveAutoContinues >= MAX_AUTO_CONTINUES` (default 3)
   → record SKIPPED, reset `consecutiveAutoContinues = 0`, return.

### Outcome taxonomy
- **OK** → no injection; checkpoint record + status only.
- **NOTE** → visible-only (record + status), never injected.
- **MALFORMED** → visible-only diagnostic, never injected (reflector already retried once).
- **STEER** → injected (unless auto-continue cap hit).
- **PAUSE_USER** → injected; steering text instructs the driver to ask the user now.
- **SKIPPED / ERROR** → record-only.

`recordCheckpoint` / `emitVisibleRecord` runs for *all* outcomes; only *injection* is gated.

### Exact injection call (agent_end + manual paths)
```ts
pi.sendMessage(buildSteeringMessage(result, checkpoint, nextGeneratedTimestamp(contextMessages)),
              { triggerTurn: true, deliverAs: "steer" });
```
(The cadence-context path does NOT call `pi.sendMessage` — it appends the same message to the
returned messages array. Only the agent_end/manual paths use the steer.)

### Loop-guard resets (the R7 mechanism to copy)
- `consecutiveAutoContinues = 0` on: `input` event (only when `event.source !== "extension"`),
  manual reflection start, `session_start`, and inside the MAX_AUTO_CONTINUES skip.
  **Not** reset on OK/NOTE — the streak breaks only on real user input.
- `agentEndReflectionsSinceUserInput` and `iterationsSinceUserInput` reset on the same
  non-extension `input` + `session_start`.
- **Critical:** `if (event.source === "extension") return;` in the `input` handler — self-injected
  steers do NOT reset their own budgets. This is the whole loop-guard.

## What to mirror
- Guard ordering: re-entrancy → user-off → abort → min-iterations → per-user-input budget →
  post-result max-continues.
- Budget increments *before* acting; SKIPPED records with reasons when caps fire.
- `input` event as the single reset boundary, with the extension-source filter.
- Deterministic outcome gating: only inject-worthy outcomes call `pi.sendMessage`; everything
  else is visible-only.
- Injection shape: `pi.sendMessage(msg, { triggerTurn: true, deliverAs: "steer" })`.
- An `isReflecting`-style latch if our handler becomes async, released in `finally`.

## What to deliberately NOT mirror (reflector-model divergence)

`runReflection()` (reflector.ts) makes a **second LLM call**:
`complete(model, { systemPrompt, messages: convertToLlm(...), tools }, { apiKey, headers, signal,
sessionId, transport, maxTokens })` from `@earendil-works/pi-ai` — driver-or-override model, its
own auth lookup, sidecar session IDs (`${sessionId}:self-reflect:...`) to protect provider
continuation state, SSE transport, a sequential expert-view + combiner strategy, a format-repair
retry prompt, and MALFORMED handling.

**We must NOT copy any of it:** no second model, no verdict parsing, no retry loop, no sidecar
sessions, no strategy/override config. Consequence for our feature:
- **MALFORMED is impossible for us** (no second model to malform).
- Taxonomy collapses to **deterministic inject vs. visible-only** (no LLM judgment to gate on).
- **Zero added latency/cost** from the reflection itself (the driving LLM's normal turn does the
  reflecting).

This directly validates the Scope constraint "the driving LLM reflects; nothing decides for it."

## Steer-message shape reference (steering.ts)
```ts
{
  role: "custom",
  customType: "self-reflect-steering",   // we'd use our own customType
  content: steeringContent(result, checkpoint),  // plain string
  display: false,
  details: { checkpoint, outcome },
  timestamp,
}
```
Content = a 6-line boundary preamble ("EXTENSION-GENERATED PROCESS SUPPORT — NOT FROM USER.",
source, "does not change the user's request", no user-attribution, do-not-expose,
process-control-only) + `Checkpoint: #N` + `Outcome: X` + outcome-specific lines (PAUSE_USER adds
`Reason:` + "ask the user now" + Question/context to present; NOTE = awareness-only; default =
"Process steering for the next step:"). It carries the reflector's *result text*, not a bare nudge —
ours would be **deterministically generated raw pane status** in the same envelope (no verdict).
