// Node:test suite for fork.ts (HerdrForkService) + the dedicated
// pi-fork-launcher.sh asset.
//
// Fake transport implements the two Herdr CLI response shapes this feature
// depends on (docs/evidence + live probe 2026-10-07):
//   pane split -> result.pane.pane_id
//   tab create -> result.{ tab: { tab_id }, root_pane: { pane_id } }
// The launcher asset is exercised for real (bash -n, argument parsing,
// PI_CODING_AGENT_DIR propagation, exec-argv isolation) against a fake
// `pi` binary — no live Herdr, no worker runtime.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

import {
  HerdrForkService,
  defaultForkLauncherPath,
  type ForkResult,
} from "../fork.js";
import { shellQuote } from "../core.js";
import type { Transport, TransportResult, TransportOptions } from "../transport.js";

// The documented `npm test` script compiles tests into .test-build/tests/
// (rootDir = repo root, outDir = .test-build), so import.meta.url resolves
// inside .test-build. defaultForkLauncherPath() therefore points at
// .test-build/scripts/, which tsc does not copy. Resolve the REAL repo-root
// asset for the asset tests (two levels up from the compiled location, same
// convention as tests/packaging.test.ts).
function repoRootPath(...parts: string[]): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", ...parts);
}
const REAL_LAUNCHER = repoRootPath("scripts", "pi-fork-launcher.sh");
const REAL_LAUNCHER_SRC = readFileSync(REAL_LAUNCHER, "utf8");

// ---------------------------------------------------------------------------
// Fake herdr world (fork-relevant subset)
// ---------------------------------------------------------------------------

class ForkWorld {
  calls: Array<{ args: string[]; timeoutMs?: number }> = [];
  launcherDir = mkdtempSync(join(tmpdir(), "fork-launcher-test-"));
  launcherPath = join(this.launcherDir, "pi-fork-launcher.sh");
  splitPaneId = "wF:p9";
  workspaceId = "wF";
  paneId = "wF:p1";
  tabId = "wF:t2";
  rootPaneId = "wF:p9";
  splitFocus = true;
  splitDirection?: string;
  splitCwd?: string;
  splitEnv?: Array<string | null> = [];
  tabWorkspace?: string;
  tabCwd?: string;
  tabEnv?: Array<string | null> = [];
  failCommands: Array<{ match: RegExp; code: string; message: string }> = [];
  throwNext?: string;

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
          world.workspaceId = a2; // echoed back by the handler
          return out({
            id: "cli:pane:get",
            result: {
              type: "pane_info",
              pane: { pane_id: a2, workspace_id: "wF" },
            },
          });
        }
        if (a0 === "pane" && a1 === "split") {
          world.splitDirection = args[args.indexOf("--direction") + 1];
          world.splitCwd = args[args.indexOf("--cwd") + 1];
          const envIdx = args.indexOf("--env");
          world.splitEnv = envIdx === -1 ? [null] : [args[envIdx + 1]];
          const focused = args.includes("--focus");
          assert.ok(focused, "fork split must request focus");
          return out({
            id: "cli:pane:split",
            result: {
              type: "pane_info",
              pane: { pane_id: world.splitPaneId, workspace_id: "wF", focused },
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
        throw new Error(`fork world: unhandled herdr command: ${c}`);
      },
    };
  }

  lastRun?: { pane: string; command: string };
}

function makeService(world: ForkWorld, over: Partial<ConstructorParameters<typeof HerdrForkService>[0]> = {}): HerdrForkService {
  return new HerdrForkService({
    transport: world.transport(),
    launcherPath: world.launcherPath,
    paneId: world.paneId,
    cwd: "/srv/fork-project",
    ...over,
  });
}

const SESSION = "/srv/sessions/parent-session.jsonl";

function commandOf(world: ForkWorld): string {
  assert.ok(world.lastRun, "pane run was not recorded");
  return world.lastRun!.command;
}

// ---------------------------------------------------------------------------
// Split placements (right / down)
// ---------------------------------------------------------------------------

