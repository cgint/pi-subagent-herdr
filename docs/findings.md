# Findings — historical discovery and current boundaries

**Date:** 2026-09-30 · **Herdr CLI:** 0.9.3 · **Lead:** Horst · **Peer audit:** Judith (w2V:p2)
**Sources:** `docs/worker1_report.md` (live CLI experiments, incl. Follow-Up EXP A/B/C), `docs/worker2_report.md` (scripts + sibling extensions + Pi API), `docs/worker3_session_mining_report.md` (320-session mine), `docs/worker4_script_usage_report.md` (skill-script usage/caveats mine), lead's real-wrapper experiment (2026-09-30, scratch workspace w35, pi 0.99.1).
**Labels:** [Observed] = live experiment in this project · [Documented] = read from source/help · [Inferred] = derived.
**Scope constraint:** [Inferred from REQUIREMENTS.md wording "this is the only supported"] Pi is the only supported sub-agent. No Claude/Codex behaviour needed. (Judith: label the inference, keep it confirmable.)

---

## Current verified boundary (2026-10-02)

Historical discovery/open-decision labels below are not continuation instructions. User authority/scope corrections at §6 govern; first-version acceptance evidence and remaining limits live in docs/live_verification.md/docs/acceptance.md.

- Actual child stdout proves Herdr/model env reach; genuine SDK session isolation/cancel PID reaping and registered/directCLI parity are recorded. Console tails remain snapshots, not answers. Finish tails and nonterminal-success rejection are repaired/tested.
- Separate348-call Qwen loop was honestly timed out and Escape-recovered. Fixed20turn batch passes only its functional contract. Multiline rejected; genuine sibling unavailable, co-load not claimed.
- SDK1.0.0 host-peer packaging validated without bundled host modules. Real residual host brace-expansion DoS risk explicitly reassessed in docs/security.md; no clean audit.
- Pure installed1.0.0 parseArgs still loses positional BRIEF after --dm-read; extension never passes positional tasks. The later authorized extension-loading rollout leaves that parser behavior unchanged.
- [Observed] Fresh deployed native editableL1→readonlyL2 original tool/hash/cleanup proof: evidence/nested_worker_live.json. Readonly workers load pi-subagent-herdr but their whole --tools allowlist excludes native calls; default start is readonly, so recursive controllers must explicitly be editable.
- [Peer-reported] Authoritative runtime/source tests/skill docs generated/deployed and normally pushed by the ~/.local/bin Firstmate as ee6810c. He pushed before the agreed live gate; the later independent passing probe supplements, not erases, that sequencing error. Old-process tool availability is unverified, not acceptance evidence.
- Rejected packaging red was ENOENT/incorrect path assumptions, not Node defect or true TDD. Correct root lookup and genuine later controlled old-manifest assertion failures are preserved. Do not repeat those false claims.

## 1. Per-requirement table

