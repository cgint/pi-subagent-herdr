# Multi-pane waiting — agreed implementation objective

Status: FIRSTMATE ACCEPTED (2026-10-03), source accepted; user subsequently authorized scoped commit and normal GitHub push, not deployment. Original independent probes rejected four core violations and a missing native input schema. Corrected source passes the full suite and original probes; fresh native originals and independently absent fixtures close acceptance. Evidence: `docs/evidence/multi_wait_native_acceptance.json`; correction/red→green provenance: `docs/evidence/multi_wait_root_correction.json`; historical rejection: `docs/evidence/multi_wait_root_review.json`. Team claims below remain superseded provenance.
User requested mandatory selection for expressiveness and caller deliberation.
Firstmate/buddy discussion established freshness and settlement constraints.

## API

Extend existing `subagent_wait`, not the tool count:

- `{ pane, timeoutMs?, returnLines?, maxChars?, source? }`: unchanged single-pane behavior.
- `{ panes: [...], until: "first" | "all", timeoutMs?, returnLines?, maxChars?, source? }`.
- Exactly one of `pane` / `panes`. `panes` must be nonempty with unique pane IDs and
  requires `until`; `pane` rejects `until`. Validate before waiting/mutation.
- No implicit first/all default, public cursor, persistent task registry or extra
  orchestration layer. Do not change dependency or model configuration.

## Semantics

First means first eligible terminal observation by this call, not globally first
finished task. Preserve existing per-pane pending-submission freshness and identity
checks. Without pending context, an already-terminal snapshot cannot win; an
observed nonterminal-to-terminal transition can. Preserve `may_reflect_prior_turn`
and all other attribution limits: terminal state is never task acceptance.
Blocked is an actionable terminal observation, with needs-attention semantics.
If only snapshots/errors remain, return immediately with no winner and their
summary. Never wait the whole deadline for an impossible winner.

All is an observation barrier: collect each pane's existing wait outcome,
including explicitly labelled current snapshots and errors. Pending submission
freshness is not bypassed. All returning does not mean all tasks succeeded or
that no-context snapshots prove submitted tasks ran. Blocked/errors must not be
reported as success. Return partial results plus explicit still-pending panes at
the shared deadline. Error/unknown observations remain distinct from terminal.
A working result after identity drift is not a completed all-barrier member:
continue bounded observation or report it pending/unknown, without task attribution.

Use one deadline from call start for either mode. Per-pane failures must remain
visible without silently ending healthy peers' waits. Do not invent retries or
keep error-only candidates alive indefinitely. Caller cancellation and a first
winner cancel/reap only local monitors, never stop/close/interrupt remote workers.

Settlement is a delivery obligation: every fresh observation whose pending
context was settled must appear in the returned summary (pane, status, seq,
code, observation/attribution and outcome as applicable). Canceled-before-observation
losers remain pending. No naive Promise.race that drops already-settled loser
observations. Do not lose observations during console capture/cancellation.
First returns bounded winner console plus compact loser summary; all returns
per-pane observations with explicitly bounded output. Preserve console-source,
Unicode, zero-cap and console/status isolation semantics. Define/document aggregate
output bounds rather than accidentally multiplying default console output.
Promise only first observed; deterministic input order applies to observations
found together, not a universal chronological tie guarantee.

Console-text bounds exclude metadata/rendering overhead. For positive `maxChars`,
first returns at most `maxChars` code points for the winner (no loser console);
all returns at most `panes.length × maxChars` across its consoles. Existing zero-cap
semantics are unchanged: `returnLines:0` disables capture; `maxChars:0` disables
character clipping, not console capture, so no character bound is promised in that
case (line bounds and transport limits still apply).

## Acceptance

- Failing-first regressions for both modes, pre-dispatch validation, stale snapshots,
  fast pending tiers, busy attribution, blocked/error/missing panes, identity drift,
  deadline/partial returns, caller abort, late/near-simultaneous observations,
  losing-context settlement and local process cleanup.
- Single-pane, all existing tools and tests preserved; full `npm run check` with
  original test timeout, no weakened assertions or dependency changes.
- Independent reviewer plus conceptual critique reconciled by controller.
- Fresh current-source native verification on disposable owned fixtures: concurrent
  waits, first then later wait on loser, all/partial timeout, pane disappearance and
  worker survival/local monitor reaping. The current root host still exposes only
  single-pane input; stale native schemas or SDK/direct-CLI tests alone are not new-wrapper proof.
