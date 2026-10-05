# Collaboration skills design

**Status:** Canonical design anchor. Commit `53a5a0b` implemented an earlier behavior-first taxonomy. The user has since required the public-prefix migration below; it is the next implementation target.

## Intent

Package a small, coherent subagent collaboration pattern that helps an LLM distinguish responsibilities from implementation details.

- Every public native tool uses the `subagent_` prefix.
- Every public skill uses the `subagent-` prefix.
- The remainder of a name describes the responsibility, not Pi or Herdr.
- Include `herdr` only where the responsibility is specifically Herdr-based.
- Keep strategy, handoff, lifecycle control, acceptance, and memory distinct.

## Target public taxonomy

| Public skill | LLM routing description | Owns | Does not own |
| --- | --- | --- | --- |
| `subagent-firstmate` | Lead sustained subagent work: retain strategy, coordinate bounded delegation, independently accept results, and stay with the user. | Strategy, integration, acceptance, user conversation. | Transport mechanics. |
| `subagent-pairing` | Maintain grounded subagent collaboration and durable repository memory; challenge assumptions, distinguish evidence from uncertainty, and curate canonical knowledge. | Partnership and memory. | A second supervision workflow. |
| `subagent-handoff` | Prepare bounded subagent assignments and compact evidence reports for workers without shared chat context. | Goal, scope, context, stop rules, evidence channel, report structure. | Launching, steering, or closing workers. |
| `subagent-herdr-supervision` | Launch, observe, recover, and retire Herdr workers with native `subagent_*` tools, using evidence-based acceptance and deliberate cleanup. | Herdr operational lifecycle and tool caveats. | Architecture, user authority, or automatic acceptance. |
| `subagent-bootstrap-pairing-memory` | Explicitly initialize repository-owned subagent collaboration memory and its stewardship contract. | Initial setup only. | Routine memory maintenance. |

Directory names and frontmatter names match. `subagent-bootstrap-pairing-memory` is explicit-only and uses `disable-model-invocation: true`.

## Collaboration flow

```text
subagent-firstmate
  → subagent-handoff (bounded goal, scope, evidence, stop rules)
  → subagent-herdr-supervision (native lifecycle tools)
  → subagent-firstmate inspection and acceptance
  → subagent-pairing memory checkpoint
```

A controller is an assigned supervision role, not another skill or policy layer.

## Native operational boundary

`subagent-herdr-supervision` routes normal work through native tools:

- launch: `subagent_start` with a complete task and explicit `cwd`;
- inspect: `subagent_read`, `subagent_list`, and `subagent_spaces`;
- follow up: `subagent_prompt`;
- observe: `subagent_wait`;
- raw terminal input: `subagent_send` only when appropriate;
- recover/retire: `subagent_interrupt` or `subagent_close` only when justified.

It states these limits plainly:

- readonly workers cannot call `subagent_*`; recursive controllers require `mode: "editable"`;
- a busy prompt can be submitted, but its observation can describe the prior turn;
- timeout or uncertain delivery never permits automatic resend;
- terminal lifecycle state is an inspection point, not task acceptance;
- capture evidence before close; independently inspect output, artifacts/diff, and checks.

## Runtime and script boundary

User-authorized self-containment now bundles `pi-worker-runtime.sh` and `pi-profile.sh` beside `herdr-worker.sh`. Native runtime discovery uses explicit flag → environment override → this package's scripts; no automatic legacy skill scan. Workers load this package's local extension entrypoint. Profiles default to minimal when available. External Pi/provider/reporter integrations remain explicit prerequisites; verification and limits are in `docs/self_contained_runtime.md`.

Older shell orchestration helpers remain reference material; bundling their dependencies does not repair their historical positional-brief/parser limitations.

## Visibility and authority

Pi keeps the first discovered skill on a duplicate name. The subagent-prefixed public names avoid collision with generic behavioral skills.

User skills and repository instructions remain canonical for project policy. The bundled skills provide the subagent-specific collaboration pattern and never claim to override those instructions.

## Implementation and acceptance

1. Rename all five packaged directories/frontmatter to the target public names; update `package.json`, links, README, and packaging assertions.
2. Preserve concise behavioral descriptions. Only `subagent-herdr-supervision` uses `herdr`, because only it is specifically Herdr-based.
3. Preserve the native operational, evidence, recovery, and acceptance safeguards established in `53a5a0b`.
4. Verify manifest/frontmatter/link consistency, npm package contents, actual Pi skill parsing, and public-name collision avoidance.
5. Do not modify external profiles, runtime configuration, or publication. The separately authorized self-contained runtime change replaces the legacy lookup; it does not authorize installed-profile edits or legacy deletion.
