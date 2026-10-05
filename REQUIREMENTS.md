# Requirements: Pi Subagent Herdr Extension

The extension has to:
- R-1) allow to start sub agent (read-only, read-write, ...) jus as the scripts allow
- R-2) allow to decide to wait for fininsh directly or to return immediately e.g. after x seconds with the last 50 characters from the console
- R-3) allow to get console content 
- R-4) allow to wait for a console to 'finish' (--wait) and then return with the last x chars of console
- R-5) allow to send text with <enter> to another pane
- R-6) allow to send an interrupt to another pane using Escape for Pi (the only supported agent). CTRL-D exits Pi; it is not a turn interrupt.
- R-7) allow to list all panes within the same herdr-space (including names and status)
- R-8) list herdr-spaces
- R-9) close a pane
- R-10) in the bottom line the HERDR-PANE-ID has to be displayed if pi is running within a herdr pane

We need to gather information in a way so that the behaviour and the caveats of using those tools the agents had can be learned and we can address this in the extension!

## Confirmed purpose and scope (2026-10-03)

These clarify the existing requirements; they do not add new functional commands
or authorize implementation outside the agreed work.

- **Single operational basis:** pure Herdr + this extension as an ergonomic wrapper
  for agents' most-used Herdr operations. Do not require another agent orchestration
  or messaging system to perform the existing workflows.
- **Useful convenience, not bare CLI parity:** preserve evidence-backed composites
  such as launch/readiness/prompt, prompt/wait/console and close/absence verification.
  Simplify agent use without hiding errors or overstating guarantees.
- **Pattern-neutral:** support agents and existing peers without imposing a role
  hierarchy, task graph, mandatory handoff protocol or automatic worker cleanup.
  Collaboration policy and acceptance remain with the agents/user, not the wrapper.
- **No competing orchestration framework:** do not introduce a scheduler, broker,
  persistent task registry or ownership-based access policy. Minimal in-memory
  submission context supports honest observations, not task ownership.
- **Observable, explicit control:** distinguish agent prompts from raw text+Enter;
  submission from consumption; terminal state from task success; wait cancellation
  from worker interruption; interruption from pane closure. Preserve bounded console
  inspection and deliberate follow-up/cleanup.
- **Pragmatic and experimental:** Pi coordinating → Herdr → Pi executing is useful
  on its own and lets us learn collaboration patterns for the broader deliberate-agent
  direction. POCE/GENIETABLE and potentially BEAM/OTP are not to be rebuilt here.
  Conceptual multiplexer replaceability does not require cmux/orca adapters now.

Existing interface clarifications: `docs/tool_usage_review.md`. The separately
agreed first/all multi-pane observation helper remains covered by
`docs/multi_pane_wait.md`; it is not a new scheduler or new requirement from this
reassessment. Broader reasoning: `docs/pi_subagents_gap_analysis.md`.

## Open evidence questions — not new promised features

Busy-parent notifications, correlated task replies, readonly-worker callback paths
and observable decision/wait dependencies need evidence before any capability or
mechanical deadlock/recovery guarantee is claimed. Preserve runtime/tool restrictions;
do not bypass them or build speculative machinery to close these gaps. Findings
may justify a later scoped requirement, but this discussion does not add one.