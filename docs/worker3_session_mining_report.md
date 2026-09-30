# Worker 3 Report: Historical Session Mining

**Worker:** Stefan (session miner)
**Herdr CLI:** 0.9.3
**Date:** 2026-09-30
**Scope:** `~/.pi/profiles/*/agent/sessions/` (all profiles: minimal, partner, opsx) + `~/.pi/agent/sessions/`
**Mode:** read-only (no herdr panes created, no state changed)

---

## 1. Headline Summary

- **Session files inspected:** 320 unique files mention `herdr`; **101** contain actual herdr CLI commands in assistant bash tool calls.
- **Herdr tool results (bash tool with herdr in output):** 1,947
- **Agent lifecycle states observed in tool outputs:** 889 total — 415 idle, 323 done, 122 working, 27 unknown, 2 blocked.
- **Error codes in tool outputs:** 58 total — 23 `agent_not_found`, 11 `invalid_key`, 8 `timeout`, 6 `pane_not_found`, 5 `protocol_mismatch`, 2 `server_not_running`, 2 `workspace_not_found`, 1 `agent_prompt_stalled`.
- **De-facto "tools" in practice:** 5 bash wrapper scripts (`herdr-start-subagent.sh`, `herdr_await_agent.sh`, `herdr_prompt_agent.sh`, `herdr_wait_agent.sh`, `herdr_start_subagent.sh`) account for the vast majority of sub-agent lifecycle operations. Direct `herdr agent get`/`read`/`wait`/`prompt` CLI calls appear only for recovery/inspection.

---

## 2. Frequency Table (Herdr CLI Subcommands in Assistant Bash Tool Calls)

