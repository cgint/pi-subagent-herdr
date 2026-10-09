// Herdr transport for the /herdr-fork command
// (docs/feature-impl/20261007-herdr-fork/3_plan__herdr-fork.md).
//
// A forked Pi session is a PEER interactive session, not a managed worker:
// - the pane is never recorded in SubagentService ownership,
// - no managed-Pi detection, rename, or agent-prompt delivery happens,
// - the launcher is this package's own `scripts/pi-fork-launcher.sh`, which
//   never sources the worker runtime and contains no `.sub_agent_conf`,
//   worker profile/model/tool or write-guard logic.
//
// Reuses the Herdr CLI transport (process-array arguments, shellQuote /
// command-string convention) established by core.ts and transport.ts; the
// arbitrary session path / instruction travel as shell-quoted arguments to
// the launcher, executed by Herdr's `pane run` (no blind keystroke injection).

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

export type ForkPlacement = "right" | "down" | "tab";

export interface ForkOptions {
  /** In-process Herdr transport (tests); defaults to the real CLI. */
  transport?: Transport;
  /** Absolute path of the packaged pi-fork-launcher.sh. */
  launcherPath: string;
  /** Absolute path of the active session file (already validated). */
  sessionFile: string;
  placement: ForkPlacement;
  /** Optional starter instruction; undefined = open without sending a prompt. */
  instruction?: string;
  /** The HERDR_PANE_ID of the calling (parent) session. */
  paneId?: string;
  /** The calling session's working directory (ctx.cwd). */
  cwd?: string;
  /**
   * The command process's own environment (the handler must supply its
   * process env deliberately). Only PI_CODING_AGENT_DIR is read from it and
   * propagated to the forked pane/tab via `--env`; nothing else. An empty or
   * blank value counts as absent (no flag is emitted, no default is
   * substituted).
   */
  env?: NodeJS.ProcessEnv;
}

export interface ForkResult {
  ok: boolean;
  outcome:
    | "forked"
    | "error"
    | "aborted"
    | "outside_herdr"
    | "launcher_missing";
  phase: string;
  /** The peer pane that hosts the forked session. */
  pane?: string;
  /** The tab (tab:*) when placement is "tab". */
  tab?: string;
  placement?: ForkPlacement;
  code?: string;
  hint?: string;
  detail?: string;
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

export class HerdrForkService {
  private readonly transport: Transport;
  private readonly launcherPath: string;
  private readonly paneId?: string;
  private readonly cwd: string;
  /**
   * The caller's exact PI_CODING_AGENT_DIR at service construction, or null
   * when the command process does not run under a named profile. This single
   * entry — and only this one — is propagated to every fork target pane/tab
   * via Herdr's `--env` option (pane split / tab create), which sets the
   * environment of the process Herdr launches there (the launcher, and hence
   * the forked `pi --fork` session). An absent value is NEVER substituted
   * with a default; the target simply inherits whatever Herdr defaults to.
   */
  private readonly profileDir: string | null;
  private workspaceIdCache?: string;

