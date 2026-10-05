---
name: subagent-herdr-supervision
description: "Operational supervision for bounded Herdr workers: launch, observe, recover, and retire them with native subagent_* tools while retaining evidence-based acceptance and cleanup."
---

# Subagent supervision

Use this skill when a bounded worker provides more value than its launch, inspection, and cleanup cost. The Firstmate retains strategy, user communication, integration, and acceptance; a worker owns only its assigned task.

This is an operational skill. Use the native `subagent_*` tools as the normal control plane. The Herdr worker runtime is bundled beside this skill; no legacy supervisor skill installation is required. Profile management is external: use system `pi-profile` when available, otherwise launch Pi directly. Older shell orchestration helpers remain reference material, not the recommended control plane. With system `pi-profile`, profiles default to `minimal`; `PI_WORKER_PROFILE` is an explicit override.

## Before launch

1. Decide that delegation is worthwhile. Do trivial reads, obvious edits, and immediate checks directly.
2. Prepare a complete handoff using [subagent-handoff](../subagent-handoff/SKILL.md): goal, success criteria, exact `cwd`, allowed and forbidden paths/actions, starting evidence, required checks, stop rule, and expected report.
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

## Keep coordination moving

Every delegation needs an explicit follow-through path. Default to lead-owned wait/read until the requested result or blocker is received. Alternatively, tell the worker to ping an exact recipient on completion/blocker, but only through a mechanism known to notify and resume that recipient. A terminal report, delivery receipt, or the mere presence of messaging tools does not prove wake-up. If that return path is unavailable or unverified (including readonly workers without messaging tools), the lead must wait/read instead.

`wait=false` is a submission receipt, not a handoff of follow-through responsibility. Continue useful independent work, then collect the answer proactively at the next coordination checkpoint, before ending the turn without a working wake-up path. Do not promise polling after your turn ends unless an actual scheduler provides it. Use bounded waits; after timeout inspect current state and choose the next wait/recovery action, never silently abandon the worker or blindly resend. Do not wait for the user to remind you.

State who owns the next action. Completion pings must include the result/report location; blocker pings must name the blocker and required decision. The lead reads and acts on them, including telling a blocked worker whether to resume, stop, or remain deliberately parked. Merely acknowledging a ping must not leave both sides waiting.

## Evidence and recovery

- A delivery receipt is not task completion. A timeout, cancellation, or uncertain delivery never authorizes automatic resend.
- A terminal lifecycle observation is not acceptance. Inspect the requested report, relevant output, changed paths/diff when applicable, and proportionate checks.
- `blocked` requires reading the actual question or evidence before clarifying, redirecting, or escalating.
- Clean up temporary owned worker panes at the same checkpoint as result inspection: capture required evidence, independently verify the assignment and related jobs are finished, then close if there is no concrete next assignment. Cleanup is not permission to cancel unfinished work. Do not accumulate finished panes until the overall goal ends. Independently verify absence and update the child registry; failed closure remains an open cleanup obligation. Retention after close is not assumed.
- Before closing an owned controller, reconcile its children: inspect/capture results and close finished temporary children, or confirm an authorized active supervisor has accepted responsibility for each retained child and can access its registry/evidence. Do not orphan live children by closing their only supervisor.
- Keep a pane only for a concrete near-term assignment or an explicitly persistent role, with a clear owner/reason; reassess temporary retention at the next coordination checkpoint. “Might be useful later” is not a retention reason. Never close a user-designated peer or another repository's Firstmate as cleanup; persistent does not mean abandoned.
- Ownership metadata is informational. Use authority and the handoff, not a tool flag, to decide whether control is appropriate.

## Completion

The Firstmate accepts results only after independent inspection. Record durable findings, limits, and next actions in the repository's canonical documentation when they matter beyond the current engagement. Do not leave created panes unmanaged.
