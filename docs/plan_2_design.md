# Plan 2 — first-version design (awaiting user approval)

## Goal and approved choices
Meet REQUIREMENTS.md R-1..R-10 with native Pi tools, distinct `subagent_*` names, Escape interruption, and reuse of the existing bash worker runtime. The external readonly brief-delivery patch is authorized independently. Destination verified: Pi 0.99.1, Herdr 0.9.3. No extension implementation is authorized until this plan is approved.

## Architecture
Small TypeScript Pi package: entrypoint/registration and footer; injected asynchronous Herdr CLI transport; validated JSON adapter; worker-runtime resolution and safe shell quoting; lifecycle operations; automated tests. Keep UI separate from operations. No subprocesses in extension factory. Use installed SDK declarations/examples, output schemas and structured results. Invoke CLI with argv, not shell strings; only pane run requires an atomically quoted wrapper command.

Runtime directory: explicit extension configuration/flag or environment (`PI_SUBAGENT_RUNTIME_DIR`), with documented discovery under the active Pi profile. Validate required files before launch; no historical absolute paths, downloads, installs, or silent runtime fallback. Invoke `herdr-worker.sh --mode <mode> --` WITHOUT task arguments: source confirms the lower-level wrapper allows this and consumes its separator. Do not call the task-requiring `herdr-start-subagent.sh` with fake briefs. Wrapper owns provider/model/profile resolution, trusted extensions and guards.

## Tool surface
- `subagent_start`: name, cwd, readonly/editable mode, task, wait mode (`none`, `bounded`, `finish`), timeout, tailChars (default 50), optional report path included in the task contract. Split without focus, run wrapper, detect, rename, then prompt. Return pane even on detection/delivery uncertainty; never duplicate-launch automatically.
- `subagent_prompt`: existing Pi target, task, wait mode/timeout/tail. Preflight rejects working/blocked. Serialize extension-controlled submissions per target; external senders remain an unavoidable race.
- `subagent_read`: target, line limit, optional character tail; lifecycle-aware recent-unwrapped, explicit raw-pane fallback choice.
- `subagent_wait`: target, timeout, tail, optional sequence baseline. Without baseline, inspect/wait for current terminal state and label it a snapshot. With baseline, require newer state and label it observed activity, never proof of an identified task.
- `subagent_send`: raw terminal text plus Enter, not a substitute for agent_prompt. Verify multiline semantics before shipping.
- `subagent_interrupt`: Escape, never CTRL-D.
- `subagent_list`: current workspace panes with joined agent names/status.
- `subagent_spaces`: workspaces.
- `subagent_close`: idempotent close, verify absence.
- Footer: HERDR_PANE_ID via ctx.ui.setStatus only when present in TUI.

## Delivery, waits and truthful outcomes
A successful prompt submission is a transport receipt, not acceptance of the work. Blocking/bounded prompt uses Herdr `agent prompt --wait`: it requires observed working/blocked within its 5s grace, then matches idle/done/blocked. Timeout or stalled is not success and does not prove non-delivery. Never resend automatically. For no-wait mode submit once and return submitted, not finished. A later standalone wait cannot retrospectively prove a turn that it did not observe; expose that limitation.

Do not call a lifecycle terminal state successful task completion: return `terminal_observed` (idle/done), `needs_attention` (blocked), `submitted`, `timeout`, `stalled`, `cancelled`, or `error`, plus transport delivery known/unknown, state/seq and bounded console evidence. Human/lead acceptance requires task-specific output/artifact checks. A fast turn missed by Herdr's working gate may produce stalled; report honestly, inspect output, never fabricate a completion guard using seq or echoed nonce. Live tests determine whether the supported runtime supplies adequate transitions.

Cancellation terminates only local CLI/wait resources; it neither interrupts nor closes the worker. Cancellation during submission means delivery unknown. Keep pane ID and inspection guidance available. Reap subprocesses/timers. Do not automatically close active workers on extension shutdown.

## Safety and error boundaries
Reject supervisor self-target for send/interrupt/close. Default these controls to panes launched by this session; allow explicitly acknowledged external targets using a clearly named opt-in parameter (not a claim of user authorization), restricted to current workspace. Existing user/buddy panes are never used by implementation smoke tests. Reconstruct owned-pane metadata from session records and verify live workspace identity; never trust a stale ID alone. Confirm this scope behavior with user as part of approval.

Check Herdr context and dependencies before action; missing context becomes structured actionable error, not a Pi crash. Preserve CLI typed errors and stderr; distinguish pane creation, detection, submission and waiting phases. Missing detection is not automatically runtime crash. Bound reads by SDK output limits; Unicode tails count code points, not half-surrogates. Timeout ceilings and explicit limits documented; no arbitrary infinite polling.