| Req | Needed Herdr primitive (extension implementation) | Evidence | Status |
|---|---|---|---|
| **R-1** start sub-agent (readonly/editable, "as the scripts allow") | `pane split --current --direction <d> --cwd <d> --no-focus` → parse `pane_id`; `pane run <pane> <wrapper>`; poll `agent get <pane_id>` (0.5 s steps) until `agent_status != unknown`; `agent rename`; return JSON `{ok, name, pane_id, agent_status, state_change_seq, agent_detected}`. Worker side: profile resolution (`PI_WORKER_PROFILE`, default `minimal`), `-ne` + explicit extensions (focus-guard, tool-intent, `herdr-agent-state.ts`, provider ext), `.sub_agent_conf` → `PI_WORKER_DEFAULT_MODEL` → codex/copilot model chain with pre-launch `--list-models` probe, `readonly` = `--tools read,bash,grep,find,ls --dm-read` + `PI_WRITE_GUARD_DIRS=.`, `editable` = full tools + same env guard. ⚠ Task delivery via positional payload is **not** reliable in readonly mode — see §3.1. | [Documented] Clara §1 (launcher/wrapper/runtime source incl. tests); [Observed] Fritz §5-6 (pane split/run mechanics, 0.9.3); [Observed] lead w35 experiment: wrapper launch end-to-end in scratch workspace (detection, idle startup state, extensions loaded). Usage reality: 611 launches (start 454+157), start > await > prompt. | **Settled** (mechanics). *Open: reuse bash wrapper vs port to TS* (open decision 3, updated with §3.1 evidence). |
| **R-2** wait-for-finish directly, **or** return after x s with last 50 chars | Blocking: `agent prompt <t> <text> --wait --timeout <ms>` when we submit the prompt (atomic; 5000 ms working-grace, then matches `idle|done|blocked` or `--until`). Fresh-agent case (task via `pane run`): **two-phase, seq-gated** — record S0 at detection, `agent wait --until working`, then `agent wait --until <terminal>`; guard: if `seq > S0` **and** status already terminal, treat as finished (fast-task case). Partial return: short `--timeout` + `agent read --lines N --source recent-unwrapped` + client-side `slice(-50)` (Herdr slices lines only, not chars). **Delivery proof is mandatory:** a higher `state_change_seq` plus a terminal status does NOT prove the task ran (seq also advances on startup transitions, and an undelivered task ends in the same terminal state — see §3.1 and caveat 12). Delivering the task via `agent prompt` after detection is the fix: it gives confirmed delivery (`prompt.sent`) and a clean baseline seq for the wait. | [Observed] Fritz §4.3, EXP B (two-phase sound: seq 2819 > 2816 > 2816; bare `--until idle` on fresh agent returned stale idle in **36 ms**), §3.2 (no char slicing); **lead real-wrapper EXP B (w35)**: *fast-task guard test — RE-INTERPRETED per Judith audit*: that run was a readonly + inline-brief launch whose brief was never delivered (§3.1); the seq advance (→2968, terminal `idle`) was **startup only, not task completion** — so seq-gating alone was shown to be insufficient proof of "finished". *Slow-task run (sound)*: task delivered via `agent prompt` (confirmed), phase 1 `--wait --until working` returned at working (seq 2985), phase 2 `agent wait --until idle --until done` returned at **done** (seq 2986). [Documented] EXP C help text (5000 ms grace, `agent_prompt_stalled`). Mining: 100 % of real usage is synchronous blocking (`herdr_await_agent --timeout-ms 1800000` dominant, `--lines 100`) → long-running tool calls are the norm; the "return after x s with tail" case is served by the bounded-wait + read-tail tool itself, not a separate polling loop. | **Settled** (two-phase seq-gated wait sound **given confirmed delivery**; delivery via `agent prompt` post-detection — see §3.1, caveat 12). |
| **R-3** get console content | `agent read <target> --lines N --source recent-unwrapped --format text` (lifecycle-aware, primary channel; strips ANSI/Pi status-bar wrapping). `pane read` for raw terminal-level access. Output is plain text on stdout (no JSON envelope without `--raw`). | [Observed] Fritz §3 (all `--source` variants, `--lines`, `--format`). Mining: `agent read` 273× + `pane read` 124×; `recent-unwrapped` is the consistent real-world choice. | **Settled**. |
| **R-4** wait for a console to "finish" (`--wait`), then return last x chars | `agent wait <target> --until idle,done,blocked --timeout <ms>` (event path; without `--until` matches exactly those) + polling fallback (pi-herdr's event+poll race pattern; poll `agent get` every ~800 ms) — because the CLI has **no** "wait for state change since seq X" primitive: the extension must implement seq-gating itself (poll `agent get`, require `state_change_seq` > S0) for panes it did not prompt. Then `agent read --lines N` + client-side `slice(-x)`. **Terminal-state race must include both `idle` and `done`:** startup state of a real worker was `idle` (seq 2968) while the finished-task state was `done` (seq 2986) — an `--until idle`-only wait would have timed out. | [Observed] Fritz §4 (wait payloads success/timeout, race), EXP B (stale-state failure mode); **lead real-wrapper EXP B (w35)**: startup idle → post-task done, both observed on one self-reporting worker. [Documented] Clara §2.1 (pi-herdr `waitForStatus` event+poll race; `agent read` `textOk` handling). | **Settled** (mechanics: event wait + poll fallback + seq-gating; idle/done union confirmed by live run). |
| **R-5** send text with `<enter>` to another pane | `pane run <pane> <text>` = text + Enter in one call (preferred); or `pane send-text <pane> <text>` then `pane send-keys <pane> enter` (send-text does **not** auto-submit). Key spelling: `ctrl+X` only (`ctrl-X`, `C-X` rejected). Multi-line text behaviour UNDETERMINED. For *agent turns* use `agent prompt` (lifecycle-aware) instead — pane-level injection is for raw terminal control. | [Observed] Fritz §1.1, §2, §6.1. Mining: `send-text` 10×, `send-keys` 29×, rare; skill forbids them for agent turns. | **Settled** (multi-line text: open, minor). |
| **R-6** send *interrupt* (req says "CTRL-D for pi") | `pane send-keys <pane> esc` → **turn abort**: `working` → `done`, console prints `Operation aborted`, Pi process stays alive. `pane send-keys <pane> ctrl+d` → **kill**: Pi process exits, foreground reverts to shell, agent drops to `unknown`, subsequent `agent get/read` fail `agent_not_found`. | [Observed] Fritz Follow-Up EXP A (A1 esc / A2 ctrl+d, on a *working* agent; earlier idle-prompt tests were non-evidential per Judith audit). | **OPEN — user decision.** Requirement says CTRL-D; experiments show ctrl+d ends the session. See open decision 2. |
| **R-7** list all panes in the same herdr-space (names + status) | `pane list --workspace <workspace_id>` → per pane: `pane_id`, `agent_status`, `cwd`, `terminal_title`, `focused`, `tab_id`, … **Worker names:** `agent list` exposes a `name` field per agent (null when never renamed; set by `agent rename` at launch) — join `pane list` + `agent list` by pane_id for names+status. Resolve "same space" from the supervisor's own `HERDR_PANE_ID` env → `pane get` → `workspace_id`. (Default `pane list` is all-workspaces; `--workspace` filters — corrects an earlier assumption.) | [Observed] Fritz §5.2; lead live check: `agent list` shows `name: null` on unrenamed panes and the assigned name after rename. [Documented] `HERDR_PANE_ID` present in pane env (this session runs with it). | **Settled**. |
| **R-8** list herdr-spaces | `workspace list` → `workspaces[]` with `workspace_id`, `label`, `pane_count`, `tab_count`, `agent_status`, `focused`, `active_tab_id`. | [Observed] Fritz §5.1. | **Settled**. |
| **R-9** close a pane | `pane close <pane_id>` → `{result:{type:"ok"}}`; `pane_not_found` (exit 1) when pane is already gone — **treat as success (idempotent close)**. Panes disappear when their foreground process exits (observed: `ctrl+d` kill made pane drop from agent APIs). Always verify with `pane list --workspace <id>` (real-world ritual: `close && list` 390×+381×). | [Observed] Fritz §5.3, §6.4. Mining: close+list is the universal cleanup pair. | **Settled**. |
| **R-10** (new, added to REQUIREMENTS.md 2026-09-30) display HERDR-PANE-ID in the bottom line when Pi runs inside a herdr pane | Pi extension API footer status: `ctx.ui.setStatus("<ext>", text)` → collected by TUI via `footerData.getExtensionStatuses()` → rendered in the bottom line; read `HERDR_PANE_ID` from `process.env`. Exact pattern proven by pi-herdr (footer showing agent count + version). Gate on `HERDR_PANE_ID` presence so the status stays empty outside herdr panes. | [Documented] pi-tui source: `setStatus` → `footerData.getExtensionStatuses()` → bottom line (verified in pi 0.99.1 dist + docs/examples); Clara §2.1 (pi-herdr `src/index.ts`). [Observed] `HERDR_PANE_ID=w2V:p1` in this pane's env. | **Settled** (mechanism documented; end-to-end proof lands with the extension's own smoke test). |

