# herdr-stage-support — plan

Date: 2026-10-20 · Status: implemented; live command acceptance pending · Requirements: `2_requirements__herdr-stage-support.md`

## Approach

Implement stage support as packaged Pi prompt templates, not extension runtime
orchestration. A template expands into guidance for the current LLM; the LLM
continues to choose whether and how to use existing `subagent_*` tools.

## Implemented work

1. Added one Markdown prompt template per stage under `prompts/`.
2. Declared templates under `pi.prompts` and included `prompts` in package files.
3. Added frontmatter, optional-argument forwarding, approved guidance, and default
   intent to every template.
4. Documented commands and boundaries in `README.md`.
5. Added automated resource/content tests. Typecheck, the full test suite, and a
   package dry-run passed.

## Remaining acceptance

In a live Pi session that loaded the package, run `/reload`, confirm `/stage-`
command completion, and invoke one command with an argument to confirm visible
expansion. This cannot be proven by resource/content tests alone.

## Constraints

- No new TypeScript command handler or worker lifecycle code.
- No automatic delegation, waiting, reporting, or cleanup.
- No model selection, `.sub_agent_conf` use, or profile/tool override.
- Package resources must be explicit so templates remain available when this
  extension package is installed.

## Acceptance outline

- Each approved slash command appears after the package loads/reloads.
- A command expands its fixed guidance and forwards optional user text correctly.
- The expanded prompt makes no automatic tool call and does not prescribe a model.
- Existing `subagent_*` behavior remains unchanged.
