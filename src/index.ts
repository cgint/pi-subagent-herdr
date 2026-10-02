// Pi extension registration for pi-subagent-herdr.
//
// Wires the Herdr lifecycle core (src/core.ts) into the Pi extension runtime:
//  - nine `subagent_*` tools (R-1..R-9) with typed TypeBox schemas,
//    outputSchema/structuredContent and structured isError results
//  - session footer showing the HERDR pane id (R-10) when running in a
//    TUI inside a herdr pane (ctx.ui.setStatus, TUI + HERDR_PANE_ID only)
//  - worker-runtime scripts directory resolution: explicit CLI flag, then
//    PI_SUBAGENT_RUNTIME_DIR, then the active profile's skill scripts dir
//  - ownership persistence across reload/resume of the same session via
//    pi.appendEntry / session entries (new and fork sessions start clean;
//    foreign-session records are filtered out)
//  - UI-backed confirmation for closing external panes (deny without UI);
//    the model's externalConfirmed flag is never accepted directly
//
// The factory performs no subprocesses, timers, or I/O beyond path checks;
// the SubagentService is created lazily on the first session tool call.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
const RUNTIME_SKILL = "sub-agent-herdr-supervisor";

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
  pane_id?: string;
  workspace_id?: string;
  status?: string;
  seq?: number;
  tail?: string;
  code?: string;
  hint?: string;
  detail?: string;
  continuation?: string;
}

interface SubagentServiceLike {
  execute(operation: string, params: Record<string, unknown>, signal: AbortSignal | undefined): Promise<ServiceResultLike>;
  getOwned(): ReadonlyArray<{ pane_id: string; session?: string }>;
  restoreOwned(records: ReadonlyArray<unknown>): void;
}

// ---------------------------------------------------------------------------
// Runtime directory resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the herdr skill scripts directory.
 * Precedence (plan_2): explicit registered CLI flag, then PI_SUBAGENT_RUNTIME_DIR,
 * then the selected profile's skill scripts directory. Never invents a path.
 */
