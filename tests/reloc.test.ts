// Node:test suite for reloc.ts (HerdrRelocService) + the dedicated
// pi-reloc-launcher.sh asset.
//
// Fake transport implements the Herdr CLI response shapes this feature
// depends on (docs/evidence + live probes):
//   pane get   -> result.pane.workspace_id
//   tab create -> result.{ tab: { tab_id }, root_pane: { pane_id } }
//   pane run   -> { result: { type: "ok" } }
//   pane close -> clean ok envelope / truncated-empty / typed error / throw
// The launcher asset is exercised for real (bash -n, argument parsing,
// PI_CODING_AGENT_DIR propagation, exit codes) against a fake `pi` binary —
// no live Herdr, no worker runtime.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

import {
  HerdrRelocService,
  defaultRelocLauncherPath,
} from "../reloc.js";
import { shellQuote } from "../core.js";
import type { Transport, TransportResult, TransportOptions } from "../transport.js";

// The documented `npm test` script compiles tests into .test-build/tests/
// (rootDir = repo root, outDir = .test-build), so import.meta.url resolves
// inside .test-build. defaultRelocLauncherPath() therefore points at
// .test-build/scripts/, which tsc does not copy. Resolve the REAL repo-root
// asset for the asset tests (two levels up from the compiled location, same
// convention as tests/fork.test.ts).
function repoRootPath(...parts: string[]): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", ...parts);
}
const REAL_LAUNCHER = repoRootPath("scripts", "pi-reloc-launcher.sh");
const REAL_LAUNCHER_SRC = readFileSync(REAL_LAUNCHER, "utf8");

// ---------------------------------------------------------------------------
// Fake herdr world (reloc-relevant subset)
// ---------------------------------------------------------------------------

/** How the fake world answers `pane close` of the calling pane. */
type CloseMode =
  | "clean" // clean ok envelope
  | "truncated" // exit 0, empty stdout (PTY killed before the envelope)
  | "not_found" // exit 1, typed pane_not_found
  | "server_error" // exit 1, typed server error
  | "throw"; // transport-level throw (timeout/abort stand-in)

class RelocWorld {
  calls: Array<{ args: string[]; timeoutMs?: number }> = [];
  launcherDir = mkdtempSync(join(tmpdir(), "reloc-launcher-test-"));
  launcherPath = join(this.launcherDir, "pi-reloc-launcher.sh");
  paneId = "wR:p1";
  workspaceId = "wR";
  tabId = "wR:t2";
  rootPaneId = "wR:p9";
  tabWorkspace?: string;
  tabCwd?: string;
  tabEnv?: Array<string | null> = [];
  failCommands: Array<{ match: RegExp; code: string; message: string }> = [];
  closeMode: CloseMode = "clean";
  closePaneId?: string;

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
              pane: { pane_id: a2, workspace_id: "wR" },
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
        if (a0 === "pane" && a1 === "close") {
          world.closePaneId = a2;
          switch (world.closeMode) {
            case "clean":
              return out({ id: "cli:pane:close", result: { type: "ok" } });
            case "truncated":
              // Probe-confirmed silent-failure mode: the PTY is killed
              // before the CLI writes its envelope -> 0-byte stdout.
              return { exitCode: 0, stdout: "", stderr: "" };
            case "not_found":
              return {
                exitCode: 1,
                stdout: "",
                stderr: JSON.stringify({ error: { code: "pane_not_found", message: "pane does not exist" }, id: "x" }),
              };
            case "server_error":
              return {
                exitCode: 1,
                stdout: "",
                stderr: JSON.stringify({ error: { code: "pane_busy", message: "could not close pane" }, id: "x" }),
              };
            case "throw":
              throw Object.assign(new Error("herdr CLI timed out"), { name: "TimeoutError" });
          }
        }
        throw new Error(`reloc world: unhandled herdr command: ${c}`);
      },
    };
  }

  lastRun?: { pane: string; command: string };
}

function makeService(world: RelocWorld, over: Partial<ConstructorParameters<typeof HerdrRelocService>[0]> = {}): HerdrRelocService {
  return new HerdrRelocService({
    transport: world.transport(),
    launcherPath: world.launcherPath,
    paneId: world.paneId,
    cwd: "/srv/reloc-project",
    ...over,
  });
}

const SESSION = "/srv/sessions/active-session.jsonl";

function commandOf(world: RelocWorld): string {
  assert.ok(world.lastRun, "pane run was not recorded");
  return world.lastRun!.command;
}

