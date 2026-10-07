# teamlead-role-clarity — idea

Date: 2026-10-07 · Status: implemented (2026-10-07) — `ROLES.teamlead` hardened in `core.ts` + verbatim test updated; role-file scope only · Owner: Firstmate (user owns requirements)

## One-liner

Make "You are the Teamlead" reliably produce **decompose → delegate → verify** behavior instead of self-implementation, **self-contained within this extension** — no dependency on external skills being installed on the target machine.

## Problem

The term "teamlead" is a borrowed org-chart metaphor. In LLM training data, "tech lead" / "teamlead" overwhelmingly co-occurs with people who also write and ship code. Pure coordination-without-coding is rare in training corpora and usually invisible (the delegation artifact looks like a clean PR, not "I delegated this").

Result: when prompted "you are the teamlead, delegate this," the model minimizes overhead and "just does it."

## Observed drift (2026-10-07, pi-focus-guard session)

1. User: "You are the Teamlead implementing the crazy-find-guard feature."
2. Agent: "I'll implement this directly (it's a cohesive, medium-sized change and I already have the grounding)."
3. User (twice): "why is it not clean to you that you are teamlead and that you should decompose -> delegate to team-members?"
4. Agent rationalized via size/cohesion arguments and its own "do simple work yourself" clause.
5. Settled plan (in session): implementer (editable) → reviewer (readonly) → lead verification; user asked what the initial request needs to make delegation crisp, answer was #1: **explicit role mandate**.

**Session transcript:** `agent/tmp/pi-focus-guard-20261007.md` (exported via `pi-session-to-md`).

## Root causes (verified against code unless marked otherwise)

1. **Missing role context at drift time.** The `firstmate`/`subagent-firstmate` skills were likely NOT loaded in the drifted session's profile — the drift session ran under a different repo/profile than this one, and the transcript does not record which skills were loaded (**inference, unverified**). The role had to be inferred from four English words with zero supporting spec.
2. **The user's own prompt wording is the primary trigger.** "You are the Teamlead **implementing** the crazy-find-guard feature" puts the implementation verb in the lead's own sentence. No role preamble can fix a prompt that assigns implementation to the lead directly; the fix must make that collision explicit ("implementing" must modify the feature's end-state, not the lead's action).
3. **Conflicting escape hatches.** `skills/subagent-handoff/SKILL.md` (line 16) says *"Do obvious local work directly"* and `skills/subagent-herdr-supervision/SKILL.md` (line 8) says *"a bounded worker provides more value than its launch, inspection, and cleanup cost"* — a cost/benefit test the model resolves in favor of the cheaper action (the dominant training prior). The model's stated justification ("cohesive, medium-sized, I already have the grounding") was a textbook cost-benefit rationalization against these instructions.
4. **Fuzzy "simple" threshold.** "Do simple work yourself" gives the model an unlimited rationalization surface: any task can be argued "simple enough."
5. **Scouting → implementation morph.** Reading the codebase to write a good brief is legitimate lead work; but once the model holds the full context, "I might as well implement" is the path of least resistance. No invariant separates "having read the code" from "owning the implementation."
6. **No audit trail.** Without a required reviewer pane or a persisted brief file, the drift was invisible until the user noticed.
7. **Tool-affordance paradox (architectural driver).** In `core.ts` (line ~782), `role: "teamlead"` *requires* `mode: "editable"` because the teamlead needs the native `subagent_*` tools, which the readonly runtime excludes. So a *spawned* teamlead pane's tool belt always contains `write`/`edit` — any prose-level "never modify files" must fight the available tool schema. This is an architectural amplifier of the drift (the drifted pane had full write access), not just a wording problem. The mechanical backstop (open question #3) is the only channel that can fully neutralize it.

### Actor model (delivery boundary) — CORRECTED 2026-10-07 by user

The drifted session **was itself a spawned `role: "teamlead"` pane**, launched by an upstream (root) lead:

```
Root lead (earlier session)
   │ subagent_start(role: "teamlead", mode: "editable")   ← required by core.ts
   ▼
Spawned teamlead pane  ◀── DRIFT HAPPENED HERE
   ROLES.teamlead preamble WAS active (--append-system-prompt, rolePreamble @ core.ts:139)
   │ subagent_start(role: "worker" / "reviewer", ...)
   ▼
workers / reviewers
```