---

## 2. Corrections to earlier assumptions (discovery output)

- `pane list --workspace <id>` **does** filter (default is unfiltered). [Observed]
- `pane run` sends text **and** Enter in one call. [Observed]
- Pane's process exited ⇒ pane gone from agent APIs ⇒ close must treat `pane_not_found` as success. [Observed]
- `agent prompt --wait` timeout error is `timed out waiting for agent status` (agent domain), **not** the pane wait-output message. [Observed, corrected]
- `esc` on an idle prompt is non-evidential (expected no-op); only the working-agent test counts. [Audit]
- Herdr version-branching (0.7.x legacy paths in pi-herdr) is **dead code here** — 0.9.3 is installed. Don't port it. [Documented + Observed]

## 3. Standalone findings

### 3.1 Launch-time task delivery: `--dm-read` swallows inline briefs (real-wrapper experiment, w35; parser behaviour pinned to pi 0.99.1 — a Pi update could change or fix it)

**Root cause [Observed + verified against pi's own 0.99.1 parser]:** In pi 0.99.1, `--dm-read` is **not a core flag** — it is registered by the `pi-focus-guard` extension at load time (`pi.registerFlag("dm-read")`, focus-guard.ts:134). The CLI arg parser runs *before* extensions load (`parseArgs` in dist/cli/args.js), so at parse time `--dm-read` is an **unknown flag** — and the unknown-flag branch (args.js:226–241) **consumes the following non-dash, non-`@` argument as the flag's value**. Verified deterministically by calling pi's `parseArgs` directly:

| Invocation | `parsed.messages` | Result |
|---|---|---|
| `-ne --dm-read BRIEF` | `[]` | brief swallowed into `unknownFlags["dm-read"]` → worker boots **idle, task lost** |
| `-ne BRIEF` | `[BRIEF]` | delivered ✓ |
| `-ne --dm-read @/x/handoff.md` | `[]` (but `fileArgs=["/x/handoff.md"]`) | `@`-args are excluded from swallowing → handoff **works** ✓ |
| `-ne --dm-read=1 BRIEF` | `[BRIEF]` | `=`-form sets the value, brief survives ✓ |

**Impact on the current production skill [Observed]:** `pi-worker-runtime.sh` appends `--dm-read` **only in readonly mode**. Therefore: **readonly + inline `--brief` launches silently lose the task** (worker boots idle); readonly + `--handoff` and all editable-mode launches work. This matches the mining evidence: `--handoff` is the dominant delivery form, so the latent bug went unnoticed. Live confirmations in w35: wrapper readonly+brief boot showed 0.0 % context / no user message in the session file; `agent prompt` to the same worker delivered the task reliably (2/2).

**Design implication for the extension:** the launch tool should **deliver the task via `herdr agent prompt` after agent detection** (works in all modes, adds preflight + `--wait` semantics, matches supervisor follow-up behaviour) instead of relying on the positional payload at `exec` time. If the wrapper is kept (decision 3), patch the readonly flag to the `--dm-read=1` form or move `--dm-read` ahead of the payload with an explicit `=` value. **Also worth flagging to the user as a bug in the current skill** (one-liner fix in `pi-worker-runtime.sh`).

### 3.2 `herdr-agent-state.ts` dependency

Worker Pi self-reports lifecycle state to Herdr via the profile extension `herdr-agent-state.ts` ([Inferred from Clara §1.3: "installed with `herdr integration install pi`"]). Without it, pi panes rely on Herdr's auto-detection only — weaker, and the launcher hard-fails if the file is missing from the profile dir (sources: `herdr-worker.sh` → `HERDR_REPORTER=$(pi_worker_herdr_reporter_path)`; `pi-worker-runtime.sh` `trusted_extension` check: `[ -f "$trusted_extension" ] || exit 1`; and `extension_args+=(-e "$trusted_extension")` before `exec`). **Any extension that launches worker Pi must include this extension in the launch** (the wrapper loads it explicitly; a TS port must too). [Documented] Clara §1.3, §2.1; [Observed] w35 wrapper boot: extension present in the pane's `[Extensions]` banner.

## 4. Design caveats from session mining (become tool semantics)

From 320 sessions (1,947 herdr tool results; 58 typed errors: 23 `agent_not_found`, 11 `invalid_key`, 8 `timeout`, 6 `pane_not_found`, 5 `protocol_mismatch`, 2 `server_not_running`, 2 `workspace_not_found`, 1 `agent_prompt_stalled`):

1. **Typed errors, not terminal text** — map the 8 observed error codes into structured tool results.
2. **Detection race** — `agent_not_found` right after launch (23×): launch tool must poll for detection; `agent_detected: false` ≠ launch failure — **never re-launch the same name while its pane exists** (re-launching duplicates the worker and orphans the first pane).
3. **`ok:true` ≠ acceptance** — terminal states trigger inspection, not acceptance (script contract, followed in sessions).
4. **Report artifact on disk is the deliverable**; terminal harvest is a status peek.
5. **No blind resend** after timeout/`agent_prompt_stalled` — inspect `agent get`/`agent read` + compare `state_change_seq` first.
6. **Timeout is a wait ceiling, not a worker kill** — on timeout, inspect; the worker keeps running.
7. **Preflight on prompt** — refuse `working`/`blocked` targets (`prompt.sent:false` + reason); `prompt.sent` is the only delivery signal.
8. **Write-guard semantics** — a blocked write in a readonly worker is guard *success*. *(Correction, 2026-09-30, verified against installed `pi-worker-runtime.sh`: the write guard covers `.` in both modes with **no** report-path carve-out; the earlier "carved out" statement was an assumption. Readonly trial evidence is terminal-only; report artifacts belong to editable trials inside the worker cwd.)*
9. **Pane-scoped control plane** — all primitives presuppose the supervisor Pi runs inside a Herdr pane (`HERDR_ENV=1`, `HERDR_PANE_ID` set); the extension must check and report this at session start (pi-herdr toasts on missing herdr).
10. **Long model turns are normal** — modal await timeout 30 min; tool implementations must tolerate multi-minute waits with AbortSignal support.
11. **Peer Pi runtime breakage** — workers have hit a broken/corrupt Pi runtime (missing JS chunk → pi fails to start mid-session); the supervisor must treat "pane alive but no agent / crash text" as a distinct failure class from `agent_not_found` and surface the pane for inspection rather than retrying blindly. [Observed in sessions] Wilhelm §failure-surface.
12. **Seq + terminal ≠ task ran** — `state_change_seq` advancing plus a terminal status does not prove the task executed (seq advances on startup; an undelivered task ends in the same terminal state). Launch+wait requires delivery proof: task visible as a user message / answering output (`agent read`, session file), or — the recommended design — delivery via `agent prompt` post-detection, which both confirms delivery and yields a clean baseline seq. [Observed w35, per §3.1 / R-2 re-interpretation.]

## 4b. Measurement note (usage counts)

Stefan's numbers (320 sessions, 101 with commands, 1,947 tool results, 58 typed errors) are **per-call** counts of herdr CLI invocations. Wilhelm's numbers (start ≈1126, await ≈706, prompt ≈536) are **grep line-hits** in the session JSONL (one line can contain multiple mentions, and error lines are counted in both). They measure different things; do not mix them.

## 5. Open questions (unanswered by any worker)

- Tool-name **collision with pi-herdr** if both extensions load (`herdr_*` names).
- Pi's **output truncation limits** for tool results (affects `--lines` defaults).
- Do **HERDR_\* env vars reach processes the extension spawns** (workers)?
- How long does **agent detection** actually take; does `agent read` work before detection? (EXP B suggests ~0.5–5 s; not precisely measured.)
- **Tail edge cases:** wide characters, trailing blank lines in `agent read` output.
- **Multi-line `send-text`** behaviour.
- `protocol_mismatch` (5×) / `server_not_running` (2×) root cause & recovery — no pattern observed.

## 6. Decisions (current canonical)

**First-version decision state (2026-09-30):** Plan 2 was designed, peer-reviewed (buddy: no approval blockers), and — after the user delegated technical design, implementation and acceptance to the Firstmate — implemented without a human approval gate. The repository-only scope correction (below) superseded the external live-skill patch option; the extension reuses the installed runtime unchanged with no positional task. Acceptance state is tracked in `docs/acceptance.md` per the live acceptance contract (`agent/live-acceptance-contract.md`); source evidence in this file is historical, authoritative requirements stay in `REQUIREMENTS.md`.

**Approved (user) in the continuation session:** (1) distinct `subagent_*` tool names; (2) Escape for turn interruption, pane close for termination (user-approved clarification of R-6); (3) reuse the bash worker runtime initially.

**Superseded (historical only):** option 4's "patch the live skill" — the external live-skill patch/regression was authorized then **removed from scope** by the user's scope correction. The `--dm-read` brief-swallow bug remains a known quirk of the installed skill (informational; flag to user); the extension never hits it because it never passes positional briefs.

### Discovery-era options (historical rationale)

1. **Overlap with pi-herdr.** pi-herdr already ships `herdr_start_agent`, `herdr_send_prompt`, `herdr_read_agent`, `herdr_wait_agent`, `herdr_list_panes`, `herdr_close_pane`, … (five tiers). Decide: (a) build pi-subagent-herdr as a *supervisor-workflow* subset (launch/await/prompt/read/close with our caveats baked in), tolerating coexistence; (b) name tools distinctly (e.g. `subagent_*`); or (c) extend/replace pi-herdr. Tool-name collision behaviour when both load is unknown (open question 1).
2. **Interrupt key (R-6).** Evidence: `esc` aborts the turn (agent survives); `ctrl+d` kills the session. The requirement's "CTRL-D" was presumably a guess at how Pi interrupts. Recommendation (Judith): `send_interrupt` → `esc`; termination is already covered by pane close (R-9). **Your call: esc, ctrl+d, or both as separate tools.**
3. **Reuse vs port the bash wrapper.** Keep `herdr-worker.sh`/`pi-worker-runtime.sh` as the worker entrypoint (extension only orchestrates via `pane run`, zero worker-side change, proven quoting/safety) **vs** port model-resolution/`.sub_agent_conf`/write-guard logic to TypeScript (cleaner single-language codebase, but re-implements tested behaviour: shell-quoting edge cases, provider-extension probing, profile validation). **New evidence (§3.1):** the wrapper's readonly+brief delivery is broken by pi 0.99.1's flag parsing — either option must decouple task delivery from launch (`agent prompt` post-detection), which tilts the decision toward at minimum patching the wrapper's `--dm-read` handling.
4. **Patch the live skill now?** `pi-worker-runtime.sh` (outside this repo, in active use) has the `--dm-read` brief-swallow bug: every readonly + `--brief` launch today silently loses its task. Options: (a) one-line patch now (`--dm-read` → `--dm-read=1`, verified with `parseArgs`), (b) leave the skill as-is and only fix it in the extension, (c) patch + add a regression test to the skill. It matters independently of this extension — your call.

---

## 7. Safety notes (process, not product)

- Fritz ran `agent wait` against Judith's pane (w2V:p2) in round 1 — outside his scratch box; read-only, findings still valid, flagged in his report, corrected in round 2 (re-verified inside scratch only).
- Lead interrupt timing fault: both session miners were `esc`-interrupted exactly while writing their reports; both were given one bounded "write the report now" follow-up and completed cleanly. Lesson: never `esc` a worker at "looks stuck" — check `agent read` for a write-in-flight first.
- `ctrl+d` closes **whatever is in the foreground** — it exits an idle Pi *and* an empty zsh prompt (pane then auto-closes, workspace closes with its last pane). Key-sends must target the intended process; after any `ctrl+d`, re-verify the pane exists before the next action.

## Technical decision authority (user clarification)
The user owns requirements and delegates technical design, implementation and acceptance to the Firstmate, supported by equal-level buddy discussion, bounded workers and independent verification. The earlier human Plan 2 approval gate is superseded; do not ask the user to approve architecture. Escalate only actual requirements/scope/authorization blockers.

## Scope correction — repository-only extension
Original first-version scope forbade installed supervisor changes and withdrew external readonly parser patch/regression authorization. On 2026-10-02 the user separately authorized authoritative runtime/template always-on pi-subagent-herdr loading, then deployment, commit and push. The ~/.local/bin Firstmate owns that repository's source/tests/skill docs, generator/deploy workflow and Git; coordinate through messages, do not execute commands there. Reported rollout/push and independent minimal-profile nested acceptance are separate evidence. No unrelated external/config/auth changes, force push or publication are authorized. Extension implementation remains here; no positional tasks, prompt only after managed readiness.

## Live implementation regression gates (2026-09-30)

The guarded production digest probe (`docs/evidence/lead_l2_complete.json`) independently proves readonly task execution and first-close typed absence, **not full lifecycle acceptance**. Its continuation wait returned the unchanged startup idle sequence before the task began. Confirmed delivery must be distinguished from timeout/unknown delivery, and continuation waiting must reject stale terminal snapshots while keeping bounded cancellation, identity checks, idle/done/blocked support and honest task-verification limits. The installed reporter is under the selected profile's `extensions/`, not beside the launcher; v9 reports idle/working/blocked. Neither a done-only gate nor a numeric sequence-gap shortcut is justified by that source.

Plan 2's idempotence needs reconciliation with ownership removal after verified close: any previously-closed marker must be followed by a fresh typed absence probe, never treated as authority over a reused live pane ID. External-target safeguards remain mandatory. The repaired readonly L2 replay is independently verified in `docs/evidence/lead_l2_final.json`: delivery-proven continuation, sampled working → done, original computed task output, normal/repeated close and independent absence. Native lifecycle/reliability gates remain separate and pending.

For original evidence, use the actual `agent_session.value` returned by `agent get`; profile-specific session storage may differ from `~/.pi/agent/sessions/`. Role-separated worker messages and original call/result records are canonical evidence; reconstructed reports and serialized-text substring matches are not.

### Managed startup readiness and result phases

Screen-detected `pi`/`idle` can precede the editor submit handler and leave a task as an unsubmitted draft. Require authoritative managed `agent_session` metadata from `herdr:pi` before task delivery; native status/sequence alone is not readiness. Verified frozen identities must retain exact workspace and terminal IDs on mutator preflight and every continuation poll, including failure on missing metadata.

A delivered prompt previously retained the label `phase: preflight` despite original worker records proving execution. The source now reports `submission` after delivery; do not interpret that historical mislabeled result as an undelivered task or resend blindly. Native managers must reload changed source before validating the corrected label.

### Active console history boundary (Herdr 0.9.3, resumed Pi 1.0.0)

`agent read --source recent-unwrapped --lines 100` can fail with typed `agent_not_idle` while Pi is working: reading alternate-screen history would scroll the running TUI. Use the `visible` source for that specific condition; do not suppress unrelated errors or fabricate an empty tail. Idle reads retain deep history. Original failure and repaired bounded live trace are reflected in `docs/evidence/visible_tail_live.json`; native repaired-path replay is pending.

## Verification re-check (2026-10-05, on a second host: pi 1.0.2, Node 26.10.0, Herdr 0.9.3)

- **Live-skill `--dm-read` bug confirmed at parser level.** `pi-worker-runtime.sh:228-229` appends bare `--dm-read` in readonly mode. pi's `parseArgs` (dist/cli/args.js) treats an unknown bare `--flag` as consuming the next non-dash, non-@ token: with `--dm-read BRIEF`, `messages=[]` and the brief lands in `unknownFlags["dm-read"]` → task loss. Fix candidate `--dm-read=1` yields `messages=[BRIEF]`, `unknownFlags["dm-read"]="1"` → correct. Editable mode (no flag) is unaffected. **Not applied** (installed-skill write is out of this repo's scope); end-to-end (full worker launch) still unverified — parser-level only.
- **`@`-prefix edge case:** a brief starting with `@file` under bare `--dm-read` goes to `fileArgs` (not `messages`) — also not delivered as a prompt. `--dm-read=1` avoids this too.
- **Parser quirk is version-pinned:** verified on pi 1.0.2; 1.0.0-vs-1.0.2 byte parity of the unknown-flag branch not diffed. If a future pi registers `--dm-read` as a known boolean flag, the bug self-corrects — re-check on any pi upgrade.
- **`docs/evidence/stageA_get_list_read.json` is malformed JSON** (non-whitespace after the first JSON value at offset 340) — a concatenated CLI capture, not a single JSON document. Not cited as a passing gate by the canonical docs; flagged so a future JSON validator/ingest does not choke on it. All other evidence files parse clean.
