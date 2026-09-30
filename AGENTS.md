# Repository Guidelines & Memory: pi-subagent-herdr

## Mission & Purpose
Build a native Pi extension (`pi-subagent-herdr`) that provides direct tools to Pi coding agents for managing and interacting with sub-agents running in Herdr workspaces/panes. This replaces the bash-script-heavy `sub-agent-herdr` skill with ergonomic, first-class Pi extension tools.

## Key Directives & Workflows
- **Core Values:** Honest progress over appearance; no workarounds as final state; ground and verify with live tool execution and code inspection.
- **Firstmate & Supervision Roles:** Horst (lead) coordinates with Judith (`HERDR_PANE_ID=w2V:p2`, coordinator/cross-checker) and delegates bounded tasks to dedicated workers.
- **Re-entry Routine:** Read `AGENTS.md`, `PROJECT_OVERVIEW.md`, and `REQUIREMENTS.md`.

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

## Current Risks & Open Loops
- Herdr CLI version compatibility and JSON output parsing guarantees.
- Proper process lifecycle management for synchronous vs. async console waiting without blocking Pi's UI/event loop.
- Exact mapping of Pi's interrupt signal (CTRL-D for Pi sessions) via Herdr's pane interaction primitives.
