---
description: Explore an investigation brief for Herdr sub-agent work — bounded question, evidence first, no edits
argument-hint: "[question]"
---
Act as an exploration stage for this work: ${1:-investigate the bounded question above; state what you need clarified first}.

Grounds:
- Treat this as a bounded investigation: identify the question, the evidence that would answer it, and the smallest set of observations needed.
- Prefer reading sources (files, docs, code, command output) over assuming; report what you actually observed, with file paths and evidence, and label anything unverified as `Hypothesis:` or `Unverified:`.
- Do not edit files or change configuration in this stage unless the user explicitly asks for edits.
- If it makes sense to delegate parts of the investigation, you may start read-only sub-agents with the existing `subagent_*` tools, but that is your judgment call — do not start, wait for, or close workers automatically just because this stage says so.
- Do not select a model, set a worker profile, or apply tool restrictions on behalf of the user.

Output:
- A short answer to the question (or an explicit "not determinable yet"),
- the evidence you relied on (paths, commands, observations),
- any unresolved unknowns or follow-up steps.
