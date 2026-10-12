// Herdr transport for the /herdr-reloc-tab command
// (docs/feature-impl/20261027-herdr-reloc-tab/3_plan__herdr-reloc-tab.md).
//
// A relocated Pi session is a PEER interactive session, not a managed worker
// and not a fork:
// - the new pane/tab is never recorded in SubagentService ownership,
// - no managed-Pi detection, rename, or agent-prompt delivery happens,
// - the session RESUMES (pi --session), it is not branched (pi --fork),
// - the launcher is this package's own `scripts/pi-reloc-launcher.sh`,
//   which never sources the worker runtime and contains no
//   `.sub_agent_conf`, worker profile/model/tool or write-guard logic.
//
// The choreography (plan §1.4):
//   1. pane get <paneId>            -> resolve the calling pane's workspace
//   2. tab create --workspace ... --focus -> new tab + root pane
//   3. pane run <rootPane> "<launcher> --session-file <quoted>"
//   4. pane close <originalPaneId>   (LAST action; see close call below)
//
// Reuses the Herdr CLI transport (process-array arguments, shellQuote /
// command-string convention) established by core.ts and transport.ts; the
// arbitrary session path travels as a shell-quoted argument to the launcher,
// executed by Herdr's `pane run` (no blind keystroke injection).
//
// Architectural departure from core.ts (documented, deliberate):
// the subagent core carries a hard `isSelf` guard ("supervisor cannot close
// itself (its own process owns this pane)"). This service DELIBERATELY closes
// the calling pane in step 4. Justification: by the time step 4 runs, the
// session has already been resumed in the new tab (step 3); the close is a
// cleanup step, not a control action. The accepted risk is the SILENT
// FAILURE mode (see the close call below): Herdr kills the PTY — and with
// it this process and its CLI child — possibly BEFORE the close's JSON
// response is written to stdout, so the confirmation notification may never
// fire. The service treats a close that fails to return a parseable, clean
// ok envelope (truncated/empty output, timeout, non-zero exit, or a typed
// pane_not_found) as "relocated, staleOriginalPane: true" rather than an
// error, because the session is already live in the new tab either way.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HerdrTransport,
  shellQuote,
  type Transport,
  type TransportResult,
  type TransportErrorName,
} from "./transport.js";

export interface RelocOptions {
  /** In-process Herdr transport (tests); defaults to the real CLI. */
  transport?: Transport;
  /** Absolute path of the packaged pi-reloc-launcher.sh. */
  launcherPath: string;
  /** The HERDR_PANE_ID of the calling (original) session. */
  paneId?: string;
  /** The calling session's working directory (ctx.cwd). */
  cwd?: string;
  /**
   * The command process's own environment (the handler must supply its
   * process env deliberately). Only PI_CODING_AGENT_DIR is read from it and
   * propagated to the new tab via `tab create --env`; nothing else. An empty
   * or blank value counts as absent (no flag is emitted, no default is
   * substituted).
   */
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
  /**
   * Set when the final `pane close` of the original pane did not return a
   * clean ok envelope (truncated/empty output, timeout, non-zero exit, or a
   * typed pane_not_found) — but the session is ALREADY resumed in the new
   * tab, so the reloc itself succeeded. The stale original pane (if still
   * alive) is left for manual cleanup.
   */
  staleOriginalPane?: boolean;
}

interface HerdrReturn {
  ok: boolean;
  exitCode: number;
  signal?: string;
  doc: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
  transportCode?: string;
  transportMessage?: string;
  text: string;
}

function parseJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function errorOf(doc: Record<string, unknown> | null): { code: string; message: string } | null {
  if (!doc || typeof doc !== "object") return null;
  const err = (doc as { error?: unknown }).error;
  if (!err || typeof err !== "object") return null;
  const e = err as { code?: unknown; message?: unknown };
  return {
    code: typeof e.code === "string" ? e.code : "unknown_error",
    message: typeof e.message === "string" ? e.message : "herdr error",
  };
}

export class HerdrRelocService {
  private readonly transport: Transport;
  private readonly launcherPath: string;
  private readonly paneId?: string;
  private readonly cwd: string;
  /**
   * The caller's exact PI_CODING_AGENT_DIR at service construction, or null
   * when the command process does not run under a named profile. This single
   * entry — and only this one — is propagated to the new tab via Herdr's
   * `tab create --env` option, which sets the environment of the process
   * Herdr launches in the tab's root pane (the launcher, and hence the
   * resumed `pi --session` session). An absent value is NEVER substituted
   * with a default; the target simply inherits whatever Herdr defaults to.
   */
  private readonly profileDir: string | null;
  private workspaceIdCache?: string;

