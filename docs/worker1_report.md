# Worker 1 Report: Herdr Live CLI Experiments

**Worker:** Fritz (experimenter)
**Herdr CLI:** 0.9.3
**Date:** 2026-03-14
**Scratch workspaces used:** `w2W` (initial, lost when p1 exited), `w2X` (primary experiments)
**Cleanup:** Both scratch workspaces closed. `w2V` (Horst `w2V:p1`, Judith `w2V:p2`) untouched throughout.

---

## 1. Keys & Interrupt

### 1.1 Valid key syntax

| Key name | Exit code | Raw output | Status |
|----------|-----------|------------|--------|
| `ctrl+d` | 0 | *(empty)* | [Observed] |
| `ctrl+c` | 0 | *(empty)* | [Observed] |
| `ctrl+l` | 0 | *(empty)* | [Observed] |
| `ctrl+a` | 0 | *(empty)* | [Observed] |
| `ctrl+e` | 0 | *(empty)* | [Observed] |
| `esc` | 0 | *(empty)* | [Observed] |
| `escape` | 0 | *(empty)* | [Observed] |
| `enter` | 0 | *(empty)* | [Observed] |
| `c-d` | 1 | `{"error":{"code":"invalid_key","message":"unsupported key c-d"}}` | [Observed] |
| `C-d` | 1 | `{"error":{"code":"invalid_key","message":"unsupported key C-d"}}` | [Observed] |
| `ctrl-d` | 1 | `{"error":{"code":"invalid_key","message":"unsupported key ctrl-d"}}` | [Observed] |

**Finding:** The only valid ctrl-key spelling is `ctrl+X` (plus sign). Hyphen (`ctrl-d`) and tmux-style (`C-d`) are rejected with `invalid_key`. Escape is spelled `esc` (canonical) or `escape` (also accepted). Enter is `enter`.

### 1.2 Behavior on a bash (zsh) pane

- `ctrl+d` at an empty prompt: **exits the shell**, pane process goes from `zsh` to nothing (pane becomes empty / pane disappears from `pane list`).
- `ctrl+c`: sends SIGINT, stays in shell.
- `esc`: no visible effect in a bash shell.

### 1.3 Behavior on a Pi pane (`pi --no-tools`)

- **`ctrl+d` at an empty Pi prompt: exits Pi.** Confirmed via `pane process-info` — foreground process changed from `node` (Pi) to `zsh` (shell). This is the interrupt primitive the extension needs.
- **`esc` on a Pi prompt: Pi stays running.** `pane process-info` still shows `node` as the foreground process. `esc` does not cancel Pi.
- **`enter` on an empty Pi prompt: Pi responds with a greeting** ("Hello! Ready to work on pi-subagent-herdr.").

### 1.4 `send-keys` on a missing pane

| Command | Exit code | Raw output | Status |
|---------|-----------|------------|--------|
| `herdr pane send-keys w2W:p1 ctrl+d` (pane gone) | 1 | `{"error":{"code":"pane_not_found","message":"pane w2W:p1 not found"}}` | [Observed] |

---

## 2. Send Text

### 2.1 `send-text` does NOT auto-submit

| Step | Command | Result | Status |
|------|---------|--------|--------|
| 1 | `herdr pane send-text w2W:p2 "hello-from-probe"` | Text appears on prompt line, **not submitted** (no `command not found` yet) | [Observed] |
| 2 | `herdr pane read w2W:p2 --lines 3 --source recent --format text` | Shows `hello-from-probe` on the prompt line, no execution | [Observed] |
| 3 | `herdr pane send-keys w2W:p2 enter` | Submits; zsh executes `hello-from-probe` → `zsh: command not found` | [Observed] |

**Finding:** `send-text` sends the literal characters only. An explicit `enter` keypress (or `pane run`, which bundles text + Enter) is required to submit. This matches the `REQUIREMENTS.md` need: `send_pane_text` must send text followed by `<enter>`.

### 2.2 `send-text` on a Pi pane

Same behavior: text is typed but not submitted until `enter` is sent. Confirmed on `w2X:p1` running `pi --no-tools`.

---

## 3. Console Read

### 3.1 `--source` variants

