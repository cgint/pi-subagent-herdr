// Node:test suite for index.ts (Pi registration layer, 0.2.0 contract).
//
// Covers: registration count/names/schemas (flat 0.2.0 parameter surface),
// legacy-field absence from schemas, honest descriptions, annotations,
// runtime-dir flag, session lifecycle handlers, and result mapping via
// the captured execute() callbacks against a fake SubagentService
// injected through RegistrationDeps.service (no process hooks).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import registerSubagentHerdr, { resolveRuntimeDir, type RegistrationDeps } from "../index.js";
import { DEFAULTS } from "../core.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Captured tool / fake pi helpers
// ---------------------------------------------------------------------------

interface CapturedTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  outputSchema: unknown;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionContext,
  ) => Promise<unknown>;
}

interface FakePiOptions {
  flag?: string | undefined;
  entries?: Array<{ type: "custom"; customType: string; data?: unknown }>;
  mode?: string;
  hasUI?: boolean;
  paneId?: string;
  env?: NodeJS.ProcessEnv;
}

interface FakePi {
  pi: ExtensionAPI;
  tools: CapturedTool[];
  flags: Map<string, { description?: string; type: string }>;
  handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>;
  appended: Array<{ customType: string; data: unknown }>;
  ctx: ExtensionContext;
  statusCalls: Array<{ key: string; text: string | undefined }>;
  notifyCalls: Array<{ message: string; type?: string }>;
}

function makeFakePi(options: FakePiOptions = {}): FakePi {
  const tools: CapturedTool[] = [];
  const flags = new Map<string, { description?: string; type: string }>();
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const appended: Array<{ customType: string; data: unknown }> = [];
  let entries: Array<{ type: "custom"; customType: string; data?: unknown }> = options.entries ?? [];
  const statusCalls: Array<{ key: string; text: string | undefined }> = [];
  const notifyCalls: Array<{ message: string; type?: string }> = [];
  const sessionId = "sess-1";
  const mode = options.mode ?? "tui";

  const ctx: ExtensionContext = {
    ui: {
      setStatus(key: string, text: string | undefined) {
        statusCalls.push({ key, text });
      },
      notify(message: string, type?: "info" | "warning" | "error") {
        notifyCalls.push({ message, type });
      },
    } as unknown as ExtensionContext["ui"],
    mode: mode as ExtensionContext["mode"],
    hasUI: options.hasUI ?? true,
    cwd: "/tmp",
    signal: undefined,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => entries as unknown as ReturnType<ExtensionContext["sessionManager"]["getBranch"]>,
      getEntries: () => entries as unknown as ReturnType<ExtensionContext["sessionManager"]["getEntries"]>,
    } as unknown as ExtensionContext["sessionManager"],
  } as unknown as ExtensionContext;

  const pi = {
    registerTool(tool: unknown) {
      tools.push(tool as CapturedTool);
    },
    registerFlag(name: string, opts: { description?: string; type: string }) {
      flags.set(name, opts);
    },
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    appendEntry<T>(_customType: string, data?: T) {
      const entry = { customType: _customType, data } as { customType: string; data: unknown };
      appended.push(entry);
      entries.push({ type: "custom", customType: _customType, data } as unknown as (typeof entries)[number]);
      return entry;
    },
    getFlag(name: string): string | boolean | undefined {
      if (name === "subagent-herdr-runtime-dir") return options.flag;
      return undefined;
    },
  } as unknown as ExtensionAPI;

  return { pi, tools, flags, handlers, appended, ctx, statusCalls, notifyCalls };
}

// ---------------------------------------------------------------------------
// Fake SubagentService (injected via RegistrationDeps.service)
// ---------------------------------------------------------------------------

interface FakeResult {
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
  observation?: string;
  code?: string;
  hint?: string;
  detail?: string;
  items?: unknown[];
  verifiedAbsent?: boolean;
}

