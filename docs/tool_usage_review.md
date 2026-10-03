# Native subagent tools: verdict and simplification plan

Date: 2026-10-02 (design). **Current acceptance/publication authority (2026-10-03):** the user authorizes Firstmate review, scoped commit and normal GitHub push; human testing follows publication. `docs/ergonomic_acceptance.md` owns the current verdict. Historical checkpoint/team discussion below is design provenance, not current execution instructions. External deployment, research changes and packaging remain outside this goal.

## Working state — living discussion artifact

This file is our shared design workbench, **including intermediate ideas**, not just a final report. Persist lead/buddy proposals, evidence, disagreements, revised positions and unresolved questions here as they develop; do not leave the design solely in chat or wait for agreement before writing. Replace superseded recommendations rather than accumulate contradictory final-sounding conclusions. Clearly distinguish user requirements, current recommendation and unverified design candidates.

- **Established direction:** ergonomics for our real-session-derived commands; no artificial ownership/workspace permission layer; useful combined operations return context without avoidable caller follow-ups. The user's prompt/wait example illustrates this direction, not a mandated function.
- **Current lead/buddy recommendation:** nine existing verbs, flat consistent inputs, start submit-only by default for fan-out, prompt wait by default, bounded waits with console, compact inspection results and close plus absence verification. These are proposed interfaces, not installed behavior.
- **Agreed design:** Nora explicitly reports comfortable with no remaining design blockers after reading the corrected interface/freshness sections. Lead agrees. **Pane ID is the sole caller-facing address**; internal sequence context is not task proof. The single evaluation default is 100 lines/8,000 code points.
- **Current phase:** user-authorized checkpoint, then one implementation team with sole source writer, independent readonly reviewer and controller. Runtime-dependent checks remain explicit verification gates, not speculative fallback. Source and deployed behavior remain unchanged at this design checkpoint.

## Verdict and intended product

Simplify **our existing, session-derived subagent handling and collaboration commands**, not a generic catalog of common Herdr CLI commands. The extensive investigation of real sessions, delegated research and live verification is the design foundation. Preserve useful workflows distilled from that evidence; remove artificial access restrictions and unnecessary complexity. CLI parity is a reference for primitives and existing-peer communication, not a reason to discard proven orchestration.

The user's clarification supersedes this review's earlier recommendations to retain non-owned-close UI approval, external acknowledgement gates or separately authorize cross-workspace mutators. Default workspace-sensitive operations to the current workspace; permit explicit other workspaces and all-workspace inspection. Explicit pane targets work regardless of ownership/workspace. Scope discipline remains the agent's responsibility, not a wrapper access gate. Peer panes are not automatic cleanup resources.

Keep input validation, reliable argument passing, CLI error propagation, explicit output bounds and honest descriptions. Do not require a recorded launch relationship to address an existing agent. Do not impose unsupported access policy. Preserve readiness, waiting and result-handling behavior where the real-session findings justify it; distinguish those useful workflow guarantees from restrictions that prevent legitimate collaboration.

## Evidence and limitations

Baseline: `live_verification.md`, `evidence/current_session_tools_live.json`, `evidence/nested_worker_live.json` establish tested Pi workflows, hidden task oracles and cleanup. They do not validate the proposed simplified implementation or all agent kinds. The latest existing-code check passed 130 tests; no implementation or new code tests were run for this review.

User-designated feedback pane `w26:pD` reported actual cross-workspace prompt/send denials even with `allowExternal: true`, while read/wait worked. Source `checkControlAccess` confirms the mutator workspace restriction. The feedback corrected earlier unsupported assumptions and admitted its attempted CLI message did not land. Its initial claims are not delivery evidence. Historical handles in this document are provenance, never reusable control authority.

### Actual Claude communication failure and workaround

During the requested equal-level buddy discussion, native `subagent_prompt` to the same-workspace Claude instance returned:

> prompt_refused (phase: preflight): authoritative managed Pi session readiness is required; no task sent

