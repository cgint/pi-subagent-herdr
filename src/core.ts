// Asynchronous Herdr transport and lifecycle core for the pi-subagent-herdr
// extension. Implements the plan_2 lifecycle contract: start (split,
// task-free wrapper launch, detection poll, rename, agent prompt),
// prompt / read / wait / send / interrupt / list / spaces / close, ownership
// verification, safe external-target control, and truthful terminal outcomes.
//
// Design constraints honoured (docs/findings.md, docs/plan_2_design.md,
// agent/core-review.md):
// - task delivery via `agent prompt` post-detection, never positional payload
// - terminal-state waits race idle + done + blocked
// - seq-gated waits need delivery proof; timeout alone is not "working"
// - a bounded/finish prompt times out -> `timeout` with current get + tail;
//   timeout never implies the worker was working
// - delivery receipt is the real CLI `agent_prompted` response (type
//   `agent_prompted`), never an invented `prompt.sent` field
// - continuation is an opaque, server-owned id backed by service state; a
//   forged id is rejected, never minted
// - working evidence comes from an actual sampled `agent get` working state or
//   an explicit CLI working report — never inferred from a timeout
// - close only treats a typed `pane_not_found` as absence; transport/server/
//   abort errors are NOT absence; ownership is retained until verified gone
// - `pane close` on an already-gone owned pane is idempotent success
// - ownership is recorded immediately after split (including terminal/workspace
//   identity from `pane get`); pending-detection panes stay managed/closeable
// - split targets an explicit pane (positional / `--pane`), never `--current`
// - esc interrupts a turn; ctrl+d kills the session (never used here)
// - abort reaps only the local CLI process, never the worker pane

import fs from "node:fs";
import path from "node:path";
import {
  HerdrTransport,
  shellQuote,
  type Transport,
  type TransportResult,
  type TransportErrorName,
} from "./transport.js";

// ---------------------------------------------------------------------------
// Result / record types
// ---------------------------------------------------------------------------

export interface Result {
  ok: boolean;
  outcome: string;
  phase: string;
  pane_id?: string;
  workspace_id?: string;
  status?: string;
  seq?: number;
  tail?: string;
  code?: string;
  hint?: string;
  detail?: string;
  name?: string;
  /** Opaque continuation handle (server-owned). Pass to the wait operation. */
  continuation?: string;
  /** True when the returned pane is still owned/managed by this session. */
  owned?: boolean;
}

export interface OwnedRecord {
  pane_id: string;
  workspace_id: string;
  terminal_id?: string;
  name?: string;
  launched_at?: number;
  /** Session identity that owns this pane. */
  session?: string;
  /** True while the worker pane has not yet been agent-detected. */
  pending?: boolean;
}

/** Server-owned continuation state (backing the opaque id). */
export interface ContinuationState {
  pane_id: string;
  /** Frozen live identity captured when the continuation was minted/restored. */
  workspace_id: string;
  terminal_id?: string;
  name?: string;
  /** Frozen pre-submission seq baseline. */
  baseline_seq?: number;
  /** True only for a real `agent_prompted` receipt. */
  delivery_confirmed?: boolean;
  /** Receipt snapshot retained for completed-before-return fast cases. */
  receipt_seq?: number;
  receipt_state?: string;
  /** True only when a working state was actually sampled or CLI-reported. */
  working_observed: boolean;
  working_seq?: number;
  /** Latest observational snapshot seen while resuming the continuation. */
  state?: string;
  seq?: number;
}

export interface SubagentServiceOptions {
  transport?: Transport;
  runtimeDir?: string;
  paneId?: string;
  now?: () => number;
  /** Default timeout ceilings (ms). */
  defaults?: {
    detectionMs?: number;
    boundedWaitMs?: number;
    finishWaitMs?: number;
    maxWaitMs?: number;
    tailBoundedChars?: number;
    tailWaitChars?: number;
    readLines?: number;
    readChars?: number;
  };
  /** Directory of the herdr skill scripts (wrapper); defaults to runtimeDir. */
  scriptsDir?: string;
}

export const DEFAULTS = {
  detectionMs: 15_000,
  boundedWaitMs: 30_000,
  finishWaitMs: 30 * 60_000,
  maxWaitMs: 60 * 60_000,
  tailBoundedChars: 50,
  tailWaitChars: 2000,
  readLines: 100,
  readChars: 50_000,
};

const DETECTION_POLL_MS = 500;
const SAMPLE_POLL_MS = 200;
const TERMINAL_STATES = ["idle", "done", "blocked"];

// ---------------------------------------------------------------------------
// Small JSON helpers
// ---------------------------------------------------------------------------

function parseJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface AgentInfo {
  agent_status?: string;
  state_change_seq?: number;
  pane_id?: string;
  workspace_id?: string;
  terminal_id?: string;
  name?: string | null;
  agent?: string;
  agent_session?: { agent?: string; kind?: string; source?: string; value?: string };
}

/** A screen-detected Pi/idle may still retain submissions as startup drafts.
 * The installed reporter publishes its managed session only after Pi binds
 * the real editor submit handler; never send a launch task before that. */
function managedPiReady(agent: AgentInfo | null): boolean {
  const session = agent?.agent_session;
  return agent?.agent === "pi" && session?.agent === "pi"
    && session.source === "herdr:pi" && session.kind === "path"
    && typeof session.value === "string" && session.value.length > 0
    && agent.agent_status !== undefined && agent.agent_status !== "unknown";
}

interface PaneInfo {
  pane_id?: string;
  workspace_id?: string;
  terminal_id?: string;
  agent_status?: string;
  terminal_title?: string;
  focused?: boolean;
  name?: string | null;
}

function agentOf(doc: Record<string, unknown> | null): AgentInfo | null {
  if (!doc) return null;
  const result = doc.result as Record<string, unknown> | undefined;
  if (!result) return null;
  // `agent prompt` / `agent get` / `agent wait` all nest the agent under
  // `result.agent` (with `result.type` e.g. `agent_prompted` / `agent_info`).
  const value = result.agent;
  if (value && typeof value === "object") return value as AgentInfo;
  return null;
}

/** True when the CLI response is the real submission receipt. */
function isPromptReceipt(doc: Record<string, unknown> | null): boolean {
  if (!doc) return false;
  const result = doc.result as Record<string, unknown> | undefined;
  return result?.type === "agent_prompted";
}

function errorOf(doc: Record<string, unknown> | null): { code: string; message: string } | null {
  if (!doc) return null;
  const error = doc.error as { code?: unknown; message?: unknown } | undefined;
  if (!error) return null;
  return { code: String(error.code ?? "unknown"), message: String(error.message ?? "") };
}

function tailCodePoints(text: string, maxChars: number): string {
  const codePoints = Array.from(text);
  return codePoints.length > maxChars ? codePoints.slice(-maxChars).join("") : text;
}

