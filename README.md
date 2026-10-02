# pi-subagent-herdr

Native Pi extension tools for safe Herdr sub-agent supervision. Replaces the
bash-script-heavy `sub-agent-herdr` skill workflow with first-class Pi tools.

**Status:** verified first-version functional gates; evidence and limits are in
[`docs/live_verification.md`](docs/live_verification.md). Terminal state is not task completion.

## What it does

Registers nine `subagent_*` tools (R-1 through R-9 in `REQUIREMENTS.md`) plus a
session footer showing the current Herdr pane id (R-10) when Pi runs inside a
Herdr pane in TUI mode.

| Tool | Purpose |
|---|---|
| `subagent_start` | Launch a new worker pane, detect the agent, rename it, deliver the task via `agent prompt` |
| `subagent_prompt` | Submit a task to an existing worker (serialised per target, refuses working/blocked) |
| `subagent_read` | Read recent console content (lifecycle-aware agent read; `raw` for raw terminal read) |
| `subagent_wait` | Wait for a terminal agent state (idle/done/blocked); continuation-aware |
| `subagent_send` | Send a single line of raw terminal text + Enter to another pane |
| `subagent_interrupt` | Abort the current turn with Escape (never ctrl+d) |
| `subagent_list` | List panes in the current workspace with names and agent status |
| `subagent_spaces` | List all Herdr workspaces |
| `subagent_close` | Close a pane (idempotent; external panes require UI confirmation) |

## Installation

### Local development (this repo)

```bash
npm ci
pi --extension ./src/index.ts
```

Pi loads TypeScript extensions directly via `jiti`; no build step is needed for
local loading.

### As a Pi package

```bash
pi install ./pi-subagent-herdr
```

The `pi` key in `package.json` declares the extension entry:

```json
{
  "pi": { "extensions": ["./src/index.ts"] }
}
```

## Dependencies / profile / runtime configuration

Use Node.js22.19 or newer. Host SDK/pi-ai/TypeBox are wildcard peers (`*`),
never bundled runtime dependencies. `npm ci` uses exact local development
pins1.0.0/1.0.0/1.3.27; this does not claim every wildcard host version was tested.
The extension also needs the Herdr CLI (`herdr`) on `PATH` and the worker runtime
scripts directory (containing `herdr-worker.sh`). The runtime directory is
resolved with this precedence:

1. **CLI flag** `--subagent-herdr-runtime-dir <path>` (registered by the extension)
2. **Environment** `PI_SUBAGENT_RUNTIME_DIR=<path>`
3. **Profile discovery** `~/.pi/profiles/<profile>/agent/skills/sub-agent-herdr-supervisor/scripts`

The supervisor must run inside a Herdr pane: `HERDR_PANE_ID` must be set in the
environment. Without it, `subagent_start` and `subagent_list` fail with
`herdr_context_missing`.

No additional config file is required in v1.

## Safety and timeout semantics

- **Delivery is not completion.** A successful `agent prompt` submission is a
  transport receipt, not proof the worker accepted or finished the task.
  `waitMode=none` returns `submitted`; `bounded`/`finish` return a terminal-state
  observation (`terminal_observed`) or `needs_attention` (blocked), never a
  task-completion claim.
- **Active console snapshots:** Herdr cannot scroll deep alternate-screen history while a worker is working. For its typed `agent_not_idle` condition, reads use the visible viewport; idle reads retain recent unwrapped history. Unrelated read failures are not hidden in bounded prompt results.
- **Timeouts are bounded.** Defaults: detection 15 s, bounded wait 30 s,
  finish/wait 30 min, hard ceiling 60 min. No infinite polling.
- **Cancellation is safe.** Aborting a tool call reaps only the local Herdr CLI
  process; it never interrupts or closes the worker pane.
- **Self-target denied.** The supervisor cannot send/interrupt/close/prompt
  itself.
- **External targets require opt-in.** `subagent_send` / `subagent_interrupt` /
  `subagent_wait` on a non-owned pane require `allowExternal: true`
  (acknowledgement only, not user authorisation) and are restricted to the
  current workspace.
- **External close requires real UI confirmation.** `subagent_close` on a
  non-owned pane triggers `ctx.ui.confirm()`. Without UI (RPC/JSON mode) the
  close is denied. The close schema does not expose an `externalConfirmed`
  parameter; any model-supplied flag is stripped before the core call.
- **Ownership persists across reload/resume of the same Pi session.** Pane
  ownership records are stored in session entries (`pi.appendEntry`) keyed by
  the Pi session ID (`ctx.sessionManager.getSessionId()`). New and forked
  sessions inherit nothing; records from a different Pi session are filtered
  out even when in the same HERDR pane. Live identity (workspace, terminal id,
  agent name) is verified before any control operation.
- **Continuation is an opaque server-owned ID.** The `continuation` field in
  results is an opaque string handle. Pass it verbatim to `subagent_wait`
  to resume the same turn. Do not inspect, forge, or derive fields from it.
  The schema does not expose `working_observed` or any caller-visible truth
  beyond the opaque ID.

### Numeric parameter bounds (honest defaults)

