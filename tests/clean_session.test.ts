// Node:test suite for clean-session.ts (HerdrCleanSessionService) + the
// dedicated pi-cleansession-launcher.sh + the bundled pi-session-to-md
// converter.
//
// Fake transport implements the two Herdr CLI response shapes this feature
// depends on (same as fork.test.ts):
//   pane split -> result.pane.pane_id
//   tab create -> result.{ tab: { tab_id }, root_pane: { pane_id } }
// The launcher asset is exercised for real (bash -n, argument parsing,
// PI_CODING_AGENT_DIR propagation, exec-argv isolation) against a fake
// `pi` binary — no live Herdr, no worker runtime.
//
// Converter regression tests run the REAL bundled script (not a stub):
//   (a) torn trailing JSON line (no newline, and newline-terminated)
//       exits 0 and omits only the torn record
//   (b) malformed middle line still exits non-zero
//   (c) pre-created md file's mode is 0600 after conversion

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
  openSync,
  closeSync,
} from "node:fs";
import { tmpdir, tmpdir as osTmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

import {
  HerdrCleanSessionService,
  defaultCleanSessionLauncherPath,
  defaultCleanSessionConverterPath,
  type CleanSessionResult,
} from "../clean-session.js";
import { shellQuote } from "../core.js";
import type { Transport, TransportResult, TransportOptions } from "../transport.js";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function repoRootPath(...parts: string[]): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", ...parts);
}
const REAL_LAUNCHER = repoRootPath("scripts", "pi-cleansession-launcher.sh");
const REAL_LAUNCHER_SRC = readFileSync(REAL_LAUNCHER, "utf8");
const REAL_CONVERTER = repoRootPath("scripts", "pi-session-to-md");

// The service (clean-session.ts runConverter) spawns the converter with
// PYTHONDONTWRITEBYTECODE=1 so no __pycache__ bytecode is ever written into
// the repo/packaged scripts directory. The direct real-converter invocations
// here mirror that env so the test suite itself cannot recreate the artifact.
const NO_BYTECODE_ENV = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };

// ---------------------------------------------------------------------------
// Fake herdr world (clean-session-relevant subset, mirrors ForkWorld)
// ---------------------------------------------------------------------------

class CleanSessionWorld {
  calls: Array<{ args: string[]; timeoutMs?: number }> = [];
  launcherDir = mkdtempSync(join(tmpdir(), "cleansession-launcher-test-"));
  launcherPath = join(this.launcherDir, "pi-cleansession-launcher.sh");
  converterPath = REAL_CONVERTER;
  splitPaneId = "wC:p9";
  workspaceId = "wC";
  paneId = "wC:p1";
  tabId = "wC:t2";
  rootPaneId = "wC:p9";
  splitDirection?: string;
  splitCwd?: string;
  splitEnv?: Array<string | null> = [];
  tabWorkspace?: string;
  tabCwd?: string;
  tabEnv?: Array<string | null> = [];
  failCommands: Array<{ match: RegExp; code: string; message: string }> = [];
  lastRun?: { pane: string; command: string };

  constructor() {
    writeFileSync(this.launcherPath, REAL_LAUNCHER_SRC, { mode: 0o755 });
  }

  dispose() {
    rmSync(this.launcherDir, { recursive: true, force: true });
  }

  call(args: string[]): string {
    this.calls.push({ args: [...args] });
    return args.join(" ");
  }

  transport(): Transport {
    const world = this;
    return {
      async run(args: string[], options: TransportOptions = {}): Promise<TransportResult> {
        if (options.signal?.aborted) {
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }
        const c = world.call(args);
        for (const fail of world.failCommands) {
          if (fail.match.test(c)) {
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
            result: {
              type: "pane_info",
              pane: { pane_id: a2, workspace_id: "wC" },
            },
          });
        }
        if (a0 === "pane" && a1 === "split") {
          world.splitDirection = args[args.indexOf("--direction") + 1];
          world.splitCwd = args[args.indexOf("--cwd") + 1];
          const envIdx = args.indexOf("--env");
          world.splitEnv = envIdx === -1 ? [null] : [args[envIdx + 1]];
          const focused = args.includes("--focus");
          assert.ok(focused, "clean-session split must request focus");
          return out({
            id: "cli:pane:split",
            result: {
              type: "pane_info",
              pane: { pane_id: world.splitPaneId, workspace_id: "wC", focused },
            },
          });
        }
        if (a0 === "tab" && a1 === "create") {
          world.tabWorkspace = args[args.indexOf("--workspace") + 1];
          world.tabCwd = args[args.indexOf("--cwd") + 1];
          const envIdx = args.indexOf("--env");
          world.tabEnv = envIdx === -1 ? [null] : [args[envIdx + 1]];
          assert.ok(args.includes("--focus"), "tab create must request focus");
          return out({
            id: "cli:tab:create",
            result: { tab: { tab_id: world.tabId }, root_pane: { pane_id: world.rootPaneId } },
          });
        }
        if (a0 === "pane" && a1 === "run") {
          world.lastRun = { pane: a2, command: args[3] };
          return out({ id: "cli:pane:run", result: { type: "ok" } });
        }
        throw new Error(`clean-session world: unhandled herdr command: ${c}`);
      },
    };
  }
}