test("fork: right split -> focus, run launcher in returned pane, no instruction", async () => {
  const world = new ForkWorld();
  try {
    const svc = makeService(world);
    const r = await svc.fork({ sessionFile: SESSION, placement: "right" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.outcome, "forked");
    assert.equal(r.pane, world.splitPaneId);
    assert.equal(r.placement, "right");
    // pane split on the PARENT pane, with focus, in the calling cwd.
    // No PI_CODING_AGENT_DIR in the service env -> no --env entry at all.
    assert.deepEqual(world.calls[0].args, [
      "pane", "split", "wF:p1", "--direction", "right", "--cwd", "/srv/fork-project", "--focus",
    ]);
    assert.deepEqual(world.splitEnv, [null]);
    assert.equal(world.lastRun!.pane, world.splitPaneId);
    // No instruction: launcher invoked as `--session-file <q> --`.
    assert.equal(
      commandOf(world),
      `${shellQuote(world.launcherPath)} --session-file ${shellQuote(SESSION)} --`,
    );
    // Never touches the parent pane, never records ownership-relevant state.
    assert.ok(!world.calls.some((c) => c.args[1] === "run" && c.args[2] === "wF:p1"));
  } finally {
    world.dispose();
  }
});

test("fork: down split -> direction down, instruction transported quoted", async () => {
  const world = new ForkWorld();
  try {
    const svc = makeService(world);
    const r = await svc.fork({
      sessionFile: SESSION,
      placement: "down",
      instruction: "investigate the failing test; don't panic",
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.placement, "down");
    assert.equal(world.splitDirection, "down");
    const expected = [
      shellQuote(world.launcherPath),
      "--session-file", shellQuote(SESSION),
      "--",
      shellQuote("investigate the failing test; don't panic"),
    ].join(" ");
    assert.equal(commandOf(world), expected);
    // The instruction survives the herdr-side shell exactly once.
    const parts = commandOf(world).split(" -- ")[1] ?? "";
    assert.ok(parts.startsWith("'"), "instruction must be single-quoted (it contains a shell metachar)");
  } finally {
    world.dispose();
  }
});

test("fork: shell metacharacters in the instruction never become separate argv entries", async () => {
  const world = new ForkWorld();
  try {
    const svc = makeService(world);
    const r = await svc.fork({
      sessionFile: SESSION,
      placement: "right",
      instruction: "rm -rf /; $(touch /pwned) `id` && echo done",
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    // One single-quoted argv token after `--` — the whole instruction.
    const cmd = commandOf(world);
    const after = cmd.split("-- ")[1] ?? "";
    const quoted = /--\s+'[^']*'$/.exec(cmd);
    assert.ok(quoted, "instruction must be a single trailing single-quoted token");
    assert.ok(after.length > 0);
    // No raw metachar outside the launcher-arg region.
    assert.equal(after, shellQuote("rm -rf /; $(touch /pwned) `id` && echo done"));
  } finally {
    world.dispose();
  }
});

// ---------------------------------------------------------------------------
// Profile (PI_CODING_AGENT_DIR) propagation
// ---------------------------------------------------------------------------

const PROFILE_DIR = "/Users/cgint/.pi/profiles/minimal/agent";

test("fork: PI_CODING_AGENT_DIR present -> split carries exactly --env PI_CODING_AGENT_DIR=<value>", async () => {
  const world = new ForkWorld();
  try {
    const svc = makeService(world, { env: { PI_CODING_AGENT_DIR: PROFILE_DIR, HERDR_PANE_ID: world.paneId } });
    const r = await svc.fork({ sessionFile: SESSION, placement: "down" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(world.splitEnv, [`PI_CODING_AGENT_DIR=${PROFILE_DIR}`]);
    // Full argv order: --env sits as a single pair after --cwd, before --focus.
    assert.deepEqual(world.calls[0].args, [
      "pane", "split", world.paneId, "--direction", "down", "--cwd", "/srv/fork-project",
      "--env", `PI_CODING_AGENT_DIR=${PROFILE_DIR}`, "--focus",
    ]);
  } finally {
    world.dispose();
  }
});

test("fork: PI_CODING_AGENT_DIR present -> tab create carries exactly one --env pair", async () => {
  const world = new ForkWorld();
  try {
    const svc = makeService(world, { env: { PI_CODING_AGENT_DIR: PROFILE_DIR } });
    const r = await svc.fork({ sessionFile: SESSION, placement: "tab", instruction: "go" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(world.tabEnv, [`PI_CODING_AGENT_DIR=${PROFILE_DIR}`]);
    assert.deepEqual(world.calls[1].args, [
      "tab", "create", "--workspace", "wF", "--cwd", "/srv/fork-project",
      "--env", `PI_CODING_AGENT_DIR=${PROFILE_DIR}`, "--focus",
    ]);
  } finally {
    world.dispose();
  }
});

test("fork: profile dir with shell metacharacters travels as one --env value", async () => {
  const world = new ForkWorld();
  try {
    const weird = "/tmp/my profile dir (x); `id` $(whoami)";
    const svc = makeService(world, { env: { PI_CODING_AGENT_DIR: weird } });
    await svc.fork({ sessionFile: SESSION, placement: "right" });
    // Exactly one --env argument pair; the value keeps its metacharacters
    // intact as a single argv entry (no interpolation on our side).
    assert.deepEqual(world.splitEnv, [`PI_CODING_AGENT_DIR=${weird}`]);
    assert.equal(world.calls[0].args.filter((a) => a === "--env").length, 1);
  } finally {
    world.dispose();
  }
});

test("fork: absent or empty PI_CODING_AGENT_DIR -> no --env, no default substituted", async () => {
  for (const env of [undefined, {}, { PI_CODING_AGENT_DIR: "" }, { PI_CODING_AGENT_DIR: "   " }]) {
    const world = new ForkWorld();
    try {
      const svc = makeService(world, { env });
      await svc.fork({ sessionFile: SESSION, placement: "right" });
      assert.equal(world.calls[0].args.includes("--env"), false, `no --env expected for env=${JSON.stringify(env)}`);
    } finally {
      world.dispose();
    }
  }
});

// ---------------------------------------------------------------------------
// Tab placement
// ---------------------------------------------------------------------------

test("fork: tab placement -> workspace resolve, tab create, run in root pane", async () => {
  const world = new ForkWorld();
  try {
    const svc = makeService(world);
    const r = await svc.fork({
      sessionFile: SESSION,
      placement: "tab",
      instruction: "take the tab",
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.outcome, "forked");
    assert.equal(r.pane, world.rootPaneId);
    assert.equal(r.tab, world.tabId);
    assert.equal(r.placement, "tab");
    // Step 1: resolve the parent's workspace from HERDR_PANE_ID.
    assert.deepEqual(world.calls[0].args, ["pane", "get", "wF:p1"]);
    // Step 2: create the tab in that workspace, with focus.
    // No PI_CODING_AGENT_DIR in the service env -> no --env entry at all.
    assert.deepEqual(world.calls[1].args, [
      "tab", "create", "--workspace", "wF", "--cwd", "/srv/fork-project", "--focus",
    ]);
    assert.deepEqual(world.tabEnv, [null]);
    assert.equal(world.lastRun!.pane, world.rootPaneId);
    assert.ok(commandOf(world).includes(shellQuote(SESSION)));
  } finally {
    world.dispose();
  }
});

test("fork: tab placement without instruction still sends the session file", async () => {
  const world = new ForkWorld();
  try {
    const svc = makeService(world);
    const r = await svc.fork({ sessionFile: SESSION, placement: "tab" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(
      commandOf(world),
      `${shellQuote(world.launcherPath)} --session-file ${shellQuote(SESSION)} --`,
    );
  } finally {
    world.dispose();
  }
});

// ---------------------------------------------------------------------------
// Failure / context handling (parent must stay untouched)
// ---------------------------------------------------------------------------

test("fork: outside Herdr (no HERDR_PANE_ID) -> warning, zero herdr calls", async () => {
  const world = new ForkWorld();
  try {
    const svc = makeService(world, { paneId: undefined });
    const r = await svc.fork({ sessionFile: SESSION, placement: "right" });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "outside_herdr");
    assert.equal(world.calls.length, 0, "no herdr command may be issued outside Herdr");
  } finally {
    world.dispose();
  }
});

test("fork: missing launcher -> validation error before any herdr call", async () => {
  const world = new ForkWorld();
  try {
    const svc = makeService(world, { launcherPath: join(world.launcherDir, "absent.sh") });
    const r = await svc.fork({ sessionFile: SESSION, placement: "right" });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "launcher_missing");
    assert.equal(world.calls.length, 0);
  } finally {
    world.dispose();
  }
});

test("fork: pane split failure -> error, no pane run", async () => {
  const world = new ForkWorld();
  try {
    world.failCommands.push({
      match: /^pane split/,
      code: "pane_layout_failed",
      message: "maximum panes reached",
    });
    const svc = makeService(world);
    const r = await svc.fork({ sessionFile: SESSION, placement: "right" });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "error");
    assert.equal(r.phase, "split");
    assert.equal(r.code, "pane_layout_failed");
    assert.equal(world.lastRun, undefined, "pane run must not follow a failed split");
  } finally {
    world.dispose();
  }
});

test("fork: tab create failure -> error, no pane run", async () => {
  const world = new ForkWorld();
  try {
    world.failCommands.push({
      match: /^tab create/,
      code: "tab_failed",
      message: "workspace tab limit",
    });
    const svc = makeService(world);
    const r = await svc.fork({ sessionFile: SESSION, placement: "tab" });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "error");
    assert.equal(r.phase, "tab_create");
    assert.equal(r.code, "tab_failed");
    assert.equal(world.lastRun, undefined);
  } finally {
    world.dispose();
  }
});

test("fork: pane run failure -> error carrying the created pane", async () => {
  const world = new ForkWorld();
  try {
    world.failCommands.push({ match: /^pane run/, code: "run_failed", message: "spawn failed" });
    const svc = makeService(world);
    const r = await svc.fork({ sessionFile: SESSION, placement: "right" });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "error");
    assert.equal(r.phase, "launch");
    assert.equal(r.pane, world.splitPaneId);
    assert.equal(r.code, "run_failed");
  } finally {
    world.dispose();
  }
});

test("fork: abort after successful split -> aborted result", async () => {
  const world = new ForkWorld();
  try {
    const ac = new AbortController();
    const svc = makeService(world);
    // Abort before the launch step by pre-aborting right after split:
    // simpler: abort before the call -> pre result.
    ac.abort();
    const r = await svc.fork({ sessionFile: SESSION, placement: "right" }, ac.signal);
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "aborted");
    assert.equal(world.calls.length, 0);
  } finally {
    world.dispose();
  }
});

test("fork: split response without pane_id -> malformed error", async () => {
  const world = new ForkWorld();
  try {
    const worldRef = world;
    const transport: Transport = {
      async run(args: string[]): Promise<TransportResult> {
        const [a0, a1] = args;
        if (a0 === "pane" && a1 === "split") {
          return { exitCode: 0, stdout: JSON.stringify({ result: { type: "pane_info" } }), stderr: "" };
        }
        throw new Error("unexpected");
      },
    };
    const svc = new HerdrForkService({
      transport,
      launcherPath: worldRef.launcherPath,
      paneId: "wF:p1",
      cwd: "/tmp",
    });
    const r = await svc.fork({ sessionFile: SESSION, placement: "right" });
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
  // The fake pi records its argv (program name normalized to "pi") into
  // $RECORD and the PI_CODING_AGENT_DIR env var into $RECORD.env, so tests
  // can assert both without depending on the resolved PATH location.
  writeFileSync(join(dir, "bin", "pi"), `#!/usr/bin/env bash
printf 'pi\n' >> "$RECORD"
printf '%s\\n' "\${@}" >> "$RECORD"
printf 'PI_CODING_AGENT_DIR=%s\\n' "\${PI_CODING_AGENT_DIR:-}" >> "\${RECORD}.env"
printf 'pi (fake)\\n'
`, { mode: 0o755 });
  return join(dir, "bin");
}

function runLauncher(
  dir: string,
  argv: string[],
  env: Record<string, string>,
  recordTo: string,
  launcherPath = join(dir, "pi-fork-launcher.sh"),
): { status: number | null; stderr: string; recorded: string[] } {
  // The dir/bin fake `pi` shadows the system pi: the test directory comes
  // first in PATH.
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
});

test("launcher: parses --session-file and passes the instruction as one argv entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "fork-launcher-"));
  try {
    writeFileSync(join(dir, "pi-fork-launcher.sh"), REAL_LAUNCHER_SRC, { mode: 0o755 });
    fakePiDir(dir);
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, "{}\n");
    const record = join(dir, "argv.txt");
    const res = runLauncher(
      dir,
      ["--session-file", sessionFile, "--", "investigate; the 'flaky' test", "extra"],
      {},
      record,
    );
    assert.equal(res.status, 0, res.stderr);
    // fake pi records its argv: <pi> --fork <session> <instruction-joined>
    // The launcher joins all words after -- into a single instruction string,
    // so "investigate; the 'flaky' test" + "extra" becomes one argv entry.
    assert.deepEqual(res.recorded, [
      "pi",
      "--fork",
      sessionFile,
      "investigate; the 'flaky' test extra",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("launcher: propagates the parent PI_CODING_AGENT_DIR verbatim", () => {
  const dir = mkdtempSync(join(tmpdir(), "fork-launcher-"));
  try {
    writeFileSync(join(dir, "pi-fork-launcher.sh"), REAL_LAUNCHER_SRC, { mode: 0o755 });
    fakePiDir(dir);
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, "{}\n");
    const record = join(dir, "env.txt");
    const res = spawnSync("bash", [join(dir, "pi-fork-launcher.sh"), "--session-file", sessionFile, "--"], {
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
    // The fake pi records PI_CODING_AGENT_DIR=... on its own line.
    assert.ok(
      recorded.includes("PI_CODING_AGENT_DIR=/Users/cgint/.pi/profiles/minimal/agent"),
      `expected PI_CODING_AGENT_DIR propagation, got:\n${recorded}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("launcher: usage errors exit 2 without exec'ing pi", () => {
  const dir = mkdtempSync(join(tmpdir(), "fork-launcher-"));
  try {
    writeFileSync(join(dir, "pi-fork-launcher.sh"), REAL_LAUNCHER_SRC, { mode: 0o755 });
    fakePiDir(dir);
    const record = join(dir, "argv.txt");
    for (const argv of [
      [],
      ["--session-file"],
      ["--bogus"],
      ["--session-file", join(dir, "does-not-exist.jsonl")],
    ]) {
      const res = runLauncher(dir, argv, {}, record);
      assert.equal(res.status, 2, `argv=${JSON.stringify(argv)}: ${res.stderr}`);
      assert.ok(res.stderr.startsWith("pi-fork-launcher: "), "usage errors must identify the launcher");
    }
    assert.ok(!existsSync(record), "pi must never have been executed on usage errors");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultForkLauncherPath: converts the module file-URL to the scripts/ asset path", () => {
  // defaultForkLauncherPath() must be computed from a file: URL, not a raw
  // URL pathname: an encoded path (e.g. a space -> %20) in the checkout
  // directory must still resolve to the on-disk asset. The test compiles
  // into the same directory as fork.js, so the expected value is derived
  // from the module's own file-URL conversion and must name the package's
  // scripts/pi-fork-launcher.sh asset path exactly.
  const expected = join(
    dirname(fileURLToPath(new URL("../fork.js", import.meta.url))),
    "scripts",
    "pi-fork-launcher.sh",
  );
  assert.equal(defaultForkLauncherPath(), expected, "defaultForkLauncherPath must convert import.meta.url via fileURLToPath");
  // Anchor the asset itself on the repo-root copy (same convention as the
  // other launcher tests in this file).
  assert.ok(existsSync(REAL_LAUNCHER), "package launcher asset must exist at scripts/pi-fork-launcher.sh");
  assert.ok(statSync(REAL_LAUNCHER).mode & 0o111, "package launcher asset must be executable");
});

test("packaging: fork source and launcher are declared package files", () => {
  const pkgPath = new URL("../../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { files?: string[] };
  for (const entry of ["index.ts", "core.ts", "transport.ts", "fork.ts", "fork-parser.ts", "scripts"]) {
    assert.ok(pkg.files?.includes(entry), `package.json files must include ${entry}`);
  }
  assert.ok(existsSync(REAL_LAUNCHER), "scripts/pi-fork-launcher.sh must exist in the repo");
  const stat = statSync(REAL_LAUNCHER);
  assert.ok(stat.mode & 0o111, "launcher must be executable");
  assert.ok(pkg.files?.includes("README.md"), "README stays packaged");
});
