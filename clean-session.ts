// Herdr transport for the /herdr-new-clean-session command
// (docs/feature-impl/20261108-herdr-new-clean-session/3_plan__herdr-new-clean-session.md).
//
// A clean-session Pi session is a PEER interactive session, not a managed
// worker and not a fork:
// - the pane is never recorded in SubagentService ownership,
// - no managed-Pi detection, rename, or agent-prompt delivery happens,
// - the launcher is this package's own `scripts/pi-cleansession-launcher.sh`,
//   which never sources the worker runtime and contains no
//   `.sub_agent_conf`, worker profile/model/tool or write-guard logic,
// - the new session is a plain `pi <instruction>` (no --session, no --fork);
//   the exported Markdown handoff file is its only memory.
//
// The conversion runs HANDLER-SIDE, BEFORE any Herdr call (plan §4):
//   1. pre-create the md file with mode 0600 (fs.openSync "w", 0o600)
//   2. spawn python3 <converterPath> --mode branch <sessionFile> -o <mdPath>
//      with { umask: 0o077 } (child_process, bounded output, no shell)
//   3. on any failure: delete partial file, outcome conversion_failed,
//      NO Herdr call was made
//   4. compose handoff instruction (always non-empty: fixed preamble +
//      optional user instruction appended after)
//   5. pane split --focus / tab create --focus (fork.ts choreography)
//   6. pane run <pane> "<launcher> -- [instruction...]"
//
// Reuses the Herdr CLI transport (process-array arguments, shellQuote /
// command-string convention) established by core.ts and transport.ts; the
// md path and instruction travel as shell-quoted arguments to the launcher,
// executed by Herdr's `pane run` (no blind keystroke injection).

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import {
  HerdrTransport,
  shellQuote,
  type Transport,
  type TransportResult,
  type TransportErrorName,
} from "./transport.js";

export type CleanSessionPlacement = "right" | "down" | "tab";

export interface CleanSessionOptions {
  /** In-process Herdr transport (tests); defaults to the real CLI. */
  transport?: Transport;
  /** Absolute path of the packaged pi-cleansession-launcher.sh. */
  launcherPath: string;
  /** Absolute path of the bundled pi-session-to-md converter. */
  converterPath: string;
  /** The HERDR_PANE_ID of the calling (parent) session. */
  paneId?: string;
  /** The calling session's working directory (ctx.cwd). */
  cwd?: string;
  /**
   * The command process's own environment (the handler must supply its
   * process env deliberately). Only PI_CODING_AGENT_DIR is read from it and
   * propagated to the clean-session pane/tab via `--env`; nothing else.
   * An empty or blank value counts as absent (no flag is emitted, no
   * default is substituted).
   */
  env?: NodeJS.ProcessEnv;
}

export interface CleanSessionResult {
  ok: boolean;
  outcome:
    | "clean_session"
    | "error"
    | "aborted"
    | "outside_herdr"
    | "launcher_missing"
    | "conversion_failed";
  phase: string;
  /** The peer pane that hosts the clean session. */
  pane?: string;
  /** The tab (tab:*) when placement is "tab". */
  tab?: string;
  placement?: CleanSessionPlacement;
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

/**
 * The fixed handoff preamble that is ALWAYS sent to the new clean session.
 * It names the md path and instructs the receiving agent to read it, continue
 * the prior work from there, and delete the file once absorbed. The user's
 * optional instruction is appended after this preamble (never before, never
 * instead of it).
 */
function buildHandoffInstruction(mdPath: string, userInstruction?: string): string {
  const preamble = [
    "Handoff from a prior Pi session. Read the exported transcript at:",
    mdPath,
    "Continue the prior work from there. Delete the file once you have absorbed its content.",
  ].join("\n");
  if (userInstruction !== undefined && userInstruction.trim().length > 0) {
    return `${preamble}\n\n${userInstruction}`;
  }
  return preamble;
}

export class HerdrCleanSessionService {
  private readonly transport: Transport;
  private readonly launcherPath: string;
  private readonly converterPath: string;
  private readonly paneId?: string;
  private readonly cwd: string;
  /**
   * The caller's exact PI_CODING_AGENT_DIR at service construction, or null
   * when the command process does not run under a named profile. This single
   * entry — and only this one — is propagated to every clean-session target
   * pane/tab via Herdr's `--env` option (pane split / tab create), which
   * sets the environment of the process Herdr launches there (the launcher,
   * and hence the `pi <instruction>` session). An absent value is NEVER
   * substituted with a default; the target simply inherits whatever Herdr
   * defaults to.
   */
  private readonly profileDir: string | null;
  private workspaceIdCache?: string;

