# Plan 1: Information Gathering & Feasibility Probing

**Status:** Revised Draft (incorporating Judith's critique)  
**Date:** 2025-09-30  
**Authors:** Horst (Lead)  
**Reviewer:** Judith (`HERDR_PANE_ID=w2V:p2`, Coordinator Buddy)

---

## 1. Core Unknowns & Grounding Questions

### A. The Existing Scripts as the Specification (Requirement 1)
- **Source Files:** `herdr-start-subagent.sh`, `herdr-worker.sh`, `pi-worker-runtime.sh`, `herdr_agent_observation_lib.sh`, and `test_worker_launchers.sh`.
- **Questions:**
  1. What do `readonly` and `editable` actually configure? (e.g. `--tools read,bash,grep,find,ls --dm-read` vs `PI_WRITE_GUARD_DIRS`).
  2. Are there any other modes hinted at by the user's "..."?
  3. How are profiles (`pi-profile minimal` vs `default`) and `.sub_agent_conf` resolved and probed?
  4. Which caller arguments are blocked (e.g. `--model`, `--provider`, `--tools`)?
  5. What is the contract for handoff vs brief, absolute report paths, and agent naming regex (`^[a-z][a-z0-9_-]{0,31}$`)?
  6. What safety invariants do the existing launcher tests enforce?

### B. Herdr Key Sending & Process Interrupts (Requirement 6)
- **Herdr Key Syntax:** What exact key identifier does `herdr pane send-keys <pane_id> ...` accept? (Does it accept `ctrl+d`, `c-d`, `C-d`, `ctrl-c`, `esc`?)
- **Pi Session Reaction:** In an active Pi terminal session inside a Herdr pane, what actually happens when each key is sent?
  - Does Ctrl-D exit the session (if editor is empty), or does it abort an in-flight prompt?
  - Does Escape trigger `app.interrupt`?
  - What does the verbatim requirement "send -interrupt- to another pane (depending on the agent this is handed over as CTRL-D for pi - this is the only supported)" require from us?

### C. Console Reading & Tail Extraction (Requirements 3 & 4)
- **Read Sources & Formats:** How do `herdr pane read` and `herdr agent read` differ? Which source is best (`recent-unwrapped` vs `recent`)?
- **Character Slicing vs Line Limits:** Herdr CLI supports `--lines N`. Does it support character slicing natively, or must the extension perform string slicing on the unwrapped output?
- **ANSI Stripping:** Does `pane read` return ANSI codes or plain text by default (`--format text`)?

### D. Waiting & The Lifecycle Race Condition (Requirements 2 & 4)
- **Wait Behavior:** What are the exact exit codes and payloads when `herdr agent wait` times out vs succeeds vs fails?
- **Prompt/Wait Race Condition:** Immediately after sending text/prompt, does `herdr agent wait` return immediately because the agent is still observed as `idle` before transitioning to `working`? How does `state_change_seq` solve this in `herdr_prompt_agent.sh`?
- **Immediate Return with Console Preview:** How to implement "return immediately e.g. after X seconds with the last 50 chars": polling loop vs timeout on wait?

### E. Pane & Workspace Management (Requirements 5, 7, 8, 9)
- **Send Text:** Does `herdr pane send-text` append `<enter>` automatically, or does it require an explicit newline / subsequent `send-keys Enter`?
- **Workspaces & Panes:** What JSON formats do `herdr workspace list` and `herdr pane list` produce? Can `pane list` filter by workspace ID?
- **Close Pane:** What happens when closing a pane via `herdr pane close`? Does it kill the child process cleanly? What happens if target is non-existent, already closed, or the caller's own pane?

### F. Pi Extension API & Overlap with `pi-herdr`
- **Pi Extension API:** What are the conventions for tool definitions (TypeBox), streaming/progress, long-running blocking tools, and `AbortSignal` cancellation?
- **Overlap with `pi-herdr`:** `../pi-herdr` already implements several tools (`herdr_start_agent`, `herdr_send_prompt`, `herdr_read_agent`, `herdr_wait_agent`). What does it do well, what is missing (modes, write guards, .sub_agent_conf, workspace listing), and should our extension be standalone (`subagent_*`) or extend `pi-herdr`?

---

## 2. Multi-Agent Investigation Graph

```
                        +----------------------+
                        |     User (Human)     |
                        +----------+-----------+
                                   |
                                   v
+--------------------------------------------------------------------+
|                            Horst (Lead)                            |
| - Coordinates investigation, enforces safety boxes, synthesizes    |
| - Captures evidence in docs/findings.md                            |
+-------------------+----------------------------+-------------------+
                    |                            |
                    v (Critiques discovery)      v (Delegated research)
+-----------------------------+     +--------------------------------+
|  Judith (Buddy Coordinator) |     |   Sub-Agent Workers (Herdr)    |
|  HERDR_PANE_ID=w2V:p2       |     |                                |
| - Reviews findings          |     | [Worker 1: Herdr Experiments]  |
| - Verifies evidence rigor   |     |   - Live CLI probes (sandboxed)|
| - Checks parity matrix      |     | [Worker 2: Specs & Code Scout] |
|                             |     |   - Analyzes scripts & pi-herdr|
+-----------------------------+     +--------------------------------+
```

### Safety Box for Worker 1 (Live Probes):
- Worker 1 will create a dedicated temporary scratch workspace/tab (`herdr workspace create` or dedicated tab in current workspace).
- Worker 1 **must NEVER** send text, keys, or close commands to `w2V:p1` (Horst) or `w2V:p2` (Judith).
- Worker 1 must track every pane it spawns and close all of them before exiting.

---

## 3. Investigation Evidence Contract

Every finding reported must include:
1. Exact source command, script file:line, or doc reference.
2. Raw JSON or terminal output proof.
3. Classification: `[Observed]` (tested live), `[Documented]` (found in docs/specs), or `[Inferred]`.
4. Stored durably in `docs/findings.md` (never lost in transient chat).

---

## 4. Deliverables of Phase 1

1. Completed `docs/findings.md` containing verified answers to all questions A–F.
2. Feasibility Table: Mapping each of the 9 user requirements to verified Herdr/Pi mechanisms.
3. Decision proposals for User:
   - Tool naming/overlap strategy (`subagent_*` vs `pi-herdr`).
   - Exact behavior of `CTRL-D` vs `Escape` for Pi interrupt.
   - Script reuse vs TypeScript port for worker runtime sandbox.