Consequence: `ROLES.teamlead` **is the correct delivery channel for the observed drift** — it was in-context at drift time, so the failure was prose weakness (no size-bypass ban, no scouting-≠-licensing, vague "never modify files"), not missing context. Hardening `ROLES.teamlead` targets exactly the actor that drifted. (A bare root-session lead — user typing "you are the teamlead" directly into their own session, no teamlead pane spawned — is a separate, un-protected actor; a general limitation, not the observed bug.)

## Self-containment constraint (user directive, 2026-10-07)

> "we need to have things self contained in this extension … we can not rely on skill being installed or not on the system where this extension is installed"

Therefore the fix must live **in the extension code**, not in external skill files.

### Delivery channels available in this extension

The extension registers 9 tools (`subagent_*`) in `core.ts`/`index.ts`. Role preambles exist as `ROLES` (`teamlead`, `worker`, `reviewer`, `rubberduck`, `explorer`) — injected into **launched panes** via `--append-system-prompt` (`rolePreamble(role)`), never into the calling session. Per the corrected actor model, the drift happened in a **spawned teamlead pane**, where `ROLES.teamlead` is active — so channel (a) targets the right actor.

| Channel | Covers spawned teamlead panes? | Covers a bare root-session lead? | Notes |
|---|---|---|---|
| `ROLES.teamlead` in `core.ts` | Yes (when launched with `role: "teamlead"`) | No (calling session never gets its own preamble) | **Verified** mechanism; targets the actor where the drift occurred |
| Tool descriptions (`subagent_start` etc.) | Yes | Yes (always in context) | **Hypothesis (unverified):** LLM adherence to tool descriptions is weaker than in-prompt text; treat as auxiliary reinforcement only |
| `subagent_start` return payload / `hint` | — | Yes (at launch moment) | Fires only *after* the lead decided to delegate — cannot protect the earlier edit-or-launch decision |
| New extension command (e.g. `/subagent-teamlead`) | — | Yes (opt-in, via `pi.registerCommand` + `pi.sendMessage`) | Explicit activation; mandate lands in conversation context. **Verified:** Pi SDK supports `pi.registerCommand` (docs/extensions.md:23,77); this extension does not use it yet (index.ts registers only tools + 1 flag) — but it is an available, in-repo channel |
| Session-start message | — | Yes (every session) | Would fire every session; noisy; likely rejected |

**Hypothesis (unverified):** the hardened `ROLES.teamlead` preamble will stop the drift in spawned teamlead panes where the original drifted; prompt-adherence effect is unverified until measured (see "How to measure"). A bare root-session lead (no teamlead pane spawned) is not covered by channel (a) — a residual limitation accepted in the 2026-10-07 scope decision.

## Hardened `teamlead` role preamble (APPLIED to `core.ts` ROLES.teamlead, 2026-10-07)

The live text (verbatim, asserted by `tests/roles.test.ts`):

```text
Role: teamlead (orchestrator / proxy lead).
You act on your caller's behalf. Your product is coordination and acceptance — not code.

Invariants (for application code and tests — no exceptions, no size-based bypass):
1. You NEVER write, edit, or patch application code or tests yourself.
   If a task requires changing repository source or tests, it is DELEGATED.
   (An explicit user instruction to do it directly — any phrasing — overrides;
    say so when acting on it.)
2. Scouting is not licensing: reading specs, code, and test harnesses is
   reconnaissance to write sharp briefs — never a license to implement.
3. No "too small / too cohesive / I already have the context" escape hatches.
   Even a single bounded slice goes through: implementer (editable) → reviewer
   (readonly) → your independent acceptance.

Permitted lead work (your own writes, no delegation needed):
- Handoff briefs, status/docs, pairing memory (AGENTS.md, docs/), workpads.
- Read-only inspection: read, grep, ls, git status/diff/log.
- Final acceptance: inspecting worker evidence and the diff; re-running acceptance
  checks. (For a spawned teamlead, acceptance = inspecting its workers' evidence,
  never re-implementing or re-testing in place of them.)
- Decomposition decisions, course-correction prompts, final acceptance.

Pipeline for every implementation task:
1. Decompose into bounded, verifiable sub-tasks; write a self-contained brief
   (goal, scope, allowed/forbidden paths, evidence contract, stop rule).
2. subagent_start an editable worker with that brief.
3. subagent_start a readonly reviewer to verify the diff against the brief/spec.
4. Independently accept, then report to your caller. Close owned panes after
   evidence capture.
5. On worker failure/block: report it, re-plan with a corrected brief — do not
   absorb the work into yourself.
```