export function resolveRuntimeDir(
  flagValue: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string | undefined {
  const fromFlag = typeof flagValue === "string" && flagValue.trim() !== "" ? flagValue : undefined;
  if (fromFlag) return fromFlag;
  const fromEnv = env[RUNTIME_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv;
  // Profile skill scripts directory: ~/.pi/profiles/<profile>/agent/skills/<skill>/scripts.
  const profilesRoot = path.join(homeDir, ".pi", "profiles");
  let profiles: string[] = [];
  try {
    profiles = fs.readdirSync(profilesRoot);
  } catch {
    return undefined;
  }
  for (const profile of profiles) {
    const candidate = path.join(
      profilesRoot,
      profile,
      "agent",
      "skills",
      RUNTIME_SKILL,
      "scripts",
    );
    if (fs.existsSync(path.join(candidate, "herdr-worker.sh"))) return candidate;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Result mapping (core Result -> tool result)
// ---------------------------------------------------------------------------

function resultSummary(r: Result): string {
  const parts = [`${r.outcome} (phase: ${r.phase})`];
  if (r.pane_id) parts.push(`pane ${r.pane_id}`);
  if (r.status) parts.push(`status ${r.status}`);
  if (r.seq !== undefined) parts.push(`seq ${r.seq}`);
  if (r.hint) parts.push(r.hint);
  if (r.detail) parts.push(r.detail);
  return parts.join("; ");
}

function resultText(r: ServiceResultLike): string {
  const lines = [resultSummary(r)];
  if (r.tail !== undefined && r.tail !== "") {
    lines.push("--- console tail ---");
    lines.push(r.tail);
  }
  if (r.continuation !== undefined) {
    lines.push("--- continuation ---");
    lines.push(String(r.continuation));
    lines.push(
      "pass this opaque ID to subagent_wait.continuation to keep waiting on the same turn",
    );
  }
  return lines.join("\n");
}

interface StructuredResult {
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
  owned: boolean;
  continuation?: string;
}

function toStructured(r: ServiceResultLike, owned: boolean): StructuredResult {
  const s: StructuredResult = { ok: r.ok, outcome: r.outcome, phase: r.phase, owned };
  if (r.pane_id !== undefined) s.pane_id = r.pane_id;
  if (r.workspace_id !== undefined) s.workspace_id = r.workspace_id;
  if (r.status !== undefined) s.status = r.status;
  if (r.seq !== undefined) s.seq = r.seq;
  if (r.tail !== undefined) s.tail = r.tail;
  if (r.code !== undefined) s.code = r.code;
  if (r.hint !== undefined) s.hint = r.hint;
  if (r.detail !== undefined) s.detail = r.detail;
  if (r.continuation !== undefined) s.continuation = r.continuation;
  return s;
}

/** JSON schema shared by every tool result (optional fields stay optional). */
const OUTPUT_SCHEMA = Type.Object({
  ok: Type.Boolean(),
  outcome: Type.String(),
  phase: Type.String(),
  pane_id: Type.Optional(Type.String()),
  workspace_id: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  seq: Type.Optional(Type.Number()),
  tail: Type.Optional(Type.String()),
  code: Type.Optional(Type.String()),
  hint: Type.Optional(Type.String()),
  detail: Type.Optional(Type.String()),
  owned: Type.Boolean(),
  continuation: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 256,
      description: "Opaque continuation ID (server-owned); pass verbatim to resume.",
    }),
  ),
});

// ---------------------------------------------------------------------------
// Tool parameter schemas (finite, bounded inputs)
// ---------------------------------------------------------------------------

const WAIT_MODE = Type.Union(
  [Type.Literal("none"), Type.Literal("bounded"), Type.Literal("finish")],
  {
    description:
      "none: submit and return immediately (receipt only); bounded: wait up to timeoutMs for a terminal state; finish: wait until a terminal state (capped at maxWaitMs, default 30 min).",
  },
);

const START_PARAMS = Type.Object({
  name: Type.String({
    description:
      "Agent name: [a-z0-9][a-z0-9_-]{0,31}. The worker pane is renamed to this after detection.",
  }),
  cwd: Type.Optional(
    Type.String({ description: "Absolute working directory for the worker pane (default: current)." }),
  ),
  mode: Type.Optional(
    Type.Union([Type.Literal("readonly"), Type.Literal("editable")], {
      description: "Worker write mode (default readonly).",
    }),
  ),
  task: Type.String({
    description: "Task brief delivered via `agent prompt` after detection (never at launch).",
  }),
  waitMode: Type.Optional(WAIT_MODE),
  timeoutMs: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 3600000, description: "Wait budget in ms for bounded/finish (default 60 min; max 60 min)." }),
  ),
  tailChars: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 2000, description: "Console tail length in code points (default 50 bounded / 2000 finish)." }),
  ),
});

const PROMPT_PARAMS = Type.Object({
  target: Type.String({ description: "Pane id of the target worker pane." }),
  task: Type.String({ description: "Text submitted as an agent prompt." }),
  waitMode: Type.Optional(WAIT_MODE),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600000, description: "Wait budget in ms (max 60 min)." })),
  tailChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000, description: "Console tail length in code points (default 50)." })),
  allowExternal: Type.Optional(
    Type.Boolean({
      description:
        "Required true when the target is not owned by this session. Acknowledgement only — not user authorisation.",
    }),
  ),
});

const READ_PARAMS = Type.Object({
  target: Type.String({ description: "Pane id of the target pane." }),
  lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Console lines to fetch (default 100, max 500)." })),
  maxChars: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 50000, description: "Tail limit in code points for the returned text (default 2000, max 50000)." }),
  ),
  raw: Type.Optional(
    Type.Boolean({
      description:
        "true: raw terminal read (pane read) when the agent is undetectable; default lifecycle-aware agent read.",
    }),
  ),
});

/**
 * Opaque continuation handle returned by the core. It is a server-owned
 * opaque ID — the caller must not inspect, forge, or derive fields from it.
 * The schema is a plain string; the core's Result type exposes it as `string`.
 */
const CONTINUATION_PARAM = Type.Optional(
  Type.String({
    minLength: 1,
    maxLength: 256,
    description:
      "Opaque continuation ID from an earlier subagent_prompt/subagent_wait result. Pass verbatim to resume the same turn; do not inspect or forge.",
  }),
);

