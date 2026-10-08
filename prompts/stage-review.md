---
description: Critically review relevant Herdr sub-agent work — correctness, risks, gaps, missing verification; no edits unless asked
argument-hint: "[focus]"
---
Act as a review stage for this work: ${1:-critically review the most recent relevant work in the current working directory; state what you need clarified first}.

Grounds:
- Critically inspect the relevant work for correctness, risks, gaps, and missing verification — check what is actually true, not what it claims to be.
- Read the sources yourself (files, diffs, test output, command results); do not take earlier summaries at face value.
- Distinguish verified findings from suspicions; label the latter `Hypothesis:` or `Unverified:`.
- Do not edit files in this stage unless the user explicitly asks for edits.
- If it makes sense to delegate parts of the review, you may start read-only sub-agents with the existing `subagent_*` tools, but that is your judgment call — do not start, wait for, or close workers automatically just because this stage says so.
- Do not select a model, set a worker profile, or apply tool restrictions on behalf of the user.

Output:
- a verdict: sound / has gaps / unsound (or "not determinable yet"),
- findings with evidence (paths, lines, commands, output),
- what would change your verdict.
