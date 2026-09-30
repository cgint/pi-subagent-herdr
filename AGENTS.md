# Repository Guidelines & Memory: pi-subagent-herdr

## Mission & Purpose
Build a native Pi extension (`pi-subagent-herdr`) that provides direct tools to Pi coding agents for managing and interacting with sub-agents running in Herdr workspaces/panes. This replaces the bash-script-heavy `sub-agent-herdr` skill with ergonomic, first-class Pi extension tools.

## Key Directives & Workflows
- **Core Values:** Honest progress over appearance; no workarounds as final state; ground and verify with live tool execution and code inspection.
- **Firstmate & Supervision Roles:** Horst (lead) coordinated discovery with Judith (original pane `w2V:p2`, historical only) and bounded workers. On another machine establish a fresh peer; never reuse old pane IDs without verification.
- **Re-entry Routine:** Read `AGENTS.md`, `PROJECT_OVERVIEW.md`, `REQUIREMENTS.md`, `docs/findings.md`, and `docs/HANDOFF.md` before continuing.

## Collaboration roles
- The lead remains the user's Firstmate and owns strategy, integration, acceptance, and the user conversation. Use the user-designated buddy as an equal-level discussion partner, not as a grunt-work delegate.
- Delegate bounded grunt work to cheap, capable subagents when the work warrants delegation. Verify evidence independently and clean up owned panes; never rename or close the user's buddy pane.
- Buddy pane IDs are session-local: obtain or verify the current user-designated pane on re-entry rather than persisting a reusable handle.

## Durable Pairing Memory & Standing Stewardship Contract
- **Durable Pairing Memory:** Repository-owned, filesystem-persisted knowledge that enables future sessions to continue without losing intent, constraints, or decisions.
- **Remembering Contract:** Remembering is complete only when persisted to the filesystem. Chat context or promises to write later do not count; if blocked, report **not persisted**.
- **Stewardship Duty:** Agents hold proactive authority, responsibility, and accountability to curate, maintain, correct, and prune pairing memory without waiting for explicit prompts.
- **Curation Standard:** Memory is future-oriented curation, not a log of current session effort. Use the filter: **FUTURE → CONSEQUENCE → ESSENCE → HOME**:
  - *Future:* Who will use this later, and when?
  - *Consequence:* What action, decision, bug, or costly rediscovery does it prevent?
  - *Essence:* What is the smallest stable statement preserving that value?
  - *Home:* What canonical file owns it?
- **Immediate Triggers:** User statements indicating information matters for future work ("remember this", "take note") override agent discretion on whether to persist (while respecting scope and brevity).
- **Memory Checkpoint:** Before concluding meaningful work, identify durable findings, update canonical files, prune stale notes, and report updates clearly.
- **Memory Boundary:** Repository-owned docs (`AGENTS.md`, `PROJECT_OVERVIEW.md`, `docs/`) hold durable knowledge. `agent/` is strictly for agent-internal ephemeral scratch/work artifacts.

## Phase State (updated 2026-09-30)
- **Discovery complete.** `docs/findings.md` v2.1 (commit `0b2df33`) is signed off by Judith; all evidence committed (worker reports, handoffs, plans). Re-entry: read `REQUIREMENTS.md` (R-1..R-10 verbatim) + `docs/findings.md`.
- **User decisions approved in continuation:** distinct `subagent_*` names; Escape for interruption and pane close for termination; initial bash runtime reuse; live-skill patch plus regression test and isolated live verification. Patch not yet performed. Plan 2 still needs peer review and user agreement.
- **Settled design constraints (do not re-litigate):** task delivery via `herdr agent prompt` post-detection, never positional payload at launch (pi 0.99.1 `--dm-read` swallows inline briefs in readonly mode — §3.1); terminal-state waits must race `idle`+`done`; any seq-gated wait needs delivery proof (caveat 12); worker launch must load `herdr-agent-state.ts`; R-10 footer via `ctx.ui.setStatus`.

## Current Risks & Open Loops
- **Live skill bug (authorized patch pending):** readonly + `--brief` launches in `pi-worker-runtime.sh` silently lose the task (pi 0.99.1 parses `--dm-read` as unknown flag and swallows the next positional). Fix candidate `--dm-read=1` is parseArgs-verified, not yet launch-tested.
- Tool-name collision with pi-herdr if both extensions load (unknown until tested).
- Multi-line `pane send-text` behaviour undetermined (minor, R-5).
- `--dm-read` parser behaviour is pinned to pi 0.99.1; re-verify on Pi updates.