I had to use `bash` → `herdr agent prompt wP:p2 'Horst/Felix → Nora: user requests equal-level ...' --wait --timeout 120000`. The CLI returned `agent_prompted`, agent kind `claude`, and managed `herdr:claude` session identity. Subsequent pane reads showed both the request and actual response. This confirms that interaction, not general non-Pi lifecycle semantics.

This is a wrapper deficiency, not a Herdr limitation or acceptable final workaround. Existing-agent prompt should directly wrap the CLI; launching a managed Pi worker remains a separate composite helper. Do not add automatic bash fallback.

### Verified CLI prompt contract

Read-only `herdr agent prompt --help` inspection during reassessment states:

- `--wait` waits for the first matching state after submission; default terminal matches are idle/done/blocked.
- Already-blocked submission is rejected with `agent_blocked` before input is sent.
- An accepted submission from a non-working state must observe working or blocked within 5 seconds, otherwise `agent_prompt_stalled`; an earlier caller deadline returns timeout.
- **It does not track turns. If the agent is already working, that active turn's completion may match.**

Consequently, preserve those receipts/statuses/errors, and do not label a matching state as completion of the newly submitted task. No wrapper busy refusal is needed solely to protect a task-completion claim that the wrapper should not make. Never automatically resend after timeout or uncertain delivery.

Source `runPrompt` currently adds `managedPiReady` to all prompts. Source `mintContinuation` can prefer saved ownership identity over the current preflight baseline. Removing only the readiness gate is therefore insufficient to achieve deliberate retargeting; remove the ordinary-path dependency on saved ownership/continuation authority too.

## LLM-facing ergonomics — lead/buddy recommendation

**User clarification:** `send_prompt_wait(...)` was one off-the-top-of-the-head example, not a request to name or implement that one function. Design the whole interface for LLM use in this harness. Preserve our researched workflows; reduce unnecessary tool selection, parameter variation, follow-up reads and recovery bookkeeping. This section supersedes earlier generic-wrapper framing and any blanket removal of proven lifecycle machinery. It is a design recommendation, not an implemented contract.

### Evidence driving the interface

- Worker3 reports 611 launches, 320 helper awaits, 176 helper follow-up prompts, 383 gets and 397 console reads. These are per-call counts; worker4's larger grep counts measure mentions and must not be combined with them.
- Worker4's **Behaviour Patterns** explicitly records back-to-back parallel launches followed by blocking awaits. Worker3's claim that no true asynchronous pattern existed must not be read as evidence against fan-out. Blocking await does not imply that start should block, or that an asynchronously awaited Pi tool blocks the UI/event loop.
- Worker4 caveats 9–11 show distinct startup-detection versus work-wait budgets, cumbersome nested output extraction and repeated close-plus-list verification. These are opportunities for useful composites, not a generic CLI command inventory.
- Earlier miner claims about readonly report-path carve-outs and Ctrl-D interrupts are superseded by current findings/AGENTS: readonly evidence is terminal-only; Escape interrupts, close terminates. Preserve the corrected conclusions rather than transplant historical report advice wholesale.

### Recommended small tool surface

Keep the nine established `subagent_*` names; do not add duplicate verbs for every combination. Proposed inputs are flat, use `pane` consistently for explicit pane targets, and use milliseconds explicitly as `timeoutMs`. Parameter renames and changed defaults require a documented compatibility/version migration, never silent field dropping. **All party-directed calls address `pane`; no caller-facing continuation/cursor/receipt ID is required or returned as another address.** Internal identity/sequence bookkeeping is not a permission gate.

