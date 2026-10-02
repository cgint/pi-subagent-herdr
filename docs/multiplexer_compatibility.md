# Multiplexer Compatibility Investigation (cmux · orca · herdr)

**Date:** 2026-10-02 · **Lead:** Horst · **Mode:** read-only (Strict-Discuss)
**Scope:** Assess whether `pi-subagent-herdr` can drive sub-agents under **cmux** or **orca** in addition to **herdr**, auto-selected by the runtime environment.
**Labels:** [Observed] = live run · [Documented] = read from official docs/source/help · [Inferred] = derived from docs + existing code. *Everything below is [Documented] or [Inferred] until we probe a real install.*

---

## 0. Bottom line (one paragraph)

All three are "agent multiplexers" that expose a **very similar conceptual surface** (workspaces → panes → terminals/surfaces → an agent you can prompt, read, and wait on). Our existing `subagent_*` tools (R-1..R-9) map almost 1:1 onto each host. The compatibility work is therefore **not a rewrite** — it is a **per-host adapter layer** in front of the existing `SubagentService`. The host-specificity lives entirely in `src/core.ts` (herdr CLI command names, herdr's typed JSON envelope, the `HERDR_PANE_ID` env var, and herdr's agent lifecycle states). `src/transport.ts` is already host-agnostic **for spawned processes** — but cmux is **not** a spawnable CLI; it is a **Unix socket**, so a cmux adapter needs a *second* transport (socket RPC), not a reused `spawn` call. The one real risk: **cmux is the weakest fit** — it has no agent-lifecycle API and **no `wait` command at all**, so `subagent_wait`/`subagent_prompt` are keystroke-inferred on cmux, and cmux additionally gates access by process ancestry (see §4/§5).

---

## 1. What the three hosts actually are

| Host | Runtime model | Control interface | Env / id |
|---|---|---|---|
| **herdr** (current) | **Server/runtime** — holds real terminals open on the machine; every UI (incl. TUI) is just a client that attaches. Runs inside any terminal, survives SSH. | CLI: `herdr pane/agent/workspace/tab/worktree …` | `HERDR_PANE_ID` (e.g. `w2V:p1`) |
| **cmux** | **Native macOS app** built on **libghostty** (Ghostty-compatible config). Hierarchy: session → workspaces → screens → panes → surfaces (terminal or browser tabs). One control socket per session. | **Unix socket + CLI** (every command available both ways). Socket: newline-terminated JSON `{id, method, params}`. `CMUX_SOCKET_PATH` (default `/tmp/cmux.sock`). **Access modes:** `cmuxOnly` (default — only processes spawned *inside* cmux terminals can connect) / `allowAll` / `off`. | `CMUX_SOCKET_PATH`, `CMUX_WORKSPACE_ID`, `CMUX_SURFACE_ID`, `TERM_PROGRAM=ghostty` |
| **orca** | **VS Code-based** terminal layer with a structured **multi-agent orchestration** layer (Runs, Tasks, Dispatches, supervised workers, decision gates). | CLI: `orca terminal …`, `orca orchestration …`, `orca worktree …` (all `--json`) | `--worktree`, `--terminal <handle>` |

[Documented] cmux.com/docs/tui, cmux.com/docs/concepts; onorca.dev/docs (terminal, agents-sessions, cli/reference, cli/overview, orchestration); herdr.dev/docs.

Key framing from herdr's own comparison page: *"Apps manage the herd. Herdr runs it."* — herdr is the runtime; cmux and orca are (mac-native / VS-Code-native) apps that also run their own terminals. This matters because each host owns its own terminal processes and panes; our extension is always a **client** talking to that host's control surface.

---

## 2. Requirement → host command mapping

The existing extension implements R-1..R-9. Mapping each to the three hosts:

