# Project Overview: pi-subagent-herdr

## Goal
Replace the bash-heavy `sub-agent-herdr-supervisor` workflow with a native TypeScript Pi extension for Herdr subagent control. Authoritative requirements R-1 through R-10 are in `REQUIREMENTS.md` (including pane ID in the bottom status line).

## Current phase
First-version functional requirements independently verified. Read docs/live_verification.md for exact originals/version scope and declared limits; docs/acceptance.md retains unchanged gates. Strict currentSDK/typecheck/unit/package smoke, actual native lifecycle, fixed functional batch, direct environment, ownership/cancel and independent cleanup are evidenced. No worker-model task-completion guarantee or statistical reliability claim.

## Read on return
1. `AGENTS.md` — standing collaboration/memory rules.
2. `REQUIREMENTS.md` — verbatim requirements.
3. `docs/findings.md` — discovery evidence, caveats; current approved choices separated at §6.
4. `docs/acceptance.md` — requirement-to-evidence matrix and live acceptance gates.
5. `docs/HANDOFF.md` — continuation steps and cross-machine dependencies.

## Document map
- `docs/plan_2_design.md`: the approved-by-delegation design (tool surface, outcomes, verification gates).
- `docs/acceptance.md`: current acceptance state and live gates per requirement.
- `plan_1_information_gathering.md`, `docs/plan.md`: investigation plans, not architecture specifications.
- `docs/worker*_report.md` and `docs/worker3_session_mining_report.md`: research reports (see handoff for exact mapping).
- Worker handoffs and `docs/fritz_followup.md`: archival task boundaries.
- `agent/`: ephemeral worker reports/handoffs (not pairing memory).

## Next step
No completed probe should be repeated merely because historical discovery reports said pending. Before a host/runtime upgrade, recheck parser/peer compatibility and SDK advisory pin; rerun relevant automated/live gates in fresh owned scratch scope. Genuine sibling co-loading remains conditional on availability; multiline remains deliberately rejected. Do not reuse recorded handles or modify installed scripts/configuration.

## Technical decision authority (user clarification)
The user owns requirements and delegates technical design, implementation and acceptance to the Firstmate, supported by equal-level buddy discussion, bounded workers and independent verification. The earlier human Plan 2 approval gate is superseded; do not ask the user to approve architecture. Escalate only actual requirements/scope/authorization blockers.

## Scope correction — repository-only extension
User explicitly forbids changes to the installed supervisor skill scripts. External live-skill patch/regression is removed from scope, superseding earlier authorization and plan gates. Reuse the installed worker runtime unchanged with no positional task; deliver through agent prompt after detection. Implement and test all extension changes in this repository.
