# pi-subagent-herdr

Native Pi extension tools for safe Herdr sub-agent supervision. Replaces the
bash-script-heavy `sub-agent-herdr` skill workflow with first-class Pi tools.

**Status:** 0.2.0 ergonomic contract implemented; unit test suite passes (count is not a contract).
Registered-tool lifecycle evidence is recorded; busy steering and timeout behaviour
remain unit-covered but not verified live. Human testing follows the GitHub update.
Automated acceptance is recorded in
[`docs/ergonomic_acceptance.md`](docs/ergonomic_acceptance.md); historical native
evidence is indexed in [`docs/live_verification.md`](docs/live_verification.md). Terminal state is not task completion.

## 0.1.x → 0.2.0 Breaking Migration

Version 0.2.0 is a **breaking** migration. Legacy 0.1.x parameters are rejected
with precise migration hints (no silent fallbacks). Key changes:

| 0.1.x | 0.2.0 | Rationale |
|---|---|---|
| `target` (all tools) | `pane` (all tools) | Sole caller-facing address; no `pane_id` |
| `task` (prompt) | `prompt` | Name reflects the field's role |
| `waitMode` (none/bounded/finish) | `wait` (boolean) | Simplified; start defaults false, prompt defaults true |
| `tailChars` | `maxChars` | Consistent with `returnLines` |
| `lines` (read) | `returnLines` | Consistent naming |
| `raw` (read) | `source: "raw"` | Explicit source selection |
| `continuation` (wait) | *(removed)* | Internal pending context only; no public cursor |
| `allowExternal` / `externalConfirmed` | *(removed)* | Ownership is informational only; no control gates |
| `start.timeoutMs` (60 min default) | `start.timeoutMs` (30 min default) | Bounded wait phase; detection is a separate 15 s budget |
| `prompt.timeoutMs` (60 min default) | `prompt.timeoutMs` (30 min default) | Bounded wait phase |
| `wait.timeoutMs` (30 min default) | `wait.timeoutMs` (30 min default) | Bounded wait phase |

Legacy fields are rejected by the core before any action, with a hint naming
the 0.2.0 replacement. The old acknowledgement flags are accepted but ignored. See `docs/tool_usage_review.md` for the full field map.

## What it does

Registers nine `subagent_*` tools (R-1 through R-9 in `REQUIREMENTS.md`) plus a
session footer showing the current Herdr pane id (R-10) when Pi runs inside a
Herdr pane in TUI mode.

| Tool | Purpose |
|---|---|
| `subagent_start` | Launch a new worker pane, detect the agent, rename it, deliver the task via `agent prompt` |
| `subagent_prompt` | Submit a task to an existing worker (pane addressing; busy allowed, blocked = not_sent) |
| `subagent_read` | Read recent console content (`source`: auto/agent/raw) |
| `subagent_wait` | Wait for one pane, or multiple panes with explicit `until: "first" / "all"`; two-tier freshness |
| `subagent_send` | Send a single line of raw terminal text + Enter (no console by default) |
| `subagent_interrupt` | Abort the current turn with Escape (never ctrl+d) |
| `subagent_list` | List panes (current workspace by default; `workspace: "all"` for cross-workspace) |
| `subagent_spaces` | List all Herdr workspaces |
| `subagent_close` | Close a pane (idempotent; verified absence) |

**Pane is the sole caller-facing address.** All tools address panes by `pane`
id (e.g. `w2V:p1`). No `pane_id`, no `target`, no `continuation`, no `receipt`
handles are exposed to the model.

## Multi-pane waiting

Single-pane arguments remain unchanged. For multiple panes, explicitly choose a mode:

```json
{"panes":["wX:p2","wX:p3"],"until":"first","timeoutMs":10000}
```

Use exactly one of `pane` or nonempty, unique `panes`; multi-pane calls require
`until`. `first` selects the first eligible terminal observation, not globally first
finished task; stale snapshots cannot win. `all` collects per-pane observations,
including labelled snapshots/errors, with explicit pending panes at one shared
deadline. Neither mode proves task success. Cancellation/first-winner cleanup reaps
local monitors only, never remote workers. First includes winner console only; all
has per-pane console caps. For positive `maxChars`, aggregate console text is bounded
by `maxChars` for first or `panes.length × maxChars` for all; `maxChars:0` disables
character clipping. See [contract, evidence and limits](docs/multi_pane_wait.md).

## Installation

### Install from GitHub

```bash
pi install git:github.com/cgint/pi-subagent-herdr
```

For an existing installation:

```bash
pi update git:github.com/cgint/pi-subagent-herdr
```

Restart Pi and any running controllers/workers to load the new schemas. Updating
files does not replace tools already loaded in those processes. For a local
checkout, use `git pull --ff-only`, `npm ci`, then restart Pi.

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

