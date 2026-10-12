# Feature Requirements: `/herdr-reloc-tab` Preset Command

## 1. Objective & Purpose
Enable a user working in a Pi session inside Herdr to relocate their **active, running** session to a fresh tab with a single slash command (`/herdr-reloc-tab`). The user's current manual workflow (create new tab → run `pi --session <file>` in the new pane → close the old pane) is cumbersome; this command automates exactly that, with no PTY-relocation hazard.

---

## 2. User Experience & Command Syntax

### Command Invocation
```text
/herdr-reloc-tab
```

**No arguments. No options. No placement keyword. No `keep` flag.**

One gesture: "reloc me to a new tab."

### Why this shape (vs. `/herdr-fork`)
- `/herdr-fork` spawns a **branch** (independent copy) and accepts placement + instruction because the user is choosing where the *new* branch lands and what to tell it.
- `/herdr-reloc-tab` **relocates the existing session** — there is no branch, no placement choice (always a new tab), and no instruction to forward (the session already has all its history). The command is a fixed 4-step choreography, not a parameterized layout tool.

---

## 3. Behavioral Requirements

### 3.1 The Four Steps (Exact Choreography)
1. **Resolve the active session file.**
   - Source: `ctx.sessionManager.getSessionFile()`.
   - If undefined, blank, or the file does not exist on disk → abort with a warning notification; nothing is created.
2. **Create a new tab** in the current workspace.
   - `herdr tab create --workspace <wsId> --cwd <cwd> --env PI_CODING_AGENT_DIR=<dir> --focus`
   - Returns `{ tab: { tab_id }, root_pane: { pane_id } }`.
   - The `--env PI_CODING_AGENT_DIR` carries the parent's exact profile directory (profile parity), using the same mechanism as `/herdr-fork`.
   - `--focus` moves TUI focus to the new tab immediately.
3. **Resume the session in the new tab's root pane.**
   - Execute the dedicated `pi-reloc-launcher.sh` via `herdr pane run <newPane> "<launcher> --session-file <abs-path>"`.
   - The launcher `exec`s `pi --session <session-file>` — a **Pi-native resume**, not a fork. The session continues where it left off.
   - The new `pi` process gets a **fresh `HERDR_PANE_ID`** (the new pane's id), so no stale-env-var issue.
4. **Close the original pane** (the one the Pi process is running in).
   - `herdr pane close <originalPaneId>`.
   - The original pane's PTY is terminated. The new tab already holds the live, resumed session.
   - **⚠ Unverified critical assumption:** The Pi process that issued the command is a child of the original pane's PTY. The `herdr pane close` CLI call is a child of the Pi process. When Herdr closes the pane, it kills the PTY, which kills the shell, which kills the `herdr` CLI child — **possibly before the JSON response is written to stdout**. In that case, the transport's `await` hangs (up to the 60 s timeout) or receives a truncated/empty response, and the `ctx.ui.notify` confirmation **never fires**. The user sees the old tab vanish and the new tab appear, with no feedback. This is the **guaranteed** outcome if Herdr kills the PTY synchronously; it is only safe if Herdr delivers the CLI response before killing the PTY. **This must be verified by a live probe before implementation is considered complete.**
   - **Architectural note:** The subagent core (`core.ts`) has a hard `isSelf` guard: `"supervisor cannot close itself (its own process owns this pane)"`. This reloc command deliberately departs from that principle — the Pi process *does* close its own pane. This is justified because the session has already been resumed in the new tab (the close is a cleanup step, not a control action), but the departure must be documented and the silent-failure mode (above) accepted as a known risk.

### 3.2 Session Continuity
- The resumed session is the **same** session (not a fork). All conversation history, tool state, and context carry over.
- The old pane is closed; the new pane is the sole host of that session going forward.
- **Independence:** there is no "parent" and "child" — the session *moves*. After the reloc, the original pane no longer exists.

### 3.3 Configuration & Profile Parity
- The new tab's root pane receives `PI_CODING_AGENT_DIR` via `herdr tab create --env` (same as fork), so the resumed `pi` runs with the parent's exact active profile.
- The launcher (`pi-reloc-launcher.sh`) is a **dedicated, standalone script** that:
  - relies on `PI_CODING_AGENT_DIR` being **already in the process environment** (set by `herdr tab create --env` in step 2); `exec` inherits the environment verbatim — no re-export, no default injection. If the variable is absent, the `pi` process inherits the Herdr default.
  - `exec`s `pi --session <session-file>` directly,
  - never sources the worker runtime, contains no `.sub_agent_conf` parsing, no role preambles, no model override, no tool restrictions.
- The launcher is **decoupled from the subagent worker launchers** (same isolation principle as `pi-fork-launcher.sh`).

### 3.4 Visual & Focus Feedback
- Focus transfers to the new tab immediately (`--focus` on `tab create`).
- The user sees the new tab with the resumed Pi session, ready for input.
- The original tab/pane disappears (closed).
- A non-intrusive confirmation notification: `herdr-reloc-tab: session relocated to tab <tabId>; original pane closed.`

### 3.5 Failure Handling (Clean State)
- **No session file:** abort before any Herdr call; warning notification; parent session untouched.
- **Outside Herdr:** `HERDR_PANE_ID` unset → abort; warning; nothing created.
- **Tab create fails:** error notification with the Herdr error code/message; the original pane is untouched (no close issued).
- **`pane run` fails:** error notification; the new tab exists but has no resumed session; the original pane is **not** closed (the user still has their live session). The orphaned empty tab is left for manual cleanup (or a follow-up `herdr tab close`).
- **`pane close` fails (graceful):** the session is already resumed in the new tab; the error is reported but the reloc is considered successful (the goal — a live session in a new tab — was achieved). The stale original pane remains for manual cleanup.
- **`pane close` kills the Pi process before the response (silent failure):** the old tab vanishes, the new tab has the resumed session, but **no notification fires** (the Pi process is dead). The user must verify manually that the new tab has a live, typeable Pi session. This is the primary risk of step 4; see §3.1 step 4 for the mechanism.

---

## 4. Acceptance Criteria

1. **Single Command:** Running `/herdr-reloc-tab` (no args) performs all four steps and leaves the user in a new tab with the resumed session; the original pane is closed.
2. **Session Continuity:** The resumed session has the full conversation history of the original; the user can continue typing as if nothing happened (minus the cold-start of `pi`).
3. **Profile Parity:** The resumed `pi` runs with the parent's exact `PI_CODING_AGENT_DIR` (verified by checking the new pane's environment or the Pi status line).
4. **No Fork:** The session file is opened with `--session` (resume), **not** `--fork` (branch). The new pane's session is the *same* session, not a copy.
5. **Fresh Pane ID:** The resumed `pi` process has a `HERDR_PANE_ID` matching the new pane (not the old one).
6. **Original Pane Closed:** After a successful reloc, `herdr pane get <originalPaneId>` reports the pane as closed/absent.
7. **Failure Isolation:** If any step fails, the original session is never left in a broken state:
   - tab create fails → original pane untouched
   - pane run fails → original pane untouched (no close issued)
   - pane close fails (graceful) → session is live in the new tab (reloc succeeds, stale pane reported)