// ---------------------------------------------------------------------------
// Happy path (plan §6 case 1)
// ---------------------------------------------------------------------------

test("reloc: happy path -> pane get, tab create, pane run, pane close; relocated result", async () => {
  const world = new RelocWorld();
  try {
    const svc = makeService(world);
    const r = await svc.reloc({ sessionFile: SESSION });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.outcome, "relocated");
    assert.equal(r.tab, world.tabId);
    assert.equal(r.pane, world.rootPaneId);
    assert.equal(r.staleOriginalPane, false);
    // Exact 4-call sequence.
    assert.deepEqual(world.calls[0].args, ["pane", "get", "wR:p1"]);
    // No PI_CODING_AGENT_DIR in the service env -> no --env entry at all.
    assert.deepEqual(world.calls[1].args, [
      "tab", "create", "--workspace", "wR", "--cwd", "/srv/reloc-project", "--focus",
    ]);
    assert.deepEqual(world.tabEnv, [null]);
    assert.deepEqual(world.calls[2].args, ["pane", "run", world.rootPaneId, commandOf(world)]);
    // No instruction marker: launcher invoked as `--session-file <q>` only.
    assert.equal(commandOf(world), `${shellQuote(world.launcherPath)} --session-file ${shellQuote(SESSION)}`);
    assert.deepEqual(world.calls[3].args, ["pane", "close", "wR:p1"]);
    assert.equal(world.closePaneId, world.paneId, "the ORIGINAL pane must be closed, not the new one");
  } finally {
    world.dispose();
  }
});

// ---------------------------------------------------------------------------
// Profile (PI_CODING_AGENT_DIR) propagation (plan §6 cases 2-3)
// ---------------------------------------------------------------------------

const PROFILE_DIR = "/Users/cgint/.pi/profiles/minimal/agent";

test("reloc: PI_CODING_AGENT_DIR present -> tab create carries exactly one --env pair", async () => {
  const world = new RelocWorld();
  try {
    const svc = makeService(world, { env: { PI_CODING_AGENT_DIR: PROFILE_DIR } });
    const r = await svc.reloc({ sessionFile: SESSION });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(world.tabEnv, [`PI_CODING_AGENT_DIR=${PROFILE_DIR}`]);
    assert.deepEqual(world.calls[1].args, [
      "tab", "create", "--workspace", "wR", "--cwd", "/srv/reloc-project",
      "--env", `PI_CODING_AGENT_DIR=${PROFILE_DIR}`, "--focus",
    ]);
  } finally {
    world.dispose();
  }
});

test("reloc: absent or empty PI_CODING_AGENT_DIR -> no --env, no default substituted", async () => {
  for (const env of [undefined, {}, { PI_CODING_AGENT_DIR: "" }, { PI_CODING_AGENT_DIR: "   " }]) {
    const world = new RelocWorld();
    try {
      const svc = makeService(world, { env });
      const r = await svc.reloc({ sessionFile: SESSION });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(world.calls[1].args.includes("--env"), false, `no --env expected for env=${JSON.stringify(env)}`);
    } finally {
      world.dispose();
    }
  }
});

test("reloc: profile dir with shell metacharacters travels as one --env value", async () => {
  const world = new RelocWorld();
  try {
    const weird = "/tmp/my profile dir (x); `id` $(whoami)";
    const svc = makeService(world, { env: { PI_CODING_AGENT_DIR: weird } });
    const r = await svc.reloc({ sessionFile: SESSION });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(world.tabEnv, [`PI_CODING_AGENT_DIR=${weird}`]);
    assert.equal(world.calls[1].args.filter((a) => a === "--env").length, 1);
  } finally {
    world.dispose();
  }
});

// ---------------------------------------------------------------------------
// Context / validation failures (plan §6 cases 4-5)
// ---------------------------------------------------------------------------

test("reloc: outside Herdr (no paneId) -> outside_herdr, zero herdr calls", async () => {
  const world = new RelocWorld();
  try {
    const svc = makeService(world, { paneId: undefined });
    const r = await svc.reloc({ sessionFile: SESSION });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "outside_herdr");
    assert.equal(world.calls.length, 0, "no herdr command may be issued outside Herdr");
  } finally {
    world.dispose();
  }
});

test("reloc: missing launcher -> launcher_missing before any herdr call", async () => {
  const world = new RelocWorld();
  try {
    const svc = makeService(world, { launcherPath: join(world.launcherDir, "absent.sh") });
    const r = await svc.reloc({ sessionFile: SESSION });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "launcher_missing");
    assert.equal(world.calls.length, 0);
  } finally {
    world.dispose();
  }
});