- Report exact evidence and unresolved limits; no claimed acceptance based only
  on lifecycle done. Root Firstmate independently accepts final result.

Packaging/bundling and Durable experiments remain separate later objectives.
User subsequently authorized scoped commit and normal GitHub push. External edits,
configuration changes, deployment and package publication remain unauthorized.

## Root correction checkpoint (2026-10-03)

The bounded correction candidate was stopped and preserved after source review
found polling, terminal-drift promotion, unbounded preflight and incomplete cancellation
contracts. The Firstmate took core ownership rather than accepting a green-screen fix.
The owned writer's persisted partial report is not acceptance; its pane was closed with
independently verified typed absence. No peer pane was controlled.

The corrected implementation latches eligible observations synchronously, starts one
deadline before concurrent preflights, preserves real drained observations, and awaits
actual local transport cleanup. Caller/deadline cancellation remains active through
console capture. First retains winner console and compact loser metadata; all retains
per-pane bounded console. Registered native input exposes panes/until, and model-visible
text now carries settlement sequence/attribution and nested console, not renderer-only data.
Fully observed blocked barriers remain needs-attention; blocked plus pending is partial.
Preflight failures preserve actual Herdr/transport types rather than inventing error names.

Independent `npm run check`: 224 passed, zero failures/cancellations/skips; all four
original root probes pass. Corrected test schedules were independently discussed with
secondmate: late release cannot imply an observed loser, pre-deadline release is not
post-deadline, abort-after-return is not mid-flight abort, and no release cannot produce
a winner. Real listener removal, active Timeout resource counts after winner/abort, reverse
ready-order and delayed transport-reap tests replace weak behavioral guesses. The compact-loser assertion removed by the worker
was restored. Exact red/green evidence and source hashes are in the correction artifact.

## Native acceptance and limits (2026-10-03)

Firstmate inspected original session schema/calls/results, actual monitor PIDs and
hidden file digests; secondmate's bounded critique found no rejection-worthy gap.
The fresh host explicitly loaded the existing provider, reporter and repo extension:
`--no-extensions` alone omitted the custom provider, not an unavoidable config blocker.
Physical model was `home-llm/qwen3.8-27b-nvfp4-dflash2-direct`.

Verified natively: panes/until registration and self-guard; first then a later fresh
loser wait; shared-deadline all-partial with a working peer; all-complete snapshots;
mid-wait pane disappearance preserving `agent_not_running` and the healthy peer;
controller Escape returning aborted, PID reaped, remote child still working and later
completing a clean oracle; two simultaneous first monitors with the later-input winner,
compact pending loser and both local monitors reaped. Final reload proof preserves
missing `agent_not_found` plus healthy snapshot and truthful early-error hint.
A separate genuine Pi/LLM native JSON print-mode call, with process-only empty PATH,
preserves actual preflight `SpawnError`/`ENOENT`; no Herdr binary was spawned, no remote
operation occurred, and no installed/profile configuration was changed.

An early error originally claimed deadline expiry in its aggregate hint. A failing
assertion caught it; only hint selection/wording changed, then full suite/probes and
fresh reload native result passed. Initial task punctuation accidentally added `.`:
those commands exited1 despite matching digests and are not clean task-success proof.
Later exact-command Bash results have `isError:false` and independent matching oracles.
Actor prose mistook first/error returns for deadlines; original tool results prevail.

Busy attribution, blocked multi-mode and identity drift remain core/unit/probe-verified,
not native-proven. No statistical/model-reliability or broader orchestration guarantee.
Console tails are snapshots, not extracted assistant answers. The current root caller's
schema remains single-pane until appropriately refreshed; no installed rollout is claimed.

Owned fixture panes p1–p4 and workspace w2F are independently absent with typed
`pane_not_found` / `workspace_not_found`; peer/user resources were preserved. Handles
are historical provenance only, never reusable. `npm run check`:224 passed, no failures,
cancellations or skips, original timeout; original four root probes pass. Exact final
source hashes, originals, limits and cleanup are in the native acceptance artifact.

## Root independent review (2026-10-03; historical rejected source)

Independent `npm run check` passed 202 tests, no failures/skips, with unchanged
assertions/timeouts. Separate deterministic probes against that built source fail:

1. `first` waits for both monitors and selects by input order even when the second
   input was observed terminal first; it neither returns early nor picks first.