Known wording tension (open): the override clause ("any phrasing") can be read as licensing self-implementation when the spawning lead's brief says "implement X". See open question #5; tightening candidate: restrict override to direct user instructions in the pane's *own* conversation, not brief wording.

Rationale per invariant:
- **#1** closes the "lead writes code" prior head-on (the dominant training-distribution behavior). Scoped to application code/tests so it does not block the lead's own artifacts; the user-override clause prevents a rule-collision trap when the user explicitly says "do it directly".
- **#2** kills the scouting→implementation morph observed in the drift ("I already have the grounding").
- **#3** bans the size-based bypass — the exact rationalization used in the drift ("cohesive, medium-sized").
- **Permitted lead work** prevents accidental self-blockade: the lead must still be able to write briefs, docs, and memory; acceptance stays with the lead.

## Open design questions

1. **Which channel(s) carry the hardened text?** — **DECIDED (2026-10-07, user):** (a) `ROLES.teamlead` in `core.ts` only. No bundled-skill edits, no activation command, no tool-description changes in this change. Root-session lead protection (for leads *without* a teamlead pane) remains out of scope by this decision.
2. **Hard floor vs. eligibility test** — **DECIDED (2026-10-07): hard floor, no carve-outs** (user approved "go for it").
3. **Mechanical backstop (optional, later):** a guard that blocks the lead's own `write`/`edit` while a delegation is active (cf. `docs/feature-impl/20261007-delegation-guard/`). Stronger than prose; requires state tracking; separate feature, not v1. **Boundary:** this entry is the prose-level fix; the mechanical guard is a separate feature-impl.
4. **Test-execution split** — **DECIDED (2026-10-07, user confirmed via "go for it" on the presented wording):** re-running acceptance checks is permitted lead work (final acceptance) at whichever level owns the check; a spawned teamlead's acceptance = inspecting its workers' evidence and the diff, never re-implementing in place of them. The old contradiction was a doc-drafting artifact, not a design gap.
5. **Prompt-trigger collision / brief-wording override hole:** a user (or spawning lead) can word the task "You are the Teamlead **implementing** X" or write a brief that says "implement X" — and the override clause ("any phrasing") can be read as licensing self-implementation from that. Tightening candidate: restrict the override to a direct, explicit instruction in the pane's *own* conversation; wording inside a delegated task brief does not override. Not applied yet (outside role-file scope as approved).
6. **Micro-change overhead:** under the hard floor, even a 1-line fix requires implementer + reviewer panes. Document the operational cost explicitly; consider bundling micro-fixes into larger delegations.
7. **Skill-text precedence:** the bundled skills (`subagent-firstmate`: "do simple work yourself", `subagent-handoff` line 16: "Do obvious local work directly") still conflict with the hardened mandate. User scoped the fix to the role file only (2026-10-07), so this contradiction remains **by decision**, not by oversight. If drift recurs via skill-text rationalization, the escalation path is amending both skill files in-repo.
8. **Measurement prompt contamination:** the before/after scenario re-uses the same ambiguous prompt ("Teamlead implementing X"). The test must target the *spawned teamlead pane* (where the preamble is active); a root-session run is a different channel and would fail by design. Design the scenario to spawn a teamlead pane with the original drifted task.

## How to measure (avoid "I fixed it, but did it?")

- **Drift metric:** in session JSONL, count lead-session `write`/`edit` calls targeting application code or tests that occur while a delegation (spawned worker pane) for that task is active.
- **Before/after scenario test:** spawn a `role: "teamlead"` pane with the original drifted task ("You are the Teamlead implementing X" + bounded spec) — this targets the channel under test (the preamble is only active in the spawned pane). Pre-fix evidence exists (`agent/tmp/pi-focus-guard-20261007.md`); post-fix transcript must show `subagent_start` *before* any `write`/`edit` on target code.

## Next steps

