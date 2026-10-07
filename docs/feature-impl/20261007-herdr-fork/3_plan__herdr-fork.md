# Implementation Plan & Guidance: `/herdr-fork` Preset Command

> **Status:** Guidance / Draft  
> **Requirements Source:** [`2_requirements__herdr-fork.md`](./2_requirements__herdr-fork.md)  
> **Investigation Grounding:** Sub-agent spike report (2026-10-07)

---

## 1. Technical Architecture & Principles

### 1.1 Command Registration (`ExtensionCommandContext`)
- `/herdr-fork` is an interactive user command, not an agent tool.
- Register via `pi.registerCommand("herdr-fork", { description: "Fork active Pi session into a new Herdr pane or tab", handler: ... })` in `src/index.ts` (or delegated via `src/commands/fork.ts`).
- Unlike tool execution (which returns structured tool results), slash commands communicate back via `ctx.ui.notify(...)` and write directly to the user interface.

### 1.2 Session Boundary: Peer Session vs. Managed Worker
- **Critical Distinction:** The spawned Pi process is a **peer interactive user session**, not an owned worker.
- **Do NOT** register the forked pane in `SubagentService` internal ownership records.
- **Do NOT** wrap with `herdr-worker.sh` (no restricted tool allowlists, no subagent role preambles).
- **Do NOT** execute worker rename or cleanup routines on this pane.

### 1.3 Dedicated Fork Launcher Shell Script (`pi-fork-launcher.sh`)
- **Isolation from Subagent Infrastructure:**
  - Create a dedicated, standalone launcher script (e.g. `scripts/pi-fork-launcher.sh` or bundled in extension assets).
  - Explicitly bypasses `herdr-worker.sh`, `pi-worker-runtime.sh`, and any `.sub_agent_conf` parsing.
  - Ensures no worker model selection, no role preambles, and no tool restrictions are injected.
- **Launcher Script Responsibilities:**
  1. Inspect active `PI_CODING_AGENT_DIR` (or `PI_PROFILE` / system `pi-profile`) to preserve the exact parent profile.
  2. Invoke `pi --fork <session-file> [optional initial prompt...]`.
  3. Let `pi --fork` naturally inherit the parent session's model and settings directly from the session file without any external model override.
- **Invocation from Herdr:**
  - `herdr pane run <newPane> "<launcher-script-path> <sessionFile> [escaped-instruction]"`

---

## 2. Parameter Parsing Guidance

Given raw input string `args` passed to the command handler:

1. **Quote Protection:**
   - If the trimmed input starts with quotes (e.g. `"/herdr-fork \"down the road is a bug\""`), treat the entire unquoted content as `instruction`, defaulting `placement` to `right`.
2. **Keyword Match:**
   - Tokenize the first word.
   - If first token is `right`, `down`, or `tab` (case-insensitive):
     - `placement` = matched keyword
     - `instruction` = remaining string (trimmed)
   - Otherwise:
     - `placement` = `right` (default)
     - `instruction` = entire string (trimmed)

---

## 3. Edge Cases & Resilience Checks

1. **In-Memory / Unflushed Session:**
   - Before executing split/run, verify `ctx.sessionManager.getSessionFile()`.
   - If `undefined` or file does not exist on disk (e.g. empty turn session), abort before pane creation and notify user:
     - `ctx.ui.notify("No active conversation to fork yet.", { type: "warning" })`.
2. **Current Pane & Workspace Context:**
   - Retrieve current pane ID via `herdr pane current` or existing client helpers.
   - Fall back gracefully if run outside of an active Herdr terminal environment.
3. **Failure Handling (Clean State):**
   - If `herdr pane split` or `herdr tab create` fails, report error via `ctx.ui.notify`.
   - Ensure parent session and terminal remain intact and uninterrupted.

---

## 4. Phased Implementation Roadmap

- [ ] **Phase 1: Command Parser & Unit Tests**
  - Implement parsing logic (`parseForkArgs(input: string) -> { placement: 'right'|'down'|'tab', instruction?: string }`).
  - Unit tests covering default, explicit placement, positional prompt, quotes escaping, and whitespace handling.
- [ ] **Phase 2: Herdr Process Runner Integration**
  - Add client helper for `pane split` and `tab create` returning target pane ID.
  - Implement command launcher invoking `pi --fork <sessionFile> [instruction]`.
- [ ] **Phase 3: Slash Command Handler Wiring**
  - Wire `pi.registerCommand("herdr-fork", ...)` in `src/index.ts`.
  - Handle session file resolution, validation, notifications, and focus handover.
- [ ] **Phase 4: Live Verification & Acceptance**
  - Verify vertical split (`right`), horizontal split (`down`), and new tab (`tab`).
  - Verify context continuity and prompt forwarding.
