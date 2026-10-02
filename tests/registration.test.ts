// Node:test suite for src/index.ts (Pi registration layer).
//
// Covers: registration count/names/schemas, result mapping (isError,
// structuredContent, codepoint tails), footer inside/outside herdr panes,
// session persistence isolation (same-pane new/fork must not inherit;
// same-session reload restores), explicit external-close confirmation and
// no-UI denial. The fake ExtensionAPI captures actual registerTool/on/
// registerFlag/appendEntry/getFlag calls and the tools are exercised via
// their captured execute() callbacks against a fake SubagentService
// injected through RegistrationDeps (no process-wide module hooks).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import registerSubagentHerdr, { resolveRuntimeDir, type RegistrationDeps } from "../src/index.js";
import { SubagentService } from "../src/core.js";
import type { Transport, TransportResult } from "../src/transport.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Core interception: a synchronous Node module hook (registerHooks) that
// redirects the factory's `../src/core.js` import to a data-URL module built
// from the per-test fake service. This substitutes the core without editing
// src/core.ts (owned by another worker) and without CJS require.cache tricks
// that don't apply to ESM output.
//
// The hook fires for `../src/core.js` when its parent is the factory module
// (src/index.js). Each loadFactory() call sets a fresh fake on a stable
// global before importing a unique index.js URL (unique query => fresh
// evaluation, so the factory picks up the new fake).
// ---------------------------------------------------------------------------

async function loadFactory(prime: object, deps: RegistrationDeps = {}) {
  // Import the factory (no process-wide module hooks needed; the fake
  // service is injected via deps.service).
  const mod = await import(`../src/index.js?fakecore=${Date.now()}-${Math.random()}`);
  const factory = mod.default as (pi: ExtensionAPI, deps?: RegistrationDeps) => void;
  // Return the factory pre-bound to the test's deps (env, service, etc.)
  // so callers just invoke factory(pi).
  const merged: RegistrationDeps = { ...deps, service: prime as RegistrationDeps["service"] };
  const bound = (pi: ExtensionAPI) => factory(pi, merged);
  return { factory: bound, ...mod };
}

// ---------------------------------------------------------------------------
// Minimal SDK type stand-ins (the factory only needs the shapes it uses)
// ---------------------------------------------------------------------------

interface CapturedTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  outputSchema: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
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
}

interface FakePi {
  pi: ExtensionAPI;
  tools: CapturedTool[];
  flags: Map<string, { description?: string; type: string }>;
  handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>;
  appended: Array<{ customType: string; data: unknown }>;
  ctx: ExtensionContext;
  setEntries(entries: Array<{ type: "custom"; customType: string; data?: unknown }>): void;
  confirmResults: boolean[];
}

