// Pi extension registration for pi-subagent-herdr (v0.2.0 ergonomic
// contract, docs/tool_usage_review.md).
//
//  - nine `subagent_*` tools with flat, consistent TypeBox schemas:
//    `pane` is the sole caller-facing address; `task` for start, `prompt`
//    for existing-agent prompt; `wait` boolean; `timeoutMs`; `returnLines` /
//    `maxChars`; read `source` auto/agent/raw; list `workspace` current/id/all
//  - no public continuation/cursor/receipt IDs; internal pending context is
//    memory-only bookkeeping in the core
//  - 0.1.x -> 0.2.0 breaking migration: legacy fields (target, prompt task,
//    waitMode, tailChars, read lines/raw, continuation) are rejected by the
//    core before any action, each with a precise replacement hint;
//    `allowExternal` is accepted-but-ignored (deprecated) for this transition
//  - session footer showing the HERDR pane id (R-10) when running in a
//    TUI inside a herdr pane (ctx.ui.setStatus, TUI + HERDR_PANE_ID only)
//  - worker-runtime scripts directory resolution: explicit CLI flag, then
//    PI_SUBAGENT_RUNTIME_DIR, then this package's bundled scripts dir
//  - ownership persistence across reload/resume of the same session via
//    pi.appendEntry / session entries (informational only: ownership is not
//    a control gate in 0.2.0)
//
// The factory performs no subprocesses, timers, or I/O beyond path checks;
// the SubagentService is created lazily on the first session tool call.

import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { SubagentService as RealSubagentService, type Result } from "./core.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Custom-entry type carrying the owned-pane records for one session. */
const OWNED_ENTRY_TYPE = "pi-subagent-herdr-ownership-v1";

/** CLI flag that overrides the worker runtime scripts directory. */
const RUNTIME_FLAG = "subagent-herdr-runtime-dir";

/** Environment variable that overrides the worker runtime scripts directory. */
const RUNTIME_ENV = "PI_SUBAGENT_RUNTIME_DIR";

/** Footer status key for the R-10 pane id display. */
const STATUS_KEY = "pi-subagent-herdr";

/** Skill directory that owns the worker runtime scripts (installed read-only). */

/** 0.2.0 wait/output constants (mirrored in core.ts DEFAULTS). */
const WAIT_MS = 1_800_000;
const MAX_WAIT_MS = 3_600_000;
const MAX_LINES = 500;
const MAX_CHARS = 50_000;

export interface RegistrationDeps {
  /** Override process env (for tests). */
  env?: NodeJS.ProcessEnv;
  /** Fake SubagentService for tests; when set, the real core is not instantiated. */
  service?: SubagentServiceLike;
}

/** Minimal structural interface for the service the factory needs. */
interface ServiceResultLike {
  ok: boolean;
  outcome: string;
  phase: string;
  pane?: string;
  workspace?: string;
  agent?: string;
  status?: string;
  seq?: number;
  delivery?: string;
  console?: string;
  consoleSource?: string;
  truncated?: boolean;
  consoleError?: string;
  submittedWhile?: string;
  working_observed?: boolean;
  observation?: string;
  owned?: boolean;
  code?: string;
  hint?: string;
  detail?: string;
  items?: unknown[];
  verifiedAbsent?: boolean;
}

interface SubagentServiceLike {
  execute(operation: string, params: Record<string, unknown>, signal: AbortSignal | undefined): Promise<ServiceResultLike>;
  getOwned(): ReadonlyArray<{ pane_id: string; session?: string }>;
  restoreOwned(records: ReadonlyArray<unknown>): void;
}

// ---------------------------------------------------------------------------
// Runtime directory resolution
// ---------------------------------------------------------------------------