- [x] Decide: hard floor vs. eligibility test → **hard floor, no carve-outs** (user approved).
- [x] Decide the test-execution split (open question #4) → acceptance = lead work; spawned teamlead verifies by inspection.
- [x] Apply the `core.ts` change (preamble text) — role-file only, per user scope decision (2026-10-07). Bundled-skill edits were started, then **reverted** (user: fix applies to the teamlead role only).
- [x] Update the verbatim preamble test in `tests/roles.test.ts` to the new text.
- [ ] Verify the delivered preamble reaches the pane system prompt in a live spawn (one-time spot check; unit tests cover the launch-command construction at `tests/roles.test.ts` line ~342).
- [ ] Define the drift metric and run the before/after scenario test (see "How to measure"); design the scenario to target the spawned teamlead pane (open #8).
- [ ] Tighten the override clause against brief-wording (open #5) — 1-line change in `core.ts`, needs user approval.
- [ ] If drift recurs in a bare root-session lead (no teamlead pane spawned): evaluate channels (b) tool descriptions or (d) activation command — out of scope for the current change.
- [ ] If drift persists after the wording change: scope the mechanical delegation-guard (separate feature, see 20261007-delegation-guard).
- [ ] Scope-bleed guard for later phases: `ROLES.teamlead` targets spawned teamlead panes; a bare root-session lead (without a teamlead pane) is a separate actor and belongs to repo instructions/skills or a future root-session channel, not `core.ts`.

## Verification log (2026-10-07)

- External second-perspective review #1 (advisor) accepted the structure; flagged: (i) test-execution permission vs current `core.ts` "never … execute tests yourself" — captured as open question #4 (now a blocker per critic); (ii) actor-model ambiguity — resolved by the actor model section (itself corrected later by user: the drifted session WAS a spawned teamlead pane); (iii) scope bleed during scoping — captured in open questions + next steps.
- Independent Herdr critique sub-agent (readonly, `teamlead-critic`, 2026-10-07): verdict **NOT ready for scoping** until (1) test-execution split resolved and preamble contradiction fixed, (2) channel (d) verified or dropped.
  - Accepted: root cause #1 was an inference, not verified fact (re-labeled); missing root cause = user prompt wording ("implementing") — added as #2; skill citation errors fixed (`subagent-herdr-supervision` not `supervisor`; exact quote is "provides more value than its launch, inspection, and cleanup cost"); root cause #6 misapplied to root session (now scoped to spawned panes); preamble self-contradiction for spawned panes (fixed with audience-scoped boundary note); override clause too narrow (generalized); skill-text precedence and measurement-prompt contamination added as open questions #6/#7.
  - Rejected: critic's "BLOCKER: verify Pi SDK command registration" — **verified false** in this session: `pi.registerCommand` is documented in Pi's official extension docs (docs/extensions.md lines 23, 77), and the extension's own `index.ts` pattern shows flags + tools registration; `registerCommand` is an available in-repo channel (currently unused). Channel (d) stands, now labeled verified-as-SDK-capability (actual command design still open).
- Code-verified this session: `ROLES` at core.ts ~line 65; `rolePreamble` line 139–140; `role` param ~line 773; teamlead→editable enforcement ~line 782; `--append-system-prompt` injection at core.ts:~890 (attached to the launched worker pane command); 9 tool registrations + 1 flag in index.ts (no commands yet); drift transcript at `agent/tmp/pi-focus-guard-20261007.md` (212 lines).
- **Actor-model correction (2026-10-07, user):** the drifted session was itself a spawned `role:"teamlead"` pane, so `ROLES.teamlead` WAS active at drift time. The earlier "root-session coverage gap / two-actor" framing is **retracted**; the drift was prose weakness (no size-bypass ban, no scouting-≠-licensing, vague "never modify files") inside a preamble that should have bound the pane. `ROLES.teamlead`-only is the correct scope.
- Implementation (2026-10-07): `ROLES.teamlead` replaced with the hardened preamble; `tests/roles.test.ts` verbatim check updated to the new text. `npm test`: 237 pass, 0 fail; `tsc --noEmit`: clean.
- Reverted in the same session: bundled-skill edits (`skills/subagent-firstmate`, `skills/subagent-handoff`) — user scoped the fix to the role file only. The skill-vs-mandate contradiction remains a known residual (open question #7): the bundled skills still say "do obvious local work directly" / "do simple work yourself".
- Remaining uncertainty: prompt-adherence effect of any prose fix is unverified until measured ("How to measure"); which skills were loaded in the drifted session is not derivable from the transcript.

## Reference

- Drift session transcript: `agent/tmp/pi-focus-guard-20261007.md`
- Role preamble source: `core.ts` (`CROSS_CUTTING_RULES`, `ROLES`, `rolePreamble`; `role` param handling around line 751)
- Related: `docs/feature-impl/20261007-delegation-guard/1_idea__delegation-guard.md` (mechanical guard option; direction superseded by this entry's self-containment focus)
- pi-focus-guard pattern reference: `pi-focus-guard/src/focus-guard.ts` (670-line orchestrator with write/discuss/commit guards; the crazy-find guard would slot in as a 4th guard — bounded, spec'd, verifiable, hence delegable by the eligibility test)