| Tool | Proposed normal call | What the single result includes |
|---|---|---|
| `subagent_start` | `{name, task, mode?, cwd?, workspace?, wait:false, ...}` | Startup/readiness and prompt delivery result, pane identity/status and available console context; `wait:true` combines launch → submit → wait → console. |
| `subagent_prompt` | `{pane, prompt, wait:true, ...}` | Submit → bounded wait → console, including status and delivery disposition. `wait:false` submits without a task wait. Works for existing agents supported by Herdr, including Claude peers. |
| `subagent_wait` | `{pane, ...}` | Wait without resending, then status + console; contextualizes a matching pending submission where evidence permits. |
| `subagent_read` | `{pane, returnLines?, maxChars?, source?}` | Status + console in one inspection; no separate get required for normal recovery. |
| `subagent_send` | `{pane, text, returnLines?:0}` | Raw single-line text plus Enter receipt; optional console observation, not an agent-task receipt. |
| `subagent_interrupt` | `{pane}` | Escape-sent result and available status observation; optional bounded observation can be considered, but no default assertion that the task aborted. |
| `subagent_close` | `{pane}` | Close plus independent absence verification; typed absence is idempotent success. No caller-side follow-up list needed merely to verify close. |
| `subagent_list` | `{workspace?:current|id|all}` | Compact structured panes with identity/name, workspace, cwd, detected agent and status; ownership is informational. |
| `subagent_spaces` | `{}` | Compact structured workspace inventory. This is distinct from listing panes across all spaces. |

Workspace defaults to current; a launch destination is current or one explicit ID, never all. Do not automatically close workers after harvesting output: review/acceptance and deliberate cleanup remain separate actions.

**Common wait/output controls:** `wait` replaces overlapping `bounded` and `finish`; all waits are finite. `timeoutMs` defaults to **1,800,000 ms** for start-with-wait, prompt-with-wait and standalone wait; retain the current configurable 3,600,000 ms ceiling. A short timeout is a progress window, not another operation. Reject explicit `timeoutMs` on submit-only calls with a migration/use hint. It bounds the work-wait phase, not worker lifetime or total tool wall time: start also performs model/runtime validation, pane creation, managed detection (currently a separate 15,000 ms budget), rename and submission; final console reads and transport have their own bounded overhead. Do not call detection-plus-wait the entire worst case. Submit-only still awaits readiness and submission, not task completion.

The **single default pair to implement and evaluate** is `returnLines:100`, `maxChars:8000` code points, drawn from mined await usage—not proven optimal. Retain bounded input ceilings (500 lines, 50,000 code points); `returnLines:0` disables console capture. Use common names across start/prompt/wait/read. Include console where the workflow needs it, not in list/spaces/close; raw send defaults to no console. A requested line window is bounded by the cap, and clipping is visible. Char-tail use remains possible through a small `maxChars` (e.g. 50) applied as a suffix after line selection; do not retain another competing line/character selector.

**Migration decision:** plan a documented breaking 0.1.x → 0.2.0 interface change, not silent compatibility assumptions. Keep tool names. Reject old `target`, prompt `task`, `waitMode`, `tailChars`, read `lines`/`raw` with exact replacement hints before mutating; docs map their old intentions to `pane`, `prompt`, `wait`, `maxChars`, `returnLines` and `source`. Conflicting old/new fields are errors, not precedence guesses. Accept `allowExternal` as ignored/deprecated for this transition version without exposing it in the preferred schema. Remove the public `continuation` field as part of this breaking migration; reject it with a hint to address the pane directly, never interpret an old opaque ID as target authority. Internal pending observations do not require the LLM to copy identifiers. Inventory SDK/session/programmatic callers in implementation preflight; do not assume that schema refresh means none exist. Version/docs change during implementation only.

### Result design: enough to choose the next action

Prefer shallow, predictable action fields: `ok`, `outcome`, `pane`, `workspace`, `agent`, `status`, `delivery`, with a bounded `console` object only when applicable. Lists return structured collections, not entire raw transport dumps. Exact schemas remain to define.