interface FakeServiceOptions {
  executeImpl?: (
    op: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<FakeResult>;
}

interface FakeService {
  execute(op: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<FakeResult>;
  getOwned(): Array<{ pane_id: string; session?: string }>;
  restoreOwned(records: ReadonlyArray<unknown>): void;
  _lastArgs?: Record<string, unknown>;
}

function makeFakeService(impl?: FakeServiceOptions["executeImpl"]): FakeService {
  const owned = new Map<string, Record<string, unknown>>();
  return {
    async execute(op: string, args: Record<string, unknown> = {}, signal?: AbortSignal) {
      if (impl) return impl(op, args, signal);
      return {
        ok: true,
        outcome: "submitted",
        phase: "submission",
        pane: `wF:p${op}`,
        hint: "ok",
      };
    },
    getOwned() {
      return [...owned.values()].map((r) => ({ ...r })) as Array<{ pane_id: string; session?: string }>;
    },
    restoreOwned(records: ReadonlyArray<unknown>) {
      owned.clear();
      for (const r of records) {
        if (r && typeof r === "object") {
          const rec = r as { pane_id?: unknown; workspace_id?: unknown; session?: unknown };
          if (typeof rec.pane_id === "string" && typeof rec.workspace_id === "string") {
            owned.set(rec.pane_id, {
              pane_id: rec.pane_id,
              workspace_id: rec.workspace_id,
              ...(typeof rec.session === "string" ? { session: rec.session } : {}),
            });
          }
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Registration: count, names, schemas
// ---------------------------------------------------------------------------

test("registers exactly nine subagent_* tools with the agreed names", async () => {
  const fake = makeFakePi();
  const svc = makeFakeService();
  registerSubagentHerdr(fake.pi, { service: svc as RegistrationDeps["service"], env: { HERDR_PANE_ID: "wF:p1" } });
  const names = fake.tools.map((t) => t.name);
  assert.deepEqual(names, [
    "subagent_start",
    "subagent_prompt",
    "subagent_read",
    "subagent_wait",
    "subagent_send",
    "subagent_interrupt",
    "subagent_list",
    "subagent_spaces",
    "subagent_close",
  ]);
  for (const t of fake.tools) {
    assert.ok(t.name.startsWith("subagent_"));
    assert.ok(t.label.length > 0, `${t.name} label`);
    assert.ok(t.description.length > 40, `${t.name} description is substantive`);
    assert.ok(t.parameters && typeof t.parameters === "object", `${t.name} parameters schema`);
    assert.ok(t.outputSchema && typeof t.outputSchema === "object", `${t.name} outputSchema`);
  }
});

test("parameter schemas match the 0.2.0 flat contract", async () => {
  const fake = makeFakePi();
  registerSubagentHerdr(fake.pi, { service: makeFakeService() as RegistrationDeps["service"], env: { HERDR_PANE_ID: "wF:p1" } });
  const byName = new Map(fake.tools.map((t) => [t.name, t]));
  const props = (t: CapturedTool) => Object.keys((t.parameters as { properties?: Record<string, unknown> }).properties ?? {});
  const required = (t: CapturedTool) => ((t.parameters as { required?: string[] }).required ?? []).sort();

  // start: name/task required; cwd optional; no terminalId, continuation or allowExternal
  assert.deepEqual(props(byName.get("subagent_start")!).sort(), [
    "cwd", "maxChars", "mode", "name", "returnLines", "task", "timeoutMs", "wait", "workspace",
  ]);
  assert.deepEqual(required(byName.get("subagent_start")!), ["name", "task"]);
  assert.equal((byName.get("subagent_start")!.parameters as { properties: Record<string, unknown> }).properties.terminalId, undefined);
  assert.equal((byName.get("subagent_start")!.parameters as { properties: Record<string, unknown> }).properties.continuation, undefined);

  // prompt: pane+prompt required; legacy task/target/waitMode/continuation absent
  assert.deepEqual(props(byName.get("subagent_prompt")!).sort(), [
    "maxChars", "pane", "prompt", "returnLines", "source", "timeoutMs", "wait",
  ]);
  assert.deepEqual(required(byName.get("subagent_prompt")!), ["pane", "prompt"]);
  assert.equal((byName.get("subagent_prompt")!.parameters as { properties: Record<string, unknown> }).properties.task, undefined);
  assert.equal((byName.get("subagent_prompt")!.parameters as { properties: Record<string, unknown> }).properties.target, undefined);
  assert.equal((byName.get("subagent_prompt")!.parameters as { properties: Record<string, unknown> }).properties.waitMode, undefined);
  assert.equal((byName.get("subagent_prompt")!.parameters as { properties: Record<string, unknown> }).properties.continuation, undefined);

  // wait: single-pane pane OR multi-pane panes+until; exactly-one is
  // enforced by the core, so the registered schema keeps all three optional.
  // No boundedWaitMs, no waitMode, no continuation.
  assert.deepEqual(props(byName.get("subagent_wait")!).sort(), ["maxChars", "pane", "panes", "returnLines", "source", "timeoutMs", "until"]);
  assert.deepEqual(required(byName.get("subagent_wait")!), [], "no required property: exactly-one pane/panes is a core validation rule (rejects before any action)");
  const waitProps = (byName.get("subagent_wait")!.parameters as { properties: Record<string, unknown> }).properties;
  assert.equal(waitProps.boundedWaitMs, undefined);
  assert.equal(waitProps.continuation, undefined);
  // panes: nonempty array of pane ids; until: literal union first|all
  const panesSchema = waitProps.panes as { type?: string; items?: { type?: string }; minItems?: number };
  assert.equal(panesSchema.type, "array", "panes is an array of pane ids");
  assert.equal(panesSchema.items?.type, "string", "panes items are strings");
  assert.equal(panesSchema.minItems, 1, "panes must be nonempty");
  const untilSchema = waitProps.until as { anyOf?: Array<{ const?: string }> };
  const untilValues = (untilSchema.anyOf ?? []).map((s) => s.const).filter(Boolean) as string[];
  assert.deepEqual(untilValues, ["first", "all"], "until is exactly the multi-pane modes");

  // read: returnLines/maxChars/source; no lines/raw/tailChars
  assert.deepEqual(props(byName.get("subagent_read")!).sort(), ["maxChars", "pane", "returnLines", "source"]);
  assert.deepEqual(required(byName.get("subagent_read")!), ["pane"]);
  const readProps = (byName.get("subagent_read")!.parameters as { properties: Record<string, unknown> }).properties;
  assert.equal(readProps.lines, undefined);
  assert.equal(readProps.raw, undefined);
  assert.equal(readProps.tailChars, undefined);
  // source: auto/agent/raw (TypeBox Union of Literals -> anyOf with const)
  const sourceSchema = readProps.source as { anyOf?: Array<{ const?: string }> };
  const sourceValues = (sourceSchema.anyOf ?? []).map((s) => s.const).filter(Boolean) as string[];
  assert.deepEqual(sourceValues.sort(), ["agent", "auto", "raw"]);

  // send: pane+text required; no lines
  assert.deepEqual(props(byName.get("subagent_send")!).sort(), ["maxChars", "pane", "returnLines", "text"]);
  assert.deepEqual(required(byName.get("subagent_send")!), ["pane", "text"]);

  // close: pane only; no allowExternal/externalConfirmed
  assert.deepEqual(props(byName.get("subagent_close")!), ["pane"]);
  assert.deepEqual(required(byName.get("subagent_close")!), ["pane"]);

  // interrupt: pane only
  assert.deepEqual(props(byName.get("subagent_interrupt")!), ["pane"]);

  // list: optional workspace
  assert.deepEqual(props(byName.get("subagent_list")!), ["workspace"]);
  const listWs = (byName.get("subagent_list")!.parameters as { properties: Record<string, { default?: string }> }).properties.workspace;
  assert.equal(listWs.default, "current");

  // spaces: no parameters
  assert.deepEqual(props(byName.get("subagent_spaces")!), []);
});

test("output schemas include working observation but no public correlation handles", () => {
  const fake = makeFakePi();
  registerSubagentHerdr(fake.pi, { service: makeFakeService() as RegistrationDeps["service"], env: { HERDR_PANE_ID: "wF:p1" } });
  for (const tool of fake.tools) {
    const props = (tool.outputSchema as { properties: Record<string, { type?: string }> }).properties;
    assert.equal(props.working_observed.type, "boolean");
    assert.equal(props.continuation, undefined);
    assert.equal(props.cursor, undefined);
    assert.equal(props.receiptId, undefined);
  }
});

test("annotations: read/list/wait/spaces read-only; close destructive+idempotent; start open-world", async () => {
  const fake = makeFakePi();
  registerSubagentHerdr(fake.pi, { service: makeFakeService() as RegistrationDeps["service"], env: { HERDR_PANE_ID: "wF:p1" } });
  const byName = new Map(fake.tools.map((t) => [t.name, t]));
  assert.equal(byName.get("subagent_read")!.annotations?.readOnlyHint, true);
  assert.equal(byName.get("subagent_wait")!.annotations?.readOnlyHint, true);
  assert.equal(byName.get("subagent_list")!.annotations?.readOnlyHint, true);
  assert.equal(byName.get("subagent_spaces")!.annotations?.readOnlyHint, true);
  assert.equal(byName.get("subagent_close")!.annotations?.destructiveHint, true);
  assert.equal(byName.get("subagent_close")!.annotations?.idempotentHint, true);
  assert.equal(byName.get("subagent_start")!.annotations?.openWorldHint, true);
});

test("registers the runtime-dir CLI flag (string type)", async () => {
  const fake = makeFakePi();
  registerSubagentHerdr(fake.pi, { service: makeFakeService() as RegistrationDeps["service"], env: { HERDR_PANE_ID: "wF:p1" } });
  assert.ok(fake.flags.has("subagent-herdr-runtime-dir"));
  assert.equal(fake.flags.get("subagent-herdr-runtime-dir")!.type, "string");
});

test("session_start and session_shutdown handlers are registered", async () => {
  const fake = makeFakePi();
  registerSubagentHerdr(fake.pi, { service: makeFakeService() as RegistrationDeps["service"], env: { HERDR_PANE_ID: "wF:p1" } });
  assert.ok(fake.handlers.has("session_start"));
  assert.ok(fake.handlers.has("session_shutdown"));
});

// ---------------------------------------------------------------------------
// Tool descriptions carry the honest 0.2.0 semantics
// ---------------------------------------------------------------------------

test("descriptions: pane is the sole address; submit-only; no continuation", async () => {
  const fake = makeFakePi();
  registerSubagentHerdr(fake.pi, { service: makeFakeService() as RegistrationDeps["service"], env: { HERDR_PANE_ID: "wF:p1" } });
  const byName = new Map(fake.tools.map((t) => [t.name, t]));
  assert.match(byName.get("subagent_start")!.description, /pane/);
  assert.match(byName.get("subagent_start")!.description, /submit-only|wait=false/i);
  assert.match(byName.get("subagent_prompt")!.description, /pane/);
  assert.match(byName.get("subagent_wait")!.description, /snapshot/);
  assert.match(byName.get("subagent_wait")!.description, /state_changed_after_submission/);
  assert.match(byName.get("subagent_read")!.description, /auto/);
  assert.match(byName.get("subagent_read")!.description, /visible viewport/);
  assert.match(byName.get("subagent_close")!.description, /verified absence/i);
  assert.match(byName.get("subagent_close")!.description, /idempotent/i);
  assert.match(byName.get("subagent_send")!.description, /single line/i);
  assert.match(byName.get("subagent_send")!.description, /unverified in herdr 0\.9\.3/);
  assert.match(byName.get("subagent_interrupt")!.description, /no guaranteed-abort claim/);
  assert.match(byName.get("subagent_prompt")!.description, /blocked/);
  assert.match(byName.get("subagent_prompt")!.description, /working|busy/i);
});

test("wait description documents the multi-pane contract (panes + until, first/all, needs-attention)", async () => {
  const fake = makeFakePi();
  registerSubagentHerdr(fake.pi, { service: makeFakeService() as RegistrationDeps["service"], env: { HERDR_PANE_ID: "wF:p1" } });
  const byName = new Map(fake.tools.map((t) => [t.name, t]));
  const d = byName.get("subagent_wait")!.description;
  assert.match(d, /panes/, "multi-pane addressing is visible to the model");
  assert.match(d, /until/);
  assert.match(d, /"first"|first/);
  assert.match(d, /"all"|all/);
  assert.match(d, /exactly one/i);
  assert.match(d, /never reported as success|not.*success|needs_attention/i);
});

// ---------------------------------------------------------------------------
// Registration-level multi-wait wiring (guards against core-only suites:
// the registered schema must reach the multi-pane core, not just the tests)
// ---------------------------------------------------------------------------

async function runWait(params: Record<string, unknown>, fake: FakePi): Promise<{
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
  structuredContent: Record<string, unknown>;
  isError: boolean;
}> {
  const byName = new Map(fake.tools.map((t) => [t.name, t]));
  return (await byName.get("subagent_wait")!.execute("call-1", params, undefined, undefined, fake.ctx)) as {
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
    structuredContent: Record<string, unknown>;
    isError: boolean;
  };
}

test("registration: multi-pane wait params reach the core (panes + until pass the schema and dispatch)", async () => {
  let captured: Record<string, unknown> | undefined;
  const svc = makeFakeService(async (op, args) => {
    if (op === "wait") captured = args;
    return {
      ok: true, outcome: "multi_wait", phase: "wait", until: "first",
      panes: ["wF:p9", "wF:p10"], winner: "wF:p9",
      results: [{ pane: "wF:p9", outcome: "terminal_observed", status: "done", code: "snapshot", observation: "snapshot" }],
      stillPending: [],
      hint: "ok",
    };
  });
  const fake = makeFakePi();
  registerSubagentHerdr(fake.pi, { service: svc as RegistrationDeps["service"], env: { HERDR_PANE_ID: "wF:p1" } });
  const r = await runWait({ panes: ["wF:p9", "wF:p10"], until: "first", timeoutMs: 1000 }, fake);
  assert.equal(r.isError, false, "multi-pane call is not treated as an error");
  assert.ok(captured, "the wait dispatch reached the core");
  assert.deepEqual(captured!.panes, ["wF:p9", "wF:p10"], "panes reach the core unmodified");
  assert.equal(captured!.until, "first", "until reaches the core");
  assert.equal(captured!.pane, undefined, "no phantom single-pane pane");
  assert.equal(r.structuredContent.outcome, "multi_wait");
  assert.equal(r.structuredContent.winner, "wF:p9");
  assert.match(r.content[0].text, /multi_wait/);
  assert.match(r.content[0].text, /winner=wF:p9/);
});

test("registration: multi-pane until=all reaches the core and maps the barrier result", async () => {
  let captured: Record<string, unknown> | undefined;
  const svc = makeFakeService(async (op, args) => {
    if (op === "wait") captured = args;
    return {
      ok: false, outcome: "multi_wait", phase: "wait", until: "all",
      panes: ["wF:p9"], winner: null, stillPending: ["wF:p9"],
      results: [{ pane: "wF:p9", outcome: "timeout", status: "working", code: "timeout", observation: "snapshot" }],
      code: "partial",
      hint: "partial",
    };
  });
  const fake = makeFakePi();
  registerSubagentHerdr(fake.pi, { service: svc as RegistrationDeps["service"], env: { HERDR_PANE_ID: "wF:p1" } });
  const r = await runWait({ panes: ["wF:p9"], until: "all", timeoutMs: 100 }, fake);
  assert.equal(r.isError, true, "a partial barrier maps to isError");
  assert.equal(captured!.until, "all");
  assert.deepEqual((r.structuredContent.stillPending as unknown[]), ["wF:p9"]);
});

test("registration: single-pane wait still dispatches with only pane (no panes/until leaked)", async () => {
  let captured: Record<string, unknown> | undefined;
  const svc = makeFakeService(async (op, args) => {
    if (op === "wait") captured = args;
    return { ok: true, outcome: "terminal_observed", phase: "wait", pane: "wF:p9", status: "done", code: "snapshot", observation: "snapshot" };
  });
  const fake = makeFakePi();
  registerSubagentHerdr(fake.pi, { service: svc as RegistrationDeps["service"], env: { HERDR_PANE_ID: "wF:p1" } });
  const r = await runWait({ pane: "wF:p9", timeoutMs: 1000 }, fake);
  assert.equal(r.isError, false);
  assert.equal(captured!.pane, "wF:p9");
  assert.equal(captured!.panes, undefined, "single-pane call must not carry panes");
  assert.equal(captured!.until, undefined, "single-pane call must not carry until");
  assert.equal(r.structuredContent.outcome, "terminal_observed");
});

test("registration: core validation codes for invalid multi-wait addressing surface as tool errors", async () => {
  const svc = makeFakeService(async (op) => {
    if (op === "wait") return { ok: false, outcome: "error", phase: "validation", code: "until_required", hint: 'until must be "first" or "all" when panes is given' };
    return { ok: true, outcome: "ok", phase: "ok" };
  });
  const fake = makeFakePi();
  registerSubagentHerdr(fake.pi, { service: svc as RegistrationDeps["service"], env: { HERDR_PANE_ID: "wF:p1" } });
  const r = await runWait({ panes: ["wF:p9"], timeoutMs: 1000 }, fake);
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.code, "until_required", "missing until is a validation error, not a silent single-pane wait");
});

// ---------------------------------------------------------------------------
// Result mapping (execute callbacks)
// ---------------------------------------------------------------------------

async function runTool(tool: CapturedTool, params: Record<string, unknown>, fake: FakePi) {
  return (await tool.execute("call-1", params, undefined, undefined, fake.ctx)) as {
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
    structuredContent: Record<string, unknown>;
    isError: boolean;
  };
}

test("tool execute maps core success to isError=false + structured pane/delivery/observation", async () => {
  const svc = makeFakeService(async (op, args) => ({
    ok: true,
    outcome: "terminal_observed",
    phase: "wait",
    pane: "wF:p2",
    status: "done",
    delivery: "acknowledged",
    observation: "state_changed_after_submission",
    console: "worker output 🧵",
    consoleSource: "agent",
    truncated: false,
    code: "done",
    hint: "ok",
  }));
  const fake = makeFakePi();
  registerSubagentHerdr(fake.pi, { service: svc as RegistrationDeps["service"], env: { HERDR_PANE_ID: "wF:p1" } });
  const byName = new Map(fake.tools.map((t) => [t.name, t]));
  const r = await runTool(byName.get("subagent_prompt")!, { pane: "wF:p2", prompt: "hi", wait: true }, fake);
  assert.equal(r.isError, false);
  assert.equal(r.structuredContent.ok, true);
  assert.equal(r.structuredContent.outcome, "terminal_observed");
  assert.equal(r.structuredContent.pane, "wF:p2");
  assert.equal(r.structuredContent.status, "done");
  assert.equal(r.structuredContent.delivery, "acknowledged");
  assert.equal(r.structuredContent.observation, "state_changed_after_submission");
  assert.equal(r.structuredContent.console, "worker output 🧵");
  assert.equal(r.structuredContent.consoleSource, "agent");
  assert.match(r.content[0].text, /terminal_observed \(phase: wait\)/);
  assert.match(r.content[0].text, /worker output 🧵/);
});

test("tool execute maps core failure to isError=true with structured code", async () => {
  const svc = makeFakeService(async () => ({
    ok: false,
    outcome: "denied",
    phase: "validation",
    code: "self_control",
    pane: "wF:p1",
    hint: "self-control denied",
  }));
  const fake = makeFakePi();
  registerSubagentHerdr(fake.pi, { service: svc as RegistrationDeps["service"], env: { HERDR_PANE_ID: "wF:p1" } });
  const byName = new Map(fake.tools.map((t) => [t.name, t]));
  const r = await runTool(byName.get("subagent_send")!, { pane: "wF:p1", text: "ls" }, fake);
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.code, "self_control");
  assert.equal(r.structuredContent.outcome, "denied");
  assert.match(r.content[0].text, /denied \(phase: validation\)/);
});

test("tool execute: console failure is a separate field (consoleError), action result intact", async () => {
  const svc = makeFakeService(async () => ({
    ok: true,
    outcome: "terminal_observed",
    phase: "wait",
    pane: "wF:p9",
    status: "done",
    delivery: "acknowledged",
    consoleError: "console read failed (server_not_running): no server",
    code: "done",
  }));
  const fake = makeFakePi();
  registerSubagentHerdr(fake.pi, { service: svc as RegistrationDeps["service"], env: { HERDR_PANE_ID: "wF:p1" } });
  const byName = new Map(fake.tools.map((t) => [t.name, t]));
  const r = await runTool(byName.get("subagent_prompt")!, { pane: "wF:p9", prompt: "hi", wait: true }, fake);
  assert.equal(r.isError, false, "action outcome survives console failure");
  assert.equal(r.structuredContent.outcome, "terminal_observed");
  assert.equal(r.structuredContent.console, undefined, "no console content on failure");
  assert.match(String(r.structuredContent.consoleError), /server_not_running/);
});

test("core exceptions are caught and mapped to a structured internal error", async () => {
  const svc = makeFakeService(async () => {
    throw new Error("boom");
  });
  const fake = makeFakePi();
  registerSubagentHerdr(fake.pi, { service: svc as RegistrationDeps["service"], env: { HERDR_PANE_ID: "wF:p1" } });
  const byName = new Map(fake.tools.map((t) => [t.name, t]));
  const r = await runTool(byName.get("subagent_list")!, {}, fake);
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.code, "internal_error");
  assert.match(String(r.structuredContent.detail), /boom/);
});

test("deprecated allowExternal/externalConfirmed are stripped before core dispatch", async () => {
  let captured: Record<string, unknown> | undefined;
  const svc = makeFakeService(async (op, args) => {
    captured = args;
    return { ok: true, outcome: "closed", phase: "close", pane: "wF:p9", verifiedAbsent: true };
  });
  const fake = makeFakePi();
  registerSubagentHerdr(fake.pi, { service: svc as RegistrationDeps["service"], env: { HERDR_PANE_ID: "wF:p1" } });
  const byName = new Map(fake.tools.map((t) => [t.name, t]));
  await runTool(byName.get("subagent_close")!, { pane: "wF:p9", allowExternal: true, externalConfirmed: true }, fake);
  assert.ok(captured);
  assert.equal(captured!.allowExternal, undefined, "allowExternal stripped");
  assert.equal(captured!.externalConfirmed, undefined, "externalConfirmed stripped");
  assert.equal(captured!.pane, "wF:p9");
});

// ---------------------------------------------------------------------------
// Footer (R-10): TUI + HERDR_PANE_ID only
// ---------------------------------------------------------------------------

test("footer: TUI inside a herdr pane sets the status line", async () => {
  const fake = makeFakePi({ mode: "tui" });
  registerSubagentHerdr(fake.pi, { service: makeFakeService() as RegistrationDeps["service"], env: { HERDR_PANE_ID: "w2V:p1" } });
  // Fire the session_start handler.
  const handlers = fake.handlers.get("session_start")!;
  for (const h of handlers) h(undefined, fake.ctx);
  const statusLine = fake.statusCalls.find((s) => s.key === "pi-subagent-herdr" && typeof s.text === "string");
  assert.ok(statusLine, "status line set on session_start");
  assert.match(statusLine!.text!, /w2V:p1/);
});

test("footer: non-TUI mode does not set the status line", async () => {
  const fake = makeFakePi({ mode: "rpc" });
  registerSubagentHerdr(fake.pi, { service: makeFakeService() as RegistrationDeps["service"], env: { HERDR_PANE_ID: "w2V:p1" } });
  const handlers = fake.handlers.get("session_start")!;
  for (const h of handlers) h(undefined, fake.ctx);
  const statusLine = fake.statusCalls.find((s) => s.key === "pi-subagent-herdr" && typeof s.text === "string");
  assert.equal(statusLine, undefined, "no status line outside TUI");
});

test("footer: TUI without HERDR_PANE_ID does not set the status line", async () => {
  const fake = makeFakePi({ mode: "tui" });
  registerSubagentHerdr(fake.pi, { service: makeFakeService() as RegistrationDeps["service"], env: {} });
  const handlers = fake.handlers.get("session_start")!;
  for (const h of handlers) h(undefined, fake.ctx);
  const statusLine = fake.statusCalls.find((s) => s.key === "pi-subagent-herdr" && typeof s.text === "string");
  assert.equal(statusLine, undefined, "no status line without HERDR_PANE_ID");
});

// ---------------------------------------------------------------------------
// Ownership persistence: session isolation
// ---------------------------------------------------------------------------

test("ownership: foreign-session records are not inherited", async () => {
  const entries = [
    {
      type: "custom" as const,
      customType: "pi-subagent-herdr-ownership-v1",
      data: {
        sessionId: "other-session",
        records: [{ pane_id: "wF:p9", workspace_id: "wF", session: "other-session" }],
      },
    },
  ];
  const fake = makeFakePi({ entries });
  const svc = makeFakeService();
  registerSubagentHerdr(fake.pi, { service: svc as RegistrationDeps["service"], env: { HERDR_PANE_ID: "wF:p1" } });
  const handlers = fake.handlers.get("session_start")!;
  for (const h of handlers) h(undefined, fake.ctx);
  assert.equal(svc.getOwned().length, 0, "foreign-session ownership not restored");
});

test("ownership: same-session records are restored on session_start", async () => {
  const entries = [
    {
      type: "custom" as const,
      customType: "pi-subagent-herdr-ownership-v1",
      data: {
        sessionId: "sess-1",
        records: [{ pane_id: "wF:p9", workspace_id: "wF", session: "sess-1" }],
      },
    },
  ];
  const fake = makeFakePi({ entries });
  const svc = makeFakeService();
  registerSubagentHerdr(fake.pi, { service: svc as RegistrationDeps["service"], env: { HERDR_PANE_ID: "wF:p1" } });
  const handlers = fake.handlers.get("session_start")!;
  for (const h of handlers) h(undefined, fake.ctx);
  assert.equal(svc.getOwned().length, 1, "same-session ownership restored");
  assert.equal(svc.getOwned()[0].pane_id, "wF:p9");
});

test("ownership: start persists via appendEntry with the session id", async () => {
  const svc = makeFakeService(async (op, args) => {
    if (op === "start") {
      (svc as unknown as { _owned: Map<string, unknown> })._owned?.set("wF:p2", { pane_id: "wF:p2", workspace_id: "wF" });
      return { ok: true, outcome: "submitted", phase: "submission", pane: "wF:p2" };
    }
    return { ok: true, outcome: "ok", phase: "ok" };
  });
  // The fake service's getOwned must reflect the start.
  const ownedMap = new Map<string, Record<string, unknown>>();
  (svc as unknown as { _owned: Map<string, unknown> })._owned = ownedMap;
  (svc as unknown as { getOwned(): Array<{ pane_id: string; session?: string }> }).getOwned = () =>
    [...ownedMap.values()].map((r) => ({ pane_id: String(r.pane_id), workspace_id: String(r.workspace_id) }));
  const fake = makeFakePi();
  registerSubagentHerdr(fake.pi, { service: svc as RegistrationDeps["service"], env: { HERDR_PANE_ID: "wF:p1" } });
  const byName = new Map(fake.tools.map((t) => [t.name, t]));
  await runTool(byName.get("subagent_start")!, { name: "a", cwd: "/tmp", task: "t" }, fake);
  assert.equal(fake.appended.length, 1, "ownership persisted after start");
  const entry = fake.appended[0];
  assert.equal(entry.customType, "pi-subagent-herdr-ownership-v1");
  const data = entry.data as { sessionId: string; records: Array<{ pane_id: string; session: string }> };
  assert.equal(data.sessionId, "sess-1");
  assert.equal(data.records[0].pane_id, "wF:p2");
  assert.equal(data.records[0].session, "sess-1");
});

// ---------------------------------------------------------------------------
// resolveRuntimeDir
// ---------------------------------------------------------------------------

test("resolveRuntimeDir: explicit flag wins over env and bundled default", () => {
  const dir = resolveRuntimeDir("/explicit/path", { PI_SUBAGENT_RUNTIME_DIR: "/env/path" }, "/home/user");
  assert.equal(dir, "/explicit/path");
});

test("resolveRuntimeDir: env wins over bundled default", () => {
  const dir = resolveRuntimeDir(undefined, { PI_SUBAGENT_RUNTIME_DIR: "/env/path" }, "/home/user");
  assert.equal(dir, "/env/path");
});

test("resolveRuntimeDir: no overrides selects bundled directory, not legacy profile scanning", () => {
  const dir = resolveRuntimeDir(undefined, {}, "/installed package/skills/scripts");
  assert.equal(dir, "/installed package/skills/scripts");
});

// ---------------------------------------------------------------------------
// Defaults (0.2.0 contract)
// ---------------------------------------------------------------------------

test("defaults: match the 0.2.0 contract", () => {
  assert.equal(DEFAULTS.detectionMs, 15_000);
  assert.equal(DEFAULTS.waitMs, 30 * 60_000);
  assert.equal(DEFAULTS.maxWaitMs, 60 * 60_000);
  assert.equal(DEFAULTS.consoleLines, 100);
  assert.equal(DEFAULTS.consoleChars, 8_000);
  assert.equal(DEFAULTS.maxConsoleLines, 500);
  assert.equal(DEFAULTS.maxConsoleChars, 50_000);
});

test("packaging: no .sub_agent_conf in the extension source", () => {
  for (const f of ["index.ts", "core.ts", "transport.ts"]) {
    const content = fs.readFileSync(path.join(process.cwd(), f), "utf8");
    assert.ok(!content.includes(".sub_agent_conf"), `${f} must not reference .sub_agent_conf`);
  }
});

test("registration: model-visible multi summary includes settled sequence, attribution and console", async () => {
  const svc = makeFakeService(async () => ({
    ok: true, outcome: "multi_wait", phase: "wait", until: "first",
    panes: ["wF:p9"], winner: "wF:p9", stillPending: [],
    results: [{ pane: "wF:p9", outcome: "terminal_observed", status: "done", seq: 41,
      code: "state_changed_after_submission", observation: "may_reflect_prior_turn", delivery: "acknowledged",
      console: "bounded winner 🧵", consoleSource: "agent" }],
  }));
  const fake = makeFakePi();
  registerSubagentHerdr(fake.pi, { service: svc as RegistrationDeps["service"] });
  const r = await runWait({ panes: ["wF:p9"], until: "first" }, fake);
  assert.match(r.content[0].text, /seq=41/);
  assert.match(r.content[0].text, /may_reflect_prior_turn/);
  assert.match(r.content[0].text, /acknowledged/);
  assert.match(r.content[0].text, /bounded winner 🧵/);
});
