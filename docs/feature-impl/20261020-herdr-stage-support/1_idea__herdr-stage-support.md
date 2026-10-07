# herdr-stage-support — idea

Date: 2026-10-20 · Status: idea (pre-scoping) · Owner: Firstmate (user owns requirements)
Supersedes: `herdr-explore-idea.md` draft (same date) — that draft scoped a single
`/herdr-explore` command; the feature is broader, per user correction.

## One-liner

Give the Pi extension **deterministic, stage-aware sub-agent dispatch and tracking**:
a pipeline *stage* (explore, implement, review, …) can be started, watched, and
collected from the extension runtime directly — by a registered `/` command, a
shortcut, or extension-internal triggers — while the LLM driving the harness stays
**informed and able to intervene**, but is *not* the mandatory actor in the critical
path.

`/herdr-explore <text>` is the first *concrete instance* of this feature, not the
feature itself.

## Problem

Today every sub-agent action routes through the model loop:

```
user → LLM interprets → LLM calls subagent_start / subagent_prompt / subagent_wait → LLM reads console → LLM reports
```

Costs:

1. **Latency & token cost.** Mechanical steps (dispatch a worker with this brief,
   wait for terminal state, tail the console) are paid for with model calls.
2. **Non-determinism.** Whether dispatch/observation/termination happen depends on
   model behavior (loops, upstream errors, turn limits, context compaction mid-flow).
3. **Stage blindness.** The extension has no notion of a *stage* (explore → implement
   → review). Stages exist only in conversation context, so compaction or a long
   interruption loses the operational picture.

## Command surface (concrete, user-specified)

One command **per stage**, each taking an **optional** brief (stage presets carry the
intent; the text refines or overrides):

```
/herdr-stage-explore <text>          # required-ish: exploration needs a target
/herdr-stage-implement <optional-text>
/herdr-stage-review   <optional-text>
```

- Stage identity comes from the **command name**; `<text>` is a refinement, not the
  definition of the stage.
- The generic `/herdr-stage <stage> <brief>` form from the earlier sketch is folded
  in: per-stage commands are the primary surface; a generic dispatcher is optional
  sugar, not a requirement.

## Intertwining of *routine* and *execution* — a deliberate experiment

The user is "usually a big fan of clear separation of such concerns" and is choosing
to **experiment with the concepts** by *not* separating them here, knowingly:

- **Routine:** the deterministic, reusable pipeline mechanics — which stage, which
  role/mode, which pane, dispatch/track/collect, report shape, recovery. The *shape
  of the process*.
- **Execution:** the LLM-driven, open-ended, content-dependent work inside each
  stage (what the explorer actually finds, what the reviewer actually argues, what
  the implementer actually writes).

The command **is the boundary where the two concepts meet in one artifact**: the
extension owns the routine (deterministic, testable, model-independent) and hands
the execution to the worker (model-driven, evidence-bearing), while the driving
session is kept informed of both. This is an intentional *conceptual* experiment —
not a settled architecture. The experiment's value is learning how much of a
pipeline's "routine" can be runtime-owned while its "execution" stays model-owned,
and whether the boundary holds (report quality, recovery, LLM intervention points).

This must be re-examined — and possibly re-separated — if the experiment shows the
boundary blurs (e.g. routine logic that needs model judgment, or execution reports
the model cannot use without re-running the routine).

## Desired capability (generic)

A **stage** is a named phase of work with:

- a **brief** (what the worker should do),
- a **role/mode** (e.g. `explorer`+readonly, `worker`+editable, `reviewer`+readonly),
- a **lifecycle**: dispatched → running → terminal (idle/done/blocked),
- a **report** (status + bounded console tail + pane address) that lands back into
  the driving session.

The feature makes that lifecycle **runtime-owned**:

- **Start:** dispatch happens as extension code (registered command handler or
  internal call), reusing the `subagent_start` launch path. No model call in the
  critical path.
- **Track:** the extension watches the worker pane (its own bounded-wait mechanism,
  same contract as `subagent_wait`), not the LLM polling.
- **Collect:** on terminal state, a structured report is emitted into the driving
  session (custom message entry + optional model wakeup), keeping the transcript
  honest without a manual tool round-trip.
- **Stay in the loop:** the driving LLM receives stage events (dispatch, terminal
  state, failures) as visible session messages. It is *informed*, can steer via
  ordinary turns (e.g. issue `subagent_prompt`/`subagent_close` tools), but does not
  have to act for the stage to complete.

## How it fits the existing architecture (grounded in installed Pi SDK types)

