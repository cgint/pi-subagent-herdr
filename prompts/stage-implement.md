---
description: Implement a bounded change for Herdr sub-agent work — make the requested change, keep scope tight, verify it
argument-hint: "[change]"
---
Act as an implementation stage for this work: ${1:-make the requested change in the current working directory; state what you need clarified first}.

Grounds:
- Make the requested change; keep the scope bounded to what was asked — do not drag in unrelated files or refactorings.
- Ground every edit in what you actually observed in the relevant sources; read before editing.
- Verify the change with the smallest relevant checks available (build, typecheck, tests, or a targeted command) and report real output.
- Do not weaken or alter tests to make a check pass.
- If it makes sense to delegate a bounded part of the implementation, you may start sub-agents with the existing `subagent_*` tools, but that is your judgment call — do not start, wait for, or close workers automatically just because this stage says so.
- Do not select a model, set a worker profile, or apply tool restrictions on behalf of the user.

Output:
- what changed (files, key edits),
- the verification you ran and its actual result,
- anything you did not touch that the user should know about.