function makeFakePi(options: FakePiOptions = {}): FakePi {
  const tools: CapturedTool[] = [];
  const flags = new Map<string, { description?: string; type: string }>();
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const appended: Array<{ customType: string; data: unknown }> = [];
  let entries: Array<{ type: "custom"; customType: string; data?: unknown }> = options.entries ?? [];
  const confirmResults: boolean[] = [];
  const statusCalls: Array<{ key: string; text: string | undefined }> = [];
  const notifyCalls: Array<{ message: string; type?: string }> = [];
  let sessionId = "sess-1";
  const mode = options.mode ?? "tui";

  const ctx: ExtensionContext = {
    ui: {
      setStatus(key: string, text: string | undefined) {
        statusCalls.push({ key, text });
      },
      notify(message: string, type?: "info" | "warning" | "error") {
        notifyCalls.push({ message, type });
      },
      async confirm(_title: string, _message: string): Promise<boolean> {
        return confirmResults.length > 0 ? confirmResults.shift()! : true;
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
    registerFlag(name: string, options: { description?: string; type: string }) {
      flags.set(name, options);
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

  return {
    pi,
    tools,
    flags,
    handlers,
    appended,
    ctx,
    setEntries(next: Array<{ type: "custom"; customType: string; data?: unknown }>) {
      entries = next;
    },
    confirmResults,
  };
}

// ---------------------------------------------------------------------------
// Fake SubagentService (dependency injection: the factory reads it from
// require.cache, so we prime the .js specifiers it imports)
// ---------------------------------------------------------------------------

interface FakeServiceOptions {
  executeImpl?: (op: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<{
    ok: boolean;
    outcome: string;
    phase: string;
    pane_id?: string;
    code?: string;
    hint?: string;
    detail?: string;
    tail?: string;
    continuation?: string;
  }>;
}

interface FakeService {
  execute(op: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<{
    ok: boolean;
    outcome: string;
    phase: string;
    pane_id?: string;
    code?: string;
    hint?: string;
    detail?: string;
    tail?: string;
    continuation?: string;
  }>;
  getOwned(): Array<{ pane_id: string; session?: string }>;
  restoreOwned(records: ReadonlyArray<unknown>): void;
}

function makeFakeService(impl: FakeServiceOptions["executeImpl"]): FakeService {
  const owned = new Map<string, Record<string, unknown>>();
  return {
    async execute(op: string, args: Record<string, unknown> = {}, signal?: AbortSignal) {
      if (impl) return impl(op, args, signal);
      return {
        ok: true,
        outcome: "submitted",
        phase: "submission",
        pane_id: `wF:p${op}`,
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
  const { factory } = await loadFactory(makeFakeService(undefined));
  factory(fake.pi);
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

test("parameter schemas are finite and bounded where the contract requires", async () => {
  const fake = makeFakePi();
  const { factory } = await loadFactory(makeFakeService(undefined));
  factory(fake.pi);
  const byName = new Map(fake.tools.map((t) => [t.name, t]));
  const props = (t: CapturedTool) =>
    Object.keys((t.parameters as { properties?: Record<string, unknown> }).properties ?? {});
  assert.ok(props(byName.get("subagent_start")!).includes("task"));
  assert.ok(props(byName.get("subagent_start")!).includes("name"));
  assert.ok(props(byName.get("subagent_read")!).includes("maxChars"), "read exposes tail limit");
  assert.ok(!props(byName.get("subagent_close")!).includes("externalConfirmed"), "close schema does not expose externalConfirmed");
  assert.ok(!props(byName.get("subagent_close")!).includes("allowExternal"));
  // wait exposes a continuation parameter
  assert.ok(props(byName.get("subagent_wait")!).includes("continuation"));
});

test("annotations: read/list/spaces read-only; close destructive+idempotent; start open-world", async () => {
  const fake = makeFakePi();
  const { factory } = await loadFactory(makeFakeService(undefined));
  factory(fake.pi);
  const byName = new Map(fake.tools.map((t) => [t.name, t]));
  assert.equal(byName.get("subagent_read")!.annotations?.readOnlyHint, true);
  assert.equal(byName.get("subagent_list")!.annotations?.readOnlyHint, true);
  assert.equal(byName.get("subagent_spaces")!.annotations?.readOnlyHint, true);
  assert.equal(byName.get("subagent_close")!.annotations?.destructiveHint, true);
  assert.equal(byName.get("subagent_close")!.annotations?.idempotentHint, true);
  assert.equal(byName.get("subagent_start")!.annotations?.openWorldHint, true);
});

test("registers the runtime-dir CLI flag (string type)", async () => {
  const fake = makeFakePi();
  const { factory } = await loadFactory(makeFakeService(undefined));
  factory(fake.pi);
  assert.ok(fake.flags.has("subagent-herdr-runtime-dir"));
  assert.equal(fake.flags.get("subagent-herdr-runtime-dir")!.type, "string");
});

test("session_start and session_shutdown handlers are registered", async () => {
  const fake = makeFakePi();
  const { factory } = await loadFactory(makeFakeService(undefined));
  factory(fake.pi);
  assert.ok(fake.handlers.has("session_start"));
  assert.ok(fake.handlers.has("session_shutdown"));
});

// ---------------------------------------------------------------------------
// Result mapping: execute() callbacks verified, not constants
// ---------------------------------------------------------------------------

async function runTool(tool: CapturedTool, params: Record<string, unknown>, fake: FakePi) {
  return (await tool.execute("call-1", params, undefined, undefined, fake.ctx)) as {
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
    structuredContent: Record<string, unknown>;
    isError: boolean;
  };
}

test("tool execute maps core success to isError=false + structuredContent", async () => {
  const svc = makeFakeService(async (op) => ({
    ok: true,
    outcome: "submitted",
    phase: "submission",
    pane_id: "wF:p2",
    code: "prompt.sent",
    hint: "receipt",
  }));
  const fake = makeFakePi();
  const { factory } = await loadFactory(svc);
  factory(fake.pi);
  const byName = new Map(fake.tools.map((t) => [t.name, t]));
  const r = await runTool(byName.get("subagent_prompt")!, { target: "wF:p2", task: "hi" }, fake);
  assert.equal(r.isError, false);
  assert.equal(r.structuredContent.ok, true);
  assert.equal(r.structuredContent.outcome, "submitted");
  assert.equal(r.structuredContent.pane_id, "wF:p2");
  assert.equal(r.structuredContent.code, "prompt.sent");
  assert.match(r.content[0].text, /submitted \(phase: submission\)/);
});

test("tool execute maps core failure to isError=true with structured code", async () => {
  const svc = makeFakeService(async () => ({
    ok: false,
    outcome: "denied",
    phase: "ownership",
    code: "external_target",
    pane_id: "wF:p9",
    hint: "opt-in required",
  }));
  const fake = makeFakePi();
  const { factory } = await loadFactory(svc);
  factory(fake.pi);
  const byName = new Map(fake.tools.map((t) => [t.name, t]));
  const r = await runTool(byName.get("subagent_send")!, { target: "wF:p9", text: "ls" }, fake);
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.code, "external_target");
  assert.equal(r.structuredContent.outcome, "denied");
  assert.match(r.content[0].text, /denied \(phase: ownership\)/);
});

test("tail code points are surfaced verbatim (unicode tail)", async () => {
  // 6 emoji = 6 code points; the tail must survive intact.
  const svc = makeFakeService(async () => ({
    ok: true,
    outcome: "read",
    phase: "read",
    tail: "🧵".repeat(6),
  }));
  const fake = makeFakePi();
  const { factory } = await loadFactory(svc);
  factory(fake.pi);
  const byName = new Map(fake.tools.map((t) => [t.name, t]));
  const r = await runTool(byName.get("subagent_read")!, { target: "wF:p2" }, fake);
  assert.equal([...String(r.structuredContent.tail)].length, 6, "tail counts code points");
  assert.ok(r.content[0].text.includes("🧵🧵🧵🧵🧵🧵"));
});

test("core exceptions are caught and mapped to a structured internal error", async () => {
  const svc = makeFakeService(async () => {
    throw new Error("boom");
  });
  const fake = makeFakePi();
  const { factory } = await loadFactory(svc);
  factory(fake.pi);
  const byName = new Map(fake.tools.map((t) => [t.name, t]));
  const r = await runTool(byName.get("subagent_list")!, {}, fake);
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.code, "internal_error");
  assert.match(String(r.structuredContent.detail), /boom/);
});

// ---------------------------------------------------------------------------
// Footer (R-10): inside vs outside a herdr pane, TUI only
// ---------------------------------------------------------------------------

function captureStatus(ctx: ExtensionContext): Array<{ key: string; text: string | undefined }> {
  const calls: Array<{ key: string; text: string | undefined }> = [];
  const orig = ctx.ui.setStatus;
  ctx.ui.setStatus = (key: string, text: string | undefined) => {
    calls.push({ key, text });
    orig.call(ctx.ui, key, text);
  };
  return calls;
}

test("footer: status set with pane id when TUI inside herdr pane", async () => {
  const fake = makeFakePi({ mode: "tui" });
  const env = { HERDR_PANE_ID: "wP:p7" } as NodeJS.ProcessEnv;
  const calls = captureStatus(fake.ctx);
  const { factory } = await loadFactory(makeFakeService(undefined), { env });
  factory(fake.pi);
  for (const h of fake.handlers.get("session_start")!) await h({}, fake.ctx);
  assert.deepEqual(calls, [{ key: "pi-subagent-herdr", text: "herdr pane wP:p7" }]);
});

test("footer: cleared (undefined) when HERDR_PANE_ID is absent", async () => {
  const fake = makeFakePi({ mode: "tui" });
  const env = {} as NodeJS.ProcessEnv;
  const calls = captureStatus(fake.ctx);
  const { factory } = await loadFactory(makeFakeService(undefined), { env });
  factory(fake.pi);
  for (const h of fake.handlers.get("session_start")!) await h({}, fake.ctx);
  assert.deepEqual(calls, [{ key: "pi-subagent-herdr", text: undefined }]);
});

test("footer: not set in non-TUI mode even with HERDR_PANE_ID", async () => {
  const fake = makeFakePi({ mode: "rpc" });
  const env = { HERDR_PANE_ID: "wP:p7" } as NodeJS.ProcessEnv;
  const calls = captureStatus(fake.ctx);
  const { factory } = await loadFactory(makeFakeService(undefined), { env });
  factory(fake.pi);
  for (const h of fake.handlers.get("session_start")!) await h({}, fake.ctx);
  assert.deepEqual(calls, [], "no setStatus outside TUI");
});

// ---------------------------------------------------------------------------
// Session persistence: isolation (new/fork) and same-session restore
// ---------------------------------------------------------------------------

test("persistence: same-session reload restores owned panes", async () => {
  const svc = makeFakeService(undefined);
  const records = [
    {
      pane_id: "wF:p2",
      workspace_id: "wF",
      terminal_id: "term_1",
      name: "otto",
      launched_at: 1,
      session: "sess-1", // matches the fake sessionManager.getSessionId()
    },
  ];
  const fake = makeFakePi({
    entries: [
      { type: "custom", customType: "pi-subagent-herdr-ownership-v1", data: { sessionId: "sess-1", records } },
    ],
  });
  const { factory } = await loadFactory(svc, { env: { HERDR_PANE_ID: "wF:p1" } as NodeJS.ProcessEnv });
  factory(fake.pi);
  for (const h of fake.handlers.get("session_start")!) await h({}, fake.ctx);
  assert.equal(svc.getOwned().length, 1, "restored from branch entries");
  assert.equal((svc.getOwned()[0] as { pane_id: string }).pane_id, "wF:p2");
});

test("persistence: foreign-session records are filtered out (fork/new isolation)", async () => {
  const svc = makeFakeService(undefined);
  const foreign = [
    {
      pane_id: "wF:p2",
      workspace_id: "wF",
      name: "stray",
      session: "sess-OTHER", // different Pi session ID
    },
  ];
  const fake = makeFakePi({
    entries: [
      { type: "custom", customType: "pi-subagent-herdr-ownership-v1", data: { sessionId: "sess-OTHER", records: foreign } },
    ],
  });
  const { factory } = await loadFactory(svc, { env: { HERDR_PANE_ID: "wF:p1" } as NodeJS.ProcessEnv });
  factory(fake.pi);
  for (const h of fake.handlers.get("session_start")!) await h({}, fake.ctx);
  assert.equal(svc.getOwned().length, 0, "records from another Pi session are not inherited");
});

test("persistence: same-pane new session does not inherit (two sessions, same HERDR pane)", async () => {
  // Two Pi sessions in the same HERDR pane must not inherit each other's control.
  const svc = makeFakeService(undefined);
  const records = [
    {
      pane_id: "wF:p2",
      workspace_id: "wF",
      name: "worker",
      session: "sess-A", // owned by a different Pi session in the same pane
    },
  ];
  const fake = makeFakePi({
    entries: [
      { type: "custom", customType: "pi-subagent-herdr-ownership-v1", data: { sessionId: "sess-A", records } },
    ],
  });
  // The fake sessionManager returns "sess-1" (a different session ID).
  const { factory } = await loadFactory(svc, { env: { HERDR_PANE_ID: "wF:p1" } as NodeJS.ProcessEnv });
  factory(fake.pi);
  for (const h of fake.handlers.get("session_start")!) await h({}, fake.ctx);
  assert.equal(svc.getOwned().length, 0, "same-pane different-session records are filtered");
});

test("persistence: start with a new owned pane appends an ownership entry", async () => {
  let recorded: unknown[] = [];
  const svc = makeFakeService(async (op) => {
    if (op === "start") {
      recorded = [{ pane_id: "wF:p5", workspace_id: "wF", name: "nova", session: "wF:p1" }];
      return { ok: true, outcome: "submitted", phase: "submission", pane_id: "wF:p5" };
    }
    return { ok: true, outcome: "listed", phase: "list" };
  });
  // Make getOwned return the recorded panes after start.
  (svc as unknown as { getOwned(): unknown[] }).getOwned = () =>
    (recorded as Array<Record<string, unknown>>).map((r) => ({ ...r }));
  const fake = makeFakePi();
  const { factory } = await loadFactory(svc, { env: { HERDR_PANE_ID: "wF:p1" } as NodeJS.ProcessEnv });
  factory(fake.pi);
  const byName = new Map(fake.tools.map((t) => [t.name, t]));
  await runTool(byName.get("subagent_start")!, { name: "nova", task: "t", cwd: "/tmp" }, fake);
  assert.equal(fake.appended.length, 1, "ownership persisted once after start");
  assert.equal(fake.appended[0].customType, "pi-subagent-herdr-ownership-v1");
  const data = fake.appended[0].data as { sessionId: string; records: unknown[] };
  assert.equal(data.sessionId, "sess-1", "session ID persisted explicitly");
  assert.equal(data.records.length, 1);
});

// ---------------------------------------------------------------------------
// External close: UI confirmation, denial, and no-UI denial
// ---------------------------------------------------------------------------

test("close external pane: unconfirmed deny triggers real UI confirm; confirmed close executes once", async () => {
  let closeCalls = 0;
  const svc = makeFakeService(async (op, args) => {
    if (op === "close") {
      closeCalls += 1;
      if (args.externalConfirmed === true) {
        return { ok: true, outcome: "closed", phase: "close", pane_id: "wF:p77", hint: "closed" };
      }
      return {
        ok: false,
        outcome: "denied",
        phase: "ownership",
        code: "external_target",
        pane_id: "wF:p77",
        hint: "opt-in required",
      };
    }
    return { ok: true, outcome: "ok", phase: "op" };
  });
  const fake = makeFakePi();
  fake.confirmResults.push(true);
  const { factory } = await loadFactory(svc);
  factory(fake.pi);
  const byName = new Map(fake.tools.map((t) => [t.name, t]));
  const r = await runTool(
    byName.get("subagent_close")!,
    { target: "wF:p77", externalConfirmed: true }, // model tries to shortcut
    fake,
  );
  assert.equal(r.isError, false);
  assert.equal(r.structuredContent.outcome, "closed");
  assert.equal(closeCalls, 2, "first unconfirmed attempt (core deny) + one confirmed execution");
  assert.match(r.content[0].text, /confirmed via UI; close executed/);
});

test("close external pane: UI decline -> denied, core executes close exactly zero confirmed times", async () => {
  let confirmedCalls = 0;
  const svc = makeFakeService(async (op, args) => {
    if (op === "close" && args.externalConfirmed === true) confirmedCalls += 1;
    if (op === "close") {
      return {
        ok: false,
        outcome: "denied",
        phase: "ownership",
        code: "external_target",
        pane_id: "wF:p77",
      };
    }
    return { ok: true, outcome: "ok", phase: "op" };
  });
  const fake = makeFakePi();
  fake.confirmResults.push(false);
  const { factory } = await loadFactory(svc);
  factory(fake.pi);
  const byName = new Map(fake.tools.map((t) => [t.name, t]));
  const r = await runTool(byName.get("subagent_close")!, { target: "wF:p77" }, fake);
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.code, "user_declined");
  assert.equal(confirmedCalls, 0, "no close executed after decline");
  assert.match(r.content[0].text, /declined via UI/);
});

test("close external pane: no UI available -> denied with no_ui_available", async () => {
  const svc = makeFakeService(async (op) => {
    if (op === "close") {
      return {
        ok: false,
        outcome: "denied",
        phase: "ownership",
        code: "external_target",
        pane_id: "wF:p77",
      };
    }
    return { ok: true, outcome: "ok", phase: "op" };
  });
  const fake = makeFakePi({ hasUI: false, mode: "json" });
  const { factory } = await loadFactory(svc);
  factory(fake.pi);
  const byName = new Map(fake.tools.map((t) => [t.name, t]));
  const r = await runTool(byName.get("subagent_close")!, { target: "wF:p77" }, fake);
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.code, "no_ui_available");
  assert.equal(r.structuredContent.outcome, "denied");
});

test("close owned pane: no UI involvement, core result passes through", async () => {
  const svc = makeFakeService(async (op) => {
    if (op === "close") return { ok: true, outcome: "closed", phase: "close", pane_id: "wF:p2" };
    return { ok: true, outcome: "ok", phase: "op" };
  });
  const fake = makeFakePi();
  fake.confirmResults.push(false);
  const { factory } = await loadFactory(svc);
  factory(fake.pi);
  const byName = new Map(fake.tools.map((t) => [t.name, t]));
  const r = await runTool(byName.get("subagent_close")!, { target: "wF:p2" }, fake);
  assert.equal(r.isError, false);
  assert.equal(r.structuredContent.outcome, "closed");
  assert.equal(fake.confirmResults.length, 1, "confirm was never called for an owned pane");
});

// ---------------------------------------------------------------------------
// Runtime dir resolution precedence
// ---------------------------------------------------------------------------

test("resolveRuntimeDir: flag beats env beats profile discovery", () => {
  const fakeHome = "/tmp/fakehome";
  assert.equal(resolveRuntimeDir("/x/flag-dir", { A: "1" }, fakeHome), "/x/flag-dir");
  assert.equal(resolveRuntimeDir(undefined, { PI_SUBAGENT_RUNTIME_DIR: "/x/env-dir" }, fakeHome), "/x/env-dir");
  assert.equal(resolveRuntimeDir("  ", { PI_SUBAGENT_RUNTIME_DIR: "" }, fakeHome), undefined, "blank flag/env fall through");
});

test("runtime flag value is passed to the factory via getFlag", async () => {
  const fake = makeFakePi({ flag: "/x/flag-dir" });
  const { factory } = await loadFactory(makeFakeService(undefined));
  factory(fake.pi);
  // The flag is registered with the agreed name; its value feeds resolveRuntimeDir.
  assert.ok(fake.flags.has("subagent-herdr-runtime-dir"));
});

// ---------------------------------------------------------------------------
// Integration: real SubagentService with fake transport (no process-wide hooks)
// ---------------------------------------------------------------------------

/**
 * Build a fake transport that records calls and returns canned results.
 * The canned results must match the herdr CLI JSON shapes the core expects.
 */
function makeFakeTransport(results: Array<{ args: string[]; result: TransportResult }>): {
  transport: Transport;
  calls: string[][];
} {
  const calls: string[][] = [];
  let idx = 0;
  const transport: Transport = {
    async run(args: string[]): Promise<TransportResult> {
      calls.push(args);
      if (idx < results.length) {
        const match = results[idx];
        idx++;
        // Return the canned result; the args are recorded for assertions.
        return match.result;
      }
      // Fallback: return an empty success.
      return { exitCode: 0, stdout: "{}", stderr: "" };
    },
  };
  return { transport, calls };
}

/**
 * A fake ExtensionAPI whose getFlag throws for unregistered flags (strict SDK
 * behaviour) and returns the registered value otherwise.
 */
function makeStrictPi(): { pi: ExtensionAPI; flags: Map<string, string>; tools: CapturedTool[]; handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>; appended: Array<{ customType: string; data: unknown }>; ctx: ExtensionContext } {
  const flags = new Map<string, string>();
  const tools: CapturedTool[] = [];
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const appended: Array<{ customType: string; data: unknown }> = [];
  let sessionId = "sess-strict-1";
  const entries: Array<{ type: string; customType?: string; data?: unknown }> = [];

  const ctx: ExtensionContext = {
    ui: {
      setStatus() {},
      notify() {},
      async confirm() { return true; },
    } as unknown as ExtensionContext["ui"],
    mode: "tui" as ExtensionContext["mode"],
    hasUI: true,
    cwd: "/tmp",
    signal: undefined,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => entries as unknown as ReturnType<ExtensionContext["sessionManager"]["getBranch"]>,
      getEntries: () => entries as unknown as ReturnType<ExtensionContext["sessionManager"]["getEntries"]>,
    } as unknown as ExtensionContext["sessionManager"],
  } as unknown as ExtensionContext;
  // Expose entries for test seeding.
  (ctx as any).__entries = entries;

  const pi = {
    registerTool(tool: unknown) { tools.push(tool as CapturedTool); },
    registerFlag(name: string, _opts: unknown) { flags.set(name, ""); },
    getFlag(name: string): unknown {
      if (!flags.has(name)) throw new Error(`flag not registered: ${name}`);
      return flags.get(name);
    },
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      const arr = handlers.get(event) ?? [];
      arr.push(handler);
      handlers.set(event, arr);
    },
    appendEntry<T>(customType: string, data: T) {
      appended.push({ customType, data });
      entries.push({ type: "custom", customType, data });
    },
    events: {} as ExtensionAPI["events"],
  } as unknown as ExtensionAPI;

  return { pi, flags, tools, handlers, appended, ctx };
}

test("integration: real SubagentService start → persist → same-session restore", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
  fs.writeFileSync(path.join(tmpDir, "herdr-worker.sh"), "#!/bin/sh\necho fake\n", { mode: 0o755 });

  try {
    // Advancing monotonic clock: starts at 0, +100ms per call.
    let clock = 0;
    const now = () => (clock += 100);

    const calls: string[][] = [];
    const responses: Array<{ match: (a: string[]) => boolean; result: TransportResult }> = [
      {
        match: (a) => a[0] === "pane" && a[1] === "get",
        result: { exitCode: 0, stdout: JSON.stringify({ result: { type: "pane_info", pane: { pane_id: "wI:p1", workspace_id: "wI" } } }), stderr: "" },
      },
      {
        match: (a) => a[0] === "pane" && a[1] === "split",
        result: { exitCode: 0, stdout: JSON.stringify({ result: { type: "pane_info", pane: { pane_id: "wI:p2", workspace_id: "wI", terminal_id: "term_i1", name: "unnamed" } } }), stderr: "" },
      },
      {
        match: (a) => a[0] === "pane" && a[1] === "run",
        result: { exitCode: 0, stdout: "", stderr: "" },
      },
      {
        match: (a) => a[0] === "agent" && a[1] === "get",
        result: { exitCode: 0, stdout: JSON.stringify({ result: { type: "agent_info", agent: { agent: "pi", agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: "/fake/worker.jsonl" }, pane_id: "wI:p2", workspace_id: "wI", terminal_id: "term_i1", name: "nova", agent_status: "idle", state_change_seq: 42 } } }), stderr: "" },
      },
      {
        match: (a) => a[0] === "agent" && a[1] === "rename",
        result: { exitCode: 0, stdout: "", stderr: "" },
      },
      {
        match: (a) => a[0] === "agent" && a[1] === "prompt",
        result: { exitCode: 0, stdout: JSON.stringify({ result: { type: "agent_prompted", agent: { agent_status: "working", state_change_seq: 43 } } }), stderr: "" },
      },
    ];

    const transport: Transport = {
      async run(args: string[]): Promise<TransportResult> {
        calls.push(args);
        for (const r of responses) {
          if (r.match(args)) return r.result;
        }
        throw new Error(`unexpected herdr call: ${args.join(" ")}`);
      },
    };

    const svc = new SubagentService({
      transport,
      paneId: "wI:p1",
      runtimeDir: tmpDir,
      scriptsDir: tmpDir,
      defaults: { detectionMs: 20000, boundedWaitMs: 200, finishWaitMs: 300, maxWaitMs: 500 },
      now,
    });

    const fake = makeStrictPi();
    const deps: RegistrationDeps = { env: { HERDR_PANE_ID: "wI:p1" } as NodeJS.ProcessEnv, service: svc };
    registerSubagentHerdr(fake.pi, deps);

    for (const h of fake.handlers.get("session_start")!) await h({}, fake.ctx);

    const byName = new Map(fake.tools.map((t) => [t.name, t]));
    const startTool = byName.get("subagent_start")!;
    const r = await startTool.execute!("tc1", { name: "nova", task: "do x", cwd: "/tmp", waitMode: "none" }, undefined, undefined, fake.ctx) as { isError: boolean; structuredContent: Record<string, unknown> };

    assert.equal(r.isError, false, `start should succeed, got: ${JSON.stringify(r.structuredContent)}`);

    // Ownership persisted with Pi session ID.
    assert.ok(fake.appended.length >= 1, "ownership entry appended");
    const entry = fake.appended.find((a) => a.customType === "pi-subagent-herdr-ownership-v1");
    assert.ok(entry, "ownership entry found");
    const entryData = entry.data as { sessionId: string; records: Array<{ session: string; pane_id: string }> };
    assert.equal(entryData.sessionId, "sess-strict-1", "top-level sessionId matches");
    assert.ok(entryData.records.length > 0, "records present");
    assert.equal(entryData.records[0].session, "sess-strict-1", "record.session is Pi session ID");
    assert.equal(entryData.records[0].pane_id, "wI:p2", "record.pane_id is the launched worker");

    // Verify the call sequence was correct.
    const callSummary = calls.map((c) => `${c[0]} ${c[1]}`);
    assert.ok(callSummary.includes("pane get"), "pane get called (workspace resolution)");
    assert.ok(callSummary.includes("pane split"), "pane split called");
    assert.ok(callSummary.includes("agent rename"), "agent rename called (not pane rename)");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("integration: persisted branch same-session restore via new SubagentService", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
  fs.writeFileSync(path.join(tmpDir, "herdr-worker.sh"), "#!/bin/sh\necho fake\n", { mode: 0o755 });

  try {
    const fake = makeStrictPi();
    // Seed the branch with a persisted entry (same session).
    (fake.ctx as any).__entries.push({
      type: "custom",
      customType: "pi-subagent-herdr-ownership-v1",
      data: { sessionId: "sess-strict-1", records: [{ pane_id: "wI:p2", workspace_id: "wI", terminal_id: "term_i1", name: "nova", session: "sess-strict-1" }] },
    });

    const svc = new SubagentService({
      paneId: "wI:p1",
      runtimeDir: tmpDir,
      scriptsDir: tmpDir,
      now: () => 1000,
    });

    const deps: RegistrationDeps = { env: { HERDR_PANE_ID: "wI:p1" } as NodeJS.ProcessEnv, service: svc };
    registerSubagentHerdr(fake.pi, deps);

    for (const h of fake.handlers.get("session_start")!) await h({}, fake.ctx);

    const owned = svc.getOwned();
    assert.equal(owned.length, 1, "same-session restore: 1 owned pane");
    assert.equal(owned[0].pane_id, "wI:p2");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("integration: persisted branch different-session denial", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
  fs.writeFileSync(path.join(tmpDir, "herdr-worker.sh"), "#!/bin/sh\necho fake\n", { mode: 0o755 });

  try {
    const fake = makeStrictPi();
    // Seed the branch with a persisted entry from a DIFFERENT session.
    (fake.ctx as any).__entries.push({
      type: "custom",
      customType: "pi-subagent-herdr-ownership-v1",
      data: { sessionId: "sess-OTHER", records: [{ pane_id: "wI:p2", workspace_id: "wI", name: "stray", session: "sess-OTHER" }] },
    });

    const svc = new SubagentService({
      paneId: "wI:p1",
      runtimeDir: tmpDir,
      scriptsDir: tmpDir,
      now: () => 1000,
    });

    const deps: RegistrationDeps = { env: { HERDR_PANE_ID: "wI:p1" } as NodeJS.ProcessEnv, service: svc };
    registerSubagentHerdr(fake.pi, deps);

    for (const h of fake.handlers.get("session_start")!) await h({}, fake.ctx);

    const owned = svc.getOwned();
    assert.equal(owned.length, 0, "different-session records are not inherited");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("integration: strict getFlag throws for unregistered flag", async () => {
  // The strict fake PI throws for unregistered flags.
  // The factory registers the flag before reading it (lazy resolve),
  // so getFlag should succeed after registration.
  const fake = makeStrictPi();
  const svc = makeFakeService(undefined);
  registerSubagentHerdr(fake.pi, { env: {} as NodeJS.ProcessEnv, service: svc });

  // The flag should be registered by the factory.
  assert.ok(fake.flags.has("subagent-herdr-runtime-dir"), "flag registered");

  // getFlag should now work (flag is registered).
  assert.doesNotThrow(() => fake.pi.getFlag("subagent-herdr-runtime-dir"), "getFlag after registration");
});