  constructor(options: {
    transport?: Transport;
    launcherPath: string;
    paneId?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  }) {
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

  async fork(args: {
    sessionFile: string;
    placement: ForkPlacement;
    instruction?: string;
  }, signal?: AbortSignal): Promise<ForkResult> {
    if (signal?.aborted) return this.aborted("pre");
    if (!this.paneId) {
      return {
        ok: false,
        outcome: "outside_herdr",
        phase: "context",
        code: "outside_herdr",
        hint: "herdr-fork needs an active Herdr session (HERDR_PANE_ID is not set); the parent session is untouched",
      };
    }
    if (!fs.existsSync(this.launcherPath) || !fs.statSync(this.launcherPath).isFile()) {
      return {
        ok: false,
        outcome: "launcher_missing",
        phase: "validation",
        code: "launcher_missing",
        detail: this.launcherPath,
        hint: "the packaged pi-fork-launcher.sh was not found; nothing was created",
      };
    }

    if (args.placement === "tab") {
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
      // Observed response (live probe, 2026-10-07):
      //   result = { tab: { tab_id }, root_pane: { pane_id } }
      const res = await this.herdr(
        [
          "tab", "create",
          "--workspace", workspaceId,
          "--cwd", this.cwd,
          ...this.profileEnvArgs(),
          "--focus",
        ],
        { signal },
      );
      if (!res.ok) return this.transportFailure("tab_create", res);
      const result = res.doc?.result as Record<string, unknown> | undefined;
      const rootPane = (result?.root_pane ?? null) as Record<string, unknown> | null;
      const tab = (result?.tab ?? null) as Record<string, unknown> | null;
      const paneId = typeof rootPane?.pane_id === "string" ? rootPane.pane_id : "";
      const tabId = typeof tab?.tab_id === "string" ? tab.tab_id : "";
      if (paneId.length === 0 || tabId.length === 0) {
        return {
          ok: false,
          outcome: "error",
          phase: "tab_create",
          code: "tab_create_malformed",
          hint: "tab create did not return a valid tab/root pane; inspect the workspace manually",
          detail: JSON.stringify(res.doc?.result ?? null),
        };
      }
      return this.launchInto(paneId, args, signal, { placement: "tab", tab: tabId });
    }

    // right / down: split the parent pane itself; the split carries focus.
    const res = await this.herdr(
      [
        "pane", "split",
        this.paneId,
        "--direction", args.placement,
        "--cwd", this.cwd,
        ...this.profileEnvArgs(),
        "--focus",
      ],
      { signal },
    );
    if (!res.ok) return this.transportFailure("split", res);
    const splitResult = res.doc?.result as Record<string, unknown> | undefined;
    const splitPane = (splitResult?.pane ?? null) as Record<string, unknown> | null;
    const paneId = typeof splitPane?.pane_id === "string" ? splitPane.pane_id : "";
    if (paneId.length === 0 || paneId === this.paneId) {
      return {
        ok: false,
        outcome: "error",
        phase: "split",
        code: "split_malformed",
        hint: "pane split did not return a valid new pane; the parent pane is untouched — inspect the workspace manually",
        detail: JSON.stringify(res.doc?.result ?? null),
      };
    }
    return this.launchInto(paneId, args, signal, { placement: args.placement });
  }

  private async launchInto(
    paneId: string,
    args: { sessionFile: string; instruction?: string },
    signal: AbortSignal | undefined,
    labels: { placement: ForkPlacement; tab?: string },
  ): Promise<ForkResult> {
    // The launcher is executed by Herdr's `pane run`, which runs a single
    // command string in the pane's shell — same convention the core's
    // `pane run` wrapper invocation uses. Arbitrary input travels as
    // shell-quoted arguments; the argument array itself never crosses a shell.
    const command = [
      shellQuote(this.launcherPath),
      "--session-file", shellQuote(args.sessionFile),
      "--",
      ...(args.instruction !== undefined
        ? [shellQuote(args.instruction)]
        : []),
    ].join(" ");
    const res = await this.herdr(["pane", "run", paneId, command], { signal });
    if (!res.ok) return this.transportFailure("launch", res, { pane: paneId });
    if (signal?.aborted) return this.aborted("launch", paneId);
    return {
      ok: true,
      outcome: "forked",
      phase: "launch",
      pane: paneId,
      placement: labels.placement,
      ...(labels.tab !== undefined ? { tab: labels.tab } : {}),
      hint: "peer session only: not an owned subagent; no detection, rename or task delivery",
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
    labels: { pane?: string } = {},
  ): ForkResult {
    const code = res.error?.code ?? res.transportCode ?? (res.signal ? `killed_${res.signal}` : `exit_${res.exitCode}`);
    const message = res.error?.message ?? res.transportMessage ?? (res.text.trim() || `herdr exited ${res.exitCode}`);
    return {
      ok: false,
      outcome: "error",
      phase,
      code,
      ...(labels.pane !== undefined ? { pane: labels.pane } : {}),
      hint: `herdr ${phase} failed (${code}): ${message}; the parent session is untouched — inspect the workspace`,
    };
  }

  private aborted(phase: string, pane?: string): ForkResult {
    return {
      ok: false,
      outcome: "aborted",
      phase,
      ...(pane !== undefined ? { pane } : {}),
      code: "aborted",
      hint: "fork aborted before completion; inspect the workspace",
    };
  }
}

/** Default launcher location: the scripts directory next to this package root. */
export function defaultForkLauncherPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "scripts", "pi-fork-launcher.sh");
}
