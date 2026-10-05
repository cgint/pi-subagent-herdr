// Asynchronous Herdr CLI transport for the pi-subagent-herdr extension.
//
// Responsibilities: spawn `herdr` without a shell, cap combined output at a
// byte level (decoding UTF-8 across chunk boundaries via shared stream
// decoders), bound execution by a finite timeout, respect the caller's
// AbortSignal, and surface typed failures (timeout / output_overflow /
// aborted / spawn_error).
//
// Design constraints honoured (docs/findings.md, docs/plan_2_design.md,
// agent/core-review.md):
// - no shell interpretation (the herdr CLI performs its own shell-quoting)
// - the output bound counts COMBINED stdout+stderr BYTES; a truncated tail
//   does not fake a valid JSON envelope. On overflow the child is killed and
//   reaped promptly (not left to the timeout) and the overflow is the reason.
// - the process is awaited on `close` (stdio fully drained — authoritative),
//   with `exit` as fallback state capture
// - a timer-fired timeout is distinguished from an arbitrary signal
//   termination; only the timer's own kill is attributed to a timeout, never a
//   signal the child raised on its own
// - spawn failures (sync throw OR async `error` event) surface as SpawnError;
//   the transport never reports a false success (exitCode ?? 0) on error
// - every close / error / abort path removes its timers, listeners, and
//   stream handlers via a `finally` block, so reusing an AbortSignal across
//   runs never leaks listeners

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface TransportOptions {
  /** Abort the in-flight CLI invocation. */
  signal?: AbortSignal;
  /**
   * Finite execution ceiling in milliseconds. Defaults to
   * DEFAULT_COMMAND_TIMEOUT_MS. Must be a finite number > 0.
   */
  timeoutMs?: number;
  /**
   * Maximum captured COMBINED stdout+stderr output in BYTES (default: 2 MiB).
   * Must be a positive finite integer.
   */
  maxBytes?: number;
}

export interface TransportResult {
  /** Process exit code, or null when the process was terminated by a signal. */
  exitCode: number | null;
  /**
   * The POSIX signal that terminated the process, or null/undefined when it
   * exited normally (with an exit code). When the process was signalled,
   * `exitCode` is null — callers must not substitute a default of 0 for it.
   */
  signal?: NodeJS.Signals | null;
  /** Decoded stdout (UTF-8 across chunk boundaries, byte-capped). Preserved verbatim. */
  stdout: string;
  /** Decoded stderr. Preserved verbatim (diagnostics are kept distinct from the envelope). */
  stderr: string;
  /** Set when execution exceeded the timeout ceiling. */
  timedOut?: boolean;
  /** Set when captured output exceeded the byte cap. */
  truncated?: boolean;
}

export type TransportErrorName =
  | "TimeoutError"
  | "OutputOverflowError"
  | "AbortError"
  | "SpawnError";