  constructor(options: {
    transport?: Transport;
    launcherPath: string;
    converterPath: string;
    paneId?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  }) {
    this.transport = options.transport ?? new HerdrTransport();
    this.launcherPath = options.launcherPath;
    this.converterPath = options.converterPath;
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

  /**
   * Run the full clean-session choreography:
   *   1. validate (paneId, launcher, converter)
   *   2. pre-create md file (0600) + spawn python3 converter
   *   3. compose handoff instruction (always non-empty)
   *   4. pane split --focus / tab create --focus
   *   5. pane run <pane> "<launcher> -- <instruction>"
   *
   * Conversion runs BEFORE any Herdr call; on conversion failure the partial
   * file is deleted and `conversion_failed` is returned with no pane created.
   */
  async cleanSession(
    args: {
      sessionFile: string;
      placement: CleanSessionPlacement;
      instruction?: string;
    },
    signal?: AbortSignal,
  ): Promise<CleanSessionResult> {
    if (signal?.aborted) return this.aborted("pre");
    if (!this.paneId) {
      return {
        ok: false,
        outcome: "outside_herdr",
        phase: "context",
        code: "outside_herdr",
        hint: "herdr-new-clean-session needs an active Herdr session (HERDR_PANE_ID is not set); nothing was created",
      };
    }
    if (!fs.existsSync(this.launcherPath) || !fs.statSync(this.launcherPath).isFile()) {
      return {
        ok: false,
        outcome: "launcher_missing",
        phase: "validation",
        code: "launcher_missing",
        detail: this.launcherPath,
        hint: "the packaged pi-cleansession-launcher.sh was not found; nothing was created",
      };
    }

    // Conversion runs BEFORE any Herdr call (plan §4).
    const mdPath = path.join(tmpdir(), `pi-cleansession-${randomUUID()}.md`);

    // Pre-create the md file with mode 0600 (privacy from first byte).
    // The converter's open("w") truncates the existing file in place,
    // preserving its mode — session content is never world-readable.
    let fd: number;
    try {
      fd = fs.openSync(mdPath, "w", 0o600);
      fs.closeSync(fd);
    } catch {
      return {
        ok: false,
        outcome: "conversion_failed",
        phase: "conversion",
        code: "md_precreate_failed",
        detail: mdPath,
        hint: "could not pre-create the handoff md file (0600); nothing was created",
      };
    }

    if (signal?.aborted) {
      this.deleteQuiet(mdPath);
      return this.aborted("conversion");
    }

    const conv = await this.runConverter(args.sessionFile, mdPath, signal);
    if (conv.aborted) {
      this.deleteQuiet(mdPath);
      return this.aborted("conversion");
    }
    if (!conv.ok) {
      this.deleteQuiet(mdPath);
      return {
        ok: false,
        outcome: "conversion_failed",
        phase: "conversion",
        code: conv.code,
        detail: conv.detail,
        hint: `session-to-md conversion failed (${conv.code}); the partial md file was deleted; nothing was created`,
      };
    }

    // Verify the md file is non-empty (conversion produced output).
    if (!fs.existsSync(mdPath) || fs.statSync(mdPath).size === 0) {
      this.deleteQuiet(mdPath);
      return {
        ok: false,
        outcome: "conversion_failed",
        phase: "conversion",
        code: "empty_output",
        detail: mdPath,
        hint: "the converter produced no output; the partial md file was deleted; nothing was created",
      };
    }

    // Compose the handoff instruction (always non-empty).
    const instruction = buildHandoffInstruction(mdPath, args.instruction);

    // Now do the Herdr choreography (split/tab create + pane run).
    if (args.placement === "tab") {
      const workspaceId = await this.resolveOwnWorkspace(signal);
      if (signal?.aborted) {
        this.deleteQuiet(mdPath);
        return this.aborted("context");
      }
      if (!workspaceId) {
        this.deleteQuiet(mdPath);
        return {
          ok: false,
          outcome: "error",
          phase: "context",
          code: "workspace_unknown",
          hint: "the current workspace could not be resolved (pane get failed); nothing was created",
        };
      }
      // Observed response (live probe, fork precedent 2026-10-07):
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
      if (!res.ok) {
        this.deleteQuiet(mdPath);
        return this.transportFailure("tab_create", res);
      }
      const result = res.doc?.result as Record<string, unknown> | undefined;
      const rootPane = (result?.root_pane ?? null) as Record<string, unknown> | null;
      const tab = (result?.tab ?? null) as Record<string, unknown> | null;
      const paneId = typeof rootPane?.pane_id === "string" ? rootPane.pane_id : "";
      const tabId = typeof tab?.tab_id === "string" ? tab.tab_id : "";
      if (paneId.length === 0 || tabId.length === 0) {
        this.deleteQuiet(mdPath);
        return {
          ok: false,
          outcome: "error",
          phase: "tab_create",
          code: "tab_create_malformed",
          hint: "tab create did not return a valid tab/root pane; inspect the workspace manually",
          detail: JSON.stringify(res.doc?.result ?? null),
        };
      }
      return this.launchInto(paneId, mdPath, instruction, signal, {
        placement: "tab",
        tab: tabId,
      });
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
    if (!res.ok) {
      this.deleteQuiet(mdPath);
      return this.transportFailure("split", res);
    }
    const splitResult = res.doc?.result as Record<string, unknown> | undefined;
    const splitPane = (splitResult?.pane ?? null) as Record<string, unknown> | null;
    const paneId = typeof splitPane?.pane_id === "string" ? splitPane.pane_id : "";
    if (paneId.length === 0 || paneId === this.paneId) {
      this.deleteQuiet(mdPath);
      return {
        ok: false,
        outcome: "error",
        phase: "split",
        code: "split_malformed",
        hint: "pane split did not return a valid new pane; the parent pane is untouched — inspect the workspace manually",
        detail: JSON.stringify(res.doc?.result ?? null),
      };
    }
    return this.launchInto(paneId, mdPath, instruction, signal, {
      placement: args.placement,
    });
  }

  private async launchInto(
    paneId: string,
    mdPath: string,
    instruction: string,
    signal: AbortSignal | undefined,
    labels: { placement: CleanSessionPlacement; tab?: string },
  ): Promise<CleanSessionResult> {
    // The launcher is executed by Herdr's `pane run`, which runs a single
    // command string in the pane's shell — same convention the core's
    // `pane run` wrapper invocation uses. The instruction (always non-empty)
    // travels as a shell-quoted argument after the `--` marker; the md path
    // is embedded inside the instruction text, not passed as a separate
    // argument to the launcher (the launcher only takes `-- <instruction>`).
    const command = [
      shellQuote(this.launcherPath),
      "--",
      shellQuote(instruction),
    ].join(" ");
    const res = await this.herdr(["pane", "run", paneId, command], { signal });
    if (!res.ok) {
      // The md file is left on disk on launch failure: the new pane exists
      // and the receiving agent may still need the handoff. It will be
      // cleaned up by the OS tmp cleanup if the agent never deletes it.
      return this.transportFailure("launch", res, { pane: paneId });
    }
    if (signal?.aborted) {
      this.deleteQuiet(mdPath);
      return this.aborted("launch", paneId);
    }
    return {
      ok: true,
      outcome: "clean_session",
      phase: "launch",
      pane: paneId,
      placement: labels.placement,
      ...(labels.tab !== undefined ? { tab: labels.tab } : {}),
      hint: "peer session only: not an owned subagent; no detection, rename or task delivery",
    };
  }

  /**
   * Spawn the bundled converter: python3 <converterPath> --mode branch
   * <sessionFile> -o <mdPath>, with { umask: 0o077 } and
   * PYTHONDONTWRITEBYTECODE=1 (no __pycache__ bytecode is ever written into
   * the installed package's scripts directory). The md file was
   * pre-created with mode 0600; the converter's open("w") truncates it in
   * place, preserving its mode. Bounded output capture (512 KB each).
   */
  private runConverter(
    sessionFile: string,
    mdPath: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; aborted: boolean; code?: string; detail?: string }> {
    return new Promise((resolve) => {
      // { umask: 0o077 } is a valid spawn option at runtime (belt-and-braces
      // alongside the pre-created 0600 file); it is not yet typed in
      // @types/node 26, so cast through unknown.
      const child = spawn(
        "python3",
        [this.converterPath, "--mode", "branch", sessionFile, "-o", mdPath],
        { umask: 0o077, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } } as unknown as Parameters<typeof spawn>[2],
      );
      let stdout = "";
      let stderr = "";
      let stderrBytes = 0;
      const MAX_BUF = 512 * 1024;
      const onAbort = (): void => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout!.on("data", (chunk: Buffer) => {
        if (stdout.length < MAX_BUF) stdout += chunk.toString("utf8");
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        if (stderrBytes < MAX_BUF) {
          stderr += chunk.toString("utf8");
          stderrBytes += chunk.length;
        }
      });
      child.on("error", (err: Error) => {
        signal?.removeEventListener("abort", onAbort);
        resolve({ ok: false, aborted: false, code: "spawn_failed", detail: err.message });
      });
      child.on("close", (code: number | null) => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) {
          resolve({ ok: false, aborted: true });
          return;
        }
        if (code === 0) {
          resolve({ ok: true, aborted: false });
        } else {
          const detail = (stderr.trim() || stdout.trim() || `converter exited ${code}`).slice(0, 2048);
          resolve({ ok: false, aborted: false, code: `exit_${code}`, detail });
        }
      });
    });
  }

  private deleteQuiet(p: string): void {
    try {
      fs.unlinkSync(p);
    } catch {
      /* best effort */
    }
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
  ): CleanSessionResult {
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

  private aborted(phase: string, pane?: string): CleanSessionResult {
    return {
      ok: false,
      outcome: "aborted",
      phase,
      ...(pane !== undefined ? { pane } : {}),
      code: "aborted",
      hint: "clean session aborted before completion; inspect the workspace",
    };
  }
}

/** Default launcher location: the scripts directory next to this package root. */
export function defaultCleanSessionLauncherPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "scripts", "pi-cleansession-launcher.sh");
}

/** Default converter location: the scripts directory next to this package root. */
export function defaultCleanSessionConverterPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "scripts", "pi-session-to-md");
}