test("reloc: tab create failure -> error at tab_create; pane run and pane close NOT called", async () => {
  const world = new RelocWorld();
  try {
    world.failCommands.push({ match: /^tab create/, code: "tab_failed", message: "workspace tab limit" });
    const svc = makeService(world);
    const r = await svc.reloc({ sessionFile: SESSION });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "error");
    assert.equal(r.phase, "tab_create");
    assert.equal(r.code, "tab_failed");
    assert.equal(world.lastRun, undefined, "pane run must not follow a failed tab create");
    assert.equal(world.closePaneId, undefined, "pane close must not follow a failed tab create");
    assert.equal(world.calls.length, 2, "only pane get + failed tab create");
  } finally {
    world.dispose();
  }
});

// ---------------------------------------------------------------------------
// Launch failure (plan §6 case 7): original pane must stay open
// ---------------------------------------------------------------------------

test("reloc: pane run failure -> error at launch; pane close NOT called", async () => {
  const world = new RelocWorld();
  try {
    world.failCommands.push({ match: /^pane run/, code: "run_failed", message: "spawn failed" });
    const svc = makeService(world);
    const r = await svc.reloc({ sessionFile: SESSION });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "error");
    assert.equal(r.phase, "launch");
    assert.equal(r.code, "run_failed");
    assert.equal(r.tab, world.tabId, "the orphaned tab id is surfaced for manual cleanup");
    assert.equal(r.pane, world.rootPaneId);
    assert.equal(world.closePaneId, undefined, "the original pane must NOT be closed when the resume failed");
    assert.equal(world.calls.length, 3, "pane get + tab create + failed pane run, nothing else");
  } finally {
    world.dispose();
  }
});

// ---------------------------------------------------------------------------
// Pane close failures (plan §6 case 8): graceful — reloc still succeeds
// ---------------------------------------------------------------------------

function assertRelocatedStale(world: RelocWorld, r: { ok: boolean; outcome: string; tab?: string; pane?: string; staleOriginalPane?: boolean }, label: string): void {
  assert.equal(r.ok, true, `${label}: ${JSON.stringify(r)}`);
  assert.equal(r.outcome, "relocated", label);
  assert.equal(r.staleOriginalPane, true, label);
  assert.equal(r.tab, world.tabId, label);
  assert.equal(r.pane, world.rootPaneId, label);
  assert.equal(world.closePaneId, world.paneId, `${label}: the close must still target the ORIGINAL pane`);
  assert.equal(world.calls.length, 4, `${label}: all 4 CLI calls were made`);
}

test("reloc: pane close truncated/empty (silent-failure probe mode) -> relocated + staleOriginalPane", async () => {
  const world = new RelocWorld();
  try {
    world.closeMode = "truncated";
    const svc = makeService(world);
    const r = await svc.reloc({ sessionFile: SESSION });
    assertRelocatedStale(world, r, "truncated close");
  } finally {
    world.dispose();
  }
});

test("reloc: pane close typed pane_not_found -> relocated + staleOriginalPane (idempotent absence)", async () => {
  const world = new RelocWorld();
  try {
    world.closeMode = "not_found";
    const svc = makeService(world);
    const r = await svc.reloc({ sessionFile: SESSION });
    assertRelocatedStale(world, r, "pane_not_found close");
  } finally {
    world.dispose();
  }
});

test("reloc: pane close typed server error -> relocated + staleOriginalPane", async () => {
  const world = new RelocWorld();
  try {
    world.closeMode = "server_error";
    const svc = makeService(world);
    const r = await svc.reloc({ sessionFile: SESSION });
    assertRelocatedStale(world, r, "server-error close");
  } finally {
    world.dispose();
  }
});

test("reloc: pane close transport throw (timeout) -> relocated + staleOriginalPane", async () => {
  const world = new RelocWorld();
  try {
    world.closeMode = "throw";
    const svc = makeService(world);
    const r = await svc.reloc({ sessionFile: SESSION });
    assertRelocatedStale(world, r, "throwing close");
  } finally {
    world.dispose();
  }
});

// ---------------------------------------------------------------------------
// Abort handling (plan §6 cases 9-10)
// ---------------------------------------------------------------------------

test("reloc: abort before start -> aborted, zero herdr calls", async () => {
  const world = new RelocWorld();
  try {
    const ac = new AbortController();
    ac.abort();
    const svc = makeService(world);
    const r = await svc.reloc({ sessionFile: SESSION }, ac.signal);
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "aborted");
    assert.equal(world.calls.length, 0);
  } finally {
    world.dispose();
  }
});