const WAIT_PARAMS = Type.Object({
  target: Type.String({ description: "Pane id of the target pane." }),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600000, description: "Wait budget in ms (default 30 min, max 60 min)." })),
  tailChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000, description: "Console tail length in code points (default 2000)." })),
  continuation: CONTINUATION_PARAM,
  allowExternal: Type.Optional(
    Type.Boolean({ description: "Required true for non-owned targets (acknowledgement only)." }),
  ),
});

const SEND_PARAMS = Type.Object({
  target: Type.String({ description: "Pane id of the target pane." }),
  text: Type.String({
    description:
      "Single line of raw terminal text; Enter is appended. Multi-line text is rejected (unverified in herdr 0.9.3).",
  }),
  allowExternal: Type.Optional(
    Type.Boolean({ description: "Required true for non-owned targets (acknowledgement only)." }),
  ),
});

const INTERRUPT_PARAMS = Type.Object({
  target: Type.String({ description: "Pane id of the target pane." }),
  allowExternal: Type.Optional(
    Type.Boolean({ description: "Required true for non-owned targets (acknowledgement only)." }),
  ),
});

const CLOSE_PARAMS = Type.Object({
  target: Type.String({ description: "Pane id of the pane to close. Non-owned panes require a real UI confirmation; the extension does not accept any model-supplied authorisation flag." }),
});

// ---------------------------------------------------------------------------
// Tool descriptions (model-facing, honest about delivery/completion limits)
// ---------------------------------------------------------------------------

