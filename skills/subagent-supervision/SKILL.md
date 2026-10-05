---
name: subagent-supervision
description: "Operational supervision for bounded workers: launch, observe, recover, and retire them with native subagent_* tools while retaining evidence-based acceptance and cleanup."
---

# Subagent supervision

Use this skill when a bounded worker provides more value than its launch, inspection, and cleanup cost. The Firstmate retains strategy, user communication, integration, and acceptance; a worker owns only its assigned task.

This is an operational skill. Use the native `subagent_*` tools as the normal control plane. The imported shell scripts are reference material, not a self-contained fallback.

## Before launch

1. Decide that delegation is worthwhile. Do trivial reads, obvious edits, and immediate checks directly.
2. Prepare a complete handoff using [handoff](../handoff/SKILL.md): goal, success criteria, exact `cwd`, allowed and forbidden paths/actions, starting evidence, required checks, stop rule, and expected report.
3. Choose `readonly` for scouting/review and `editable` only for bounded implementation. A readonly worker cannot call native lifecycle tools; a recursive controller must be explicitly editable.
4. Treat a user-designated peer as external. Do not rename, interrupt, or close it.
5. A controller records every child it launches in a lead-visible registry: pane ID, role, operating owner, lifecycle state, and final keep/close disposition. Update it at launch and closure so the lead can recover a child if the controller fails.

## Native lifecycle

| Need | Tool | Rule |
| --- | --- | --- |
| Launch | `subagent_start` | Give a complete `task`, explicit absolute `cwd`, and deliberate mode. Address the returned pane only after managed-agent detection. |
| Inspect | `subagent_read`, `subagent_list`, `subagent_spaces` | Read current evidence before deciding whether to prompt, wait, recover, or close. |
| Follow up | `subagent_prompt` | Send one bounded request. Busy prompting is supported, but an observation can reflect the prior turn. |
| Observe | `subagent_wait` | A terminal state means inspect now, not accept automatically. Use multi-pane waits only when one aggregate observation is useful. |
| Raw terminal input | `subagent_send` | Use only for a single terminal command, never as the normal agent-turn mechanism. |
| Recover | `subagent_interrupt` | Escape requests cancellation; it does not prove the worker stopped. Inspect afterward. |
| Retire | `subagent_close` | Close only after capturing evidence and making a deliberate disposition decision. It terminates the pane process. |

Native tools run in a Herdr pane and identify targets by pane ID. There is no native public `agent get`: use the inspection tools above.

## Evidence and recovery

- A delivery receipt is not task completion. A timeout, cancellation, or uncertain delivery never authorizes automatic resend.
- A terminal lifecycle observation is not acceptance. Inspect the requested report, relevant output, changed paths/diff when applicable, and proportionate checks.
- `blocked` requires reading the actual question or evidence before clarifying, redirecting, or escalating.
- Keep a pane only when its context has a concrete near-term use. Otherwise close it after independent inspection. Capture required terminal evidence before close; retention after close is not assumed.
- Ownership metadata is informational. Use authority and the handoff, not a tool flag, to decide whether control is appropriate.

## Completion

The Firstmate accepts results only after independent inspection. Record durable findings, limits, and next actions in the repository's canonical documentation when they matter beyond the current engagement. Do not leave created panes unmanaged.