function makeService(
  world: CleanSessionWorld,
  over: Partial<ConstructorParameters<typeof HerdrCleanSessionService>[0]> = {},
): HerdrCleanSessionService {
  return new HerdrCleanSessionService({
    transport: world.transport(),
    launcherPath: world.launcherPath,
    converterPath: world.converterPath,
    paneId: world.paneId,
    cwd: "/srv/cleansession-project",
    ...over,
  });
}

const SESSION = "/srv/sessions/parent-session.jsonl";

function commandOf(world: CleanSessionWorld): string {
  assert.ok(world.lastRun, "pane run was not recorded");
  return world.lastRun!.command;
}

// A minimal valid session file (session record + one user message) so the
// real converter can process it without error.
function minimalSessionFile(dir: string): string {
  const p = join(dir, "session.jsonl");
  const lines = [
    JSON.stringify({ type: "session", id: "sess-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
    JSON.stringify({ id: "m1", type: "message", parentId: "sess-1", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
    JSON.stringify({ id: "m2", type: "message", parentId: "m1", message: { role: "assistant", content: [{ type: "text", text: "hi there" }] } }),
  ];
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

// ---------------------------------------------------------------------------
// Service tests (fake transport, real converter)
// ---------------------------------------------------------------------------

test("clean-session: right split -> focus, run launcher in returned pane, handoff instruction always non-empty", async () => {
  const world = new CleanSessionWorld();
  try {
    // Use the real converter so the conversion step succeeds.
    const sessionFile = minimalSessionFile(world.launcherDir);
    const svc = makeService(world);
    const r = await svc.cleanSession({ sessionFile, placement: "right" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.outcome, "clean_session");
    assert.equal(r.pane, world.splitPaneId);
    assert.equal(r.placement, "right");
    // pane split on the PARENT pane, with focus, in the calling cwd.
    assert.deepEqual(world.calls[0].args, [
      "pane", "split", "wC:p1", "--direction", "right", "--cwd", "/srv/cleansession-project", "--focus",
    ]);
    assert.deepEqual(world.splitEnv, [null]);
    assert.equal(world.lastRun!.pane, world.splitPaneId);
    // The instruction is always non-empty: the handoff preamble is present
    // even without a user instruction. The command is `launcher -- <instruction>`.
    const cmd = commandOf(world);
    assert.ok(cmd.includes(shellQuote(world.launcherPath)), "launcher path must be in the command");
    assert.ok(cmd.includes("--"), "the -- marker must be present");
    // The instruction is a single trailing single-quoted token.
    const afterDash = cmd.split("-- ")[1] ?? "";
    assert.ok(afterDash.length > 0, "instruction must be non-empty");
    assert.ok(afterDash.startsWith("'"), "instruction must be single-quoted");
    // The handoff preamble names the md path.
    assert.ok(/pi-cleansession-.*\.md/.test(cmd), "handoff instruction must name the md path");
  } finally {
    world.dispose();
  }
});

test("clean-session: down split with user instruction -> instruction appended after the preamble", async () => {
  const world = new CleanSessionWorld();
  try {
    const sessionFile = minimalSessionFile(world.launcherDir);
    const svc = makeService(world);
    const userInstruction = "investigate the failing test; don't panic";
    const r = await svc.cleanSession({ sessionFile, placement: "down", instruction: userInstruction });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.placement, "down");
    const cmd = commandOf(world);
    const afterDash = cmd.split("-- ")[1] ?? "";
    // The instruction must contain both the preamble and the user instruction.
    assert.ok(afterDash.includes("Handoff from a prior Pi session"), "preamble must be present");
    assert.ok(afterDash.includes("investigate the failing test"), "user instruction must be present");
  } finally {
    world.dispose();
  }
});

test("clean-session: shell metacharacters in the user instruction never become separate argv entries", async () => {
  const world = new CleanSessionWorld();
  try {
    const sessionFile = minimalSessionFile(world.launcherDir);
    const svc = makeService(world);
    const malicious = "rm -rf /; $(touch /pwned) `id` && echo done";
    const r = await svc.cleanSession({ sessionFile, placement: "right", instruction: malicious });
    assert.equal(r.ok, true, JSON.stringify(r));
    const cmd = commandOf(world);
    // One single-quoted argv token after `--` — the whole handoff instruction.
    const quoted = /--\s+'[^']*'$/.exec(cmd);
    assert.ok(quoted, "instruction must be a single trailing single-quoted token");
  } finally {
    world.dispose();
  }
});

test("clean-session: multi-line user instruction travels as one quoted argv entry", async () => {
  const world = new CleanSessionWorld();
  try {
    const sessionFile = minimalSessionFile(world.launcherDir);
    const svc = makeService(world);
    const multiLine = "line one\nline two\nline three";
    const r = await svc.cleanSession({ sessionFile, placement: "right", instruction: multiLine });
    assert.equal(r.ok, true, JSON.stringify(r));
    const cmd = commandOf(world);
    // The whole instruction (preamble + multi-line user instruction) must be
    // a single trailing single-quoted token.
    const quoted = /--\s+'[^']*'$/.exec(cmd);
    assert.ok(quoted, "multi-line instruction must be a single trailing single-quoted token");
    assert.ok(quoted![0].includes("line one"), "first line of multi-line instruction must be present");
    assert.ok(quoted![0].includes("line three"), "last line of multi-line instruction must be present");
  } finally {
    world.dispose();
  }
});

test("clean-session: PI_CODING_AGENT_DIR present -> split carries exactly --env PI_CODING_AGENT_DIR=<value>", async () => {
  const world = new CleanSessionWorld();
  try {
    const sessionFile = minimalSessionFile(world.launcherDir);
    const PROFILE_DIR = "/Users/cgint/.pi/profiles/minimal/agent";
    const svc = makeService(world, { env: { PI_CODING_AGENT_DIR: PROFILE_DIR, HERDR_PANE_ID: world.paneId } });
    const r = await svc.cleanSession({ sessionFile, placement: "down" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(world.splitEnv, [`PI_CODING_AGENT_DIR=${PROFILE_DIR}`]);
    assert.deepEqual(world.calls[0].args, [
      "pane", "split", world.paneId, "--direction", "down", "--cwd", "/srv/cleansession-project",
      "--env", `PI_CODING_AGENT_DIR=${PROFILE_DIR}`, "--focus",
    ]);
  } finally {
    world.dispose();
  }
});

test("clean-session: PI_CODING_AGENT_DIR present -> tab create carries exactly one --env pair", async () => {
  const world = new CleanSessionWorld();
  try {
    const sessionFile = minimalSessionFile(world.launcherDir);
    const PROFILE_DIR = "/Users/cgint/.pi/profiles/minimal/agent";
    const svc = makeService(world, { env: { PI_CODING_AGENT_DIR: PROFILE_DIR } });
    const r = await svc.cleanSession({ sessionFile, placement: "tab", instruction: "go" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(world.tabEnv, [`PI_CODING_AGENT_DIR=${PROFILE_DIR}`]);
    assert.deepEqual(world.calls[1].args, [
      "tab", "create", "--workspace", "wC", "--cwd", "/srv/cleansession-project",
      "--env", `PI_CODING_AGENT_DIR=${PROFILE_DIR}`, "--focus",
    ]);
  } finally {
    world.dispose();
  }
});

test("clean-session: absent or empty PI_CODING_AGENT_DIR -> no --env, no default substituted", async () => {
  for (const env of [undefined, {}, { PI_CODING_AGENT_DIR: "" }, { PI_CODING_AGENT_DIR: "   " }]) {
    const world = new CleanSessionWorld();
    try {
      const sessionFile = minimalSessionFile(world.launcherDir);
      const svc = makeService(world, { env });
      await svc.cleanSession({ sessionFile, placement: "right" });
      assert.equal(world.calls[0].args.includes("--env"), false, `no --env expected for env=${JSON.stringify(env)}`);
    } finally {
      world.dispose();
    }
  }
});

test("clean-session: tab placement -> workspace resolve, tab create, run in root pane", async () => {
  const world = new CleanSessionWorld();
  try {
    const sessionFile = minimalSessionFile(world.launcherDir);
    const svc = makeService(world);
    const r = await svc.cleanSession({ sessionFile, placement: "tab", instruction: "take the tab" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.outcome, "clean_session");
    assert.equal(r.pane, world.rootPaneId);
    assert.equal(r.tab, world.tabId);
    assert.equal(r.placement, "tab");
    // Step 1: resolve the parent's workspace from HERDR_PANE_ID.
    assert.deepEqual(world.calls[0].args, ["pane", "get", "wC:p1"]);
    // Step 2: create the tab in that workspace, with focus.
    assert.deepEqual(world.calls[1].args, [
      "tab", "create", "--workspace", "wC", "--cwd", "/srv/cleansession-project", "--focus",
    ]);
    assert.deepEqual(world.tabEnv, [null]);
    assert.equal(world.lastRun!.pane, world.rootPaneId);
    const cmd = commandOf(world);
    assert.ok(cmd.includes("--"), "the -- marker must be present");
  } finally {
    world.dispose();
  }
});

// ---------------------------------------------------------------------------
// Failure / context handling
// ---------------------------------------------------------------------------

test("clean-session: outside Herdr (no HERDR_PANE_ID) -> outside_herdr, zero herdr calls, no md file", async () => {
  const world = new CleanSessionWorld();
  try {
    const sessionFile = minimalSessionFile(world.launcherDir);
    const svc = makeService(world, { paneId: undefined });
    const r = await svc.cleanSession({ sessionFile, placement: "right" });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "outside_herdr");
    assert.equal(world.calls.length, 0, "no herdr command may be issued outside Herdr");
  } finally {
    world.dispose();
  }
});

test("clean-session: missing launcher -> launcher_missing, zero herdr calls", async () => {
  const world = new CleanSessionWorld();
  try {
    const sessionFile = minimalSessionFile(world.launcherDir);
    const svc = makeService(world, { launcherPath: join(world.launcherDir, "absent.sh") });
    const r = await svc.cleanSession({ sessionFile, placement: "right" });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "launcher_missing");
    assert.equal(world.calls.length, 0);
  } finally {
    world.dispose();
  }
});

test("clean-session: conversion failure (missing converter) -> conversion_failed, zero herdr calls, partial file deleted", async () => {
  const world = new CleanSessionWorld();
  try {
    const sessionFile = minimalSessionFile(world.launcherDir);
    const svc = makeService(world, {
      converterPath: join(world.launcherDir, "absent-converter"),
    });
    // Snapshot the set of pi-cleansession-*.md files before the call.
    const before = new Set(readdirSync(osTmpdir()).filter((f) => f.startsWith("pi-cleansession-") && f.endsWith(".md")));
    const r = await svc.cleanSession({ sessionFile, placement: "right" });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "conversion_failed");
    assert.equal(r.phase, "conversion");
    assert.equal(world.calls.length, 0, "no herdr call on conversion failure");
    // The partial md file must have been deleted (requirements §4):
    // no new pi-cleansession-*.md file may remain after the failed call.
    const after = readdirSync(osTmpdir()).filter((f) => f.startsWith("pi-cleansession-") && f.endsWith(".md"));
    const newFiles = after.filter((f) => !before.has(f));
    assert.equal(newFiles.length, 0, `no new pi-cleansession-*.md file may remain after conversion failure: ${newFiles.join(", ")}`);
  } finally {
    world.dispose();
  }
});

test("clean-session: conversion failure (converter non-zero exit) -> conversion_failed, partial file deleted", async () => {
  const world = new CleanSessionWorld();
  try {
    const sessionFile = minimalSessionFile(world.launcherDir);
    // A stub converter that exits 1 without writing anything.
    const stubConverter = join(world.launcherDir, "stub-converter");
    writeFileSync(stubConverter, "#!/usr/bin/env python3\nimport sys\nsys.exit(1)\n", { mode: 0o755 });
    const svc = makeService(world, { converterPath: stubConverter });
    // Snapshot the set of pi-cleansession-*.md files before the call.
    const before = new Set(readdirSync(osTmpdir()).filter((f) => f.startsWith("pi-cleansession-") && f.endsWith(".md")));
    const r = await svc.cleanSession({ sessionFile, placement: "right" });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "conversion_failed");
    assert.equal(r.phase, "conversion");
    assert.equal(world.calls.length, 0, "no herdr call on conversion failure");
    // The partial md file must have been deleted (requirements §4):
    // no new pi-cleansession-*.md file may remain after the failed call.
    const after = readdirSync(osTmpdir()).filter((f) => f.startsWith("pi-cleansession-") && f.endsWith(".md"));
    const newFiles = after.filter((f) => !before.has(f));
    assert.equal(newFiles.length, 0, `no new pi-cleansession-*.md file may remain after conversion failure: ${newFiles.join(", ")}`);
  } finally {
    world.dispose();
  }
});

test("clean-session: pane split failure -> error, no pane run", async () => {
  const world = new CleanSessionWorld();
  try {
    const sessionFile = minimalSessionFile(world.launcherDir);
    world.failCommands.push({
      match: /^pane split/,
      code: "pane_layout_failed",
      message: "maximum panes reached",
    });
    const svc = makeService(world);
    const r = await svc.cleanSession({ sessionFile, placement: "right" });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "error");
    assert.equal(r.phase, "split");
    assert.equal(r.code, "pane_layout_failed");
    assert.equal(world.lastRun, undefined, "pane run must not follow a failed split");
  } finally {
    world.dispose();
  }
});

test("clean-session: tab create failure -> error, no pane run", async () => {
  const world = new CleanSessionWorld();
  try {
    const sessionFile = minimalSessionFile(world.launcherDir);
    world.failCommands.push({
      match: /^tab create/,
      code: "tab_failed",
      message: "workspace tab limit",
    });
    const svc = makeService(world);
    const r = await svc.cleanSession({ sessionFile, placement: "tab" });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "error");
    assert.equal(r.phase, "tab_create");
    assert.equal(r.code, "tab_failed");
    assert.equal(world.lastRun, undefined);
  } finally {
    world.dispose();
  }
});

test("clean-session: pane run failure -> error carrying the created pane", async () => {
  const world = new CleanSessionWorld();
  try {
    const sessionFile = minimalSessionFile(world.launcherDir);
    world.failCommands.push({ match: /^pane run/, code: "run_failed", message: "spawn failed" });
    const svc = makeService(world);
    const r = await svc.cleanSession({ sessionFile, placement: "right" });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "error");
    assert.equal(r.phase, "launch");
    assert.equal(r.pane, world.splitPaneId);
    assert.equal(r.code, "run_failed");
  } finally {
    world.dispose();
  }
});

test("clean-session: abort before any action -> aborted result, zero herdr calls", async () => {
  const world = new CleanSessionWorld();
  try {
    const sessionFile = minimalSessionFile(world.launcherDir);
    const ac = new AbortController();
    ac.abort();
    const svc = makeService(world);
    const r = await svc.cleanSession({ sessionFile, placement: "right" }, ac.signal);
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "aborted");
    assert.equal(world.calls.length, 0);
  } finally {
    world.dispose();
  }
});