test("reloc: abort mid-flight (at pane run) -> aborted; pane close NOT called", async () => {
  const world = new RelocWorld();
  try {
    // Realistic mid-flight abort: the new tab already exists (tab create
    // succeeded), then the signal aborts exactly when the `pane run` resume
    // is about to be issued. The service must surface "aborted" (not
    // "error") and must NOT close the original pane.
    const ac = new AbortController();
    const svc = new HerdrRelocService({
      transport: {
        async run(args: string[]): Promise<TransportResult> {
          world.call(args);
          if (args[0] === "pane" && args[1] === "get") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({ id: "cli:pane:get", result: { pane: { pane_id: world.paneId, workspace_id: "wR" } } }),
              stderr: "",
            };
          }
          if (args[0] === "tab" && args[1] === "create") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({ id: "cli:tab:create", result: { tab: { tab_id: world.tabId }, root_pane: { pane_id: world.rootPaneId } } }),
              stderr: "",
            };
          }
          // Abort lands exactly when the pane run is about to run.
          ac.abort();
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        },
      },
      launcherPath: world.launcherPath,
      paneId: world.paneId,
      cwd: "/srv/reloc-project",
    });
    const r = await svc.reloc({ sessionFile: SESSION }, ac.signal);
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "aborted");
    assert.equal(r.phase, "launch", "the abort landed at the launch step");
    // The transport records the attempted pane run before surfacing the
    // abort, so the call count is 3 (get + create + attempted run).
    assert.equal(world.calls.length, 3, "pane get + tab create + the attempted pane run");
    assert.equal(world.closePaneId, undefined, "no close after an aborted mid-flight reloc");
  } finally {
    world.dispose();
  }
});

test("reloc: tab create response without tab/root pane -> malformed error", async () => {
  const world = new RelocWorld();
  try {
    const svc = new HerdrRelocService({
      transport: {
        async run(args: string[]): Promise<TransportResult> {
          world.call(args);
          const [a0, a1] = args;
          if (a0 === "pane" && a1 === "get") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({ id: "cli:pane:get", result: { pane: { pane_id: world.paneId, workspace_id: "wR" } } }),
              stderr: "",
            };
          }
          if (a0 === "tab" && a1 === "create") {
            return { exitCode: 0, stdout: JSON.stringify({ id: "cli:tab:create", result: { type: "ok" } }), stderr: "" };
          }
          throw new Error("unexpected");
        },
      },
      launcherPath: world.launcherPath,
      paneId: world.paneId,
      cwd: "/tmp",
    });
    const r = await svc.reloc({ sessionFile: SESSION });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "error");
    assert.equal(r.phase, "tab_create");
    assert.equal(r.code, "tab_create_malformed");
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
printf 'pi\\n' >> "$RECORD"
printf '%s\\n' "\${@}" >> "$RECORD"
printf 'PI_CODING_AGENT_DIR=%s\\n' "\${PI_CODING_AGENT_DIR:-}" >> "\${RECORD}.env"
printf 'pi (fake)\\n'
`, { mode: 0o755 });
  return join(dir, "bin");
}

function runRelocLauncher(
  dir: string,
  argv: string[],
  env: Record<string, string>,
  recordTo: string,
): { status: number | null; stderr: string; recorded: string[] } {
  // The dir/bin fake `pi` shadows the system pi: the test directory comes
  // first in PATH.
  const launcherPath = join(dir, "pi-reloc-launcher.sh");
  const res = spawnSync("bash", [launcherPath, ...argv], {
    env: { PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`, ...env, RECORD: recordTo },
    encoding: "utf8",
  });
  const recorded = existsSync(recordTo)
    ? readFileSync(recordTo, "utf8").trim().split("\n").filter(Boolean)
    : [];
  return { status: res.status, stderr: res.stderr ?? "", recorded };
}

test("reloc launcher: syntax is valid bash", () => {
  const r = execFileSync("bash", ["-n", REAL_LAUNCHER], { encoding: "utf8" });
  assert.equal(r, "");
});

test("reloc launcher: no worker-runtime coupling in the asset", () => {
  const src = REAL_LAUNCHER_SRC;
  assert.ok(!/pi-worker-runtime|herdr-worker\.sh/.test(src), "launcher must not reference worker runtime");
  assert.ok(!/append-system-prompt|readonly|editable/.test(src), "launcher must not carry worker mode logic");
  assert.ok(/exec pi --session "\$session_file"/.test(src), "launcher must resume via `exec pi --session <file>`");
  assert.ok(!src.includes("usage: pi-fork-launcher"), "launcher must be the reloc asset, not the fork asset");
});

