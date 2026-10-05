---
name: subagent-handoff
description: Prepare bounded subagent assignments and compact evidence reports for workers that do not share the lead's conversation context.
---

# Handoff

Use this skill when delegating work to a worker that cannot see the lead's conversation or prior runs.

A handoff is a context boundary, not a transcript dump. Give the worker the facts needed to act safely; keep raw command output and routine mechanics in the worker context. The Firstmate retains intent, architecture, integration, and acceptance.

This skill owns assignment and report content. [Subagent Herdr supervision](../subagent-herdr-supervision/SKILL.md) owns launch, observation, recovery, and pane cleanup.

## Delegate deliberately

Delegate only when independent evidence, isolation, parallelism, or bounded execution outweighs coordination cost. Good uses include source scouting, an independently bounded implementation, and review/verification. Do obvious local work directly.

Use stable role labels when more than one worker is involved. State each worker's return path and escalation condition. A controller records every launched child in a lead-visible registry: pane ID, role, operating owner, lifecycle state, and final keep/close disposition. A user-designated peer is not an owned worker.

## Handoff brief

Provide the following information, concisely and explicitly:

- **Recipient and role:** scout, implementer, reviewer, or controller; a controller includes its lead-visible child-pane registry.
- **Goal and success criteria:** one coherent objective and observable completion conditions.
- **Repository state:** absolute repository root, branch/commit when relevant, and material working-tree or failure evidence.
- **Launch directory:** exact absolute `cwd`; for editable work, the narrowest tree containing every authorized write.
- **Scope:** allowed paths/actions and clear non-goals.
- **Starting points:** important files, symbols, commands, and evidence.
- **Checks:** proportionate commands or observations the worker must perform.
- **Stop rule:** when uncertain, blocked, or outside scope, stop and report rather than improvise.
- **Report channel:** terminal report for readonly work; approved artifact/diff only when explicitly authorized for editable work.
- **Return and escalation:** who receives the report; escalate only a decision, blocker, contradiction, or scope change.

A compact template:

```md
## HANDOFF

Recipient/role: <name or pane role>
Goal: <one sentence>
Success criteria:
- <observable condition>

Repository state: <absolute root; branch/commit; relevant status or failure>
Launch directory: <absolute cwd>
Allowed: <paths and actions>
Forbidden/non-goals: <paths and actions>
Starting points: <files, symbols, commands, evidence>
Required checks: <commands or observations>
Stop rule: <when to stop and report>
Report channel: <terminal-only | authorized artifact path>
Return/escalation: <recipient; conditions>
```

## Work report

Ask for a compact report, not a claim of acceptance:

```md
## WORK REPORT

Outcome: <completed | blocked | incomplete>
What I did: <bullets>
Evidence: <paths, line ranges, command outcomes>
Changed files: <none | list>
Checks: <command/observation → result>
Uncertainties or contradictions: <none | bullets>
Recommended next step: <one bounded action>
```

The lead independently inspects output, diff/status, and proportionate checks. A worker's “tests passed” statement is evidence to inspect, not acceptance.

## Guardrails

- No hidden context: include facts the worker cannot infer.
- Keep write scope narrow and explicit.
- Do not use the handoff to delegate ambiguous requirements, architecture, or final acceptance.
- Preserve uncertainty. A worker must report missing information rather than guess.
