# Fritz Follow-Up: Interrupt Semantics & Launch-Plus-Wait Experiments

**Identity chain:** Horst (lead) → Fritz (experimenter)
**Status:** bounded follow-up on `docs/worker1_report.md` — two gaps from the lead audit.

## HARD BOUNDARY
- Work ONLY in a fresh scratch workspace (e.g. `w2Y`) and its panes.
- **Never** touch, read, wait on, or send anything to `w2V:*` panes (p1, p2, p4, p5, p7). Your previous run did `agent wait` against `w2V:p2` — that was outside your box. Do not repeat it.
- Clean up the scratch workspace at the end (`workspace close`, verify with `workspace list`).
- Append results as a new section "## Follow-Up Experiments" to `docs/worker1_report.md` (your report file). No other file changes.

## EXP A — Interrupt semantics on a WORKING Pi agent
Your report only tested `esc` and `ctrl+d` on an *idle* Pi prompt. That proves nothing about interruption.

1. Scratch workspace + pane running `pi --no-tools`.
2. Get the agent into `working` state with a prompt that takes ~30–60s (e.g. ask it to write a very long analysis without tools). Confirm `agent_status == working` via `agent get`.
3. Send `herdr pane send-keys <pane> esc`. Wait ~3–5s. Record: `agent get` (status, state_change_seq), `pane process-info`, and `agent read --lines 10`.
   - Question: did the turn abort and agent return to `idle`? Or did nothing happen?
4. Start a second long prompt, confirm `working` again. Send `herdr pane send-keys <pane> ctrl+d`. Wait ~3–5s. Record the same three observations plus `pane list --workspace <scratch>`.
   - Question: did Pi exit (pane gone / process gone)? Did the agent state change? Is `ctrl+d` usable as an "interrupt" at all, or is it a kill?
5. If both failed to interrupt, retry each once and note if behavior is consistent.

## EXP B — Launch-plus-wait for a freshly launched agent (no `agent prompt` involved)
The worker-launch flow delivers the first task via `pane run` (command line), not via `agent prompt`, so the prompt-then-wait race from your §4.3 may apply.

1. New pane in scratch workspace; launch Pi with a bounded first task via `herdr pane run <pane> 'pi --no-tools -p "say ready"'` or the closest equivalent that starts Pi (mirror what `herdr-start-subagent.sh` does: `pane run` with the pi command + payload).
2. Poll `agent get <pane>` until `agent_status` is no longer `unknown`; record the `state_change_seq` at first detection (call it S0).
3. Call `herdr agent wait <pane> --until working --timeout 60000`. Record: did it resolve? With which seq?
4. Call `herdr agent wait <pane> --until idle --timeout 120000` (plus `--until done` if you want the union — note which states you used). Record the seq in the response.
   - Question: is the final seq > S0? If yes, the two-phase wait (working → idle/done, seq-gated) is a sound launch+wait primitive. If the wait returned a seq ≤ S0, it matched the *stale* state and the two-phase approach is broken for fresh launches.
5. Also test the failure mode explicitly: on a *second* fresh pane, call `agent wait --until idle` **immediately** (before any working state) and record whether it returns instantly with the stale state.

## EXP C — Document `--wait` semantics
1. Capture verbatim: `herdr agent prompt --help` and `herdr agent wait --help`.
2. Your report claims `--wait` "internally waits for an observed working state within 5000ms" — label this [Documented] with the help text as source, or [Undocumented/inferred] if the help text doesn't support it.
3. Note what the `--wait` timeout error message actually says on a real timeout (you observed "timed out waiting for output match" — that looks like `pane wait-output`'s message; verify which error `agent prompt --wait` emits).

## WORK REPORT
Terminal `WORK REPORT` + appended section in `docs/worker1_report.md`. Per experiment: exact commands, exit codes, verbatim key JSON fields (status/seq), and one labeled finding line ([Observed] / [Documented] / [Inferred]).