- `delivery` distinguishes **acknowledged**, **not_sent**, **unknown** and **not_applicable**. `agent_prompted` acknowledges submission whether or not `--wait` was used; waiting does not itself prove model consumption or task execution. Avoid a second ambiguous "confirmed" level based only on `--wait`.
- `console` contains text, source (`history`, `visible` or `raw`), truncation information and any independent read error. A successful action plus failed console read must not become "prompt failed" or trigger resend. Snapshots are not assistant answers; report files/diffs/tests remain independently inspected where applicable.
- Timeout/stall includes available current status and console context, states that the worker may still run, and does not invite automatic retry. Cancellation of a wait cancels local observation, not the remote worker.
- Read `source` is `auto` (default), `agent` (strict) or `raw` (explicit pane read). In auto mode, typed `agent_not_found` or a successful lookup with no detected agent permits raw pane console with unknown status; typed `agent_not_idle` permits visible-only console. Strict agent reads surface errors without raw fallback. All other failures—including missing pane, protocol/server/auth or transport errors—remain errors. Never equate a failed lookup with a successful lookup containing no agent.
- Missing identity/status fields remain unknown, not invented values. Action receipts and subsequent observations are not an atomic snapshot.

### Pane-only addressing; internal freshness bookkeeping

Make ordinary start → wait work with **`pane` alone**, without public cursor/continuation/receipt tokens. Internal context associates a pending same-session submission with matching live identity, pre-submit sequence and acknowledgement sequence/status. Return a plain `observation` label explaining the relationship, not an identifier the model must carry. Keep at most the current useful pending context per pane, not an unbounded task registry or exclusive turn-ownership claim. Context is in-memory only: reload/restart/new session loses it, and subsequent pane waits use the explicitly labelled snapshot/current-pane rule. Do not add context persistence merely to preserve task attribution; document this limit.

**Two-tier freshness rule, context only:**

1. If the acknowledgement already observes terminal status, its sequence is greater than the pre-submit baseline, identity matches, and a fresh lookup still observes that terminal sequence, the next wait can return immediately as `terminal_seen_during_submission`. This handles a fast task without requiring a nonexistent future transition. Do not return saved terminal status if the live pane is now working: use tier 2 instead. It settles the pending context once; later calls use normal current-pane observation.
2. Otherwise wait for terminal status with sequence greater than the acknowledgement baseline, identity unchanged; return `state_changed_after_submission`.

Neither rule proves task execution or exclusive attribution. A status change between preflight and submission can come from another actor. The literal labels avoid misrepresenting that time window. Preserve genuinely sampled activity if useful, never invent it or require the LLM to understand internal polling.

**Sequence evidence/gate:** existing original submit-only acknowledgements do contain `state_change_seq`: `docs/evidence/session_isolation_live.json` at `phases[1].receipt` has args `[agent,prompt,w1Y:p1,...]` with no `--wait` and an `agent_prompted` agent at idle/sequence 944; `docs/evidence/cancel_live.json` at `calls[15]` similarly returns idle/934. These establish the inspected Pi payload, not every host/agent version. During implementation, verify current host and non-Pi payloads. If acknowledgement metadata is missing, a bounded post-submit lookup may supply a separately labelled non-atomic baseline; apply the same identity/freshness safeguards and label a terminal observation from that lookup `terminal_seen_in_post_submit_lookup`, not as an acknowledgement snapshot. If no safe numeric baseline can be established for our submitted work, preserve the acknowledged action/delivery outcome, report a separate explicit context-establishment error with available status/console and stop to revise—do not quietly ship fan-out waits that immediately return stale idle. Add tests for each tier, missing receipt metadata/post-submit observation and unchanged stale terminal state.

Do not settle on unchanged startup/stale idle. A fresh terminal observation settles the pending context; timeout leaves it pending. Concurrent waits share settlement consistently; a wait already holding the context may finish that observation, while a later call sees it settled. A new submission supersedes previous automatic association, identity drift invalidates it, and settled records are not reused automatically. With no matching pending context, an already-terminal pane returns `snapshot`; otherwise wait for a terminal state as a current-pane observation. Stale bookkeeping never vetoes explicit pane addressing: discard association and inspect the current identity.

