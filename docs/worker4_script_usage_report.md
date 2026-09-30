# Worker 4 Report: Skill Script Usage & Caveats Mining

**Worker:** Wilhelm (script-usage miner)
**Date:** 2026-09-30
**Scope:** `~/.pi/profiles/*/agent/sessions/` (minimal, partner, opsx) + `~/.pi/agent/sessions/`
**Mode:** read-only mining; this report is the only file written.

---

## HEADLINE

The supervisor skill's bash scripts are the de-facto sub-agent control plane: agents run `herdr-start-subagent.sh` to launch bounded workers (pane split → `herdr-worker.sh` → detection poll → rename), then drive them with `herdr_await_agent.sh` (sync wait + bounded terminal harvest) and `herdr_prompt_agent.sh` (preflighted follow-up). Across all profiles the scripts dominate lifecycle traffic: `herdr_await_agent` ≈ 706 invocation lines, `herdr_prompt_agent` ≈ 536, `herdr-start-subagent.sh` ≈ 1126 (Stefan's independent count: 454; the delta is my count including tool-calls embedded in assistant text plus this project's own dev sessions). All real-world usage (non-skill-development) lives in the `minimal` profile's session roots, spanning `daily-workflow-helper`, `tempo-api`, `AIEnablementChapter`, `google-model-deployment-investigation`, `jira-confluence-guard`, `dev-support-bot`, and `orca-workspaces` projects from 2026-08-12 through 2026-09-30. The failure surface is small but concrete: peer Pi runtime breakage (missing node chunk), detection races right after launch, stale `idle` states, and the launcher's own argument validation. Agents cope by verifying report files on disk after every wait, re-sending prompts only after re-reading terminal state, and closing + verifying panes after every completion.

---

## Frequency Table

### Script invocations (rg line hits across all session roots, unfiltered)

| Script / wrapper | Lines mentioning it | Role |
|---|---|---|
| `herdr-start-subagent.sh` | ~1126 | Launch worker (pane split + run wrapper + poll + rename) |
| `herdr_await_agent.sh` | ~706 | Synchronous wait + bounded terminal evidence harvest |
| `herdr_prompt_agent.sh` | ~536 | Follow-up prompt with preflight (refuses `working`/`blocked`) |
| `herdr-worker.sh` (via launcher) | (bundled, no direct invocation lines found) | Worker entrypoint wrapping `pi-worker-runtime.sh` |
| `pi-worker-runtime.sh` | 61 files reference it | Worker safety/runtime: profile selection, model resolution, write-guard |
| `.sub_agent_conf` | 39 files mention it | Repo-local worker model policy (`PROVIDER=`/`MODEL=`/`THINKING=`) |
| `PI_WORKER_DEFAULT_MODEL` | 3 launch commands observed with it (google-model-deployment-investigation: `ollama/glm-4.7-flash`) | Env fallback when no `.sub_agent_conf` |
| legacy `subagent.sh` / `subagent-readonly.sh` | hundreds (mostly `partner` profile, pre-skill era) | Historical predecessor of the wrapper pair |

> Counts are rg line hits, so a single bash tool call containing several invocations counts once per line; Stefan's per-call counts (454 / 316 / 176) are the more precise per-call numbers. Both agree on the ordering: **start > await > prompt**.

### Flag distribution (observed values, real usage only)

| Flag | Observed values (descending) |
|---|---|
| `--mode` | `readonly` ~776 vs `editable` ~738 (near 50/50; readonly slightly more) |
| `--handoff` vs `--brief` | `--handoff` ~1145 mentions vs `--brief` ~722 → handoff-file delegation is the dominant pattern; inline briefs for smaller tasks |
| `herdr_await_agent --timeout-ms` | `1800000` (30 min) dominant (~418), then `900000` (15 min, ~73); a long tail of smaller values for ping/liveness checks |
| `herdr_await_agent --lines` | `100` dominates (~391) — the default; smaller values (10–40) for quick status peeks |
| `herdr_prompt_agent --timeout-ms` | `1800000` / `900000` / `600000` common; `30000` appears for liveness pings (`liveness ping — reply "ok" only`) |
| `--direction` | `right` ~85%, `down` ~15% |
| `--timeout-seconds` (launcher) | `5` is the modal value by far; then `30`, `15`, `10`, `1`; outliers `60`, `45`, `120`, `1800` (the last two exceed the documented 1–30 range — see UNDETERMINED) |
| `--cwd` | Always an absolute path; frequently a scoped sub-directory (e.g. `.../agent/scratch/kvtest-indep`) to bound the worker's world |

---

## Failure Modes

### 1. Peer Pi runtime breakage (missing node chunk) — prompt silently delivered into a broken pane

**Count:** 1 concrete incident observed (tempo-api session, 2026-09-23).
**Example (verbatim, abridged):**

