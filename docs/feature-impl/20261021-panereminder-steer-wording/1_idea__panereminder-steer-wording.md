# Idea: Pane-reminder steer wording fix

Status: **proposed — not yet implemented**
Date: 2026-10-21
Related: `docs/feature-impl/20261008-agent-end-pane-reminders/` (the feature this corrects)

## Problem

The `agent_end` pane-reminder steer (see `buildPaneSteerMessage` in `index.ts`) currently reads:

```
[pane-reminder] open: <pane_id> (<name>):<status> — decide per pane: keep, close, or wait. (extension nudge, not user input)
```

Observed effect: sub-agent panes the driving agent still needs for follow-up work within the same ongoing task get closed prematurely — at the exact turn boundary where the reminder fires, before the agent's next step that depends on the pane.

## Root cause (analysis, not yet empirically confirmed against a session transcript)

The steer's `decide per pane: keep, close, or wait` is a three-verb menu that includes `close` as an equally-weighted, convenient option. Combined with:

1. The reminder fires at `agent_end` — the LLM is re-woken into a fresh turn with no user prompt and no explicit signal that its *own* task still has pending steps using this pane.
2. `idle` status (the most common status a parked-but-still-needed pane shows) reads as "finished" rather than "parked."
3. The shipped `subagent-herdr-supervision` skill's anti-retention rule ("'Might be useful later' is not a retention reason") gives the LLM a ready-made justification to close.

The steer is the only thing this extension controls directly in that moment; it's the right place to fix, without changing trigger timing, guards, or architecture.

## Decided new wording

```
[pane-reminder] still open: <pane_id> (<name>):<status> — retain or wait if needed for upcoming steps; close only when work is fully complete. (extension nudge, not user input)
```

### What changed and why

| Aspect | Before | After |
|---|---|---|
| Leading verb | `decide per pane: keep, close, or wait` (neutral menu, `close` equally available) | `retain or wait if needed for upcoming steps; close only when work is fully complete` (keep-default; `close` gated on an explicit condition) |
| `wait` | Present as one of three options | Kept, as a first-class action alongside `retain` (restored after an earlier draft accidentally dropped it) |
| Provenance tag | `(extension nudge, not user input)` | Unchanged — deliberately kept so the LLM discounts this as harness-generated rather than a hard user directive |

### Rejected alternatives (for the record)

- **Pure status, zero instruction** (`[pane-reminder] still open: <...>` with no trailing guidance): considered as the most "no black magic" option; rejected in favor of an explicit keep-default framing, which the user preferred for clarity on *how* to make the keep/close decision.
- **Binary reflect question** (`reflect: do you still need this pane, or is its work done?`): rejected — a yes/no question both LLMs and the driving agent tend to *answer* rather than sit with, and its two branches both point toward "do you still need it / is it done," which drops `wait` and leans *more* toward closing than the original three-verb menu, not less.
- **Keep-default without `wait`** (`retain if needed for upcoming steps; close only when work is fully complete`): initially proposed, then corrected after the user flagged that `wait` (active follow-up on a pane, as opposed to passive parking) had been silently dropped — `wait` matters for panes that are `busy` (call `subagent_wait`) or that the driving agent intends to re-prompt/inspect later.

## One known nuance (documented, not a blocker)

`wait` in this extension specifically means "block until the pane's agent reaches a terminal state" — a real action for a `busy` pane, but a no-op on an already-`idle` pane (where "wait" effectively collapses into "keep it, I'll check back later," i.e. closer to `retain` than to a literal wait call). The steer's status field (`:idle` / `:busy`) already lets the LLM tell these cases apart, so no explicit distinction is needed in the string itself.

## Change to apply (pending user sign-off on this doc)

File: `index.ts`, symbol `buildPaneSteerMessage`, the single `content` template literal.

```diff
- `[pane-reminder] open: ${parts.join(", ")} — decide per pane: keep, close, or wait. (extension nudge, not user input)`;
+ `[pane-reminder] still open: ${parts.join(", ")} — retain or wait if needed for upcoming steps; close only when work is fully complete. (extension nudge, not user input)`;
```

Nothing else changes: trigger timing (`agent_end`), re-entrancy latch, auto-continue/per-turn budgets, `triggerTurn:true`, `deliverAs:"steer"`, `customType`, all untouched.

No unit test asserts the old steer string (verified via `rg "pane-reminder|decide per pane|buildPaneSteerMessage" tests/` → no matches), so no test updates are required.

## Open / residual risks (honest, not fixed)

- **No observational evidence yet.** This fix is derived from mechanism analysis of the code + the user's report; no session transcript showing an actual premature close has been inspected. Verify post-implementation by watching a real multi-step task that parks a pane across a turn boundary.
- **Keep-default bias is a lever in both directions.** If the opposite failure is ever observed (panes piling up because the LLM keeps everything "for upcoming steps"), this same sentence is the thing to walk back.
- **Mild tension with the supervision skill.** "retain or wait if needed for upcoming steps" and the skill's "'Might be useful later' is not a retention reason" are not directly contradictory (concrete near-term need vs. vague future-utility), but worth watching whether the LLM still reaches for the skill's anti-retention rule in practice after this change.