**Busy prompt:** do not refuse merely because the agent is working. Report `submittedWhile` from preflight (unknown if unavailable). When observed working, mark `observation:may_reflect_prior_turn`; Herdr's wait may match that active turn, so do not create an automatic pending association for this submission. A status read is not atomic with submission: always document that external concurrent prompts/races cannot be excluded, even if preflight was idle. Typed blocked refusal remains Herdr's `not_sent` result.

Another actor's work can satisfy the freshness gate. A matched receipt is therefore context only, never task acceptance or guaranteed answer attribution. If implementation reveals that reliable bounded association needs an elaborate registry or unsupported identity behavior, stop and revise this plan rather than patch around it. If the pane changes identity during an already-running associated wait, report drift rather than promote new-agent state as evidence for that submission.

### Buddy discussion and alternatives

Nora independently consulted worker3/worker4 and current schemas, then we reconciled a second round against the source reports. Adopted her correction to my original wait-everywhere proposal: **start returns after readiness/delivery by default for fan-out; prompt waits by default for the normal follow-up workflow**. Explicit start `wait:true` serves one-shot delegation; explicit prompt `wait:false` serves asynchronous coordination. Both can return console without another read call.

Also adopted flat inputs, stable verbs, compact structured lists and combined close/verification. After the user's address clarification, public advanced continuation is dropped too: address the pane directly and keep the minimal freshness bookkeeping inside the tools. Contested universal console capture after raw send/interrupt, unconditional first-terminal settlement and stronger delivery claims from `--wait`; the rules above avoid misleading immediate observations and the known stale-state race.

Alternatives considered: blocking everything minimizes calls for one worker but hinders parallel launch; async-first everywhere forces a second wait for ordinary follow-up; a new delegate/send-prompt-wait tool duplicates existing operations and increases selection burden. Recommend the hybrid above, not a large mode-driven mega-tool.

**Acceptance for ergonomics:** before implementing, walk through one-shot worker, parallel workers, existing Claude buddy exchange, timeout recovery without resend, startup/crash inspection, changed/reused pane identity, raw shell send, interruption and verified cleanup. Ordinary completed start/prompt/wait results must contain the requested console context, so a follow-up get/read is not needed merely because the interface withheld it. Acceptance of deliverables still requires real evidence. Assess returned context and parameter clarity—not just raw call counts.

## Authorized execution decomposition

Use **one team**, not two competing writers: core/index/tests are tightly coupled. Task-local chain: **Felix (lead) → Hanna (controller) → Rasmus (worker)**, with **Petra (independent reviewer)** reporting to Hanna and Felix. Nora remains the user's equal-level design buddy, not a grunt-work delegate or cleanup resource.

1. Controller prepares a concise implementation slice/checklist from this agreed contract, inventories current SDK callers and checks Herdr workspace-creation primitives without live mutators. Escalate actual unsupported behavior or requirements contradictions; no elaborate alternate control plane.
2. Worker is the sole writer for `src/`, `tests/`, related README/canonical docs and version metadata. Implement consistent schemas/output and pane-only flows, remove permission barriers, retain useful launch behavior and minimal internal freshness. Do not port runtime or add adapters/dependencies/task registries. Update tests for actual new behavior, not merely make old assertions disappear.
3. Reviewer independently examines original diff and source/test evidence against the contract, especially freshness tiers, unchanged stale idle, busy observations, typed fallback, migration, timeout and action-versus-console failures. Readonly, terminal-only report; no edits or self-approved acceptance.
4. Controller requests bounded worker corrections, runs `npm run check`, captures compact review/check evidence, and coordinates only fresh disposable live fixtures after source review. Lead independently inspects integration and native verification before acceptance. Any missing safe receipt metadata, unknown runtime mutation or complex workaround is an escalation, not worker improvisation.

Controller maintains a lead-visible child registry, and preserves reviewer/worker context until inspected follow-up is complete; normal cleanup is verified for owned resources only. No peer/user pane probes, commits/pushes, global configuration/model substitutions, external edits or deployment by the team. Checkpoint commit is the lead's action; later implementation commits require a deliberate lead decision under the user's authorization.