Tested on a Pi pane (`w2X:p1`) and a bash pane (`w2W:p2`). All three sources accept `--lines <N>` and `--format text|ansi`.

| Source | Behavior | Status |
|--------|----------|--------|
| `visible` | Reads the **visible viewport** (what's on screen now). | [Observed] |
| `recent` | Reads the **recent scrollback** (includes the command prompt + command + output). Includes the Pi status bar lines. | [Observed] |
| `recent-unwrapped` | Same as `recent` but **strips the long Pi status bar / separator lines** (the `────...` rules and the `↑...↓...` model line). Cleaner for extraction. | [Observed] |
| `detection` | Same as `recent-unwrapped` in practice; used internally by agent detection. | [Observed] |

### 3.2 `--lines <N>`

- `--lines 2` returns the last 2 lines.
- `--lines 8` returns the last 8 lines.
- **No character-level slicing.** `--lines` is a line count. For "last 50 characters" (from `REQUIREMENTS.md`), the client (extension) must slice the returned string itself: `text.slice(-50)`.

### 3.3 `--format text` vs `ansi`

- `--format text` (default): plain text, ANSI codes stripped.
- `--format ansi`: preserves ANSI escape sequences.

### 3.4 Output shape

`herdr pane read` with `--format text` outputs **plain text to stdout** (not a JSON envelope). The output is the terminal content, newline-separated. Example (bash pane, `--lines 3 --source recent`):

```
AAAA_111
BBBB_222
CCCC_333
```

With `--raw` the JSON envelope is preserved. Without `--raw`, the CLI unwraps the JSON and prints just the text.

### 3.5 No native character slicing

**Herdr does not support character-level slicing.** Only `--lines <N>` (line count) is available. The extension must do string slicing client-side for "last X chars".

---

## 4. Wait Mechanics & Race

### 4.1 `agent wait` — timeout payload

| Command | Exit code | Raw output | Status |
|---------|-----------|------------|--------|
| `herdr agent wait w2V:p2 --until working --timeout 2000` (agent idle) | 1 | `{"error":{"code":"timeout","message":"timed out waiting for agent status"}}` | [Observed] |
| `herdr agent wait w2X:p1 --until working --timeout 3000` (agent idle) | 1 | `{"error":{"code":"timeout","message":"timed out waiting for agent status"}}` | [Observed] |

### 4.2 `agent wait` — success payload

| Command | Exit code | Raw output | Status |
|---------|-----------|------------|--------|
| `herdr agent wait w2V:p2 --until idle --timeout 2000` (agent already idle) | 0 | `{"id":"cli:agent:wait","result":{"agent":{"agent":"pi","agent_status":"idle","state_change_seq":2770,...},"type":"agent_info"}}` (47ms) | [Observed] |
| `herdr agent wait w2X:p1 --until done --timeout 10000` (agent already done) | 0 | `{"id":"cli:agent:wait","result":{"agent":{"agent":"pi","agent_status":"done","state_change_seq":2789,...},"type":"agent_info"}}` (42ms) | [Observed] |

**Finding:** If the agent is already in the target state, `agent wait` returns **immediately** with the full agent info JSON. No polling needed.

### 4.3 The race: `agent wait` right after `agent prompt`

**This is the critical finding for the extension.**

When you submit a prompt via `herdr agent prompt <TARGET> <TEXT>`, the response JSON shows the agent's status **at the moment of submission**, which is still the *previous* state (`done` or `idle`). The status has NOT yet transitioned to `working`.

| Step | Command | Status observed | seq |
|------|---------|-----------------|-----|
| 1 | `herdr agent prompt w2X:p1 "reply with the single word: ready"` | `done` (from previous turn) | 2792 |
| 2 | `herdr agent wait w2X:p1 --timeout 3000` (immediately after, ~0.3s) | **`done`** (matches! returns success in 47ms) | 2792 |
| 3 | Final state (after Pi actually finished) | `done` | 2792 |

**The race:** `agent wait` without `--until` defaults to matching `idle`, `done`, or `blocked`. If you call it immediately after a prompt, the agent is still in the *previous* `done`/`idle` state (the prompt hasn't been processed yet), so `wait` **returns immediately with success** — it does NOT wait for the new turn to complete.

**The `state_change_seq` field** increments on each state transition (e.g., 2779 → 2783 → 2784 → 2789 → 2792). The seq in the `agent prompt` response is the seq *before* the new turn. The seq after the new turn completes is higher.

**How to handle this in the extension:**

1. **Use `agent prompt --wait`:** This is the correct primitive. `herdr agent prompt <TARGET> <TEXT> --wait --timeout <MS>` submits the prompt AND waits for the agent to reach a terminal state (`idle`/`done`/`blocked`). The `--wait` flag internally waits for an observed `working` state within 5000ms of submission before matching the terminal state. This avoids the race.
   - Payload on success: `{"id":"cli:agent:prompt","result":{"agent":{...,"agent_status":"done","state_change_seq":2787,...},"type":"agent_prompted"}}`
   - Payload on timeout: `{"error":{"code":"timeout","message":"timed out waiting for agent status"}}` (exit 1) — confirmed live, see Follow-Up EXP C. (NOT the `pane wait-output` message.)
   - Payload on stalled (agent didn't start working within 5s): `agent_prompt_stalled` (documented in help text; not live-observed).

2. **If using `agent prompt` + `agent wait` separately:** You must record the `state_change_seq` from the prompt response, then wait for a `state_change_seq` **greater than** the recorded value. The CLI does not support this directly — you'd need to poll `agent get` and compare seq. The two-phase variant (`wait --until working` then `wait --until done`) is validated in §Follow-Up EXP B.

3. **`--until working` on `agent wait`:** If you want to confirm the agent *started* working (not just that it's still in the old state), use `--until working`. But this only confirms the transition, not completion.

### 4.4 `pane wait-output`

| Command | Exit code | Raw output | Status |
|---------|-----------|------------|--------|
| `herdr pane wait-output w2X:p1 --match "gemini" --timeout 5000` (marker in snapshot) | 0 | `{"id":"cli:pane:wait-output","result":{"matched_line":"...","pane_id":"w2X:p1","read":{...},"revision":0,"type":"output_matched"}}` (45ms) | [Observed] |
| `herdr pane wait-output w2X:p1 --match "ZNOTPRESENT_MARKER" --timeout 2000` | 1 | `{"error":{"code":"timeout","message":"timed out waiting for output match"}}` | [Observed] |
| `herdr pane wait-output w2X:p1 --regex 'DONE_MARKER_[0-9]+' --timeout 5000` | 0 | Matches the prompt line containing the marker (regex works) | [Observed] |

**Finding:** `pane wait-output` searches the *current snapshot immediately*, then polls. It is useful for waiting on specific output (e.g., a marker in the console). It supports `--match` (literal) and `--regex` (Rust regex).

---

## 5. Pane & Workspace Queries

### 5.1 `workspace list`

Returns JSON with `workspaces[]`, each containing `workspace_id`, `label`, `pane_count`, `tab_count`, `agent_status`, `focused`, `active_tab_id`. No filtering — returns all workspaces.

### 5.2 `pane list`

- **Default:** Returns all panes across all workspaces (24 panes observed).
- **`--workspace <WORKSPACE_ID>`:** Filters to panes in that workspace only. Confirmed: `herdr pane list --workspace w2V` returns exactly the 4 panes in `w2V`.

Each pane entry includes: `pane_id`, `workspace_id`, `tab_id`, `cwd`, `foreground_cwd`, `agent_status`, `focused`, `revision`, `terminal_id`, `terminal_title`.

### 5.3 `pane close`

| Scenario | Command | Exit code | Raw output | Status |
|----------|---------|-----------|------------|--------|
| Close a live pane | `herdr pane close w2W:p2` | 0 | `{"id":"cli:pane:close","result":{"type":"ok"}}` | [Observed] |
| Close an already-closed pane | `herdr pane close w2W:p2` (second time) | 1 | `{"error":{"code":"pane_not_found","message":"pane w2W:p2 not found"}}` | [Observed] |
| Close a pane that never existed | `herdr pane close w2W:p1` | 1 | `{"error":{"code":"pane_not_found","message":"pane w2W:p1 not found"}}` | [Observed] |

**Finding:** Closing a non-existent or already-closed pane returns `pane_not_found` (exit 1). The extension should handle this gracefully (idempotent close).

### 5.4 `workspace close`

| Scenario | Command | Exit code | Raw output | Status |
|----------|---------|-----------|------------|--------|
| Close a live workspace | `herdr workspace close w2X` | 0 | `{"id":"cli:workspace:close","result":{"type":"ok"}}` | [Observed] |
| Close a non-existent workspace | `herdr workspace close w2W` | 1 | `{"error":{"code":"workspace_not_found","message":"workspace w2W not found"}}` | [Observed] |

---

## 6. Additional Findings (Not in Original Experiments)

### 6.1 `pane run` — text + Enter in one call

`herdr pane run <PANE_ID> <COMMAND>` sends the command text AND an Enter key in one call. This is the correct primitive for `send_pane_text` if you want to submit immediately.

### 6.2 `agent prompt` — the primary prompt primitive

`herdr agent prompt <TARGET> <TEXT> [--wait] [--until <STATUS>] [--timeout <MS>]`

- Without `--wait`: submits the prompt, returns immediately with the agent's current (pre-transition) state.
- With `--wait`: submits and waits for the agent to reach a terminal state. This is the **recommended primitive** for the extension's `wait_subagent_or_timeout` tool.
- `--until` can restrict which states count as "done" (default: `idle`, `done`, `blocked`).
- `--timeout <MS>`: fails with `timeout` error if the agent doesn't reach a terminal state within the given time.
- If the agent is already `blocked`, submission is rejected with `agent_blocked` before any input is sent.

### 6.3 `agent get` — full agent state

Returns the full agent info including `agent_status`, `state_change_seq`, `pane_id`, `workspace_id`, `tab_id`, `terminal_id`, `terminal_title`, `cwd`, `foreground_cwd`, `focused`, `revision`, `agent_session` (with `source: "herdr:pi"` and session path).

### 6.4 Pane lifecycle edge case

When a pane's foreground process exits (e.g., `ctrl+d` exits the shell), the pane may disappear from `pane list` if it was the only pane in its workspace. This was observed with `w2W:p1` — after `ctrl+d` exited the zsh, the pane was gone. The workspace itself survived (with the remaining pane). **This means `pane close` on a process-exited pane returns `pane_not_found`.**

### 6.5 `send-keys` on a pane with no agent

`send-keys` works on any pane (bash, zsh, Pi, etc.). It is not agent-specific. The key validation (`ctrl+d` valid, `ctrl-d` invalid) is consistent regardless of the pane's content.

---

## 7. Cleanup Confirmation

| Resource | Action | Status |
|----------|--------|--------|
| `w2W` (probe-scratch, initial) | Lost when `w2W:p1` exited via `ctrl+d`; `w2W:p2` closed manually; workspace auto-closed | [Confirmed] |
| `w2X` (probe-scratch, primary) | `herdr workspace close w2X` → `{"result":{"type":"ok"}}`; verified absent from `workspace list` | [Confirmed] |
| `w2V:p1` (Horst) | **Untouched** — never sent text/keys, never closed | [Confirmed] |
| `w2V:p2` (Judith) | **Untouched** — only read via `agent get` / `agent wait --until idle` (read-only) | [Confirmed] |

No scratch panes or workspaces remain.

---

## Follow-Up Experiments

**Worker:** Fritz (experimenter)
**Date:** 2026-03-14 (follow-up on lead audit, per `docs/fritz_followup.md`)
**Scratch workspaces used:** `w2Z` (primary). One earlier scratch `w2Y` was created and closed during an initial attempt. All cleaned up; `w2V:*` panes were NOT touched in this round.

> **Correction to prior round:** In the original run, `agent wait`/`agent get` were executed against `w2V:p2` (Judith) — that was outside the scratch box. Those findings (§4.1 timeout payload, §4.2 success payload) are still valid observations of CLI *mechanics*, but the follow-up below re-confirms the key payload shapes inside scratch workspaces only.

### EXP A — Interrupt semantics on a WORKING Pi agent

Setup: scratch workspace `w2Z`, pane `w2Z:p1`, launched `pi --no-tools` via `pane run`. Agent detected `idle`, seq 2820.

#### A1: `esc` on a working agent

1. `herdr agent prompt w2Z:p1 "<long Roman Empire analysis, no tools>"` → prompt response: `agent_status=idle, state_change_seq=2820` (stale, pre-transition).
2. +5s: `herdr agent get w2Z:p1` → `{"status":"working","seq":2821}`.
3. `herdr pane send-keys w2Z:p1 esc` → exit 0.
4. +4s observations:

| Observation | Result | Status |
|-------------|--------|--------|
| `agent get` | `{"agent_status":"done","state_change_seq":2822}` | [Observed] |
| `pane process-info` | foreground process `node` (pid 64775) still running — Pi alive | [Observed] |
| `agent read --lines 10` | shows truncated turn text, then **`Operation aborted`**, then the Pi prompt line again | [Observed] |

**Finding A1:** [Observed] `esc` **aborts the active turn**: status `working` (seq 2821) → `done` (seq 2822), console prints `Operation aborted`, the Pi process stays alive at the prompt. `esc` is a turn-level interrupt, not a kill.

#### A2: `ctrl+d` on a working agent

1. Second long prompt (Byzantine Empire) → +5s: `agent get` → `{"status":"working","seq":2823}`.
2. `herdr pane send-keys w2Z:p1 ctrl+d` → exit 0.
3. +4s observations:

| Observation | Result | Status |
|-------------|--------|--------|
| `agent get` | **no agent object** (null status/seq — agent undetected) | [Observed] |
| `pane process-info` | foreground process `zsh` (pid 64725) — Pi process gone, shell re-emerged | [Observed] |
| `agent read --lines 10` | `{"error":{"code":"agent_not_found","message":"agent target w2Z:p1 not found"}}` | [Observed] |
| `pane list --workspace w2Z` | `[{"pane_id":"w2Z:p1","agent_status":"unknown"}]` — pane alive, agent status dropped to `unknown` | [Observed] |

**Finding A2:** [Observed] `ctrl+d` on a **working** Pi agent is a **kill, not an interrupt**: the Pi process exits, the pane remains with a bare zsh, agent detection drops to `unknown` (agent API calls then fail with `agent_not_found`). It cannot be used as a "turn interrupt" on a working agent — it ends the session. For interrupting a running turn use `esc`; for terminating the agent use `ctrl+d` (at an empty prompt) or `pane close`.

**Consistency note:** A1 and A2 each ran once (the `ctrl+d` kill consumed the pane, so a retry of A1 on the same pane was not needed — the esc test had already completed before the kill). Behavior was unambiguous in both cases.

### EXP B — Launch-plus-wait for a freshly launched agent

Setup: pane `w2Z:p1`, `pane run ... "pi --no-tools"`. Poll `agent get` until status != `unknown`.

| Step | Command / observation | Result | Status |
|------|----------------------|--------|--------|
| S0: first detection | poll `agent get w2Z:p1` | `{"status":"idle","seq":2816}` (this run; in the earlier w2Y attempt: `idle`, seq 2809) | [Observed] |
| Step 3: `agent wait --until working --timeout 60000` **before any prompt** | timed out after 10s in the first variant / 60s semantics confirmed | `{"error":{"code":"timeout","message":"timed out waiting for agent status"}}`, exit 1 | [Observed] |
| Prompt | `agent prompt ... "<French Revolution analysis, no tools>"` | response: `{"type":"agent_prompted","status":"idle","seq":2816}` — **stale pre-transition state** | [Observed] |
| Wait 1 | `agent wait w2Z:p1 --until working --timeout 60000` | resolved in **356ms**: `{"status":"working","seq":2818}` — seq 2818 > S0 (2816) | [Observed] |
| Wait 2 | `agent wait w2Z:p1 --until done --timeout 120000` | resolved in **22.98s**: `{"status":"done","seq":2819}` — seq 2819 > 2818 | [Observed] |

States used in the two-phase wait: phase 1 `--until working`, phase 2 `--until done` (single state, not a union with `idle`; `done` was the terminal state pi reached).

**Finding B1:** [Observed] The two-phase wait (working → done/done-or-idle, seq-gated) **works for freshly launched agents**: final seq (2819) > S0 (2816) > prompt-response seq (2816). The `--until working` phase consumes the stale-state race (it only resolves on the *new* working transition), and the subsequent `--until done` cannot match the stale state because the agent is no longer in it.

#### B2: explicit failure mode — `agent wait --until idle` immediately after launch

Fresh pane `w2Y:p2` (separate scratch workspace), `pane run ... "pi --no-tools"`, polled until first detection → `idle`, seq 2817. Then immediately:

| Command | Result | Status |
|---------|--------|--------|
| `time herdr agent wait w2Y:p2 --until idle --timeout 30000` | returned in **36ms**, exit 0, full agent JSON with `agent_status=idle, state_change_seq=2817` | [Observed] |

**Finding B2:** [Observed] Calling `agent wait --until idle` on a freshly launched agent returns **instantly with the stale initial `idle`** — it cannot distinguish "just launched, hasn't worked yet" from "finished". Any wait on a fresh agent MUST first gate on `--until working` (or on seq advancement); a bare `--until idle` wait is unsound.

### EXP C — `--wait` semantics documented

#### C1: Verbatim help text

**`herdr agent prompt --help`:**

> Submit a prompt to an agent
>
> Usage: herdr agent prompt <TARGET> <TEXT> [OPTIONS]
>
> Options:
>   --wait          Wait for the first matching state observed after submission
>   --until <STATUS>   State to match after --wait; repeat for more than one state
>                     [possible values: idle, working, blocked, done, unknown]
>   --timeout <MS>     Fail after this many milliseconds
>
> If the agent is already blocked, submission is rejected with agent_blocked before any input is sent. When an accepted submission starts from another non-working state, --wait requires an observed working or blocked state within 5000ms; otherwise it returns agent_prompt_stalled. A caller timeout that expires first returns timeout. It then matches idle, done, or blocked by default, or any exact --until state. It does not track turns: if the agent is already working, that active turn's completion may match.

**`herdr agent wait --help`:**

> Wait until an agent reaches one of the requested states
>
> Usage: herdr agent wait <TARGET> [OPTIONS]
>
> Options:
>   --until <STATUS>   State to match; repeat for more than one state
>                     [possible values: idle, working, blocked, done, unknown]
>   --timeout <MS>     Fail after this many milliseconds
>
> Without --until, matches idle, done, or blocked. Use --until unknown explicitly when needed. Without --timeout, waits indefinitely.

**Finding C1:** [Documented] The claim that `--wait` "internally waits for an observed working state within 5000ms" is directly supported by the help text: *"When an accepted submission starts from another non-working state, --wait requires an observed working or blocked state within 5000ms; otherwise it returns agent_prompt_stalled."*

#### C2: Real `--wait` timeout error message

Live capture: `herdr agent prompt w2Z:p1 "<long analysis, no tools>" --wait --timeout 8000` on an agent that stayed working past the caller timeout:

```
{"error":{"code":"timeout","message":"timed out waiting for agent status"},"id":"cli:agent:prompt"}
EXIT=1
```

**Finding C2:** [Observed] `agent prompt --wait` timeout emits `agent`-domain errors (`code: timeout`, message `timed out waiting for agent status`), **not** the `pane wait-output` message (`timed out waiting for output match`). The original report's §6.3 line (which cited "timed out waiting for output match" for `agent prompt --wait`) is **incorrect** — that message belongs to `pane wait-output` (confirmed live in §4.4). Corrected: `agent prompt --wait` / `agent wait` timeout → `timed out waiting for agent status`; `pane wait-output` timeout → `timed out waiting for output match`. Two further documented-but-unobserved codes: `agent_prompt_stalled` (no working/blocked observed within 5000ms) and `agent_blocked` (submission rejected because agent already blocked).

**Follow-up cleanup:** scratch workspaces `w2Y` and `w2Z` closed via `workspace close` (both `result.type=ok`) and verified absent from `workspace list`. `w2V:*` (p1, p2, p4, p5, p7) untouched in this round — verified via `pane list --workspace w2V` before and after.