/** Explicit overrides retain precedence; default assets belong to this package. */
export function resolveRuntimeDir(
  flagValue: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  bundledDir: string = fileURLToPath(new URL("./skills/subagent-herdr-supervision/scripts/", import.meta.url)),
): string {
  if (typeof flagValue === "string" && flagValue.trim() !== "") return flagValue;
  const fromEnv = env[RUNTIME_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv;
  return bundledDir;
}

// ---------------------------------------------------------------------------
// Result mapping (core Result -> tool result)
// ---------------------------------------------------------------------------

function multiWaitSummary(r: ServiceResultLike): string {
  const mw = r as unknown as {
    until?: string;
    winner?: string | null;
    stillPending?: string[];
    results?: Array<Record<string, unknown>>;
  };
  const winnerLine = mw.until === "first" ? ` winner=${mw.winner ?? "none"}` : "";
  const still = (mw.stillPending ?? []).length
    ? ` still_pending=[${(mw.stillPending ?? []).join(", ")}]`
    : "";
  const entries = (mw.results ?? [])
    .map((e) =>
      [String(e.pane ?? "?"), String(e.outcome ?? "?"),
        e.code ? `code=${String(e.code)}` : "",
        e.status ? `status=${String(e.status)}` : "",
        e.seq !== undefined ? `seq=${String(e.seq)}` : "",
        e.observation ? `observation=${String(e.observation)}` : "",
        e.delivery ? `delivery=${String(e.delivery)}` : "",
        e.consoleError ? `console_error=${String(e.consoleError)}` : ""]
        .filter(Boolean)
        .join(" "),
    )
    .join("; ");
  const verdict =
    mw.until === "first"
      ? mw.winner
        ? r.ok
          ? `OK${winnerLine}: ${entries}`
          : `NEEDS ATTENTION${winnerLine}: ${entries}`
        : r.ok
          ? `OK: no winner — ${entries}`
          : `NO WINNER${still}: ${entries}`
      : r.ok
        ? `OK: all panes observed — ${entries}`
        : r.code === "needs_attention" && !still
          ? `NEEDS ATTENTION: all panes observed — ${entries}`
          : `PARTIAL${still}: ${entries}`;
  return [
    `multi_wait (phase: ${r.phase}, until: ${mw.until ?? "?"}${r.code ? `, code: ${r.code}` : ""})${verdict}`,
    r.hint,
    r.detail,
  ].filter(Boolean).join("; ");
}

function resultSummary(r: ServiceResultLike): string {
  if (r.outcome === "multi_wait") return multiWaitSummary(r);
  const parts = [`${r.outcome} (phase: ${r.phase})`];
  if (r.pane) parts.push(`pane ${r.pane}`);
  if (r.status) parts.push(`status ${r.status}`);
  if (r.seq !== undefined) parts.push(`seq ${r.seq}`);
  if (r.delivery) parts.push(`delivery ${r.delivery}`);
  if (r.observation) parts.push(`observation ${r.observation}`);
  if (r.hint) parts.push(r.hint);
  if (r.consoleError) parts.push(`console read failed: ${r.consoleError}`);
  if (r.detail) parts.push(r.detail);
  return parts.join("; ");
}

function resultText(r: ServiceResultLike): string {
  const lines = [resultSummary(r)];
  if (r.outcome === "multi_wait") {
    const multi = r as ServiceResultLike & { results?: Array<Record<string, unknown>> };
    for (const entry of multi.results ?? []) {
      if (typeof entry.console === "string" && entry.console !== "") {
        lines.push(`--- console pane ${String(entry.pane)} (source: ${String(entry.consoleSource ?? "unknown")}) ---`, entry.console);
      }
    }
  }
  if (r.console !== undefined && r.console !== "") {
    lines.push("--- console (source: " + (r.consoleSource ?? "unknown") + (r.truncated ? ", truncated" : "") + ") ---");
    lines.push(r.console);
  }
  return lines.join("\n");
}

type StructuredResult = ServiceResultLike & { owned: boolean };

function toStructured(r: ServiceResultLike, owned: boolean): StructuredResult {
  const s: StructuredResult = { ...r, owned };
  return s;
}

/** JSON schema shared by every tool result (optional fields stay optional). */
const OUTPUT_SCHEMA = Type.Object({
  ok: Type.Boolean(),
  outcome: Type.String(),
  phase: Type.String(),
  pane: Type.Optional(Type.String()),
  workspace: Type.Optional(Type.String()),
  agent: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  seq: Type.Optional(Type.Number()),
  delivery: Type.Optional(Type.String()),
  console: Type.Optional(Type.String()),
  consoleSource: Type.Optional(Type.String()),
  truncated: Type.Optional(Type.Boolean()),
  consoleError: Type.Optional(Type.String()),
  panes: Type.Optional(Type.Array(Type.String())),
  until: Type.Optional(Type.String()),
  winner: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  results: Type.Optional(Type.Array(Type.Object({
    pane: Type.String(),
    outcome: Type.String(),
    status: Type.Optional(Type.String()),
    seq: Type.Optional(Type.Number()),
    code: Type.Optional(Type.String()),
    observation: Type.Optional(Type.String()),
    delivery: Type.Optional(Type.String()),
    console: Type.Optional(Type.String()),
    consoleSource: Type.Optional(Type.String()),
    consoleError: Type.Optional(Type.String()),
    detail: Type.Optional(Type.String()),
    hint: Type.Optional(Type.String()),
  }))),
  stillPending: Type.Optional(Type.Array(Type.String())),
  submittedWhile: Type.Optional(Type.String()),
  working_observed: Type.Optional(Type.Boolean()),
  observation: Type.Optional(Type.String()),
  owned: Type.Boolean(),
  code: Type.Optional(Type.String()),
  hint: Type.Optional(Type.String()),
  detail: Type.Optional(Type.String()),
  items: Type.Optional(Type.Array(Type.Unknown())),
  verifiedAbsent: Type.Optional(Type.Boolean()),
});

// ---------------------------------------------------------------------------
// Tool parameter schemas (0.2.0 flat contract)
// ---------------------------------------------------------------------------

const PANE_PARAM = Type.String({
  description: "Pane id of the target (e.g. w2V:p1). The pane id is the sole caller-facing address.",
});

const PANES_PARAM = Type.Optional(
  Type.Array(Type.String(), {
    minItems: 1,
    description:
      "Pane ids to wait on (multi-pane wait). Nonempty, unique ids. Mutually exclusive with pane; requires until. The pane id is the sole caller-facing address.",
  }),
);

const UNTIL_PARAM = Type.Optional(
  Type.Union(
    [Type.Literal("first"), Type.Literal("all")],
    {
      description:
        'Multi-pane only: "first" returns at the first eligible terminal observation (chronological; input order breaks only truly simultaneous observations); "all" is an observation barrier at the shared deadline. Required together with panes; rejected with pane.',
    },
  ),
);

const WAIT_PARAM = Type.Optional(
  Type.Boolean({
    description:
      `Whether to wait for a terminal agent state (idle/done/blocked) after the action. Default false for start (fan-out), true for prompt and wait.`,
  }),
);

const TIMEOUT_MS_PARAM = Type.Optional(
  Type.Integer({
    minimum: 1,
    maximum: MAX_WAIT_MS,
    description:
      `Wait-phase budget in ms (default ${WAIT_MS} for waited calls, max ${MAX_WAIT_MS}). Bounds the wait phase only — not total call time and not the worker's life. Rejected when wait=false.`,
  }),
);

const RETURN_LINES_PARAM = Type.Optional(
  Type.Integer({
    minimum: 0,
    maximum: MAX_LINES,
    description:
      `Recent console lines to return (default 100, max ${MAX_LINES}; 0 disables console capture).`,
  }),
);

const MAX_CHARS_PARAM = Type.Optional(
  Type.Integer({
    minimum: 0,
    maximum: MAX_CHARS,
    description:
      `Console tail limit in code points applied after line selection (default 8000, max ${MAX_CHARS}).`,
  }),
);

const SOURCE_PARAM = Type.Optional(
  Type.Union(
    [Type.Literal("auto"), Type.Literal("agent"), Type.Literal("raw")],
    {
      description:
        'Console source: "auto" (default; typed agent_not_found falls back to the raw pane console with unknown status, typed agent_not_idle reads the visible viewport), "agent" (strict, errors without fallback), "raw" (explicit pane read only).',
    },
  ),
);

const START_PARAMS = Type.Object({
  name: Type.String({
    description:
      "Agent name: [a-z0-9][a-z0-9_-]{0,31}. The worker pane is renamed to this after detection.",
  }),
  task: Type.String({
    description: "Task brief delivered via `agent prompt` after detection (never at launch).",
  }),
  cwd: Type.Optional(
    Type.String({ description: "Absolute working directory for the worker pane (default: current)." }),
  ),
  mode: Type.Optional(
    Type.Union([Type.Literal("readonly"), Type.Literal("editable")], {
      description: "Worker write mode (default readonly).",
    }),
  ),
  workspace: Type.Optional(
    Type.String({
      description:
        'Launch destination: "current" (default) or the current workspace id. Other destinations are rejected before pane creation; never "all".',
    }),
  ),
  wait: WAIT_PARAM,
  timeoutMs: TIMEOUT_MS_PARAM,
  returnLines: RETURN_LINES_PARAM,
  maxChars: MAX_CHARS_PARAM,
});

const PROMPT_PARAMS = Type.Object({
  pane: PANE_PARAM,
  prompt: Type.String({
    description: "Text submitted as an agent prompt to the existing agent (any agent kind Herdr supports, e.g. pi, claude).",
  }),
  wait: WAIT_PARAM,
  timeoutMs: TIMEOUT_MS_PARAM,
  returnLines: RETURN_LINES_PARAM,
  maxChars: MAX_CHARS_PARAM,
  source: SOURCE_PARAM,
});

const READ_PARAMS = Type.Object({
  pane: PANE_PARAM,
  returnLines: RETURN_LINES_PARAM,
  maxChars: MAX_CHARS_PARAM,
  source: SOURCE_PARAM,
});

const WAIT_PARAMS = Type.Object(
  {
    pane: Type.Optional(PANE_PARAM),
    panes: PANES_PARAM,
    until: UNTIL_PARAM,
    timeoutMs: TIMEOUT_MS_PARAM,
    returnLines: RETURN_LINES_PARAM,
    maxChars: MAX_CHARS_PARAM,
    source: SOURCE_PARAM,
  },
  {
    description:
      "Exactly one addressing form: pane (single-pane wait) or panes + until (multi-pane wait). Both or neither is rejected before any action.",
  },
);

const SEND_PARAMS = Type.Object({
  pane: PANE_PARAM,
  text: Type.String({
    description:
      "Single line of raw terminal text; Enter is appended. Multi-line text is rejected (unverified in herdr 0.9.3).",
  }),
  returnLines: RETURN_LINES_PARAM,
  maxChars: MAX_CHARS_PARAM,
});

const INTERRUPT_PARAMS = Type.Object({
  pane: PANE_PARAM,
});

const CLOSE_PARAMS = Type.Object({
  pane: Type.String({
    description:
      "Pane id of the pane to close. Close terminates the process inside it; absence is verified before reporting success.",
  }),
});

const LIST_PARAMS = Type.Object({
  workspace: Type.Optional(
    Type.String({
      description:
        'Workspace to list: "current" (default), an explicit workspace id, or "all" (all workspaces; inspection only).',
      default: "current",
    }),
  ),
});

// ---------------------------------------------------------------------------
// Tool descriptions (model-facing, honest about delivery/completion limits)
// ---------------------------------------------------------------------------

const DESC = {
  start: [
    "Start a new herdr sub-agent worker pane in the current workspace. An explicit different workspace is rejected before pane creation.",
    "Splits a pane, launches the worker runtime (readonly by default; use mode=editable for controllers), waits for managed-Pi agent detection (separate 15 s budget), renames the agent, then delivers the task via `agent prompt` (never at launch).",
    "wait=false (default) returns after readiness + submission (ready+submitted; fan-out friendly). wait=true combines launch -> submit -> wait -> console; the timeoutMs budget bounds the wait phase only (default 1,800,000 ms, max 3,600,000 ms), not total call time or the worker's life.",
    "A terminal state is not task completion — verify task-specific output. Cancellation never interrupts or closes the worker. The result pane field is the caller address for all other tools.",
  ].join(" "),
  prompt: [
    "Submit text to an existing agent in a herdr pane via `agent prompt` (agent-neutral: works for any agent kind Herdr supports, e.g. pi or claude).",
    "wait=true (default) submits, waits for a terminal state (idle/done/blocked; blocked = needs_attention, never success), and returns status + bounded console. wait=false submits only (receipt).",
    "If the agent is already working the submission is allowed as Herdr allows it: the result carries submittedWhile=working and observation may_reflect_prior_turn, and the matching state may be the pre-existing turn, not the new prompt. Blocked = actual CLI agent_blocked -> delivery not_sent.",
    "timeoutMs bounds the wait phase only (default 1,800,000 ms, max 3,600,000 ms); on timeout the worker may still run — inspect, never auto-resend.",
  ].join(" "),
  read: [
    "Read recent console content of a herdr pane (lifecycle-aware agent read by default).",
    'source: "auto" (default; typed agent_not_found or a successful lookup with no agent falls back to the raw pane console with unknown status; typed agent_not_idle reads the visible viewport only), "agent" (strict; errors without fallback), "raw" (explicit pane read).',
    "returnLines selects recent lines (default 100, max 500; 0 disables capture); maxChars tails the text to a code-point budget (default 8000, max 50000). A console read failure never erases a preceding action's result.",
  ].join(" "),
  wait: [
    "Wait for a herdr agent pane to reach a terminal state (idle, done, or blocked) without resending anything; then return status + bounded console.",
    "Addressing: exactly one of pane (single-pane) or panes + until (multi-pane). pane rejects until; panes (nonempty, unique ids) requires until \"first\" or \"all\"; both or neither is rejected before any action.",
    "Multi-pane first returns at the first eligible terminal observation by this call (chronological; input order breaks only truly simultaneous observations) and reports the observed losers as a bounded summary; multi-pane all is an observation barrier at the shared deadline with per-pane observations and explicit stillPending. Blocked (needs_attention) is never reported as success.",
    "When this session has an unsettled pending submission for the pane (internal, memory-only), the wait applies freshness tiers: terminal_seen_during_submission (fast, settles once) or state_changed_after_submission. Without such context an already-terminal pane returns a labelled snapshot — this wait did not observe the turn. Identity drift discards the stale association without attribution.",
    "timeoutMs is one shared deadline from call start (default 1,800,000 ms, max 3,600,000 ms). Timeout leaves any pending context unsettled and the worker may still run — inspect before re-waiting; no auto-resend. Cancellation never touches the worker.",
  ].join(" "),
  send: [
    "Send a single line of raw terminal text plus Enter to a herdr pane.",
    "This is NOT an agent prompt: no lifecycle awareness, no delivery confirmation (delivery not_applicable). No console by default; pass returnLines>0 to observe the pane afterwards.",
    "Multi-line text is rejected (behaviour unverified in herdr 0.9.3).",
  ].join(" "),
  interrupt: [
    "Abort the current turn of a herdr agent pane by sending Escape (esc).",
    "Returns the send receipt plus the observed status; no guaranteed-abort claim (the turn should abort and the agent survive). ctrl+d (session exit) is never used.",
  ].join(" "),
  list: [
    "List panes of a herdr workspace as a compact structured collection (pane id, workspace, cwd, name, agent, status, focus; ownership is informational).",
    'workspace: "current" (default), an explicit workspace id, or "all" (all workspaces; inspection only).',
  ].join(" "),
  spaces: [
    "List all herdr workspaces (spaces) as a compact structured collection (id, label, pane/tab counts, focus).",
    "This is a workspace inventory, distinct from listing panes across all spaces (list with workspace=all).",
  ].join(" "),
  close: [
    "Close a herdr pane (idempotent: an already-gone pane reports verified absence).",
    "The pane is closed and absence is independently verified with a typed pane_not_found before success is reported; non-verified failures retain ownership (when tracked) and are reported as errors. No console tail is returned.",
  ].join(" "),
};

// ---------------------------------------------------------------------------
// Ownership persistence (appendEntry / session entries)
// ---------------------------------------------------------------------------

interface OwnedState {
  service: SubagentServiceLike;
  sessionId: string | undefined;
}

function sessionIdFromCtx(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId();
  } catch {
    return undefined;
  }
}