## High-level adaptation checklist

### 1. Reconcile our command contracts with the real-session findings

Start from our existing `subagent_*` surface and the researched handling/collaboration workflows, not from a new generic CLI catalog. Map each command to its purpose, real-session evidence, underlying primitives, useful orchestration and unnecessary restrictions. Cover launch/readiness/delivery, bounded waiting with console context, follow-up communication, inspection, Escape, listing and verified cleanup. Preserve established useful behavior unless evidence supports changing it.

Existing-agent prompt accepts detected agent kinds supported by Herdr, not just Pi. Avoid adding an agent-specific semantics framework or proof labels to compensate: expose the actual CLI result and explain its limits. Pi-only launch scope does not imply Pi-only peer messaging.

Done: our established command surface is simpler to use, retains evidence-backed workflow guarantees and clearly documents submit-only versus wait/timeout behavior. No generic CLI expansion or speculative extra operations.

### 2. Remove artificial permission gates and simplify ordinary workflows

Remove same-workspace/non-owned denials, `allowExternal` requirements, non-owned-close UI approval and universal managed-Pi readiness. Pass blocked/busy behavior and errors through from Herdr rather than duplicating policy. No ownership prerequisite or automatic cleanup of external peers.

Review working samplers and ownership-restoration machinery against the real-session failure cases they address. Do not remove useful evidence simply because bare CLI calls lack it. Keep minimal internal wait context/identity bookkeeping; remove public continuation handles and artificial access policy according to the version migration above. Do not reinterpret a legacy handle as a pane address. Ignore/deprecate old acknowledgement flags for the transition version rather than replace them with another gate.

For explicit pane IDs, use current CLI identity/results, not stale saved ownership. Bind only the currently running operation/internal pending observation to its sampled live identity; a later explicit pane call deliberately targets whoever is currently there. Do not invent a new target registry or public identity handle. Routine validation is not a promise that the CLI offers an atomic identity-bound send.

Self-target operations need actual execution-limit documentation, not a blanket ownership prohibition: terminating/interrupting the executing process may prevent returning a receipt; waiting for one's own turn can be circular. Do not add a general deny rule without inspecting the underlying behavior.

Done: valid explicit targets behave like CLI calls across workspaces/agent kinds, while failures and delivery uncertainty remain visible. Existing provenance can remain informational, not authority.

### 3. Keep only justified composite launch behavior

Retain the proven Pi launch sequence: runtime/profile/model selection, managed startup readiness and task submission after readiness, not an unreliable positional task. This check addresses an observed startup-draft problem; it belongs here, not in universal prompt.

Current workspace remains the launch/list default. Provide explicit other-workspace selection and explicit all-workspaces listing; all is not a launch destination. Inspect creation primitives early, implement other-workspace launch only through supported CLI operations. No user-focus-changing workaround or arbitrary split of a stranger's pane. Do not create a missing workspace silently.

Done: launch preserves its tested useful orchestration; workspace targeting is explicit and feasible. Additional launched runtimes remain outside scope.

### 4. Improve readable output without inventing answers

**Illustrative user example, not a required function name/signature:** `send_prompt_wait(pane="w4:pT", prompt="prompt", timeout=12000, returnLines=50)` sends the prompt, waits using Herdr's `--wait --timeout` behavior, and returns the observed status plus the requested recent console lines in the same tool result. `timeout` is milliseconds in this example. The name/signature illustrate the desired shorthand; decide whether to expose this directly or simplify the existing prompt tool rather than duplicate functionality.

After the prompt wait returns, the tool itself reads and attaches the console window; the caller should not need a follow-up get/read merely to see the output. This may require multiple underlying Herdr calls: one caller-facing operation, not necessarily one CLI invocation. On timeout, return the timeout/current observation and available console context; never imply the worker was stopped. If console reading fails, preserve the prompt/wait outcome and report that read failure separately—do not resend or manufacture output.