const DESC = {
  start: [
    "Start a new herdr sub-agent worker pane in the current workspace.",
    "Splits a pane, launches the worker runtime (read-only by default), waits for agent detection, renames the agent, then delivers the task via `agent prompt` (never at launch).",
    "waitMode=none returns a submission receipt, not completion. bounded/finish wait for a terminal agent state (idle/done/blocked); blocked is reported as needs_attention, never as success.",
    "Timeouts are bounded (default 30 min, max 60 min); cancellation never interrupts or closes the worker.",
  ].join(" "),
  prompt: [
    "Submit a task to an existing herdr worker pane via `agent prompt`.",
    "Refuses targets that are already working or blocked; submissions to the same target are serialised.",
    "waitMode=none returns a submission receipt only; bounded/finish return a terminal-state observation plus a continuation record for subagent_wait.",
    "A terminal state is not task completion — verify task-specific output.",
  ].join(" "),
  read: [
    "Read recent console content of a herdr pane (lifecycle-aware agent read by default; raw=true falls back to a raw terminal read).",
    "Returns the last `lines` lines, tailed to `maxChars` code points.",
  ].join(" "),
  wait: [
    "Wait for a herdr worker pane to reach a terminal agent state (idle, done, or blocked).",
    "Without a continuation this inspects the current state (a snapshot — it did not observe the turn). With a continuation from a prior prompt/wait it verifies identity and, when working was actually observed, reports terminal_observed_after_working.",
    "Blocked returns needs_attention; timeout returns the current state plus a console tail. Cancellation never touches the worker.",
  ].join(" "),
  send: [
    "Send a single line of raw terminal text plus Enter to another pane.",
    "This is NOT an agent prompt: it has no lifecycle awareness and no delivery confirmation.",
    "Multi-line text is rejected (behaviour unverified in herdr 0.9.3).",
  ].join(" "),
  interrupt: [
    "Abort the current turn of a herdr worker pane by sending Escape (esc).",
    "The agent survives; ctrl+d (session exit) is never used.",
  ].join(" "),
  list: [
    "List all panes of the current herdr workspace with names and agent status.",
    "Marks which panes are owned (launched) by this session.",
  ].join(" "),
  spaces: [
    "List all herdr workspaces (spaces) with label, pane/tab counts and focus state.",
  ].join(" "),
  close: [
    "Close a herdr worker pane (idempotent: an already-gone pane reports success).",
    "Panes owned by this session close directly after live identity verification.",
    "Non-owned panes in the current workspace close only after a real UI confirmation; without UI the request is denied. The externalConfirmed parameter is not accepted as authorisation.",
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
    // Verify top-level sessionId matches before accepting the record set.
    if (sessionId !== undefined && typeof data.sessionId === "string" && data.sessionId !== sessionId) {
      continue; // foreign-session entry; skip
    }
    records = data.records;
  }
  if (!records) return undefined;
  return records.filter((r) => {
    if (!r || typeof r !== "object") return false;
    const rec = r as { session?: unknown };
    // Require matching Pi session identity per-record; filter absent/foreign.
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

  // -- CLI flag registered BEFORE any getFlag call. The SDK's getFlag
  //    checks registration first, so the flag must be registered before
  //    the runtime dir is resolved. We register the flag now and lazily
  //    resolve the runtime dir on first use (inside ensureService) so the
  //    flag value is read after registration.
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
    // If a fake service was injected (tests), use it directly.
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
  const runOp = (
    operation: string,
    opts: { uiConfirmCloseExternal?: boolean } = {},
  ) => {
    return async (
      _toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> => {
      const service = ensureService(ctx);
      const ownedBefore = service.getOwned().length;
      // The model's externalConfirmed flag (if present in raw params despite
      // being absent from the schema) is never accepted as authorisation.
      // Strip it before calling the core so the core's own external-target
      // check denies; the real UI confirmation below re-runs the close with
      // externalConfirmed only after a user click.
      const coreParams: Record<string, unknown> = { ...params };
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

      // External close: the model's externalConfirmed flag is never accepted.
      // When the core denies an unconfirmed external target, ask the real UI;
      // only after an affirmative confirmation execute the close exactly once.
      // The target never received any input before this point, so a single
      // confirmed close attempt is safe. Denied without UI.
      let confirmationNote: string | undefined;
      if (
        opts.uiConfirmCloseExternal &&
        !result.ok &&
        result.outcome === "denied" &&
        result.code === "external_target"
      ) {
        if (ctx.hasUI) {
          const confirmed = await ctx.ui.confirm(
            "Close external herdr pane?",
            `The pane ${result.pane_id ?? "unknown"} was not launched by this session.\n` +
              `Closing it terminates the process inside it. Continue?`,
          );
          if (confirmed) {
            try {
              result = await service.execute(
                operation,
                { ...coreParams, externalConfirmed: true },
                signal,
              );
              confirmationNote = "confirmed via UI; close executed";
            } catch (err) {
              result = {
                ok: false,
                outcome: "error",
                phase: "close",
                code: "internal_error",
                detail: err instanceof Error ? err.message : String(err),
                hint: "confirmed close failed after UI approval; inspect the pane",
              };
              confirmationNote = "confirmed via UI; close failed";
            }
          } else {
            result = {
              ok: false,
              outcome: "denied",
              phase: "confirmation",
              pane_id: result.pane_id,
              code: "user_declined",
              hint: "user declined the UI confirmation; pane untouched",
            };
            confirmationNote = "declined via UI";
          }
        } else {
          result = {
            ok: false,
            outcome: "denied",
            phase: "confirmation",
            pane_id: result.pane_id,
            code: "no_ui_available",
            hint: "closing a non-owned pane requires an interactive UI confirmation; none is available in this mode",
          };
          confirmationNote = "denied: no UI";
        }
      }

      const owned = service.getOwned();
      if (operation === "start" && owned.length > ownedBefore) {
        persistOwned(ctx, service);
      }
      if (operation === "close" && result.outcome === "closed" && owned.length !== ownedBefore) {
        persistOwned(ctx, service);
      }

      const isOwned = owned.some((r) => r.pane_id === result.pane_id);
      const structured = toStructured(result, isOwned) as unknown as AgentToolResult["structuredContent"];
      const text = confirmationNote
        ? `${resultText(result)}\n(close: ${confirmationNote})`
        : resultText(result);
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
      parameters: Type.Object({}),
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
      execute: runOp("close", { uiConfirmCloseExternal: true }),
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
        `pi-subagent-herdr: restored ${owned.length} owned pane(s): ${owned
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
          `pi-subagent-herdr: ${remaining.length} owned pane(s) still open (not closed on shutdown): ${remaining
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