test("reloc launcher: parses --session-file and resumes with pi --session <file>", () => {
  const dir = mkdtempSync(join(tmpdir(), "reloc-launcher-"));
  try {
    writeFileSync(join(dir, "pi-reloc-launcher.sh"), REAL_LAUNCHER_SRC, { mode: 0o755 });
    fakePiDir(dir);
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, "{}\n");
    const record = join(dir, "argv.txt");
    const res = runRelocLauncher(dir, ["--session-file", sessionFile], {}, record);
    assert.equal(res.status, 0, res.stderr);
    // fake pi records its argv: <pi> --session <session-file>
    assert.deepEqual(res.recorded, ["pi", "--session", sessionFile]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reloc launcher: rejects a missing -- marker and stray arguments (exit 2, pi never exec'd)", () => {
  const dir = mkdtempSync(join(tmpdir(), "reloc-launcher-"));
  try {
    writeFileSync(join(dir, "pi-reloc-launcher.sh"), REAL_LAUNCHER_SRC, { mode: 0o755 });
    fakePiDir(dir);
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, "{}\n");
    const record = join(dir, "argv.txt");
    for (const argv of [
      [],
      ["--session-file"],
      ["--bogus"],
      ["--session-file", sessionFile, "--"],
      ["--session-file", join(dir, "does-not-exist.jsonl")],
    ]) {
      const res = runRelocLauncher(dir, argv, {}, record);
      assert.equal(res.status, 2, `argv=${JSON.stringify(argv)}: ${res.stderr}`);
      assert.ok(res.stderr.startsWith("pi-reloc-launcher: "), "usage errors must identify the launcher");
    }
    assert.ok(!existsSync(record), "pi must never have been executed on usage errors");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reloc launcher: inherits PI_CODING_AGENT_DIR verbatim (no re-export needed)", () => {
  const dir = mkdtempSync(join(tmpdir(), "reloc-launcher-"));
  try {
    writeFileSync(join(dir, "pi-reloc-launcher.sh"), REAL_LAUNCHER_SRC, { mode: 0o755 });
    fakePiDir(dir);
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, "{}\n");
    const record = join(dir, "env.txt");
    const res = spawnSync("bash", [join(dir, "pi-reloc-launcher.sh"), "--session-file", sessionFile], {
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
    // The fake pi records PI_CODING_AGENT_DIR=... on its own line: the value
    // must have been inherited from the process environment verbatim.
    assert.ok(
      recorded.includes("PI_CODING_AGENT_DIR=/Users/cgint/.pi/profiles/minimal/agent"),
      `expected PI_CODING_AGENT_DIR inheritance, got:\n${recorded}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultRelocLauncherPath: converts the module file-URL to the scripts/ asset path", () => {
  // defaultRelocLauncherPath() must be computed from a file: URL, not a raw
  // URL pathname: an encoded path (e.g. a space -> %20) in the checkout
  // directory must still resolve to the on-disk asset. The test compiles
  // into the same directory as reloc.js, so the expected value is derived
  // from the module's own file-URL conversion and must name the package's
  // scripts/pi-reloc-launcher.sh asset path exactly.
  const expected = join(
    dirname(fileURLToPath(new URL("../reloc.js", import.meta.url))),
    "scripts",
    "pi-reloc-launcher.sh",
  );
  assert.equal(defaultRelocLauncherPath(), expected, "defaultRelocLauncherPath must convert import.meta.url via fileURLToPath");
  // Anchor the asset itself on the repo-root copy (same convention as the
  // other launcher tests in this file).
  assert.ok(existsSync(REAL_LAUNCHER), "package launcher asset must exist at scripts/pi-reloc-launcher.sh");
  assert.ok(statSync(REAL_LAUNCHER).mode & 0o111, "package launcher asset must be executable");
});

test("packaging: reloc source and launcher are declared package files", () => {
  const pkgPath = new URL("../../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { files?: string[] };
  for (const entry of ["index.ts", "core.ts", "transport.ts", "fork.ts", "scripts"]) {
    assert.ok(pkg.files?.includes(entry), `package.json files must include ${entry}`);
  }
  assert.ok(existsSync(REAL_LAUNCHER), "scripts/pi-reloc-launcher.sh must exist in the repo");
  const stat = statSync(REAL_LAUNCHER);
  assert.ok(stat.mode & 0o111, "launcher must be executable");
});