`returnLines=50` selects recent console lines, not the last 50 assistant-answer lines or proof of task completion. Retain a clearly documented response-size cap and truncation/source information. While the agent is working, visible-only console limitations still apply. A completed wait and subsequent console read are not an atomic snapshot; report the actual observations honestly.

Prefer **lines for context plus a character cap for budget**, consistently across read and optional prompt/wait tails. Preserve the char-tail use case through `maxChars`, with the explicit breaking migration above; reject legacy selectors with replacement hints rather than silently choosing between them. A character cap accompanying a line window is valid.

Evaluate the single 100-line/8,000-code-point default pair specified above against representative narrow/wide panes and long lines; do not introduce a second competing default here. Fifty-character tails often show only footer noise; line windows can also show footers, and a single line can be huge. Expose truncation and history/visible source; active visible-only reads cannot recover unavailable history. Do not silently strip UI-looking text or pretend console snapshots are final answers.

Resolve source-inspected contract inconsistencies: read advertises 2,000 characters but core defaults to 50,000; prompt advertises 50 but finish uses 2,000; start/prompt timeout fields advertise 60 minutes but core finish defaults to 30, with 60 as maximum; wait advertises external acknowledgement that the inspected execution path does not enforce.

Done: accurate defaults, bounded useful output and no extra answer-extraction feature.

### 5. Verify parity and publish accurate docs, after authorization

Replace tests asserting superseded permission gates with command-mapping/parity tests. Verify argument quoting, CLI receipts/errors, timeout/stall/blocked behavior, busy submit-only and busy wait's documented attribution limitation, missing targets, legacy-field migration and output bounds/Unicode.

Use only newly created disposable fixtures for live mutator checks: same/cross-workspace existing-agent interaction, explicit launch destination, all-space listing, raw send to a test shell, Escape and close/idempotence. Include a non-Pi existing-agent fixture where available; otherwise state that evidence is incomplete. Actual CLI Claude discussion is not native-wrapper verification. Check original outputs and independent cleanup; preserve user/buddy panes.

Inspect recent baseline tests as preservation evidence, not proof that removing gates is already safe. Update README, acceptance and design/scope memory to the new contract. No commit/push/deploy without implementation authorization; another repository's runtime work remains owned by its Firstmate.

Done: the implemented shorthand matches verified CLI behavior and clearly states remaining limits, with no hidden fallback or invented task-completion guarantee.

## Independent review and reconciliation

Nora, the user-designated equal-level buddy, provided an external review of this proposal; no edits or experiments were requested. Accepted: separate launch readiness from existing-peer prompt, remove stale ownership as a bare-target baseline, retain honest state-versus-task semantics, keep output defaults provisional and inspect destination primitives before launch redesign.

Her concern about busy waits was confirmed directly by CLI help. Her conditional suggestion to retain a wrapper busy gate is unnecessary under the revised state-observation-only contract: pass through the CLI behavior instead of claiming task attribution. Earlier numeric sequence-jump suggestions are not accepted as completion evidence. No claim of general native Claude support is made before implementation/testing.

Correction after the user's final clarification: a generic thin command mapping plus one launch helper was an overcorrection. The preferred direction is **our real-session-derived command workflows, simplified without losing their proven value**. Workspaces, ownership, agent kind and approval flags should not become a second authority model; that does not make evidence-backed orchestration unnecessary.

## Later packaging goal — user-requested reminder

**Bundle the relevant skills and scripts with the extension later.** This reduces separately installed runtime dependencies but is not authorization to copy or relocate resources now. Plan one authoritative source/update path to avoid divergent bundled and `~/.local/bin` copies, package resource discovery, compatibility and ownership/licensing. Coordinate with that repository's Firstmate.

## Out of scope and remaining unknowns

No external runtime/config/model changes, answer extraction, readonly allowlist expansion, automatic peer cleanup, multiplexer adapters or packaging work in this implementation. Readonly native-tool visibility is an existing host/runtime selection constraint, not justification for another wrapper permission system.

