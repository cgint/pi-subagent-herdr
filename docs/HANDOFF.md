# Cross-machine handoff

## Resume here

Read, in order:
1. `AGENTS.md` — collaboration and memory rules.
2. `REQUIREMENTS.md` — authoritative user requirements R-1 through R-10.
3. `docs/findings.md` — discovery synthesis, evidence labels, caveats, and four pending decisions (§6).
4. This file — portability and next steps.

## Current state

Discovery is complete and peer-reviewed by Judith. No TypeScript extension, package setup, implementation, or implementation tests exist yet. `docs/plan.md` and `plan_1_information_gathering.md` are investigation plans, **not an approved architecture**. Tool names in older overview/planning material are illustrative, not agreed schemas.

Evidence was committed in `0b2df33`; pairing memory in `81b1750`. Judith inspected the committed findings and explicitly agreed that the four decisions can be presented. Her important correction is preserved in findings R-2 and caveat 12: the supposed fast-task completion in the real-wrapper experiment was actually startup after an **undelivered** brief. It does not validate fast-task completion. The subsequent prompt-delivered working→done experiment is valid.

## User decisions — approved in continuation

- **Live skill:** patch plus regression test, then isolated live-launch proof of task receipt. Authorized, not yet performed.
- **Tool overlap:** distinct `subagent_*` names.
- **Interrupt:** Escape aborts a turn; pane close terminates the session. This is the user-approved clarification of R-6.
- **Worker runtime:** reuse the tested bash runtime initially; native TypeScript tools orchestrate it.

The lead remains Firstmate. The user-designated buddy is an equal-level discussion partner; cheap, capable workers handle bounded grunt work. Verify the current buddy pane before interaction; do not own or close it.

## Next work

1. Execute the authorized live-skill patch workflow below after inspecting the destination runtime; verify independently and persist the outcome.
2. `docs/plan_2_design.md` is prepared and reviewed with the current user-designated buddy, who found no remaining approval blockers. Obtain user agreement before extension implementation. Runtime patch remains authorized but unperformed.
3. Carry delivery proof into the wait condition itself: terminal state plus advanced seq is not enough. Recommended delivery is `herdr agent prompt` after detection, with baseline taken for that agent after startup. Wait for both `idle` and `done`; do not equate blocked/timeout with successful work.
4. If a live-skill patch is authorized, inspect the destination machine's runtime first, regression-test parsing and perform an isolated live launch proving receipt, then clean up owned panes. Do not assume the candidate fix is already verified end-to-end.

## Portability: external dependencies are not in this repository

The repository contains research artifacts, not the external source trees, skill runtime, Pi installation, Herdr installation, or raw session logs. Worker reports preserve extracted evidence and local source references; those absolute paths are historical provenance, not portable instructions. Restore or locate the following on the destination machine before live work:

- Herdr CLI (research used **0.9.3**) and Pi (research used **0.99.1**); record actual destination versions and recheck version-sensitive conclusions.
- `sub-agent-herdr-supervisor` skill and its `scripts/`: `herdr-start-subagent.sh`, `herdr-worker.sh`, `pi-worker-runtime.sh`, `herdr_prompt_agent.sh`, `herdr_await_agent.sh`, observation library and launcher tests.
- Worker profile (`minimal` in the investigation), `pi-profile`, provider authentication/model availability, focus-guard/tool-intent/provider extensions, and especially `herdr-agent-state.ts` lifecycle reporting.
- Sibling `pi-herdr` repository if comparing or reusing its implementation.
- Pi SDK documentation/examples matching the installed version before implementation.

Original source root: `/Users/christian.gintenreiter/.pi/profiles/minimal/agent/skills/sub-agent-herdr-supervisor/scripts/`. Pi was installed under `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/`. Resolve equivalent paths on the destination; do not hardcode these.

The source machine had `PI_WORKER_DEFAULT_MODEL` set to a qwen cloudrun model. Check destination environment rather than assuming model selection. **No `.sub_agent_conf` belongs to this repo**: the user explicitly removed it; do not recreate it automatically.

The original peer pane `w2V:p2` (Judith), lead pane `w2V:p1`, and scratch workspace `w35` are session-local identifiers. Do not target them on another machine. Research workers and scratch workspace were cleaned up; establish a fresh peer and verify current pane/workspace ownership before interacting. Old handoffs are archival, not instructions to relaunch workers.

## Evidence map

- `docs/worker1_report.md`: Fritz, CLI experiments and interrupt/wait follow-ups.
- `docs/worker2_report.md`: Clara, runtime scripts, sibling extensions, Pi API.
- `docs/worker3_session_mining_report.md`: Stefan, session-level CLI usage.
- `docs/worker4_script_usage_report.md`: Wilhelm, skill-script usage and failure patterns.
- `docs/findings.md`: canonical synthesis, including lead's real-wrapper/parser experiments and peer corrections. Raw scratch captures/session logs were not committed; precise parser behavior should be reproduced against destination Pi rather than treated as permanent.

## Git transfer

No Git remote was configured when this handoff was prepared. User will commit/push and clone on the other machine. Ensure all handoff updates are committed and pushed; after cloning check `git status --short` and read this file before resuming. Do not assume local chat history, installed skills, or session state travels with Git.
