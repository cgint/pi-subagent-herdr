# Worker 2 Report — Specs, Scripts & Pi Extension Patterns

**Identity chain:** Horst (lead) → Judith (coordinator) → Clara (code scout)
**Mode:** editable (report-only writes)
**Scope:** Read-only analysis of the `sub-agent-herdr-supervisor` launcher scripts, the
sibling `pi-herdr` / `pi-supervisor` / `pi-mini-self-org` extensions, and the Pi
extension API. All paths below are absolute; line numbers refer to the files as of
this analysis.

Classification key: **[Documented]** = read directly from source; **[Inferred]** =
derived from observed behavior, not explicitly stated.

---

## 1. The Scripts as Specification

Files analyzed:

- `/Users/christian.gintenreiter/.pi/profiles/minimal/agent/skills/sub-agent-herdr-supervisor/scripts/herdr-start-subagent.sh`
- `/Users/christian.gintenreiter/.pi/profiles/minimal/agent/skills/sub-agent-herdr-supervisor/scripts/herdr-worker.sh`
- `/Users/christian.gintenreiter/.pi/profiles/minimal/agent/skills/sub-agent-herdr-supervisor/scripts/pi-worker-runtime.sh`
- `/Users/christian.gintenreiter/.pi/profiles/minimal/agent/skills/sub-agent-herdr-supervisor/scripts/test_worker_launchers.sh`

### 1.1 Two-layer architecture [Documented]

- `herdr-start-subagent.sh` (the **launcher**) — runs *inside* the supervisor's own
  Herdr pane. It validates arguments, splits a new non-focused sibling pane, submits
  the wrapper command via `herdr pane run`, polls for agent detection, renames the
  agent, and emits **one JSON object on stdout** (`jq -cn` at the end of the script).
- `herdr-worker.sh` (the **wrapper**) — runs *inside* the new pane. It is a small
  shim that sources `pi-worker-runtime.sh` and calls
  `pi_worker_runtime_main "$HERDR_REPORTER" "$@"`, passing the profile-local
  `herdr-agent-state.ts` extension path as the trusted extension.
- `pi-worker-runtime.sh` (the **runtime**) — shared safety/runtime logic: profile
  resolution, argument blacklisting, `.sub_agent_conf` parsing, model probing, and
  the final `exec pi ...`.

### 1.2 Launcher flags & contract (`herdr-start-subagent.sh`) [Documented]

Required arguments:

| Flag | Validation |
| --- | --- |
| `--name <agent-name>` | must match `^[a-z][a-z0-9_-]{0,31}$`; must **not** collide with an existing live agent (checked via `herdr agent list` + jq select on `.name`) |
| `--mode <readonly\|editable>` | exact match, else exit 2 |
| `--handoff <abs-path>` **XOR** `--brief <inline>` | `--handoff` must be an existing readable absolute file; `--brief` must be non-empty; both → error; neither → error |
| `--report <abs-path>` | absolute; parent directory must exist and be writable |
| `--instruction <line>` | optional; must be exactly one physical line (no `\n`/`\r`) |
| `--direction <right\|down>` | default `right` |
| `--cwd <abs-dir>` | default `$PWD`; must be an existing absolute directory |
| `--timeout-seconds <1-30>` | default 5 (`DEFAULT_TIMEOUT_SECONDS`), integer 1..30 |

Environment guard: `HERDR_ENV=1` must be set (must run inside a Herdr-managed pane),
else exit 2.

Default instruction when omitted:
- handoff: `Read @$handoff. Complete the handoff exactly and write the required report to $report.`
- brief: `Complete the brief exactly and write the required report to $report.`

Launch mechanics:

- `herdr pane split --current --direction <d> --cwd <cwd> --no-focus` → parse
  `.result.pane.pane_id` via jq.
- Wrapper command built as: `<wrapper> --mode <mode> -- <payload> <instruction>`
  where payload is `@<handoff>` or the inline brief.