test("clean-session: split response without pane_id -> malformed error", async () => {
  const world = new CleanSessionWorld();
  try {
    const sessionFile = minimalSessionFile(world.launcherDir);
    const transport: Transport = {
      async run(args: string[]): Promise<TransportResult> {
        const [a0, a1] = args;
        if (a0 === "pane" && a1 === "split") {
          return { exitCode: 0, stdout: JSON.stringify({ result: { type: "pane_info" } }), stderr: "" };
        }
        throw new Error("unexpected");
      },
    };
    const svc = new HerdrCleanSessionService({
      transport,
      launcherPath: world.launcherPath,
      converterPath: REAL_CONVERTER,
      paneId: "wC:p1",
      cwd: "/tmp",
    });
    const r = await svc.cleanSession({ sessionFile, placement: "right" });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "error");
    assert.equal(r.phase, "split");
    assert.equal(r.code, "split_malformed");
  } finally {
    world.dispose();
  }
});

// ---------------------------------------------------------------------------
// Launcher asset (bash, executed for real against a fake `pi`)
// ---------------------------------------------------------------------------

function fakePiDir(dir: string): string {
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", "pi"), `#!/usr/bin/env bash
printf 'pi\n' >> "$RECORD"
printf '%s\\n' "\${@}" >> "$RECORD"
printf 'PI_CODING_AGENT_DIR=%s\\n' "\${PI_CODING_AGENT_DIR:-}" >> "\${RECORD}.env"
printf 'pi (fake)\\n'
`, { mode: 0o755 });
  return join(dir, "bin");
}

function runCleanSessionLauncher(
  dir: string,
  argv: string[],
  env: Record<string, string>,
  recordTo: string,
  launcherPath = join(dir, "pi-cleansession-launcher.sh"),
): { status: number | null; stderr: string; recorded: string[] } {
  const res = spawnSync("bash", [launcherPath, ...argv], {
    env: { PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`, ...env, RECORD: recordTo },
    encoding: "utf8",
  });
  const recorded = existsSync(recordTo)
    ? readFileSync(recordTo, "utf8").trim().split("\n").filter(Boolean)
    : [];
  return { status: res.status, stderr: res.stderr ?? "", recorded };
}