The `pi` key in `package.json` declares the extension entry and its bundled skills:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"],
    "skills": ["./skills/subagent-firstmate", "./skills/subagent-pairing", "./skills/subagent-handoff", "./skills/subagent-herdr-supervision", "./skills/subagent-bootstrap-pairing-memory"]
  }
}
```

The package serves five subagent-scoped skills:

- `subagent-firstmate`: sustained subagent-work strategy, integration, and acceptance;
- `subagent-pairing`: grounded subagent collaboration and durable repository memory;
- `subagent-handoff`: bounded subagent assignments and compact evidence reports;
- `subagent-herdr-supervision`: native `subagent_*` Herdr worker lifecycle operations;
- `subagent-bootstrap-pairing-memory`: explicit-only initialization of subagent collaboration memory.

The `subagent-` prefix keeps these public skills distinct from generic collaboration skills. `herdr` appears only in `subagent-herdr-supervision`, whose responsibility is specifically Herdr pane lifecycle control. The external runtime lookup still uses its installed legacy `sub-agent-herdr-supervisor` directory; that compatibility dependency is distinct from the public `subagent-herdr-supervision` skill.

## Dependencies / profile / runtime configuration

Use Node.js 22.19 or newer. Host SDK/pi-ai/TypeBox are wildcard peers (`*`),
never bundled runtime dependencies. `npm ci` uses exact local development
pins 1.0.0/1.0.0/1.3.27; this does not claim every wildcard host version was
tested. The extension also needs the Herdr CLI (`herdr`) on `PATH` and the
worker runtime scripts directory (containing `herdr-worker.sh`). The runtime
directory is resolved with this precedence:

1. **CLI flag** `--subagent-herdr-runtime-dir <path>` (registered by the extension)
2. **Environment** `PI_SUBAGENT_RUNTIME_DIR=<path>`
3. **Profile discovery** `~/.pi/profiles/<profile>/agent/skills/sub-agent-herdr-supervisor/scripts`

The supervisor must run inside a Herdr pane: `HERDR_PANE_ID` must be set in the
environment. Without it, `subagent_start` and `subagent_list` fail with
`herdr_context_missing`.

No additional config file is required.

## Safety and timeout semantics

- **Delivery is not completion.** A successful `agent prompt` submission is a
  transport receipt, not proof the worker accepted or finished the task.
  `wait=false` returns `submitted`; `wait=true` returns a terminal-state
  observation (`terminal_observed`) or `needs_attention` (blocked), never a
  task-completion claim.
- **Two-tier freshness.** Tier 1 (`terminal_seen_during_submission`): a terminal
  receipt is newer than the pre-submit baseline, and a fresh lookup confirms
  that same terminal sequence. Tier 2 (`state_changed_after_submission`): a
  terminal state must be newer than the receipt baseline. A working state
  never settles a wait. Already-consumed observations become snapshots.
  Pending submission context is memory-only and is lost on reload/restart.
- **Active console snapshots:** Herdr cannot scroll deep alternate-screen
  history while a worker is working. For its typed `agent_not_idle` condition,
  reads use the visible viewport; idle reads retain recent unwrapped history.
  Unrelated read failures are not hidden in bounded prompt results.
- **Timeouts are bounded.** Defaults: detection 15 s, start/prompt/wait
  timeoutMs 30 min. Hard ceiling 60 min. No infinite polling.
- **Cancellation is safe.** Aborting a tool call reaps only the local Herdr CLI
  process; it never interrupts or closes the worker pane.
- **Self-target denied.** The supervisor cannot send/interrupt/close/prompt
  itself.
- **Ownership is informational only.** `owned` in results is informational; it
  does not gate control operations. External panes can be prompted, waited on,
  read, sent to, interrupted, and closed without opt-in flags. Self-target
  close is denied (the supervisor cannot close its own pane).
- **Close is idempotent with verified absence.** Close terminates the process
  inside the pane. Absence is verified with a typed `pane_not_found` before
  reporting success; `verifiedAbsent: true` in the result confirms this.
- **Ownership persists across reload/resume of the same Pi session.** Pane
  ownership records are stored in session entries (`pi.appendEntry`) keyed by
  the Pi session ID. New and forked sessions inherit nothing; records from a
  different Pi session are filtered out even when in the same HERDR pane.
  Persisted ownership is provenance, not control authority. Stale pending
  identity is discarded; an explicit pane call observes the current occupant.

### Numeric parameter bounds (honest defaults)

| Parameter | Type | Min | Max | Default |
|---|---|---|---|---|
| `start.timeoutMs` / `prompt.timeoutMs` / `wait.timeoutMs` | integer | 1 | 3 600 000 (60 min) | 1 800 000 (30 min) |
| `returnLines` (start/prompt/read/wait/send) | integer | 0 | 500 | 100 (0 for send) |
| `maxChars` (start/prompt/read/wait/send) | integer | 0 | 50 000 | 8 000 |

`returnLines=0` disables console capture. `maxChars=0` disables the character
cap (the line selection and transport ceiling still apply). Read status is a
separately sampled observation, not an atomic snapshot with the console.

## No task-acceptance claims

A terminal state (`idle` or `done`) is **not** task completion. The extension
returns `terminal_observed` and hints the model to verify task-specific output.
A `blocked` state is reported as `needs_attention` (often a write-guard success
in read-only mode), never as success. A timeout or stalled result includes the
current console tail so the supervisor can inspect before re-waiting.

## Requirements coverage (R-1 through R-10)

| Req | Tool | Notes |
|---|---|---|
| R-1 | `subagent_start` | read-only / editable mode; pane addressing |
| R-2 | `subagent_start` / `subagent_prompt` | `wait` boolean; `returnLines`/`maxChars` |
| R-3 | `subagent_read` | `returnLines` default 100, `maxChars` tail limit, `source` auto/agent/raw |
| R-4 | `subagent_wait` | terminal-state wait; two-tier freshness; no continuation |
| R-5 | `subagent_send` | single-line raw text + Enter; no console by default; multi-line rejected |
| R-6 | `subagent_interrupt` | Escape only; ctrl+d never used |
| R-7 | `subagent_list` | current workspace by default; `workspace: "all"` for cross-workspace |
| R-8 | `subagent_spaces` | all workspaces |
| R-9 | `subagent_close` | idempotent; verified absence; self-close denied |
| R-10 | footer | `ctx.ui.setStatus` in TUI when `HERDR_PANE_ID` is set |

## Known limitations

- Console tails are raw terminal snapshot suffixes (code points), not extracted
  assistant answers. They can contain TUI footer/padding rather than task
  output; request a larger `subagent_read` and verify the actual task result.
- **Multi-line `subagent_send`** is rejected (behaviour unverified in Herdr
  0.9.3). Send one line at a time.
- **Tool-name collision** with `pi-herdr` if both extensions load is unknown
  until tested in a live session.
- **Installed readonly inline-brief bug:** pure parser checks confirm
  positional briefs after `--dm-read` are swallowed on Pi 0.99.1 and 1.0.0.
  Installed scripts remain unchanged; this extension delivers tasks only after
  detection via agent prompt.
- **Destination launch:** `start.workspace` accepts the current workspace.
  A different destination is rejected before pane creation; cross-workspace
  launch is not implemented. Listing other workspaces remains supported.
- **Live correlation** depends on CLI identity and sequence metadata. Missing
  metadata and external submissions limit task attribution; current pane
  snapshots never prove task completion.
- **External submissions** (from outside the extension) remain a documented
  correlation limit; the pending context is memory-only and does not
  serialise concurrent submissions to the same target.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # build to .test-build + node --test
npm run check       # typecheck + test
```