/** Normalized result of a herdr CLI call (transport errors mapped into error/transportCode). */
interface HerdrReturn {
  ok: boolean;
  exitCode: number;
  /** Set when the CLI process was terminated by a signal (no exit code). */
  signal?: string;
  doc: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
  text: string;
  /** A typed transport-level failure (not a herdr CLI exit). */
  transportCode?: string;
  transportMessage?: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SubagentService {
  private readonly transport: Transport;
  private readonly scriptsDir: string;
  private readonly paneId?: string;
  private readonly now: () => number;
  private readonly defaults: typeof DEFAULTS;
  private readonly owned = new Map<string, OwnedRecord>();
  /** Recently closed pane ids remembered as tombstones for idempotent close. */
  private readonly retired = new Map<string, OwnedRecord>();
  private readonly targetLocks = new Map<string, Promise<unknown>>();
  /** Opaque continuation id -> server-owned continuation state. */
  private readonly continuations = new Map<string, ContinuationState>();
  private continuationCounter = 0;
  private workspaceIdCache?: string;

  constructor(options: SubagentServiceOptions = {}) {
    this.transport = options.transport ?? new HerdrTransport();
    this.scriptsDir = options.scriptsDir ?? options.runtimeDir ?? "";
    this.paneId = options.paneId;
    this.now = options.now ?? Date.now;
    const d = options.defaults ?? {};
    this.defaults = {
      detectionMs: d.detectionMs ?? DEFAULTS.detectionMs,
      boundedWaitMs: d.boundedWaitMs ?? DEFAULTS.boundedWaitMs,
      finishWaitMs: d.finishWaitMs ?? DEFAULTS.finishWaitMs,
      maxWaitMs: d.maxWaitMs ?? DEFAULTS.maxWaitMs,
      tailBoundedChars: d.tailBoundedChars ?? DEFAULTS.tailBoundedChars,
      tailWaitChars: d.tailWaitChars ?? DEFAULTS.tailWaitChars,
      readLines: d.readLines ?? DEFAULTS.readLines,
      readChars: d.readChars ?? DEFAULTS.readChars,
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async execute(
    operation: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<Result> {
    // Pre-call abort: return immediately, no herdr call.
    if (signal?.aborted) {
      return this.aborted("pre");
    }
    const handler: Record<string, (a: Record<string, unknown>, s?: AbortSignal) => Promise<Result>> = {
      start: (a, s) => this.start(a, s),
      prompt: (a, s) => this.prompt(a, s),
      read: (a, s) => this.read(a, s),
      wait: (a, s) => this.wait(a, s),
      send: (a, s) => this.send(a, s),
      interrupt: (a, s) => this.interrupt(a, s),
      list: (a, s) => this.list(a, s),
      spaces: (a, s) => this.spaces(a, s),
      close: (a, s) => this.close(a, s),
    };
    const fn = handler[operation];
    if (!fn) {
      return {
        ok: false,
        outcome: "error",
        phase: "validation",
        code: "invalid_operation",
        hint: `unknown operation "${operation}"; expected one of ${Object.keys(handler).join(", ")}`,
      };
    }
    return fn(args, signal);
  }

  /** Plain-JSON snapshot of owned pane records. */
  getOwned(): OwnedRecord[] {
    return [...this.owned.values()].map((r) => ({ ...r }));
  }

  /** Restore ownership records (e.g. from session persistence). */
  restoreOwned(records: unknown[]): void {
    this.owned.clear();
    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      const r = record as Partial<OwnedRecord>;
      if (typeof r.pane_id !== "string" || typeof r.workspace_id !== "string") continue;
      this.owned.set(r.pane_id, {
        pane_id: r.pane_id,
        workspace_id: r.workspace_id,
        terminal_id: typeof r.terminal_id === "string" ? r.terminal_id : undefined,
        name: typeof r.name === "string" ? r.name : undefined,
        launched_at: typeof r.launched_at === "number" ? r.launched_at : undefined,
        session: typeof r.session === "string" ? r.session : undefined,
        pending: r.pending === true,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Transport wrapper
  // -------------------------------------------------------------------------

  private async herdr(
    args: string[],
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
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
    // Envelope stream selection (the herdr CLI protocol boundary):
    //  - success (exit 0): the envelope is the JSON on stdout. Any stderr text
    //    is diagnostics only and never parsed as the envelope.
    //  - failure (exit 1): the typed error envelope is the JSON on stderr.
    //  - any other exit code: inspect stdout first (an error envelope may still
    //    be present there), falling back to stderr only when stdout has none.
    // The raw stdout/stderr are preserved verbatim on the transport result; this
    // selection is purely about which stream carries the typed envelope.
    const envelopeStream = success
      ? result.stdout
      : code === 1
        ? result.stderr
        : parseJson(result.stdout) !== null
          ? result.stdout
          : result.stderr;
    const doc = parseJson(envelopeStream);
    const error = errorOf(doc);
    return {
      ok: success,
      exitCode: code ?? -1,
      signal: result.signal ?? undefined,
      doc,
      error,
      text: envelopeStream,
    };
  }

  // -------------------------------------------------------------------------
  // Context / ownership
  // -------------------------------------------------------------------------

  private async resolveOwnWorkspace(signal?: AbortSignal): Promise<string | null> {
    if (this.workspaceIdCache) return this.workspaceIdCache;
    if (!this.paneId) return null;
    const res = await this.herdr(["pane", "get", this.paneId], { signal });
    const pane = (res.doc?.result as Record<string, unknown> | undefined)?.pane as PaneInfo | undefined;
    if (!res.ok || !pane?.workspace_id) return null;
    this.workspaceIdCache = pane.workspace_id;
    return pane.workspace_id;
  }

  private isOwned(paneId: string): OwnedRecord | undefined {
    return this.owned.get(paneId);
  }

  private isSelf(paneId: string): boolean {
    return this.paneId !== undefined && paneId === this.paneId;
  }

  private recordPending(
    paneId: string,
    workspaceId: string,
    identity?: { terminal_id?: string; name?: string },
  ): void {
    const existing = this.owned.get(paneId);
    this.owned.set(paneId, {
      pane_id: paneId,
      workspace_id: workspaceId,
      // Record the live terminal_id (and any name) from the split object so the
      // pending record already carries identity before the worker launches.
      terminal_id: identity?.terminal_id ?? existing?.terminal_id,
      name: identity?.name ?? existing?.name,
      session: existing?.session ?? this.paneId,
      launched_at: existing?.launched_at ?? this.now(),
      pending: true,
    });
  }

  /**
   * Verify live identity of an owned record: the pane must exist, be in the
   * recorded workspace, and (when recorded) carry the same terminal_id and
   * agent name. A mismatch/absent pane makes the record non-owned.
   */
  private async verifyOwnership(
    record: OwnedRecord,
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; agent: AgentInfo; pane: PaneInfo }
    | { ok: false; reason: string; agent: AgentInfo | null; pane: PaneInfo | null }
  > {
    const paneRes = await this.herdr(["pane", "get", record.pane_id], { signal });
    const pane = (paneRes.doc?.result as Record<string, unknown> | undefined)?.pane as PaneInfo | undefined;
    if (!paneRes.ok || !pane?.pane_id) {
      return { ok: false, reason: "pane_not_found_live", agent: null, pane: pane ?? null };
    }
    if (pane.workspace_id !== record.workspace_id) {
      return { ok: false, reason: "workspace_mismatch", agent: null, pane };
    }
    if (record.terminal_id && pane.terminal_id !== record.terminal_id) {
      return { ok: false, reason: "terminal_id_mismatch", agent: null, pane };
    }
    const agentRes = await this.herdr(["agent", "get", record.pane_id], { signal });
    const agent = agentOf(agentRes.doc);
    if (!agentRes.ok || !agent) {
      // Pane alive but agent undetectable: distinct failure class, not owned.
      return { ok: false, reason: "agent_not_detected", agent: null, pane };
    }
    if (record.terminal_id && agent.terminal_id !== record.terminal_id) {
      return { ok: false, reason: "terminal_id_mismatch", agent, pane };
    }
    if (record.name && agent.name !== null && agent.name !== undefined && agent.name !== record.name) {
      return { ok: false, reason: "name_mismatch", agent, pane };
    }
    // Refresh stale identity fields.
    if (agent.terminal_id) record.terminal_id = agent.terminal_id;
    if (typeof agent.name === "string" && agent.name) record.name = agent.name;
    record.pending = false;
    return { ok: true, agent, pane };
  }

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------

  private async start(args: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
    // Prevalidation (before any pane mutation).
    const name = typeof args.name === "string" ? args.name : "";
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) {
      return {
        ok: false, outcome: "error", phase: "validation",
        code: "invalid_name", hint: "name must match [a-z0-9][a-z0-9_-]{0,31}",
      };
    }
    const cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();
    if (!path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      return {
        ok: false, outcome: "error", phase: "validation",
        code: "invalid_cwd", hint: `cwd must be an existing absolute directory (got ${cwd})`,
      };
    }
    const mode = args.mode === undefined ? "readonly" : args.mode;
    if (mode !== "readonly" && mode !== "editable") {
      return {
        ok: false, outcome: "error", phase: "validation",
        code: "invalid_mode", hint: "mode must be 'readonly' or 'editable'",
      };
    }
    const task = typeof args.task === "string" ? args.task : "";
    if (task.length === 0) {
      return {
        ok: false, outcome: "error", phase: "validation",
        code: "task_required",
        hint: "task (non-empty string) is required; delivery happens via agent prompt after detection",
      };
    }
    const waitMode = args.waitMode === undefined ? "none" : args.waitMode;
    if (waitMode !== "none" && waitMode !== "bounded" && waitMode !== "finish") {
      return {
        ok: false, outcome: "error", phase: "validation",
        code: "invalid_wait_mode", hint: "waitMode must be 'none', 'bounded' or 'finish'",
      };
    }
    const timeoutMs =
      typeof args.timeoutMs === "number" && args.timeoutMs > 0
        ? args.timeoutMs
        : waitMode === "bounded"
          ? this.defaults.boundedWaitMs
          : waitMode === "finish"
            ? this.defaults.finishWaitMs
            : 0;
    if (waitMode !== "none" && timeoutMs > this.defaults.maxWaitMs) {
      return {
        ok: false, outcome: "error", phase: "validation",
        code: "timeout_too_large", hint: `timeoutMs must be <= ${this.defaults.maxWaitMs}`,
      };
    }
    const tailChars =
      typeof args.tailChars === "number" && args.tailChars >= 0
        ? args.tailChars
        : waitMode === "bounded"
          ? this.defaults.tailBoundedChars
          : this.defaults.tailWaitChars;

    // Check runtime BEFORE any herdr call (pure local check).
    const wrapper = this.scriptsDir
      ? path.join(this.scriptsDir, "herdr-worker.sh")
      : "herdr-worker.sh";
    if (!this.scriptsDir || !fs.existsSync(wrapper) || !fs.statSync(wrapper).isFile()) {
      return {
        ok: false, outcome: "error", phase: "validation",
        code: "runtime_missing",
        hint: `worker wrapper not found at ${wrapper}; set runtimeDir or PI_SUBAGENT_RUNTIME_DIR to the skill scripts directory`,
      };
    }
    if (signal?.aborted) return this.aborted("validation");

    const workspaceId = await this.resolveOwnWorkspace(signal);
    if (!workspaceId) {
      return {
        ok: false, outcome: "error", phase: "validation",
        code: "herdr_context_missing",
        hint: "no HERDR_PANE_ID (or pane lookup failed); supervisor must run inside a herdr pane",
      };
    }

    // 1) Split a new sibling pane off the SUPERVISOR pane (explicit positional
    //    pane id, never --current).
    const splitRes = await this.herdr(
      [
        "pane", "split",
        this.paneId ?? "",
        "--direction", "right",
        "--cwd", cwd,
        "--no-focus",
      ],
      { signal },
    );
    if (!splitRes.ok) {
      return this.transportFailure("split", splitRes);
    }
    // ACTUAL recorded shape (docs/evidence/stageA_pane_split.json):
    //   result = { type: "pane_info", pane: { pane_id, workspace_id,
    //                                          terminal_id, agent_status, ... } }
    // i.e. a SINGLE pane object, not a `panes` array. We trust only that object.
    const splitResult = splitRes.doc?.result as Record<string, unknown> | undefined;
    const splitPane = (splitResult?.pane ?? null) as PaneInfo | null;
    if (!splitPane || typeof splitPane.pane_id !== "string" || splitPane.pane_id.length === 0) {
      // Malformed / unexpected split response: do NOT launch, do NOT record
      // ownership, do NOT infer a fake list fallback. Surface the uncertainty.
      return {
        ok: false, outcome: "error", phase: "split",
        code: "split_malformed",
        hint: "pane split response did not carry a valid result.pane; inspect the workspace and do not re-launch",
        detail: JSON.stringify(splitRes.doc?.result ?? null),
      };
    }
    const paneId = splitPane.pane_id;
    // Safety: never treat the supervisor's own pane as the new worker, and only
    // trust a pane in the supervisor's workspace.
    if (paneId === this.paneId) {
      return {
        ok: false, outcome: "error", phase: "split",
        code: "split_self_target",
        hint: "pane split reported the supervisor's own pane; do not launch into self",
      };
    }
    if (splitPane.workspace_id !== undefined && splitPane.workspace_id !== workspaceId) {
      return {
        ok: false, outcome: "error", phase: "split",
        code: "split_workspace_mismatch",
        hint: `pane split landed in workspace ${splitPane.workspace_id}, expected ${workspaceId}; not adopted as owned`,
      };
    }

    // Record ownership IMMEDIATELY (pending) with the live identity from the
    // split object, so the pane stays managed/closeable even before the worker
    // launches and even if detection never completes.
    this.recordPending(paneId, workspaceId, {
      terminal_id: splitPane.terminal_id,
      name: splitPane.name ?? undefined,
    });

    // 2) Launch the task-free wrapper: `herdr-worker.sh --mode <mode> --`.
    const command = `${shellQuote(wrapper)} --mode ${mode} --`;
    const runRes = await this.herdr(["pane", "run", paneId, command], { signal });
    if (!runRes.ok) {
      // Launch failed: attempt to close the half-created pane. Retain ownership
      // if absence is unverified; only drop it on a verified gone result.
      const closed = await this.closePane(paneId, signal);
      if (!closed.ok) {
        // Absence unverified: keep the pane owned (it may still exist).
        return this.transportFailure("launch", runRes, { pane_id: paneId });
      }
      this.owned.delete(paneId);
      return this.transportFailure("launch", runRes, { pane_id: paneId });
    }
    if (signal?.aborted) {
      return this.aborted("launch", paneId, workspaceId);
    }

    // 3) Wait for authoritative managed Pi readiness, not screen heuristics.
    const detectionRes = await this.waitForDetection(paneId, this.defaults.detectionMs, signal);
    const detected = managedPiReady(detectionRes.agent);
    if (signal?.aborted) {
      return this.aborted("detection", paneId, workspaceId, detectionRes.agent ?? undefined);
    }
    if (!detected) {
      // Missing detection is not automatically a runtime crash: the pane stays
      // owned (managed) for inspection, never auto-retried.
      return {
        ok: false, outcome: "detection_timeout", phase: "detection",
        pane_id: paneId, workspace_id: workspaceId,
        status: detectionRes.agent?.agent_status ?? "unknown",
        seq: detectionRes.agent?.state_change_seq,
        code: "agent_not_found",
        owned: true,
        hint: "managed Pi session readiness was not established within the detection window; no task sent; pane remains owned for inspection or closure",
      };
    }

    // 4) Rename the agent so it carries its identity.
    const renameRes = await this.herdr(["agent", "rename", paneId, name], { signal });
    if (!renameRes.ok) {
      return {
        ok: false, outcome: "error", phase: "rename",
        pane_id: paneId, workspace_id: workspaceId,
        status: detectionRes.agent?.agent_status,
        seq: detectionRes.agent?.state_change_seq,
        code: renameRes.error?.code ?? "rename_failed",
        detail: renameRes.error?.message,
        hint: "agent detected and launched, but rename failed; the pane is live and can be controlled by pane id",
      };
    }

    // Promote the pending record to a verified ownership record.
    const record: OwnedRecord = {
      pane_id: paneId,
      workspace_id: workspaceId,
      terminal_id: detectionRes.agent?.terminal_id ?? undefined,
      name,
      launched_at: this.owned.get(paneId)?.launched_at ?? this.now(),
      session: this.paneId,
      pending: false,
    };
    this.owned.set(paneId, record);

    // 5) Deliver the task via agent prompt (post-detection, all modes).
    return this.promptAfterLaunch(record, task, waitMode, timeoutMs, tailChars, detectionRes.agent, signal);
  }

  private async promptAfterLaunch(
    record: OwnedRecord,
    task: string,
    waitMode: "none" | "bounded" | "finish",
    timeoutMs: number,
    tailChars: number,
    preflight: AgentInfo | null,
    signal?: AbortSignal,
  ): Promise<Result> {
    if (preflight?.agent_status === "working" || preflight?.agent_status === "blocked") {
      return {
        ok: false, outcome: "prompt_refused", phase: "submission",
        pane_id: record.pane_id, workspace_id: record.workspace_id,
        status: preflight.agent_status, seq: preflight.state_change_seq,
        code: preflight.agent_status === "blocked" ? "agent_blocked" : "agent_working",
        hint: "worker is already working/blocked; inspect before prompting",
      };
    }
    return this.runPrompt(record.pane_id, task, waitMode, timeoutMs, tailChars, signal);
  }

  private async waitForDetection(
    paneId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ agent: AgentInfo | null; error: { code: string; message: string } | null }> {
    const deadline = this.now() + timeoutMs;
    let last: AgentInfo | null = null;
    let lastError: { code: string; message: string } | null = null;
    for (;;) {
      if (signal?.aborted) break;
      const res = await this.herdr(["agent", "get", paneId], { signal });
      if (res.error?.code === "aborted") break;
      if (res.ok) {
        last = agentOf(res.doc) ?? null;
        lastError = null;
        if (managedPiReady(last)) break;
      } else {
        lastError = res.error;
      }
      if (this.now() >= deadline) break;
      await this.sleep(DETECTION_POLL_MS, signal);
    }
    return { agent: last, error: lastError };
  }

  // -------------------------------------------------------------------------
  // prompt
  // -------------------------------------------------------------------------

  async prompt(args: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
    const target = typeof args.target === "string" ? args.target : "";
    if (!target) {
      return { ok: false, outcome: "error", phase: "validation", code: "target_required" };
    }
    if (this.isSelf(target)) {
      return {
        ok: false, outcome: "denied", phase: "validation", code: "self_control",
        hint: "supervisor cannot prompt itself",
      };
    }
    const task = typeof args.task === "string" ? args.task : "";
    if (!task) {
      return { ok: false, outcome: "error", phase: "validation", code: "task_required" };
    }
    const waitMode = args.waitMode === undefined ? "none" : args.waitMode;
    if (waitMode !== "none" && waitMode !== "bounded" && waitMode !== "finish") {
      return { ok: false, outcome: "error", phase: "validation", code: "invalid_wait_mode" };
    }
    const timeoutMs =
      typeof args.timeoutMs === "number" && args.timeoutMs > 0
        ? args.timeoutMs
        : waitMode === "bounded"
          ? this.defaults.boundedWaitMs
          : waitMode === "finish"
            ? this.defaults.finishWaitMs
            : 0;
    if (waitMode !== "none" && timeoutMs > this.defaults.maxWaitMs) {
      return { ok: false, outcome: "error", phase: "validation", code: "timeout_too_large" };
    }
    const tailChars =
      typeof args.tailChars === "number" && args.tailChars >= 0
        ? args.tailChars
        : waitMode === "bounded"
          ? this.defaults.tailBoundedChars
          : this.defaults.tailWaitChars;

    const access = await this.checkControlAccess(target, args, "prompt", signal);
    if (!access.ok) return access.result;

    // Serialize extension-controlled submissions per target.
    const prev = this.targetLocks.get(target) ?? Promise.resolve();
    const run = prev.then(() =>
      this.runPrompt(target, task, waitMode, timeoutMs, tailChars, signal),
    );
    this.targetLocks.set(target, run.catch(() => {}));
    return run;
  }

  private async runPrompt(
    target: string,
    task: string,
    waitMode: "none" | "bounded" | "finish",
    timeoutMs: number,
    tailChars: number,
    signal: AbortSignal | undefined,
  ): Promise<Result> {
    // Preflight: refuse working/blocked.
    const pre = await this.herdr(["agent", "get", target], { signal });
    if (!pre.ok) return this.transportFailure("preflight", pre, { pane_id: target });
    const preAgent = agentOf(pre.doc);
    if (!preAgent) {
      return {
        ok: false, outcome: "error", phase: "preflight",
        code: "agent_not_found", pane_id: target,
        hint: "target agent not detected; inspect pane before prompting",
      };
    }
    if (preAgent.agent_status === "working" || preAgent.agent_status === "blocked") {
      return {
        ok: false, outcome: "prompt_refused", phase: "preflight",
        pane_id: target, status: preAgent.agent_status, seq: preAgent.state_change_seq,
        code: preAgent.agent_status === "blocked" ? "agent_blocked" : "agent_working",
        hint: "target is already working or blocked; do not submit (external senders remain a race)",
      };
    }

    if (!managedPiReady(preAgent)) {
      return {
        ok: false, outcome: "prompt_refused", phase: "preflight",
        pane_id: target, code: "agent_not_ready",
        hint: "authoritative managed Pi session readiness is required; no task sent",
      };
    }
    const phase = "submission";
    const waitBounded = waitMode !== "none";
    // Submit. Bounded/finish use --wait bounded by --timeout; none submits once
    // and returns the receipt (submission receipt, not completion).
    const cmd: string[] = ["agent", "prompt", target, task];
    if (waitBounded) {
      cmd.push("--wait", "--timeout", String(timeoutMs));
    }

    // Concurrent working-evidence sampler (bounded/finish only): samples real
    // `agent get` working states. It is STOPPED when the prompt returns — we
    // never keep polling after the CLI returned.
    let workingSample: { status: string; seq: number } | null = null;
    let sampler: { promise: Promise<{ status: string; seq: number } | null>; stop: () => void } | undefined;
    if (waitBounded) {
      sampler = this.startWorkingSampler(target, timeoutMs, signal);
      sampler.promise.then((s) => {
        if (s && !workingSample) workingSample = s;
      });
    }

    const res = await this.herdr(cmd, {
      signal,
      timeoutMs: waitBounded ? timeoutMs + 5_000 : undefined,
    });
    // The sampler stops the moment the prompt returns (or aborts).
    if (sampler) {
      sampler.stop();
      await sampler.promise.catch(() => {});
    }

    // Abort: delivery unknown (an in-flight abort does not prove not-sent).
    if (res.error?.code === "aborted" || res.transportCode === "aborted") {
      return {
        ok: false, outcome: "cancelled", phase,
        pane_id: target, status: preAgent.agent_status, seq: preAgent.state_change_seq,
        code: "aborted",
        hint: "aborted during submission; delivery unknown — verify with agent read before any resend",
      };
    }

    if (!res.ok) {
      const code = res.error?.code ?? res.transportCode ?? "prompt_failed";
      if (code === "agent_prompt_stalled" || code === "timeout") {
        // Timeout/stall: include current get + tail. A timeout is NOT working
        // evidence. If the sampler caught a real working sample, the
        // continuation records it; otherwise working_observed stays false.
        const after = await this.agentGet(target, signal);
        const tail = await this.readTail(target, tailChars, this.defaults.readLines, signal);
        const cont = this.mintContinuation(target, preAgent, workingSample, after ?? null, false);
        return {
          ok: false,
          outcome: code === "agent_prompt_stalled" ? "stalled" : "timeout",
          phase,
          pane_id: target,
          status: after?.agent_status,
          seq: after?.state_change_seq,
          tail: tail.text,
          detail: tail.error ?? tail.hint,
          code,
          hint: "submission may have been accepted but the turn did not reach a terminal state within the window; inspect, do not auto-resend",
          continuation: cont,
        };
      }
      return this.transportFailure(phase, res, { pane_id: target });
    }

    // Success path: only a real `agent_prompted` receipt is a delivery receipt.
    if (!isPromptReceipt(res.doc)) {
      return this.transportFailure(phase, res, { pane_id: target });
    }
    const agent = agentOf(res.doc) ?? preAgent;
    const cont = this.mintContinuation(target, preAgent, workingSample, agent, true);

    if (waitMode === "none") {
      return {
        ok: true, outcome: "submitted", phase,
        pane_id: target, status: agent.agent_status, seq: agent.state_change_seq,
        code: "agent_prompted",
        hint: "submission receipt (agent_prompted); the turn has not completed",
        continuation: cont,
      };
    }
    if (!TERMINAL_STATES.includes(agent.agent_status ?? "")) {
      return {
        ok: false, outcome: "error", phase,
        pane_id: target, status: agent.agent_status, seq: agent.state_change_seq,
        code: "unexpected_wait_state",
        hint: "agent prompt --wait returned a non-terminal state; submission confirmed, inspect before re-waiting",
        continuation: cont,
      };
    }
    // Both finish and fast bounded observations return the requested snapshot.
    // A console failure is explicit; it does not erase the terminal observation.
    const tail = await this.readTail(target, tailChars, this.defaults.readLines, signal);
    const terminalConsole = { tail: tail.text, detail: tail.error ?? tail.hint };
    // Terminal state reached via --wait. blocked != completion.
    const status = agent.agent_status;
    if (status === "blocked") {
      return {
        ok: false, outcome: "needs_attention", phase,
        pane_id: target, status, seq: agent.state_change_seq,
        ...terminalConsole,
        code: "agent_blocked",
        hint: "agent blocked (may be a write-guard success in readonly mode); inspect",
        continuation: cont,
      };
    }
    return {
      ok: true,
      outcome: workingSample ? "terminal_observed_after_working" : "terminal_observed",
      phase,
      pane_id: target, status: status ?? "unknown", seq: agent.state_change_seq,
      ...terminalConsole,
      code: status ?? "terminal",
      hint: "terminal state observed, not task completion; verify task-specific output",
      continuation: cont,
    };
  }

  /** Start a bounded working-evidence sampler with an explicit stop(). */
  private startWorkingSampler(
    target: string,
    budgetMs: number,
    signal: AbortSignal | undefined,
  ): { promise: Promise<{ status: string; seq: number } | null>; stop: () => void } {
    let stopped = false;
    const promise = (async () => {
      const deadline = this.now() + Math.max(1000, budgetMs);
      while (!stopped && this.now() < deadline && !signal?.aborted) {
        const res = await this.herdr(["agent", "get", target], { signal });
        if (res.error?.code === "aborted") return null;
        if (stopped) return null;
        const agent = agentOf(res.doc);
        if (agent?.agent_status === "working") {
          return { status: "working", seq: agent.state_change_seq ?? -1 };
        }
        await this.sleep(SAMPLE_POLL_MS, signal);
      }
      return null;
    })();
    return {
      promise,
      stop: () => {
        stopped = true;
      },
    };
  }

  /** Mint an opaque, server-owned continuation id backed by service state. */
  private mintContinuation(
    target: string,
    baseline: AgentInfo | null,
    workingSample: { status: string; seq: number } | null,
    current: AgentInfo | null,
    deliveryConfirmed: boolean,
  ): string {
    const reportedWorking =
      current?.agent_status === "working" && typeof current.state_change_seq === "number"
        ? { status: "working", seq: current.state_change_seq }
        : null;
    const observedWorking = workingSample ?? reportedWorking;
    const state: ContinuationState = {
      pane_id: target,
      workspace_id: this.owned.get(target)?.workspace_id ?? baseline?.workspace_id ?? current?.workspace_id ?? "",
      terminal_id: this.owned.get(target)?.terminal_id ?? baseline?.terminal_id ?? current?.terminal_id,
      name: current?.name ?? baseline?.name ?? undefined,
      baseline_seq: baseline?.state_change_seq ?? current?.state_change_seq,
      delivery_confirmed: deliveryConfirmed,
      receipt_seq: deliveryConfirmed ? current?.state_change_seq : undefined,
      receipt_state: deliveryConfirmed ? current?.agent_status : undefined,
      working_observed: observedWorking !== null,
      working_seq: observedWorking?.seq,
      state: current?.agent_status,
      seq: current?.state_change_seq,
    };
    this.continuationCounter += 1;
    const id = `cont_${this.continuationCounter}_${Buffer.from(
      JSON.stringify([target, state.seq ?? 0, this.continuationCounter]),
    )
      .toString("hex")
      .slice(0, 12)}`;
    this.continuations.set(id, state);
    return id;
  }

  /**
   * Mint an opaque, server-owned continuation id from explicit state.
   * Backs a prior submission so a later `wait` can continue from it.
   * (Public so tests can seed working-evidence state and so session restore
   * can re-register a continuation across reload.)
   */
  registerContinuation(state: ContinuationState): string {
    const reportedWorking =
      state.state === "working" && typeof state.seq === "number"
        ? state.seq
        : undefined;
    const normalized: ContinuationState = {
      ...state,
      delivery_confirmed: state.delivery_confirmed === true,
      receipt_seq:
        typeof state.receipt_seq === "number"
          ? state.receipt_seq
          : state.delivery_confirmed === true
            ? state.seq
            : undefined,
      receipt_state:
        typeof state.receipt_state === "string"
          ? state.receipt_state
          : state.delivery_confirmed === true
            ? state.state
            : undefined,
      working_observed:
        state.working_observed === true || typeof state.working_seq === "number" || reportedWorking !== undefined,
      working_seq:
        typeof state.working_seq === "number"
          ? state.working_seq
          : reportedWorking,
    };
    this.continuationCounter += 1;
    const id = `cont_${this.continuationCounter}_${Buffer.from(
      JSON.stringify([normalized.pane_id, normalized.seq ?? 0, this.continuationCounter]),
    )
      .toString("hex")
      .slice(0, 12)}`;
    this.continuations.set(id, normalized);
    return id;
  }

  private resolveContinuation(id: unknown): ContinuationState | undefined {
    if (typeof id !== "string") return undefined;
    return this.continuations.get(id);
  }

  private continuationIdentityFailure(target: string, hint: string): Result {
    return {
      ok: false, outcome: "error", phase: "identity",
      code: "identity_mismatch", pane_id: target, hint,
    };
  }

  private continuationIdentityMismatch(cont: ContinuationState, agent: AgentInfo): string | undefined {
    if (cont.workspace_id && cont.workspace_id !== agent.workspace_id) {
      return agent.workspace_id ? "workspace changed since submission" : "workspace identity missing; cannot verify submission target";
    }
    if (cont.terminal_id && cont.terminal_id !== agent.terminal_id) {
      return agent.terminal_id ? "terminal id changed since submission; not the same agent" : "terminal identity missing; cannot verify submission target";
    }
    return undefined;
  }

  private continuationTerminalBaseline(cont: ContinuationState): number | undefined {
    if (typeof cont.working_seq === "number") return cont.working_seq;
    if (typeof cont.baseline_seq === "number") return cont.baseline_seq;
    if (typeof cont.receipt_seq === "number") return cont.receipt_seq;
    return cont.seq;
  }

  private continuationTerminalObserved(cont: ContinuationState, agent: AgentInfo): boolean {
    if (!TERMINAL_STATES.includes(agent.agent_status ?? "")) return false;
    if (typeof agent.state_change_seq !== "number") return false;
    const baseline = this.continuationTerminalBaseline(cont);
    return typeof baseline === "number" ? agent.state_change_seq > baseline : false;
  }

  private continuationAfterWorking(cont: ContinuationState, agent: AgentInfo): boolean {
    return cont.delivery_confirmed === true
      && cont.working_observed
      && typeof cont.working_seq === "number"
      && typeof agent.state_change_seq === "number"
      && agent.state_change_seq > cont.working_seq
      && agent.agent_status !== "blocked";
  }

  private recordContinuationObservation(id: string, agent: AgentInfo | null): string {
    const cont = this.continuations.get(id);
    if (cont && agent) {
      cont.state = agent.agent_status;
      cont.seq = agent.state_change_seq;
      if (agent.agent_status === "working" && typeof agent.state_change_seq === "number") {
        cont.working_observed = true;
        if (typeof cont.working_seq !== "number" || agent.state_change_seq > cont.working_seq) {
          cont.working_seq = agent.state_change_seq;
        }
      }
    }
    return id;
  }

  private async continuationTerminalResult(
    target: string,
    contId: string,
    cont: ContinuationState,
    agent: AgentInfo,
    tailChars: number,
    signal: AbortSignal | undefined,
  ): Promise<Result> {
    const tail = await this.readTail(target, tailChars, this.defaults.readLines, signal);
    const afterWorking = this.continuationAfterWorking(cont, agent);
    const blocked = agent.agent_status === "blocked";
    return {
      ok: !blocked,
      outcome: blocked ? "needs_attention" : afterWorking ? "terminal_observed_after_working" : "terminal_observed",
      phase: "wait",
      pane_id: target,
      status: agent.agent_status,
      seq: agent.state_change_seq,
      tail: tail.text,
      code: afterWorking ? "activity" : cont.delivery_confirmed === true ? "terminal_observed" : "activity",
      hint: afterWorking
        ? "terminal state observed after confirmed delivery and recorded working evidence; verify task-specific output"
        : cont.delivery_confirmed === true
          ? "terminal state observed after confirmed delivery, but without recorded working evidence this remains observational; verify task-specific output"
          : "terminal state observed after newer activity; delivery was not confirmed, so this is not proof of the same task",
      continuation: this.recordContinuationObservation(contId, agent),
    };
  }

  // -------------------------------------------------------------------------
  // read
  // -------------------------------------------------------------------------

  async read(args: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
    const target = typeof args.target === "string" ? args.target : "";
    if (!target) {
      return { ok: false, outcome: "error", phase: "validation", code: "target_required" };
    }
    const raw = args.raw === true;
    const lines =
      typeof args.lines === "number" && args.lines > 0 && args.lines <= 500
        ? Math.floor(args.lines)
        : this.defaults.readLines;
    const maxChars =
      typeof args.maxChars === "number" && args.maxChars > 0
        ? args.maxChars
        : this.defaults.readChars;

    if (raw) {
      const res = await this.herdr(["pane", "read", target, "--lines", String(lines)], { signal });
      if (!res.ok) return this.transportFailure("read", res, { pane_id: target });
      return {
        ok: true, outcome: "read", phase: "read",
        pane_id: target,
        tail: tailCodePoints(res.text, maxChars),
      };
    }
    const { res, hint } = await this.readConsole(target, lines, signal);
    if (!res.ok) {
      if (res.error?.code === "agent_not_found") {
        return {
          ok: false, outcome: "error", phase: "read", pane_id: target,
          code: "agent_not_found",
          hint: "agent not detected; use raw:true (pane read) or check agent get",
        };
      }
      return this.transportFailure("read", res, { pane_id: target });
    }
    const readResult = res.doc?.result as Record<string, unknown> | undefined;
    const text = typeof readResult?.text === "string" ? readResult.text : res.text;
    return {
      ok: true, outcome: "read", phase: "read",
      pane_id: target,
      tail: tailCodePoints(text, maxChars),
      hint,
    };
  }

  private async readConsole(target: string, lines: number, signal: AbortSignal | undefined): Promise<{ res: HerdrReturn; hint?: string }> {
    const args = ["agent", "read", target, "--lines", String(lines), "--source", "recent-unwrapped", "--format", "text"];
    const res = await this.herdr(args, { signal });
    if (res.error?.code !== "agent_not_idle" || signal?.aborted) return { res };
    // Herdr cannot scroll active alternate-screen history. Its documented
    // visible source reads the current viewport without scrolling the worker.
    args[args.indexOf("--source") + 1] = "visible";
    return {
      res: await this.herdr(args, { signal }),
      hint: "active alternate-screen history unavailable; console snapshot uses visible viewport",
    };
  }

  private async readTail(
    target: string,
    chars: number,
    lines: number,
    signal: AbortSignal | undefined,
  ): Promise<{ text: string | undefined; error?: string; hint?: string }> {
    try {
      const { res, hint } = await this.readConsole(target, lines, signal);
      if (!res.ok) return {
        text: undefined,
        error: `console read failed (${res.error?.code ?? res.transportCode ?? `exit_${res.exitCode}`}): ${res.error?.message ?? res.transportMessage ?? res.text}`,
      };
      const readResult = res.doc?.result as Record<string, unknown> | undefined;
      const text = typeof readResult?.text === "string" ? readResult.text : res.text;
      return { text: tailCodePoints(text, chars), hint };
    } catch (err) {
      return { text: undefined, error: `console read failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // -------------------------------------------------------------------------
  // wait
  // -------------------------------------------------------------------------

  async wait(args: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
    const target = typeof args.target === "string" ? args.target : "";
    if (!target) {
      return { ok: false, outcome: "error", phase: "validation", code: "target_required" };
    }
    const timeoutMs =
      typeof args.timeoutMs === "number" && args.timeoutMs > 0
        ? Math.min(args.timeoutMs, this.defaults.maxWaitMs)
        : this.defaults.finishWaitMs;
    const tailChars =
      typeof args.tailChars === "number" && args.tailChars >= 0
        ? args.tailChars
        : this.defaults.tailWaitChars;
    const deadline = this.now() + timeoutMs;

    const contId = args.continuation as string | undefined;
    // Resolve the opaque continuation. Unknown / forged ids are rejected,
    // never minted — a forged id cannot create working evidence.
    const cont = contId !== undefined ? this.resolveContinuation(contId) : undefined;
    if (contId !== undefined && !cont) {
      return {
        ok: false, outcome: "error", phase: "validation",
        code: "unknown_continuation", pane_id: target,
        hint: "continuation id is not recognized (unknown or forged); a prior subagent_prompt/wait must have issued it",
      };
    }
    if (cont && cont.pane_id !== target) {
      return {
        ok: false, outcome: "error", phase: "validation",
        code: "continuation_target_mismatch", pane_id: target,
        hint: "continuation was issued for a different pane than the wait target",
      };
    }

    const pre = await this.agentGet(target, signal);
    if (pre === undefined) {
      return {
        ok: false, outcome: "error", phase: "preflight",
        code: "agent_not_found", pane_id: target,
        hint: "target agent not detected",
      };
    }

    if (cont) {
      const mismatch = this.continuationIdentityMismatch(cont, pre);
      if (mismatch) return this.continuationIdentityFailure(target, mismatch);
      this.recordContinuationObservation(contId!, pre);
      if (this.continuationTerminalObserved(cont, pre)) {
        return this.continuationTerminalResult(target, contId!, cont, pre, tailChars, signal);
      }
      if (TERMINAL_STATES.includes(pre.agent_status ?? "")) {
        return this.waitForContinuationProgress(target, contId!, deadline, tailChars, signal);
      }
    } else if (pre.agent_status && pre.agent_status !== "unknown") {
      // Without baseline: current terminal state is a SNAPSHOT — labelled as
      // such. This call did not observe the turn; it cannot imply a new turn.
      if (TERMINAL_STATES.includes(pre.agent_status)) {
        const tail = await this.readTail(target, tailChars, this.defaults.readLines, signal);
        return {
          ok: pre.agent_status !== "blocked",
          outcome: pre.agent_status === "blocked" ? "needs_attention" : "terminal_observed",
          phase: "wait",
          pane_id: target, status: pre.agent_status, seq: pre.state_change_seq,
          tail: tail.text,
          code: "snapshot",
          hint: "current terminal state snapshot; this wait did not observe the turn, so it is not proof of task completion",
          continuation: undefined,
        };
      }
    }

    const remainingMs = Math.max(1, deadline - this.now());
    // Event wait racing idle + done + blocked.
    const res = await this.herdr(
      [
        "agent", "wait", target,
        "--until", "idle",
        "--until", "done",
        "--until", "blocked",
        "--timeout", String(remainingMs),
      ],
      { signal, timeoutMs: remainingMs + 5_000 },
    );
    if (res.error?.code === "aborted" || res.transportCode === "aborted") {
      const after = await this.agentGet(target, signal);
      if (cont && after) {
        const mismatch = this.continuationIdentityMismatch(cont, after);
        if (!mismatch) this.recordContinuationObservation(contId!, after);
      }
      return {
        ok: false, outcome: "cancelled", phase: "wait",
        pane_id: target, status: after?.agent_status, seq: after?.state_change_seq,
        code: "aborted", hint: "wait cancelled; worker keeps running",
      };
    }
    if (!res.ok) {
      const tail = await this.readTail(target, tailChars, this.defaults.readLines, signal);
      const after = await this.agentGet(target, signal);
      if (cont && after) {
        const mismatch = this.continuationIdentityMismatch(cont, after);
        if (mismatch) return this.continuationIdentityFailure(target, mismatch);
        this.recordContinuationObservation(contId!, after);
      }
      if (res.error?.code === "timeout" || res.transportCode === "TimeoutError") {
        // Timeout is NOT delivery proof or working evidence; include current get + tail.
        return {
          ok: false, outcome: "timeout", phase: "wait",
          pane_id: target, status: after?.agent_status, seq: after?.state_change_seq,
          tail: tail.text, code: "timeout",
          hint: "no terminal state within the window; worker keeps running; inspect before re-waiting",
          continuation: cont ? this.recordContinuationObservation(contId!, after ?? null) : undefined,
        };
      }
      return this.transportFailure("wait", res, { pane_id: target });
    }
    const agent = agentOf(res.doc) ?? pre;
    if (cont) {
      const mismatch = this.continuationIdentityMismatch(cont, agent);
      if (mismatch) return this.continuationIdentityFailure(target, mismatch);
      this.recordContinuationObservation(contId!, agent);
      if (this.continuationTerminalObserved(cont, agent)) {
        return this.continuationTerminalResult(target, contId!, cont, agent, tailChars, signal);
      }
      if (TERMINAL_STATES.includes(agent.agent_status ?? "")) {
        return this.waitForContinuationProgress(target, contId!, deadline, tailChars, signal);
      }
    }
    if (!TERMINAL_STATES.includes(agent.agent_status ?? "")) {
      return {
        ok: false, outcome: "error", phase: "wait",
        pane_id: target, status: agent.agent_status, seq: agent.state_change_seq,
        code: "unexpected_wait_state",
        hint: "agent wait returned a non-terminal state; no terminal observation, inspect before retrying",
        continuation: cont ? contId : undefined,
      };
    }
    const tail = await this.readTail(target, tailChars, this.defaults.readLines, signal);
    return {
      ok: agent.agent_status !== "blocked",
      outcome: agent.agent_status === "blocked" ? "needs_attention" : "terminal_observed",
      phase: "wait",
      pane_id: target, status: agent.agent_status, seq: agent.state_change_seq,
      tail: tail.text,
      code: "snapshot",
      hint: "terminal state snapshot; not proof of a specific task turn",
      continuation: undefined,
    };
  }

  private async waitForContinuationProgress(
    target: string,
    contId: string,
    deadline: number,
    tailChars: number,
    signal: AbortSignal | undefined,
  ): Promise<Result> {
    const cont = this.continuations.get(contId);
    if (!cont) {
      return {
        ok: false, outcome: "error", phase: "validation",
        code: "unknown_continuation", pane_id: target,
        hint: "continuation id is not recognized (unknown or forged); a prior subagent_prompt/wait must have issued it",
      };
    }

    let after: AgentInfo | undefined;
    while (this.now() < deadline) {
      if (signal?.aborted) {
        return this.aborted("wait", target, undefined, after);
      }
      const res = await this.herdr(["agent", "get", target], { signal });
      if (res.error?.code === "aborted" || res.transportCode === "aborted") {
        return this.aborted("wait", target, undefined, after);
      }
      if (!res.ok) {
        return this.transportFailure("wait", res, { pane_id: target });
      }
      const agent = agentOf(res.doc);
      if (!agent) {
        return this.transportFailure("wait", {
          ok: false,
          exitCode: res.exitCode,
          signal: res.signal,
          doc: res.doc,
          error: { code: "agent_not_found", message: "target agent not detected" },
          text: res.text,
          transportCode: res.transportCode,
          transportMessage: res.transportMessage,
        }, { pane_id: target });
      }
      const mismatch = this.continuationIdentityMismatch(cont, agent);
      if (mismatch) return this.continuationIdentityFailure(target, mismatch);
      after = agent;
      this.recordContinuationObservation(contId, agent);
      if (this.continuationTerminalObserved(cont, agent)) {
        return this.continuationTerminalResult(target, contId, cont, agent, tailChars, signal);
      }
      await this.sleep(Math.min(SAMPLE_POLL_MS, Math.max(1, deadline - this.now())), signal);
    }

    if (signal?.aborted) {
      return this.aborted("wait", target, undefined, after);
    }
    const tail = await this.readTail(target, tailChars, this.defaults.readLines, signal);
    return {
      ok: false,
      outcome: "timeout",
      phase: "wait",
      pane_id: target,
      status: after?.agent_status,
      seq: after?.state_change_seq,
      tail: tail.text,
      code: "timeout",
      hint: "no newer terminal state within the window; worker keeps running; inspect before re-waiting",
      continuation: this.recordContinuationObservation(contId, after ?? null),
    };
  }

  // -------------------------------------------------------------------------
  // send / interrupt
  // -------------------------------------------------------------------------

  async send(args: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
    const target = typeof args.target === "string" ? args.target : "";
    if (!target) return { ok: false, outcome: "error", phase: "validation", code: "target_required" };
    if (this.isSelf(target)) {
      return {
        ok: false, outcome: "denied", phase: "validation", code: "self_control",
        hint: "supervisor cannot send text to itself",
      };
    }
    const text = typeof args.text === "string" ? args.text : "";
    if (text.length === 0) {
      return { ok: false, outcome: "error", phase: "validation", code: "text_required" };
    }
    if (text.includes("\n")) {
      return {
        ok: false, outcome: "error", phase: "validation",
        code: "multiline_unverified",
        hint: "multi-line send behaviour is unverified in herdr 0.9.3; send one line at a time",
      };
    }
    const access = await this.checkControlAccess(target, args, "send", signal);
    if (!access.ok) return access.result;
    // pane run = text + Enter in one call (preferred primitive).
    const res = await this.herdr(["pane", "run", target, text], { signal });
    if (!res.ok) return this.transportFailure("send", res, { pane_id: target });
    return {
      ok: true, outcome: "sent", phase: "send",
      pane_id: target,
      hint: "raw terminal text + Enter; not an agent prompt (lifecycle-unaware)",
    };
  }

  async interrupt(args: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
    const target = typeof args.target === "string" ? args.target : "";
    if (!target) return { ok: false, outcome: "error", phase: "validation", code: "target_required" };
    if (this.isSelf(target)) {
      return {
        ok: false, outcome: "denied", phase: "validation", code: "self_control",
        hint: "supervisor cannot interrupt itself",
      };
    }
    const access = await this.checkControlAccess(target, args, "interrupt", signal);
    if (!access.ok) return access.result;
    // esc aborts the turn; ctrl+d would kill the session — never used here.
    const res = await this.herdr(["pane", "send-keys", target, "esc"], { signal });
    if (!res.ok) return this.transportFailure("interrupt", res, { pane_id: target });
    const after = await this.agentGet(target, signal);
    return {
      ok: true, outcome: "interrupted", phase: "interrupt",
      pane_id: target, status: after?.agent_status, seq: after?.state_change_seq,
      hint: "escape sent; the turn should abort and the agent survive",
    };
  }

  // -------------------------------------------------------------------------
  // list / spaces
  // -------------------------------------------------------------------------

  async list(_args: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
    const workspaceId = await this.resolveOwnWorkspace(signal);
    if (!workspaceId) {
      return {
        ok: false, outcome: "error", phase: "validation",
        code: "herdr_context_missing",
        hint: "no HERDR_PANE_ID; cannot determine the current workspace",
      };
    }
    const panesRes = await this.herdr(["pane", "list", "--workspace", workspaceId], { signal });
    if (!panesRes.ok) return this.transportFailure("list", panesRes);
    const agentsRes = await this.herdr(["agent", "list"], { signal });
    if (!agentsRes.ok) return this.transportFailure("list", agentsRes);
    const panes =
      ((panesRes.doc?.result as Record<string, unknown> | undefined)?.panes as PaneInfo[] | undefined) ?? [];
    const agents =
      ((agentsRes.doc?.result as Record<string, unknown> | undefined)?.agents as AgentInfo[] | undefined) ?? [];
    const byPane = new Map(agents.map((a) => [a.pane_id, a]));
    const items = panes.map((p) => {
      const a = p.pane_id ? byPane.get(p.pane_id) : undefined;
      return {
        pane_id: p.pane_id,
        workspace_id: p.workspace_id,
        terminal_id: p.terminal_id,
        name: a?.name ?? null,
        agent_status: a?.agent_status ?? p.agent_status,
        terminal_title: p.terminal_title ?? null,
        focused: p.focused === true,
        owned: this.isOwned(p.pane_id ?? "") !== undefined,
      };
    });
    return {
      ok: true, outcome: "listed", phase: "list",
      workspace_id: workspaceId,
      detail: JSON.stringify(items),
    };
  }

  async spaces(_args: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
    const res = await this.herdr(["workspace", "list"], { signal });
    if (!res.ok) return this.transportFailure("spaces", res);
    const workspaces =
      ((res.doc?.result as Record<string, unknown> | undefined)?.workspaces as Array<{
        workspace_id?: string;
        label?: string;
        pane_count?: number;
        tab_count?: number;
        agent_status?: string;
        focused?: boolean;
        active_tab_id?: string;
      }> | undefined) ?? [];
    const items = workspaces.map((w) => ({
      workspace_id: w.workspace_id,
      label: w.label ?? null,
      pane_count: w.pane_count,
      tab_count: w.tab_count,
      agent_status: w.agent_status,
      focused: w.focused === true,
      active_tab_id: w.active_tab_id ?? null,
    }));
    return {
      ok: true, outcome: "listed", phase: "spaces",
      detail: JSON.stringify(items),
    };
  }

  // -------------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------------

  async close(args: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
    const target = typeof args.target === "string" ? args.target : "";
    if (!target) return { ok: false, outcome: "error", phase: "validation", code: "target_required" };
    if (this.isSelf(target)) {
      return {
        ok: false, outcome: "denied", phase: "validation", code: "self_control",
        hint: "supervisor cannot close itself",
      };
    }
    if (!this.isOwned(target)) {
      const retired = await this.probeRetiredClose(target, signal);
      if (retired) return retired;
    }

    const access = await this.checkControlAccess(target, args, "close", signal);
    if (!access.ok) return access.result;

    const owned = this.isOwned(target);
    const tombstone: OwnedRecord = owned ?? this.retired.get(target) ?? { pane_id: target, workspace_id: "" };

    // Close, then verify ABSENCE with a typed pane_not_found. Only a typed
    // pane_not_found proves absence; transport/server/abort errors do NOT.
    const res = await this.closePane(target, signal);
    if (!res.ok) {
      // Ownership is retained: we could not verify the pane is gone.
      return res;
    }
    if (res.code === "pane_not_found") {
      // Idempotent close: the pane was already gone (typed absence). For an
      // owned pane this is success; drop ownership and remember the tombstone.
      this.owned.delete(target);
      this.retired.set(target, {
        pane_id: tombstone.pane_id,
        workspace_id: tombstone.workspace_id,
        terminal_id: tombstone.terminal_id,
        name: tombstone.name,
        launched_at: tombstone.launched_at,
        session: tombstone.session,
        pending: false,
      });
      return {
        ok: true, outcome: "closed", phase: "close",
        pane_id: target, code: "pane_not_found",
        hint: "pane already gone (typed pane_not_found); idempotent close treated as success",
      };
    }
    // res.code === "ok": verify the pane is actually absent.
    const verify = await this.herdr(["pane", "get", target], { signal });
    if (verify.error?.code === "pane_not_found") {
      this.owned.delete(target);
      this.retired.set(target, {
        pane_id: tombstone.pane_id,
        workspace_id: tombstone.workspace_id,
        terminal_id: tombstone.terminal_id,
        name: tombstone.name,
        launched_at: tombstone.launched_at,
        session: tombstone.session,
        pending: false,
      });
      return {
        ok: true, outcome: "closed", phase: "close",
        pane_id: target, code: "ok",
        hint: "pane closed and absence verified (typed pane_not_found)",
      };
    }
    if (verify.ok) {
      // Still present: close did not actually remove it. Retain ownership.
      return {
        ok: false, outcome: "error", phase: "verify",
        pane_id: target, code: "close_verification_failed",
        hint: "close reported ok but the pane still appears in pane get; ownership retained, re-check before further action",
      };
    }
    // Verify produced a non-typed error (server/transport/abort): absence is
    // UNVERIFIED, not assumed. Retain ownership.
    return {
      ok: false, outcome: "error", phase: "verify",
      pane_id: target,
      code: verify.error?.code ?? verify.transportCode ?? "verify_failed",
      hint: "could not verify absence (non-typed verify failure); ownership retained",
    };
  }

  private async probeRetiredClose(paneId: string, signal?: AbortSignal): Promise<Result | undefined> {
    if (!this.retired.has(paneId)) return undefined;
    const probe = await this.herdr(["pane", "get", paneId], { signal });
    if (probe.error?.code === "pane_not_found") {
      return {
        ok: true, outcome: "closed", phase: "close",
        pane_id: paneId, code: "pane_not_found",
        hint: "pane already gone (typed pane_not_found); idempotent close treated as success",
      };
    }
    if (!probe.ok) {
      return this.transportFailure("ownership", probe, { pane_id: paneId });
    }
    return undefined;
  }

  private async closePane(paneId: string, signal?: AbortSignal): Promise<Result> {
    const res = await this.herdr(["pane", "close", paneId], { signal });
    if (res.ok) {
      return { ok: true, outcome: "closed", phase: "close", pane_id: paneId, code: "ok" };
    }
    if (res.error?.code === "pane_not_found") {
      // Typed absence: idempotent close, already gone.
      return {
        ok: true, outcome: "closed", phase: "close", pane_id: paneId,
        code: "pane_not_found",
        hint: "pane already gone; idempotent close treated as success",
      };
    }
    // Any other failure (server error, transport, abort) is NOT absence.
    return this.transportFailure("close", res, { pane_id: paneId });
  }

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  private async checkControlAccess(
    target: string,
    args: Record<string, unknown>,
    operation: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; result: Result }> {
    if (this.isSelf(target)) {
      return {
        ok: false,
        result: {
          ok: false, outcome: "denied", phase: "validation", code: "self_control",
          pane_id: target, hint: "supervisor cannot control itself",
        },
      };
    }
    const owned = this.isOwned(target);
    if (owned) {
      // Pending-detection panes (not yet agent-detected) are still managed /
      // closeable: ownership identity is workspace + recorded terminal/name.
      if (owned.pending) {
        const paneRes = await this.herdr(["pane", "get", target], { signal });
        const pane = (paneRes.doc?.result as Record<string, unknown> | undefined)?.pane as PaneInfo | undefined;
        if (!paneRes.ok || !pane) {
          // Pane already gone: close is idempotent success; other ops lose.
          if (operation === "close" && paneRes.error?.code === "pane_not_found") {
            this.owned.delete(target);
            return { ok: true };
          }
          this.owned.delete(target);
          return {
            ok: false,
            result: {
              ok: false, outcome: "ownership_lost", phase: "ownership",
              pane_id: target, code: "pane_not_found_live",
              hint: "pending pane no longer exists; not treated as owned",
            },
          };
        }
        if (pane.workspace_id !== owned.workspace_id) {
          this.owned.delete(target);
          return {
            ok: false,
            result: {
              ok: false, outcome: "ownership_lost", phase: "ownership",
              pane_id: target, code: "workspace_mismatch",
              hint: "pending pane moved to another workspace; not treated as owned",
            },
          };
        }
        if (owned.terminal_id && pane.terminal_id !== owned.terminal_id) {
          this.owned.delete(target);
          return {
            ok: false,
            result: {
              ok: false, outcome: "ownership_lost", phase: "ownership",
              pane_id: target, code: "terminal_id_mismatch",
              hint: "pending pane terminal identity no longer verifies; control denied",
            },
          };
        }
        return { ok: true };
      }
      // Verified (detected) record: verify live identity before control.
      const check = await this.verifyOwnership(owned, signal);
      if (!check.ok) {
        // Retain ownership unless the pane is verifiably gone; a mismatch or
        // lost-live means we cannot trust it as the same pane.
        if (check.reason !== "pane_not_found_live") {
          this.owned.delete(target);
        }
        return {
          ok: false,
          result: {
            ok: false, outcome: "ownership_lost", phase: "ownership",
            pane_id: target, code: check.reason,
            hint: `recorded ownership no longer verifies live (${check.reason}); target is not treated as owned — an external opt-in is required`,
          },
        };
      }
      return { ok: true };
    }
    // External target: explicit opt-in required, restricted to the current
    // workspace. The opt-in is an acknowledgement, not user authorization.
    const optIn =
      operation === "close" ? args.externalConfirmed === true : args.allowExternal === true;
    if (!optIn) {
      return {
        ok: false,
        result: {
          ok: false, outcome: "denied", phase: "ownership",
          pane_id: target,
          code: "external_target",
          hint: `${operation} on a non-owned pane requires explicit opt-in (args.${operation === "close" ? "externalConfirmed === true" : "allowExternal === true"})`,
        },
      };
    }
    const workspaceId = await this.resolveOwnWorkspace(signal);
    if (!workspaceId) {
      return {
        ok: false,
        result: {
          ok: false, outcome: "error", phase: "ownership",
          code: "herdr_context_missing",
          hint: "cannot determine current workspace",
        },
      };
    }
    const res = await this.herdr(["pane", "get", target], { signal });
    const pane = (res.doc?.result as Record<string, unknown> | undefined)?.pane as PaneInfo | undefined;
    if (!res.ok || !pane) {
      // For close: a typed missing pane is not an access error — closePane
      // handles pane_not_found idempotently. Other ops fail.
      if (operation === "close" && res.error?.code === "pane_not_found") {
        return { ok: true };
      }
      return { ok: false, result: this.transportFailure("ownership", res, { pane_id: target }) };
    }
    if (pane.workspace_id !== workspaceId) {
      return {
        ok: false,
        result: {
          ok: false, outcome: "denied", phase: "ownership",
          pane_id: target, code: "outside_workspace",
          hint: "external targets are restricted to the current workspace",
        },
      };
    }
    return { ok: true };
  }

  private async agentGet(target: string, signal?: AbortSignal): Promise<AgentInfo | undefined> {
    const res = await this.herdr(["agent", "get", target], { signal });
    if (!res.ok) return undefined;
    return agentOf(res.doc) ?? undefined;
  }

  private aborted(phase: string, paneId?: string, workspaceId?: string, agent?: AgentInfo): Result {
    return {
      ok: false, outcome: "cancelled", phase,
      pane_id: paneId, workspace_id: workspaceId,
      status: agent?.agent_status, seq: agent?.state_change_seq,
      code: "aborted",
      hint: "aborted; local CLI resources reaped, the worker pane was not interrupted or closed",
    };
  }

  private transportFailure(
    phase: string,
    res: {
      ok: boolean;
      exitCode: number;
      signal?: string;
      doc: Record<string, unknown> | null;
      error: { code: string; message: string } | null;
      text: string;
      transportCode?: string;
      transportMessage?: string;
    },
    extra: { pane_id?: string } = {},
  ): Result {
    const code = res.error?.code ?? res.transportCode ?? (res.signal ? `killed_${res.signal}` : `exit_${res.exitCode}`);
    const message =
      res.error?.message ?? res.transportMessage ?? (res.text.trim() || `herdr exited ${res.exitCode}`);
    return {
      ok: false,
      outcome: "error",
      phase,
      pane_id: extra.pane_id,
      code,
      detail: message,
      hint: this.hintFor(code, phase),
    };
  }

  private hintFor(code: string, phase: string): string {
    if (code === "server_not_running") return "herdr server is not running; start herdr or attach to a session";
    if (code === "protocol_mismatch") return "herdr client/server protocol mismatch; restart the herdr server";
    if (code === "agent_not_found" && phase === "preflight") {
      return "target agent not detected; inspect the pane (pane read / process-info) — a dead worker is a distinct failure class, do not retry blindly";
    }
    if (code === "workspace_not_found") return "workspace not found; list workspaces with the spaces operation";
    if (code === "aborted") return "operation aborted by caller (local CLI reaped, worker pane untouched)";
    if (code === "TimeoutError") return "CLI invocation exceeded its execution ceiling; no state was read from it";
    if (code === "OutputOverflowError") return "CLI output exceeded the byte cap and was truncated; envelope could not be trusted";
    if (code === "SpawnError") return "could not spawn the herdr CLI (binary missing or spawn failure)";
    if (code === "transport_error") return "could not run the herdr CLI (transport failure)";
    return `herdr ${phase} failed (${code})`;
  }

  private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(t);
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const t = setTimeout(finish, ms);
      const onAbort = (): void => finish();
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export { shellQuote, HerdrTransport };
export type { Transport, TransportResult, TransportOptions } from "./transport.js";