test("launcher: syntax is valid bash", () => {
  const r = execFileSync("bash", ["-n", REAL_LAUNCHER], { encoding: "utf8" });
  assert.equal(r, "");
});

test("launcher: no worker-runtime coupling in the asset", () => {
  const src = REAL_LAUNCHER_SRC;
  assert.ok(!/pi-worker-runtime|herdr-worker|sub_agent_conf/.test(src), "launcher must not reference worker runtime");
  assert.ok(!/append-system-prompt|readonly|editable/.test(src), "launcher must not carry worker mode logic");
  // The clean-session launcher must NOT pass --fork or --session to pi.
  // Check only the actual exec line (not comments): match `exec pi` followed
  // by flags on the same line.
  const execMatch = /exec pi(\s+\S+)+/.exec(src);
  assert.ok(execMatch, "launcher must contain an exec pi line");
  const execLine = execMatch![0];
  assert.ok(!/--fork/.test(execLine), `launcher must not pass --fork to pi (exec line: ${execLine})`);
  assert.ok(!/--session/.test(execLine), `launcher must not pass --session to pi (exec line: ${execLine})`);
});

test("launcher: parses -- and passes the instruction as one argv entry to pi", () => {
  const dir = mkdtempSync(join(tmpdir(), "cleansession-launcher-"));
  try {
    writeFileSync(join(dir, "pi-cleansession-launcher.sh"), REAL_LAUNCHER_SRC, { mode: 0o755 });
    fakePiDir(dir);
    const record = join(dir, "argv.txt");
    // A single-line handoff instruction (the real instruction has newlines,
    // which herdr pane run shell-quotes separately; the launcher receives
    // each line as a separate argv word and joins them with a space).
    const instruction = "Handoff: read the exported transcript at /tmp/pi-cleansession-abc.md and continue the prior work from there";
    const res = runCleanSessionLauncher(
      dir,
      ["--", instruction, "extra word"],
      {},
      record,
    );
    assert.equal(res.status, 0, res.stderr);
    // fake pi records its argv: <pi> <instruction-joined>
    // The launcher joins all words after -- into a single instruction string.
    assert.deepEqual(res.recorded, [
      "pi",
      `Handoff: read the exported transcript at /tmp/pi-cleansession-abc.md and continue the prior work from there extra word`,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("launcher: propagates the parent PI_CODING_AGENT_DIR verbatim", () => {
  const dir = mkdtempSync(join(tmpdir(), "cleansession-launcher-"));
  try {
    writeFileSync(join(dir, "pi-cleansession-launcher.sh"), REAL_LAUNCHER_SRC, { mode: 0o755 });
    fakePiDir(dir);
    const record = join(dir, "env.txt");
    const instruction = "Handoff from a prior Pi session.";
    const res = spawnSync("bash", [join(dir, "pi-cleansession-launcher.sh"), "--", instruction], {
      env: {
        PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
        RECORD: record,
        PI_CODING_AGENT_DIR: "/Users/cgint/.pi/profiles/minimal/agent",
      },
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    const envRecord = `${record}.env`;
    const recorded = existsSync(envRecord) ? readFileSync(envRecord, "utf8") : "";
    assert.ok(
      recorded.includes("PI_CODING_AGENT_DIR=/Users/cgint/.pi/profiles/minimal/agent"),
      `expected PI_CODING_AGENT_DIR propagation, got:\n${recorded}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("launcher: usage errors exit 2 without exec'ing pi", () => {
  const dir = mkdtempSync(join(tmpdir(), "cleansession-launcher-"));
  try {
    writeFileSync(join(dir, "pi-cleansession-launcher.sh"), REAL_LAUNCHER_SRC, { mode: 0o755 });
    fakePiDir(dir);
    const record = join(dir, "argv.txt");
    for (const argv of [
      [],
      ["--bogus"],
      // -- with no instruction after it = empty instruction = usage error
      ["--"],
    ]) {
      const res = runCleanSessionLauncher(dir, argv, {}, record);
      assert.equal(res.status, 2, `argv=${JSON.stringify(argv)}: ${res.stderr}`);
      assert.ok(res.stderr.startsWith("pi-cleansession-launcher: "), "usage errors must identify the launcher");
    }
    assert.ok(!existsSync(record), "pi must never have been executed on usage errors");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultCleanSessionLauncherPath: resolves to scripts/pi-cleansession-launcher.sh", () => {
  const expected = join(
    dirname(fileURLToPath(new URL("../clean-session.js", import.meta.url))),
    "scripts",
    "pi-cleansession-launcher.sh",
  );
  assert.equal(defaultCleanSessionLauncherPath(), expected);
  assert.ok(existsSync(REAL_LAUNCHER), "package launcher asset must exist at scripts/pi-cleansession-launcher.sh");
  assert.ok(statSync(REAL_LAUNCHER).mode & 0o111, "package launcher asset must be executable");
});

test("defaultCleanSessionConverterPath: resolves to scripts/pi-session-to-md", () => {
  const expected = join(
    dirname(fileURLToPath(new URL("../clean-session.js", import.meta.url))),
    "scripts",
    "pi-session-to-md",
  );
  assert.equal(defaultCleanSessionConverterPath(), expected);
  assert.ok(existsSync(REAL_CONVERTER), "package converter asset must exist at scripts/pi-session-to-md");
  assert.ok(statSync(REAL_CONVERTER).mode & 0o111, "package converter asset must be executable");
});

test("packaging: clean-session source, launcher and converter are declared package files", () => {
  const pkgPath = new URL("../../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { files?: string[] };
  for (const entry of ["index.ts", "core.ts", "transport.ts", "fork.ts", "fork-parser.ts", "clean-session.ts", "scripts"]) {
    assert.ok(pkg.files?.includes(entry), `package.json files must include ${entry}`);
  }
  assert.ok(existsSync(REAL_LAUNCHER), "scripts/pi-cleansession-launcher.sh must exist in the repo");
  assert.ok(existsSync(REAL_CONVERTER), "scripts/pi-session-to-md must exist in the repo");
  const statL = statSync(REAL_LAUNCHER);
  const statC = statSync(REAL_CONVERTER);
  assert.ok(statL.mode & 0o111, "launcher must be executable");
  assert.ok(statC.mode & 0o111, "converter must be executable");
});

// ---------------------------------------------------------------------------
// Converter regression tests (REAL bundled script, not a stub)
// ---------------------------------------------------------------------------

function writeSessionFile(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

test("converter: torn trailing line (no trailing newline) exits 0 and omits only the torn record", () => {
  const dir = mkdtempSync(join(tmpdir(), "cleansession-conv-"));
  try {
    // Valid lines 1-2, then a torn line 3 (no trailing newline).
    const sessionFile = writeSessionFile(dir, "torn.jsonl",
      JSON.stringify({ type: "session", id: "s1", timestamp: "2026-01-01T00:00:00.000Z" }) + "\n" +
      JSON.stringify({ id: "m1", type: "message", parentId: "s1", message: { role: "user", content: [{ type: "text", text: "hello" }] } }) + "\n" +
      '{"id":"m2","type":"message","parentId":"m1","message":{"role":"assistant","content":[{"type":"text","text":"par' // torn, no newline
    );
    const mdFile = join(dir, "out.md");
    // Pre-create with 0600 (as the extension does) so the mode is preserved.
    openSync(mdFile, "w", 0o600);
    closeSync(openSync(mdFile, "r"));
    const res = spawnSync("python3", [REAL_CONVERTER, "--mode", "branch", sessionFile, "-o", mdFile], {
      encoding: "utf8",
      umask: 0o077,
      env: NO_BYTECODE_ENV,
    } as unknown as Parameters<typeof spawnSync>[2]);
    assert.equal(res.status, 0, `torn trailing line (no newline) must exit 0: stderr=${res.stderr}`);
    assert.ok(res.stderr.includes("torn trailing line"), "stderr warning about torn trailing line expected");
    assert.ok(existsSync(mdFile), "md file must be created");
    const md = readFileSync(mdFile, "utf8");
    // The torn record (assistant "par...") must NOT appear.
    assert.ok(!md.includes("par..."), "torn record content must be omitted");
    // The valid user message must be present.
    assert.ok(md.includes("hello"), "valid user message must be present");
    // The pre-created md file's mode must be 0600 (preserved by the converter's open("w")).
    const mode = statSync(mdFile).mode & 0o777;
    assert.equal(mode, 0o600, `md file mode must be 0600, got ${mode.toString(8)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("converter: torn trailing line (with trailing newline) exits 0 and omits only the torn record", () => {
  const dir = mkdtempSync(join(tmpdir(), "cleansession-conv-"));
  try {
    // Valid lines 1-2, then a torn line 3 WITH a trailing newline.
    const sessionFile = writeSessionFile(dir, "torn-nl.jsonl",
      JSON.stringify({ type: "session", id: "s1", timestamp: "2026-01-01T00:00:00.000Z" }) + "\n" +
      JSON.stringify({ id: "m1", type: "message", parentId: "s1", message: { role: "user", content: [{ type: "text", text: "hello" }] } }) + "\n" +
      '{"id":"m2","type":"message","parentId":"m1","message":{"role":"assistant","content":[{"type":"text","text":"par' + "\n" // torn, WITH newline
    );
    const mdFile = join(dir, "out.md");
    // Pre-create with 0600 (as the extension does) so the mode is preserved.
    openSync(mdFile, "w", 0o600);
    closeSync(openSync(mdFile, "r"));
    const res = spawnSync("python3", [REAL_CONVERTER, "--mode", "branch", sessionFile, "-o", mdFile], {
      encoding: "utf8",
      umask: 0o077,
      env: NO_BYTECODE_ENV,
    } as unknown as Parameters<typeof spawnSync>[2]);
    assert.equal(res.status, 0, `torn trailing line (with newline) must exit 0: stderr=${res.stderr}`);
    assert.ok(res.stderr.includes("torn trailing line"), "stderr warning about torn trailing line expected");
    assert.ok(existsSync(mdFile), "md file must be created");
    const md = readFileSync(mdFile, "utf8");
    assert.ok(!md.includes("par..."), "torn record content must be omitted");
    assert.ok(md.includes("hello"), "valid user message must be present");
    const mode = statSync(mdFile).mode & 0o777;
    assert.equal(mode, 0o600, `md file mode must be 0600, got ${mode.toString(8)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("converter: malformed middle line (not the last) still exits non-zero", () => {
  const dir = mkdtempSync(join(tmpdir(), "cleansession-conv-"));
  try {
    // Line 1 valid, line 2 malformed (middle), line 3 valid.
    const sessionFile = writeSessionFile(dir, "middle-bad.jsonl",
      JSON.stringify({ type: "session", id: "s1", timestamp: "2026-01-01T00:00:00.000Z" }) + "\n" +
      '{"broken": not valid json' + "\n" +
      JSON.stringify({ id: "m1", type: "message", parentId: "s1", message: { role: "user", content: [{ type: "text", text: "hello" }] } }) + "\n"
    );
    const mdFile = join(dir, "out.md");
    const res = spawnSync("python3", [REAL_CONVERTER, "--mode", "branch", sessionFile, "-o", mdFile], {
      encoding: "utf8",
      env: NO_BYTECODE_ENV,
    });
    assert.notEqual(res.status, 0, "malformed middle line must exit non-zero");
    assert.ok(res.stderr.includes("Invalid JSON"), "stderr must mention Invalid JSON");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("converter: valid session file converts cleanly (no pre-creation: default mode)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cleansession-conv-"));
  try {
    const sessionFile = minimalSessionFile(dir);
    const mdFile = join(dir, "out.md");
    const res = spawnSync("python3", [REAL_CONVERTER, "--mode", "branch", sessionFile, "-o", mdFile], {
      encoding: "utf8",
      env: NO_BYTECODE_ENV,
    });
    assert.equal(res.status, 0, `valid session must exit 0: stderr=${res.stderr}`);
    assert.ok(existsSync(mdFile), "md file must be created");
    const md = readFileSync(mdFile, "utf8");
    assert.ok(md.includes("hello"), "user message must be in the export");
    assert.ok(md.includes("hi there"), "assistant message must be in the export");
    // No-bytecode regression: the converter ran against the packaged script
    // with PYTHONDONTWRITEBYTECODE=1, so no __pycache__ may appear in the
    // repo's scripts directory (it would otherwise ship in the npm package
    // and reappear on every production conversion).
    assert.ok(!existsSync(repoRootPath("scripts", "__pycache__")), "no __pycache__ may be written into scripts/ by the converter run");
    // Without pre-creation, the converter's open("w") creates the file at the
    // default mode (0644 & ~umask). This test documents that the converter
    // itself does NOT set 0600 — the extension's pre-creation does (see the
    // pre-created 0600 test below).
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("converter: pre-created 0600 file preserves its mode after conversion", () => {
  const dir = mkdtempSync(join(tmpdir(), "cleansession-conv-"));
  try {
    const sessionFile = minimalSessionFile(dir);
    const mdFile = join(dir, "precreated.md");
    // Pre-create with 0600, as the extension does.
    const fd = openSync(mdFile, "w", 0o600);
    closeSync(fd);
    assert.equal(statSync(mdFile).mode & 0o777, 0o600, "pre-created file must be 0600");
    const res = spawnSync("python3", [REAL_CONVERTER, "--mode", "branch", sessionFile, "-o", mdFile], {
      encoding: "utf8",
      umask: 0o077,
      env: NO_BYTECODE_ENV,
    } as unknown as Parameters<typeof spawnSync>[2]);
    assert.equal(res.status, 0, `conversion of pre-created file must exit 0: stderr=${res.stderr}`);
    const mode = statSync(mdFile).mode & 0o777;
    assert.equal(mode, 0o600, `md file mode must remain 0600 after conversion, got ${mode.toString(8)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