| Tool (R) | herdr (verified) | orca [Documented] | cmux [Documented] |
|---|---|---|---|
| `subagent_start` (R-1) | `pane split --no-focus` → `pane_id`; `agent prompt` post-detection | `terminal create --worktree … --title … --command …` **or** `terminal split --terminal <h> --direction horizontal/vertical --command …` | `cmux new-split right/down --command "…"` (socket: `surface.split`, `initial_input: "cmd\r"`) → send keystrokes |
| `subagent_prompt` (R) | `agent prompt <pane> <text>` (lifecycle-aware; returns `agent_prompted`) | `terminal send --terminal <h> --text … --enter --json` | send keystrokes to surface |
| `subagent_read` (R-3) | `agent read <t> --lines N --source recent-unwrapped` / `pane read` | `terminal read --terminal <h> [--screen] [--cursor --limit] --json` | read pane content |
| `subagent_wait` (R-2/R-4) | `agent wait <t> --until idle,done,blocked --timeout` + poll `agent get` (seq-gate) | `terminal wait --terminal <h> --for tui-idle --timeout-ms … --json` (**`tui-idle` only is documented; other `--for` values unverified**) | **no wait command** — must poll `read`/`list-panels` and infer a terminal state from keystroke output |
| `subagent_send` (R-5) | `pane run <pane> <text>` (text+Enter atomic) / `pane send-text` + `pane send-keys enter` | `terminal send --text … --enter --json` | send keystrokes |
| `subagent_interrupt` (R-6) | `pane send-keys <pane> esc` (turn abort; ctrl+d kills) | send `Esc` to terminal | send `Esc` to surface |
| `subagent_list` (R-7) | `pane list --workspace <id>` + `agent list` join for names/status | `terminal list --worktree active --json` (topology via `--include-visual-layouts`) | `list-panels` / `list-pane-surfaces` (surfaces-in-workspace) |
| `subagent_spaces` (R-8) | `workspace list` | `worktree list --repo id:<repoId> --json` / `worktree ps` (worktrees are orca's context unit, *not* the terminal list) | `list-workspaces` (`workspace.list`) |
| `subagent_close` (R-9) | `pane close <pane_id>` (`pane_not_found` ⇒ idempotent success) | `terminal close --terminal <h> --json` (close **terminal**, not worktree) | `surface`/pane close — *not in the public CLI reference; verify before implementing* |

[Inferred] for orca/cmux cells: derived from the official CLI docs above. Exact flag spelling, output JSON shapes, and lifecycle-state strings are **unverified** until probed against a live install.

### Naming note (R-8)
The tool is literally named `subagent_spaces` (herdr "workspace" vocabulary). orca's equivalent concept is **worktree**; cmux's is **workspace**. A cross-host design wants a **neutral "list workspaces/contexts" tool** so the name doesn't leak herdr's vocabulary into the model's mental model.

---

## 3. Where host-specificity actually lives in our code

| File | Coupling | Impact |
|---|---|---|
| `src/transport.ts` | **None** — already generic: spawns an arbitrary binary, returns raw bytes with timeout/byte-cap/abort. | Reuse as-is. |
| `src/core.ts` | **All of it**: herdr command names (`pane get`, `agent prompt`, `agent wait`, `pane split`, `pane list`, `workspace list`, `pane close`); herdr's **typed JSON envelope** (stdout on exit 0, stderr on exit 1, `result.type` like `agent_prompted`); `HERDR_PANE_ID`; herdr agent lifecycle states `idle/done/blocked`; the seq-gated two-phase wait; the `agent_status`/`state_change_seq` detection polling. | This is the seam to abstract. |
| `src/index.ts` | **Light**: `HERDR_PANE_ID` env read for R-10 footer + service construction; runtime-dir resolution (herdr skill scripts). | Add host detection + per-host env-var/footer handling. |

### The 9-operation adapter boundary (proposed)
A thin `HostAdapter` interface owning the 9 operations + host detection:

```
interface HostAdapter {
  readonly host: "herdr" | "orca" | "cmux";
  detect(): boolean;                    // can this host be used here?
  myPaneId(): string | undefined;       // R-10 / "same space" resolution
  workspaceIdOf(pane): Promise<string|undefined>;
  start(name, cwd, mode, task, …): Promise<Result>;   // R-1
  prompt(target, task, …): Promise<Result>;           // R
  read(target, …): Promise<Result>;                   // R-3
  wait(target, …): Promise<Result>;                   // R-2/R-4
  send(target, text): Promise<Result>;                // R-5
  interrupt(target): Promise<Result>;                 // R-6
  listPanes(): Promise<Result>;                       // R-7
  listSpaces(): Promise<Result>;                      // R-8
  close(target, externalConfirmed): Promise<Result>;  // R-9
}
```

`SubagentService` orchestration (ownership records, seq-gated wait, delivery proof, terminal-state race, external-target deny, idempotent close, session-entry persistence) **stays shared**; each adapter fills the 9 leaves with host-specific CLI calls + envelope parsing. The tool surface in `index.ts` (schemas, footer, ownership persistence, UI close-confirmation) is unchanged — it calls the same `execute(operation, …)`.

---

## 4. Per-host differences that must NOT be papered over

1. **Agent-lifecycle semantics.** herdr exposes `idle/done/blocked` + `state_change_seq`. orca documents only `terminal wait --for tui-idle` (a single "UI idle" wait; other `--for` values are **unverified**). **cmux has no agent-lifecycle API and no `wait` command at all** — it is keystroke-level. So `subagent_wait` is full-featured on herdr, single-state on orca (as documented), and **degraded/inferred on cmux** (must poll).
2. **`subagent_prompt` delivery proof.** herdr returns a typed `agent_prompted` receipt. orca `terminal send` is a raw submit (no lifecycle receipt). cmux is raw keystrokes. The "delivery proof is mandatory" guarantee (findings §3.1 / caveat 12) holds only on herdr; on orca/cmux it weakens to "submit confirmed, completion inferred."
3. **Worktree concept (orca).** orca addresses terminals by `--worktree` and its context unit (R-8) is the **worktree**, not the terminal. There is no worktree in herdr. `subagent_start.cwd` maps to orca `--worktree path:/…` or `active`. This is an orca-specific parameter that a unified schema must either absorb or leave host-optional.
4. **Transport / envelope format — three distinct mechanisms, not three parsers.** herdr = spawned CLI, typed JSON on stdout/stderr. orca = spawned CLI, `--json` on stdout. **cmux = Unix socket** (newline-terminated `{id, method, params}` JSON, `result` on ok / `ok:false` on error). cmux's transport is structurally different: it is **not** a spawned process, so `src/transport.ts` (spawn-based) cannot be reused for it — a socket RPC transport is required. The herdr/orca/cmux JSON shapes are all distinct.
5. **cmux access gating (security-relevant).** cmux's socket has modes: `cmuxOnly` (default — only processes *spawned inside* cmux terminals may connect) / `allowAll` / `off`. Whether an external Pi extension process (spawned by Pi, not by cmux) can reach the cmux socket at all depends on this mode. This is a **hard precondition** for cmux support and must be verified live; the default `cmuxOnly` may block our use case entirely.
6. **Read model.** herdr `agent read --source recent-unwrapped` (lifecycle-aware, strips Pi status-bar wrapping) is unique; orca `terminal read` supports `--screen` (current rendered frame) / `--cursor` (paged stream) / default stripped stream; cmux has no documented read-pane command in the public CLI reference — raw pane read is **unverified**. `subagent_read.raw` semantics differ.

---

## 5. Honest caveats

- **[Documented] orca + cmux command surfaces read in full (2026-10-02)** from the official docs (`onorca.dev/docs/cli/reference`, `cmux.com/docs/api`). orca `terminal create/split/read/send/wait/close` + `worktree list` and the cmux socket `workspace.*`, `surface.*`, `send_text`/`send_key` methods are confirmed. **Still [Unverified]:** live JSON shapes, orca's full `--for` value set (only `tui-idle` is documented), and cmux's `close`/`read-pane` commands (absent from the public CLI reference). A live probe is still required to turn these into [Observed].
- **cmux degrades the wait/prompt contract AND may not be reachable.** cmux has no `wait` and no agent-lifecycle API; `subagent_wait`/`subagent_prompt` would be keystroke-inferred. Worse, cmux's default `cmuxOnly` socket access mode may refuse connections from a Pi-spawned process — a hard precondition to verify before any cmux work.
- **cmux needs a different transport.** The spawn-based `transport.ts` does not cover cmux (Unix socket). A cmux adapter implies a second, socket-based transport — a real architectural addition, not just a CLI-arg mapping.
- **No cross-host pane-id continuity.** `HERDR_PANE_ID` / `CMUX_*` / orca handles are disjoint. Ownership records are per-host, per-session (already the case in `index.ts` via session entries) — good.
- **cmux `close`/`read` unconfirmed.** The public cmux CLI reference documents no pane-close or pane-read command; only `surface.*`, `workspace.*`, send, and sidebar/notification commands. R-3 (read) and R-9 (close) on cmux are therefore **open** until verified live.
- **cmux is macOS-only + GPL native app; orca is VS Code-based.** They are not drop-in on every machine; host selection must be **capability-gated** (binary present + env present), not assumption-gated.
- **Scope:** this is a design investigation. No code has been changed (read-only mode). Implementing adapters is a future, separately-authorized phase.

---

## 6. Verification plan (turn docs into evidence) — read-only, do first

Goal: replace [Inferred] orca/cmux cells with [Observed].

1. **Probe herdr** (baseline sanity, already installed 0.9.3): `herdr pane list`, `herdr workspace list`, `herdr agent list` — confirm envelope shape matches `core.ts` assumptions.
2. **Probe orca** (if installed/reachable): `orca terminal list --json`, `orca terminal show --terminal <h> --json`, `orca terminal wait --for tui-idle --timeout-ms 1 --json`, `orca worktree` listing. Capture exact JSON. Confirm `--worktree` addressing.
3. **Probe cmux** (if installed, macOS only): `cmux list-workspaces`, `cmux list-panels`, `cmux capabilities` (lists socket methods + **current access mode**), `cmux identify`. Socket round-trip `{"id":"x","method":"workspace.list","params":{}}`. **Critical:** confirm the active `CMUX_SOCKET_MODE` and whether a Pi-spawned process can connect at all (`cmuxOnly` may block us). Confirm JSON-over-socket shape and whether any `wait`/`close`/`read`/agent-state method exists (the public CLI reference shows none).
4. **Probe orca** `--for` values: `orca terminal wait --help` to enumerate whether `tui-idle` is the only terminal state or whether `idle/done/blocked`-equivalents exist.
5. **Record findings** in `docs/findings.md` §(new) "Multi-host probes" with [Observed] labels + exact sample outputs (incl. JSON shapes).
6. **Confirm R-8 tool renaming** decision with the user (neutral name vs herdr-vocabulary).

---

## 7. Structured implementation plan (future, not yet authorized)

### Phase A — Adapter seam (design + refactor, herdr-only first)
1. Extract `HostAdapter` interface (§3) from `core.ts`.
2. Move all herdr-specific CLI/envelope/lifecycle logic into `HerdrAdapter`.
3. **Regression gate:** herdr behavior must be byte-identical to today (run existing unit + the R-1..R-10 live gates from `docs/acceptance.md`). *This phase changes zero observable herdr behavior — pure extraction.*

### Phase B — Host detection & dispatch
1. `detectHost()` in `index.ts`: ordered capability check — herdr (`HERDR_PANE_ID` + `herdr` binary) → orca (orca binary + `orca status --json` reachable) → cmux (`cmux` binary + socket present + **access mode allows our process**). Pick the first usable; none ⇒ tools report "no supported multiplexer detected." cmux must additionally pass a `cmux capabilities` access-mode gate, else it is not usable even if the binary exists.
2. R-10 footer generalizes: herdr → `HERDR_PANE_ID`; orca → terminal handle / worktree; cmux → `CMUX_SURFACE_ID`/`CMUX_WORKSPACE_ID` (footer text becomes host-aware).
3. Ownership/session-entry + external-close UI-confirmation stay host-agnostic (they operate on the adapter's pane-id string).
4. **Add a `SocketTransport`** (Unix socket, newline-terminated JSON `{id, method, params}`) alongside the existing spawn-based `HerdrTransport`. cmux is the only socket host; herdr/orca stay spawn-based.

### Phase C — Per-host adapters
5. `OrcaAdapter` (spawn, `--json`): `terminal create/split/read/send/wait/close`, `worktree list` for R-8, `--worktree` mapping, `tui-idle` wait (extend `--for` values only if the Phase-A probe reveals more).
6. `CmuxAdapter` (socket): `surface.split`/`workspace.list`/`surface.list`/`send_text`/`send_key`; **honest degradation** — no `wait`, no agent-lifecycle, `read`/`close` only if the live probe confirms a method; all degradation documented in tool descriptions.
7. Each adapter gets its own envelope/result parser (no shared assumption).

### Phase D — Acceptance (separate per host)
7. Re-run R-1..R-10 live gates **per host** in fresh owned scratch scope; record in `docs/live_verification.md` (host-tagged) and `docs/acceptance.md`.
8. Update `AGENTS.md` phase state + `PROJECT_OVERVIEW.md` to reflect the multi-host scope and per-host acceptance status.

### Sequencing decision needed from the user
- **(a) Unified extension** that auto-detects the host (my lean) vs **(b) three separate thin extensions** sharing a core package. Unified keeps one tool surface + one ownership model but couples the extension to the union of host quirks; separate keeps hosts isolated at the cost of three install units.
- **(c) cmux scope:** include (with honest degradation) or defer (herdr+orca first) — cmux is the highest-effort, lowest-fidelity host.

---

## 8. Open questions for the user

1. **Environment:** are `cmux` and/or `orca` installed on a machine we can probe now? (Determines whether §6 runs today or waits.)
2. **Architecture:** unified auto-detecting extension vs per-host thin extensions? (Recommend unified.)
3. **cmux:** include now with honest wait/prompt degradation, or defer to a later phase? (Recommend defer to Phase C if effort is a concern.)
4. **R-8 naming:** rename `subagent_spaces` to a neutral `subagent_workspaces` (or keep herdr vocabulary)?
5. **Scope of this repo:** is multi-host now in scope, or is this purely an investigation the user wants recorded before deciding? (This doc was written as the investigation record; implementation is Phase A+ and not yet authorized.)
