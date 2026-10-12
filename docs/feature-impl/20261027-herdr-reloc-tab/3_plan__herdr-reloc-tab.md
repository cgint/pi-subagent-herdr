# Implementation Plan: `/herdr-reloc-tab` Preset Command

> **Status:** Implemented + live-accepted (2026-10-12/27). See [`4_implementation__herdr-reloc-tab.md`](./4_implementation__herdr-reloc-tab.md) for the verification gate, live AC 1-10 verdicts, test status, and known limitations.
> **Requirements Source:** [`2_requirements__herdr-reloc-tab.md`](./2_requirements__herdr-reloc-tab.md)
> **Precedent:** `/herdr-fork` (`docs/feature-impl/20261007-herdr-fork/`)

---

## 1. Technical Architecture & Principles

### 1.1 Command Registration
- `/herdr-reloc-tab` is an interactive user command, not an agent tool.
- Register via `pi.registerCommand("herdr-reloc-tab", { description: …, handler: … })` in `index.ts`, alongside the existing `registerForkCommand()`.
- The handler communicates back via `ctx.ui.notify(...)` — same pattern as `/herdr-fork`.
- **No argument parsing:** the command takes no arguments. The handler ignores `rawArgs` (or asserts it is blank).

### 1.2 Session Boundary: Relocated Peer Session (Not a Fork, Not a Worker)
- The resumed Pi process is a **peer interactive user session**, not an owned worker and not a fork.
- **Do NOT** register the new pane in `SubagentService` ownership records.
- **Do NOT** wrap with `herdr-worker.sh` or any worker runtime.
- **Do NOT** execute worker rename or cleanup routines on this pane.
- The session is *relocated*, not branched: `pi --session <file>` (resume), **not** `pi --fork <file>` (branch).

### 1.3 Dedicated Reloc Launcher Shell Script (`pi-reloc-launcher.sh`)
- **Isolation from Subagent Infrastructure:** same principle as `pi-fork-launcher.sh`.
  - Standalone, in `scripts/`.
  - No `.sub_agent_conf` parsing, no worker model selection, no role preambles, no tool restrictions.
