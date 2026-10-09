// Node:test suite for the /herdr-fork command registration in index.ts.
//
// The command is exercised through a fake pi API (like the tool tests). The
// herdr transport path is covered by tests/fork.test.ts (in-process fake
// transport); here we verify the registration wiring: the command exists,
// the tool count stays nine, and the session-file gate fires before any
// fork attempt. Handler success/error/abort outcomes are tested through
// RegistrationDeps.forkTransport (a typed in-process fake implementing the
// Transport contract from transport.js): no real herdr process is ever
// spawned, no real pane or tab is created.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import registerSubagentHerdr from "../index.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Transport, TransportResult, TransportOptions } from "../transport.js";

interface CapturedCommand {
  name: string;
  description: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

/**
 * In-memory fake Transport implementing the minimal herdr commands the
 * fork handler needs: pane get (workspace resolution), pane split, tab
 * create, pane run. Records every call; no child process, no real herdr.
 */
class FakeForkTransport implements Transport {
  calls: Array<{ args: string[] }> = [];
  workspaceId = "wT";
  splitPaneId = "wT:p2";
  tabId = "wT:t1";
  rootPaneId = "wT:p3";
  failCommands: Array<{ match: RegExp; code: string; message: string }> = [];

  async run(args: string[], _options: TransportOptions = {}): Promise<TransportResult> {
    this.calls.push({ args: [...args] });
    const joined = args.join(" ");
    for (const fail of this.failCommands) {
      if (fail.match.test(joined)) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: JSON.stringify({ error: { code: fail.code, message: fail.message }, id: "x" }),
        };
      }
    }
    const [a0, a1, a2] = args;
    const out = (obj: unknown): TransportResult => ({
      exitCode: 0,
      stdout: JSON.stringify(obj),
      stderr: "",
    });
    if (a0 === "pane" && a1 === "get") {
      return out({
        id: "cli:pane:get",
        result: { type: "pane_info", pane: { pane_id: a2, workspace_id: this.workspaceId } },
      });
    }
    if (a0 === "pane" && a1 === "split") {
      return out({
        id: "cli:pane:split",
        result: { type: "pane_info", pane: { pane_id: this.splitPaneId, workspace_id: this.workspaceId, focused: true } },
      });
    }
    if (a0 === "tab" && a1 === "create") {
      return out({
        id: "cli:tab:create",
        result: { tab: { tab_id: this.tabId }, root_pane: { pane_id: this.rootPaneId } },
      });
    }
    if (a0 === "pane" && a1 === "run") {
      return out({ id: "cli:pane:run", result: { type: "ok" } });
    }
    throw new Error(`fake transport: unhandled herdr command: ${joined}`);
  }
}

function makeFakeCtx(sessionFile: string | undefined) {
  const notifyCalls: Array<{ message: string; type?: string }> = [];
  const ctx = {
    ui: {
      notifyCalls,
      notify(message: string, type?: "info" | "warning" | "error") {
        notifyCalls.push({ message, type });
      },
    },
    mode: "tui" as const,
    hasUI: true,
    cwd: "/tmp/fork-cmd-project",
    signal: undefined,
    sessionManager: {
      getSessionFile: () => sessionFile,
    },
  } as unknown as Parameters<CapturedCommand["handler"]>[1];
  return { ctx, notifyCalls };
}

function makeFakePi(deps?: { env?: NodeJS.ProcessEnv; forkTransport?: Transport }) {
  const commands = new Map<string, CapturedCommand>();
  const tools: unknown[] = [];
  const pi = {
    registerTool(tool: unknown) {
      tools.push(tool);
    },
    registerCommand(name: string, opts: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, { name, description: opts.description ?? "", handler: opts.handler });
    },
    registerFlag() {},
    getFlag() {
      return undefined;
    },
    on() {
      return () => {};
    },
    appendEntry() {},
  } as unknown as ExtensionAPI;
  registerSubagentHerdr(pi, {
    env: deps?.env,
    ...(deps?.forkTransport !== undefined ? { forkTransport: deps.forkTransport } : {}),
  });
  return { pi, commands, tools };
}