  constructor(options: RelocOptions) {
    this.transport = options.transport ?? new HerdrTransport();
    this.launcherPath = options.launcherPath;
    this.paneId = options.paneId;
    this.cwd = options.cwd ?? process.cwd();
    const raw = options.env?.PI_CODING_AGENT_DIR;
    this.profileDir = typeof raw === "string" && raw.trim().length > 0 ? raw : null;
  }

  /**
   * The exact `--env` argument pair carrying the command process's profile
   * directory, or nothing when the process has no PI_CODING_AGENT_DIR.
   * The value travels as a separate argv entry (no shell interpolation of
   * the value beyond Herdr's own documented `--env KEY=VALUE` handling); it
   * is re-joined for the herdr CLI argument only.
   */
  private profileEnvArgs(): string[] {
    if (this.profileDir === null) return [];
    return ["--env", `PI_CODING_AGENT_DIR=${this.profileDir}`];
  }

  async reloc(args: { sessionFile: string }, signal?: AbortSignal): Promise<RelocResult> {
    if (signal?.aborted) return this.aborted("pre");
    if (!this.paneId) {
      return {
        ok: false,
        outcome: "outside_herdr",
        phase: "context",
        code: "outside_herdr",
        hint: "herdr-reloc-tab needs an active Herdr session (HERDR_PANE_ID is not set); nothing was created",
      };
    }
    if (!fs.existsSync(this.launcherPath) || !fs.statSync(this.launcherPath).isFile()) {
      return {
        ok: false,
        outcome: "launcher_missing",
        phase: "validation",
        code: "launcher_missing",
        detail: this.launcherPath,
        hint: "the packaged pi-reloc-launcher.sh was not found; nothing was created",
      };
    }

    const workspaceId = await this.resolveOwnWorkspace(signal);
    if (signal?.aborted) return this.aborted("context");
    if (!workspaceId) {
      return {
        ok: false,
        outcome: "error",
        phase: "context",
        code: "workspace_unknown",
        hint: "the current workspace could not be resolved (pane get failed); nothing was created",
      };
    }
    // Step 2: create the new tab in the calling pane's workspace.
    // Observed response (live probe, fork precedent 2026-10-07):
    //   result = { tab: { tab_id }, root_pane: { pane_id } }
    const tabRes = await this.herdr(
      [
        "tab", "create",
        "--workspace", workspaceId,
        "--cwd", this.cwd,
        ...this.profileEnvArgs(),
        "--focus",
      ],
      { signal },
    );
    if (!tabRes.ok) return this.transportFailure("tab_create", tabRes);
    const result = tabRes.doc?.result as Record<string, unknown> | undefined;
    const rootPane = (result?.root_pane ?? null) as Record<string, unknown> | null;
    const tab = (result?.tab ?? null) as Record<string, unknown> | null;
    const rootPaneId = typeof rootPane?.pane_id === "string" ? rootPane.pane_id : "";
    const tabId = typeof tab?.tab_id === "string" ? tab.tab_id : "";
    if (rootPaneId.length === 0 || tabId.length === 0) {
      return {
        ok: false,
        outcome: "error",
        phase: "tab_create",
        code: "tab_create_malformed",
        hint: "tab create did not return a valid tab/root pane; inspect the workspace manually",
        detail: JSON.stringify(tabRes.doc?.result ?? null),
      };
    }

    // Step 3: resume the SAME session in the new tab's root pane. The
    // launcher is executed by Herdr's `pane run`, which runs a single
    // command string in the pane's shell — same convention the core's
    // `pane run` wrapper invocation uses. The session path travels as a
    // shell-quoted argument; the argument array itself never crosses a
    // shell. NO instruction: reloc resumes the session as-is.
    const command = [
      shellQuote(this.launcherPath),
      "--session-file", shellQuote(args.sessionFile),
    ].join(" ");
    const runRes = await this.herdr(["pane", "run", rootPaneId, command], { signal });
    if (!runRes.ok) {
      // An aborted transport must surface as "aborted" (the caller decided
      // to stop), not as an ordinary launch error — mirrors fork's
      // launchInto. The original pane is NOT closed on any launch failure.
      if (signal?.aborted || runRes.error?.code === "aborted") {
        return this.aborted("launch", rootPaneId);
      }
      return this.transportFailure("launch", runRes, { tab: tabId, pane: rootPaneId });
    }
    if (signal?.aborted) return this.aborted("launch", rootPaneId);

    // Step 4 (LAST action): close the original (calling) pane.
    //
    // DEPARTURE FROM core.ts isSelf: the subagent core hard-blocks a
    // supervisor from closing its own pane ("supervisor cannot close itself
    // (its own process owns this pane)"). Here this service IS that
    // supervisor's process tree closing its own pane — deliberately.
    // Justification: the session has already been resumed in the new tab
    // (step 3); this close is cleanup, not control.
    //
    // SILENT-FAILURE RISK (probe-confirmed, 2026-10-27): `herdr pane close
    // <callingPane>` kills the PTY, and the PTY is the ancestor of THIS
    // process and of the CLI child it just spawned. The PTY is killed
    // SILENTLY before the CLI's JSON envelope is written to stdout — the
    // observed failure is 0-byte stdout plus a truncated shell. Therefore:
    //   - this call is the LAST action; the code below must not depend on
    //     its response for success (it cannot; if the PTY dies first, this
    //     whole process — and the notification that would follow — is dead);
    //   - any outcome of this call (clean ok, truncated/empty output,
    //     timeout, non-zero exit, typed pane_not_found) is treated as
    //     "relocated"; only a clean ok envelope leaves
    //     staleOriginalPane unset.
    const closeRes = await this.herdr(["pane", "close", this.paneId], { signal });
    const cleanClose = closeRes.ok && closeRes.error === null && closeRes.doc !== null;
    return {
      ok: true,
      outcome: "relocated",
      phase: "close",
      tab: tabId,
      pane: rootPaneId,
      staleOriginalPane: cleanClose ? false : true,
      hint: cleanClose
        ? "peer session only: not an owned subagent; no detection, rename or task delivery"
        : "peer session only: the resumed session is live in the new tab; the original pane close did not return a clean response (it may still exist as a stale pane)",
    };
  }