| Parameter | Type | Min | Max | Default |
|---|---|---|---|---|
| `start.timeoutMs` / `prompt.timeoutMs` / `wait.timeoutMs` | integer | 1 | 3 600 000 (60 min) | 60 min / 60 min / 30 min |
| `start.tailChars` / `prompt.tailChars` | integer | 1 | 2000 | 50 (bounded) |
| `wait.tailChars` | integer | 1 | 2000 | 2000 |
| `read.lines` | integer | 1 | 500 | 100 |
| `read.maxChars` | integer | 1 | 50000 | 2000 |

## No task-acceptance claims

A terminal state (`idle` or `done`) is **not** task completion. The extension
returns `terminal_observed` or `terminal_observed_after_working` and hints the
model to verify task-specific output. A `blocked` state is reported as
`needs_attention` (often a write-guard success in read-only mode), never as
success. A timeout or stalled result includes the current console tail so the
supervisor can inspect before re-waiting.

## Requirements coverage (R-1 through R-10)

| Req | Tool | Notes |
|---|---|---|
| R-1 | `subagent_start` | read-only / editable mode |
| R-2 | `subagent_start` / `subagent_prompt` | `waitMode` none/bounded/finish; `tailChars` default 50 |
| R-3 | `subagent_read` | `lines` default 100, `maxChars` tail limit |
| R-4 | `subagent_wait` | terminal-state wait; continuation for working evidence |
| R-5 | `subagent_send` | single-line raw text + Enter; multi-line rejected (unverified in herdr 0.9.3) |
| R-6 | `subagent_interrupt` | Escape only; ctrl+d never used |
| R-7 | `subagent_list` | current workspace panes with names and agent status |
| R-8 | `subagent_spaces` | all workspaces |
| R-9 | `subagent_close` | idempotent; external close needs UI confirmation |
| R-10 | footer | `ctx.ui.setStatus` in TUI when `HERDR_PANE_ID` is set |

## Known limitations

- Console tails are raw terminal snapshot suffixes (code points), not extracted assistant answers. They can contain TUI footer/padding rather than task output; request a larger `subagent_read` and verify the actual task result.

- **Multi-line `subagent_send`** is rejected (behaviour unverified in Herdr
  0.9.3). Send one line at a time.
- **Tool-name collision** with `pi-herdr` if both extensions load is unknown
  until tested in a live session.
- **Installed readonly inline-brief bug:** pure parser checks confirm positional
  briefs after `--dm-read` are swallowed on Pi0.99.1 and1.0.0. Installed scripts
  remain unchanged; this extension delivers tasks only after detection via agent prompt.
- **Live-identity verification** depends on the Herdr CLI supplying stable
  terminal ids and agent names; if the CLI cannot supply adequate identity,
  ownership control is denied or requires the explicit external-target path;
  it is never inferred from a reused pane ID.
- **External submissions** (from outside the extension) remain a documented
  correlation limit; the extension serialises its own submissions per target.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # build to .test-build + node --test
npm run check       # typecheck + test
```

Tests use bounded `node:test` runs with fake transports and a fake
`ExtensionAPI`. Registration tests inject services directly; integration tests
exercise the real core, persisted-session isolation, and strict flag ordering.
CLI fixtures are pinned to recorded Herdr envelopes. Unit tests alone are not live
acceptance; see `docs/acceptance.md` and `docs/live_verification.md`.

## npm audit

`npm audit` reports a high-severity transitive `brace-expansion` vulnerability
pinned by the Pi host SDK's shrinkwrap through minimatch—not TypeScript.
The host's glob handling retains a denial-of-service risk; the extension does
not expose that code path. Standard non-force mitigation did not change the
pin. The Firstmate's explicit risk acceptance and upgrade criteria are in
[`docs/security.md`](docs/security.md); no audit suppression or host override
is used. Host modules are wildcard peers; no host library is bundled as an executable dependency.

## Package scope

`private: true` is intentional. This package is not published to npm; it is
loaded locally or installed from a git/local path via `pi install`.

## Tested environments and use

Initial registration/footer controls used Pi0.99.1/Herdr0.9.3. Resumed native lifecycle, final production/package smoke used Pi1.0.0/Herdr0.9.3, Node22.23.3 and TypeBox1.3.27. See the evidence doc for exact scope.

Example `subagent_start` arguments:
```json
{"name":"scout","cwd":"/absolute/project/path","mode":"readonly","task":"Inspect the tests and report findings; no writes.","waitMode":"bounded","timeoutMs":10000,"tailChars":50}
```
Pass a returned continuation verbatim to `subagent_wait`; inspect larger `subagent_read` output/result artifacts before accepting work. Names are lowercase `[a-z0-9][a-z0-9_-]{0,31}`. Errors such as runtime_missing/herdr_context_missing require fixing dependencies; timeout/stalled means inspect, not resend; unexpected_wait_state means CLI reported a nonterminal state, not completion.

A separate selected-model fixture looped348 pwd calls; honest timeout and Escape recovery are evidenced, not hidden. Multiline remains rejected. Genuine sibling co-loading was unavailable/unverified. Current host SDK retains one high-severity brace-expansion audit finding (explicit risk decision in docs/security.md).