/** A transport-level failure (distinct from a herdr CLI non-zero exit). */
export class TransportError extends Error {
  constructor(name: TransportErrorName, message: string) {
    super(message);
    this.name = name;
  }
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export interface Transport {
  run(args: string[], options?: TransportOptions): Promise<TransportResult>;
}

/** POSIX single-quote with the standard '\'' idiom for embedded quotes (no shell interpretation). */
export function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_\-./=+:@%^]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export class HerdrTransport implements Transport {
  readonly herdrPath: string;

  constructor(herdrPath: string = "herdr") {
    this.herdrPath = herdrPath;
  }

  async run(args: string[], options: TransportOptions = {}): Promise<TransportResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TransportError("SpawnError", "timeoutMs must be a finite number > 0");
    }
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isInteger(maxBytes) || !Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new TransportError("SpawnError", "maxBytes must be a positive finite integer");
    }
    const signal = options.signal;

    // Pre-empt abort: no process is spawned, nothing to clean up.
    if (signal?.aborted) {
      throw new TransportError("AbortError", "aborted before spawn");
    }

    // Shared UTF-8 decoders so multi-byte sequences that straddle chunk
    // boundaries decode correctly (a byte slice would corrupt them).
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    // COMBINED byte budget across both streams.
    let totalBytes = 0;
    let overflowed = false;
    let spawnError: Error | null = null;
    const spawnErr: { err: (Error & { code?: string }) | null } = { err: null };
    let timerFired = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(this.herdrPath, args, {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      // Synchronous spawn throw (e.g. invalid arguments).
      throw new TransportError(
        "SpawnError",
        `failed to spawn ${this.herdrPath}: ${(err as Error).message}`,
      );
    }

    // -- Abort -------------------------------------------------------------
    let aborted = false;
    const onAbort = (): void => {
      if (aborted) return;
      aborted = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    // -- Timeout (timer is the only source of a TimeoutError) ---------------
    const timeoutTimer = setTimeout(() => {
      timerFired = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    timeoutTimer.unref?.();

    // -- Output cap (combined stdout+stderr, kills + reaps on overflow) ------
    const killChild = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    };
    const onData = (which: "out" | "err", chunk: Buffer): void => {
      if (overflowed) return; // collection already stopped
      totalBytes += chunk.length;
      if (which === "out") {
        if (totalBytes <= maxBytes) stdout += outDecoder.write(chunk);
      } else {
        if (totalBytes <= maxBytes) stderr += errDecoder.write(chunk);
      }
      if (totalBytes > maxBytes && !overflowed) {
        // Overflow: stop collecting, kill and reap promptly, record reason.
        overflowed = true;
        killChild();
      }
    };
    child.stdout?.on("data", (c: Buffer) => onData("out", c));
    child.stderr?.on("data", (c: Buffer) => onData("err", c));

    // -- Await close (authoritative) with exit as fallback -------------------
    const result = await new Promise<{
      code: number | null;
      signalName: NodeJS.Signals | null;
    }>((resolve) => {
      let code: number | null = null;
      let signalName: NodeJS.Signals | null = null;
      let closed = false;

      const finish = (): void => {
        if (closed) return;
        closed = true;
        resolve({ code, signalName });
      };

      child.once("exit", (c, s) => {
        code = c ?? code;
        signalName = s ?? signalName;
      });
      child.once("close", (c, s) => {
        code = c ?? code;
        signalName = s ?? signalName;
        finish();
      });
      child.once("error", (err) => {
        // Async spawn failure (ENOENT, EACCES, E2BIG). Capture, kill, and let
        // close/exit settle the promise — the spawn error is preserved.
        spawnErr.err = err;
        killChild();
      });
    });

    // -- Flush + finally-guaranteed cleanup (runs on EVERY path) ------------
    try {
      stdout += outDecoder.end();
      stderr += errDecoder.end();
    } finally {
      clearTimeout(timeoutTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (child.stdout) {
        child.stdout.removeAllListeners();
        try {
          child.stdout.destroy();
        } catch {
          /* ignore */
        }
      }
      if (child.stderr) {
        child.stderr.removeAllListeners();
        try {
          child.stderr.destroy();
        } catch {
          /* ignore */
        }
      }
      child.removeAllListeners();
    }

    // -- Outcome classification ---------------------------------------------
    // Async spawn failure: preserve the error, never report a false success.
    if (spawnErr.err) {
      throw new TransportError(
        "SpawnError",
        `spawn ${this.herdrPath} failed: ${spawnErr.err.code ?? ""} ${spawnErr.err.message}`.trim(),
      );
    }
    // Aborted by the caller: the worker pane is untouched, the local CLI reaped.
    if (aborted || signal?.aborted) {
      throw new TransportError("AbortError", "aborted during CLI invocation");
    }
    // Overflow: kill reason wins over the signal name (the kill produced it).
    if (overflowed) {
      throw new TransportError(
        "OutputOverflowError",
        `CLI output exceeded ${maxBytes} combined bytes (output truncated)`,
      );
    }
    // Timeout: ONLY when our own timer fired. A signal the child raised on its
    // own (or an external kill) is not a timeout.
    if (timerFired) {
      throw new TransportError("TimeoutError", `CLI invocation exceeded ${timeoutMs}ms`);
    }

    // Preserve the raw streams exactly. The herdr CLI writes its JSON envelope
    // to stdout for success and to stderr for typed error envelopes (observed
    // contract, docs/evidence/stageA_agent_probe.json); deciding which stream
    // carries the envelope — and only on which exit class — is the protocol
    // boundary's job (core), never the transport's.
    //
    // `exitCode` stays null when the process was signalled (no exit code was
    // produced). The protocol boundary inspects `signal` so a signal-terminated
    // run is never mistaken for a successful (exit 0) envelope.
    return {
      exitCode: result.code,
      signal: result.signalName,
      stdout,
      stderr,
      timedOut: false,
      truncated: false,
    };
  }
}