- **Responsibilities:**
  1. `PI_CODING_AGENT_DIR` is **already in the process environment** (set by `herdr tab create --env` in step 3). The launcher does NOT re-export or re-forward it — `exec` inherits the current environment verbatim. If `PI_CODING_AGENT_DIR` is absent from the environment, the `pi` process inherits whatever Herdr defaults to (no substitution, no default injection). This is simpler than `pi-fork-launcher.sh` (which must resolve the profile dir from the calling process's env because the split pane does not automatically carry it); here, the `--env` flag on `tab create` already placed it in the target pane's launch environment.
  2. `exec pi --session <session-file>` directly. No instruction argument (reloc resumes as-is; there is nothing new to tell the session).
- **Invocation from Herdr:**
  - `herdr pane run <newPane> "<launcher-script-path> --session-file <shell-quoted-abs-path>"`
  - The session path travels as a shell-quoted argument (same `shellQuote` convention as fork).

### 1.4 The Four-Step Choreography (Service Method)
A new `HerdrRelocService` in `reloc.ts` (mirroring `HerdrForkService` structure):

```
reloc({ sessionFile, paneId, cwd, env, transport }):
  1. Validate: paneId present (else outside_herdr), launcher exists (else launcher_missing)
  2. resolveOwnWorkspace()  → wsId  (cache, same as fork)
  3. herdr tab create --workspace wsId --cwd cwd --env PI_CODING_AGENT_DIR=… --focus
     → { tab: { tab_id }, root_pane: { pane_id } }
     → on failure: return transportFailure("tab_create")
  4. herdr pane run <rootPane> "<launcher> --session-file <quoted>"
     → on failure: return transportFailure("launch")  (original pane NOT closed)
  5. herdr pane close <originalPaneId>
     → ⚠ CRITICAL RISK: the Pi process issuing this command is a child of the
       original pane's PTY. When Herdr closes the pane, it kills the PTY, which
       kills the shell, which kills the `herdr` CLI child — possibly BEFORE the
       JSON response is written to stdout. In that case, the transport's `await`
       hangs (up to 60 s timeout) or receives a truncated/empty response, and
       the `ctx.ui.notify` confirmation NEVER fires. The user sees the old tab
       vanish and the new tab appear, with no feedback.
     → This is NOT a graceful-failure path; it is a SILENT-FAILURE path.
     → The reloc itself succeeds (the session is in the new tab), but the user
       gets no confirmation. This is acceptable only if verified by the
       Pre-Implementation Verification Gate (requirements §5, item 2).
     → On graceful failure (response arrives): return success-with-warning.
  6. return { ok: true, outcome: "relocated", tab, pane: rootPane }
```

**Key invariants:**
- The original pane is closed **only after** step 4 succeeds. If step 4 fails, the original pane is untouched (the user still has their live session).
- The original pane's close (step 5) is the **last** action. **The Pi process issuing the command is a child of that pane.** The close takes effect on the Herdr server; whether the CLI JSON response is delivered before the PTY is killed is **unverified** (see step 5 risk). If the PTY is killed first, the transport hangs or receives a truncated response, and no notification fires.
- `PI_CODING_AGENT_DIR` is propagated via `--env` on `tab create` (same single-entry mechanism as fork). No other env var is forwarded.
- **Architectural departure from `core.ts`:** The subagent core has a hard `isSelf` guard (`"supervisor cannot close itself"`). This reloc command deliberately closes the calling pane. Justification: the session has already been resumed in the new tab (step 4); the close is a cleanup step, not a control action. The silent-failure mode is the accepted risk of this departure.

---

## 2. Files to Create / Modify

### New files
| File | Purpose |
|---|---|
| `reloc.ts` | `HerdrRelocService` class + `RelocResult` type + `defaultRelocLauncherPath()` |
| `scripts/pi-reloc-launcher.sh` | Dedicated launcher: resolve profile dir, `exec pi --session <file>` |
| `tests/reloc.test.ts` | Unit tests for `HerdrRelocService` (exact CLI invocations, failure paths, launcher asset) |
| `tests/reloc_command.test.ts` | Unit tests for the `/herdr-reloc-tab` command handler (registration, session-file resolution, notify) |

### Modified files
| File | Change |
|---|---|
| `index.ts` | Add `registerRelocCommand()` (mirrors `registerForkCommand()`); add `relocTransport` to `RegistrationDeps` for test injection; import `HerdrRelocService` + `defaultRelocLauncherPath` |
| `package.json` | (no change expected — no new dependencies) |

### Unchanged (explicit)
- `core.ts` — the subagent core is not involved; reloc is a peer-session operation.
- `fork.ts` / `fork-parser.ts` — fork is unchanged; reloc is a separate service.
- `transport.ts` — reused as-is (the `Transport` interface + `HerdrTransport` + `shellQuote`).
- `scripts/pi-fork-launcher.sh` — unchanged.

---

## 3. `HerdrRelocService` API (Sketch)

```ts
export interface RelocOptions {
  transport?: Transport;
  launcherPath: string;
  /** HERDR_PANE_ID of the calling (original) session. */
  paneId?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RelocResult {
  ok: boolean;
  outcome: "relocated" | "error" | "aborted" | "outside_herdr" | "launcher_missing";
  phase: string;
  /** The new tab (tab:*). */
  tab?: string;
  /** The new root pane hosting the resumed session. */
  pane?: string;
  code?: string;
  hint?: string;
  detail?: string;
  /** Set when pane close failed but the reloc itself succeeded. */
  staleOriginalPane?: boolean;
}

export class HerdrRelocService {
  constructor(options: RelocOptions);
  async reloc(args: { sessionFile: string }, signal?: AbortSignal): Promise<RelocResult>;
}

export function defaultRelocLauncherPath(): string;
```

**Internal structure** mirrors `HerdrForkService`:
- `private profileEnvArgs(): string[]` — the `--env PI_CODING_AGENT_DIR=…` pair (or empty).
- `private resolveOwnWorkspace(signal?): Promise<string | null>` — `pane get` → `workspace_id` (cached).
- `private herdr(args, opts): Promise<HerdrReturn>` — the CLI invocation wrapper (same JSON-envelope parsing as fork).
- `private transportFailure(phase, res, labels?): RelocResult` — error mapping.
- `private aborted(phase): RelocResult` — abort mapping.

---

## 4. `pi-reloc-launcher.sh` (Sketch)

```bash
#!/usr/bin/env bash
# pi-reloc-launcher.sh — dedicated /herdr-reloc-tab launcher (peer session resume,
# NOT a worker, NOT a fork).
#
# Invoked by Herdr's `pane run` inside the new tab's root pane:
#   herdr pane run <pane> "<this-script> --session-file <abs-path>"
#
# Responsibilities:
#   1. PI_CODING_AGENT_DIR is already in the process environment (set via
#      `herdr tab create --env` in step 3). `exec` inherits the current
#      environment verbatim — no re-export, no default injection. If the
#      variable is absent, the pi process inherits the Herdr default.
#   2. exec `pi --session <session-file>` directly — a plain interactive Pi
#      resume, fully decoupled from the subagent worker launchers.
#
# Arguments:
#   --session-file <path>   REQUIRED. Absolute path to the active session file
#                           (already validated by the command handler).
#
# Exit codes:
#   0   resumed session launched successfully
#   2   usage error (missing/blank --session-file); pi is never exec'd.

set -euo pipefail

err() { printf 'pi-reloc-launcher: %s\n' "$*" >&2; }
usage_error() { err "$1"; echo "usage: pi-reloc-launcher.sh --session-file <path>" >&2; exit 2; }

session_file=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session-file)
      [ $# -lt 2 ] && usage_error "--session-file requires a value"
      session_file="$2"; shift 2 ;;
    *) usage_error "unexpected argument: $1" ;;
  esac
done
[ -z "$session_file" ] && usage_error "--session-file is required"
[ ! -f "$session_file" ] && usage_error "session file not found: $session_file"

# Profile parity: PI_CODING_AGENT_DIR is already in the process environment
# (set via `herdr tab create --env` in step 3). `exec` inherits the current
# environment verbatim — no re-export needed. If the variable is absent, the
# pi process inherits the Herdr default (no substitution, no default injection).
exec pi --session "$session_file"
```

**Note:** unlike `pi-fork-launcher.sh`, there is no `--` instruction marker and no instruction joining — reloc resumes the session as-is.

---

## 5. Command Handler (in `index.ts`)

```ts
const registerRelocCommand = (): void => {
  try {
    pi.registerCommand("herdr-reloc-tab", {
      description: "Relocate the active Pi session to a new Herdr tab (resume, not fork)",
      handler: async (_rawArgs: string, ctx: ExtensionCommandContext) => {
        const notify = (msg: string, type: "info"|"warning"|"error" = "info") => {
          try { ctx.ui.notify(msg, type); } catch { /* advisory */ }
        };
        // 1) Resolve and validate the active session file.
        let sessionFile: string | undefined;
        try { sessionFile = ctx.sessionManager.getSessionFile(); } catch { sessionFile = undefined; }
        if (typeof sessionFile !== "string" || sessionFile.trim() === "" || !fs.existsSync(sessionFile)) {
          notify("herdr-reloc-tab: no active session file to relocate yet; nothing was created.", "warning");
          return;
        }
        // 2) Execute the 4-step choreography.
        const service = new HerdrRelocService({
          launcherPath: defaultRelocLauncherPath(),
          paneId: envPaneId(),
          cwd: ctx.cwd,
          env,
          ...(registrationDeps.relocTransport !== undefined ? { transport: registrationDeps.relocTransport } : {}),
        });
        const result = await service.reloc({ sessionFile }, ctx.signal);
        if (result.ok) {
          notify(
            result.staleOriginalPane
              ? `herdr-reloc-tab: session relocated to tab ${result.tab}; original pane close FAILED (stale pane remains).`
              : `herdr-reloc-tab: session relocated to tab ${result.tab}; original pane closed.`,
            "info",
          );
          return;
        }
        if (result.outcome === "outside_herdr") {
          notify("herdr-reloc-tab: this session is not running inside a Herdr pane; reloc skipped.", "warning");
          return;
        }
        notify(`herdr-reloc-tab failed (${result.phase}): ${result.hint ?? result.code ?? "unknown"}`, "error");
      },
    });
  } catch { /* registration is advisory */ }
};
registerRelocCommand();
```

---

## 6. Test Coverage Plan

### `tests/reloc.test.ts` (service-level, fake transport)
Mirror `tests/fork.test.ts` structure:
1. **Happy path (tab):** fake transport records calls; assert exact sequence:
   - `pane get <paneId>` (workspace resolution)
   - `tab create --workspace <ws> --cwd <cwd> --env PI_CODING_AGENT_DIR=<dir> --focus`
   - `pane run <rootPane> "<launcher> --session-file <quoted>"`
   - `pane close <originalPaneId>`
   - Result: `{ ok: true, outcome: "relocated", tab, pane: rootPane }`
2. **PI_CODING_AGENT_DIR absent:** `tab create` carries **no** `--env` pair.
3. **PI_CODING_AGENT_DIR present:** `tab create` carries exactly one `--env` pair.
4. **Outside Herdr (no paneId):** `outcome: "outside_herdr"`, no CLI calls.
5. **Launcher missing:** `outcome: "launcher_missing"`, no CLI calls.
6. **Tab create fails:** `outcome: "error"`, phase `tab_create`; `pane run` and `pane close` are **not** called.
7. **Pane run fails:** `outcome: "error"`, phase `launch`; `pane close` is **not** called.
8. **Pane close fails (graceful):** `outcome: "relocated"` (ok: true), `staleOriginalPane: true`; all 4 CLI calls were made.
9. **Abort before start:** `outcome: "aborted"`, no CLI calls.
10. **Abort mid-flight:** `outcome: "aborted"`, CLI calls stop at the abort point.

**⚠ Test coverage limitation:** All unit tests use a fake transport that returns a valid JSON response for `pane close`. The **real** failure mode (PTY killed before the CLI response is written) is a runtime/environment behavior, **not** a logic error — no unit test can catch it. This is why Phase 4's human-verification acceptance criterion (requirements AC 10) is mandatory: only a human can confirm that the new tab has a live, typeable Pi session after the old tab vanishes with no notification.

### `tests/reloc_command.test.ts` (command-handler-level)
1. **Registration:** the command is registered with the correct name and description.
2. **No session file:** handler calls `notify` with a warning; no service call.
3. **Happy path:** handler calls `notify` with a confirmation (tab id present).
4. **Outside Herdr:** handler calls `notify` with a warning; no error.
5. **Service error:** handler calls `notify` with an error (phase + hint).

### Verification commands
```bash
# Type-check
npx tsc --noEmit
# Unit tests (reloc-specific + full suite for regressions)
npx vitest run tests/reloc.test.ts tests/reloc_command.test.ts
npx vitest run   # full suite
```

---

## 7. Phased Implementation Roadmap

- [ ] **Phase 1: `pi-reloc-launcher.sh`**
  - Write the launcher script (see §4 sketch).
  - No unit test (it's a thin shell script; the fork launcher follows the same pattern and is verified by the fork test suite's launcher-asset check).
- [ ] **Phase 2: `reloc.ts` (HerdrRelocService) + unit tests**
  - Implement the service (see §3 sketch).
  - Write `tests/reloc.test.ts` (see §6).
  - All tests green.
- [ ] **Phase 3: Command handler wiring in `index.ts`**
  - Add `registerRelocCommand()` + `relocTransport` dep.
  - Write `tests/reloc_command.test.ts`.
  - All tests green.
- [ ] **Phase 4: Live verification & acceptance**
  - In a temporary Pi session loaded from this checkout:
    - `/herdr-reloc-tab` creates a new tab, resumes the session, closes the original pane.
    - The new tab shows the full conversation history; the user can continue typing.
    - The original pane is closed (verified via `herdr pane get <oldId>` → absent).
    - The new `pi` process has a fresh `HERDR_PANE_ID` (verified via the Pi status line or `herdr pane get <newId>`).
    - `PI_CODING_AGENT_DIR` is carried (verified via the Pi profile indicator or env inspection).
  - All temporary tabs/panes are closed and absence verified.
  - Edge cases: run `/herdr-reloc-tab` when no session file exists (warning, nothing created); run outside Herdr (warning, nothing created).

---

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **`pane close` on the calling pane kills the Pi process before the CLI response is delivered (SILENT FAILURE).** | This is the **primary risk** of the feature. The Pi process is a child of the pane being closed; the `herdr pane close` CLI is a child of the Pi process. When Herdr kills the PTY, the CLI child may die before writing its JSON response. The transport hangs (up to 60 s) or receives a truncated/empty response; no notification fires. **Mitigation:** (a) Pre-implementation verification gate (plan §9, item 2) determines whether this actually happens. (b) If confirmed, document it as a known limitation: the reloc succeeds (session is in the new tab) but the user gets no confirmation. (c) Phase 4 acceptance criterion 10 (human verification) catches this: the user manually confirms the new tab has a live session. **This is NOT a "missing confirmation" edge case — it is the guaranteed outcome if Herdr kills the PTY synchronously.** Live-confirmed (2026-10-12/27): the notification did not fire (issuing pi dead before the CLI envelope) and the reloc succeeded — see `4_implementation__herdr-reloc-tab.md`. The exact PTY-kill/envelope ordering was not isolated; the substantive steps (tab create, resume) execute before the final self-close, so the resume is unaffected by the close's envelope loss. |
| **Architectural departure from `core.ts` `isSelf` guard.** | The subagent core hard-blocks a supervisor from closing its own pane. This reloc command deliberately closes the calling pane. Justification: the session has already been resumed in the new tab (step 4); the close is cleanup, not control. The departure is documented in requirements §3.1 step 4 and plan §1.4 key invariants. |
| **`pi --session <file>` cold-start is slow (seconds).** | Inherent to the resume-and-close pattern (vs. `pane move` which is instant). Acceptable trade-off for architectural safety. Documented in requirements. |
| **The new tab's root pane is not the *only* pane in the new tab** (Herdr might create a default layout). | `tab create` returns `root_pane` — the service uses that exact pane for `pane run`. If the layout has multiple panes, the session resumes in the root pane (correct). |
| **Session file path contains special characters.** | `shellQuote` (from `transport.ts`) handles this — same mechanism as fork. |
| **The original pane is the *last* pane in its tab; closing it closes the tab.** | Expected and correct: the user's old tab disappears, the new tab has the session. No data loss. |
| **`PI_CODING_AGENT_DIR` is set but points to a non-existent directory.** | The `pi` process will fail to start in the new pane (Herdr shows the error in that pane). The original pane is **not** closed (pane run failed → step 5 not reached). The user sees the error in the new tab and can close it manually. |

---

## 9. Pre-Implementation Verification Gate (MANDATORY)

Before Phase 1 (writing `pi-reloc-launcher.sh`) begins, verify:

1. **`pi --session <file>` resumes-and-continues** (not read-only, not a fork prompt).
   - *How:* In a scratch Herdr pane, run `pi --session <path-to-a-test-session-file>`. Type a message. Confirm the conversation continues.
   - *If it reopens read-only or prompts for a fork:* **STOP.** The feature design changes. Re-scope.
2. **`herdr pane close <id>` on a pane with a running PTY: does the CLI response arrive before the PTY is killed?**
   - *How:* In a scratch Herdr pane, run `sleep 300`. From another pane, run `herdr pane close <id>`. Observe whether the CLI returns a JSON envelope before or after the PTY dies.
   - *If the response is lost:* silent-failure mode confirmed. Document it. The feature still works (session is in the new tab), but the user gets no confirmation.
   - *If the response arrives:* step 5 is safe as designed; the confirmation notification fires.

**These two probes are 30-second each. Do them before writing any code.**

---

## 10. Open Questions (residual, after verification gate)

1. **Does `herdr pane close <id>` return a JSON envelope, or exit silently?**
   - *Evidence:* the subagent core's `closePane` (in `core.ts`) expects a JSON response (it checks `res.code === "pane_not_found"` for idempotent close). *Assumption:* `pane close` returns a JSON envelope. *Verification:* covered by verification gate item 2 above.
2. **Is there a race between `tab create --focus` and the TUI rendering the new tab?**
   - *Hypothesis:* `--focus` is a server-side state change; the TUI client picks it up on its next render cycle. No race expected. *Verification:* Phase 4 — observe whether focus lands on the new tab without a manual click.
