# Project Overview: pi-subagent-herdr

## Goal
Replace the bash-heavy `sub-agent-herdr-supervisor` workflow with a native TypeScript Pi extension for Herdr subagent control. Authoritative requirements R-1 through R-10 are in `REQUIREMENTS.md` (including pane ID in the bottom status line).

## Current phase
0.2.0 ergonomic contract implemented (9 tools, pane sole address, two-tier freshness, console spread isolation). Unit test suite passes (count is not a contract). Automated acceptance and bounded native evidence/limits: docs/ergonomic_acceptance.md. Busy steering, timeout recovery and final corrections are unit-verified; human testing follows the authorized GitHub push. Read docs/live_verification.md for exact originals/version scope and declared limits; docs/acceptance.md retains historical live gates. First-version SDK/package smoke, native lifecycle, functional batch, environment, ownership/cancel and cleanup are historical evidence, not a new adapted-code live pass. Later authorized always-on runtime loading has a fresh deployed native editable-controller→readonly-child proof in docs/evidence/nested_worker_live.json. Readonly allowlists exclude native tools, so recursive controllers must explicitly be editable. No worker-model task-completion guarantee or statistical reliability claim.

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
No completed probe should be repeated merely because historical discovery reports said pending. Before a host/runtime upgrade, recheck parser/peer compatibility and SDK advisory pin; rerun relevant automated/live gates in fresh owned scratch scope. Genuine sibling co-loading remains conditional on availability; multiline remains deliberately rejected. Do not reuse recorded handles or modify installed scripts/configuration outside the targeted authorization below.

## Technical decision authority (user clarification)
The user owns requirements and delegates technical design, implementation and acceptance to the Firstmate, supported by equal-level buddy discussion, bounded workers and independent verification. The earlier human Plan 2 approval gate is superseded; do not ask the user to approve architecture. Escalate only actual requirements/scope/authorization blockers.

## Scope correction — repository-only extension
The first version reused unchanged installed supervisor scripts; external parser patch/regression remained forbidden. On 2026-10-02 the user separately authorized the authoritative runtime/template always-on `pi-subagent-herdr` loading change, then deployment, commit and push. The `~/.local/bin` Firstmate owns that repository and its generator/deploy workflow; coordinate through messages, not direct commands there. This does not authorize unrelated external edits/configuration. Extension implementation remains here; never pass positional tasks, and deliver through agent prompt after managed detection.
