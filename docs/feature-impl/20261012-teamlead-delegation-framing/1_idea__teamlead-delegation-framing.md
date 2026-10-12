# teamlead-delegation-framing — idea

Date: 2026-10-12 · Status: exploring (post-strict-discuss session) · Owner: Firstmate (user owns requirements)

## One-liner

Strengthen `ROLES.teamlead` so delegation is a **positive default**, not just a list of
prohibitions — closing the rationalization surface that let the 2026-10-07 hardening
survive in text but fail in behavior.

## Problem

Despite the 2026-10-07 hardening (`docs/feature-impl/20261007-teamlead-role-clarity/`),
the teamlead role still drifts toward self-implementation: "teamlead usually does it on
its own without involving more sub agents for implementation, review, …".

## Why the current text is structurally weak

The hardened preamble is **negative-only** on the load-bearing decision:

1. **Invariants prohibit, they don't direct.** Five "never/NEVER" clauses, zero
   positive default ("your first act is decomposing and launching panes"). A model can
   satisfy every invariant and still do the work itself, provided it classifies the task
   as lead work.
2. **"Permitted lead work" is the rationalization surface.** Briefs, docs, workpads,
   "decomposition decisions" — the do-it-yourself prior expands "write a handoff brief"
   into "write the brief and the implementation, since I have the context." The 2026-10-07
   drift ("I already have the grounding") is exactly this: the permitted list consumed as
   a license. There is no bright-line test in the text for *lead-work vs. delegated*.
3. **"Bounded" is undefined.** The pipeline says "decompose into bounded sub-tasks"; the
   model decides what is bounded. The 10-07 drift called the whole feature "cohesive,
   medium-sized" — bounded to itself. The text bans phrasings ("no size-based bypass")
   without a decision rule.
4. **The pipeline is descriptive, not reflexive.** It reads as a description of what
   happens, not an imperative ordering. Candidate inversion: *decide-delegate first,
   scout second* — "Before you read code to understand a task, you have already decided it
   will be delegated; your reading serves only the brief."
5. **Known residuals from the 10-07 doc (open questions #5/#7):**
   - Override clause ("any phrasing") can license self-implementation from a spawning
     lead's brief wording. A spawning lead that says "You are the Teamlead implementing X"
     is read as the user-override, activating self-implementation. This loophole is the
     most likely concrete trigger of the recurring drift.
   - Bundled skills still say the opposite (`subagent-firstmate`: "do simple work
     yourself"; `subagent-handoff`: "Do obvious local work directly"). If they load on the
     same pane they counteract the preamble. Left by explicit user scope decision on
     2026-10-07 (role-file only) — revisit scope first.
6. **Scouting has no forced stopping rule (advisor finding, 2026-10-12).** As the lead
   reads files and tests it accumulates the full solution in working context; the cost of
   emitting `edit` drops below the cost of context distillation into a brief. No clause
   forces the lead to stop scouting and delegate. This is a stronger root cause than
   "negative-only": even a perfectly negative preamble can be out-argued at the moment
   the implementation is one `edit` call away.

## Candidate direction (sketch, not decided)

- Positive default up top: "Every implementation, review, or verification task you
  receive is handled by the pipeline below, not by your own hands. Decomposition is your
  first act, before you read the code."
- **Operational, tool-indexed bright-line rule** (advisor refinement, 2026-10-12):
  semantic artifact classification ("describes vs. is the work") is itself a
  rationalization surface — a lead can argue "a test patch describes requirements".
  Instead: the lead's primary execution tools are `subagent_start` / `subagent_prompt`.
  Any `write`/`edit` on application code or tests, or running implementation scripts
  directly, is a hard role breach. No semantic classification needed at decision time.
- **Close the override loophole**: restrict the override clause to a direct, explicit
  instruction in the pane's *own* conversation with the user (e.g. an explicit
  "implement directly yourself" phrasing); a spawning lead's brief wording never
  overrides. (Same direction as 10-07 open question #5.)
- Keep the existing invariants; they remain the backstop.

## Open questions

1. What specific drift was observed this time — same "I'll just do it" shape, or new
   (e.g., delegated one worker and kept the rest)? Determines which clause fails.
2. Are the bundled skills (`subagent-firstmate`, `subagent-handoff`) now in scope, or
   does the 2026-10-07 role-file-only boundary stand?
3. Does this replace, extend, or supersede `20261007-teamlead-role-clarity` (which has
   its own open questions #5/#7 and a "How to measure" section that was never run)?
   Current position: **extend** — a new dated feature dir; the 10-07 history stays
   untouched and is linked as prior art (advisor agreement, 2026-10-12).
4. Note (not an open question): editing `ROLES.teamlead` in `core.ts` breaks the
   verbatim assertion in `tests/roles.test.ts`; any implementation must update that
   test to match the exact new text in the same change.

## Measurement (carry-over from 10-07, still unrun — expanded per 2026-10-12 advisor)

The 10-07 metric (no `write`/`edit` before `subagent_start`) misses two common failure
modes:
1. **Exhaustive scouting:** lead spends many turns reading the repo before spawning a
   worker with an over-specified micro-patch. → Measure: turn count to first
   `subagent_start` (budgeted reconnaissance).
2. **Shallow delegation:** lead delegates implementation but skips the reviewer pane and
   does review/acceptance itself. → Measure: presence of the full implementer +
   reviewer pipeline in the transcript.

Plus the 10-07 baseline: in a spawned `role:"teamlead"` pane with the original drifted
task, post-fix transcript must show `subagent_start` before any `write`/`edit` on
target code.

**Measurement caveat (unverified):** the lead pane's own session JSONL is not a
pre-built artifact; a collection step (locate the pane's session file, filter tool
calls) must be designed before any metric can be computed. Do not claim a metric
exists until that step is run.

## Reassessment log

- 2026-10-12 critical-rethink-sanity pass (second perspective: external advisor review):
  accepted — override-clause loophole as concrete trigger; operational tool-indexed rule
  over semantic classification; two new failure modes (exhaustive scouting, shallow
  delegation) added to measurement; directory renamed 20261113 → 20261012 (real date);
  extend-don't-supersede position. Rejected — advisor's claim that today's drift
  observation is transcript-backed (it is not; single user report only).

## Reference

- Current preamble: `ROLES.teamlead` in `core.ts` (verbatim asserted by `tests/roles.test.ts`)
- Prior feature: `docs/feature-impl/20261007-teamlead-role-clarity/1_idea__teamlead-role-clarity.md`
- Drift transcript: `agent/tmp/pi-focus-guard-20261007.md`
