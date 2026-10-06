// Asynchronous Herdr transport and lifecycle core for the pi-subagent-herdr
// extension (v0.2.0 ergonomic contract, docs/tool_usage_review.md).
//
// Nine operations: start / prompt / read / wait / send / interrupt / list /
// spaces / close. Pane id is the sole caller-facing address; there is no
// public continuation/cursor/receipt handle. Internal freshness bookkeeping
// (pendingContext, in-memory only) associates a same-session submission with
// matching live identity and applies the two-tier freshness rules:
//   tier 1: terminal seen during submission (acknowledgement already
//           terminal, seq newer than pre-submit baseline, identity matches,
//           fresh lookup confirms the same terminal sequence) ->
//           terminal_seen_during_submission, settled once
//   tier 2: wait for a terminal state with seq greater than the
//           acknowledgement baseline, identity unchanged ->
//           state_changed_after_submission
// Neither rule proves task execution or exclusive attribution.
//
// Design constraints honoured:
// - task delivery via `agent prompt` post-detection, never positional payload
// - terminal-state waits race idle + done + blocked
// - a bounded wait times out -> `timeout` with current status + console;
//   timeout never implies the worker was stopped, and never triggers resend
// - delivery receipt is the real CLI `agent_prompted` response; the `delivery`
//   field distinguishes acknowledged / not_sent / unknown / not_applicable
// - existing-agent prompt is agent-neutral: any detected agent kind supported
//   by Herdr (including non-Pi, e.g. Claude) may be prompted; managed-Pi
//   readiness is start-specific only
// - busy prompt: allowed as Herdr allows it; `submittedWhile` reported from
//   preflight; no automatic pending association when submitted while working
//   (observation may_reflect_prior_turn); typed agent_blocked -> not_sent
// - close only treats a typed `pane_not_found` as absence; close returns
//   verified absence, no console tail
// - `pane close` on an already-gone pane is idempotent success
// - esc interrupts a turn; ctrl+d kills the session (never used here)
// - abort reaps only the local CLI process, never the worker pane
// - console failures never erase the action outcome: the result carries the
//   console text (or undefined) plus an independent consoleError field
// - read source=auto: typed agent_not_found (or lookup succeeds with no
//   detected agent) -> raw pane console with unknown status; typed
//   agent_not_idle -> visible-only; every other real error stays an error;
//   source=agent is strict; source=raw is explicit only
// - old 0.1.x parameter names are rejected before any action with precise
//   replacement hints (breaking 0.1.x -> 0.2.0 migration)

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
// Role preambles (v1: hardcoded, no config files, no per-role model)
//
// Combined preamble = CROSS_CUTTING_RULES + "\n\n" + ROLES[role].
// The combined text is passed to the launcher via --append-system-prompt.
// ---------------------------------------------------------------------------

export const CROSS_CUTTING_RULES = `You are a bounded sub-agent. Strictly honor your specific role; do not drift into other roles.
- Be honest about uncertainty: label guesses (Hypothesis:/Unverified:), cite evidence you actually saw.
- Never invent file contents, test results, or command output.
- Report status and blockers plainly; do not hide failures behind optimism.
- Your caller is an agent; end with a compact, structured summary so it can aggregate findings mechanically.`;

export const ROLES: Record<string, string> = {
  teamlead: `Role: teamlead (proxy / team-lead).
You act on your caller's behalf: you decompose, delegate, and synthesize — you do not execute the work yourself.
- Investigate first if grounding is missing; never delegate on blind assumptions.
- Decompose the goal into bounded, independently verifiable sub-tasks.
- Delegate each sub-task to a sub-agent via subagent_start; give each a self-contained brief (goal, scope, evidence expected).
- You may inspect files to orient, but never modify files, run builds, or execute tests yourself.
- Coordinate: observe with subagent_read/subagent_wait; provide course-corrections via prompts.
- Synthesize the sub-agents' results into one consolidated answer for your caller.
- If a sub-task fails or blocks, report it; do not silently re-plan around it.`,
  worker: `Role: worker (plan executor).
- Execute the given bounded task; do not expand scope beyond it.
- Read the relevant code/files first; ground every edit in what you actually observed.
- Run the verification the task asks for (tests, build, command) and report real output.
- Never alter tests or weaken assertions just to make a verification pass.
- If readonly, make no file changes; report what you would change instead.
- If editable, keep changes minimal and scoped to the task.
- If scope must widen or you hit a permission boundary, stop and report BLOCKED — do not expand scope unilaterally.
- End with a structured status: DONE / PARTIAL / BLOCKED / FAILED, plus what changed, evidence it works, and what you did NOT touch.`,
  reviewer: `Role: reviewer (post-implementation verification).
- Evaluate the actual diff against the original requirements and invariants, ignoring the author's narrative.
- Check callers/callees and data flow where an invariant may live outside the diff.
- Check: correctness vs requirement, test coverage, regressions, edge cases, security, scope creep.
- Prioritize functional bugs, logic errors, regressions, and missing tests; do not nitpick formatting or personal style.
- Cite file:line for every finding; no findings without evidence.
- For each finding: severity (Blocker/Important/Nit), location, evidence, consequence, minimal fix direction.
- Do NOT modify code; you only report.
- If no material defects, say so explicitly and list what was verified.
- Verdict: approved / needs-changes / blocked (with the specific list and why).`,
  rubberduck: `Role: rubber-duck (deliberate Socratic sparring partner — focus on problem framing and logic, NOT code review or syntax).
- Read-only: do not output code blocks, refactorings, or diffs; express thoughts in conceptual markdown only.
- Ask narrow, non-leading clarifying questions that expose hidden assumptions; challenge one assumption at a time.
- Separate verified facts, hypotheses, contradictions, and unknowns in your responses.
- Challenge weak reasoning; name the specific claim that needs evidence.
- Reframe the problem when the framing is wrong; offer 1-2 alternatives.
- Help the caller think, not decide for them; end with the open questions that remain.`,
  explorer: `Role: explorer (investigator).
- Open-ended investigation of the codebase and (when needed) the web.
- Explore hierarchically (structure → candidate files → symbols → callers/callees → data flow), not exhaustively.
- Map only the components and integration edges relevant to the question; document existing patterns, not aspirational ones.
- Surface hidden complexity, architectural assumptions, and non-obvious risks.
- Ground every claim in a file you actually read or a source you actually fetched.
- Synthesize findings into file paths and structural relationships; use small ASCII diagrams or tradeoff tables when they clarify faster than prose.
- Return a compact ranked report: what, where (file:line), why it matters, confidence.
- Do NOT implement; you produce a map, not a change.
- As soon as the target question is answered, output your final structured findings and stop.`,
};

/** Build the combined preamble text for a given role (cross-cutting + role body). */
export function rolePreamble(role: string): string {
  return `${CROSS_CUTTING_RULES}\n\n${ROLES[role]}`;
}

// ---------------------------------------------------------------------------
// Result / record types
// ---------------------------------------------------------------------------

