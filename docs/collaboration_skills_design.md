# Collaboration skills design — proposed

**Status:** Implemented design anchor. It records the user’s behavior-first naming decision, secondmate review, and the boundaries the completed adaptation must preserve.

## Intent

Package a small, coherent collaboration pattern that helps an LLM use this extension without confusing harness, transport, and responsibility.

- Name skills for the responsibility they teach, not Pi or Herdr.
- Mention native tools and Herdr only where operational behavior requires them.
- Keep strategy, handoff, lifecycle control, acceptance, and memory distinct.
- Change only the names and instructions needed to remove routing ambiguity and script-first conflict.

## Taxonomy

| Skill | LLM routing description | Owns | Does not own |
| --- | --- | --- | --- |
| `firstmate` | Lead sustained work: retain strategy, coordinate bounded delegation, independently accept results, and stay with the user. | Strategy, integration, acceptance, user conversation. | Transport mechanics. |
| `pairing` | Maintain grounded collaboration and durable repository memory; challenge assumptions, distinguish evidence from uncertainty, and curate canonical knowledge. | Partnership and memory. | A second supervision workflow. |
| `handoff` | Prepare bounded assignments and compact evidence reports for workers without shared chat context. | Goal, scope, context, stop rules, evidence channel, report structure. | Launching, steering, or closing workers. |
| `subagent-supervision` | Launch, observe, recover, and retire bounded workers with this extension’s native `subagent_*` tools, using evidence-based acceptance and deliberate cleanup. | Operational lifecycle and tool caveats. | Architecture, user authority, or automatic acceptance. |
| `bootstrap-pairing-memory` | Explicitly initialize repository-owned collaboration memory and its stewardship contract. | Initial setup only. | Routine memory maintenance. |

Directory names and frontmatter names will match. `bootstrap-pairing-memory` remains explicit-only and should set `disable-model-invocation: true` when adapted.

## Collaboration flow

```text
Firstmate
  → handoff (bounded goal, scope, evidence, stop rules)
  → subagent-supervision (native lifecycle tools)
  → Firstmate inspection and acceptance
  → pairing memory checkpoint
```

A controller is an assigned supervision role, not another skill or policy layer.

## Native operational boundary

`subagent-supervision` must route normal work through native tools:

- launch: `subagent_start` with a complete task and explicit `cwd`;
- inspect: `subagent_read` and `subagent_list`;
- follow up: `subagent_prompt`;
- observe: `subagent_wait`;
- recover/retire: `subagent_interrupt` or `subagent_close` only when justified.

It must state these limits plainly:

- readonly workers cannot call `subagent_*`; recursive controllers require `mode: "editable"`;
- a busy prompt can be submitted, but its observation can describe the prior turn;
- timeout or uncertain delivery never permits automatic resend;
- terminal lifecycle state is an inspection point, not task acceptance;
- capture evidence before close; independently inspect output, artifacts/diff, and checks.

`subagent_send` is terminal-level input, not the normal agent-turn mechanism.

## Runtime and script boundary

`src/index.ts` keeps `RUNTIME_SKILL = "sub-agent-herdr-supervisor"`. That resolves an externally installed worker-runtime directory; it is not the public name of the packaged behavioral skill.

The imported scripts are reference material, not a self-contained fallback: `herdr-worker.sh` sources `pi-worker-runtime.sh`, which is not in this package. The adapted skills must not claim a script fallback unless its dependencies and behavior are separately verified.

## Visibility and authority

Pi keeps the first discovered skill on a duplicate name. Therefore behavioral package names cannot guarantee that a package copy is visible beside an existing user/project copy.

This is accepted, not hidden:

- user skills and repository instructions remain canonical for generic Firstmate/pairing policy;
- `subagent-supervision` must be self-contained for essential native lifecycle safeguards;
- `handoff` must remain useful if another handoff skill wins;
- package skills are coherent defaults, never claimed as overrides.

## Implemented adaptation sequence

1. Renamed packaged directories/frontmatter and updated manifest paths, links, packaging assertions, and README.
2. Narrowed all five descriptions so Pi can route from advertised metadata before reading a body.
3. Replaced script-first and stale transport instructions with the native operational boundary while preserving scope, evidence, recovery, and acceptance rules.
4. Removed the dangling CMUX link rather than importing a CMUX dependency.
5. Verified manifest/frontmatter/link consistency, package contents, and actual Pi skill parsing. The adaptation does not modify external profiles, runtime configuration, or publication.
