# Acceptance — requirement-to-evidence matrix (R-1..R-10)

**Current status:** R-1..R-10 functional gates independently verified for the first-version surface; requirement-linked originals and limits are in `docs/live_verification.md`. Conditional genuine-sibling co-loading was unavailable, not passed. Latest strict currentSDK observation is timestamped in `agent/evidence-report.md`; no permanent count is claimed here.

Evidence classes:
- **Code:** read/verified in `src/` (design conformance only — never acceptance).
- **Unit:** fake-transport tests in `tests/` (L1). Cite the timestamped observation in `agent/evidence-report.md`, never a stable count.
- **Live:** executed against real Herdr CLI in an owned workspace, task-specific output/artifact verified. Partial independently checked evidence is curated in `docs/live_verification.md`; only matching complete gates establish acceptance.
- **Blocker:** requirement cannot be live-verified in the current scope without the noted condition.

Standing rule: raw findings from discovery (`docs/findings.md`) are historical evidence of CLI behaviour, not proof the extension implements the behaviour.

---

## Matrix

### R-1 — start sub-agent (readonly/editable, as the scripts allow)
- Code: `subagent_start` (src/index.ts) + start lifecycle in src/core.ts: split (explicit supervisor pane id, `--no-focus`, `--cwd`) → record pending ownership → `pane run` task-free wrapper (`herdr-worker.sh --mode <mode> --`) → detection poll (500 ms) → rename → task via `agent prompt` post-detection. Conforms to plan_2 and scope correction; ordering verified against source on 2026-09-30.
- Unit: start lifecycle, validation, detection timeout, split ambiguity, runtime-missing, abort-during-detection (L1, provisional — see status basis).
- **Live gate:** in owned scratch workspace:
  1. `subagent_start` readonly with a task that demands a task-specific answer (e.g. "report the current model id and file count of cwd").
  2. Verify worker boot: `herdr agent read <pane>` shows the task as a user message (delivery proof, caveat 12) and the answer.
  3. Repeat in editable mode. **Report artifacts: readonly mode does NOT carve a writable report path by assumption** — the installed runtime's write guard covers `.` in both modes; readonly trial artifacts must be terminal-only (answer visible in console), editable trials may write a report file inside the worker cwd. Verify model/profile resolution matches the destination environment (check env first — see HANDOFF portability).
  - **Accept when (per live-acceptance-contract):** the reliability batch covers 5 immediate start+prompt trials **per mode** with task-specific answer verified; zero lost-task results in that batch.
- Blockers: none in repo; requires live scratch workspace + working pi runtime in worker pane (failure class 11: broken peer runtime is a distinct blocker).

### R-2 — wait for finish directly OR return after x s with last 50 chars
- Code: `waitMode: none|bounded|finish`, `timeoutMs`, `tailChars` (default 50 bounded) on start/prompt; continuation records for `subagent_wait`.
- Unit: bounded timeout, stalled with tail + working evidence, snapshot vs activity vs `terminal_observed_after_working`.
- **Live gate:**
  1. Trivial task with `waitMode=finish`: result must be `terminal_observed` (idle **or** done — the race must include both) and console tail must contain the task-specific answer.
  2. Long task (≥ 60 s) with `waitMode=bounded timeoutMs=10000`: result must be a timeout/continuation record with ≤50-code-point tail, worker still alive (`agent get`), and a follow-up `subagent_wait` with the continuation must reach terminal.
  - **Accept when:** zero false terminal/completion claims; every fast turn either observed working (evidence) or reported honestly as snapshot/stalled.

### R-3 — get console content
- Code: `subagent_read` (lifecycle-aware `agent read --lines --source recent-unwrapped`, `raw` fallback, code-point tail).
- Unit: unicode/code-point tail bounds, raw fallback.
- **Live gate:** `subagent_read` on a worker with known multi-line output; returned text matches `herdr agent read <pane> --lines N --source recent-unwrapped` (diff within tail bounds). Verify wide-character tail counts code points.
- **Accept when:** content matches direct CLI output; bounded, no crash on empty/undetectable agent.

### R-4 — wait for console to 'finish' (--wait), then return last x chars
- Code: `subagent_wait` (event wait + poll fallback semantics, seq-gated continuation, idle/done/blocked union, blocked → `needs_attention`).
- Unit: continuation identity/seq, terminal-id mismatch, seq without working evidence.
- **Live gate:** after an observed `working` state, wait must return terminal only on a **newer** seq with idle or done; blocked must return `needs_attention`, never ok. Verify the wait actually observed working (continuation `working_observed: true` from sampled get or CLI report — not from a timeout).
- **Accept when:** fast-task case (turn ends between calls) is handled per plan_2 identity+seq comparison; no completion claimed without working evidence.

### R-5 — send text with <enter> to another pane
- Code: `subagent_send` (single line + Enter; multi-line rejected).
- Unit: owned/external opt-in, multi-line rejected, cross-workspace denied.
- **Live gate:** send a known single line to an owned idle shell/worker pane; verify the line + Enter landed (e.g. echoes or executes). Multi-line: document current behaviour explicitly (open question) — tool rejects by design until live-verified.
- **Accept when:** single-line send lands; rejection behaviour matches schema.

### R-6 — send interrupt (Escape; user-approved R-6 clarification)
- Code: `subagent_interrupt` → `pane send-keys esc`; ctrl+d never used.
- Unit: esc used, never ctrl+d.
- **Live gate:** worker in `working` state → `subagent_interrupt` → verify `working → done`, console shows abort, Pi process still alive, `agent get` still works.
- **Accept when:** turn aborted, agent survives. (Discovery evidence for esc behaviour is live-verified at CLI level; the extension path must be verified through the tool.)