- **Quoting:** a custom `shell_quote()` (single-quote + POSIX `'"'"'` apostrophe
  idiom) instead of `printf %q` — the test suite documents that `printf %q` under
  `LC_ALL=C.UTF-8` produced invalid UTF-8 (raw leading byte + octal-escaped
  continuation bytes) for multibyte characters. Verified by the Unicode and
  apostrophe round-trip tests in `test_worker_launchers.sh` (including a `shlex`
  byte-for-byte comparison).
- `herdr pane run <pane_id> <command>` (stdout discarded).
- **Detection poll:** up to `timeout_seconds * 2` iterations at 0.5s
  (`POLL_INTERVAL_SECONDS=0.5`), calling `herdr agent get <pane_id>`; when
  `agent_status` is no longer `"unknown"`, it renames via
  `herdr agent rename <pane_id> <name>` and reads `agent_status` +
  `state_change_seq` via `herdr agent get <name>`.
- **Success JSON contract:**
  `{ok, name, mode, pane_id, report, agent_detected, agent_status,
  state_change_seq, detection_timeout_seconds, handoff|brief}` (exactly one of
  `handoff`/`brief`).
- **Error contract:** `{ok:false, error, exit_code}` on stderr, non-zero exit
  (`fail()` helper).

### 1.3 Worker wrapper & runtime (`pi-worker-runtime.sh`) [Documented]

**Profile selection:**
- If `pi-profile` is on PATH: use `PI_WORKER_PROFILE` (default `minimal`) →
  command `pi-profile <profile>`.
- Else: only `default` is allowed; any non-default `PI_WORKER_PROFILE` → exit 2 with
  an explanatory message.
- Profile agent dir: `default` → `~/.pi/agent`; any other profile (validated
  against `^[A-Za-z0-9_-]+$`, path-traversal names like `../unsafe` rejected) →
  `~/.pi/profiles/<profile>/agent`.
- Trusted reporter extension: `<profile_agent_dir>/extensions/herdr-agent-state.ts`.

