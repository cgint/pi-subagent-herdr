// Node:test suite for the /herdr-reloc-tab command registration in index.ts.
//
// The command is exercised through a fake pi API (like the fork command
// tests). The herdr transport path is covered by tests/reloc.test.ts
// (in-process fake transport); here we verify the registration wiring: the
// command exists, the tool count stays nine, and the session-file gate fires
// before any reloc attempt. Handler success/error/outcome notifications are
// tested through RegistrationDeps.relocTransport (a typed in-process fake
// implementing the Transport contract from transport.js): no real herdr
// process is ever spawned, no real pane or tab is created.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The documented `npm test` script compiles tests into .test-build/tests/
// (rootDir = repo root, outDir = .test-build), so import.meta.url resolves
// inside .test-build. defaultRelocLauncherPath() (in reloc.js) therefore
// points at .test-build/scripts/, which tsc does not copy. Materialize the
// REAL repo-root launcher asset there before importing index, so the
// handler's launcher-existence check passes — the same fixture the fork
// command handler's defaultForkLauncherPath() would need (tests/fork_command
// .test.ts leaves this to the environment; we do it deterministically here).
function repoRootPath(...parts: string[]): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", ...parts);
}
const compiledScriptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const realLauncher = repoRootPath("scripts", "pi-reloc-launcher.sh");
mkdirSync(compiledScriptsDir, { recursive: true });
copyFileSync(realLauncher, join(compiledScriptsDir, "pi-reloc-launcher.sh"));

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
 * reloc handler needs: pane get (workspace resolution), tab create,
 * pane run, pane close. Records every call; no child process, no real
 * herdr.
 */
class FakeRelocTransport implements Transport {
  calls: Array<{ args: string[] }> = [];
  workspaceId = "wT";
  tabId = "wT:t1";
  rootPaneId = "wT:p3";
  closeMode: "clean" | "not_found" = "clean";
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
    if (a0 === "tab" && a1 === "create") {
      return out({
        id: "cli:tab:create",
        result: { tab: { tab_id: this.tabId }, root_pane: { pane_id: this.rootPaneId } },
      });
    }
    if (a0 === "pane" && a1 === "run") {
      return out({ id: "cli:pane:run", result: { type: "ok" } });
    }
    if (a0 === "pane" && a1 === "close") {
      if (this.closeMode === "not_found") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: JSON.stringify({ error: { code: "pane_not_found", message: "pane does not exist" }, id: "x" }),
        };
      }
      return out({ id: "cli:pane:close", result: { type: "ok" } });
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
    cwd: "/tmp/reloc-cmd-project",
    signal: undefined,
    sessionManager: {
      getSessionFile: () => sessionFile,
    },
  } as unknown as Parameters<CapturedCommand["handler"]>[1];
  return { ctx, notifyCalls };
}

function makeFakePi(deps?: { env?: NodeJS.ProcessEnv; relocTransport?: Transport }) {
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
    ...(deps?.relocTransport !== undefined ? { relocTransport: deps.relocTransport } : {}),
  });
  return { pi, commands, tools };
}

// ---------------------------------------------------------------------------
// Registration + gates (plan §6 cases 1-4)
// ---------------------------------------------------------------------------

test("registration: herdr-reloc-tab command is registered and tool count stays nine", () => {
  const { commands, tools } = makeFakePi();
  assert.ok(commands.has("herdr-reloc-tab"), "herdr-reloc-tab command must be registered");
  assert.match(commands.get("herdr-reloc-tab")!.description, /Relocate the active Pi session to a new Herdr tab/);
  assert.equal(tools.length, 9, "exactly nine tools remain registered");
});

test("command: session file missing -> warning, reloc never attempted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reloc-command-"));
  try {
    const { commands } = makeFakePi();
    const { ctx, notifyCalls } = makeFakeCtx(join(dir, "absent-session.jsonl")); // never written
    await commands.get("herdr-reloc-tab")!.handler("", ctx);
    const warn = notifyCalls.find((n) => /no active session file/i.test(n.message));
    assert.ok(warn, `expected no-session-file warning, got ${JSON.stringify(notifyCalls)}`);
    assert.equal(warn.type, "warning");
    assert.equal(notifyCalls.length, 1, "no other notification expected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("command: session file undefined -> warning, reloc never attempted", async () => {
  const { commands } = makeFakePi();
  const { ctx, notifyCalls } = makeFakeCtx(undefined);
  await commands.get("herdr-reloc-tab")!.handler("", ctx);
  const warn = notifyCalls.find((n) => /no active session file/i.test(n.message));
  assert.ok(warn, JSON.stringify(notifyCalls));
  assert.equal(warn.type, "warning");
});