### R-7 — list all panes in same herdr-space (names + status)
- Code: `subagent_list` (pane list + agent list join, owned marker).
- Unit: join by pane id.
- **Live gate:** workspace with ≥2 renamed workers + 1 unrenamed pane: names+status correct; owned marker correct; unrenamed shows empty/unknown name.
- **Accept when:** output matches `herdr pane list --workspace <id>` + `herdr agent list`.

### R-8 — list herdr-spaces
- Code: `subagent_spaces`.
- Unit: mapping.
- **Live gate:** ≥2 workspaces exist; output matches `herdr workspace list` (ids, labels, counts).
- **Accept when:** fields match direct CLI.

### R-9 — close a pane
- Code: `subagent_close` (idempotent; owned closes directly after identity check; external requires real UI confirm; `externalConfirmed` param never accepted).
- Unit: idempotent close + absence verified, external opt-in, self-control denied.
- **Live gate:** close an owned worker; verify gone from `pane list`; repeat (idempotent success). External pane: verify UI confirmation path fires (or denial without UI).
- **Accept when:** owned close verified absent; `pane_not_found` treated as success; external path safe.
- Cleanup duty: every live gate closes all panes it opened and records cleanup in the evidence report.

### R-10 — HERDR-PANE-ID in bottom line when Pi runs inside a herdr pane
- Code: footer via `ctx.ui.setStatus` on session_start/session_shutdown, TUI + `HERDR_PANE_ID` only.
- Unit: footer inside/outside herdr (registration-level).
- **Live gate:** launch a TUI Pi session inside a herdr pane with this extension loaded; screenshot/terminal capture showing `herdr pane <id>` in the bottom line; control: same TUI outside a herdr pane shows nothing.
- **Accept when:** visual proof captured (screenshot in repo evidence or session capture) both inside and outside.
- **Verified:** `docs/evidence/footer_controlled.json` (same-terminal inside negative/positive, final bottom line), `docs/evidence/footer_outside_pty.json` (only native extension explicitly loaded outside Herdr, no attribution, normal exit), and `docs/evidence/native_editable_blocker.json` (independent final owned-workspace absence).

---

## Cross-cutting acceptance gates (live-acceptance-contract + plan_2 gates 3–4)

1. **Automated L1:** `npm run check` (typecheck + core/registration/transport suites). Do not cite failing/passing counts here; record a timestamped observation in `agent/evidence-report.md`. **Gate: fully green, re-run by lead immediately before any acceptance claim** (stale green counts are not evidence).
2. **Reliability batch (contract; functional probing, not a statistical reliability claim):** 10 fast prompts on one cheap worker + 5 immediate start+prompt per mode + 2 normal task outcomes with verified result/artifact. Record all stalls/lost tasks; zero false terminal claims; every failure diagnosed/fixed or a report blocker — never soften the gate secretly.
3. **L3 (contract):** load the actual `src/index.ts` in the installed Pi (original contract0.99.1; resumed runtime1.0.0), invoke the real registered tools (RPC if supported, else model-directed short tasks with session evidence); prove all nine tools register + footer. Registration fake tests alone are insufficient.
4. **Real CLI contract checks in owned scratch workspace** (per-R live gates above), incl. R6 deterministic working-task + Escape abort (output must not include the expected completion answer — prompt echo isn't the answer), R5 single-line send into an idle scratch shell (characterize multiline before documenting the v1 limit), R10 footer screen/ANSI capture inside a herdr pane + no-status outside.
5. **Co-loading / packaging smoke:** load pi-herdr together if available; verify no tool-name collision or document the collision as a blocker (open question 1). Pin dependency claims; do not install into user config.
6. **Dependency reachability:** verify `HERDR_PANE_ID`/`HERDR_ENV` and model env reach processes the extension spawns (open question); do not assume from supervisor pane env.
7. **npm audit:** Firstmate assessment is recorded in `docs/security.md`, including the host SDK shrinkwrap boundary, real residual denial-of-service risk, unsuccessful standard mitigation and explicit first-version risk decision. Host modules (including TypeBox) are wildcard peers, not bundled executable dependencies. CurrentPi1.0.0 tree/audit are reassessed in docs/security.md and docs/evidence/packaging_live.json. Do not claim a clean audit.
8. **Ownership/cancel probes (contract):** same-session reload/resume restores ownership, new/fork does not, live identity match required; cancel during await reaps local CLI only, worker survives, delivery known/unknown reported honestly; external close needs real UI confirmation, no-UI denial verified in automated and noninteractive tool checks.
9. **Durable evidence doc:** `docs/live_verification.md` with concise commands/evidence/results and test counts; review artifacts under `docs/evidence/`; raw logs ephemeral in `agent/`. README exists (install/usage) — re-verify its claims against live results during this pass.

## Ownership & cleanup rules (all live gates)
- Work only in a freshly created scratch workspace; never target user/buddy panes.
- Verify live workspace/pane identity before control (stale IDs never trusted).
- Every gate ends with `pane list`/`workspace list` proving cleanup of owned panes; result recorded in `agent/evidence-report.md`.

## Verification and declared limits

R-1..R-10 matching original evidence is indexed in `docs/live_verification.md`; the definitions above remain unchanged. Fixed20turn functional batch, actual registration, ownership/cancellation, direct child environment, packed-package load and independent cleanup are recorded there. Final finish-tail and nonterminal-payload guards have real assertion-red/green regressions plus production finish proof.

Multiline is characterized but rejected for v1. Genuine sibling pi-herdr was unavailable, so conditional co-loading remains unexecuted. Worker model loops/upstream errors are disclosed, not extension task acceptance. Audit remains one high vulnerable host dependency with explicit current risk decision. No result promises task completion.