**Argument grammar (wrapper CLI):** exactly one `--mode readonly|editable` before a
`--` delimiter; everything after `--` is the worker payload (e.g.
`@/tmp/handoff.md 'Instruction'`). Duplicate `--mode`, missing `--`, or an unknown
pre-delimiter flag → `usage_error` ("requires exactly one --mode readonly|editable
before --").

**Blacklisted caller arguments** (post-`--` payload; any match → exit 2 "caller may
not override launcher configuration"):
`--print`, `--print=*`, `-p`, `-p?*`, `--extension`, `--extension=*`, `-e`, `-e?*`,
`--model`, `--model=*`, `--provider`, `--provider=*`, `--thinking`,
`--thinking=*`, `--tools`, `--tools=*`, `-t`, `-t?*`, `--dm-*`
(covers read-only/dm-read mode toggles and any extension injection by the worker).

**Always-loaded extensions:**
- `https://github.com/cgint/pi-focus-guard`
- `https://github.com/cgint/pi-tool-intent`
- the trusted `herdr-agent-state.ts` from the profile dir (if present; missing → exit 1).

**`.sub_agent_conf` resolution:**
- Location: `<git rev-parse --show-toplevel>/.sub_agent_conf` (repo root only;
  outside a git repo → no config).
- Line syntax: blank lines and `#` comments allowed. Exactly three keys, each
  allowed **at most once** (second occurrence → error "invalid ... line"):
  - `PROVIDER=[A-Za-z0-9._-]+`
  - `MODEL=[A-Za-z0-9._-]+`
  - `THINKING=` one of `off|minimal|low|medium|high|xhigh|max`
- Any other key (e.g. `EXTENSIONS=...`) → hard error (explicitly tested: a
  `.sub_agent_conf` can select a provider/model but **can never introduce
  extension sources**).
- Both `PROVIDER` and `MODEL` must be present (comment-only or partial file → error
  "requires both PROVIDER and MODEL").

**Model probing / provider extensions:**
- `pi_worker_provider_extensions()` is the launcher's *own* trusted map (currently
  only `home-llm` → `https://github.com/cgint/pi-olla-autodetect`) — needed because
  some providers register models *inside* a Pi extension, making them invisible
  under `-ne` unless loaded explicitly.
- **Availability probe** (applies to both `.sub_agent_conf` and
  `PI_WORKER_DEFAULT_MODEL`): runs
  `<pi-cmd> -ne <extension_args> --list-models <provider>/<model>` and awk-matches a
  `provider<TAB>model` line. The probe uses the **same discovery mode (`-ne`) and
  explicit extensions as the eventual launch**, so a passing probe guarantees the
  launch can resolve the model. Unavailable model → exit 1 "model is unavailable".
  A provider *without* a mapped extension must still work (tested with
  `static-llm/known-model` — the trusted map is not a gate).

**Model selection precedence:**
1. `.sub_agent_conf` (`PROVIDER`/`MODEL`/optional `THINKING`) — wins over env.
2. Else `PI_WORKER_DEFAULT_MODEL` env: format
   `provider/model` or `provider/model:thinking`; thinking must be a valid level;
   missing provider → error.
3. Else default fallback: `auth check --provider openai-codex` → if ready,
   `openai-codex/gpt-5.6-terra`; else `auth check --provider github-copilot` →
   `github-copilot/gpt-5.6-terra`; else exit 1.

**Final `pi` invocation:**
- Base: `-ne` (no extension discovery) + the extension args (focus-guard,
  tool-intent, trusted reporter, provider extension if any).
- Provider/model flags per selection precedence; `--thinking` only when explicitly
  configured (default fallback forces `--thinking minimal`).
- **Mode flags:**
  - `readonly` → appends `--tools read,bash,grep,find,ls --dm-read`.
  - `editable` → **no** tool restriction flags (full default toolset).
  - (Both modes: `-ne`, so the only active extensions are the explicitly
    launched ones.)
- **Write guard:** exports `PI_WRITE_GUARD_DIRS="."` in both modes.
- `exec <pi-cmd> <args> <payload...>` (payload = `@handoff` + instruction, or brief
  + instruction).

### 1.4 Handoff vs. brief, report path, naming [Documented]

- **Handoff** (`--handoff`): must be an absolute, existing, readable file. The
  launcher's own usage text states the requirement: "A handoff must state the
  complete report path and all worker boundaries." Payload is `@<absolute-path>`.
- **Brief** (`--brief`): inline non-empty string; "An inline brief must state the
  complete worker boundaries; when its instruction is omitted, the launcher
  supplies one that requires the report path."
- **Report path** (`--report`): absolute; parent dir must exist and be writable
  (`require_absolute_report_path`). Enforced as a launcher argument so a worker can
  never be launched without a verifiable report destination.
- **Naming:** lowercase-first, `[a-z][a-z0-9_-]{0,31}`; uniqueness against live
  agents enforced pre-launch.

### 1.5 Test coverage highlights (`test_worker_launchers.sh`) [Documented]

The suite (self-contained; fakes `pi`, `git`, `herdr`) locks in:
- Readonly mode emits `--tools read,bash,grep,find,ls --dm-read` +
  `PI_WRITE_GUARD_DIRS=.`; editable omits the tool restriction.
- Fallback model switching (openai-codex → github-copilot).
- `PI_WORKER_PROFILE` honored for profile dir **and** reporter path; invalid profile
  names rejected; direct-pi (no `pi-profile`) refuses non-default profiles.
- `.sub_agent_conf`: provider/model/thinking passed through; THINKING omitted when
  absent; invalid THINKING rejected; duplicate keys rejected; incomplete /
  comment-only file rejected; unknown keys (extension injection) rejected;
  unavailable model rejected; config **overrides** `PI_WORKER_DEFAULT_MODEL`.
- `PI_WORKER_DEFAULT_MODEL`: valid form, thinking suffix, invalid thinking, missing
  provider, unavailable model.
- Caller override of `--model` rejected with "caller may not override launcher
  configuration".
- Launcher JSON contract for both `--handoff` and `--brief`; both/neither source
  errors; byte-exact shell quoting for Unicode + apostrophes (C.UTF-8 regression).

---

## 2. Sibling Pi Extensions

### 2.1 `../pi-herdr` (`@andrewjacop/pi-herdr` v0.3.0) [Documented]

Package layout (`/Users/christian.gintenreiter/dev-external/pi-herdr/package.json`):
`"type": "module"`, entry `"pi": {"extensions": ["./src/index.ts"]}`, node >= 20,
loaded via **jiti — no build step**. Peer deps: `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-ai`, `typebox` (all `*`).

**`src/herdr.ts` — the single CLI-spawn module** [Documented]:
- `herdr<T>(args, opts): Promise<Result<T>>` where
  `Result = {ok:true, data} | {ok:false, error:{code,message,details}}` (uniform
  envelope from `src/env.ts` — never throws).
- Spawns the native binary via `child_process.spawn(bin, args, {shell:false,
  windowsHide:true, env: process.env})`. Binary resolved by `resolveHerdrBin()`
  honoring `HERDR_BIN` / PATH / PATHEXT (`src/config.ts`).
- **Timeout:** `opts.timeoutMs` (default 60_000); a `setTimeout` kills the child and
  resolves `{error:{code:"TIMEOUT"}}`.
- **AbortSignal:** `opts.signal`; if already aborted → immediate TIMEOUT; else
  `addEventListener("abort", ...)` kills the child. A `settled` flag +
  `clearTimeout` prevent double-settle.
- **Envelope parsing:** `parseLastJson()` — tries whole-stdout `JSON.parse`, then
  scans lines back-to-front (herdr may emit trailing non-JSON lines). On non-zero
  exit with empty stdout, retries on **stderr** (herdr 0.7.5+ emits error envelopes
  on stderr).
- **Silent success:** exit 0 + empty stdout + empty stderr → `{ok:true, data:{}}`
  (e.g. `pane send-keys`).
- **`textOk` option:** for commands that emit plain text on success (`agent read`,
  `pane read`) — raw stdout returned as data.
- **Error code mapping** (`mapCode`): `agent_start_failed` →
  `AGENT_START_FAILED`; `*not_found*`/`no_such_agent`/`no_such_pane` →
  `NOT_FOUND`; `*gone*` → `PANE_GONE`; `*timeout*`/`*timed_out*` → `TIMEOUT`;
  else `VALIDATION_ERROR`. Spawn `ENOENT` → `HERDR_UNAVAILABLE`.

**Tools registered** (five tiers; every tool is a thin `execute(_id, p, signal)`
wrapper: build argv → `herdr()` → uniform `ToolReturn`):
- Tier 1 orchestration (`src/tools/orchestration.ts`): `herdr_start_agent`,
  `herdr_send_prompt`, `herdr_read_agent`, `herdr_wait_agent`,
  `herdr_list_agents`, `herdr_get_agent`, `herdr_stop_agent` (destructive),
  `herdr_rename_agent`, `herdr_focus_agent`, `herdr_explain_agent`,
  `herdr_delegate` (composite spawn→send→wait→read, with `onBlocked: wait|return`).
- Tier 2 layout (`src/tools/layout.ts`): `herdr_list_panes`, `herdr_get_pane`,
  `herdr_resize_pane`, `herdr_zoom_pane`, `herdr_move_pane`, `herdr_swap_panes`,
  `herdr_list_tabs`, `herdr_create_tab`, `herdr_get_tab`, `herdr_focus_tab`,
  `herdr_rename_tab`, `herdr_close_tab`, `herdr_list_workspaces`,
  `herdr_create_workspace`, `herdr_get_workspace`, `herdr_focus_workspace`,
  `herdr_rename_workspace`, `herdr_close_workspace`.
- Tier 3 pane-sync (`src/tools/sync.ts`): `herdr_split_pane`, `herdr_run_command`
  (`pane run <pane> <command>` — text + Enter), `herdr_read_pane`,
  `herdr_wait_output` (`pane wait-output --match|--regex --timeout`),
  `herdr_send_keys` (logical key names, e.g. `ctrl+c`, `esc`, `Enter`;
  `pane send-keys` or `agent send-keys` via `agentScope`), `herdr_close_pane`.
- Tier 4 worktrees (`src/tools/worktrees.ts`), Tier 5 introspection
  (`src/tools/introspection.ts`).

**The agent-wait race** [Documented] — `waitForStatus()` in
`src/tools/orchestration.ts`:
- Races **two** completion paths with `Promise.race`:
  1. **Event path:** herdr's status-transition wait. New API (≥0.7.5): one
     `agent wait <target> --until <s> [--until <s>…] --timeout <ms>` (repeatable
     `--until`, so several states race in a single call); legacy (<0.7.5): one
     `wait agent-status <target> --status <s> --timeout <ms>` **per state**. The
     event promise resolves *only on success* — errors are swallowed so the poll
     gets a chance.
  2. **Poll path:** `agent get <pane>` every 800ms until the wanted status or
     deadline — the fallback that makes detection robust against flaky herdr event
     commands (e.g. 0.7.3 "failed to decode pane get error").
- Whichever wins first resolves; a shared `AbortController` cancels the loser. The
  parent `signal` abort propagates via a one-shot listener.
- For "finished" specifically (`raceIdleDone`): races `idle` **and** `done`,
  because self-reporting pi panes settle on `idle` (herdr ≥0.7.3) while herdr's
  auto-detection may render `idle-after-working` as `done`. Completion is **never
  inferred from the rendered `Working…` spinner** (tool output replaces the
  spinner → false idle).
- **Self-report** (`src/selfreport.ts`): when pi itself runs inside a herdr pane,
  the extension pushes real state via lifecycle hooks (`agent_start → working`,
  `agent_settled → idle`) and the `herdr:blocked` EventBus channel (bridge from
  `pi-ask-user` / `pi-subagents` → `pane report-agent --state blocked`). This is
  why pi panes detect reliably while heterogeneous agents (claude/codex) rely on
  auto-detect + the poll.
- `submitAndWait()` (0.7.5): single atomic `agent prompt <target> <text> --wait
  --timeout <ms>`; on `agent_prompt_stalled` (prompt submitted but no working
  transition within herdr's grace window) it falls back to the wait/poll dance and
  the caller's retry loop re-sends up to 3× on `NOT_STARTED`.
- `waitForBlockedResolved()`: unbounded loop of 60s `raceIdleDone` chunks — only
  the parent signal can stop it (human-in-the-loop ask-user answers).

**TypeBox usage** [Documented]: `Type.Object({...})` with `Type.Optional`,
`Type.String/Integer/Boolean/Array/Record`, and `StringEnum` from
`@earendil-works/pi-ai` for closed vocabularies (e.g. `["idle","working","blocked",
"done","unknown"]`). Reusable field objects (e.g. `agentFields`) are spread into
multiple schemas. Returns are hand-built `ToolReturn` objects:
`{content:[{type:"text",text}], details, isError?}` via `fail(r)` / `okText(text,
details)` helpers — identical error contract across all tools.

**Extension entry** (`src/index.ts` [Documented]): default export
`function (pi: ExtensionAPI): void`; registers self-report + all five tiers;
`pi.on("session_start")` (reason `startup`/`reload`) re-probes herdr version and
toasts when missing; footer status on `agent_start`/`turn_end` via
`ctx.ui.setStatus("pi-herdr", ...)` showing agent count + working count + version.

### 2.2 `../pi-supervisor` [Documented]

`/Users/christian.gintenreiter/dev-external/pi-supervisor/src/index.ts`:
- Default export `(pi: ExtensionAPI)`; event-driven
  (`session_start`, `session_tree`, `turn_end`, `agent_end`), a
  `pi.registerCommand("supervise", {description, handler})`, and one
  `pi.registerTool({name:"start_supervision", label, description, parameters:
  Type.Object({…}), execute: async (_toolCallId, params, _signal, _onUpdate, ctx)
  => …})`.
- Notable patterns: TypeBox `Type.Union([Type.Literal("low"), …])` for enums;
  returning `{content:[{type:"text" as const, text}], details: undefined}`;
  `ctx.ui.notify`, `ctx.ui.confirm`, `ctx.modelRegistry.getApiKeyForProvider`;
  state kept in a manager object reconstructed from `ctx` on session events.
- The tool execute signature here confirms the 5-arg form:
  `execute(toolCallId, params, signal, onUpdate, ctx)`.

### 2.3 `../pi-mini-self-org` [Documented]

`/Users/christian.gintenreiter/dev-external/pi-mini-self-org/src/mini-self-org.ts`:
- Single-file extension (`src/mini-self-org.ts`) + `index.ts` re-export;
  `pi.extensions: ["./index.ts"]` in package.json.
- **Generic tool registration:** `pi.registerTool<typeof WorkpadParameters,
  WorkpadDetails>({…})` — TypeBox `TParams` and a `TDetails` interface, giving
  fully-typed `execute(toolCallId, params, signal, onUpdate, ctx)`.
- Schema patterns: `Type.Object` with per-field `minLength/maxLength/maxItems`,
  `Type.Union([Type.String({…}), Type.Null()])` for nullable strings,
  `Type.Optional(Type.Integer({minimum, maximum}))`.
- **Custom rendering:** `renderResult(result, _options, _theme, context)` returning
  a `{render(width), invalidate()}` structural component (using `truncateToWidth`,
  `visibleWidth` from `@earendil-works/pi-tui`) — error branch via
  `context.isError`.
- **Context injection:** `pi.on("context", async (event) => {… return {messages}})`
  to filter/inject a session-local scratchpad message (role `custom`, customType
  marker, `display:false`) before each LLM call; state reconstruction from
  `ctx.sessionManager.getBranch()` on `session_start`/`session_tree`.
- Commands: `pi.registerCommand` with `handler: async (args, ctx)`.

---

## 3. Pi Extension API & Constraints

Verified against the installed Pi package
(`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`) and official docs
(`.../pi-coding-agent/docs/extensions.md`).

### 3.1 Tool registration & TypeBox [Documented]

`pi.registerTool(definition)` with (from
`dist/core/extensions/types.d.ts`, ToolDefinition ~line 430-487):

```ts
{
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: TParams;            // TypeBox TSchema
  outputSchema?: TSchema;         // JSON Schema for structuredContent
  exposure?: "direct" | "model-only" | "codemode" | "deferred" | "hidden";
  namespace?: ToolNamespace;
  annotations?: ToolAnnotations;  // readOnlyHint/destructiveHint/…
  defaultActive?: boolean;
  executionMode?: "sequential" | "parallel";
  execute(toolCallId: string,
          params: Static<TParams>,
          signal: AbortSignal | undefined,
          onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
          ctx: ExtensionToolContext): Promise<AgentToolResult<TDetails>>;
  renderCall? / renderResult?;    // custom TUI components
  prepareArguments?, prepareLoadout?, constrainedSampling?;
}
```

- Parameters: **TypeBox** (`typebox`/`@sinclair/typebox`); `Static<TParams>` gives
  the TS param type. All three sibling extensions use `Type.Object` with
  `Type.Optional`, `StringEnum` (pi-ai), `Type.Union([Type.Literal…])`, and
  constraint props (`minLength`, `maxItems`, …).
- Returns: `AgentToolResult<TDetails>` = `{content: [{type:"text", text}],
  details: TDetails, isError?, usage?, structuredContent?, terminate?}`.
  **Throwing** from `execute` produces a failed tool result; returning
  `isError: true` reports failure *with* data (model sees error, scripts still get
  `structuredContent`). `outputSchema` + `structuredContent` for programmatic
  (codemode) consumers.

### 3.2 Long-running async & AbortSignal [Documented]

- `execute` returns a `Promise` — **async handlers may run arbitrarily long**
  (pi-herdr waits up to minutes inside `herdr_wait_agent`/`herdr_delegate`). The UI
  stays responsive because everything is event-loop based; nothing blocks.
- **`signal: AbortSignal | undefined`** is the 3rd execute argument: it carries the
  *active turn's* abort (user interrupt). Docs: "Use `ctx.signal` for nested work
  owned by an active turn; commands and idle session events often have no operation
  signal." For long work: check `signal.aborted`, attach an `"abort"` listener, and
  pass it down to child processes (pi-herdr's `herdr()` both honors it — kill
  child + resolve `TIMEOUT` on abort).
- **`onUpdate`** (4th arg): `AgentToolUpdateCallback<TDetails>` — push incremental
  results (e.g. `onUpdate({content: [], details})`) for live rendering of long
  operations; the built-in `bash` tool uses it for progress. Docs: nested tool
  calls via `ctx.executeTool(name, args, {signal, onUpdate})` emit
  `tool_execution_start/update/end` with `parentToolCallId`.
- **`ctx: ExtensionToolContext`** (5th arg): `cwd`, `model`, `modelRegistry`,
  `ui`, `sessionManager`, `signal`, `executeTool`, `tools`, …; `ctx.ui` guards
  (`ctx.hasUI`, `ctx.mode === "tui"`).
- **Lifecycle rules** (docs): the factory must not start processes/sockets/timers —
  "some invocations load extensions without starting a session"; start
  session-scoped resources from `session_start` (or the tool itself) and clean up
  in `session_shutdown`. Extension TS is loaded via **jiti — no build step**;
  dev loop is `pi -ne -e ./src/index.ts` or `/reload`.
- [Inferred] For a tool that blocks a herdr wait for minutes, report progress via
  `onUpdate` and honor `signal` on every herdr CLI call; this is exactly
  pi-herdr's established pattern and keeps Pi's UI/event loop free.

---

## 4. Architectural Recommendations for `pi-subagent-herdr`

1. **One herdr CLI module, uniform envelope.** Copy the `src/herdr.ts` pattern from
   pi-herdr: single `herdr<T>(args, {timeoutMs, signal, textOk})` →
   `Result<T> = {ok,data}|{ok,error:{code,message,details}}`, `spawn` with
   `shell:false`, hard timeout, AbortSignal kill, last-JSON-line parsing, stderr
   error-envelope fallback, silent-success rule. This directly mitigates the
   AGENTS.md risk "Herdr CLI version compatibility and JSON output parsing
   guarantees". Never throw; every failure is a normalized error code
   (`TIMEOUT`, `NOT_FOUND`, `PANE_GONE`, `VALIDATION_ERROR`,
   `HERDR_UNAVAILABLE`, `AGENT_START_FAILED`).
2. **Version-branched argv.** Herdr's API changed between 0.7.3 and 0.7.5
   (`agent start --kind` vs legacy; `agent prompt --wait` vs `send`+`wait
   agent-status`; `agent wait --until` repeatable). Probe `herdr --version` once
   (cached per session, as pi-herdr does in `src/version.ts`) and branch argv
   builders; keep builders **pure** so they unit-test offline.
3. **Wait race = event wait ∥ poll.** Implement pi-herdr's `waitForStatus`:
   `Promise.race` of herdr's transition wait (repeatable `--until` on ≥0.7.5)
   against an `agent get` poll every ~0.8-1s, cancelled via a shared
   `AbortController`; race `idle`+`done` for "finished". This answers the
   AGENTS.md risk "proper process lifecycle management for synchronous vs. async
   console waiting" — it never hangs on a flaky event and never blocks the event
   loop (promises + timers only).
4. **Port the launcher contract into `start_subagent`.** The scripts already encode
   the full spec: name regex `[a-z][a-z0-9_-]{0,31}` + live-name collision check,
   `readonly|editable` (readonly = `--tools read,bash,grep,find,ls --dm-read`),
   handoff XOR brief, absolute writable report path, direction/cwd/timeout,
   `PI_WRITE_GUARD_DIRS=.`, the argument blacklist, `.sub_agent_conf`
   (PROVIDER/MODEL/THINKING, single-occurrence, no extension injection),
   `PI_WORKER_DEFAULT_MODEL`, model-availability probe with matching `-ne`
   discovery, and the openai-codex→github-copilot fallback. The TypeScript tool
   should reproduce this argv construction exactly (the bash test suite in
   `test_worker_launchers.sh` is a ready-made acceptance-test list, including the
   UTF-8 quoting regression — in TS, `pane run` receives argv elements, which
   removes the shell-quoting problem entirely [Inferred: verify `pane run` argv
   shape live — pi-herdr's `run_command` passes the whole command line as a single
   argv element]).
   - Open decision: keep invoking the existing `herdr-worker.sh`/
     `pi-worker-runtime.sh` via `pane run` (fast, spec-complete, but bash-in-TUI)
     **or** reimplement the runtime in TS (cleaner, but must re-encode profile
     resolution, `.sub_agent_conf` semantics, and the probe). Recommendation:
     **phase 1 = reuse the wrapper via `pane run`** (behavioral parity now),
     **phase 2 = TS-native launch** once the tool surface is proven.
5. **Self-report for reliable completion.** Ship (or depend on) a
   `herdr-agent-state.ts`-style self-reporter so spawned pi workers push
   `working`/`idle`/`blocked` to herdr (`src/selfreport.ts` is the template:
   `agent_start`/`agent_settled` + `herdr:blocked` EventBus channel). Without it,
   completion detection for pi workers degrades to herdr's TUI auto-detect, which
   the pi-herdr README documents as unreliable for `working → idle`.
6. **Tool surface mapping (REQUIREMENTS.md → tools).** All 9 required capabilities
   have working precedents in pi-herdr:
   - `start_subagent` → orchestration `startAgent` + wrapper (or TS-native).
   - `wait_subagent_or_timeout` → `waitForStatus` with a `waitSeconds` budget;
     on timeout return last-N chars via `agent read --lines`.
   - `get_console_content` → `herdr_read_agent` / `herdr_read_pane`
     (`--source recent --lines`).
   - `wait_console_finish` → `agent wait --until idle,done` (agent panes) or
     `pane wait-output` (raw panes).
   - `send_pane_text` → `agent prompt` / `pane send-text` + `pane send-keys Enter`
     (version-branched, see `sendAgentPrompt`).
   - `send_pane_interrupt` → `pane send-keys ctrl+d` (logical key names are
     supported by `herdr_send_keys`; **CTRL-D mapping for a pi TUI must be
     verified live** — open loop from AGENTS.md).
   - `list_workspace_panes` → `herdr_list_panes` with `--workspace`.
   - `list_workspaces` → `herdr_list_workspaces`.
   - `close_pane` → `herdr_close_pane` (mark destructive via `annotations`).
7. **Return contract.** Uniform `ToolReturn` `{content:[text], details, isError}`
   via `fail()`/`okText()` helpers (pi-herdr pattern); consider `outputSchema` +
   `structuredContent` so codemode/scripts can consume pane ids and statuses
   programmatically (docs support it; pi-herdr does not use it yet — an
   improvement, not a requirement).
8. **Package shape.** `"type":"module"`, `pi.extensions: ["./src/index.ts"]`, jiti
   loading (no build step), peer deps on pi-coding-agent + typebox; dev loop
   `pi -ne -e ./src/index.ts`. Register everything in the factory; no
   timers/processes in the factory (docs rule); version probe + footer status on
   `session_start`/`agent_start`/`turn_end` are cheap UX wins proven in pi-herdr.

---

## 5. Open Loops / Risks Carried Forward

- **CTRL-D mapping:** herdr `send-keys` accepts logical key *names*; whether
  `ctrl+d` reaches a pi TUI as the interrupt is unverified — needs a live test.
- **`pane run` argv shape:** pi-herdr passes the command line as a *single* argv
  element (`pane run <pane> <command>`); the bash scripts also pass one shell
  command string. Verify the worker payload (wrapper path + args) survives as one
  string vs. needing separate argv elements.
- **Herdr version floor:** which herdr build is installed in the target
  environment decides the legacy vs. 0.7.5 branches; probe at session start and
  toast on missing/unparseable (pi-herdr `src/version.ts` pattern).
- **Self-report scope:** pi-only self-report; if workers may be claude/codex, rely
  on the poll fallback only.

*Report complete. All findings are sourced from the files cited; inferred items
are marked. No files were modified except this report.*