| Command | Count | Role in workflow |
|---|---|---|
| `herdr pane close` | 390 | Cleanup (mandatory per skill) |
| `herdr agent get` | 383 | State inspection (recovery, preflight) |
| `herdr pane list` | 381 | Verification after close, workspace discovery |
| `herdr agent read` | 273 | Output harvesting (recovery, acceptance) |
| `herdr agent wait` | 138 | Synchronous wait (recovery, short polls) |
| `herdr pane read` | 124 | Terminal-level output (supervisor's own pane, diagnostics) |
| `herdr agent prompt` | 62 | Follow-up prompts (recovery, steering) |
| `herdr agent list` | 47 | Agent discovery |
| `herdr pane run` | 30 | Run command in pane (worker launch) |
| `herdr pane send-keys` | 29 | Key injection (rare, mostly diagnostics) |
| `herdr pane --help` | 27 | Discovery (CLI learning) |
| `herdr pane get` | 27 | Pane state inspection |
| `herdr pane process-info` | 23 | Process diagnostics |
| `herdr agent --help` | 15 | Discovery (CLI learning) |
| `herdr workspace list` | 13 | Workspace discovery |
| `herdr pane send-text` | 10 | Text injection (rare) |
| `herdr agent start` | 10 | Agent launch (bypassing helper) |
| `herdr session list` | 10 | Session discovery |
| `herdr session stop` | 9 | Session teardown |
| `herdr session delete` | 9 | Session cleanup |
| `herdr workspace create` | 7 | Scratch workspace (experiments) |
| `herdr workspace close` | 5 | Scratch workspace teardown |
| `herdr pane wait-output` | 5 | Terminal-level wait (rare) |

**Helper script wrappers (bash tool calls, the de-facto extension tools):**

| Script | Count | Role |
|---|---|---|
| `herdr-start-subagent.sh` | 454 | Launch worker (pane split + run + poll + rename) |
| `herdr_await_agent.sh` | 316 | Synchronous wait + harvest terminal output |
| `herdr_prompt_agent.sh` | 176 | Follow-up prompt with preflight (refuses working/blocked) |
| `herdr_start_subagent.sh` | 157 | Older naming (pre-rename) of the same launcher |
| `herdr_wait_agent.sh` | 4 | Legacy wait (superseded by `herdr_await_agent.sh`) |
| `herdr_delegate` | 5 | Composite spawn→prompt→wait→harvest (experimental) |

> **Note:** `herdr-start-subagent.sh` (454) + `herdr_start_subagent.sh` (157) = **611 total launches**. The underscore vs hyphen split reflects a mid-project rename. `herdr_await_agent.sh` (316) and `herdr_wait_agent.sh` (4) are the same capability — the underscore form won.

---

## 3. Categorized Real-World Behaviors

### 3a. Must-Have High-Frequency Patterns

These are the operations that, if missing, break the workflow:

1. **Launch a sub-agent** (`herdr-start-subagent.sh` / `herdr agent start` + `herdr pane split` + `herdr pane run`)
   - 611 total launches. Always creates a sibling pane, runs a worker wrapper, polls for agent detection, renames the agent, returns JSON with `pane_id` + `agent_status` + `state_change_seq`.
   - **The JSON return is the single most important contract.** Every downstream operation depends on `pane_id` and the initial `state_change_seq`.

2. **Await / wait for completion** (`herdr_await_agent.sh` / `herdr agent wait`)
   - 320 total waits (316 helper + 4 legacy). The dominant pattern is **synchronous blocking wait** with a 30-minute timeout (`--timeout-ms 1800000`).
   - Timeout value distribution: 1,800,000 ms (65×), 180,000 ms (21×), 600,000 ms (19×), 300,000 ms (15×), 60,000 ms (14×).
   - **Key race condition discovered (Worker 1):** `agent wait` without `--until` matches `idle|done|blocked`. If called immediately after a prompt, the agent is still in the *previous* `idle`/`done` state → wait returns immediately with success, NOT waiting for the new turn. The correct primitive is `agent prompt --wait` (which internally requires an observed `working` or `blocked` within 5000 ms before matching the terminal state).
   - The helper `herdr_await_agent.sh` wraps `agent wait` and adds `state_change_seq` comparison to detect whether the agent actually transitioned.

3. **Inspect state** (`herdr agent get`)
   - 383 calls. Used for: preflight (is the agent idle/working/blocked?), recovery (what happened after a timeout?), acceptance (final state before close).
   - JSON returns: `agent`, `agent_status`, `pane_id`, `state_change_seq`, `terminal_title`, `agent_session` (Pi session path), `focused`, `cwd`, `foreground_cwd`, `scroll`, `tab_id`, `terminal_id`.

4. **Read output** (`herdr agent read` / `herdr pane read`)
   - 273 + 124 = 397 calls. `agent read` is the primary channel (lifecycle-aware, Pi-specific). `pane read` is used for terminal-level diagnostics.
   - `agent read` supports `--source recent-unwrapped` (strips terminal ANSI wrapping) and `--lines N`.
   - **Report files** (the `--report` path passed at launch) are the *secondary* evidence channel for editable workers. The terminal WORK REPORT is the primary channel for readonly workers.

5. **Close pane** (`herdr pane close` + `herdr pane list` to verify)
   - 390 + 381 = 771 calls. Close is always paired with a `pane list` verification. The skill mandates: "The supervisor owns every pane it creates. … close the owned pane immediately. Verify the resulting pane list instead of assuming close succeeded."
   - `pane_not_found` errors (6×) confirm that panes disappear when the process exits — close operations need to be idempotent.

6. **List panes / agents** (`herdr pane list`, `herdr agent list`)
   - 381 + 47 = 428 calls. Used for: workspace discovery, post-close verification, finding the supervisor's own pane, checking which agents are alive.

### 3b. Common Failure Modes in Sessions

| Failure | Count | Recovery pattern observed |
|---|---|---|
| `agent_not_found` | 23× | Re-launch with corrected name; check `pane list` for the actual pane ID; the agent may not have been detected yet (race at launch) |
| `invalid_key` | 11× | Key syntax error: `ctrl-d` rejected, must use `ctrl+d` (plus sign). `esc`/`escape` both valid. `enter` valid. `c-d`/`C-d` rejected. |
| `timeout` | 8× | Re-await with longer timeout; inspect `agent get` to see if the agent is still `working`; do NOT resend the prompt first |
| `pane_not_found` | 6× | Pane already closed (process exited); make close idempotent; verify with `pane list` |
| `protocol_mismatch` | 5× | UNDETERMINED — likely herdr version skew between CLI and server; no recovery pattern observed in sessions |
| `server_not_running` | 2× | Restart herdr server; UNDETERMINED — no automated recovery observed |
| `workspace_not_found` | 2× | Scratch workspace lost (process exited); recreate workspace |
| `agent_prompt_stalled` | 1× | Prompt sent but no `working`/`blocked` observed within 5000 ms; recover via `agent get` + `agent read` before resending |

**Additional failure patterns (not error codes, but observed in session context):**

- **Stale `idle` after launch:** The launcher returns `agent_status: "idle"` immediately after pane creation. This is a lifecycle snapshot, NOT completion evidence. Sessions show agents that were "idle" at launch but actually still initializing. The skill explicitly warns: "A returned `idle` immediately after launch is a lifecycle snapshot, **not completion evidence**."
- **Pane focus drift:** A worker was observed as `focused: true` after a `--no-focus` launch request. Focus state is a creation *request*, not proof of final state.
- **UTF-8 / terminal wrapping:** `herdr-utf` appears 331× in sessions — terminal output wrapping/ANSI escaping causes issues with `pane read` output parsing. `agent read --source recent-unwrapped` is the fix.
- **Helper script not found:** `herdr_wait_agent.sh: No such file` (4×) — the legacy script was removed/renamed to `herdr_await_agent.sh` mid-project. Sessions show agents hitting this and recovering by using the new name.
- **Double-launch race:** Two sessions in the `is4358-rebrand` directory show the same worker name (`Marta` / `marta`) launched twice in quick succession (case sensitivity in the launch command). The second launch failed with `agent_not_found` because the first was still initializing.

### 3c. Unused or Redundant Capabilities

| Capability | Evidence | Assessment |
|---|---|---|
| `herdr pane send-text` / `send-keys` for agent turns | 10 + 29 = 39 calls, but the skill explicitly forbids them for agent turns ("Use the lifecycle-aware helper rather than `pane send-text`") | Redundant for sub-agent work; only useful for raw terminal control (diagnostics) |
| `herdr pane wait-output` | 5 calls | Terminal-level wait, superseded by `agent wait` for lifecycle-aware waiting |
| `herdr session list/stop/delete` | 10 + 9 + 9 = 28 calls | Session management is orthogonal to sub-agent supervision; rarely used in the workflow |
| `herdr workspace create/close` | 7 + 5 = 12 calls | Only for scratch/experiment workspaces (Worker 1, Worker 2 experiments); not part of the normal sub-agent workflow |
| `herdr channel` | 130 mentions (mostly in docs/skill text, not in tool calls) | Channel-based messaging appears in the CLI but is not used in any observed sub-agent workflow |
| `herdr agent explain` | 3 calls | Debugging aid, not part of the workflow |
| `herdr agent send-keys` | 6 calls | Raw key injection (esc, ctrl+c); used only in recovery/interrupt scenarios |
| `herdr agent rename` | 3 calls | Rare; the launcher handles renaming at launch |
| `herdr agent interrupt` | 1 call | Interrupt signal — the exact mapping of Pi's CTRL-D via herdr is still an open question (see AGENTS.md) |

---

## 4. Waiting: Synchronous vs. Polling/Asynchronous

- **Synchronous blocking wait is the dominant pattern.** `herdr_await_agent.sh` (316×) and `herdr agent wait` (138×) both block the calling bash tool until the agent reaches a terminal state (`idle`/`done`/`blocked`) or the timeout expires.
- **Timeout values:** 30 min (1,800,000 ms) is the standard for real work (65×). Shorter timeouts (60 s–15 min) appear in polling/progress-check patterns.
- **No true async/polling loop was observed.** Sessions do NOT show a pattern of "start agent, do other work, come back later." The supervisor always blocks on the await. This is a **critical design constraint** for the pi-subagent-herdr extension: the extension tool must either (a) block the Pi event loop (bad — blocks the UI), or (b) return immediately and let the supervisor poll (requires a different interaction model).
- **The race condition** (Worker 1 finding) is the single most important technical insight: `agent wait` called right after a prompt returns immediately if the agent was already in a terminal state. The fix is `agent prompt --wait` (atomic prompt+wait) or `state_change_seq` comparison.

---

## 5. Text Injection, Interrupts, and Key Sending

- **Text injection:** `herdr pane send-text` (10×) and `herdr pane send-keys` (29×) are rare. The skill forbids them for agent turns (use `agent prompt` instead). Observed uses: sending `enter` to confirm a prompt, sending `esc` to cancel, sending `ctrl+c` to interrupt.
- **Interrupts:** `herdr agent send-keys` (6×) used for `esc` and `ctrl+c`. `herdr agent interrupt` (1×) — the exact Pi→Herdr interrupt mapping (CTRL-D for Pi sessions) is **UNDETERMINED** and listed as an open question in AGENTS.md.
- **Key syntax:** Only `ctrl+X` (plus sign) is valid. `ctrl-X`, `C-X`, `c-X` are all rejected with `invalid_key`. `esc`/`escape` both valid. `enter` valid.

---

## 6. Concrete Lessons for the `pi-subagent-herdr` Extension Design

1. **The launch tool must return a structured JSON** with `pane_id`, `agent_name`, `agent_status`, `state_change_seq`. Every downstream operation depends on these. The current bash script does this; the extension tool must preserve the contract.

2. **The wait tool must handle the race condition.** Either use `agent prompt --wait` (atomic) or compare `state_change_seq` before and after. A naive `agent wait` immediately after a prompt is broken.

3. **Synchronous vs. async is the core design tension.** Sessions show 100% synchronous blocking. The extension must decide: block the Pi event loop (simple but blocks UI), or return a "pending" result and let the supervisor poll with a second tool call (non-blocking but requires a different interaction model). The bash scripts block for up to 30 minutes — this is the pattern that works in practice.

4. **The close+verify pair is mandatory.** `pane close` followed by `pane list` to confirm. The extension should make this a single atomic operation (close and verify in one tool call) to reduce the number of round-trips.

5. **`agent get` is the universal preflight.** Every operation (prompt, wait, close) is preceded by an `agent get` to check state. The extension could fold this into each tool call (preflight + action in one) to reduce round-trips.

6. **`agent read --source recent-unwrapped --lines N` is the primary output channel.** The extension should expose this as a first-class read tool with a `lines` parameter. The `recent-unwrapped` source strips ANSI wrapping.

7. **Error codes must be surfaced as structured results, not raw terminal text.** The 8 error codes (`agent_not_found`, `invalid_key`, `timeout`, `pane_not_found`, `protocol_mismatch`, `server_not_running`, `workspace_not_found`, `agent_prompt_stalled`) should be mapped to typed errors in the extension API.

8. **The helper scripts are the de-facto API.** 611 launches, 320 awaits, 176 prompts — all through bash scripts. The extension should provide first-class tools for exactly these three operations (launch, await, prompt) plus the supporting reads (agent get, agent read, pane list, pane close).

9. **Report files are the secondary evidence channel.** Editable workers write to a `--report` path. The extension should support reading this file as part of the acceptance workflow (or the supervisor should just `read` it directly).

10. **Idempotent close.** Panes disappear when the process exits. `pane close` on an already-closed pane returns `pane_not_found`. The extension should treat this as success, not error.

---

## 7. Caveats

- **Session files are compressed/archived.** Not all historical sessions may be present. The 320 files found may undercount early (pre-August 2026) sessions.
- **`protocol_mismatch` and `server_not_running`** (5 + 2 = 7 occurrences) have no clear recovery pattern in the sessions. These may indicate herdr version upgrades or server restarts that were handled outside the session context.
- **The `herdr_delegate` composite tool** (5×) appears to be an early prototype of the "one-shot spawn→prompt→wait→harvest" pattern. It was not adopted by the skill workflow (which uses separate launch/await/prompt steps). UNDETERMINED whether this was abandoned or just prototyped.
- **`herdr channel`** (130 mentions) appears heavily in skill documentation and CLI help, but NOT in any observed sub-agent workflow. It may be a herdr feature that is irrelevant to the Pi sub-agent use case.
- **The `herdr_wait_agent.sh` → `herdr_await_agent.sh` rename** caused 4× `No such file` errors in sessions. The extension should not have this naming fragility — it should be a stable API, not a shell script name.

---

## 8. UNDETERMINED

- **`protocol_mismatch` root cause:** 5 occurrences, no recovery pattern observed. Likely herdr version skew, but not confirmed in sessions.
- **`server_not_running` recovery:** 2 occurrences. Sessions show the agent noting the error but the recovery (restart herdr server) is not captured in the session context.
- **Pi interrupt mapping (CTRL-D → herdr):** `herdr agent interrupt` was called once. The exact mapping of Pi's CTRL-D interrupt to a herdr pane signal is an open question (AGENTS.md). No session shows a successful CTRL-D interrupt of a Pi sub-agent.
- **`herdr channel` usage:** 130 mentions in docs/CLI help, 0 in sub-agent workflows. UNDETERMINED whether this is a herdr feature that should be exposed in the extension or one that is irrelevant.
- **Early sessions (pre-August 2026):** The earliest herdr-mentioning sessions are from August 2026. Earlier usage (if any) may be in archived/compressed files not scanned by this mining pass.

---

## 9. Confirmation

- **Files modified:** Only this report (`docs/worker3_session_mining_report.md`). No herdr panes created, no workspaces modified, no agent state changed.
- **Herdr scratch panes/workspaces:** None created (read-only mining).
- **Herdr workspaces touched:** None.