export interface Result {
  ok: boolean;
  outcome: string;
  phase: string;
  pane?: string;
  workspace?: string;
  /** Observed agent kind (e.g. "pi", "claude"); undefined when unknown. */
  agent?: string;
  /** Observed agent status; "unknown" when the agent was not detectable. */
  status?: string;
  /** Last observed state-change sequence, when the payload carries one. */
  seq?: number;
  /** Delivery disposition: acknowledged | not_sent | unknown | not_applicable. */
  delivery?: string;
  /** Bounded console text (code-point tailed); undefined when disabled or failed. */
  console?: string;
  /** Console source that produced `console`: agent | visible | raw. */
  consoleSource?: string;
  /** True when `console` was clipped by the line or character bound. */
  truncated?: boolean;
  /** Independent console-read failure; never erases the action outcome. */
  consoleError?: string;
  /** Pre-submit status for busy submissions (0.2.0 prompt). */
  submittedWhile?: string;
  /** Observational label (e.g. snapshot, may_reflect_prior_turn, ...). */
  observation?: string;
  /** True when the pane was launched (and is still tracked) by this session. */
  owned?: boolean;
  /** True only when a working state was actually sampled or CLI-reported. */
  working_observed?: boolean;
  code?: string;
  hint?: string;
  detail?: string;
  /** Compact structured collection (list/spaces). */
  items?: unknown[];
  /** True for close results where absence was verified. */
  verifiedAbsent?: boolean;
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

/**
 * In-memory pending submission context (NOT persisted, NOT a public handle).
 * One record per pane; a new submission supersedes the previous record for
 * that pane. Reload/restart/new session loses it; subsequent pane waits then
 * use the explicitly labelled current-pane snapshot rule.
 */
export interface PendingContext {
  pane_id: string;
  workspace_id?: string;
  terminal_id?: string;
  name?: string;
  /** Pre-submit seq baseline (from the preflight agent get). */
  baseline_seq?: number;
  /** True only for a real `agent_prompted` receipt. */
  delivery_confirmed: boolean;
  /** Acknowledgement snapshot (terminal status at submission time, if any). */
  receipt_seq?: number;
  receipt_state?: string;
  /** True only when a working state was actually sampled or CLI-reported. */
  working_observed: boolean;
  working_seq?: number;
  /** True once tier 1 settled this record; settled records are not reused. */
  settled?: boolean;
  /** Observation label attached to the submitting call (busy, etc.). */
  submitted_while?: string;
}

export interface SubagentServiceOptions {
  transport?: Transport;
  runtimeDir?: string;
  paneId?: string;
  now?: () => number;
  /** Default timeout/output ceilings (ms / lines / code points). */
  defaults?: {
    detectionMs?: number;
    waitMs?: number;
    maxWaitMs?: number;
    consoleLines?: number;
    consoleChars?: number;
    maxConsoleLines?: number;
    maxConsoleChars?: number;
  };
  /** Directory of the herdr skill scripts (wrapper); defaults to runtimeDir. */
  scriptsDir?: string;
}

export const DEFAULTS = {
  detectionMs: 30_000,
  waitMs: 1_800_000,
  maxWaitMs: 3_600_000,
  consoleLines: 100,
  consoleChars: 8_000,
  maxConsoleLines: 500,
  maxConsoleChars: 50_000,
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
 * the real editor submit handler; never send a launch task before that.
 * Launch (start) readiness only — existing-agent prompt is agent-neutral. */
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
  cwd?: string;
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

function tailCodePoints(text: string, maxChars: number): { text: string; clipped: boolean } {
  if (maxChars === 0) return { text, clipped: false };
  const codePoints = Array.from(text);
  return codePoints.length > maxChars
    ? { text: codePoints.slice(-maxChars).join(""), clipped: true }
    : { text, clipped: false };
}

/** A screen-detected Pi/idle may still retain submissions as startup drafts. */

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
// 0.1.x -> 0.2.0 migration: legacy field rejection
// ---------------------------------------------------------------------------

/**
 * Reject 0.1.x parameter names BEFORE any herdr action, each with a precise
 * 0.2.0 replacement hint. Conflicting old+new fields are errors, not
 * precedence guesses. `allowExternal` is accepted-but-ignored (deprecated)
 * for this transition and is NOT rejected.
 */
export function rejectLegacyFields(
  args: Record<string, unknown>,
  operation: string,
): Result | null {
  const hint = (field: string, replacement: string): Result => ({
    ok: false,
    outcome: "error",
    phase: "validation",
    code: "legacy_field",
    hint: `0.1.x field "${field}" is not accepted in 0.2.0 (${operation}); use ${replacement}`,
  });
  if (args.target !== undefined) {
    return hint("target", "pane (the pane id is the sole address)");
  }
  if (operation === "prompt" && args.task !== undefined) {
    return hint("task", "prompt (text submitted as an agent prompt)");
  }
  if (args.waitMode !== undefined) {
    return hint("waitMode", "wait (boolean: start defaults to false, prompt defaults to true)");
  }
  if (args.tailChars !== undefined) {
    return hint("tailChars", "returnLines + maxChars (line window then code-point tail)");
  }
  if (operation === "read" && args.lines !== undefined) {
    return hint("lines", "returnLines");
  }
  if (operation === "read" && args.raw !== undefined) {
    return hint("raw", 'source: "raw" (or "auto" / "agent")');
  }
  if (args.continuation !== undefined) {
    return hint("continuation", "address the pane directly (pane); internal pending context is not caller-facing");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Read a bounded console for a pane.
 *  source "raw": explicit `pane read` (no agent semantics).
 *  source "agent": strict agent read; every failure is an error.
 *  source "auto" (default):
 *    - typed agent_not_found (or lookup succeeds with no detected agent)
 *      -> raw pane console with unknown status
 *    - typed agent_not_idle -> visible-only console
 *    - every other real error stays an error
 */
export type ConsoleOutcome =
  | { ok: true; text: string; source: "agent" | "visible" | "raw"; clipped: boolean; hint?: string }
  | { ok: false; error: string; source: "agent" | "raw" | "none" };

interface MultiPaneEntry {
  pane: string;
  outcome: "terminal_observed" | "needs_attention" | "timeout" | "working" | "error";
  /** Present only when an observation was actually read (no fabrication). */
  status?: string;
  seq?: number;
  /** Freshness label (tier-1/tier-2/snapshot) or error code. */
  code: string;
  /** Observation label: ...after_submission / may_reflect_prior_turn / snapshot / pending / error. */
  observation: string;
  /** "acknowledged" when a pending record settled on this entry. */
  delivery?: string;
  /** Bounded per-pane console tail; absent when returnLines is 0. */
  console?: string;
  consoleSource?: string;
  consoleError?: string;
  /** True when this pane's console tail was clipped (drives top-level truncated). */
  paneTruncated?: boolean;
  detail?: string;
  hint?: string;
}

export class SubagentService {
  private readonly transport: Transport;
  private readonly scriptsDir: string;
  private readonly paneId?: string;
  private readonly now: () => number;
  private readonly defaults: typeof DEFAULTS;
  private readonly owned = new Map<string, OwnedRecord>();
  /** Recently closed pane ids remembered as tombstones for idempotent close. */
  private readonly retired = new Map<string, OwnedRecord>();
  /**
   * In-memory pending submission context: at most ONE useful record per
   * pane. Never persisted, never caller-facing; a new submission supersedes.
   */
  private readonly pending = new Map<string, PendingContext>();
  private workspaceIdCache?: string;

  constructor(options: SubagentServiceOptions = {}) {
    this.transport = options.transport ?? new HerdrTransport();
    this.scriptsDir = options.scriptsDir ?? options.runtimeDir ?? "";
    this.paneId = options.paneId;
    this.now = options.now ?? Date.now;
    const d = options.defaults ?? {};
    this.defaults = {
      detectionMs: d.detectionMs ?? DEFAULTS.detectionMs,
      waitMs: d.waitMs ?? DEFAULTS.waitMs,
      maxWaitMs: d.maxWaitMs ?? DEFAULTS.maxWaitMs,
      consoleLines: d.consoleLines ?? DEFAULTS.consoleLines,
      consoleChars: d.consoleChars ?? DEFAULTS.consoleChars,
      maxConsoleLines: d.maxConsoleLines ?? DEFAULTS.maxConsoleLines,
      maxConsoleChars: d.maxConsoleChars ?? DEFAULTS.maxConsoleChars,
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
    // Breaking 0.1.x -> 0.2.0: reject legacy fields BEFORE any action.
    const legacy = rejectLegacyFields(args, operation);
    if (legacy) return legacy;
    const handler: Record<string, (a: Record<string, unknown>, s?: AbortSignal) => Promise<Result>> = {
      start: (a, s) => this.start(a, s),
      prompt: (a, s) => this.prompt(a, s),
      read: (a, s) => this.read(a, s),
      wait: (a, s) => this.routeWait(a, s),
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

  /** Plain-JSON snapshot of owned pane records (informational). */
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

  /**
   * Expose the current in-memory pending context for a pane (test/debug only;
   * never a caller-facing handle). Settled records report as such.
   */
  pendingContext(paneId: string): PendingContext | undefined {
    const rec = this.pending.get(paneId);
    return rec ? { ...rec } : undefined;
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
  // Context / ownership (informational only — never a control gate)
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
      terminal_id: identity?.terminal_id ?? existing?.terminal_id,
      name: identity?.name ?? existing?.name,
      session: existing?.session ?? this.paneId,
      launched_at: existing?.launched_at ?? this.now(),
      pending: true,
    });
  }

  // -------------------------------------------------------------------------
  // Console reading (0.2.0 source semantics)
  // -------------------------------------------------------------------------

  private async readConsole(
    target: string,
    lines: number,
    source: "auto" | "agent" | "raw",
    signal: AbortSignal | undefined,
  ): Promise<ConsoleOutcome> {
    if (source === "raw") {
      const res = await this.herdr(["pane", "read", target, "--lines", String(lines)], { signal });
      if (!res.ok) return { ok: false, error: this.describeFailure(res), source: "raw" };
      return { ok: true, text: res.text, source: "raw", clipped: false };
    }
    const args = ["agent", "read", target, "--lines", String(lines), "--source", "recent-unwrapped", "--format", "text"];
    const res = await this.herdr(args, { signal });
    if (res.ok) {
      const readResult = res.doc?.result as Record<string, unknown> | undefined;
      const text = typeof readResult?.text === "string" ? readResult.text : res.text;
      return { ok: true, text, source: "agent", clipped: false };
    }
    const code = res.error?.code ?? res.transportCode ?? `exit_${res.exitCode}`;
    if (source === "agent") {
      // Strict: surface the error, no raw fallback.
      return { ok: false, error: this.describeFailure(res), source: "agent" };
    }
    // auto fallback rules:
    if (code === "agent_not_found") {
      // Typed agent_not_found -> raw pane console with unknown status.
      const raw = await this.herdr(["pane", "read", target, "--lines", String(lines)], { signal });
      if (!raw.ok) return { ok: false, error: this.describeFailure(raw), source: "raw" };
      return { ok: true, text: raw.text, source: "raw", clipped: false };
    }
    if (code === "agent_not_idle") {
      // Active alternate-screen history unavailable: the documented visible
      // source reads the current viewport without scrolling the worker.
      const args2 = [...args];
      args2[args2.indexOf("--source") + 1] = "visible";
      const res2 = await this.herdr(args2, { signal });
      if (!res2.ok) return { ok: false, error: this.describeFailure(res2), source: "agent" };
      const readResult = res2.doc?.result as Record<string, unknown> | undefined;
      const text = typeof readResult?.text === "string" ? readResult.text : res2.text;
      return {
        ok: true,
        text,
        source: "visible",
        clipped: false,
        hint: "active alternate-screen history unavailable; console uses the visible viewport",
      };
    }
    // Every other real error (missing pane, protocol, server, transport)
    // stays an error. Never equate a failed lookup with a no-agent lookup.
    return { ok: false, error: this.describeFailure(res), source: "agent" };
  }

  private describeFailure(res: HerdrReturn): string {
    const code = res.error?.code ?? res.transportCode ?? (res.signal ? `killed_${res.signal}` : `exit_${res.exitCode}`);
    const message = res.error?.message ?? res.transportMessage ?? (res.text.trim() || `herdr exited ${res.exitCode}`);
    return `console read failed (${code}): ${message}`;
  }

  /**
   * Console-specific fields for spreading into a result without clobbering
   * the action's own status/seq. When the console read succeeded, status/seq
   * are absent (they only appear in the raw-fallback path, where the console
   * status IS the only status). When the console read failed, status/seq are
   * absent from the error path (the error carries consoleError only).
   */
  private consoleSpread(out: {
    console?: string;
    consoleSource?: string;
    truncated?: boolean;
    consoleError?: string;
  }): Record<string, unknown> {
    return out;
  }
  private async captureConsole(
    target: string,
    lines: number,
    chars: number,
    source: "auto" | "agent" | "raw",
    signal: AbortSignal | undefined,
  ): Promise<{ console?: string; consoleSource?: string; truncated?: boolean; consoleError?: string }> {
    if (lines <= 0) return {};
    const out = await this.readConsole(target, lines, source, signal);
    if (!out.ok) {
      return { consoleError: out.error };
    }
    const tailed = tailCodePoints(out.text, chars);
    const clipped = tailed.clipped;
    return {
      console: tailed.text,
      consoleSource: out.source,
      truncated: clipped || undefined,
      ...(out.hint ? { hint: out.hint } : {}),
    };
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
    // Role validation (before any pane mutation).
    const role = typeof args.role === "string" ? args.role : "";
    let combinedPreamble: string | undefined;
    if (role.length > 0) {
      if (ROLES[role] === undefined) {
        return {
          ok: false, outcome: "error", phase: "validation",
          code: "unknown_role",
          hint: `unknown role '${role}'; known roles: ${Object.keys(ROLES).join(", ")}`,
        };
      }
      if (role === "teamlead" && mode !== "editable") {
        return {
          ok: false, outcome: "error", phase: "validation",
          code: "teamlead_requires_editable",
          hint: "teamlead requires mode: editable — it needs the native subagent_* tools, which the readonly runtime excludes",
        };
      }
      combinedPreamble = rolePreamble(role);
    }
    const task = typeof args.task === "string" ? args.task : "";
    if (task.length === 0) {
      return {
        ok: false, outcome: "error", phase: "validation",
        code: "task_required",
        hint: "task (non-empty string) is required; delivery happens via agent prompt after detection",
      };
    }
    const wait = args.wait === true;
    const timeoutMs = this.resolveWaitBudget(args, wait, "start");
    if (timeoutMs.error) return timeoutMs.error;
    const { lines, chars } = this.resolveConsoleBounds(args);

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

    // Launch destination: current workspace (default) or one explicit id.
    const destination = await this.resolveStartWorkspace(args.workspace, signal);
    if (destination.error) return destination.error;
    const workspaceId = destination.id;

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
    //   result = { type: "pane_info", pane: { pane_id, workspace_id, ... } }
    const splitResult = splitRes.doc?.result as Record<string, unknown> | undefined;
    const splitPane = (splitResult?.pane ?? null) as PaneInfo | null;
    if (!splitPane || typeof splitPane.pane_id !== "string" || splitPane.pane_id.length === 0) {
      // No pane id is extractable from the response, so we cannot close a
      // specific pane. Documenting why we don't attempt cleanup: without a
      // pane_id, a `pane close` call has no target. The caller must inspect
      // the workspace manually. This is the one case where an orphan pane
      // may remain — the response did not tell us which pane was created.
      return {
        ok: false, outcome: "error", phase: "split",
        code: "split_malformed",
        hint: "pane split response did not carry a valid result.pane; inspect the workspace and do not re-launch",
        detail: JSON.stringify(splitRes.doc?.result ?? null),
      };
    }
    const paneId = splitPane.pane_id;
    // Safety: never treat the supervisor's own pane as the new worker.
    if (paneId === this.paneId) {
      return {
        ok: false, outcome: "error", phase: "split",
        code: "split_self_target",
        hint: "pane split reported the supervisor's own pane; do not launch into self",
      };
    }
    if (splitPane.workspace_id !== undefined && splitPane.workspace_id !== workspaceId) {
      // Unexpected split mismatch: the pane was created in the wrong
      // workspace. Clean up: close the created pane and verify absence
      // before returning the error. Do NOT leave an orphan pane.
      const closed = await this.closePane(paneId, signal);
      const verifiedAbsent = closed.ok;
      return {
        ok: false, outcome: "error", phase: "split",
        code: "split_workspace_mismatch",
        pane: paneId,
        verifiedAbsent,
        hint: `pane split landed in workspace ${splitPane.workspace_id}, expected ${workspaceId}; pane closed${verifiedAbsent ? " and absence verified" : " but absence unverified"}; not adopted as owned`,
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
    const command = combinedPreamble !== undefined
      ? `${shellQuote(wrapper)} --mode ${mode} --append-system-prompt ${shellQuote(combinedPreamble)} --`
      : `${shellQuote(wrapper)} --mode ${mode} --`;
    const runRes = await this.herdr(["pane", "run", paneId, command], { signal });
    if (!runRes.ok) {
      // Launch failed: attempt to close the half-created pane. Retain ownership
      // if absence is unverified; only drop it on a verified gone result.
      const closed = await this.closePane(paneId, signal);
      if (!closed.ok) {
        return this.transportFailure("launch", runRes, { pane: paneId });
      }
      this.owned.delete(paneId);
      return this.transportFailure("launch", runRes, { pane: paneId });
    }
    if (signal?.aborted) {
      return this.aborted("launch", paneId, workspaceId);
    }

    // 3) Wait for authoritative managed Pi readiness, not screen heuristics.
    //    This is a launch-specific readiness check (managed-Pi startup draft
    //    protection), separate from the 0.2.0 wait budget.
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
        pane: paneId, workspace: workspaceId,
        status: detectionRes.agent?.agent_status ?? "unknown",
        seq: detectionRes.agent?.state_change_seq,
        code: "agent_not_found",
        owned: true,
        delivery: "not_sent",
        hint: "managed Pi session readiness was not established within the detection window; no task sent; pane remains owned for inspection or closure",
      };
    }

    // 4) Rename the agent so it carries its identity.
    const renameRes = await this.herdr(["agent", "rename", paneId, name], { signal });
    if (!renameRes.ok) {
      return {
        ok: false, outcome: "error", phase: "rename",
        pane: paneId, workspace: workspaceId,
        status: detectionRes.agent?.agent_status,
        seq: detectionRes.agent?.state_change_seq,
        code: renameRes.error?.code ?? "rename_failed",
        detail: renameRes.error?.message,
        owned: true,
        delivery: "not_sent",
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
    return this.submitPrompt(paneId, task, wait, timeoutMs.ms, lines, chars, detectionRes.agent, signal);
  }

  /** Resolve the start destination workspace (current or one explicit id). */
  private async resolveStartWorkspace(
    workspaceArg: unknown,
    signal: AbortSignal | undefined,
  ): Promise<{ id: string; error?: undefined } | { id?: undefined; error: Result }> {
    if (workspaceArg === undefined || workspaceArg === null) {
      const id = await this.resolveOwnWorkspace(signal);
      if (!id) {
        return { error: {
          ok: false, outcome: "error", phase: "validation",
          code: "herdr_context_missing",
          hint: "no HERDR_PANE_ID (or pane lookup failed); supervisor must run inside a herdr pane",
        } };
      }
      return { id };
    }
    if (workspaceArg === "current") {
      const id = await this.resolveOwnWorkspace(signal);
      if (!id) {
        return { error: {
          ok: false, outcome: "error", phase: "validation",
          code: "herdr_context_missing",
          hint: "workspace 'current' requested but the current workspace is unknown (no HERDR_PANE_ID)",
        } };
      }
      return { id };
    }
    if (typeof workspaceArg === "string" && workspaceArg.trim() !== "") {
      // Explicit destination: verify the workspace exists before any mutation.
      const res = await this.herdr(["workspace", "get", workspaceArg], { signal });
      if (!res.ok) {
        return { error: {
          ok: false, outcome: "error", phase: "validation",
          code: res.error?.code ?? "workspace_not_found",
          hint: `launch destination workspace ${workspaceArg} not found; list workspaces with the spaces operation`,
        } };
      }
      // The pane split always creates a sibling in the SUPERVISOR's workspace.
      // An explicit different destination is not supported: the split cannot
      // target another workspace. Reject before any mutation to avoid orphan
      // panes.
      const ownWs = await this.resolveOwnWorkspace(signal);
      if (ownWs && workspaceArg !== ownWs) {
        return { error: {
          ok: false, outcome: "error", phase: "validation",
          code: "workspace_unsupported",
          hint: `start creates the worker in the supervisor's workspace (${ownWs}); a different destination (${workspaceArg}) is not supported; omit workspace or use 'current'`,
        } };
      }
      return { id: workspaceArg };
    }
    return { error: {
      ok: false, outcome: "error", phase: "validation",
      code: "invalid_workspace",
      hint: "workspace must be 'current' or an explicit workspace id (never 'all'; all is not a launch destination)",
    } };
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
  // prompt (agent-neutral) + shared submission path
  // -------------------------------------------------------------------------

  async prompt(args: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
    const pane = typeof args.pane === "string" ? args.pane : "";
    if (!pane) {
      return { ok: false, outcome: "error", phase: "validation", code: "pane_required", hint: "pane (pane id) is required" };
    }
    const boundsError = this.validateConsoleBounds(args);
    if (boundsError) return boundsError;
    if (this.isSelf(pane)) {
      return {
        ok: false, outcome: "denied", phase: "validation", code: "self_control",
        hint: "supervisor cannot prompt itself (its own turn owns this process)",
      };
    }
    const text = typeof args.prompt === "string" ? args.prompt : "";
    if (!text) {
      return { ok: false, outcome: "error", phase: "validation", code: "prompt_required", hint: "prompt (non-empty string) is required" };
    }
    const wait = args.wait !== false; // prompt defaults to wait=true (opt-out)
    const timeoutMs = this.resolveWaitBudget(args, wait, "prompt");
    if (timeoutMs.error) return timeoutMs.error;
    const { lines, chars, source } = this.resolveConsoleBounds(args);

    // Preflight: a typed agent get. Working is allowed (busy prompt): report
    // submittedWhile and do not create an automatic pending association.
    // Blocked (agent_blocked) is an actual Herdr refusal -> not_sent.
    const pre = await this.agentGet(pane, signal);
    if (pre === "error") {
      return {
        ok: false, outcome: "error", phase: "preflight",
        code: "preflight_failed", pane,
        hint: "preflight agent get failed; inspect the pane before prompting",
      };
    }
    if (pre === null) {
      return {
        ok: false, outcome: "error", phase: "preflight",
        code: "agent_not_found", pane,
        hint: "target agent not detected; inspect the pane (read with source 'raw') before prompting",
      };
    }

    const busy = pre.agent_status === "working";
    if (pre.agent_status === "blocked") {
      // Actual CLI agent_blocked -> not_sent.
      return {
        ok: false, outcome: "not_sent", phase: "preflight",
        pane, status: "blocked", seq: pre.state_change_seq, agent: pre.agent,
        delivery: "not_sent", code: "agent_blocked",
        hint: "agent is blocked; Herdr refuses the submission (agent_blocked); inspect the pane",
      };
    }

    return this.submitPrompt(pane, text, wait, timeoutMs.ms, lines, chars, pre, signal, {
      submittedWhile: busy ? "working" : pre.agent_status,
      busy,
      source,
    });
  }

  /**
   * Shared submission: agent prompt, optional --wait, pending-context
   * bookkeeping, console capture. Used by start (post-detection) and by the
   * agent-neutral prompt operation.
   */
  private async submitPrompt(
    pane: string,
    text: string,
    wait: boolean,
    timeoutMs: number,
    lines: number,
    chars: number,
    preAgent: AgentInfo | null,
    signal?: AbortSignal,
    extra?: { submittedWhile?: string; busy?: boolean; source?: "auto" | "agent" | "raw" },
  ): Promise<Result> {
    const phase = "submission";
    const boundsError = this.validateConsoleBounds({ returnLines: lines, maxChars: chars });
    if (boundsError) return boundsError;
    const preSeq = preAgent?.state_change_seq;
    const preStatus = preAgent?.agent_status;

    // Preflight working state for start too (launch preflight may observe a
    // turn already running); busy start submits only when the CLI accepts it.
    const busy = extra?.busy ?? (preStatus === "working");

    const cmd: string[] = ["agent", "prompt", pane, text];
    if (wait) {
      cmd.push("--wait", "--timeout", String(timeoutMs));
    }

    // Concurrent working-evidence sampler (wait only): samples real
    // `agent get` working states. It is STOPPED when the prompt returns.
    let workingSample: { status: string; seq: number } | null = null;
    let sampler: { promise: Promise<{ status: string; seq: number } | null>; stop: () => void } | undefined;
    if (wait) {
      sampler = this.startWorkingSampler(pane, timeoutMs, signal);
      sampler.promise.then((s) => {
        if (s && !workingSample) workingSample = s;
      });
    }

    const res = await this.herdr(cmd, {
      signal,
      timeoutMs: wait ? timeoutMs + 5_000 : undefined,
    });
    if (sampler) {
      sampler.stop();
      await sampler.promise.catch(() => {});
    }

    // Abort: delivery unknown (an in-flight abort does not prove not-sent).
    // An attempted new submission that MAY have reached the pane must
    // supersede/delete the old association so a later wait never treats the
    // old prompt as the latest.
    if (res.error?.code === "aborted" || res.transportCode === "aborted") {
      this.pending.delete(pane);
      return {
        ok: false, outcome: "cancelled", phase,
        pane, status: preStatus, seq: preSeq,
        delivery: "unknown", code: "aborted",
        hint: "aborted during submission; delivery unknown — verify with subagent_read before any resend",
      };
    }

    if (!res.ok) {
      const code = res.error?.code ?? res.transportCode ?? "prompt_failed";
      if (code === "agent_prompt_stalled" || code === "timeout") {
        // Timeout/stall: include current status + console. A timeout is NOT
        // working evidence and never implies the worker was stopped.
        // The submission may have reached the pane: supersede the old context.
        this.pending.delete(pane);
        const after = await this.agentGet(pane, signal);
        const status = after === "error" || after === null ? undefined : after.agent_status;
        const seq = after === "error" || after === null ? undefined : after.state_change_seq;
        const consoleOut = await this.captureConsole(pane, lines, chars, extra?.source ?? "auto", signal);
        return {
          ok: false,
          outcome: code === "agent_prompt_stalled" ? "stalled" : "timeout",
          phase,
          pane,
          status,
          seq,
          delivery: "unknown",
          ...this.consoleSpread(consoleOut),
          code,
          hint: "submission may have been accepted but the turn did not reach a terminal state within the window; the worker may still run; inspect, do not auto-resend",
        };
      }
      // Generic transport failure: the submission may or may not have reached
      // the pane. Supersede the old context so a later wait does not treat
      // the old prompt as the latest.
      this.pending.delete(pane);
      return this.transportFailure(phase, res, { pane });
    }

    // Success path: only a real `agent_prompted` receipt acknowledges.
    if (!isPromptReceipt(res.doc)) {
      this.pending.delete(pane);
      return this.transportFailure(phase, res, { pane });
    }
    // Receipt status/sequence must come from the receipt itself, never preflight.
    // Preflight remains available separately for identity and baseline fallback.
    const ackAgent = agentOf(res.doc) ?? {};

    // Internal pending context (memory only; a new submission supersedes).
    // Busy submissions carry NO automatic association: the Herdr wait may
    // match the pre-existing active turn (may_reflect_prior_turn).
    const reportedWorking =
      ackAgent.agent_status === "working" && typeof ackAgent.state_change_seq === "number"
        ? { status: "working" as const, seq: ackAgent.state_change_seq }
        : null;
    const observedWorking = workingSample ?? reportedWorking;
    const rec: PendingContext = {
      pane_id: pane,
      workspace_id: preAgent?.workspace_id ?? ackAgent.workspace_id,
      terminal_id: preAgent?.terminal_id ?? ackAgent.terminal_id,
      name: preAgent?.name ?? ackAgent.name ?? undefined,
      baseline_seq: preSeq,
      delivery_confirmed: true,
      receipt_seq: ackAgent.state_change_seq,
      receipt_state: ackAgent.agent_status,
      working_observed: observedWorking !== null,
      working_seq: observedWorking?.seq,
      submitted_while: extra?.submittedWhile ?? preStatus,
    };
    if (busy) {
      // No automatic pending association for a busy submission.
      this.pending.delete(pane);
    } else {
      this.pending.set(pane, rec);
    }

    if (!wait) {
      return {
        ok: true, outcome: "submitted", phase,
        pane,
        workspace: preAgent?.workspace_id ?? ackAgent.workspace_id,
        agent: ackAgent.agent ?? preAgent?.agent,
        status: ackAgent.agent_status ?? preStatus,
        seq: ackAgent.state_change_seq ?? preSeq,
        delivery: "acknowledged",
        owned: this.isOwned(pane) !== undefined,
        code: "agent_prompted",
        submittedWhile: extra?.submittedWhile ?? preStatus,
        hint: "submission receipt (agent_prompted); the turn has not completed; wait with subagent_wait {pane} when needed",
      };
    }

    if (!TERMINAL_STATES.includes(ackAgent.agent_status ?? "")) {
      return {
        ok: false, outcome: "error", phase,
        pane, status: ackAgent.agent_status, seq: ackAgent.state_change_seq,
        delivery: "acknowledged",
        code: "unexpected_wait_state",
        hint: "agent prompt --wait returned a non-terminal state; submission confirmed, inspect before re-waiting",
      };
    }
    // Terminal state reached via --wait. Console failures never erase the
    // terminal observation.
    const consoleOut = await this.captureConsole(pane, lines, chars, extra?.source ?? "auto", signal);
    // Tier 1 fast case: the acknowledgement already observed a terminal
    // status newer than the pre-submit baseline; the live pane must still
    // observe that same terminal sequence (checked in wait; here the CLI
    // --wait already returned the terminal state, so label tier 2 unless
    // seq equals the pre-submit baseline edge case). With a terminal receipt
    // strictly newer than baseline this is a fresh terminal observation.
    const status = ackAgent.agent_status;
    const freshTerminal = typeof ackAgent.state_change_seq === "number"
      && typeof preSeq === "number"
      && ackAgent.state_change_seq > preSeq;
    // When both seq are missing, freshTerminal is false but the terminal was
    // observed via agent prompt --wait — label it as a genuine observation,
    // not a stale snapshot.
    const seqMissing = typeof ackAgent.state_change_seq !== "number" || typeof preSeq !== "number";
    // When a wait:true prompt observes a fresh terminal, mark the record
    // settled so a subsequent wait does not replay tier-1 as a new
    // observation. The terminal was observed directly by the --wait call.
    if (freshTerminal && !busy) {
      rec.settled = true;
    }
    if (status === "blocked") {
      return {
        ok: false, outcome: "needs_attention", phase,
        pane, status, seq: ackAgent.state_change_seq,
        delivery: "acknowledged",
        submittedWhile: busy ? "working" : preStatus,
        ...this.consoleSpread(consoleOut),
        code: "agent_blocked",
        observation: busy ? "may_reflect_prior_turn" : (freshTerminal ? "state_changed_after_submission" : (seqMissing ? "terminal_observed" : "snapshot")),
        hint: "agent blocked (may be a write-guard success in readonly mode); inspect",
      };
    }
    return {
      ok: true,
      outcome: "terminal_observed",
      phase,
      pane,
      workspace: preAgent?.workspace_id ?? ackAgent.workspace_id,
      agent: ackAgent.agent ?? preAgent?.agent,
      status: status ?? "unknown",
      seq: ackAgent.state_change_seq,
      delivery: "acknowledged",
      owned: this.isOwned(pane) !== undefined,
      submittedWhile: busy ? "working" : preStatus,
      ...this.consoleSpread(consoleOut),
      code: status ?? "terminal",
      observation: busy ? "may_reflect_prior_turn" : (freshTerminal ? "state_changed_after_submission" : (seqMissing ? "terminal_observed" : "snapshot")),
      hint: "terminal state observed after confirmed delivery; not proof of task completion; verify task-specific output",
    };
  }

  /**
   * Resolve wait/timeoutMs against the 0.2.0 contract.
   *  - explicit timeoutMs with wait=false is rejected (migration hint)
   *  - wait defaults: start false, prompt true, wait true
   *  - budgets: default waitMs, max maxWaitMs
   */
  private resolveWaitBudget(
    args: Record<string, unknown>,
    wait: boolean,
    operation: string,
  ): { ms: number; error?: undefined } | { ms?: undefined; error: Result } {
    const raw = args.timeoutMs;
    if (raw !== undefined) {
      if (!wait) {
        return { error: {
          ok: false, outcome: "error", phase: "validation",
          code: "timeout_without_wait",
          hint: `explicit timeoutMs is not accepted when wait=false (${operation}); the budget bounds the wait phase — set wait=true (or drop timeoutMs)`,
        } };
      }
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
        return { error: {
          ok: false, outcome: "error", phase: "validation",
          code: "invalid_timeout",
          hint: "timeoutMs must be a positive finite number (milliseconds)",
        } };
      }
      if (raw > this.defaults.maxWaitMs) {
        return { error: {
          ok: false, outcome: "error", phase: "validation",
          code: "timeout_too_large",
          hint: `timeoutMs must be <= ${this.defaults.maxWaitMs} ms`,
        } };
      }
      return { ms: Math.floor(raw) };
    }
    if (!wait) return { ms: 0 };
    return { ms: this.defaults.waitMs };
  }

  /** Resolve returnLines/maxChars/source with 0.2.0 defaults and ceilings. */
  private resolveConsoleBounds(args: Record<string, unknown>): {
    lines: number;
    chars: number;
    source: "auto" | "agent" | "raw";
  } {
    const rawLines = args.returnLines;
    let lines = this.defaults.consoleLines;
    if (rawLines !== undefined) {
      if (typeof rawLines !== "number" || !Number.isInteger(rawLines) || rawLines < 0 || rawLines > this.defaults.maxConsoleLines) {
        // Out-of-bounds or invalid input: fail validation (no silent clamp of
        // garbage), keep intended behavior honest.
        lines = 0; // handled by caller validation below via error return
        lines = NaN;
      } else {
        lines = rawLines;
      }
    }
    if (Number.isNaN(lines)) {
      lines = this.defaults.consoleLines;
    }
    const rawChars = args.maxChars;
    let chars = this.defaults.consoleChars;
    if (rawChars !== undefined) {
      if (typeof rawChars !== "number" || !Number.isInteger(rawChars) || rawChars < 0 || rawChars > this.defaults.maxConsoleChars) {
        chars = NaN;
      } else {
        chars = rawChars;
      }
    }
    if (Number.isNaN(chars)) {
      chars = this.defaults.consoleChars;
    }
    let source: "auto" | "agent" | "raw" = "auto";
    if (args.source !== undefined) {
      if (args.source === "auto" || args.source === "agent" || args.source === "raw") {
        source = args.source;
      } else {
        source = "auto";
      }
    }
    return { lines, chars, source };
  }

  /**
   * Strict validation for console bounds (called before any herdr action on
   * operations that carry returnLines/maxChars/source). Returns an error
   * Result when an out-of-range value was supplied.
   */
  private validateConsoleBounds(args: Record<string, unknown>): Result | null {
    const rawLines = args.returnLines;
    if (rawLines !== undefined && (typeof rawLines !== "number" || !Number.isInteger(rawLines) || rawLines < 0 || rawLines > this.defaults.maxConsoleLines)) {
      return {
        ok: false, outcome: "error", phase: "validation",
        code: "invalid_return_lines",
        hint: `returnLines must be an integer 0..${this.defaults.maxConsoleLines} (0 disables console capture)`,
      };
    }
    const rawChars = args.maxChars;
    if (rawChars !== undefined && (typeof rawChars !== "number" || !Number.isInteger(rawChars) || rawChars < 0 || rawChars > this.defaults.maxConsoleChars)) {
      return {
        ok: false, outcome: "error", phase: "validation",
        code: "invalid_max_chars",
        hint: `maxChars must be an integer 0..${this.defaults.maxConsoleChars} code points`,
      };
    }
    if (args.source !== undefined && args.source !== "auto" && args.source !== "agent" && args.source !== "raw") {
      return {
        ok: false, outcome: "error", phase: "validation",
        code: "invalid_source",
        hint: 'source must be "auto", "agent" (strict) or "raw" (explicit pane read)',
      };
    }
    return null;
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

  // -------------------------------------------------------------------------
  // read
  // -------------------------------------------------------------------------

  async read(args: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
    const pane = typeof args.pane === "string" ? args.pane : "";
    if (!pane) {
      return { ok: false, outcome: "error", phase: "validation", code: "pane_required", hint: "pane (pane id) is required" };
    }
    const boundsError = this.validateConsoleBounds(args);
    if (boundsError) return boundsError;
    const { lines, chars, source } = this.resolveConsoleBounds(args);
    let agent: AgentInfo | null = null;
    if (source !== "raw") {
      const lookup = await this.herdr(["agent", "get", pane], { signal });
      if (!lookup.ok && lookup.error?.code !== "agent_not_found") {
        return {
          ok: false, outcome: "read_failed", phase: "read", pane,
          code: "console_read_failed", detail: this.describeFailure(lookup),
          hint: "agent lookup failed; no raw fallback; inspect the pane",
        };
      }
      agent = agentOf(lookup.doc) ?? null;
    }
    const observed = { status: source === "raw" || !agent ? "unknown" : agent.agent_status,
      seq: agent?.state_change_seq, agent: agent?.agent, workspace: agent?.workspace_id };
    if (lines <= 0) {
      return {
        ok: true, outcome: "read", phase: "read", pane, ...observed,
        hint: "returnLines=0: console capture disabled; no console returned",
      };
    }
    const out = await this.readConsole(pane, lines, source === "auto" && !agent ? "raw" : source, signal);
    if (!out.ok) {
      return {
        ok: false, outcome: "read_failed", phase: "read", pane,
        status: out.source === "raw" ? "unknown" : undefined,
        code: "console_read_failed",
        detail: out.error,
        hint: "console read failed; the action result (if any) is unaffected — inspect the pane",
      };
    }
    const tailed = tailCodePoints(out.text, chars);
    return {
      ok: true, outcome: "read", phase: "read",
      pane,
      ...observed,
      status: out.source === "raw" ? "unknown" : observed.status,
      console: tailed.text,
      consoleSource: out.source,
      truncated: tailed.clipped || undefined,
      ...(out.hint ? { hint: out.hint } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // wait routing (single-pane vs multi-pane; docs/multi_pane_wait.md)
  // -------------------------------------------------------------------------

  /**
   * Route subagent_wait: single-pane `pane` keeps the exact 0.2.0 contract
   * (byte-identical, A12); `panes` + `until` ("first" | "all") runs the
   * multi-pane wait. The two addressing forms are mutually exclusive —
   * no implicit default (A10).
   */
  private async routeWait(args: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
    const pane = typeof args.pane === "string" && args.pane !== "" ? args.pane : undefined;
    const hasPanes = args.panes !== undefined;

    if (pane !== undefined && hasPanes) {
      return {
        ok: false, outcome: "error", phase: "validation",
        code: "pane_and_panes",
        hint: "pane and panes are mutually exclusive; pass one addressing form",
      };
    }
    if (pane !== undefined && args.until !== undefined) {
      // A9/A10: until is multi-pane only; with single-pane addressing it is
      // rejected before any herdr call (single-pane behavior stays intact).
      return {
        ok: false, outcome: "error", phase: "validation",
        code: "until_with_pane",
        hint: "until applies only to multi-pane waits (panes); pass pane alone for a single-pane wait",
      };
    }
    if (pane === undefined && !hasPanes) {
      return {
        ok: false, outcome: "error", phase: "validation",
        code: "pane_required", hint: "pane (single-pane) or panes (multi-pane) is required",
      };
    }
    if (pane !== undefined) {
      // 0.2.0 single-pane behavior, untouched (A12); panes/until ignored here.
      return this.wait({ ...args, pane }, signal);
    }

    // ---- Multi-pane validation (all BEFORE any herdr call; A10) ----
    const panesArg = args.panes;
    if (!Array.isArray(panesArg)) {
      return {
        ok: false, outcome: "error", phase: "validation", code: "panes_invalid",
        hint: "panes must be an array of pane ids",
      };
    }
    const panes: string[] = [];
    for (const entry of panesArg) {
      if (typeof entry !== "string" || entry.length === 0) {
        return {
          ok: false, outcome: "error", phase: "validation", code: "panes_invalid",
          hint: "panes must be an array of non-empty pane id strings",
        };
      }
      panes.push(entry);
    }
    if (panes.length === 0) {
      return {
        ok: false, outcome: "error", phase: "validation", code: "panes_empty",
        hint: "panes must name at least one pane",
      };
    }
    if (new Set(panes).size !== panes.length) {
      return {
        ok: false, outcome: "error", phase: "validation", code: "panes_duplicate",
        hint: "panes must not repeat a pane id",
      };
    }
    for (const id of panes) {
      if (this.isSelf(id)) {
        return {
          ok: false, outcome: "denied", phase: "validation", code: "self_control",
          hint: `pane ${id} is the supervisor's own pane; multi-pane wait cannot address the controller`,
        };
      }
    }
    const until = args.until;
    if (until !== "first" && until !== "all") {
      return {
        ok: false, outcome: "error", phase: "validation",
        code: until === undefined ? "until_required" : "until_invalid", // multi-pane only
        hint: until === undefined
          ? 'until must be "first" or "all" when panes is given'
          : 'until must be "first" or "all"',
      };
    }
    const boundsError = this.validateConsoleBounds(args);
    if (boundsError) return boundsError;
    const timeoutMs = this.resolveWaitBudget(args, true, "wait");
    if (timeoutMs.error) return timeoutMs.error;

    return this.multiWait(panes, until, timeoutMs.ms, args, signal);
  }

  // -------------------------------------------------------------------------
  // wait (pane-only; internal pending context; two-tier freshness)
  // -------------------------------------------------------------------------

  async wait(args: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
    const pane = typeof args.pane === "string" ? args.pane : "";
    if (!pane) {
      return { ok: false, outcome: "error", phase: "validation", code: "pane_required", hint: "pane (pane id) is required" };
    }
    if (this.isSelf(pane)) {
      return {
        ok: false, outcome: "denied", phase: "validation", code: "self_control",
        hint: "supervisor cannot wait on itself (its own turn owns this process)",
      };
    }
    const timeoutMs = this.resolveWaitBudget(args, true, "wait");
    if (timeoutMs.error) return timeoutMs.error;
    const boundsError = this.validateConsoleBounds(args);
    if (boundsError) return boundsError;
    const { lines, chars, source } = this.resolveConsoleBounds(args);
    const deadline = this.now() + timeoutMs.ms;

    const pre = await this.agentGet(pane, signal);
    if (pre === "error") {
      return {
        ok: false, outcome: "error", phase: "preflight",
        code: "preflight_failed", pane,
        hint: "preflight agent get failed; inspect the pane",
      };
    }
    if (pre === null) {
      return {
        ok: false, outcome: "error", phase: "preflight",
        code: "agent_not_found", pane,
        hint: "target agent not detected",
      };
    }

    // -- Internal pending context (memory only, superseded per pane) -------
    let rec = this.pending.get(pane);
    if (rec && !rec.settled) {
      const identityDrift = this.pendingIdentityDrift(rec, pre);
      if (identityDrift) {
        // Identity changed under the record: discard the association; the
        // explicit pane address targets whoever is currently there.
        // Stale bookkeeping must never veto an explicit pane call: discard
        // and observe the current identity (no error-for-drift).
        this.pending.delete(pane);
        rec = undefined;
      } else {
      // Tier 1: acknowledgement already terminal, its seq newer than the
      // pre-submit baseline, identity matched, and the fresh lookup still
      // observes that same terminal sequence -> settle once, fast return.
      // If the live pane is now working, use tier 2 instead.
      if (
        rec.receipt_state !== undefined
        && TERMINAL_STATES.includes(rec.receipt_state)
        && typeof rec.receipt_seq === "number"
        && typeof rec.baseline_seq === "number"
        && rec.receipt_seq > rec.baseline_seq
      ) {
        if (pre.agent_status === "working") {
          // Fall through to tier 2 (live working overrides the fast case).
        } else if (
          TERMINAL_STATES.includes(pre.agent_status ?? "")
          && typeof pre.state_change_seq === "number"
          && pre.state_change_seq === rec.receipt_seq
        ) {
          rec.settled = true;
          const consoleOut = await this.captureConsole(pane, lines, chars, source, signal);
          return {
            ok: pre.agent_status !== "blocked",
            outcome: pre.agent_status === "blocked" ? "needs_attention" : "terminal_observed",
            phase: "wait",
            pane,
            status: pre.agent_status,
            seq: pre.state_change_seq,
            delivery: rec.delivery_confirmed ? "acknowledged" : "unknown",
            ...this.consoleSpread(consoleOut),
            code: pre.agent_status === "blocked" ? "agent_blocked" : "terminal_seen_during_submission",
            observation: rec.submitted_while === "working" ? "may_reflect_prior_turn" : "terminal_seen_during_submission",
            hint: "terminal state already observed at submission time (same sequence); settled once; not proof of task completion",
          };
        } else {
          // The live state differs from the acknowledgement snapshot: treat
          // the pending record as stale for the fast path; fall to tier 2.
        }
      }
      // Tier 2: wait for a terminal status with seq greater than the
      // acknowledgement baseline, identity unchanged.
      return this.waitPendingPane(pane, rec, deadline, lines, chars, source, signal);
      }
    }

    // -- No matching pending context ----------------------------------------
    if (TERMINAL_STATES.includes(pre.agent_status ?? "")) {
      // Already terminal with no context: labelled snapshot (this wait did
      // not observe the turn). Never return a saved/stale terminal as if it
      // were observed now.
      const consoleOut = await this.captureConsole(pane, lines, chars, source, signal);
      return {
        ok: pre.agent_status !== "blocked",
        outcome: pre.agent_status === "blocked" ? "needs_attention" : "terminal_observed",
        phase: "wait",
        pane,
        status: pre.agent_status,
        seq: pre.state_change_seq,
        ...this.consoleSpread(consoleOut),
        code: "snapshot",
        observation: "snapshot",
        hint: "current terminal state snapshot; no pending submission context, so this did not observe the turn — not proof of task completion",
      };
    }

    // Current-pane observation: event wait racing idle + done + blocked.
    const remainingMs = Math.max(1, deadline - this.now());
    const res = await this.herdr(
      [
        "agent", "wait", pane,
        "--until", "idle",
        "--until", "done",
        "--until", "blocked",
        "--timeout", String(remainingMs),
      ],
      { signal, timeoutMs: remainingMs + 5_000 },
    );
    if (res.error?.code === "aborted" || res.transportCode === "aborted") {
      const after = await this.agentGet(pane, signal);
      const status = after === "error" || after === null ? undefined : after.agent_status;
      const seq = after === "error" || after === null ? undefined : after.state_change_seq;
      return {
        ok: false, outcome: "cancelled", phase: "wait",
        pane, status, seq,
        code: "aborted", hint: "wait cancelled; worker keeps running",
      };
    }
    if (!res.ok) {
      const after = await this.agentGet(pane, signal);
      const status = after === "error" || after === null ? undefined : after.agent_status;
      const seq = after === "error" || after === null ? undefined : after.state_change_seq;
      if (res.error?.code === "timeout" || res.transportCode === "TimeoutError") {
        // Timeout: NOT delivery proof, NOT working evidence; include the
        // current status + console. A pending record (if any) stays pending.
        const consoleOut = await this.captureConsole(pane, lines, chars, source, signal);
        return {
          ok: false, outcome: "timeout", phase: "wait",
          pane,
          status,
          seq,
          ...this.consoleSpread(consoleOut),
          code: "timeout",
          observation: "snapshot",
          hint: "no terminal state within the window; the worker may still run; inspect before re-waiting (no auto-resend)",
        };
      }
      return this.transportFailure("wait", res, { pane });
    }
    const agent = agentOf(res.doc) ?? pre;
    if (!TERMINAL_STATES.includes(agent.agent_status ?? "")) {
      return {
        ok: false, outcome: "error", phase: "wait",
        pane, status: agent.agent_status, seq: agent.state_change_seq,
        code: "unexpected_wait_state",
        hint: "agent wait returned a non-terminal state; no terminal observation, inspect before retrying",
      };
    }
    const consoleOut = await this.captureConsole(pane, lines, chars, source, signal);
    return {
      ok: agent.agent_status !== "blocked",
      outcome: agent.agent_status === "blocked" ? "needs_attention" : "terminal_observed",
      phase: "wait",
      pane,
      status: agent.agent_status,
      seq: agent.state_change_seq,
      ...this.consoleSpread(consoleOut),
      code: "snapshot",
      observation: "snapshot",
      hint: "terminal state snapshot; not proof of a specific task turn",
    };
  }

  // -------------------------------------------------------------------------
  // multi-pane wait (docs/multi_pane_wait.md; adjudications A1–A14)
  // -------------------------------------------------------------------------


  /**
   * Multi-pane wait over `panes` until the first eligible fresh terminal
   * observation (until="first") or the shared deadline (until="all").
   *
   * Guarantees (A1–A14):
   * - pending contexts settle at observation time (A2 settle-once), keeping
   *   the two-tier freshness model per pane (A1);
   * - every pane yields exactly one entry (A6); error/timeout/working/snapshot
   *   entries are first-class, never hidden;
   * - per-pane console bound maxChars; top-level truncated iff any pane
   *   clipped (A7);
   * - deterministic input order in results/panes; input-order tie-breaks
   *   (A8);
   * - local-only reaping: the internal AbortController cancels the local CLI
   *   monitors; no pane close/interrupt/kill (A13);
   * - single-pane behavior untouched (A12): `wait()` is not modified.
   */
  private async multiWait(
    panes: string[],
    until: "first" | "all",
    budgetMs: number,
    args: Record<string, unknown>,
    externalSignal: AbortSignal | undefined,
  ): Promise<Result> {
    const { lines, chars, source } = this.resolveConsoleBounds(args);
    const deadline = this.now() + budgetMs;
    const calls = new AbortController();
    const observers = new AbortController();
    const preflights = new Map<string, AgentInfo | "error" | null>();
    const entries = new Map<string, MultiPaneEntry>();
    const driftedPreflights = new Set<string>();
    let winner: string | null = null;
    let deadlineHit = false;
    // Winner cancellation applies only to observation operations. Console reads
    // retain a live caller/deadline signal; no worker-control command is sent.
    const cancel = (): void => { calls.abort(); observers.abort(); };
    externalSignal?.addEventListener("abort", cancel, { once: true });
    if (externalSignal?.aborted) cancel();
    const timer = setTimeout(() => { deadlineHit = true; cancel(); }, budgetMs);

    const pendingEntry = (id: string, pre?: AgentInfo): MultiPaneEntry => ({
      pane: id, outcome: driftedPreflights.has(id) ? "working" : "timeout", status: pre?.agent_status,
      seq: pre?.state_change_seq,
      code: externalSignal?.aborted ? "aborted" : driftedPreflights.has(id) ? "identity_drift" : deadlineHit ? "timeout" : "pending",
      observation: externalSignal?.aborted || !pre ? "pending" : "snapshot",
      hint: "no terminal observation; only local observation operations were cancelled; the worker may still run",
    });
    const driftEntry = (id: string, agent: AgentInfo): MultiPaneEntry => ({
      pane: id, outcome: agent.agent_status === "blocked" ? "needs_attention" : "terminal_observed",
      status: agent.agent_status, seq: agent.state_change_seq,
      code: "identity_drift", observation: "snapshot",
      hint: "agent identity changed; old association discarded; current terminal snapshot is not attributable to the submitted task",
    });
    const latch = (id: string): void => {
      if (until === "first" && winner === null) {
        winner = id;
        observers.abort();
      }
    };
    const recordTerminal = (id: string, agent: AgentInfo, pre?: AgentInfo): void => {
      const rec = this.pending.get(id);
      const changedSincePreflight = !!pre && (
        (!!pre.workspace_id && !!agent.workspace_id && pre.workspace_id !== agent.workspace_id)
        || (!!pre.terminal_id && !!agent.terminal_id && pre.terminal_id !== agent.terminal_id)
      );
      if (changedSincePreflight || !this.identityMatches(rec, agent)) {
        this.pending.delete(id);
        entries.set(id, driftEntry(id, agent));
        return; // Reused-agent observations never win the old wait.
      }
      // Settlement and entry publication are synchronous at observation time,
      // before winner cancellation or any asynchronous console read.
      const settled = this.settleAtObservation(id, agent, lines, chars, source);
      entries.set(id, settled ?? {
        pane: id,
        outcome: agent.agent_status === "blocked" ? "needs_attention" : "terminal_observed",
        status: agent.agent_status, seq: agent.state_change_seq,
        code: "snapshot", observation: "snapshot",
        hint: pre
          ? "terminal observed by this call without submission attribution; not proof of task completion"
          : "already-terminal snapshot; this call did not observe a fresh transition",
      });
      if (settled || (pre && (!rec || rec.settled))) latch(id);
    };

    // Start every preflight concurrently in input order. Fresh observations
    // latch immediately, rather than waiting behind a slow peer's preflight.
    // Equally-ready promises retain input order; different observation times
    // never get re-sorted. Awaiting jobs also awaits actual transport reaping:
    // an abort-only race would hide a still-running local CLI operation.
    const jobs = panes.map(async (id): Promise<void> => {
      if (observers.signal.aborted) { entries.set(id, pendingEntry(id)); return; }
      const lookup = await this.herdr(["agent", "get", id], { signal: observers.signal });
      const pre = lookup.ok ? agentOf(lookup.doc) ?? null : "error";
      preflights.set(id, pre);
      if (deadlineHit || this.now() >= deadline) {
        deadlineHit = true;
        cancel();
        entries.set(id, pendingEntry(id));
        return;
      }
      if (pre === "error" || pre === null) {
        entries.set(id, observers.signal.aborted ? pendingEntry(id) : {
          pane: id, outcome: "error", code: lookup.error?.code ?? lookup.transportCode ?? "agent_not_found", observation: "error",
          hint: lookup.error?.message ?? "pane or managed agent unavailable at preflight",
        });
        return;
      }
      const drifted = !this.identityMatches(this.pending.get(id), pre);
      if (drifted) { this.pending.delete(id); driftedPreflights.add(id); }
      if (TERMINAL_STATES.includes(pre.agent_status ?? "")) {
        if (drifted) entries.set(id, driftEntry(id, pre));
        else recordTerminal(id, pre);
        return;
      }
      if (observers.signal.aborted) { entries.set(id, pendingEntry(id, pre)); return; }
      const remaining = Math.max(1, deadline - this.now());
      const res = await this.herdr([
        "agent", "wait", id, "--until", "idle", "--until", "done", "--until", "blocked",
        "--timeout", String(remaining),
      ], { signal: observers.signal, timeoutMs: remaining + 5_000 });
      // Even after another winner/caller cancellation, a genuine completed
      // terminal payload is an observation. Drain and preserve it, not an
      // aborted transport's nonexistent observation. Deadline is different:
      // events outside the observation budget cannot create a winner.
      if (deadlineHit || this.now() >= deadline) {
        deadlineHit = true; cancel(); entries.set(id, pendingEntry(id, pre)); return;
      }
      if (res.ok) {
        const agent = agentOf(res.doc);
        if (agent && TERMINAL_STATES.includes(agent.agent_status ?? "")) {
          recordTerminal(id, agent, pre);
        } else {
          entries.set(id, { pane: id, outcome: "error", code: "unexpected_wait_state", observation: "error" });
        }
        return;
      }
      if (observers.signal.aborted || res.error?.code === "aborted") {
        entries.set(id, pendingEntry(id, pre)); return;
      }
      if (res.error?.code === "timeout" || res.transportCode === "TimeoutError") {
        const post = await this.agentGet(id, observers.signal);
        if (!deadlineHit && post && post !== "error" && TERMINAL_STATES.includes(post.agent_status ?? "")) {
          recordTerminal(id, post, pre);
        } else {
          entries.set(id, {
            ...pendingEntry(id, post && post !== "error" ? post : pre),
            code: driftedPreflights.has(id) ? "identity_drift" : "timeout",
          });
        }
        return;
      }
      const code = res.error?.code ?? res.transportCode ?? "agent_wait_failed";
      entries.set(id, { pane: id, outcome: "error", code, observation: "error", hint: this.hintFor(code, "wait") });
    });

    try {
      const completions = await Promise.allSettled(jobs);
      completions.forEach((completion, index) => {
        const id = panes[index];
        if (completion.status === "rejected" && !entries.has(id)) {
          entries.set(id, { pane: id, outcome: "error", code: "observation_failed", observation: "error", hint: String(completion.reason) });
        }
      });
      // A first snapshot-only set has no winner; all-mode is a terminal
      // observation barrier, not evidence of task success.
      await Promise.all([...entries.values()].map(async (entry) => {
        if (until === "first" && entry.pane !== winner) return;
        if (entry.outcome !== "terminal_observed" && entry.outcome !== "needs_attention") return;
        const output = await this.captureConsole(entry.pane, lines, chars, source, calls.signal);
        Object.assign(entry, this.multiConsoleSpread(output));
      }));
      return this.finishMultiWait(panes, until, winner, preflights, entries, new Map(), deadlineHit, externalSignal?.aborted ?? false);
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", cancel);
      cancel();
      await Promise.allSettled(jobs);
    }
  }

  /**
   * Identity match between an (unsettled) pending record and a live agent
   * observation. Missing identity stays honest: unknown components never
   * block a settlement, but any KNOWN component that differs is drift.
   */
  private identityMatches(rec: PendingContext | undefined, agent: AgentInfo): boolean {
    if (!rec || rec.settled) return true;
    if (rec.workspace_id && agent.workspace_id && rec.workspace_id !== agent.workspace_id) return false;
    if (rec.terminal_id && agent.terminal_id && rec.terminal_id !== agent.terminal_id) return false;
    return true;
  }

  /**
   * Attempt identity-validated tier-1/tier-2 settlement for a pane whose
   * preflight is already terminal (multi-pane path only; A1). Returns the
   * settled entry when the pending record settles fresh, else undefined (the
   * pane stays a plain snapshot and is never an eligible winner). The
   * check-and-set is synchronous (atomic within one turn): the first client
   * to observe the terminal wins the tier label; concurrent clients see
   * `settled` and fall back to a labelled snapshot (A14(9)). Identity is
   * validated by the caller BEFORE entering (drifted contexts are discarded
   * and never settle here).
   */
  private settleAtObservation(
    pane: string,
    pre: AgentInfo,
    lines: number,
    chars: number,
    source: "auto" | "agent" | "raw",
  ): MultiPaneEntry | null {
    const rec = this.pending.get(pane);
    if (!rec || rec.settled || !rec.delivery_confirmed) return null;
    if (!this.identityMatches(rec, pre)) return null;
    const preSeq = typeof pre.state_change_seq === "number" ? pre.state_change_seq : -1;
    const preStatus = pre.agent_status ?? "unknown";
    // Tier 1: the terminal IS the submission receipt itself — exact
    // sequence AND identity, receipt newer than the pre-submit baseline.
    if (rec.receipt_seq !== undefined && preSeq >= 0 && preSeq === rec.receipt_seq
      && preStatus === (rec.receipt_state ?? "") && rec.baseline_seq !== undefined
      && rec.receipt_seq > rec.baseline_seq) {
      rec.settled = true;
      const busy = rec.submitted_while === "working";
      return {
        pane,
        outcome: preStatus === "blocked" ? "needs_attention" : "terminal_observed",
        status: preStatus,
        seq: pre.state_change_seq,
        code: "terminal_seen_during_submission",
        observation: busy ? "may_reflect_prior_turn" : "terminal_seen_during_submission",
        delivery: "acknowledged",
        hint: "terminal state already observed at submission time (same sequence); settled once; not proof of task completion",
        ...this.multiConsoleSpread(this.consoleSpreadForSettled(lines, chars, source)),
      };
    }
    // Tier 2: terminal strictly newer than the pre-submit baseline, observed
    // by THIS call's preflight -> fresh settlement.
    const baseline = rec.baseline_seq === undefined ? rec.receipt_seq
      : rec.receipt_seq === undefined ? rec.baseline_seq : Math.max(rec.baseline_seq, rec.receipt_seq);
    if (baseline !== undefined && preSeq > baseline) {
      rec.settled = true;
      const busy = rec.submitted_while === "working";
      return {
        pane,
        outcome: preStatus === "blocked" ? "needs_attention" : "terminal_observed",
        status: preStatus,
        seq: pre.state_change_seq,
        code: "state_changed_after_submission",
        observation: busy ? "may_reflect_prior_turn" : "state_changed_after_submission",
        delivery: "acknowledged",
        hint: busy
          ? "the agent was already working when submitted; the observed state may reflect the prior turn; not proof of task completion"
          : "state change after submission observed by this call; not proof of task completion",
        ...this.multiConsoleSpread(this.consoleSpreadForSettled(lines, chars, source)),
      };
    }
    return null;
  }

  /**
   * Console spread for a settled entry that is produced synchronously: the
   * console capture is asynchronous, so settled-at-preflight entries carry
   * the status/seq settlement and no console (the caller-facing bound holds:
   * total output <= panes * maxChars; the winner's console is still captured
   * in finishMultiWait for the winner only when requested). Kept minimal and
   * honest: no fabricated console text.
   */
  private consoleSpreadForSettled(
    _lines: number, _chars: number, _source: "auto" | "agent" | "raw",
  ): Record<string, unknown> {
    return this.consoleSpread({});
  }

  /** Spread console fields into a multi-pane entry (per-pane truncation flag). */
  private multiConsoleSpread(out: Record<string, unknown>): Record<string, unknown> {
    if (out.truncated === true) {
      const rest = { ...out };
      delete rest.truncated;
      rest.paneTruncated = true;
      return rest;
    }
    return out;
  }

  /**
   * Assemble the multi-wait result (A6/A7/A8/A11 shape):
   * - results/panes in input order, exactly one entry per pane;
   * - until=first: winner (or null + code no_winner); a winner makes
   *   ok=true ONLY when it is a plain terminal_observed — a blocked winner
   *   (needs_attention) is actionable, never success;
   * - until=all: ok=true only when every pane is a plain terminal_observed.
   *   Any needs_attention (blocked) or still-pending member makes the
   *   barrier not-success (code needs_attention / partial); errors never
   *   count as success either;
   * - top-level code "aborted" when the caller cancelled (A3), combined with
   *   the winner when the winner was captured before the abort.
   */
  private finishMultiWait(
    panes: string[],
    until: "first" | "all",
    winner: string | null,
    _preflights: Map<string, AgentInfo | "error" | null>,
    entries: Map<string, MultiPaneEntry>,
    _monitorResults: Map<string, unknown>,
    deadlineHit: boolean,
    callerAborted: boolean,
  ): Result {
    const results: MultiPaneEntry[] = panes.map((id) => entries.get(id)!);
    // A7: top-level truncated iff any pane's console tail was clipped.
    let anyTruncated = false;
    for (const e of results) {
      if (e.paneTruncated === true) { anyTruncated = true; delete e.paneTruncated; }
    }
    const stillPending = results
      .filter((e) => e.outcome === "timeout" || e.outcome === "working")
      .filter((e) => e.code === "timeout" || e.code === "identity_drift"
        || e.code === "pending" || e.code === "aborted")
      .map((e) => e.pane);
    const hasNeedsAttention = results.some((e) => e.outcome === "needs_attention");
    const hasError = results.some((e) => e.outcome === "error");

    if (callerAborted) {
      return {
        ok: false,
        outcome: "multi_wait",
        phase: "wait",
        until,
        panes: [...panes],
        results,
        winner: until === "first" ? winner : null,
        stillPending,
        ...(anyTruncated ? { truncated: true } : {}),
        code: "aborted",
        hint: "aborted; local CLI resources reaped, the worker panes were not interrupted or closed",
      } as unknown as Result;
    }

    if (until === "first") {
      if (winner === null) {
        return {
          ok: false,
          outcome: "multi_wait",
          phase: "wait",
          until,
          panes: [...panes],
          results,
          winner: null,
          code: "no_winner",
          stillPending,
          ...(anyTruncated ? { truncated: true } : {}),
          hint: deadlineHit
            ? "shared deadline reached before any eligible terminal observation; partial observations reported; inspect before re-waiting"
            : "no pane can yield a fresh terminal observation; all panes are snapshots or errors; re-wait or inspect",
        } as unknown as Result;
      }
      const winnerEntry = entries.get(winner)!;
      const ok = winnerEntry.outcome === "terminal_observed";
      return {
        ok,
        outcome: "multi_wait",
        phase: "wait",
        until,
        panes: [...panes],
        results,
        winner,
        stillPending,
        ...(anyTruncated ? { truncated: true } : {}),
        ...(winnerEntry.outcome === "needs_attention"
          ? { code: "agent_blocked", hint: "winner reached blocked (needs attention), not success" }
          : {}),
        hint: ok
          ? "a fresh terminal observation was observed by this call; not proof of task completion"
          : undefined,
      } as unknown as Result;
    }

    // until: all — barrier result. Success requires EVERY pane to be a plain
    // terminal observation: blocked (needs_attention), errors and still-pending
    // panes each make the barrier not-success, with distinct codes.
    const allTerminal = results.every((e) => e.outcome === "terminal_observed" || e.outcome === "needs_attention");
    const fullyObserved = !stillPending.length && !hasError;
    const ok = results.every((e) => e.outcome === "terminal_observed");
    const code = !ok ? (!allTerminal || hasError ? "partial" : "needs_attention") : undefined;
    return {
      ok,
      outcome: "multi_wait",
      phase: "wait",
      until,
      panes: [...panes],
      results,
      winner: null,
      stillPending,
      ...(anyTruncated ? { truncated: true } : {}),
      ...(code ? { code } : {}),
      hint: ok
        ? "all panes produced terminal observations under the shared deadline"
        : hasNeedsAttention
          ? (fullyObserved
            ? "all panes observed; at least one reached blocked (needs attention); not a success barrier"
            : "barrier incomplete: blocked member plus pending or failed observations; inspect before re-waiting")
          : hasError
            ? "barrier incomplete: per-pane errors reported; inspect failed panes before re-waiting"
            : stillPending.length
              ? (deadlineHit
                ? "shared deadline reached; partial observations reported with explicit stillPending; inspect before re-waiting"
                : "barrier incomplete; partial observations reported with explicit stillPending; inspect before re-waiting")
              : "barrier reached without success",
    } as unknown as Result;
  }

  private pendingIdentityDrift(rec: PendingContext, agent: AgentInfo): string | undefined {
    if (rec.workspace_id && agent.workspace_id && rec.workspace_id !== agent.workspace_id) {
      return "workspace changed since submission; the pane address now targets a different workspace context";
    }
    if (rec.terminal_id && agent.terminal_id && rec.terminal_id !== agent.terminal_id) {
      return "terminal identity changed since submission (reused/changed pane); not the same agent";
    }
    return undefined;
  }

  /**
   * Tier 2: wait for a terminal status with seq greater than the
   * acknowledgement baseline, identity unchanged. Concurrent waits share the
   * record: whichever observation settles it first marks settled; later
   * calls see it settled and fall back to the normal current-pane rule.
   */
  private async waitPendingPane(
    pane: string,
    rec: PendingContext,
    deadline: number,
    lines: number,
    chars: number,
    source: "auto" | "agent" | "raw",
    signal: AbortSignal | undefined,
  ): Promise<Result> {
    let baselineSeq = this.pendingBaseline(rec);
    let lastAgent: AgentInfo | null = null;

    // Missing-receipt-metadata path: when both the pre-submit baseline and the
    // acknowledgement seq are absent, perform a bounded, separately labelled
    // post-submit lookup (one agent get, non-atomic) to establish a baseline.
    if (baselineSeq === undefined) {
      const lookup = await this.agentGet(pane, signal);
      if (lookup === "error" || lookup === null) {
        // Even the lookup cannot establish a baseline: do NOT settle.
        // Keep the acknowledged action outcome and return a distinct
        // context-establishment error.
        const consoleOut = await this.captureConsole(pane, lines, chars, source, signal);
        return {
          ok: false, outcome: "error", phase: "wait", pane,
          status: undefined, seq: undefined,
          ...this.consoleSpread(consoleOut),
          code: "context_establishment_failed",
          observation: "none",
          hint: "no numeric baseline could be established (preflight and acknowledgement both seq-less; post-submit lookup failed or was also seq-less); the pending submission stays unsettled; inspect the pane before re-waiting",
        };
      }
      const drift = this.pendingIdentityDrift(rec, lookup);
      if (drift) {
        // Identity changed: discard the association; observe the current
        // identity (no error-for-drift). Stale bookkeeping must never veto
        // an explicit pane call.
        this.pending.delete(pane);
        const consoleOut = await this.captureConsole(pane, lines, chars, source, signal);
        if (TERMINAL_STATES.includes(lookup.agent_status ?? "")) {
          return {
            ok: lookup.agent_status !== "blocked",
            outcome: lookup.agent_status === "blocked" ? "needs_attention" : "terminal_observed",
            phase: "wait", pane,
            status: lookup.agent_status, seq: lookup.state_change_seq,
            ...this.consoleSpread(consoleOut),
            code: "snapshot",
            observation: "snapshot",
            hint: "identity drift discarded stale context; current terminal state snapshot — not proof of task completion",
          };
        }
        return {
          ok: true, outcome: "working", phase: "wait", pane,
          status: lookup.agent_status, seq: lookup.state_change_seq,
          ...this.consoleSpread(consoleOut),
          code: "working",
          observation: "snapshot",
          hint: "identity drift discarded stale context; agent is currently working",
        };
      }
      if (typeof lookup.state_change_seq === "number") {
        // The lookup supplies a numeric baseline. If the lookup is terminal,
        // settle with the distinct post-submit-lookup label (never as an
        // acknowledgement snapshot).
        baselineSeq = lookup.state_change_seq;
        if (TERMINAL_STATES.includes(lookup.agent_status ?? "")) {
          rec.settled = true;
          const consoleOut = await this.captureConsole(pane, lines, chars, source, signal);
          const blocked = lookup.agent_status === "blocked";
          return {
            ok: !blocked,
            outcome: blocked ? "needs_attention" : "terminal_observed",
            phase: "wait", pane,
            status: lookup.agent_status, seq: lookup.state_change_seq,
            delivery: rec.delivery_confirmed ? "acknowledged" : "unknown",
            ...this.consoleSpread(consoleOut),
            code: blocked ? "agent_blocked" : "terminal_seen_in_post_submit_lookup",
            observation: rec.submitted_while === "working" ? "may_reflect_prior_turn" : "terminal_seen_in_post_submit_lookup",
            hint: "terminal state observed in the post-submit baseline lookup (non-atomic); not proof of task completion; verify task-specific output",
          };
        }
        // Non-terminal lookup: use as baseline for the tier-2/event-wait path.
        lastAgent = lookup;
      } else {
        // Lookup succeeded but has no numeric seq: cannot establish a baseline.
        const consoleOut = await this.captureConsole(pane, lines, chars, source, signal);
        return {
          ok: false, outcome: "error", phase: "wait", pane,
          status: lookup.agent_status, seq: lookup.state_change_seq,
          ...this.consoleSpread(consoleOut),
          code: "context_establishment_failed",
          observation: "none",
          hint: "post-submit lookup succeeded but carried no numeric state_change_seq; no baseline could be established; the pending submission stays unsettled; inspect the pane before re-waiting",
        };
      }
    }

    // Tier 2 fast check requires a newer TERMINAL state. Working is activity,
    // never a settled wait or evidence that this submission caused the change.
    const live = await this.agentGet(pane, signal);
    if (live !== "error" && live !== null) {
      const drift = this.pendingIdentityDrift(rec, live);
      if (drift) {
        // Identity changed: discard the association; observe the current
        // identity (no error-for-drift).
        this.pending.delete(pane);
        const consoleOut = await this.captureConsole(pane, lines, chars, source, signal);
        if (TERMINAL_STATES.includes(live.agent_status ?? "")) {
          return {
            ok: live.agent_status !== "blocked",
            outcome: live.agent_status === "blocked" ? "needs_attention" : "terminal_observed",
            phase: "wait", pane,
            status: live.agent_status, seq: live.state_change_seq,
            ...this.consoleSpread(consoleOut),
            code: "snapshot",
            observation: "snapshot",
            hint: "identity drift discarded stale context; current terminal state snapshot — not proof of task completion",
          };
        }
        return {
          ok: true, outcome: "working", phase: "wait", pane,
          status: live.agent_status, seq: live.state_change_seq,
          ...this.consoleSpread(consoleOut),
          code: "working",
          observation: "snapshot",
          hint: "identity drift discarded stale context; agent is currently working",
        };
      }
      if (TERMINAL_STATES.includes(live.agent_status ?? "")
        && typeof live.state_change_seq === "number" && typeof baselineSeq === "number"
        && live.state_change_seq > baselineSeq) {
        rec.settled = true;
        const consoleOut = await this.captureConsole(pane, lines, chars, source, signal);
        return {
          ok: live.agent_status !== "blocked",
          outcome: live.agent_status === "blocked" ? "needs_attention" : "terminal_observed",
          phase: "wait", pane,
          status: live.agent_status, seq: live.state_change_seq,
          delivery: rec.delivery_confirmed ? "acknowledged" : "unknown",
          ...this.consoleSpread(consoleOut),
          code: "state_changed_after_submission",
          observation: rec.submitted_while === "working" ? "may_reflect_prior_turn" : "state_changed_after_submission",
          working_observed: rec.working_observed ?? false,
          hint: "newer terminal state observed after submission; not proof of task completion",
        };
      }
      lastAgent = live;
    }

    // Event wait to the first terminal, then verify freshness against the
    // baseline (a terminal at/under the baseline is the stale-idle trap).
    let remainingMs = Math.max(1, deadline - this.now());
    for (;;) {
      const res = await this.herdr(
        [
          "agent", "wait", pane,
          "--until", "idle",
          "--until", "done",
          "--until", "blocked",
          "--timeout", String(remainingMs),
        ],
        { signal, timeoutMs: remainingMs + 5_000 },
      );
      if (res.error?.code === "aborted" || res.transportCode === "aborted") {
        const after = await this.agentGet(pane, signal);
        const status = after === "error" || after === null ? undefined : after.agent_status;
        const seq = after === "error" || after === null ? undefined : after.state_change_seq;
        return {
          ok: false, outcome: "cancelled", phase: "wait",
          pane, status, seq,
          code: "aborted", hint: "wait cancelled; worker keeps running",
        };
      }
      if (!res.ok) {
        if (res.error?.code === "timeout" || res.transportCode === "TimeoutError") {
          // No fresh terminal within the window: the record stays pending.
          const after = lastAgent ?? await this.agentGet(pane, signal);
          const status = after === "error" || after === null ? undefined : after.agent_status;
          const seq = after === "error" || after === null ? undefined : after.state_change_seq;
          const consoleOut = await this.captureConsole(pane, lines, chars, source, signal);
          return {
            ok: false, outcome: "timeout", phase: "wait",
            pane,
            status,
            seq,
            ...this.consoleSpread(consoleOut),
            code: "timeout",
            observation: rec.submitted_while === "working" ? "may_reflect_prior_turn" : "snapshot",
            hint: "no newer terminal state within the window; the pending submission stays unsettled; the worker may still run; inspect before re-waiting (no auto-resend)",
          };
        }
        return this.transportFailure("wait", res, { pane });
      }
      const agent = agentOf(res.doc) ?? null;
      if (!agent) {
        return this.transportFailure("wait", res, { pane });
      }
      const drift = this.pendingIdentityDrift(rec, agent);
      if (drift) {
        // Identity changed: discard the association; observe the current
        // identity (no error-for-drift).
        this.pending.delete(pane);
        const consoleOut = await this.captureConsole(pane, lines, chars, source, signal);
        if (TERMINAL_STATES.includes(agent.agent_status ?? "")) {
          return {
            ok: agent.agent_status !== "blocked",
            outcome: agent.agent_status === "blocked" ? "needs_attention" : "terminal_observed",
            phase: "wait", pane,
            status: agent.agent_status, seq: agent.state_change_seq,
            ...this.consoleSpread(consoleOut),
            code: "snapshot",
            observation: "snapshot",
            hint: "identity drift discarded stale context; current terminal state snapshot — not proof of task completion",
          };
        }
        return {
          ok: true, outcome: "working", phase: "wait", pane,
          status: agent.agent_status, seq: agent.state_change_seq,
          ...this.consoleSpread(consoleOut),
          code: "working",
          observation: "snapshot",
          hint: "identity drift discarded stale context; agent is currently working",
        };
      }
      lastAgent = agent;
      if (!TERMINAL_STATES.includes(agent.agent_status ?? "")) {
        // A successful terminal-only CLI wait must not match working. Surface
        // the protocol mismatch without settling context or spinning forever.
        return {
          ok: false, outcome: "error", phase: "wait", pane,
          status: agent.agent_status, seq: agent.state_change_seq,
          code: "unexpected_wait_state",
          hint: "terminal-only wait returned a nonterminal state; pending context remains unsettled; inspect the pane",
        };
      }
      if (typeof agent.state_change_seq === "number" && typeof baselineSeq === "number"
        && agent.state_change_seq > baselineSeq) {
        rec.settled = true;
        rec.working_observed = rec.working_observed; // unchanged
        const consoleOut = await this.captureConsole(pane, lines, chars, source, signal);
        const blocked = agent.agent_status === "blocked";
        return {
          ok: !blocked,
          outcome: blocked ? "needs_attention" : "terminal_observed",
          phase: "wait",
          pane,
          status: agent.agent_status,
          seq: agent.state_change_seq,
          delivery: rec.delivery_confirmed ? "acknowledged" : "unknown",
          ...this.consoleSpread(consoleOut),
          code: blocked ? "agent_blocked" : "state_changed_after_submission",
          observation: rec.submitted_while === "working" ? "may_reflect_prior_turn" : "state_changed_after_submission",
          hint: blocked
            ? "agent blocked after a newer terminal transition; inspect"
            : "terminal state observed after a newer transition; observational freshness only, not task acceptance; verify task-specific output",
        };
      }
      // Terminal but not newer than the baseline: the stale-idle trap.
      // Keep waiting for a genuinely newer terminal (until the deadline).
      if (this.now() >= deadline) {
        const consoleOut = await this.captureConsole(pane, lines, chars, source, signal);
        return {
          ok: false, outcome: "timeout", phase: "wait",
          pane,
          status: agent.agent_status,
          seq: agent.state_change_seq,
          ...this.consoleSpread(consoleOut),
          code: "timeout",
          observation: rec.submitted_while === "working" ? "may_reflect_prior_turn" : "snapshot",
          hint: "terminal state observed but not newer than the submission baseline; stale snapshot, not a fresh transition; the pending submission stays unsettled; inspect before re-waiting",
        };
      }
      remainingMs = Math.max(1, deadline - this.now());
    }
  }

  /**
   * Freshness baseline for tier-2 in a pending record. Prefers the
   * ACKNOWLEDGEMENT seq (receipt_seq); falls back to the pre-submit baseline
   * (baseline_seq) when the receipt carried none. If neither exists, a
   * bounded post-submit lookup may supply a separately labelled non-atomic
   * baseline (documented limit).
   *
   * The tier-1 fast path uses rec.baseline_seq and rec.receipt_seq directly
   * and is unaffected by this method.
   */
  private pendingBaseline(rec: PendingContext): number | undefined {
    if (typeof rec.receipt_seq === "number") return rec.receipt_seq;
    return rec.baseline_seq;
  }

  // -------------------------------------------------------------------------
  // send / interrupt
  // -------------------------------------------------------------------------

  async send(args: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
    const pane = typeof args.pane === "string" ? args.pane : "";
    if (!pane) return { ok: false, outcome: "error", phase: "validation", code: "pane_required", hint: "pane (pane id) is required" };
    if (this.isSelf(pane)) {
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
    // pane run = text + Enter in one call (preferred primitive).
    const res = await this.herdr(["pane", "run", pane, text], { signal });
    if (!res.ok) return this.transportFailure("send", res, { pane });

    // Optional bounded observation (defaults to no console; opt-in via returnLines or maxChars).
    const sendArgs = { ...args };
    if (sendArgs.returnLines === undefined && sendArgs.maxChars === undefined) {
      sendArgs.returnLines = 0;
    }
    const { lines, chars } = this.resolveConsoleBounds(sendArgs);
    const out: Result = {
      ok: true, outcome: "sent", phase: "send",
      pane,
      delivery: "not_applicable",
      owned: this.isOwned(pane) !== undefined,
      hint: "raw terminal text + Enter; not an agent prompt (lifecycle-unaware); no delivery confirmation",
    };
    if (lines > 0) {
      const consoleOut = await this.captureConsole(pane, lines, chars, "auto", signal);
      Object.assign(out, consoleOut);
    }
    return out;
  }

  async interrupt(args: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
    const pane = typeof args.pane === "string" ? args.pane : "";
    if (!pane) return { ok: false, outcome: "error", phase: "validation", code: "pane_required", hint: "pane (pane id) is required" };
    if (this.isSelf(pane)) {
      return {
        ok: false, outcome: "denied", phase: "validation", code: "self_control",
        hint: "supervisor cannot interrupt itself",
      };
    }
    // esc aborts the turn; ctrl+d would kill the session — never used here.
    const res = await this.herdr(["pane", "send-keys", pane, "esc"], { signal });
    if (!res.ok) return this.transportFailure("interrupt", res, { pane });
    const after = await this.agentGet(pane, signal);
    const status = after === "error" || after === null ? undefined : after.agent_status;
    const seq = after === "error" || after === null ? undefined : after.state_change_seq;
    return {
      ok: true, outcome: "interrupted", phase: "interrupt",
      pane,
      status,
      seq,
      owned: this.isOwned(pane) !== undefined,
      hint: "escape sent and observed; the turn should abort and the agent survive (no guaranteed-abort claim)",
    };
  }

  // -------------------------------------------------------------------------
  // list / spaces
  // -------------------------------------------------------------------------

  async list(args: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
    // workspace: current (default) | explicit id | all
    const workspaceArg = args.workspace === undefined || args.workspace === null ? "current" : args.workspace;
    if (workspaceArg === "current") {
      const workspaceId = await this.resolveOwnWorkspace(signal);
      if (!workspaceId) {
        return {
          ok: false, outcome: "error", phase: "validation",
          code: "herdr_context_missing",
          hint: "no HERDR_PANE_ID; cannot determine the current workspace",
        };
      }
      return this.listWorkspace(workspaceId, signal);
    }
    if (workspaceArg === "all") {
      return this.listAllWorkspaces(signal);
    }
    if (typeof workspaceArg === "string" && workspaceArg.trim() !== "") {
      return this.listWorkspace(workspaceArg, signal);
    }
    return {
      ok: false, outcome: "error", phase: "validation",
      code: "invalid_workspace",
      hint: "workspace must be 'current', an explicit workspace id, or 'all' (inspection only)",
    };
  }

  private async listWorkspace(workspaceId: string, signal?: AbortSignal): Promise<Result> {
    // Cross-workspace listing only through supported Herdr primitives.
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
        pane_id: p.pane_id ?? null,
        workspace_id: p.workspace_id ?? null,
        terminal_id: p.terminal_id ?? null,
        cwd: p.cwd ?? null,
        name: a?.name ?? null,
        agent: a?.agent ?? null,
        agent_status: a?.agent_status ?? p.agent_status ?? "unknown",
        terminal_title: p.terminal_title ?? null,
        focused: p.focused === true,
        owned: p.pane_id ? this.isOwned(p.pane_id) !== undefined : false,
      };
    });
    return {
      ok: true, outcome: "listed", phase: "list",
      workspace: workspaceId,
      items,
    };
  }

  private async listAllWorkspaces(signal?: AbortSignal): Promise<Result> {
    const spacesRes = await this.herdr(["workspace", "list"], { signal });
    if (!spacesRes.ok) return this.transportFailure("list", spacesRes);
    const workspaces =
      ((spacesRes.doc?.result as Record<string, unknown> | undefined)?.workspaces as Array<{ workspace_id?: string }> | undefined) ?? [];
    const items: unknown[] = [];
    for (const w of workspaces) {
      if (!w.workspace_id) continue;
      const r = await this.listWorkspace(w.workspace_id, signal);
      if (!r.ok) return r;
      for (const item of r.items ?? []) {
        items.push(item);
      }
    }
    return { ok: true, outcome: "listed", phase: "list", workspace: "all", items };
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
      workspace_id: w.workspace_id ?? null,
      label: w.label ?? null,
      pane_count: w.pane_count ?? null,
      tab_count: w.tab_count ?? null,
      agent_status: w.agent_status ?? null,
      focused: w.focused === true,
      active_tab_id: w.active_tab_id ?? null,
    }));
    return { ok: true, outcome: "listed", phase: "spaces", items };
  }

  // -------------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------------

  async close(args: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
    const pane = typeof args.pane === "string" ? args.pane : "";
    if (!pane) return { ok: false, outcome: "error", phase: "validation", code: "pane_required", hint: "pane (pane id) is required" };
    if (this.isSelf(pane)) {
      return {
        ok: false, outcome: "denied", phase: "validation", code: "self_control",
        hint: "supervisor cannot close itself (its own process owns this pane)",
      };
    }
    if (!this.isOwned(pane)) {
      const retired = await this.probeRetiredClose(pane, signal);
      if (retired) return retired;
    }
    // A closed pane no longer has pending context.
    this.pending.delete(pane);

    // Close, then verify ABSENCE with a typed pane_not_found. Only a typed
    // pane_not_found proves absence; transport/server/abort errors do NOT.
    const res = await this.closePane(pane, signal);
    if (!res.ok) {
      // Absence unverified: retain ownership if present.
      return res;
    }
    if (res.code === "pane_not_found") {
      // Idempotent close: the pane was already gone (typed absence).
      this.owned.delete(pane);
      this.retired.set(pane, { pane_id: pane, workspace_id: "", terminal_id: undefined, name: undefined, launched_at: undefined, session: undefined, pending: false });
      return {
        ok: true, outcome: "closed", phase: "close",
        pane, code: "pane_not_found", verifiedAbsent: true,
        hint: "pane already gone (typed pane_not_found); idempotent close treated as success",
      };
    }
    // res.code === "ok": verify the pane is actually absent.
    const verify = await this.herdr(["pane", "get", pane], { signal });
    if (verify.error?.code === "pane_not_found") {
      this.owned.delete(pane);
      this.retired.set(pane, { pane_id: pane, workspace_id: "", terminal_id: undefined, name: undefined, launched_at: undefined, session: undefined, pending: false });
      return {
        ok: true, outcome: "closed", phase: "close",
        pane, code: "ok", verifiedAbsent: true,
        hint: "pane closed and absence verified (typed pane_not_found)",
      };
    }
    if (verify.ok) {
      // Still present: close did not actually remove it. Retain ownership.
      return {
        ok: false, outcome: "error", phase: "verify",
        pane, code: "close_verification_failed",
        hint: "close reported ok but the pane still appears in pane get; ownership retained, re-check before further action",
      };
    }
    // Verify produced a non-typed error (server/transport/abort): absence is
    // UNVERIFIED, not assumed. Retain ownership.
    return {
      ok: false, outcome: "error", phase: "verify",
      pane,
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
        pane: paneId, code: "pane_not_found", verifiedAbsent: true,
        hint: "pane already gone (typed pane_not_found); idempotent close treated as success",
      };
    }
    if (!probe.ok) {
      return this.transportFailure("ownership", probe, { pane: paneId });
    }
    return undefined;
  }

  private async closePane(paneId: string, signal?: AbortSignal): Promise<Result> {
    const res = await this.herdr(["pane", "close", paneId], { signal });
    if (res.ok) {
      return { ok: true, outcome: "closed", phase: "close", pane: paneId, code: "ok" };
    }
    if (res.error?.code === "pane_not_found") {
      // Typed absence: idempotent close, already gone.
      return {
        ok: true, outcome: "closed", phase: "close", pane: paneId,
        code: "pane_not_found", verifiedAbsent: true,
        hint: "pane already gone; idempotent close treated as success",
      };
    }
    // Any other failure (server error, transport, abort) is NOT absence.
    return this.transportFailure("close", res, { pane: paneId });
  }

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  /**
   * Agent get: null when the lookup succeeds but no agent is detected;
   * "error" when the lookup itself failed (any real error).
   */
  private async agentGet(
    target: string,
    signal?: AbortSignal,
  ): Promise<AgentInfo | null | "error"> {
    if (process.env.PI_MULTIWAIT_TRACE) {
      // eslint-disable-next-line no-console
      console.error(`[agentGet ${target}] start`);
    }
    const res = await this.herdr(["agent", "get", target], { signal });
    if (process.env.PI_MULTIWAIT_TRACE) {
      const out = res.ok ? agentOf(res.doc) : res.error;
      // eslint-disable-next-line no-console
      console.error(`[agentGet ${target}] end ok=${res.ok} out=${JSON.stringify(out)}`);
    }
    if (!res.ok) {
      // Typed agent_not_found is a valid "no agent" signal, not a transport error.
      if (res.error?.code === "agent_not_found") return null;
      return "error";
    }
    return agentOf(res.doc) ?? null;
  }

  private aborted(phase: string, paneId?: string, workspaceId?: string, agent?: AgentInfo): Result {
    return {
      ok: false, outcome: "cancelled", phase,
      pane: paneId, workspace: workspaceId,
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
    extra: { pane?: string } = {},
  ): Result {
    const code = res.error?.code ?? res.transportCode ?? (res.signal ? `killed_${res.signal}` : `exit_${res.exitCode}`);
    const message =
      res.error?.message ?? res.transportMessage ?? (res.text.trim() || `herdr exited ${res.exitCode}`);
    return {
      ok: false,
      outcome: "error",
      phase,
      pane: extra.pane,
      code,
      detail: message,
      hint: this.hintFor(code, phase),
    };
  }

  private hintFor(code: string, phase: string): string {
    if (code === "server_not_running") return "herdr server is not running; start herdr or attach to a session";
    if (code === "protocol_mismatch") return "herdr client/server protocol mismatch; restart the herdr server";
    if (code === "agent_not_found" && phase === "preflight") {
      return "target agent not detected; inspect the pane (read with source 'raw') — a dead worker is a distinct failure class, do not retry blindly";
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
