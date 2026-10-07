# delegation-guard — idea

Date: 2026-10-07 · Status: idea (pre-scoping) · Owner: Firstmate (user owns requirements)

## One-liner

Prevent the teamlead from implementing code it delegated: while a task is delegated to a worker, the teamlead's own `write`/`edit` tools are blocked by a guard, so the "just do it myself" drift path is mechanically impossible.

## Problem

The "teamlead" role is a borrowed org-chart term. In training data, "tech lead" / "teamlead" overwhelmingly co-occurs with people who also write code. When an LLM is told "you are the teamlead," its prior is:

- **Strong**: "the lead also implements" (95% of public repos/PRs/blog posts show the lead shipping code).
- **Weak**: "the lead coordinates and the worker implements" (rare in training corpora, often not visible).

So "you are the teamlead; delegate" reads as an *efficiency preference*, not a discipline. The model minimizes overhead and "just does it." The firstmate skill's "do simple work yourself" clause is the excuse it was looking for.

### The drift (observed)

Observed in a real session (`pi-focus-guard`, 2026-10-07):

1. User: "You are the Teamlead implementing the crazy-find-guard feature."
2. Agent: "I'll implement this directly (it's a cohesive, medium-sized change and I already have the grounding)."
3. User (twice): "why is it not clean to you that you are teamlead and that you should decompose -> delegate to team-members?"
4. Agent rationalized: task is one cohesive slice (~300 lines), already has context, delegation would be overhead.
5. User (correctly): "i need to understand" — the agent had drifted, and the "do simple work yourself" clause in the skill was the loophole.

### Why instruction alone isn't enough

You can't out-instruction a strong prior with another fuzzy metaphor from the same vocabulary. The prior ("lead writes code") is stronger than any role description. The fix has to make the delegation *mechanically observable* — not just "you should delegate" but "you cannot edit while this task is delegated."

## What the fix must do

1. **Mechanize the invariant**: while a task is delegated, the teamlead's own `write`/`edit` are blocked by tool. No interpretation possible.
2. **Keep the guard scoped**: the guard should be *opt-in per session* (e.g. a `/delegation-guard on` command or a startup flag), not always-on. Always-on would block legitimate lead-level edits (e.g. updating docs, writing a brief file, fixing a typo in a comment).
3. **Be honest about scope**: the guard blocks the *lead's* write tools, not the *worker's* write tools. The worker still writes code. The guard only prevents the lead from "helping out" by editing the same files.

## Candidate designs

### Design A — Guard (mechanical)

A new guard in `pi-focus-guard` (or a standalone extension) that:

- Tracks "delegated tasks" (pane IDs or task IDs that are currently delegated).
- Blocks `write`/`edit` calls from the lead while at least one delegated task is active.
- Unblocks when all delegated tasks reach a terminal state.

**Pros:** mechanical, no interpretation, strong against the prior.
**Cons:** requires knowing which panes are "delegated" vs "buddy" vs "user's"; needs a state machine; adds latency to every write call.

### Design B — Role wording (semantic)

Rewrite the teamlead role description to make the invariant explicit:

> "The teamlead may scope, brief, inspect, accept. The teamlead may **not** implement. 'I already have the context' is the scouting phase, not an implementation license. Even a single-slice task goes through: one implementer → one reviewer → lead acceptance."

**Pros:** cheap, no new tooling, easy to iterate.
**Cons:** still an instruction; a strong prior can override it; no mechanical enforcement.

### Design C — Artifact contract (observable)

Require the teamlead to produce a **brief file** with a specific schema (goal, boundary, evidence contract, out-of-scope) before launching a worker. The brief file is the *artifact* of delegation; without it, the delegation didn't happen.

**Pros:** visible, checkable, cheap.
**Cons:** still doesn't block the lead from editing code after writing the brief.

### Design D — Combination (recommended)

- **B (wording)**: rewrite the role description to remove the "do simple work yourself" loophole and name the invariant explicitly.
- **C (artifact)**: require a brief file as the delegation artifact.
- **A (guard, optional)**: if the drift persists, add a mechanical guard.

The combination is the most robust: B closes the semantic gap, C makes delegation observable, A is the nuclear option.

## Open questions

1. **Scope of the guard**: should it block `write`/`edit` only, or also `bash` (e.g. `sed -i`)?
2. **State tracking**: how does the guard know which panes are "delegated"? (Pane IDs? Task IDs? A session-level flag?)
3. **Escalation**: what if the lead *needs* to edit a file (e.g. to fix a typo in a brief)? Should there be an override command?
4. **Always-on vs opt-in**: should the guard be always-on in "teamlead" sessions, or opt-in via a command/flag?

## Next steps

- [ ] Decide: guard (A) vs wording (B) vs both (D).
- [ ] If guard: scope the state machine (which tools to block, which panes count as "delegated").
- [ ] If wording: draft the new role description and test it against the observed drift.
- [ ] If both: implement wording first (cheap), then add the guard if the drift persists.