- **Deterministic entry points:**
  - `pi.registerCommand("herdr-stage", …)` — general form: `/herdr-stage <stage> <brief> [--role …] [--editable] [--wait]`.
  - Per-stage sugar commands (`/herdr-explore`, `/herdr-review`, …) are thin aliases
    that pre-set role/mode — same implementation, no per-command logic.
  - `pi.registerShortcut` (optional) for the most common stage.
  - Extension-internal API (future): stages can also be triggered by other extension
    code/events — the command is one façade, not the only one.
- **Dispatch/track/collect:** reuse `core.ts`'s existing Herdr pane logic (pane
  creation → managed-Pi detection → `agent prompt` delivery → terminal-state
  observation). Stage support is a **thin stage state layer on top of the same
  supervision code** — explicitly *not* a second supervision implementation.
- **In-loop reporting:**
  - `ctx.sendMessage({ customType: "herdr_stage_<event>", … })` with a registered
    message renderer → visible, structured transcript entries.
  - `appendEntry("herdr_stage", …)` → stage state persists in session data, survives
    context compaction, and is readable by later model turns.
  - Model wakeup (`deliverAs: "steer"/"followUp"`, `triggerTurn`) is a deliberate,
    per-event choice — see open questions.
- **Existing invariants preserved:** pane remains the sole caller-facing address; no
  public continuation/cursor IDs; ownership informational; readonly default
  (editable only via explicit flag, same rule as `subagent_start`); console tails
  remain bounded code-point snapshots; multiline rejection unchanged.

## Stage state model (sketch, not yet specified)

```
herdr_stage {
  id, name (explore|implement|review|…|custom),
  brief, role, mode, pane,
  status: dispatched | running | terminal | failed,
  terminal: { status, console tail, pane, observedAt },
  events: [...]        // persisted via appendEntry
}
```

One stage = one worker pane in v1. Multi-worker stages (controller + N workers) are
an explicit follow-up unless the user scopes otherwise.

## Open questions (for the scoping phase)

1. **V1 surface.** Per-stage commands (`/herdr-stage-explore`,
   `/herdr-stage-implement`, `/herdr-stage-review`) as specified above; is a generic
   `/herdr-stage <stage> <brief>` dispatcher also needed in v1, or later sugar?
   Shortcuts and internal triggers can be later.
2. **Sync vs. fire-and-forget.** Does the command block the TUI until terminal state,
   or return immediately while the extension watches the pane in the background and
   posts the terminal report into the session? Leaning fire-and-forget + terminal
   report (keeps the interactive loop unstalled, keeps the model informed).
3. **When is the driving model woken?** Inform-only (custom entries, no turn) vs.
   wakeup (steer/followUp) at dispatch / terminal / failure. Default hypothesis:
   visible entries always; model wakeup only at terminal state and on failure.
4. **Per-stage brief semantics.** Required vs. optional text per stage (explore
   leans required; implement/review lean optional with stage presets supplying
   defaults, e.g. review = "review the current session's diff/state"). Define the
   default brief per stage in requirements. Fixed set (explore/implement/review) vs. free-form names
   with role/mode parameters. Leaning free-form name + preset role/mode mapping for
   the fixed ones; v1 presets come from the existing role set
   (teamlead/worker/reviewer/rubberduck/explorer).
5. **Routine/execution boundary in the report.** What exactly does the terminal
   report carry back — only the *routine* evidence (status, console tail, pane,
   timing), or also a model-judged *execution* verdict (e.g. "exploration conclusive:
   yes/no")? Leaning: routine evidence only in v1; the driving LLM does the verdict.
   This is the sharpest test of the concept experiment above.
6. **Recovery & honesty.** Pane death, detection failure, or wait timeout must
   surface into the session as an honest failure event (stage `failed` + report),
   never silently. Same limits as `subagent_wait` (bounded budget, no auto-resend).
7. **Concurrency.** Multiple simultaneous stages in one session: allowed in v1 or
   one active stage at a time? Leaning: allowed, each stage isolated by its pane
   address; no shared-mutable state between stages.
8. **Command vs. prompt-template alternative.** A registered command is the only
   model-independent path; a prompt template/skill would still run through the LLM
   and does not solve the stated problem. Confirm this choice with the user.

## Non-goals (v1)

- Replacing the `subagent_*` tools — the LLM-driven path stays first-class.
- Multiline briefs in the command line.
- Cross-workspace dispatch / multi-worker orchestration per stage.
- A full pipeline engine (auto-chaining stages explore→implement→review) — that is
  the natural *next* feature on top of this stage model; out of v1 unless scoped in.

## Next step

Resolve the open questions (especially #1 surface, #2 sync/async, #3 model wakeup,
#5 report boundary) with the user, then write
`2_requirements__herdr-stage-support.md` (user-facing syntax, per-stage behavior,
default briefs, acceptance criteria). The routine/execution experiment is the
conceptual backbone; keep it visible in requirements so the acceptance criteria
test the boundary, not just the mechanics.