test("registration: herdr-fork command is registered and tool count stays nine", () => {
  const { commands, tools } = makeFakePi();
  assert.ok(commands.has("herdr-fork"), "herdr-fork command must be registered");
  assert.match(commands.get("herdr-fork")!.description, /Fork the active Pi session/);
  assert.equal(tools.length, 9, "exactly nine tools remain registered");
});

test("command: session file missing -> warning, fork never attempted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fork-command-"));
  try {
    const { commands } = makeFakePi();
    const { ctx, notifyCalls } = makeFakeCtx(join(dir, "absent-session.jsonl")); // never written
    await commands.get("herdr-fork")!.handler("down", ctx);
    const warn = notifyCalls.find((n) => /no active session file/i.test(n.message));
    assert.ok(warn, `expected no-session-file warning, got ${JSON.stringify(notifyCalls)}`);
    assert.equal(warn.type, "warning");
    assert.equal(notifyCalls.length, 1, "no other notification expected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("command: session file undefined -> warning, fork never attempted", async () => {
  const { commands } = makeFakePi();
  const { ctx, notifyCalls } = makeFakeCtx(undefined);
  await commands.get("herdr-fork")!.handler("", ctx);
  const warn = notifyCalls.find((n) => /no active session file/i.test(n.message));
  assert.ok(warn, JSON.stringify(notifyCalls));
  assert.equal(warn.type, "warning");
});