Tests use bounded `node:test` runs with fake transports and a fake
`ExtensionAPI`. Registration tests inject services directly; integration tests
exercise the real core, persisted-session isolation, and strict flag ordering.
CLI fixtures are pinned to recorded Herdr envelopes. Unit tests alone are not
live acceptance; see `docs/acceptance.md` and `docs/live_verification.md`.

## npm audit

`npm audit` reports a high-severity transitive `brace-expansion` vulnerability
pinned by the Pi host SDK's shrinkwrap through minimatch—not TypeScript.
The host's glob handling retains a denial-of-service risk; the extension does
not expose that code path. Standard non-force mitigation did not change the
pin. The Firstmate's explicit risk acceptance and upgrade criteria are in
[`docs/security.md`](docs/security.md); no audit suppression or host override
is used. Host modules are wildcard peers; no host library is bundled as an
executable dependency.

## Package scope

`private: true` is intentional. This package is not published to npm; it is
loaded locally or installed from a git/local path via `pi install`.

## Tested environments and use

Initial registration/footer controls used Pi 0.99.1/Herdr 0.9.3. Resumed
native lifecycle, final production/package smoke used Pi 1.0.0/Herdr 0.9.3,
Node 22.23.3 and TypeBox 1.3.27. See the evidence doc for exact scope.

Example `subagent_start` arguments:
```json
{"name":"scout","cwd":"/absolute/project/path","mode":"readonly","task":"Inspect the tests and report findings; no writes.","wait":false,"returnLines":50,"maxChars":2000}
```
For a bounded progress window use `wait:true, timeoutMs:10000`; inspect the
returned console and re-wait by `pane` without resending on timeout.

Names are lowercase `[a-z0-9][a-z0-9_-]{0,31}`. Errors such as
runtime_missing/herdr_context_missing require fixing dependencies;
timeout/stalled means inspect, not resend; unexpected_wait_state means CLI
reported a non-terminal state, not completion.

A separate selected-model fixture looped 348 pwd calls; honest timeout and
Escape recovery are evidenced, not hidden. Multiline remains rejected. Genuine
sibling co-loading was unavailable/unverified. Current host SDK retains one
high-severity brace-expansion audit finding (explicit risk decision in
docs/security.md).