  private async resolveOwnWorkspace(signal?: AbortSignal): Promise<string | null> {
    if (this.workspaceIdCache) return this.workspaceIdCache;
    if (!this.paneId) return null;
    const res = await this.herdr(["pane", "get", this.paneId], { signal });
    const pane = (res.doc?.result as Record<string, unknown> | undefined)?.pane as
      | Record<string, unknown>
      | undefined;
    if (!res.ok || typeof pane?.workspace_id !== "string") return null;
    this.workspaceIdCache = pane.workspace_id;
    return pane.workspace_id;
  }

  private async herdr(
    args: string[],
    opts: { signal?: AbortSignal } = {},
  ): Promise<HerdrReturn> {
    let result: TransportResult;
    try {
      result = await this.transport.run(args, opts);
    } catch (err) {
      const name = (err as Error)?.name as string | undefined;
      if (name === "AbortError" || opts.signal?.aborted) {
        return {
          ok: false, exitCode: -1, doc: null,
          error: { code: "aborted", message: "operation aborted" },
          text: "", transportCode: "aborted",
        };
      }
      const code: TransportErrorName | "TransportError" =
        name === "TimeoutError"
          ? "TimeoutError"
          : name === "OutputOverflowError"
            ? "OutputOverflowError"
            : name === "SpawnError"
              ? "SpawnError"
              : "TransportError";
      return {
        ok: false, exitCode: -1, doc: null,
        error: { code: code === "TransportError" ? "transport_error" : code, message: (err as Error).message ?? String(err) },
        text: "", transportCode: code, transportMessage: (err as Error).message,
      };
    }
    const code = result.exitCode;
    const success = code === 0;
    const envelopeStream = success
      ? result.stdout
      : code === 1
        ? result.stderr
        : parseJson(result.stdout) !== null
          ? result.stdout
          : result.stderr;
    const doc = parseJson(envelopeStream);
    return {
      ok: success,
      exitCode: code ?? -1,
      signal: result.signal ?? undefined,
      doc,
      error: errorOf(doc),
      text: envelopeStream,
    };
  }

  private transportFailure(
    phase: string,
    res: HerdrReturn,
    labels: { tab?: string; pane?: string } = {},
  ): RelocResult {
    const code = res.error?.code ?? res.transportCode ?? (res.signal ? `killed_${res.signal}` : `exit_${res.exitCode}`);
    const message = res.error?.message ?? res.transportMessage ?? (res.text.trim() || `herdr exited ${res.exitCode}`);
    return {
      ok: false,
      outcome: "error",
      phase,
      code,
      ...(labels.tab !== undefined ? { tab: labels.tab } : {}),
      ...(labels.pane !== undefined ? { pane: labels.pane } : {}),
      hint: `herdr ${phase} failed (${code}): ${message}; the original pane is untouched — inspect the workspace`,
    };
  }

  private aborted(phase: string, pane?: string): RelocResult {
    return {
      ok: false,
      outcome: "aborted",
      phase,
      ...(pane !== undefined ? { pane } : {}),
      code: "aborted",
      hint: "reloc aborted before completion; inspect the workspace",
    };
  }
}

/** Default launcher location: the scripts directory next to this package root. */
export function defaultRelocLauncherPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "scripts", "pi-reloc-launcher.sh");
}
