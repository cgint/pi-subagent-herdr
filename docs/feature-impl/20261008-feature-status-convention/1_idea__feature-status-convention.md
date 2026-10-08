# feature-status-convention — idea

Date: 2026-10-08 · Status: idea (pre-scoping) · Owner: Firstmate (user owns requirements)

Origin: end-of-discussion handoff from a Strict-Discuss session (READ-ONLY). No repo docs were modified in that session.

## Repo / context

- Repo: `/Users/christian.gintenreiter/dev-external/pi-subagent-herdr`
- Re-entry reading (per AGENTS.md / docs/HANDOFF.md): AGENTS.md, REQUIREMENTS.md, docs/findings.md, docs/acceptance.md, docs/live_verification.md. Only the feature-impl part was in scope of this discussion.
- User owns requirements; Firstmate (agent) owns design. Don't ask user to approve architecture; escalate only scope/authorization blockers.
- User preferences observed this session: concise, structured, no feature-content summaries unless asked, stay strictly on the user's input, ASCII diagrams welcome when simple.

## The topic: a status for feature-idea docs in `docs/feature-impl/`

User's original observation: "what i miss is a status in that feature-idea".

### Current state (verified)

- Convention lives in `docs/feature-impl/README.md`. It defines directory naming `<YYYYMMDD>-<short-name>/` and file naming `<n>_<phase>__<short-name>.md` (`1_idea`, `2_requirements`, `3_plan`, free-form extras). It has a "Status" column — but that column describes whether each *file type* is optional, NOT a feature lifecycle status. No status vocabulary is defined.
- Ad-hoc `Status:` lines that exist (verified via grep):
  - `20261007-delegation-guard/1_idea__…` → `Status: idea (pre-scoping)`
  - `20261007-teamlead-role-clarity/1_idea__…` → `Status: implemented (2026-10-07) — …` (long prose)
  - `20261008-agent-end-pane-reminders/1_idea__…` → `Status: idea (pre-scoping)`
  - `20261020-herdr-stage-support/1_idea__…` → `Status: idea (pre-scoping)`
  - `20261007-herdr-fork/3_plan__…` → `> **Status:** Guidance / Draft` (blockquote, different format, in the PLAN not an idea file)
  - `20261007-herdr-fork/` has NO `1_idea__` file (only `2_requirements__` and `3_plan__`).
- Nothing in `src/` or skills reads or enforces these status lines (grep of feature-impl + skills found no shared vocabulary).
- Git: `20261008-agent-end-pane-reminders/` has no git history result in my check (may be untracked/new) — unverified whether committed.

### Problem statement (as understood)

Status is inconsistent (3+ phrasings), undefined (no vocabulary), and not in the convention, so a reader can't tell at a glance whether an idea is alive, parked, or done.

### Open design decisions (NOT decided — user owns the call)

1. **Placement:**
   - (a) per-doc header `Status:` line, standardized + vocabulary documented in README. (Agent's lean: minimal, matches existing pattern, self-describing docs.)
   - (b) status column in README index table (portfolio view), docs stay content-only.
2. **Axis:**
   - doc-phase (how far the document has progressed) vs.
   - feature-state (is it being built / blocked / done / parked / superseded).
   - Today's `implemented` conflates both (teamlead doc is "done" but has open measurement questions).
3. **Vocabulary** (not yet agreed). Candidate, unvalidated: `idea → scoped → planned → implementing → implemented → parked | superseded`.
4. Whether `herdr-fork`'s missing idea file is a convention gap or intentional (unanswered; do not assume).

### Things I got wrong in this session (do not repeat)

- Over-solutioned early (offered design menu) before confirming what the user wanted.
- Summarized feature contents repeatedly after the user said not to.
- Did not pivot promptly when the user corrected focus.
- Claimed "no status" for herdr-fork based on absence of idea file without checking plan/requirements status lines (the plan does have a status line: "Guidance / Draft").

### Verification state

- All findings above are from direct reads/greps in this session.
- No tests run (none relevant: docs-only topic).
- No files in the repo modified.

## Suggested first steps for the new session

1. Re-read `docs/feature-impl/README.md` and the 5 status-bearing files (listed above) to re-ground.
2. Ask the user ONE question: placement (a) vs (b), and axis (doc-phase vs feature-state).
3. Only after the answer: propose the minimal vocabulary + README edit; wait for go-ahead before writing (user's standing rule: discuss first, do not implement without direction).
4. Do not touch feature content (idea/requirements/plan prose) — scope is the status convention only.

## Out of scope for this topic

- Feature content, designs, or implementation of any of: herdr-fork, herdr-stage-support, teamlead-role-clarity, delegation-guard, agent-end-pane-reminders.
- Changes to `src/` or `tests/`.