## Verification gates
1. External skill fix: actual runtime argv parser regression plus launcher suite; isolated readonly inline brief task answered correctly; readonly guard still active; cleanup verified. Actual argv has no `--` before payload: bare flag loses BRIEF but INSTR survives. `--dm-read=1` preserves both.
2. Automated tests: adapter/quoting/validation, fake transport state sequences, detection timeout, fast-task stalled, blocked, prompt rejection, ambiguous delivery, abort in each phase, parallel prompt serialization, Unicode/truncation, join/list, idempotent closure, self/external safeguards, missing dependencies, footer inside/outside. Typecheck and package-loading tests.
3. Real CLI contract checks in owned scratch workspace; readonly/editable end-to-end delivery with task-specific answer/artifact verification; wait and console tails; text+Enter including multiline; working Escape abort; list/spaces/close and verified cleanup; footer visual evidence; co-loading pi-herdr when available. Verify dependencies/env reach workers, not merely versions.
4. Requirement-to-evidence matrix R-1..R-10, independent review and lead verification; installation/usage/errors/dependencies docs; curated findings/handoff. No push/publish unless requested.

## Final peer-review refinements (adopted)
- Bounded submission returns a continuation record with pane/workspace/terminal identity, submission baseline, observed working evidence when available, and current state/seq. `subagent_wait` can continue from it; if working was observed and a newer terminal state appears, return `terminal_observed_after_working`. If the worker finished between calls, compare identity and sequence against recorded working evidence. Working evidence must come from an actual sampled `agent get` working state or an explicit CLI response reporting working, never merely from a timeout: the timeout can expire before the 5s grace. Observe get concurrently while bounded prompting if continuation evidence is needed, without sending extra input. If no working evidence exists, retain snapshot/activity semantics; never infer task execution. External submissions remain a documented correlation limit.
- Stalled/timeout results include current get and tail in the same result. Reliability gate: at least 10 trivial and 10 normal prompt trials with task-specific answers checked, plus 10 start/immediate-prompt trials per mode. Require zero false terminal/completion claims and zero unexplained stalled or lost-task results in normal trials. Any failure must be diagnosed and fixed or escalated before shipping, not hidden by heuristics. Record all stalls, including explained ones, in the evidence matrix so recurring reliability problems remain visible.
- Ownership persists across reload/resume of the same session, not a new session or fork. Record pane/workspace/terminal ID, agent name, launch time and session identity; require matching live identity before control. A rename/mismatch/reused pane ID makes it non-owned. Add simulated ID-reuse/reload tests. If installed CLI cannot supply adequate stable identity, require explicit confirmation rather than assume ownership.
- Close of an external current-workspace pane requires real UI confirmation; deny when confirmation is unavailable. Send/interrupt require explicit external-target opt-in and never target the supervisor. This model opt-in is not user authorization. Test workers never target user/buddy panes.
- Defaults: detection 15s; bounded wait 30s; finish/wait 30min; configurable finite maximum 60min. None mode still requires detection/submission to finish. Tail defaults 50 code points for bounded start/prompt, 2000 for finish/wait/read; line default 100; enforce finite output bounds.
- Runtime discovery precedence: explicit registered CLI flag, then PI_SUBAGENT_RUNTIME_DIR, then selected profile skill scripts directory. No additional config file in v1. Validate reporter through the runtime's actual profile rules.
- Expose phase on every result. Shutdown reports remaining owned panes without terminating them. Multiline send must be live-verified; reject clearly if unsupported instead of quietly modifying input.

## Work allocation
Firstmate owns design, integration, acceptance and conversation. Buddy is an equal-level design/review partner; cheap workers receive bounded outcomes (runtime fix with regression, transport/core operations, tool registration/tests, independent live/contract verification) after their scope is ready. No delegation of final architecture or acceptance.

## Peer review and approval
Initial buddy discussion informed tools, structured errors, cancellation and dependency checks. Nonce echo and stable-idle heuristics are not adopted as delivery/completion proof. Final buddy review identified continuation semantics, fast-turn reliability and reload identity as approval blockers; the refinements above resolve them. Buddy Nora explicitly found no remaining approval blockers after rereading those refinements. Her suggested timeout implication is not adopted: an early timeout does not prove working; actual sampled evidence is required. User approval pending. Pause before extension implementation if approval is not available. Escalate missing dependencies, contradictory semantics or unsafe ownership rather than working around them.