test("command: outside Herdr (no HERDR_PANE_ID) -> honest warning, no transport, no pane", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fork-command-"));
  try {
    const sessionFile = join(dir, "parent-session.jsonl");
    writeFileSync(sessionFile, "{}\n");
    // An injected env WITHOUT HERDR_PANE_ID: the handler's single resolved
    // env source sees no pane id, builds the fork service, and service.fork()
    // short-circuits to outside_herdr BEFORE any transport call. The
    // registered env (PI_CODING_AGENT_DIR) is present so the env-source
    // resolution path is exercised end-to-end, but nothing is spawned.
    const { commands } = makeFakePi({
      env: {
        PI_CODING_AGENT_DIR: "/tmp/injected-profile-dir",
      } as NodeJS.ProcessEnv,
    });
    const { ctx, notifyCalls } = makeFakeCtx(sessionFile);
    await commands.get("herdr-fork")!.handler("down check the failing test", ctx);
    const warn = notifyCalls.find((n) => /not running inside a Herdr pane/i.test(n.message));
    assert.ok(warn, JSON.stringify(notifyCalls));
    assert.equal(warn.type, "warning");
    assert.equal(notifyCalls.length, 1, "exactly one notification expected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Full handler path with injected forkTransport (no real herdr process)
// ---------------------------------------------------------------------------

test("command: injected forkTransport, split placement -> success notification, exact argv", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fork-command-"));
  try {
    const sessionFile = join(dir, "parent-session.jsonl");
    writeFileSync(sessionFile, "{}\n");
    const transport = new FakeForkTransport();
    const { commands } = makeFakePi({
      env: { HERDR_PANE_ID: "wT:p1", PI_CODING_AGENT_DIR: "/tmp/profile" } as NodeJS.ProcessEnv,
      forkTransport: transport,
    });
    const { ctx, notifyCalls } = makeFakeCtx(sessionFile);
    await commands.get("herdr-fork")!.handler("down check the failing test", ctx);
    // Success notification with the split pane id and instruction.
    const info = notifyCalls.find((n) => /forked/i.test(n.message));
    assert.ok(info, JSON.stringify(notifyCalls));
    assert.equal(info!.type, "info");
    assert.ok(info!.message.includes(transport.splitPaneId), "success message must name the pane");
    // The transport was called (not the real CLI): split on the parent pane,
    // then pane run in the split pane.
    assert.equal(transport.calls.length, 2);
    assert.equal(transport.calls[0].args[0], "pane");
    assert.equal(transport.calls[0].args[1], "split");
    assert.equal(transport.calls[0].args[2], "wT:p1");
    assert.equal(transport.calls[1].args[0], "pane");
    assert.equal(transport.calls[1].args[1], "run");
    assert.equal(transport.calls[1].args[2], transport.splitPaneId);
    assert.ok(!notifyCalls.some((n) => n.type === "error"), "no error notification expected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("command: injected forkTransport, tab placement -> success notification with tab id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fork-command-"));
  try {
    const sessionFile = join(dir, "parent-session.jsonl");
    writeFileSync(sessionFile, "{}\n");
    const transport = new FakeForkTransport();
    const { commands } = makeFakePi({
      env: { HERDR_PANE_ID: "wT:p1" } as NodeJS.ProcessEnv,
      forkTransport: transport,
    });
    const { ctx, notifyCalls } = makeFakeCtx(sessionFile);
    await commands.get("herdr-fork")!.handler("tab take the tab", ctx);
    const info = notifyCalls.find((n) => /forked/i.test(n.message));
    assert.ok(info, JSON.stringify(notifyCalls));
    assert.equal(info!.type, "info");
    assert.ok(info!.message.includes(transport.tabId), "success message must name the tab");
    // pane get -> tab create -> pane run in the root pane.
    assert.equal(transport.calls.length, 3);
    assert.deepEqual(transport.calls[0].args, ["pane", "get", "wT:p1"]);
    assert.equal(transport.calls[1].args[0], "tab");
    assert.equal(transport.calls[1].args[1], "create");
    assert.equal(transport.calls[2].args[0], "pane");
    assert.equal(transport.calls[2].args[1], "run");
    assert.equal(transport.calls[2].args[2], transport.rootPaneId);
    assert.ok(!notifyCalls.some((n) => n.type === "error"), "no error notification expected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("command: injected forkTransport, split failure -> error notification with code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fork-command-"));
  try {
    const sessionFile = join(dir, "parent-session.jsonl");
    writeFileSync(sessionFile, "{}\n");
    const transport = new FakeForkTransport();
    transport.failCommands.push({
      match: /^pane split/,
      code: "pane_layout_failed",
      message: "maximum panes reached",
    });
    const { commands } = makeFakePi({
      env: { HERDR_PANE_ID: "wT:p1" } as NodeJS.ProcessEnv,
      forkTransport: transport,
    });
    const { ctx, notifyCalls } = makeFakeCtx(sessionFile);
    await commands.get("herdr-fork")!.handler("down", ctx);
    const err = notifyCalls.find((n) => n.type === "error");
    assert.ok(err, JSON.stringify(notifyCalls));
    assert.ok(err!.message.includes("pane_layout_failed"), "error must surface the herdr code");
    assert.ok(!notifyCalls.some((n) => /forked/i.test(n.message)), "no success notification expected");
    assert.equal(transport.calls.length, 1, "no further herdr call after a failed split");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("command: injected forkTransport, run failure -> error notification naming the pane", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fork-command-"));
  try {
    const sessionFile = join(dir, "parent-session.jsonl");
    writeFileSync(sessionFile, "{}\n");
    const transport = new FakeForkTransport();
    transport.failCommands.push({ match: /^pane run/, code: "run_failed", message: "spawn failed" });
    const { commands } = makeFakePi({
      env: { HERDR_PANE_ID: "wT:p1" } as NodeJS.ProcessEnv,
      forkTransport: transport,
    });
    const { ctx, notifyCalls } = makeFakeCtx(sessionFile);
    await commands.get("herdr-fork")!.handler("right", ctx);
    const err = notifyCalls.find((n) => n.type === "error");
    assert.ok(err, JSON.stringify(notifyCalls));
    assert.ok(err!.message.includes("run_failed"), "error must surface the herdr code");
    assert.ok(!notifyCalls.some((n) => /forked/i.test(n.message)), "no success notification expected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