/**
 * Owned-pane records for this session, reconstructed from the session branch.
 * Returns undefined when no ownership entry exists (fresh session).
 * Foreign-session records are filtered out: two Pi sessions in the same
 * HERDR pane are distinct and must not inherit each other's control.
 */
function readOwnedFromEntries(ctx: ExtensionContext, sessionId: string | undefined): unknown[] | undefined {
  let records: unknown[] | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== OWNED_ENTRY_TYPE) continue;
    const data = entry.data as { sessionId?: unknown; records?: unknown } | undefined;
    if (!data || !Array.isArray(data.records)) continue;
    if (sessionId !== undefined && typeof data.sessionId === "string" && data.sessionId !== sessionId) {
      continue; // foreign-session entry; skip
    }
    records = data.records;
  }
  if (!records) return undefined;
  return records.filter((r) => {
    if (!r || typeof r !== "object") return false;
    const rec = r as { session?: unknown };
    if (typeof rec.session !== "string") return false;
    if (sessionId !== undefined && rec.session !== sessionId) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export default function registerSubagentHerdr(pi: ExtensionAPI, deps: RegistrationDeps = {}): void {
  const env = deps.env ?? process.env;
  let ownedState: OwnedState | null = null;

  // -- CLI flag registered BEFORE any getFlag call.
  try {
    pi.registerFlag(RUNTIME_FLAG, {
      description:
        "Directory containing the herdr worker runtime scripts (herdr-worker.sh). Overrides PI_SUBAGENT_RUNTIME_DIR.",
      type: "string",
    });
  } catch {
    // Flag registration is advisory; env and profile discovery still work.
  }

  let runtimeDir: string | undefined;
  const getRuntimeDir = (): string | undefined => {
    if (!runtimeDir) {
      let flagValue: string | undefined;
      try {
        flagValue = pi.getFlag(RUNTIME_FLAG) as string | undefined;
      } catch {
        flagValue = undefined;
      }
      runtimeDir = resolveRuntimeDir(flagValue, env);
    }
    return runtimeDir;
  };

  const envPaneId = (): string | undefined =>
    typeof env.HERDR_PANE_ID === "string" && env.HERDR_PANE_ID.trim() !== ""
      ? env.HERDR_PANE_ID
      : undefined;

  // -- R-10 footer: TUI + HERDR_PANE_ID only, set from the extension context.
  const applyFooter = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") return;
    const paneId = envPaneId();
    if (paneId) {
      ctx.ui.setStatus(STATUS_KEY, `herdr pane ${paneId}`);
    } else {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  };

  const ensureService = (ctx: ExtensionContext): SubagentServiceLike => {
    const sid = sessionIdFromCtx(ctx);
    if (ownedState && ownedState.sessionId === sid) {
      return ownedState.service;
    }
    if (deps.service) {
      const restored = readOwnedFromEntries(ctx, sid);
      if (restored && restored.length > 0) {
        deps.service.restoreOwned(restored);
      }
      ownedState = { service: deps.service, sessionId: sid };
      return deps.service;
    }
    const paneId = envPaneId();
    const service: SubagentServiceLike = new RealSubagentService({
      paneId,
      runtimeDir: getRuntimeDir(),
      scriptsDir: getRuntimeDir(),
    });
    const restored = readOwnedFromEntries(ctx, sid);
    if (restored && restored.length > 0) {
      service.restoreOwned(restored);
    }
    ownedState = { service, sessionId: sid };
    return service;
  };

  const persistOwned = (ctx: ExtensionContext, service: SubagentServiceLike): void => {
    const sid = sessionIdFromCtx(ctx);
    const records = service.getOwned().map((r: { pane_id: string; session?: string }) => ({
      ...r,
      session: sid, // Always store the Pi session ID, not the core's pane-id session.
    }));
    pi.appendEntry<Record<string, unknown>>(OWNED_ENTRY_TYPE, {
      sessionId: sid,
      records,
    });
  };

  // -- Tool execution wrapper: map core Result onto tool result contracts. --
  const runOp = (operation: string) => {
    return async (
      _toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> => {
      const service = ensureService(ctx);
      const ownedBefore = service.getOwned().length;
      // Deprecated 0.1.x acknowledgement flags are accepted-but-ignored for
      // this transition; the 0.2.0 core has no ownership/external gates.
      // They are stripped so a stale schema caller cannot influence behaviour.
      const coreParams: Record<string, unknown> = { ...params };
      delete coreParams.allowExternal;
      delete coreParams.externalConfirmed;
      let result: ServiceResultLike;
      try {
        result = await service.execute(operation, coreParams, signal);
      } catch (err) {
        result = {
          ok: false,
          outcome: "error",
          phase: "dispatch",
          code: "internal_error",
          detail: err instanceof Error ? err.message : String(err),
          hint: "unexpected error in the subagent core; inspect the pane",
        };
      }

      const owned = service.getOwned();
      if (operation === "start" && owned.length > ownedBefore) {
        persistOwned(ctx, service);
      }
      if (operation === "close" && result.outcome === "closed" && owned.length !== ownedBefore) {
        persistOwned(ctx, service);
      }

      const isOwned = result.pane !== undefined && owned.some((r) => r.pane_id === result.pane);
      const structured = toStructured(result, isOwned) as unknown as AgentToolResult["structuredContent"];
      const text = resultText(result);
      return {
        content: [{ type: "text" as const, text }],
        details: structured,
        structuredContent: structured,
        isError: !result.ok,
      };
    };
  };

  // -- Register the nine tools (R-1..R-9). --
  const tools: ToolDefinition[] = [
    {
      name: "subagent_start",
      label: "Subagent start",
      description: DESC.start,
      parameters: START_PARAMS,
      outputSchema: OUTPUT_SCHEMA,
      annotations: { openWorldHint: true },
      execute: runOp("start"),
    },
    {
      name: "subagent_prompt",
      label: "Subagent prompt",
      description: DESC.prompt,
      parameters: PROMPT_PARAMS,
      outputSchema: OUTPUT_SCHEMA,
      execute: runOp("prompt"),
    },
    {
      name: "subagent_read",
      label: "Subagent read",
      description: DESC.read,
      parameters: READ_PARAMS,
      outputSchema: OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true },
      execute: runOp("read"),
    },
    {
      name: "subagent_wait",
      label: "Subagent wait",
      description: DESC.wait,
      parameters: WAIT_PARAMS,
      outputSchema: OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true },
      execute: runOp("wait"),
    },
    {
      name: "subagent_send",
      label: "Subagent send",
      description: DESC.send,
      parameters: SEND_PARAMS,
      outputSchema: OUTPUT_SCHEMA,
      execute: runOp("send"),
    },
    {
      name: "subagent_interrupt",
      label: "Subagent interrupt",
      description: DESC.interrupt,
      parameters: INTERRUPT_PARAMS,
      outputSchema: OUTPUT_SCHEMA,
      execute: runOp("interrupt"),
    },
    {
      name: "subagent_list",
      label: "Subagent list",
      description: DESC.list,
      parameters: LIST_PARAMS,
      outputSchema: OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true },
      execute: runOp("list"),
    },
    {
      name: "subagent_spaces",
      label: "Subagent spaces",
      description: DESC.spaces,
      parameters: Type.Object({}),
      outputSchema: OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true },
      execute: runOp("spaces"),
    },
    {
      name: "subagent_close",
      label: "Subagent close",
      description: DESC.close,
      parameters: CLOSE_PARAMS,
      outputSchema: OUTPUT_SCHEMA,
      annotations: { destructiveHint: true, idempotentHint: true },
      execute: runOp("close"),
    },
  ];
  for (const tool of tools) {
    pi.registerTool(tool);
  }

  // -- Session lifecycle: restore ownership, set the footer, report shutdown.
  pi.on("session_start", (_event, ctx) => {
    applyFooter(ctx);
    const service = ensureService(ctx);
    const owned = service.getOwned();
    if (owned.length > 0) {
      ctx.ui.notify(
        `pi-subagent-herdr: restored ${owned.length} tracked pane(s): ${owned
          .map((r) => r.pane_id)
          .join(", ")}`,
        "info",
      );
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    applyFooter(ctx);
    if (ownedState) {
      const remaining = ownedState.service.getOwned();
      if (remaining.length > 0) {
        ctx.ui.notify(
          `pi-subagent-herdr: ${remaining.length} tracked pane(s) still open (not closed on shutdown): ${remaining
            .map((r) => r.pane_id)
            .join(", ")}`,
          "warning",
        );
      }
    }
    ownedState = null;
  });
}

export type { Result, SubagentService } from "./core.js";