Implementation preflight/verification gates: exact destination-workspace primitives, old-caller inventory for the specified migration, evaluate the chosen output defaults, current host/agent receipt metadata, and narrow self-target execution limitations. Non-Pi native timeout/interrupt semantics remain unverified. These are implementation-planning questions, not reasons to retain the current permission layer. No hidden workaround is proposed as the final state.

## 0.1.x → 0.2.0 Field Map (implementation reference)

This is the authoritative mapping from the 0.1.x parameter surface to the 0.2.0
flat contract. Legacy fields are rejected by core pre-dispatch validation with a precise
migration hint before any action. Acknowledgement flags are accepted but ignored.

| Tool | 0.1.x field | 0.2.0 field | Notes |
|---|---|---|---|
| all | `target` | `pane` | Sole caller-facing address; no `pane_id` |
| prompt | `task` | `prompt` | Name reflects the field's role |
| start, prompt | `waitMode` (none/bounded/finish) | `wait` (boolean) | start defaults `false`, prompt defaults `true` |
| start, prompt, read, wait, send | `tailChars` | `maxChars` | Consistent with `returnLines` |
| read | `lines` | `returnLines` | Consistent naming |
| read | `raw` (boolean) | `source: "raw"` | Explicit source selection: auto/agent/raw |
| wait | `continuation` (opaque ID) | *(removed)* | Internal pending context is memory-only; no public cursor |
| send, interrupt, wait | `allowExternal` (boolean) | *(removed)* | Accepted but ignored; ownership is informational only |
| close | `externalConfirmed` (boolean) | *(removed)* | Accepted but ignored in this transition; explicit pane close needs no ownership or UI approval |
| start | `timeoutMs` (default 60 min) | `timeoutMs` (default 30 min) | Bounded wait phase; detection is a separate 15 s budget |
| prompt | `timeoutMs` (default 60 min) | `timeoutMs` (default 30 min) | Bounded wait phase |
| wait | `timeoutMs` (default 30 min) | `timeoutMs` (default 30 min) | Current-pane observation |
| start, prompt, read, wait, send | `returnLines` | `returnLines` (new) | Default 100; 0 disables console; send defaults to 0 (no console) |
| start, prompt, read, wait, send | `maxChars` | `maxChars` (new) | Default 8000; 0 disables character bound |

### Result field changes

| 0.1.x result field | 0.2.0 result field | Notes |
|---|---|---|
| `pane_id` | `pane` | Sole caller-facing address |
| `continuation` (opaque ID) | *(removed)* | No public continuation/cursor |
| `tail` | `console` | Bounded console text (code-point tailed) |
| `truncatedTail` | `truncated` | Boolean: console was clipped |
| `tailSource` | `consoleSource` | agent / visible / raw |
| — | `consoleError` | Independent console-read failure; never erases the action outcome |
| — | `delivery` | acknowledged / not_sent / unknown / not_applicable |
| — | `observation` | terminal_seen_during_submission / state_changed_after_submission / snapshot |
| — | `submittedWhile` | Pre-submit status for busy submissions |
| — | `working_observed` | Optional observation, not task proof; true only when working was actually sampled or CLI-reported |
| — | `verifiedAbsent` | True for close results where absence was verified |


## Implemented boundaries (2026-10-03)

Current automated verdict and concrete coverage are in `ergonomic_acceptance.md`.
Explicit different-workspace **launch** is safely rejected before creation;
there is no supported destination split primitive in this implementation and no
focus-changing workaround. Existing explicit-pane operations have no ownership
or workspace gate. Self prompt/wait would wait for the executing turn; self
send/interrupt/close can interfere with or terminate the executing process, so
these execution-limited calls are rejected. Read/list remain available.

The native battery did not establish busy steering or timeout recovery; those
are automated regressions awaiting human testing. Missing receipt metadata,
settlement and final console-source/identity corrections are unit-verified, not
new native proof. Historical completed first-version gates do not upgrade that
scope. No native non-Pi parity claim is made.
