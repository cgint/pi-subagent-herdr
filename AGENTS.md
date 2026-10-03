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
- Git integration handoffs must preserve in-progress merges: inspect and resolve in place; never abort/reset/recreate without lead authorization. Readonly is an assignment boundary, not proof of filesystem isolation: local Git metadata writes were observed despite that mode. Forbid config writes explicitly and independently check side effects; compare hashes using the same algorithm.
- Buddy pane IDs are session-local: obtain or verify the current user-designated pane on re-entry rather than persisting a reusable handle.
- Cross-repository authority clarification: respect the other repository's agent as its Firstmate. Coordinate changes, verification and local memory through messages; do not execute commands against that repository. Do not close or rename its Firstmate pane.

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

## Phase state (2026-10-02)
- 0.2.0 ergonomic contract implemented (9 tools, pane sole address, two-tier freshness, console spread isolation); unit test suite passes (count is not a contract). Automated acceptance and bounded native evidence/limits: docs/ergonomic_acceptance.md. Busy steering, timeout recovery and final corrections are unit-verified; human testing follows the authorized GitHub push. Unit passage alone is not acceptance; cite timestamped observations, never a permanent count.
- Current validated host: Pi 1.0.0, Herdr 0.9.3, Node 22.23.3, TypeBox 1.3.27. Initial registration/footer controls were recorded on Pi 0.99.1. Host SDK/pi-ai/TypeBox are wildcard peers; exact local dev pins follow the validated host.
- Settled: distinct subagent_* names; Escape interrupts, close terminates; reuse the worker runtime, no positional tasks, prompt only after managed detection; terminal waits include idle+done+blocked, delivery/identity/working evidence gates; footer via ctx.ui.setStatus.
- 0.2.0 contract: pane is the sole caller-facing address; no public continuation/cursor/receipt IDs; ownership is informational only (no control gates); prompt defaults wait=true, start defaults wait=false; send defaults to no console; two-tier freshness (terminal_seen_during_submission / state_changed_after_submission); consoleSpread prevents status/seq clobbering.
- Console tails are code-point snapshot suffixes, not assistant answers. Active alternate-screen history uses visible only on typed agent_not_idle; real other read errors remain visible.
- Readonly workers use terminal-only evidence; editable artifacts stay inside worker cwd. The runtime guard has no report-path carve-out, but is not a security sandbox: a readonly reviewer mutated local Git config during acceptance. The lead removed the added setting; runtime hardening is outside this repository's scope. See docs/security.md.
- Verifier-owned test workers/managers/workspaces independently absent. Other-repository Firstmates may remain available as peers, not cleanup targets. Historical pane handles are never reusable; no buddy/user pane was controlled.
- Authorized always-on runtime loading and fresh native editable-controller→readonly-child integration verified; evidence/limits: docs/evidence/nested_worker_live.json. Readonly workers load the extension but their --tools allowlist excludes native tools; default start mode is readonly, so recursive controllers must explicitly be editable.

## Current ergonomic adaptation (2026-10-02)

User authorizes a commit-all checkpoint followed by one or two controller/reviewer/worker implementation teams. Agreed lead/buddy contract and intermediate reasoning: `docs/tool_usage_review.md`. Keep nine session-derived commands; pane ID is the only caller-facing address, no public continuation/cursor. Simplify permission barriers and combine useful wait/console and close/verification workflows; preserve proven startup delivery and honest state-versus-task semantics. Use one team with a sole source writer for tightly coupled core/index/tests, independent readonly reviewer and controller. Internal pending context is memory-only, not a persistent task registry. No hacks, automatic CLI fallbacks, overengineering, multiplexer-adapter expansion, external runtime/config/model edits, packaging or push. Firstmate owns integration and acceptance; user-designated buddy remains an equal-level peer, never a team cleanup resource.

## Declared limits / follow-up
- Installed readonly inline-brief parser quirk persists on0.99.1/1.0.0; extension avoids it via post-detection prompt. Later authorized extension-loading rollout does not repair or rely on positional briefs.
- Multiline send deliberately rejected. Genuine pi-herdr unavailable; conditional co-loading unexecuted, never claimed collision-free.
- Selected Qwen model can loop or suffer upstream errors. A separate348-call pwd loop timed out honestly and was inspected/Escape-recovered; passing20turn batch is functional, not a statistical guarantee.
- Current SDK shrinkwrap pins brace-expansion5.0.9 (one high vulnerable package, three DoS advisories). Explicit Firstmate acceptance/reassessment/upgrade trigger in docs/security.md; no clean audit/suppression/override claim.

## Technical decision authority (user clarification)
The user owns requirements and delegates technical design, implementation and acceptance to the Firstmate, supported by equal-level buddy discussion, bounded workers and independent verification. The earlier human Plan 2 approval gate is superseded; do not ask the user to approve architecture. Escalate only actual requirements/scope/authorization blockers.

## Scope correction — repository-only extension
Original first-version scope: user forbade changes to installed supervisor skill scripts; reuse unchanged runtime, no positional task, prompt after detection. **Targeted later authorization (2026-10-02):** user requested the authoritative `~/.local/bin` runtime/template change to always load `pi-subagent-herdr`, then explicitly requested deployment, commit and push. That repository's Firstmate owns its source/tests/skill docs, generator/deploy workflow and Git; no direct commands against it. Its reported rollout/normal push and this repository's independently verified fresh nested live probe are distinct evidence. Do not generalize authorization to unrelated external edits, config changes, force push or publication.
