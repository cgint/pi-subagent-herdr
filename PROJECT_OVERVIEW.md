# Project Overview: pi-subagent-herdr

## Goal
Replace the bash-heavy `sub-agent-herdr-supervisor` workflow with a native TypeScript Pi extension for Herdr subagent control. Authoritative requirements R-1 through R-10 are in `REQUIREMENTS.md` (including pane ID in the bottom status line).

## Current phase
**Discovery complete; design and implementation not started.** Peer-reviewed research is committed. User approved patch plus regression/live verification, distinct `subagent_*` names, Escape interruption, and initial bash runtime reuse. The patch has not yet been performed. No implementation approach or tool schema has been approved.

## Read on return
1. `AGENTS.md` — standing collaboration/memory rules.
2. `REQUIREMENTS.md` — verbatim requirements.
3. `docs/findings.md` — canonical evidence, caveats, open decisions (§6).
4. `docs/HANDOFF.md` — continuation steps and cross-machine dependencies.

## Document map
- `plan_1_information_gathering.md`, `docs/plan.md`: investigation plans, not architecture specifications.
- `docs/worker*_report.md` and `docs/worker3_session_mining_report.md`: research reports (see handoff for exact mapping).
- Worker handoffs and `docs/fritz_followup.md`: archival task boundaries.

## Next step
Verify the authorized live-skill patch, then write Plan 2 (design) with peer review and user agreement before implementation. Resolve machine-local dependencies before live experiments. Original pane IDs and absolute paths are historical references, not reusable handles.