test("command: outside Herdr (no HERDR_PANE_ID) -> honest warning, no error, no transport", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reloc-command-"));
  try {
    const sessionFile = join(dir, "active-session.jsonl");
    writeFileSync(sessionFile, "{}\n");
    // An injected env WITHOUT HERDR_PANE_ID: the handler's single resolved
    // env source sees no pane id, builds the reloc service, and
    // service.reloc() short-circuits to outside_herdr BEFORE any transport
    // call. The registered env (PI_CODING_AGENT_DIR) is present so the
    // env-source resolution path is exercised end-to-end, but nothing is
    // spawned.
    const { commands } = makeFakePi({
      env: {
        PI_CODING_AGENT_DIR: "/tmp/injected-profile-dir",
      } as NodeJS.ProcessEnv,
    });
    const { ctx, notifyCalls } = makeFakeCtx(sessionFile);
    await commands.get("herdr-reloc-tab")!.handler("", ctx);
    const warn = notifyCalls.find((n) => /not running inside a Herdr pane/i.test(n.message));
    assert.ok(warn, JSON.stringify(notifyCalls));
    assert.equal(warn.type, "warning");
    assert.equal(notifyCalls.length, 1, "exactly one notification expected");
    assert.ok(!notifyCalls.some((n) => n.type === "error"), "outside-herdr is a warning, not an error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Full handler path with injected relocTransport (no real herdr process)
// ---------------------------------------------------------------------------

test("command: injected relocTransport -> success notification naming the tab; exact argv", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reloc-command-"));
  try {
    const sessionFile = join(dir, "active-session.jsonl");
    writeFileSync(sessionFile, "{}\n");
    const transport = new FakeRelocTransport();
    const { commands } = makeFakePi({
      env: { HERDR_PANE_ID: "wT:p1", PI_CODING_AGENT_DIR: "/tmp/profile" } as NodeJS.ProcessEnv,
      relocTransport: transport,
    });
    const { ctx, notifyCalls } = makeFakeCtx(sessionFile);
    await commands.get("herdr-reloc-tab")!.handler("", ctx);
    // Success notification with the new tab id.
    const info = notifyCalls.find((n) => /session relocated to tab/i.test(n.message));
    assert.ok(info, JSON.stringify(notifyCalls));
    assert.equal(info!.type, "info");
    assert.ok(info!.message.includes(transport.tabId), "success message must name the tab");
    assert.ok(info!.message.includes("original pane closed"), "clean close must say the pane was closed");
    // The transport was called (not the real CLI): pane get -> tab create ->
    // pane run in the root pane -> pane close of the ORIGINAL pane.
    assert.equal(transport.calls.length, 4);
    assert.deepEqual(transport.calls[0].args, ["pane", "get", "wT:p1"]);
    assert.equal(transport.calls[1].args[0], "tab");
    assert.equal(transport.calls[1].args[1], "create");
    assert.equal(transport.calls[2].args[0], "pane");
    assert.equal(transport.calls[2].args[1], "run");
    assert.equal(transport.calls[2].args[2], transport.rootPaneId);
    assert.deepEqual(transport.calls[3].args, ["pane", "close", "wT:p1"], "the ORIGINAL pane must be closed");
    assert.ok(!notifyCalls.some((n) => n.type === "error"), "no error notification expected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("command: injected relocTransport, close not_found -> relocated with stale-pane wording", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reloc-command-"));
  try {
    const sessionFile = join(dir, "active-session.jsonl");
    writeFileSync(sessionFile, "{}\n");
    const transport = new FakeRelocTransport();
    transport.closeMode = "not_found";
    const { commands } = makeFakePi({
      env: { HERDR_PANE_ID: "wT:p1" } as NodeJS.ProcessEnv,
      relocTransport: transport,
    });
    const { ctx, notifyCalls } = makeFakeCtx(sessionFile);
    await commands.get("herdr-reloc-tab")!.handler("", ctx);
    // The reloc still SUCCEEDED (the session is live in the new tab), but the
    // notification must say the close did not cleanly land.
    const info = notifyCalls.find((n) => /session relocated to tab/i.test(n.message));
    assert.ok(info, JSON.stringify(notifyCalls));
    assert.equal(info!.type, "info");
    assert.ok(info!.message.includes(transport.tabId), "success message must name the tab");
    assert.ok(
      /close FAILED \(stale pane remains\)/.test(info!.message),
      `stale-pane wording expected, got: ${info!.message}`,
    );
    assert.equal(transport.calls.length, 4, "all four herdr calls were made");
    assert.ok(!notifyCalls.some((n) => n.type === "error"), "a stale close is NOT an error notification");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("command: injected relocTransport, tab create failure -> error notification with code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reloc-command-"));
  try {
    const sessionFile = join(dir, "active-session.jsonl");
    writeFileSync(sessionFile, "{}\n");
    const transport = new FakeRelocTransport();
    transport.failCommands.push({
      match: /^tab create/,
      code: "tab_failed",
      message: "workspace tab limit",
    });
    const { commands } = makeFakePi({
      env: { HERDR_PANE_ID: "wT:p1" } as NodeJS.ProcessEnv,
      relocTransport: transport,
    });
    const { ctx, notifyCalls } = makeFakeCtx(sessionFile);
    await commands.get("herdr-reloc-tab")!.handler("", ctx);
    const err = notifyCalls.find((n) => n.type === "error");
    assert.ok(err, JSON.stringify(notifyCalls));
    assert.ok(err!.message.includes("tab_failed"), "error must surface the herdr code");
    assert.ok(!notifyCalls.some((n) => /session relocated/i.test(n.message)), "no success notification expected");
    assert.equal(transport.calls.length, 2, "no further herdr call after a failed tab create");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("command: injected relocTransport, run failure -> error notification naming the pane", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reloc-command-"));
  try {
    const sessionFile = join(dir, "active-session.jsonl");
    writeFileSync(sessionFile, "{}\n");
    const transport = new FakeRelocTransport();
    transport.failCommands.push({ match: /^pane run/, code: "run_failed", message: "spawn failed" });
    const { commands } = makeFakePi({
      env: { HERDR_PANE_ID: "wT:p1" } as NodeJS.ProcessEnv,
      relocTransport: transport,
    });
    const { ctx, notifyCalls } = makeFakeCtx(sessionFile);
    await commands.get("herdr-reloc-tab")!.handler("", ctx);
    const err = notifyCalls.find((n) => n.type === "error");
    assert.ok(err, JSON.stringify(notifyCalls));
    assert.ok(err!.message.includes("run_failed"), "error must surface the herdr code");
    assert.ok(!notifyCalls.some((n) => /session relocated/i.test(n.message), "no success notification expected"));
    assert.equal(transport.calls.length, 3, "pane close must NOT follow a failed pane run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