2. Caller abort during active monitoring is not forwarded to the local monitors;
   they remain active until another completion/deadline.
3. `all` with blocked panes returns `ok:true`, violating needs-attention semantics.
4. A reused terminal identity can settle old pending context and become a winner.
   Source inspection also finds missing identity checks in terminal monitor settlement.

Secondmate independently concurs with these source-level blockers. Existing fake
abort tests exercise pre-abort, not mid-flight cancellation; passing fake tests are
not proof of resource reaping. Require failing-first staggered/deferred monitor,
mid-flight abort, blocked/mixed all-barrier and terminal identity-drift regressions
before implementation corrections. Root additionally verified that `WAIT_PARAMS`
requires `pane` and contains neither `panes` nor `until`, while `DESC.wait` describes
single-pane only. The team's index diff changed output fields/summary, not native
input registration. Correct the input schema/description and cover it in the existing
registration harness before claiming new-wrapper availability.

Preserve observed losing settlements when first
cancels/reaps other local monitors. Native verification follows repaired core checks.

The production trace calls are guarded by `PI_MULTIWAIT_TRACE`; the earlier claim
of unconditional stderr pollution is not supported. Root read-only catalog checks
under the unchanged minimal profile confirm that `--no-extensions` cannot discover
`home-llm/qwen3.8-27b-nvfp4-dflash2-direct`, while ambient extension discovery can
(`agent/multi-wait/catalog-no-extensions.log`, `catalog-ambient.log`). This supports
provider-extension omission as the fixture issue; the exact fallback to the displayed
Codex model is still unverified. Do not assume a runtime/config change is required.

Controller restoration of the lead's concurrent `PROJECT_OVERVIEW.md` edit was
unauthorized; current user-approved documentation has been restored by the lead.
Foreign edits must not be reverted to manufacture a clean baseline. Former controller
pane is now a user-designated other-repository peer, not a test/cleanup resource.

Evidence: `docs/evidence/multi_wait_root_review.json` includes original outcomes and
source hashes. Ephemeral reproduction: `agent/multi-wait/root-adversarial.mjs`;
independent full-suite log: `agent/multi-wait/root-check.log`. No live panes were
created or controlled by these probes. No acceptance, commit or push is claimed.

## Team implementation outcome (2026-10-03, multi-wait-20261003; superseded verdict)

- Implemented: `subagent_wait` extended with `{ panes: [...], until:
  "first" | "all" }` (mandatory until; exactly one of pane/panes; no new
  tool). Single-pane behavior and result shape unchanged (all 163
  pre-existing tests pass unchanged).
- Code: src/core.ts (+679: routeWait, multiWait, settleAtObservation,
  finishMultiWait, multiConsoleSpread), src/index.ts (+58: panes/until
  schema, description, output schema), tests/multi_wait.test.ts (new, 39
  tests).
- Full `npm run check` (typecheck + node --test --test-timeout=10000):
  202/202 pass, 0 fail — run independently by the controller, by the
  independent reviewer (Signe), and by the writer (Nils); same original
  timeout, no skips, no dependency changes.
- Independent review (Signe, readonly): pass — contract + controller
  adjudications checked line by line, diff audited vs baseline 6d68275,
  two independent black-box probes against the built core, side-effect
  audit clean (reported one out-of-scope anomaly: a concurrent foreign
  edit to PROJECT_OVERVIEW.md, which the controller restored to baseline).
- Conceptual critique (Ada, readonly): contract hazards a–f + 10
  adversarial cases; all resolved by controller adjudications A1–A14
  (recorded in agent/multi-wait/handoff-nils-wait.md) and reflected in
  the implementation and tests.
- NATIVE LIMITATION (acceptance gap, honestly reported — NOT a pass):
  fresh fixture hosts launched with the current-repo extension could not
  run LLM turns (the fixture hosts' model was forced to an unsupported
  codex model regardless of --provider/--model; fixing it requires
  out-of-scope runtime/config edits). Details + evidence:
  agent/multi-wait/native-live/RESULT.md. Consequently the new-wrapper
  multi-pane behavior is proven at the core level (39-test unit suite +
  reviewer black-box probes) only; per the contract, SDK/direct-CLI/unit
  evidence alone is not native new-wrapper proof.
- Evidence: agent/multi-wait/ (team-registry.json,
  worker-report-nils-wait.md, native-live/RESULT.md, handoffs) and
  agent/multi-wait/controller-report.md (Maren → Felix).
