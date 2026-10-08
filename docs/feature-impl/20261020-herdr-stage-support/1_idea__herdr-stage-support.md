# herdr-stage-support — idea

Date: 2026-10-20 · Status: implemented; live command acceptance pending · Owner: Firstmate (user owns requirements)

## One-liner

Package reusable Pi prompt templates for common sub-agent stages so users do not
need to repeat what an explorer, implementer, or reviewer should do.

## Problem

The current LLM can already use the native `subagent_*` tools to start and
supervise workers. What is repeatedly missing is a concise, consistent brief for
common work types. Users should not have to restate role expectations every time.

## Desired user experience

```text
/stage-explore investigate the failing test
/stage-implement add the requested validation
/stage-review focus on regressions
```

Each command expands into a predefined prompt for the current LLM. The LLM then
uses the existing tools and its judgment to coordinate the work.

## Stage intent

| Template | Default intent |
| --- | --- |
| `/stage-explore` | Investigate a bounded question, gather evidence, do not edit unless explicitly asked. |
| `/stage-implement` | Make the requested change, keep scope bounded, and verify it. |
| `/stage-review` | Critically inspect relevant work for correctness, risks, gaps, and missing verification; do not edit unless explicitly asked. |

The supplied text refines the template's default intent. Templates must not
silently select a model, set worker configuration, or replace the LLM's judgment
about whether and how to delegate.

## Boundaries

- This is **not** native runtime orchestration, a workflow engine, or a new
  sub-agent lifecycle system.
- The existing `subagent_*` tools remain the execution and supervision interface.
- Templates provide reusable guidance only; they do not automatically start,
  track, or close workers.
- No model, `.sub_agent_conf`, worker profile, or tool restriction is injected by
  a template.

## Why prompt templates

Pi prompt templates are Markdown-backed slash commands. They are the smallest
mechanism that makes reusable stage guidance visible in command completion while
keeping all delegation decisions with the current LLM.

## Open questions for requirements

1. Exact command names: `stage-*` versus `herdr-stage-*`.
2. Whether each template requires an explicit task or supplies a useful default.
3. Exact role guidance, output expectations, and edit boundaries for each template.
4. Whether templates ship as package resources, project resources, or both.
5. Acceptance examples proving expansion, argument forwarding, and no hidden
   automatic orchestration.

## Non-goals

- New TypeScript stage orchestration.
- Automatic worker dispatch, polling, reporting, or state persistence.
- Replacing the current native sub-agent tools.
- Defining worker models or altering the parent session configuration.

## Requirements

The accepted user-facing contract is in
[`2_requirements__herdr-stage-support.md`](./2_requirements__herdr-stage-support.md).
