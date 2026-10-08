# herdr-stage-support — requirements

## Objective

Provide reusable prompt-template commands so users do not need to restate the
usual expectations for exploration, implementation, and review work.

## Commands

| Command | Optional input | Required behavior |
| --- | --- | --- |
| `/stage-explore` | `[question]` | Guide an evidence-first investigation; do not edit unless explicitly asked. |
| `/stage-implement` | `[change]` | Guide a bounded implementation and relevant verification. |
| `/stage-review` | `[focus]` | Guide a critical review for correctness, risks, gaps, and missing verification; do not edit unless explicitly asked. |

Each command must accept optional text. When text is supplied, it becomes the
specific brief; without it, the template supplies a useful default intent.

## Constraints

- Templates provide guidance to the current LLM only.
- They must not automatically start, wait for, prompt, or close sub-agents.
- They must not set a model, worker profile, tool set, or use `.sub_agent_conf`.
- The current LLM retains the decision whether and how to delegate via the existing
  `subagent_*` tools.

## Acceptance criteria

1. The three commands appear after the package is loaded or reloaded.
2. Each command expands its fixed stage guidance and forwards optional user text.
3. The commands make no automatic worker-management action or configuration override.
4. The templates are included when the package is installed or published.
5. Existing `subagent_*` behavior remains unchanged.