Command:
```
./scripts/herdr_prompt_agent.sh w2G:p1 'Christian(lead) -> w2G(p1): liveness ping — reply "ok" only. Stop.' --timeout-ms 30000 --lines 20
```
Result (`prompt.sent: true`, status `done`), but the terminal tail shows:
```
 Error: Cannot find module
 '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/openai-completions-XHML6MTL.js'
 imported from
 /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-4DKZACXI.js
```
The script reported `prompt.sent: True` because delivery succeeded — the *target* agent's Pi install was broken.
**Recovery:** The supervisor (a) confirmed the peer was still detected, (b) re-sent a shorter prompt stating the previous attempt failed on the peer's runtime, (c) explicitly told itself "this pane is now confirmed alive", and (d) escalated awareness to the user. No script-level recovery exists; this is a host-environment fault the supervisor must detect by *reading the harvested terminal text*, not by the JSON.

### 2. `agent_not_found` immediately after launch (detection race)

**Count:** 23 `agent_not_found` hits in tool outputs across sessions (Stefan's count); several verbatim examples.
**Example (verbatim):**
```
{"error":{"code":"agent_not_found","message":"agent target wp1-provenance-review not found"},"id":"cli:agent:get"}
```
and
```
{"error":{"code":"agent_not_found","message":"agent target w2K:p3 not found"},"id":"cli:agent:get"}
```
with the agent's own diagnosis: "All three `herdr agent get` calls returned agent_not_found after launch initialization."
**Recovery:** Wait and re-poll; use `herdr agent list` to rediscover the stable name; the launcher's own detection loop (poll every 0.5 s for up to `--timeout-seconds` seconds, then rename) exists precisely to avoid this — agents that bypass the launcher (direct `herdr pane run` + immediate `agent get`) hit this most.

### 3. `agent_prompt_stalled` / stalled prompt

**Count:** 1 direct hit in tool output + multiple in skill documentation quoted inside sessions.
**Semantics (verbatim from skill text found in sessions):** "a non-working state must produce an observed lifecycle change within five seconds or Herdr returns `agent_prompt_stalled`".
**Recovery (verbatim from the skill, which agents follow):** "After an abort, timeout, `agent_prompt_stalled`, or any other unexpected prompt/wait result, do **not** resend first. The result does not establish that the request was not delivered." → inspect with `herdr agent get` + `herdr agent read`, compare `state_change_seq` with the pre-dispatch value, read the report artifact, *then* decide to resend or not.

### 4. Launcher argument-validation errors (exit 2)

**Count:** several verbatim hits.
**Examples (verbatim):**
```
{"ok":false,"error":"target and message are required"}   (exit 2, herdr_prompt_agent.sh)
```
```
--timeout-seconds must be an integer from 1 to 30
```
```
--handoff and --brief are mutually exclusive / one of --handoff or --brief is required
```
```
an existing live Herdr agent already uses --name: <name>   (duplicate-name guard)
```
```
must run inside a Herdr-managed pane (HERDR_ENV=1)
```
**Recovery:** fix the invocation and retry; the errors are deterministic and self-describing. Note the HERDR_ENV failure only occurs when the *supervisor itself* is not inside a Herdr pane — i.e. the whole control plane is pane-scoped.

### 5. `readonly` mode write attempt → blocked (expected guard behaviour, occasionally misread as failure)

**Count:** a few observed; the write guard is exercised in 39 session files.
**Example (paraphrased from session narrative):** a readonly worker attempted `write` on a path outside its allowed set and was refused; the same worker *did* succeed in writing to its designated report path (the report path is explicitly allowed even in readonly mode — it is the output channel).
**Recovery:** the supervisor distinguishes "guard did its job" from "worker failed" by checking the report file on disk; readonly workers are still expected to produce the report file.

### 6. Peer coordination prompt: message truncated / split

**Count:** 1 observed (tempo-api, 2026-09-23). A long multi-paragraph coordination message sent via `herdr_prompt_agent.sh` was visibly split mid-sentence in the peer's terminal ("Reply in this pane (w2G:p1) with a short: AGREE/PARTIAL/DISAGREE ... Stop." appeared in the tail, but the peer echoed back the *previous* message text before the error). The supervisor re-sent a shortened version.
**Recovery:** keep prompts bounded; for long payloads use a handoff *file* the peer reads instead of an inline message.

---

## Caveats List

Things an agent **had to know** to use these tools successfully — direct input to extension tool semantics:

1. **Pane-scoped control plane.** All helper scripts require `HERDR_ENV=1` (the supervisor must itself live in a Herdr-managed pane) plus `herdr` and `jq` on PATH. Errors are emitted as single-line JSON on stderr (`{"ok":false,"error":...}`) with specific exit codes (2 = usage, 127 = missing dep, 1 = Herdr operation failure).
2. **Detection race after launch.** A freshly created pane is not a named agent yet. The launcher polls `herdr agent get <pane_id>` every 0.5 s until `agent_status != "unknown"`, then renames. If the poll window (`--timeout-seconds`, default 5) expires, the JSON still returns `ok: true` with `agent_detected: false`, `agent_status: "initializing"` — the launch *succeeded*, the naming did not. The supervisor must re-poll or `herdr agent list` later; it must not treat this as a failed launch and must not re-launch (the pane already exists and a second launch would duplicate).
3. **`ok: true` ≠ task acceptance.** Every script's JSON contract states the same thing: "A lifecycle result is evidence for inspection, never automatic task acceptance." Terminal states (`idle`/`done`/`blocked`) trigger *inspection*, not acceptance.
4. **Read the report artifact on disk, not just the terminal.** The dominant acceptance pattern across all sessions: after `await` returns, the supervisor reads `--report` from disk and inspects diffs/tests. Terminal harvest (`--lines`) is a *status peek*, the report file is the *deliverable*.
5. **Write-guard behaviour (worker side).** `readonly` mode = `--tools read,bash,grep,find,ls --dm-read` plus `PI_WRITE_GUARD_DIRS="."` (env) — the worker may write its report (the report path is carved out) but nothing else. `editable` mode drops the tool restriction but keeps the write-guard for anything outside the allowed dirs. Agents had to learn that a blocked write inside a readonly worker is guard success, not worker failure.
6. **Model resolution order (worker side).** `.sub_agent_conf` in the repo root (exact `PROVIDER=`/`MODEL=`/`THINKING=` lines, both PROVIDER and MODEL required, unknown lines are fatal) → else `PI_WORKER_DEFAULT_MODEL` env (`provider/model` or `provider/model:thinking`) → else default: openai-codex, else github-copilot, model `gpt-5.6-terra`, `--thinking minimal`. The launcher probes model availability with `pi ... -ne --list-models` *before* launching, and rejects it if the probe fails. Concurrent human edits to `.sub_agent_conf` (observed: renamed to `.sub_agent_conf_gemini38` mid-session) silently change which model the next worker gets — supervisors were instructed to check this before launching and to never revert a human's rename.
7. **Prompt preflight.** `herdr_prompt_agent.sh` refuses to send when the target is `working` or `blocked`: it returns `prompt.sent: false` with status evidence and does *not* wait. A supervisor who needs the message delivered must first wait for `idle`, then prompt. The `prompt.sent` field is the only reliable delivery signal.
8. **Do not resend after a failed/stalled wait without inspecting.** Documented and followed in real sessions: timeout/`agent_prompt_stalled` does not prove non-delivery; compare `state_change_seq` pre/post dispatch and read the report before resending. Blind resends were a noted anti-pattern in the skill docs.
9. **Timeouts are the supervisor's budget, not the worker's.** `--timeout-ms 1800000` (30 min) as the default await is a *wait ceiling*; the worker keeps running past it. On timeout the supervisor must inspect, not assume death. `--timeout-seconds` on the launcher is only the *detection* window (1–30 s documented), not total worker time.
10. **JSON parsing gotchas.** All outputs are single-line JSON; agents commonly piped through `python3 -c "import sys,json..."` or `jq` to extract `prompt.sent`, `agent.status`, `wait.exit_code`, and the terminal tail. The await/prompt JSON is nested: top-level `{ok, operation, target, agent:{status,payload,response}, wait:{...}, prompt:{...}, terminal:{text,response}}`. The `response` sub-objects carry the raw herdr CLI exit code + stdout + stderr — the layer where `agent_not_found` etc. actually surface.
11. **Cleanup discipline.** Every completion pattern ends with `herdr pane close <pane_id> && herdr pane list` (verified in multiple sessions, e.g. `herdr pane close w2G:pB && herdr pane list`, `herdr pane close w2V:p3 && herdr pane list --workspace w2V | jq -c '.result.panes[] | {pane_id, agent_status}'`). The close-then-list pair is the standard ownership-release ritual; stale owned panes were an explicit concern in the supervisor skill.
12. **`--instruction` is one physical line.** The launcher rejects multi-line instructions; long tasks must be carried by the handoff file, not the instruction.
13. **Quoting.** The launcher shell-quotes the wrapper command with single quotes (deliberately *not* `printf %q`, which is locale-dependent and can mangle multibyte characters) — handoff paths and briefs containing single quotes work, but this is a known sharp edge if anyone rewrites the launcher.
14. **Name uniqueness.** Agent names must match `[a-z][a-z0-9_-]{0,31}` and be unique among *live* agents (checked via `herdr agent list` before launch). Re-using a name from a closed worker is fine; re-using a live name fails fast.

---

## Behaviour Patterns

- **Sync wait by default, not polling loops.** The modal pattern is: launch (short detection timeout 5 s) → `herdr_await_agent.sh <target> --timeout-ms 1800000 --lines 100` as a *single blocking call* that returns lifecycle + terminal tail. Polling loops over `herdr agent get` appear only in recovery/recovery-diagnosis, never as the primary wait strategy.
- **Read-back after every await.** After the await JSON, the supervisor immediately: (a) checks `agent.status`, (b) reads the report file on disk, (c) optionally `herdr agent read <name> --lines 30-300 --source recent-unwrapped` for the worker's final messages. Reading the terminal "recent-unwrapped" source (not raw screen) was the consistent choice.
- **Follow-up prompts only after idle.** `herdr_prompt_agent.sh` is used for bounded multi-turn engagement ("Re-sending the substantive coordination", "Implement D4/D5 now. Full contract is in agent/handoffs/d4d5_handoff.md — READ IT FIRST..."). Each follow-up re-states scope and the "Stop." boundary. Pings (`liveness ping — reply "ok" only`) with `--timeout-ms 30000` are the cheapest liveness probe in practice.
- **Scoped `--cwd` for write work.** Editable workers get `--cwd` pointed at a scratch subdirectory (`.../agent/scratch/kvtest-indep`) so the write-guard and the worker's file views are bounded to the task's world.
- **Parallel launches in one block.** Independent workers (e.g. critic + opponent, or multiple review workers) are launched back-to-back in a single assistant turn, each with its own `--direction right`/`down` and its own report path.
- **Pane close + verify after acceptance.** `herdr pane close X && herdr pane list` (optionally piped through `jq -c '.result.panes[] | {pane_id, agent_status}'`) — always the *own* pane; closing a peer's pane was explicitly out of scope.
- **Recovery = inspect, don't retry blindly.** The documented and observed recovery sequence after any non-terminal result: `herdr agent get` → `herdr agent read --lines 160` → compare `state_change_seq` → read report artifact → then decide (resend / escalate / accept).
- **Model pinning per project.** Repos that care set `.sub_agent_conf` (e.g. daily-workflow-helper: `PROVIDER=qwen38-cloudrun / MODEL=qwen3.8-27b-nvfp4-bf16-lmhead / THINKING=off`); one-off investigations used `export PI_WORKER_PROFILE=minimal PI_WORKER_DEFAULT_MODEL="ollama/glm-4.7-flash"` inline before the launcher call.

---

## UNDETERMINED

- **Exact per-call invocation counts** beyond Stefan's (454/316/176) and my line-hit totals (~1126/706/536): my counts include assistant-text mentions and this project's own dev sessions; reconciling both requires de-duplicating by tool-call ID, which I did not perform (out of timebox).
- **`--timeout-seconds 60/120/1800` outliers:** one session shows `--timeout-seconds 60`, `120`, and even `1800` being *passed* to the launcher despite the documented 1–30 range. I could not confirm whether an older launcher version accepted these or whether those lines belong to a different script (`herdr agent wait --timeout` takes ms; possible copy-paste from there). **UNDETERMINED** — needs source-of-that-session verification.
- **`agent_detected: false` real-world frequency:** no `"agent_detected":false` hits in tool results were found in the final pass; either detection reliably succeeds within 5 s (plausible, given 0.5 s polling), or the JSON is being consumed through pipes that strip it. I could not determine which. The *capability* is verified in source; the *frequency* is not.
- **herdr-agent-state.ts version drift:** the extension file is present in `minimal` and `partner` profiles (identical, 6602 bytes, md5 `edf90e82...`) but I did not audit the `opsx`/`zero`/default profiles' copies for version differences, nor check whether a broken peer pane (failure mode #1) could be caused by a stale extension on the peer side vs. a broken homebrew Pi install. The observed error text points at the homebrew bundle (missing chunk file), which is an install-level fault, not an extension fault — but I did not verify the peer's install state.
- **Write-guard exact semantics for `editable` mode:** I verified `readonly` = tool restriction + `--dm-read` + `PI_WRITE_GUARD_DIRS="."`; the *additional* guard behaviour in editable mode (which dirs are denied, whether the report path is still carved out identically) is only partially evidenced in the sessions. The runtime source shows `PI_WRITE_GUARD_DIRS="."` is exported in *both* modes, but the downstream consumer (pi-focus-guard) behaviour is not in scope for this mining pass.
- **Whether `--brief` launches ever failed because of quoting of the inline brief:** one truncated-message incident was observed; I could not attribute it definitively to the brief-vs-handoff choice vs. peer terminal wrapping.

---

## Confirmation

**Only `docs/worker4_script_usage_report.md` (this file) was written.** All mining was read-only `rg`/`python3`/`sed` over session JSONL files; no Herdr panes were created, no scripts modified, no other files touched.
