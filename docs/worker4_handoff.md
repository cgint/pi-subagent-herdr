# Handoff: Worker 4 (Skill Script Usage & Caveats Mining)

**Identity chain:** Horst (lead) → Worker 4: Wilhelm (script-usage miner)
**Task:** Use ripgrep (`rg`) over `~/.pi/profiles/*/agent/sessions/` and `~/.pi/agent/sessions/` to find all real-world usage of the supervisor skill's sh scripts, and extract the **behaviour patterns and caveats** agents had to deal with — direct input to the `pi-subagent-herdr` extension design.
**Report path:** `/Users/christian.gintenreiter/dev-external/pi-subagent-herdr/docs/worker4_script_usage_report.md`
**Mode:** editable — authorized ONLY to write that one report file. No other file changes.

## Scope (stay in this lane)
Another worker (Stefan) is mining *generic* herdr CLI usage. You cover the **skill scripts** and their failure/caveat surface. Avoid re-doing generic `herdr pane/agent` frequency counts.

## Method (bounded, fast)
1. Run rg searches (each capped, e.g. `| head -100`, never dump whole files):
   - `rg -n --no-heading 'herdr-start-subagent' <session-roots> | head -200`
   - same for: `herdr_await_agent`, `herdr_prompt_agent`, `herdr-worker\.sh`, `pi-worker-runtime`, `test_worker_launchers`, `\.sub_agent_conf`, `PI_WORKER_DEFAULT_MODEL`, `herdr integration install`
   - Script error strings that agents would have seen: `rg -n 'detection timeout|agent_not_found|agent_blocked|prompt.sent|agent_working|agent_prompt_stalled|timed out|write guard|readonly mode' <session-roots> | head -200`
2. For interesting hits, pull context lines (`rg -n -C 2 ...` on a narrow pattern, or read the specific session file region) to answer:
   - What flags were used in practice (`--mode`, `--brief` vs `--handoff`, `--timeout-seconds`, `--cwd`, `--direction`)?
   - What did the tool result show (exit code, JSON, error)?
   - What did the agent do next (retry, redirect, manual `herdr agent read`, close pane, escalate)?
3. Also grep assistant-turn narratives for friction: `rg -n -i 'launcher (timed|failed)|not detected|pane not|report (missing|never)|ignored (the )?(scope|boundar)|focus (stolen|switched)' <session-roots> | head -100`.

## Report format (`docs/worker4_script_usage_report.md`)
- **HEADLINE** — one paragraph: what the scripts were actually used for and how often.
- **Frequency table** — per script and per flag, with hit counts.
- **Failure modes** — each: count, one verbatim example (command + result), and the recovery the agent used.
- **Caveats list** — the things an agent *had to know* to use these tools successfully (detection races, stale idle states, report-path rules, write-guard behaviour, JSON parsing gotchas, cleanup discipline). This becomes the spec for extension tool semantics.
- **Behaviour patterns** — sync waits vs polling, read-back after await, pane close after completion, follow-up prompts.
- **UNDETERMINED** — anything you could not establish.
- Confirmation line: only the report file was written.

**Stop rule:** one pass over the searches above, context only where needed, then write the report. Timebox ~20 minutes.