8. **No Worker Contamination:** The new pane does not load the subagent worker runtime; no `.sub_agent_conf`, no role preamble, no tool allowlist.
9. **Notification (when it fires):** A single confirmation (or error) notification is shown; no verbose output. **Caveat:** if step 4 kills the Pi process before the response, no notification fires — the user must verify the new tab manually (see AC 10).
10. **Human Verification (Phase 4, mandatory):** After `/herdr-reloc-tab`, a human confirms: (a) the old tab is gone, (b) the new tab has a live, typeable Pi session with full conversation history, (c) typing a message in the new tab continues the conversation (not a fresh session). This is the **only** acceptance test that catches the silent-failure mode of step 4.

---

## 5. Pre-Implementation Verification Gate

Before writing any implementation code, verify:

1. **`pi --session <file>` resumes-and-continues** (not read-only, not a fork prompt).
   - *How:* In a scratch Herdr pane, run `pi --session <path-to-a-test-session-file>`. Type a message. Confirm the conversation continues (the new `pi` sees the prior history).
   - *If it reopens read-only or prompts for a fork:* the entire feature design changes (would need `--fork` or a different mechanism). **Stop and re-scope.**
2. **`herdr pane close <id>` on a pane with a running PTY: does the CLI response arrive before the PTY is killed?**
   - *How:* In a scratch Herdr pane, run a long-lived process (e.g. `sleep 300`), then from another pane run `herdr pane close <id>`. Observe whether the CLI returns a JSON envelope before or after the PTY dies.
   - *If the response is lost:* step 4's silent-failure mode is confirmed. The feature still works (the session is in the new tab), but the user gets no confirmation. This is acceptable but must be documented.
   - *If the response arrives:* the confirmation notification fires, and step 4 is safe as designed.

---

## 6. Explicit Non-Goals

- **No placement options:** always a new tab. (If split-right/down is wanted later, that is a separate feature — `/herdr-reloc` with placement, mirroring fork.)
- **No `keep` flag:** the original pane is always closed. (A safety-first variant can be added later as a flag.)
- **No instruction forwarding:** the session resumes as-is; there is nothing new to tell it.
- **No PTY relocation:** this feature does **not** use `herdr pane move`. It uses the resume-and-close pattern, which is architecturally safer (no competing writer to the PTY being moved, no stale-env-var issue, Pi-native resume path).
- **No upstream Herdr TUI keybinding:** this is a Pi extension command, not a Herdr config.toml binding or a first-party Herdr feature (discussion #1674 is the upstream venue for that).
