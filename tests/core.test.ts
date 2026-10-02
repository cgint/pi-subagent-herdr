// Node:test suite for src/core.js + src/transport.js.
// Fake transport implements a small herdr state machine so start, prompt,
// wait, detection, races, cancellation, ownership and quoting are all
// exercised without touching the live herdr server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SubagentService, shellQuote, DEFAULTS } from "../src/core.js";
import type { Transport, TransportResult, TransportOptions } from "../src/transport.js";

// ---------------------------------------------------------------------------
// TEST-ISOLATION GUARD
// ---------------------------------------------------------------------------
// This unit-test file must NEVER invoke the real herdr CLI. All herdr state is
// simulated by the FakeWorld fake transport (makeService/makeTransport). The
// ONLY real subprocesses spawned in this file are:
//   - `node` (transport process tests: spawn/kill/timeout/abort/overflow), and
//   - `zsh` (the shellQuote round-trip test).
// Both are inert, herdr-free processes. The test below asserts this invariant
// by checking that the real herdr binary is NOT used anywhere in the fake
// transport path (the FakeWorld transport never calls the real CLI).

// ---------------------------------------------------------------------------
// Fake herdr world
// ---------------------------------------------------------------------------

interface FakeAgent {
  status: string;
  seq: number;
  terminalId: string;
  name: string | null;
  alive: boolean;
}

class FakeWorld {
  agents = new Map<string, FakeAgent>();
  workspaces = new Map<string, { label: string }>();
  panesAlive = new Set<string>();
  calls: Array<{ args: string[]; timeoutMs?: number }> = [];
  splitPaneCounter = 1;
  splitTerminals = new Map<string, string>();
  /** Scripted status transitions: paneId -> queue of statuses to advance
   *  through on successive `agent get` calls (after the queue is empty the
   *  last status sticks). */
  scripts = new Map<string, string[]>();
  /** agent prompt results: paneId -> "ok" | "stalled" | "timeout" | "blocked" */
  promptOutcomes = new Map<string, string>();
  /** Number of agent-get calls needed before a pane becomes "detected". */
  detectionDelays = new Map<string, number>();
  detectionCounts = new Map<string, number>();
  failCommands: Array<{ match: RegExp; code: string; message: string }> = [];
  promptText: string[] = [];

  addPanes(paneIds: string[], workspace: string) {
    for (const id of paneIds) this.panesAlive.add(id);
    this.workspaces.set(workspace, { label: `ws-${workspace}` });
  }

  addAgent(
    paneId: string,
    workspace: string,
    init: Partial<{ status: string; terminalId: string }> = {},
  ) {
    this.agents.set(paneId, {
      status: init.status ?? "idle",
      seq: 100 + this.agents.size,
      terminalId: init.terminalId ?? `term_${paneId.replace(/[^a-z0-9]/gi, "")}`,
      name: null,
      alive: true,
    });
    this.addPanes([paneId], workspace);
  }

  killAgent(paneId: string) {
    const a = this.agents.get(paneId);
    if (a) a.alive = false;
  }

  nextStatus(paneId: string): string | null {
    const q = this.scripts.get(paneId);
    if (q && q.length > 0) return q.shift() ?? null;
    return null;
  }
}

function agentDoc(paneId: string, a: FakeAgent, workspace: string) {
  return {
    id: "cli:agent:get",
    result: {
      type: "agent_info",
      agent: {
        agent: "pi",
        agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: `/fake/${paneId}.jsonl` },
        agent_status: a.status,
        state_change_seq: a.seq,
        pane_id: paneId,
        workspace_id: workspace,
        terminal_id: a.terminalId,
        name: a.name,
      },
    },
  };
}

function paneDoc(paneId: string, workspace: string, a?: FakeAgent) {
  return {
    id: "cli:pane:get",
    result: {
      type: "pane_info",
      pane: {
        pane_id: paneId,
        workspace_id: workspace,
        terminal_id: a?.terminalId,
        agent_status: a?.status ?? "unknown",
      },
    },
  };
}

function makeTransport(world: FakeWorld, now?: () => number): Transport {
  const clock = now ?? Date.now;
  return {
    async run(args: string[], options: TransportOptions = {}): Promise<TransportResult> {
      if (options.signal?.aborted) {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      world.calls.push({ args: [...args], timeoutMs: options.timeoutMs });
      for (const fail of world.failCommands) {
        if (fail.match.test(args.join(" "))) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({ error: { code: fail.code, message: fail.message }, id: "x" }),
          };
        }
      }
      const [c0, c1, c2, c3, c4] = args;
      const out = (obj: unknown): TransportResult => ({
        exitCode: 0,
        stdout: JSON.stringify(obj),
        stderr: "",
      });

      if (c0 === "pane" && c1 === "get") {
        const id = c2!;
        if (!world.panesAlive.has(id)) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({ error: { code: "pane_not_found", message: `pane ${id} not found` } }),
          };
        }
        const ws = id.slice(0, id.indexOf(":"));
        const a = world.agents.get(id);
        return out(paneDoc(id, ws, a));
      }

      if (c0 === "pane" && c1 === "split") {
        const ws = "wF";
        // Pre-increment so the new pane id never collides with the caller's
        // own pane (wF:p1) in single-split scenarios.
        world.splitPaneCounter += 1;
        const id = `wF:p${world.splitPaneCounter}`;
        world.workspaces.set(ws, { label: "scratch" });
        // ACTUAL recorded shape (stageA_pane_split.json): result.type=pane_info,
        // result.pane = a SINGLE pane object (not a panes array).
        world.panesAlive.add(id);
        // Remember the terminal_id the split reported so `pane get` / agent
        // detection stay consistent (the real CLI keeps a pane's terminal_id
        // stable across reads).
        world.splitTerminals.set(id, `term_split_${world.splitPaneCounter}`);
        return out({
          id: "cli:pane:split",
          result: {
            type: "pane_info",
            pane: {
              agent_status: "unknown",
              cwd: "/private/tmp",
              focused: false,
              pane_id: id,
              revision: 0,
              tab_id: `${ws}:t1`,
              terminal_id: `term_split_${world.splitPaneCounter}`,
              workspace_id: ws,
            },
          },
        });
      }

      if (c0 === "pane" && c1 === "run") {
        const id = c2!;
        if (!world.panesAlive.has(id)) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({ error: { code: "pane_not_found", message: `pane ${id} not found` } }),
          };
        }
        // Auto-register the agent: launching the wrapper makes pi detect itself.
        if (!world.agents.has(id)) {
          const tid = world.splitTerminals.get(id);
          world.addAgent(id, "wF", { status: "idle", terminalId: tid });
        }
        return out({ id: "cli:pane:run", result: { type: "ok" } });
      }

      if (c0 === "pane" && c1 === "send-keys") {
        return out({ id: "cli:pane:send-keys", result: { type: "ok" } });
      }

      if (c0 === "pane" && c1 === "read") {
        return out({ id: "cli:pane:read", result: { text: "raw-output-🧵", lines: [] } });
      }

      if (c0 === "pane" && c1 === "close") {
        const id = c2!;
        if (!world.panesAlive.has(id)) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({ error: { code: "pane_not_found", message: `pane ${id} not found` } }),
          };
        }
        world.panesAlive.delete(id);
        const a = world.agents.get(id);
        if (a) a.alive = false;
        return out({ id: "cli:pane:close", result: { type: "ok" } });
      }

      if (c0 === "pane" && c1 === "list") {
        const ws = c4 ?? "wF";
        const panes = [...world.panesAlive]
          .filter((id) => id.startsWith(`${ws}:`))
          .map((id) => ({
            pane_id: id,
            workspace_id: ws,
            terminal_id: world.agents.get(id)?.terminalId ?? null,
            agent_status: world.agents.get(id)?.status ?? "unknown",
          }));
        return out({ id: "cli:pane:list", result: { type: "pane_list", panes } });
      }

      if (c0 === "agent" && c1 === "get") {
        const id = c2!;
        const a = world.agents.get(id);
        if (!a || !a.alive || !world.panesAlive.has(id)) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({ error: { code: "agent_not_found", message: `agent target ${id} not found` } }),
          };
        }
        const count = (world.detectionCounts.get(id) ?? 0) + 1;
        world.detectionCounts.set(id, count);
        const delay = world.detectionDelays.get(id) ?? 0;
        if (count <= delay) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({ error: { code: "agent_not_found", message: `agent target ${id} not found` } }),
          };
        }
        const scripted = world.nextStatus(id);
        if (scripted) {
          a.status = scripted;
          a.seq += 1;
        }
        const ws = id.slice(0, id.indexOf(":"));
        return out(agentDoc(id, a, ws));
      }

      if (c0 === "agent" && c1 === "rename") {
        const id = c2!;
        const a = world.agents.get(id);
        if (!a || !a.alive) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({ error: { code: "agent_not_found", message: `agent target ${id} not found` } }),
          };
        }
        a.name = c3!;
        return out({ id: "cli:agent:rename", result: { type: "ok" } });
      }

      if (c0 === "agent" && c1 === "prompt") {
        const id = c2!;
        const a = world.agents.get(id);
        world.promptText.push(c3!);
        if (!a || !a.alive) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({ error: { code: "agent_not_found", message: `agent target ${id} not found` } }),
          };
        }
        const outcome = world.promptOutcomes.get(id) ?? "ok";
        if (outcome === "stalled") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({ error: { code: "agent_prompt_stalled", message: "no working observed" } }),
          };
        }
        if (outcome === "timeout") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({ error: { code: "timeout", message: "timed out waiting for agent status" } }),
          };
        }
        // Live CLI 0.9.3: the `agent_prompted` receipt carries the agent state
        // BEFORE the new turn (stale snapshot), not the terminal state. The
        // terminal transition is what `agent prompt --wait` blocks on; for a
        // bounded wait the fake flips to the target terminal state after the
        // receipt is handed back.
        const snapshot = { ...a };
        const ws = id.slice(0, id.indexOf(":"));
        const receipt = {
          id: "cli:agent:prompt",
          result: { type: "agent_prompted", agent: { ...agentDoc(id, snapshot, ws).result.agent } },
        };
        if (world.promptOutcomes.get(id) === "blocked") {
          a.status = "blocked";
          a.seq += 1;
        } else {
          a.status = "done";
          a.seq += 1;
        }
        return out(receipt);
      }

      if (c0 === "agent" && c1 === "read") {
        const id = c2!;
        const a = world.agents.get(id);
        if (!a || !a.alive) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({ error: { code: "agent_not_found", message: `agent target ${id} not found` } }),
          };
        }
        return out({
          id: "cli:agent:read",
          result: { type: "read", text: "worker output 🧵🧵 end" },
        });
      }

      if (c0 === "agent" && c1 === "wait") {
        const id = c2!;
        const a = world.agents.get(id);
        if (!a || !a.alive) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({ error: { code: "agent_not_found", message: `agent target ${id} not found` } }),
          };
        }
        // The scripted queue plays out on `agent wait` too.
        const scripted = world.nextStatus(id);
        if (scripted === "TIMEOUT") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({ error: { code: "timeout", message: "timed out waiting for agent status" } }),
          };
        }
        if (scripted) {
          a.status = scripted;
          a.seq += 1;
        }
        const ws = id.slice(0, id.indexOf(":"));
        return out({
          id: "cli:agent:wait",
          result: agentDoc(id, a, ws).result,
        });
      }

      if (c0 === "agent" && c1 === "list") {
        const agents = [...world.agents.entries()]
          .filter(([, a]) => a.alive)
          .map(([id, a]) => agentDoc(id, a, id.slice(0, id.indexOf(":"))).result.agent);
        return out({ id: "cli:agent:list", result: { type: "agent_list", agents } });
      }

      if (c0 === "workspace" && c1 === "list") {
        const workspaces = [...world.workspaces.entries()].map(([id, w]) => ({
          workspace_id: id,
          label: w.label,
          pane_count: 1,
          tab_count: 1,
          agent_status: "idle",
          focused: false,
          active_tab_id: `${id}:t1`,
        }));
        return out({ id: "cli:workspace:list", result: { type: "workspace_list", workspaces } });
      }

      if (c0 === "workspace" && c1 === "get") {
        const id = c2!;
        if (!world.workspaces.has(id)) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({ error: { code: "workspace_not_found", message: `workspace ${id} not found` } }),
          };
        }
        return out({
          id: "cli:workspace:get",
          result: { type: "workspace_info", workspace: { workspace_id: id, label: world.workspaces.get(id)!.label } },
        });
      }

      return {
        exitCode: 1,
        stdout: "",
        stderr: JSON.stringify({ error: { code: "unknown_command", message: `fake transport: unknown ${c0} ${c1}` } }),
      };
    },
  };
}

function makeService(
  world: FakeWorld,
  extra: Record<string, unknown> = {},
  overrides: { runtimeDir?: string } = {},
) {
  ensureScriptsDir();
  const svc = new SubagentService({
    transport: makeTransport(world),
    paneId: "wF:p1",
    runtimeDir: overrides.runtimeDir ?? FAKE_SCRIPTS_DIR,
    defaults: {
      detectionMs: 3000,
      boundedWaitMs: 4000,
      finishWaitMs: 5000,
      maxWaitMs: 60_000,
      tailBoundedChars: 50,
      tailWaitChars: 2000,
      readLines: 10,
      readChars: 50_000,
    },
    ...extra,
  });
  return svc;
}

function getContinuationState(svc: SubagentService, id: string) {
  return (svc as unknown as { continuations: Map<string, Record<string, unknown>> }).continuations.get(id);
}

const FAKE_SCRIPTS_DIR = mkdtempSync(join(tmpdir(), "fake-scripts-"));
let SCRIPTS_DIR_READY = false;
function ensureScriptsDir() {
  if (SCRIPTS_DIR_READY) return;
  writeFileSync(join(FAKE_SCRIPTS_DIR, "herdr-worker.sh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  SCRIPTS_DIR_READY = true;
}
import { test as nodeTest } from "node:test";
nodeTest("setup fake scripts", () => {
  ensureScriptsDir();
});

// ---------------------------------------------------------------------------
// shellQuote
// ---------------------------------------------------------------------------

test("shellQuote: safe strings pass through", () => {
  assert.equal(shellQuote("/Users/x/scripts/herdr-worker.sh"), "/Users/x/scripts/herdr-worker.sh");
});

test("shellQuote: quotes paths with spaces", () => {
  const q = shellQuote("/Users/cgint/my scripts/herdr-worker.sh");
  assert.equal(q, "'/Users/cgint/my scripts/herdr-worker.sh'");
});

test("shellQuote: quotes embedded single quotes", () => {
  const q = shellQuote("a'b c");
  assert.equal(q, "'a'\\''b c'");
});

test("shellQuote: quotes shell metacharacters", () => {
  const q = shellQuote("$(rm -rf x); echo pwned");
  assert.equal(q, "'$(rm -rf x); echo pwned'", "raw payload survives inside single quotes");
});

test("shellQuote: POSIX shell round-trip preserves the value", () => {
  const samples = [
    "/Users/cgint/my scripts/herdr-worker.sh",
    "a'b c",
    "$(rm -rf x); echo pwned",
    '100% & "quoted" \\ back',
  ];
  for (const value of samples) {
    const round = execFileSync("/bin/zsh", ["-c", `printf '%s' ${shellQuote(value)}`], { encoding: "utf8" });
    assert.equal(round, value, `round-trip for ${JSON.stringify(value)}`);
  }
});

test("shellQuote: empty string", () => {
  assert.equal(shellQuote(""), "''");
});

// ---------------------------------------------------------------------------
// execute: dispatch + validation
// ---------------------------------------------------------------------------

test("execute: unknown operation rejected", async () => {
  const world = new FakeWorld();
  const svc = makeService(world);
  const r = await svc.execute("teleport", {});
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "error");
  assert.equal(r.code, "invalid_operation");
  assert.equal(r.phase, "validation");
});

// ---------------------------------------------------------------------------
// test isolation guard: no real herdr in unit tests
// ---------------------------------------------------------------------------

test("isolation: the unit-test service uses the FakeWorld transport, never the real herdr CLI", async () => {
  const world = new FakeWorld();
  world.addPanes(["wF:p1"], "wF");
  const svc = makeService(world);
  // The service's transport must be the fake (recorded calls go to the fake
  // world), NOT a real spawn-based HerdrTransport that would hit herdr.
  const inner = (svc as unknown as { transport: Transport }).transport;
  assert.ok(inner, "service has a transport");
  // Prove the fake is wired: a start call records into world.calls and never
  // spawns a real herdr process. We assert the call is captured by the fake.
  world.addAgent("wF:p1", "wF", { status: "idle" });
  await svc.execute("spaces", {});
  const spacesCalls = world.calls.filter((c) => c.args[0] === "workspace");
  assert.ok(spacesCalls.length >= 1, "the call was routed to the FakeWorld transport");
  // The fake transport is a plain object, not a HerdrTransport instance (which
  // would carry herdrPath/spawn behaviour).
  assert.ok(!(inner as unknown as { herdrPath?: string }).herdrPath, "transport is not a real HerdrTransport (no herdrPath)");
});

// ---------------------------------------------------------------------------
// start: full happy path
// ---------------------------------------------------------------------------

test("start: full lifecycle split→run→detection→rename→prompt (none)", async () => {
  const world = new FakeWorld();
  world.addPanes(["wF:p1"], "wF");
  const svc = makeService(world);
  const cwd = process.cwd();
  const r = await svc.execute("start", {
    name: "otto",
    cwd,
    mode: "readonly",
    task: "Do the thing",
    waitMode: "none",
  });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "submitted");
  assert.equal(r.phase, "submission");
  assert.match(r.pane_id!, /^wF:p\d+$/);
  assert.equal(r.code, "agent_prompted");
  assert.equal(typeof r.continuation, "string", "continuation is an opaque string handle");

  // Split used an explicit supervisor pane target, never --current.
  const splitCall = world.calls.find((c) => c.args[0] === "pane" && c.args[1] === "split")!;
  assert.ok(splitCall);
  assert.equal(splitCall.args[2], "wF:p1", "split targets the supervisor pane explicitly");
  assert.ok(!splitCall.args.includes("--current"), "never uses --current");

  // Wrapper launched task-free with safe quoting.
  const runCall = world.calls.find((c) => c.args[0] === "pane" && c.args[1] === "run")!;
  assert.ok(runCall);
  const command = runCall.args[3];
  assert.ok(command.includes(`--mode readonly --`), `wrapper cmd: ${command}`);
  assert.ok(command.includes("herdr-worker.sh"), "wrapper path present");
  assert.ok(!command.includes("Do the thing"), "task NOT in launch command");

  // Rename happened after detection.
  const renameCall = world.calls.find((c) => c.args[0] === "agent" && c.args[1] === "rename")!;
  assert.equal(renameCall.args[3], "otto");

  // Prompt delivered the task.
  assert.deepEqual(world.promptText, ["Do the thing"]);

  // Ownership recorded with plain JSON fields.
  const owned = svc.getOwned();
  assert.equal(owned.length, 1);
  assert.equal(owned[0].pane_id, r.pane_id);
  assert.equal(owned[0].name, "otto");
  assert.equal(owned[0].workspace_id, "wF");
  assert.ok(owned[0].terminal_id?.startsWith("term_"));
  assert.equal(typeof owned[0].launched_at, "number");
});

test("start: cwd must be an existing absolute directory", async () => {
  const world = new FakeWorld();
  const svc = makeService(world);
  const r = await svc.execute("start", { name: "a", cwd: "/no/such/dir/xyz", task: "t" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "invalid_cwd");
  assert.equal(r.phase, "validation");
  assert.equal(world.calls.length, 0, "no herdr calls before validation");
});

test("start: name validation", async () => {
  const world = new FakeWorld();
  const svc = makeService(world);
  const r = await svc.execute("start", { name: "Bad NAME!", cwd: process.cwd(), task: "t" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "invalid_name");
});

test("start: mode validation", async () => {
  const world = new FakeWorld();
  const svc = makeService(world);
  const r = await svc.execute("start", { name: "a", cwd: process.cwd(), mode: "sudo", task: "t" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "invalid_mode");
});

test("start: task required", async () => {
  const world = new FakeWorld();
  const svc = makeService(world);
  const r = await svc.execute("start", { name: "a", cwd: process.cwd(), task: "" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "task_required");
});

test("start: runtime missing -> runtime_missing, no mutation", async () => {
  ensureScriptsDir();
  const world = new FakeWorld();
  world.addPanes(["wF:p1"], "wF");
  const svc = makeService(world, {}, { runtimeDir: "/no/such/runtime" });
  const r = await svc.execute("start", { name: "a", cwd: process.cwd(), task: "t" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "runtime_missing");
  assert.equal(r.phase, "validation");
  assert.equal(world.calls.length, 0);
});

test("start: missing herdr context", async () => {
  ensureScriptsDir();
  const world = new FakeWorld();
  const svc = makeService(world, { paneId: undefined });
  const r = await svc.execute("start", { name: "a", cwd: process.cwd(), task: "t" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "herdr_context_missing");
});

test("start: timeout ceiling enforced", async () => {
  const world = new FakeWorld();
  const svc = makeService(world);
  const r = await svc.execute("start", {
    name: "a", cwd: process.cwd(), task: "t",
    waitMode: "finish", timeoutMs: 999_999_999,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "timeout_too_large");
});

// ---------------------------------------------------------------------------
// start: detection failures
// ---------------------------------------------------------------------------

test("start: detection timeout returns pane, never retries launch", async () => {
  ensureScriptsDir();
  const world = new FakeWorld();
  world.addPanes(["wF:p1"], "wF");
  world.detectionDelays.set("wF:p2", 1_000_000);
  const svc = makeService(world);
  const r = await svc.execute("start", {
    name: "a", cwd: process.cwd(), task: "t",
    waitMode: "none",
  });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "detection_timeout");
  assert.equal(r.phase, "detection");
  assert.equal(r.code, "agent_not_found");
  assert.ok(r.pane_id, "pane id surfaced for inspection");
  const runCalls = world.calls.filter((c) => c.args[0] === "pane" && c.args[1] === "run");
  assert.equal(runCalls.length, 1, "exactly one launch, no duplicate/retry");
});

test("start: malformed split (no valid result.pane) -> split_malformed, no launch, no ownership", async () => {
  const world = new FakeWorld();
  world.addPanes(["wF:p1"], "wF");
  ensureScriptsDir();
  const base = makeTransport(world);
  const svc = new SubagentService({
    transport: {
      async run(args: string[], options?: TransportOptions) {
        if (args[0] === "pane" && args[1] === "split") {
          // No valid single-object pane: return a result without result.pane.
          return {
            exitCode: 0,
            stdout: JSON.stringify({ id: "cli:pane:split", result: { type: "pane_info" } }),
            stderr: "",
          };
        }
        return base.run(args, options);
      },
    },
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
    defaults: { detectionMs: 1000 },
  });
  const r = await svc.execute("start", { name: "a", cwd: process.cwd(), task: "t" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "split_malformed");
  const runCalls = world.calls.filter((c) => c.args[1] === "run");
  assert.equal(runCalls.length, 0, "no launch on malformed split");
});

test("start: wrong-workspace split -> split_workspace_mismatch, not adopted", async () => {
  const world = new FakeWorld();
  world.addPanes(["wF:p1"], "wF");
  ensureScriptsDir();
  const base = makeTransport(world);
  const svc = new SubagentService({
    transport: {
      async run(args: string[], options?: TransportOptions) {
        if (args[0] === "pane" && args[1] === "split") {
          // Split landed in a DIFFERENT workspace than the supervisor.
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              id: "cli:pane:split",
              result: {
                type: "pane_info",
                pane: { pane_id: "wOTHER:p9", workspace_id: "wOTHER", terminal_id: "term_x" },
              },
            }),
            stderr: "",
          };
        }
        return base.run(args, options);
      },
    },
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
    defaults: { detectionMs: 1000 },
  });
  const r = await svc.execute("start", { name: "a", cwd: process.cwd(), task: "t" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "split_workspace_mismatch");
  const runCalls = world.calls.filter((c) => c.args[1] === "run");
  assert.equal(runCalls.length, 0, "no launch on wrong-workspace split");
});

test("start: records pending with terminal_id from the split object (before launch)", async () => {
  const world = new FakeWorld();
  world.addPanes(["wF:p1"], "wF");
  ensureScriptsDir();
  const base = makeTransport(world);
  const svc = new SubagentService({
    transport: {
      async run(args: string[], options?: TransportOptions) {
        return base.run(args, options);
      },
    },
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
    defaults: { detectionMs: 1000 },
  });
  const r = await svc.execute("start", { name: "a", cwd: process.cwd(), task: "t" });
  assert.equal(r.ok, true);
  // The split object carried terminal_id "term_split_2" (splitPaneCounter starts
  // at 1); the pending record recorded it immediately. We verify it survived to
  // the promoted record.
  assert.equal((r as { pane_id?: string }).pane_id, "wF:p2");
  // Internal check: the owned record now has a terminal_id from the split.
  const owned = (svc as unknown as { owned: Map<string, { terminal_id?: string; pending: boolean }> }).owned;
  const paneId = (r as { pane_id: string }).pane_id;
  const rec = owned.get(paneId);
  assert.ok(rec, "owned record exists");
  assert.equal(rec.terminal_id, "term_split_2", "terminal_id recorded from the split object");
  assert.equal(rec.pending, false, "promoted to verified");
});

test("start: launch fails and close is unverified -> ownership RETAINED (pane stays owned)", async () => {
  const world = new FakeWorld();
  world.addPanes(["wF:p1"], "wF");
  ensureScriptsDir();
  // Make `pane run` fail (launch error) and `pane close` fail with a
  // NON-typed server error (so absence is UNVERIFIED).
  world.failCommands.push({ match: /^pane run /, code: "internal_error", message: "boom" });
  world.failCommands.push({ match: /^pane close /, code: "internal_error", message: "boom" });
  const svc = makeService(world);
  const r = await svc.execute("start", { name: "a", cwd: process.cwd(), task: "t" });
  assert.equal(r.ok, false);
  assert.equal(r.phase, "launch");
  // Absence unverified: the pane must remain owned, not dropped.
  const owned = svc.getOwned();
  assert.equal(owned.length, 1, "ownership retained when close is unverified");
  assert.equal(owned[0].pane_id, r.pane_id);
});

test("start: launch fails but close verifies the pane is gone -> ownership released", async () => {
  const world = new FakeWorld();
  world.addPanes(["wF:p1"], "wF");
  ensureScriptsDir();
  // `pane run` fails (launch error); `pane close` succeeds -> the pane is gone
  // (verified). Ownership should be released, not left orphaned.
  world.failCommands.push({ match: /^pane run /, code: "internal_error", message: "boom" });
  const svc = makeService(world);
  const r = await svc.execute("start", { name: "a", cwd: process.cwd(), task: "t" });
  assert.equal(r.ok, false);
  assert.equal(r.phase, "launch");
  const owned = svc.getOwned();
  assert.equal(owned.length, 0, "ownership released when close verifies the pane is gone");
});

// ---------------------------------------------------------------------------
// prompt: preflight, serialization, outcomes
// ---------------------------------------------------------------------------

function worldWithWorker() {
  const world = new FakeWorld();
  world.addPanes(["wF:p1"], "wF");
  world.addAgent("wF:p9", "wF", { status: "idle" });
  return world;
}

test("prompt: happy path none -> submitted", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
  const r = await svc.execute("prompt", { target: "wF:p9", task: "hello", waitMode: "none" });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "submitted");
  assert.equal(r.code, "agent_prompted");
  assert.equal(typeof r.continuation, "string", "submission receipt returns an opaque continuation");
  assert.deepEqual(world.promptText, ["hello"]);
});

test("prompt: refuses working target", async () => {
  const world = worldWithWorker();
  world.agents.get("wF:p9")!.status = "working";
  const svc = makeService(world);
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
  const r = await svc.execute("prompt", { target: "wF:p9", task: "hi" });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "prompt_refused");
  assert.equal(r.code, "agent_working");
  assert.deepEqual(world.promptText, []);
});

test("prompt: refuses blocked target", async () => {
  const world = worldWithWorker();
  world.agents.get("wF:p9")!.status = "blocked";
  const svc = makeService(world);
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
  const r = await svc.execute("prompt", { target: "wF:p9", task: "hi" });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "prompt_refused");
  assert.equal(r.code, "agent_blocked");
});

test("prompt: stalled -> stalled outcome with tail, no auto-resend", async () => {
  const world = worldWithWorker();
  world.promptOutcomes.set("wF:p9", "stalled");
  const base = makeTransport(world);
  const svc = new SubagentService({
    transport: {
      async run(args: string[], options?: TransportOptions) {
        if (args[0] === "agent" && args[1] === "prompt") {
          // Simulate the live race: the agent starts working right after
          // submission, then the CLI reports agent_prompt_stalled.
          world.agents.get("wF:p9")!.status = "working";
          world.agents.get("wF:p9")!.seq += 1;
          await new Promise((res) => setTimeout(res, 200));
        }
        return base.run(args, options);
      },
    },
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
    defaults: { detectionMs: 500, boundedWaitMs: 4000, finishWaitMs: 5000, maxWaitMs: 60_000 },
  });
  ensureScriptsDir();
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
  const r = await svc.execute("prompt", { target: "wF:p9", task: "hi", waitMode: "bounded" });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "stalled");
  assert.equal(r.code, "agent_prompt_stalled");
  assert.ok(r.tail?.includes("worker output"), "tail included on stall");
  assert.equal(typeof r.continuation, "string", "stall returns an opaque continuation");

  // The continuation carries the sampled working evidence (working was
  // observed right after submission). Verify by waiting: since the agent is
  // still working (no terminal yet), wait should report working/timeout, but
  // the recorded evidence must be working (not fabricated).
  const cont = r.continuation!;
  world.agents.get("wF:p9")!.status = "working";
  const w = await svc.execute("wait", { target: "wF:p9", continuation: cont, timeoutMs: 30 });
  // The wait should not claim terminal_observed_after_working unless a
  // terminal state was actually observed. It either times out or reports
  // activity; it must not fabricate working evidence.
  assert.equal(w.ok, false, "a still-working target cannot be a successful terminal observation");
  assert.notEqual(w.outcome, "terminal_observed_after_working");
});

test("prompt: forged continuation id is rejected, never minted", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
  // A forged/unknown continuation id cannot create working evidence.
  const r = await svc.execute("wait", { target: "wF:p9", continuation: "cont_forged_000", timeoutMs: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "unknown_continuation");
  assert.equal(r.phase, "validation");
  assert.notEqual(r.outcome, "terminal_observed_after_working", "forged id cannot imply a new turn");
});

test("wait: stale terminal wait without continuation is labelled snapshot, not a new turn", async () => {
  const world = worldWithWorker();
  world.agents.get("wF:p9")!.status = "done"; // already terminal
  const svc = makeService(world);
  const r = await svc.execute("wait", { target: "wF:p9", timeoutMs: 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "terminal_observed");
  assert.equal(r.code, "snapshot", "no baseline -> snapshot, cannot imply a new turn");
  assert.equal(r.continuation, undefined, "snapshot wait returns no continuation");
});

test("wait: blocked snapshot -> needs_attention", async () => {
  const world = worldWithWorker();
  world.agents.get("wF:p9")!.status = "blocked";
  const svc = makeService(world);
  const r = await svc.execute("wait", { target: "wF:p9", timeoutMs: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "needs_attention");
  assert.equal(r.status, "blocked");
});

test("wait: working agent times out -> timeout with tail, worker not killed", async () => {
  const world = worldWithWorker();
  world.agents.get("wF:p9")!.status = "working";
  world.scripts.set("wF:p9", ["working", "TIMEOUT"]);
  const svc = makeService(world);
  const r = await svc.execute("wait", { target: "wF:p9", timeoutMs: 50 });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "timeout");
  assert.equal(r.code, "timeout");
  assert.ok(r.tail?.includes("worker output"));
  assert.equal(world.agents.get("wF:p9")!.alive, true, "worker still alive after timeout");
  const waitCall = world.calls.find((c) => c.args[0] === "agent" && c.args[1] === "wait")!;
  const untils = waitCall.args.flatMap((a, i) => (a === "--until" ? [waitCall.args[i + 1]] : []));
  assert.deepEqual(untils, ["idle", "done", "blocked"]);
});

test("wait: continuation on stale same-seq terminal does not shortcut completion", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  const a = world.agents.get("wF:p9")!;
  a.status = "done";
  a.seq = 100;
  const cont = svc.registerContinuation({
    pane_id: "wF:p9",
    workspace_id: "wF",
    terminal_id: a.terminalId,
    baseline_seq: 100,
    delivery_confirmed: true,
    receipt_seq: 100,
    receipt_state: "done",
    working_observed: false,
    state: "done",
    seq: 100,
  });
  const r = await svc.execute("wait", { target: "wF:p9", continuation: cont, timeoutMs: 20 });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "timeout");
  assert.equal(r.code, "timeout");
  assert.notEqual(r.outcome, "terminal_observed");
});

test("wait: confirmed continuation samples working and only accepts a newer terminal", async () => {
  const world = worldWithWorker();
  ensureScriptsDir();
  const a = world.agents.get("wF:p9")!;
  a.status = "idle";
  a.seq = 234;
  const base = makeTransport(world);
  let getCount = 0;
  const svc = new SubagentService({
    transport: {
      async run(args: string[], options?: TransportOptions) {
        if (args[0] === "agent" && args[1] === "get" && args[2] === "wF:p9") {
          getCount += 1;
          if (getCount === 2) {
            a.status = "working";
            a.seq = 235;
          } else if (getCount === 3) {
            a.status = "done";
            a.seq = 236;
          }
        }
        return base.run(args, options);
      },
    },
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
  });
  const cont = svc.registerContinuation({
    pane_id: "wF:p9",
    workspace_id: "wF",
    terminal_id: a.terminalId,
    baseline_seq: 234,
    delivery_confirmed: true,
    receipt_seq: 234,
    receipt_state: "idle",
    working_observed: false,
    state: "idle",
    seq: 234,
  });
  const r = await svc.execute("wait", { target: "wF:p9", continuation: cont, timeoutMs: 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "terminal_observed_after_working");
  assert.equal(r.seq, 236);
  const state = getContinuationState(svc, cont)!;
  assert.equal(state.working_seq, 235, "actual sampled working is retained on the continuation");
  assert.equal(state.baseline_seq, 234, "baseline stays frozen");
  assert.equal(state.terminal_id, a.terminalId, "frozen terminal identity stays unchanged");
});

test("wait: confirmed continuation fast newer terminal without working sample stays observational", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  const a = world.agents.get("wF:p9")!;
  a.status = "done";
  a.seq = 236;
  const cont = svc.registerContinuation({
    pane_id: "wF:p9",
    workspace_id: "wF",
    terminal_id: a.terminalId,
    baseline_seq: 234,
    delivery_confirmed: true,
    receipt_seq: 234,
    receipt_state: "idle",
    working_observed: false,
    state: "idle",
    seq: 234,
  });
  const r = await svc.execute("wait", { target: "wF:p9", continuation: cont, timeoutMs: 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "terminal_observed");
  assert.ok(r.hint?.includes("confirmed delivery"));
  assert.notEqual(r.outcome, "terminal_observed_after_working");
});

test("wait: continuation timeout retains sampled working and frozen identity", async () => {
  const world = worldWithWorker();
  ensureScriptsDir();
  const a = world.agents.get("wF:p9")!;
  a.status = "idle";
  a.seq = 234;
  const base = makeTransport(world);
  let getCount = 0;
  const svc = new SubagentService({
    transport: {
      async run(args: string[], options?: TransportOptions) {
        if (args[0] === "agent" && args[1] === "get" && args[2] === "wF:p9") {
          getCount += 1;
          if (getCount === 2) {
            a.status = "working";
            a.seq = 235;
          }
        }
        return base.run(args, options);
      },
    },
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
  });
  const cont = svc.registerContinuation({
    pane_id: "wF:p9",
    workspace_id: "wF",
    terminal_id: a.terminalId,
    baseline_seq: 234,
    delivery_confirmed: true,
    receipt_seq: 234,
    receipt_state: "idle",
    working_observed: false,
    state: "idle",
    seq: 234,
  });
  const r = await svc.execute("wait", { target: "wF:p9", continuation: cont, timeoutMs: 250 });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "timeout");
  const state = getContinuationState(svc, cont)!;
  assert.equal(state.working_seq, 235, "sampled working is retained across timeout/re-wait");
  assert.equal(state.baseline_seq, 234, "baseline does not slide on timeout");
  assert.equal(state.workspace_id, "wF", "workspace identity stays frozen on timeout");
  assert.equal(state.terminal_id, a.terminalId, "terminal identity stays frozen on timeout");
});

test("wait: unconfirmed continuation never upgrades activity into own-task proof", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  const a = world.agents.get("wF:p9")!;
  a.status = "done";
  a.seq = 236;
  const cont = svc.registerContinuation({
    pane_id: "wF:p9",
    workspace_id: "wF",
    terminal_id: a.terminalId,
    baseline_seq: 234,
    delivery_confirmed: false,
    working_observed: true,
    working_seq: 235,
    state: "working",
    seq: 235,
  });
  const r = await svc.execute("wait", { target: "wF:p9", continuation: cont, timeoutMs: 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "terminal_observed");
  assert.ok(r.hint?.includes("delivery was not confirmed"));
  assert.notEqual(r.outcome, "terminal_observed_after_working");
});

test("wait: continuation cancellation mid-poll is cancelled, not timeout", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  const a = world.agents.get("wF:p9")!;
  a.status = "idle";
  a.seq = 234;
  const cont = svc.registerContinuation({
    pane_id: "wF:p9",
    workspace_id: "wF",
    terminal_id: a.terminalId,
    baseline_seq: 234,
    delivery_confirmed: true,
    receipt_seq: 234,
    receipt_state: "idle",
    working_observed: false,
    state: "idle",
    seq: 234,
  });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10);
  try {
    const r = await svc.execute("wait", { target: "wF:p9", continuation: cont, timeoutMs: 1000 }, ac.signal);
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "cancelled");
    assert.equal(r.code, "aborted");
  } finally {
    clearTimeout(timer);
  }
});

test("wait: continuation terminal drift mid-poll -> identity error", async () => {
  const world = worldWithWorker();
  ensureScriptsDir();
  const a = world.agents.get("wF:p9")!;
  a.status = "idle";
  a.seq = 234;
  const base = makeTransport(world);
  let getCount = 0;
  const svc = new SubagentService({
    transport: {
      async run(args: string[], options?: TransportOptions) {
        if (args[0] === "agent" && args[1] === "get" && args[2] === "wF:p9") {
          getCount += 1;
          if (getCount === 2) {
            a.terminalId = "term_reused_live";
            a.seq = 235;
          }
        }
        return base.run(args, options);
      },
    },
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
  });
  const cont = svc.registerContinuation({
    pane_id: "wF:p9",
    workspace_id: "wF",
    terminal_id: "term_wFp9",
    baseline_seq: 234,
    delivery_confirmed: true,
    receipt_seq: 234,
    receipt_state: "idle",
    working_observed: false,
    state: "idle",
    seq: 234,
  });
  const r = await svc.execute("wait", { target: "wF:p9", continuation: cont, timeoutMs: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "identity_mismatch");
  assert.equal(r.phase, "identity");
});

test("wait: continuation workspace drift mid-poll -> identity error", async () => {
  const world = worldWithWorker();
  ensureScriptsDir();
  const a = world.agents.get("wF:p9")!;
  a.status = "idle";
  a.seq = 234;
  const base = makeTransport(world);
  let getCount = 0;
  const svc = new SubagentService({
    transport: {
      async run(args: string[], options?: TransportOptions) {
        if (args[0] === "agent" && args[1] === "get" && args[2] === "wF:p9") {
          getCount += 1;
          if (getCount === 2) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                id: "cli:agent:get",
                result: {
                  type: "agent_info",
                  agent: {
                    agent: "pi",
                    agent_status: "idle",
                    state_change_seq: 235,
                    pane_id: "wF:p9",
                    workspace_id: "wOTHER",
                    terminal_id: a.terminalId,
                    name: a.name,
                  },
                },
              }),
              stderr: "",
            };
          }
        }
        return base.run(args, options);
      },
    },
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
  });
  const cont = svc.registerContinuation({
    pane_id: "wF:p9",
    workspace_id: "wF",
    terminal_id: a.terminalId,
    baseline_seq: 234,
    delivery_confirmed: true,
    receipt_seq: 234,
    receipt_state: "idle",
    working_observed: false,
    state: "idle",
    seq: 234,
  });
  const r = await svc.execute("wait", { target: "wF:p9", continuation: cont, timeoutMs: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "identity_mismatch");
  assert.equal(r.phase, "identity");
});

test("prompt: blocked result != completion", async () => {
  const world = worldWithWorker();
  // Prompt returns ok but lands in blocked.
  ensureScriptsDir();
  const base = makeTransport(world);
  const svc = new SubagentService({
    transport: {
      async run(args: string[], options?: TransportOptions) {
        if (args[0] === "agent" && args[1] === "prompt") {
          const a = world.agents.get(args[2]!)!;
          a.status = "blocked";
          a.seq += 1;
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              id: "cli:agent:prompt",
              result: { type: "agent_prompted", agent: { agent_status: "blocked", state_change_seq: a.seq, pane_id: args[2], workspace_id: "wF" } },
            }),
            stderr: "",
          };
        }
        return base.run(args, options);
      },
    },
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
    defaults: { detectionMs: 500, boundedWaitMs: 4000, finishWaitMs: 5000, maxWaitMs: 60_000 },
  });
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
  const r = await svc.execute("prompt", { target: "wF:p9", task: "write x", waitMode: "bounded" });
  assert.equal(r.ok, false, "blocked is never ok");
  assert.equal(r.outcome, "needs_attention");
  assert.equal(r.status, "blocked");
});

test("prompt: parallel submissions serialize per target", async () => {
  ensureScriptsDir();
  const world = worldWithWorker();
  const svc = makeService(world);
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
  let overlap = false;
  let inFlight = 0;
  const base = makeTransport(world);
  const svc2 = new SubagentService({
    transport: {
      async run(args: string[], options?: TransportOptions) {
        if (args[0] === "agent" && args[1] === "prompt") {
          inFlight += 1;
          if (inFlight > 1) overlap = true;
          await new Promise((res) => setTimeout(res, 30));
          inFlight -= 1;
          return base.run(args, options);
        }
        return base.run(args, options);
      },
    },
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
    defaults: { detectionMs: 500, boundedWaitMs: 4000, finishWaitMs: 5000, maxWaitMs: 60_000 },
  });
  svc2.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
  await Promise.all([
    svc2.execute("prompt", { target: "wF:p9", task: "one" }),
    svc2.execute("prompt", { target: "wF:p9", task: "two" }),
  ]);
  assert.equal(overlap, false, "submissions to the same target never run concurrently");
  assert.deepEqual(world.promptText, ["one", "two"]);
});

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

test("read: lifecycle-aware with unicode tail bounds", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  const r = await svc.execute("read", { target: "wF:p9" });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "read");
  assert.equal(r.tail, "worker output 🧵🧵 end");
});

test("read: char tail counts code points, not bytes/surrogates", async () => {
  ensureScriptsDir();
  const world = worldWithWorker();
  const base = makeTransport(world);
  const svc = new SubagentService({
    transport: {
      async run(args: string[], options?: TransportOptions) {
        if (args[0] === "agent" && args[1] === "read") {
          // 10 emoji = 10 code points, 40 bytes.
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              id: "cli:agent:read",
              result: { type: "read", text: "🧵".repeat(10) },
            }),
            stderr: "",
          };
        }
        return base.run(args, options);
      },
    },
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
  });
  const r = await svc.execute("read", { target: "wF:p9", maxChars: 4 });
  assert.equal(r.ok, true);
  assert.equal(r.tail, "🧵🧵🧵🧵", "tail is 4 code points, not truncated mid-surrogate");
  assert.equal([...r.tail!].length, 4);
});

test("read: raw fallback uses pane read", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  const r = await svc.execute("read", { target: "wF:p9", raw: true });
  assert.equal(r.ok, true);
  const readCall = world.calls.find((c) => c.args[0] === "pane" && c.args[1] === "read")!;
  assert.ok(readCall);
  assert.ok(r.tail?.includes("raw-output"));
});

// ---------------------------------------------------------------------------
// send / interrupt
// ---------------------------------------------------------------------------

test("send: owned pane, text+Enter via pane run", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
  const r = await svc.execute("send", { target: "wF:p9", text: "ls" });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "sent");
  const runCall = world.calls.find((c) => c.args[0] === "pane" && c.args[1] === "run")!;
  assert.deepEqual(runCall.args.slice(2, 4), ["wF:p9", "ls"]);
});

test("send: multi-line rejected (unverified in 0.9.3)", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  const r = await svc.execute("send", { target: "wF:p9", text: "line1\nline2" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "multiline_unverified");
});

test("send: external pane requires allowExternal and stays in workspace", async () => {
  const world = worldWithWorker();
  world.addAgent("wF:p77", "wF");
  const svc = makeService(world);
  const denied = await svc.execute("send", { target: "wF:p77", text: "ls" });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "external_target");
  const allowed = await svc.execute("send", { target: "wF:p77", text: "ls", allowExternal: true });
  assert.equal(allowed.ok, true);
});

test("send: external pane in another workspace is denied even with opt-in", async () => {
  const world = worldWithWorker();
  world.addAgent("wZ:p1", "wZ");
  const svc = makeService(world);
  const r = await svc.execute("send", { target: "wZ:p1", text: "ls", allowExternal: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, "outside_workspace");
});

test("interrupt: uses esc, never ctrl+d", async () => {
  const world = worldWithWorker();
  world.agents.get("wF:p9")!.status = "working";
  const svc = makeService(world);
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
  const r = await svc.execute("interrupt", { target: "wF:p9" });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "interrupted");
  const keysCall = world.calls.find((c) => c.args[0] === "pane" && c.args[1] === "send-keys")!;
  assert.equal(keysCall.args[3], "esc");
  assert.ok(!world.calls.some((c) => c.args.includes("ctrl+d")), "ctrl+d never sent");
});

test("self-control denied for send/interrupt/close/prompt", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  for (const [op, args] of [
    ["send", { target: "wF:p1", text: "x" }],
    ["interrupt", { target: "wF:p1" }],
    ["close", { target: "wF:p1" }],
    ["prompt", { target: "wF:p1", task: "x" }],
  ] as const) {
    const r = await svc.execute(op, { ...args });
    assert.equal(r.ok, false, `${op} self-control`);
    assert.equal(r.outcome, "denied", `${op} self-control`);
    assert.equal(r.code, "self_control", `${op} self-control`);
  }
});

// ---------------------------------------------------------------------------
// ownership: verification, reload, id reuse
// ---------------------------------------------------------------------------

test("ownership: live verification passes for matching identity", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  const a = world.agents.get("wF:p9")!;
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF", terminal_id: a.terminalId, name: "otto" }]);
  world.agents.get("wF:p9")!.name = "otto";
  const r = await svc.execute("read", { target: "wF:p9" });
  assert.equal(r.ok, true);
  assert.equal(svc.getOwned().length, 1, "ownership retained after verified use");
});

test("ownership: renamed away -> ownership lost, control denied", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  const a = world.agents.get("wF:p9")!;
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF", terminal_id: a.terminalId, name: "otto" }]);
  world.agents.get("wF:p9")!.name = "someone_else";
  const r = await svc.execute("interrupt", { target: "wF:p9" });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "ownership_lost");
  assert.equal(r.code, "name_mismatch");
  assert.equal(svc.getOwned().length, 0, "stale record removed");
});

test("ownership: terminal id reuse -> not owned", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF", terminal_id: "term_original" }]);
  const r = await svc.execute("interrupt", { target: "wF:p9" });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "ownership_lost");
  assert.equal(r.code, "terminal_id_mismatch");
});

test("ownership: agent undetectable (dead worker) -> not owned", async () => {
  const world = worldWithWorker();
  world.killAgent("wF:p9");
  const svc = makeService(world);
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
  const r = await svc.execute("interrupt", { target: "wF:p9" });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "ownership_lost");
  assert.equal(r.code, "agent_not_detected");
});

test("ownership: reload/restore round-trip", async () => {
  ensureScriptsDir();
  const world = worldWithWorker();
  const svc = makeService(world);
  const a = world.agents.get("wF:p9")!;
  svc.restoreOwned([
    { pane_id: "wF:p9", workspace_id: "wF", terminal_id: a.terminalId, name: "otto", launched_at: 123, session: "wF:p1" },
    { pane_id: "wF:p1", workspace_id: "wF" },
    "garbage",
    null,
    { pane_id: "no-workspace" },
  ]);
  assert.equal(svc.getOwned().length, 2, "invalid records skipped");
  const reloaded = new SubagentService({
    transport: makeTransport(world),
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
  });
  reloaded.restoreOwned(svc.getOwned());
  assert.deepEqual(
    reloaded.getOwned().map((r) => r.pane_id).sort(),
    ["wF:p1", "wF:p9"],
  );
});

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

test("close: owned pane, idempotent + absence verified", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
  const r = await svc.execute("close", { target: "wF:p9" });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "closed");
  assert.equal(svc.getOwned().length, 0, "ownership record removed");
  const closeCallsAfterFirst = world.calls.filter((c) => c.args[0] === "pane" && c.args[1] === "close").length;
  // Second close: already-gone tombstone should still return success without
  // needing new external opt-in.
  const r2 = await svc.execute("close", { target: "wF:p9" });
  assert.equal(r2.ok, true);
  assert.equal(r2.outcome, "closed");
  assert.equal(r2.code, "pane_not_found", "idempotent close of a gone pane is success");
  const closeCallsAfterSecond = world.calls.filter((c) => c.args[0] === "pane" && c.args[1] === "close").length;
  assert.equal(closeCallsAfterSecond, closeCallsAfterFirst, "repeated close of a retired id does not issue a new pane close");
});

test("close: tombstoned id that reappears requires externalConfirmed", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
  const first = await svc.execute("close", { target: "wF:p9" });
  assert.equal(first.ok, true);
  world.addAgent("wF:p9", "wF");
  const closeCallsBeforeDenied = world.calls.filter((c) => c.args[0] === "pane" && c.args[1] === "close").length;
  const denied = await svc.execute("close", { target: "wF:p9" });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "external_target");
  const closeCallsAfterDenied = world.calls.filter((c) => c.args[0] === "pane" && c.args[1] === "close").length;
  assert.equal(closeCallsAfterDenied, closeCallsBeforeDenied, "reused retired id is not closed without fresh external opt-in");
  const allowed = await svc.execute("close", { target: "wF:p9", externalConfirmed: true });
  assert.equal(allowed.ok, true);
});

test("close: retired probe server failure does not claim absence or authorize mutation", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
  const first = await svc.execute("close", { target: "wF:p9" });
  assert.equal(first.ok, true);
  world.failCommands.push({ match: /^pane get wF:p9$/, code: "server_not_running", message: "no server" });
  const closeCallsBefore = world.calls.filter((c) => c.args[0] === "pane" && c.args[1] === "close").length;
  const r = await svc.execute("close", { target: "wF:p9" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "server_not_running");
  const closeCallsAfter = world.calls.filter((c) => c.args[0] === "pane" && c.args[1] === "close").length;
  assert.equal(closeCallsAfter, closeCallsBefore, "failed retired probe does not proceed to pane close");
});

test("close: external pane requires externalConfirmed", async () => {
  const world = worldWithWorker();
  world.addAgent("wF:p77", "wF");
  const svc = makeService(world);
  const denied = await svc.execute("close", { target: "wF:p77" });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "external_target");
  const allowed = await svc.execute("close", { target: "wF:p77", externalConfirmed: true });
  assert.equal(allowed.ok, true);
});

test("close: server error does NOT claim absence, ownership retained", async () => {
  const world = worldWithWorker();
  // The close call itself fails with a server error (not pane_not_found).
  world.failCommands.push({ match: /^pane close wF:p9/, code: "server_not_running", message: "no server" });
  const svc = makeService(world);
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
  const r = await svc.execute("close", { target: "wF:p9" });
  assert.equal(r.ok, false, "server error is never a success");
  assert.notEqual(r.outcome, "closed", "must not claim the pane is closed");
  assert.equal(r.code, "server_not_running");
  assert.equal(svc.getOwned().some((o) => o.pane_id === "wF:p9"), true, "ownership retained on server error");
});

test("close: non-typed verify failure (server down) retains ownership, no absence claim", async () => {
  const world = worldWithWorker();
  // Only the POST-close absence verify sees the server error; the ownership
  // access-check (an earlier `pane get`) must succeed so close actually runs.
  let serverDown = false;
  const base = makeTransport(world);
  const svc = new SubagentService({
    transport: {
      async run(args: string[], options?: TransportOptions) {
        if (args[0] === "pane" && args[1] === "close") {
          const r = await base.run(args, options);
          // After close succeeds, the server goes down: the subsequent
          // `pane get` (absence verify) now returns a non-typed server error.
          serverDown = true;
          return r;
        }
        if (serverDown && args[0] === "pane" && args[1] === "get") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({ error: { code: "server_not_running", message: "no server" } }),
          };
        }
        return base.run(args, options);
      },
    },
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
  });
  ensureScriptsDir();
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
  const r = await svc.execute("close", { target: "wF:p9" });
  assert.equal(r.ok, false, "unverified absence is not a success");
  assert.equal(r.outcome, "error");
  assert.equal(r.phase, "verify");
  assert.equal(r.code, "server_not_running");
  assert.equal(svc.getOwned().some((o) => o.pane_id === "wF:p9"), true, "ownership retained when absence unverified");
});

// ---------------------------------------------------------------------------
// list / spaces
// ---------------------------------------------------------------------------

test("list: joins agent names/status by pane id", async () => {
  const world = worldWithWorker();
  world.agents.get("wF:p9")!.name = "otto";
  world.agents.get("wF:p9")!.status = "working";
  const svc = makeService(world);
  const r = await svc.execute("list", {});
  assert.equal(r.ok, true);
  assert.equal(r.phase, "list");
  const items = JSON.parse(r.detail!) as Array<{ pane_id: string; name: string | null; agent_status: string }>;
  const p9 = items.find((i) => i.pane_id === "wF:p9")!;
  assert.equal(p9.name, "otto");
  assert.equal(p9.agent_status, "working");
  const p1 = items.find((i) => i.pane_id === "wF:p1")!;
  assert.equal(p1.name, null, "unrenamed pane has null name");
});

test("spaces: workspace list mapped to plain JSON", async () => {
  const world = worldWithWorker();
  world.addPanes(["wZ:p1"], "wZ");
  const svc = makeService(world);
  const r = await svc.execute("spaces", {});
  assert.equal(r.ok, true);
  const items = JSON.parse(r.detail!) as Array<{ workspace_id: string; label: string | null }>;
  const ids = items.map((i) => i.workspace_id).sort();
  assert.ok(ids.includes("wF") && ids.includes("wZ"));
  for (const item of items) {
    assert.equal(typeof JSON.stringify(item), "string");
  }
});

// ---------------------------------------------------------------------------
// cancellation
// ---------------------------------------------------------------------------

test("abort: pre-call abort -> cancelled, no herdr call", async () => {
  const world = worldWithWorker();
  world.agents.get("wF:p9")!.status = "unknown";
  const svc = makeService(world);
  const controller = new AbortController();
  controller.abort();
  const r = await svc.execute("read", { target: "wF:p9" }, controller.signal);
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "cancelled");
  assert.equal(r.code, "aborted");
  assert.equal(world.calls.length, 0, "aborted before any herdr call");
});

test("abort: abort during wait -> cancelled, worker untouched", async () => {
  ensureScriptsDir();
  const world = worldWithWorker();
  world.agents.get("wF:p9")!.status = "working";
  const svc = makeService(world);
  const controller = new AbortController();
  const base = makeTransport(world);
  const svc2 = new SubagentService({
    transport: {
      async run(args: string[], options?: TransportOptions) {
        if (args[0] === "agent" && args[1] === "wait") {
          await new Promise<void>((resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
            setTimeout(resolve, 500);
          });
        }
        return base.run(args, options);
      },
    },
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
    defaults: { detectionMs: 500, finishWaitMs: 5000, maxWaitMs: 60_000 },
  });
  const p = svc2.execute("wait", { target: "wF:p9", timeoutMs: 4000 }, controller.signal);
  setTimeout(() => controller.abort(), 50);
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "cancelled");
  assert.equal(r.code, "aborted");
  assert.equal(world.agents.get("wF:p9")!.alive, true, "worker not touched by cancellation");
});

test("abort: abort during detection -> cancelled with pane surfaced", async () => {
  ensureScriptsDir();
  const world = new FakeWorld();
  world.addPanes(["wF:p1"], "wF");
  world.detectionDelays.set("wF:p2", 1_000_000);
  const svc = makeService(world);
  const controller = new AbortController();
  const p = svc.execute(
    "start",
    { name: "a", cwd: process.cwd(), task: "t", waitMode: "none" },
    controller.signal,
  );
  setTimeout(() => controller.abort(), 80);
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "cancelled");
  assert.equal(r.phase, "detection");
  assert.ok(r.pane_id, "pane id kept available for inspection");
});

// ---------------------------------------------------------------------------
// error mapping
// ---------------------------------------------------------------------------

test("errors: typed herdr errors surface as structured codes", async () => {
  const world = worldWithWorker();
  world.failCommands.push({ match: /^workspace list/, code: "server_not_running", message: "no server" });
  const svc = makeService(world);
  const r = await svc.execute("spaces", {});
  assert.equal(r.ok, false);
  assert.equal(r.code, "server_not_running");
  assert.ok(r.hint?.includes("herdr server"), "actionable hint for server_not_running");
});

test("errors: spawn failure -> transport_error", async () => {
  ensureScriptsDir();
  const world = new FakeWorld();
  const svc = new SubagentService({
    transport: {
      async run(): Promise<TransportResult> {
        throw new Error("spawn herdr ENOENT");
      },
    },
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
  });
  const r = await svc.execute("spaces", {});
  assert.equal(r.ok, false);
  assert.equal(r.code, "transport_error");
  assert.equal(r.outcome, "error");
});

// ---------------------------------------------------------------------------
// defaults
// ---------------------------------------------------------------------------

test("defaults: match plan (detection 15s, bounded 30s, finish 30min, max 60min, tails)", () => {
  assert.equal(DEFAULTS.detectionMs, 15_000);
  assert.equal(DEFAULTS.boundedWaitMs, 30_000);
  assert.equal(DEFAULTS.finishWaitMs, 30 * 60_000);
  assert.equal(DEFAULTS.maxWaitMs, 60 * 60_000);
  assert.equal(DEFAULTS.tailBoundedChars, 50);
  assert.equal(DEFAULTS.tailWaitChars, 2000);
  assert.equal(DEFAULTS.readLines, 100);
});

// ---------------------------------------------------------------------------
// sampler / listener cleanup (bounded prompt does not poll forever)
// ---------------------------------------------------------------------------

test("prompt: sampler is reaped when the bounded prompt returns (no 30-min polling)", async () => {
  const world = worldWithWorker();
  let getAfterPrompt = 0;
  let promptReturned = false;
  const base = makeTransport(world);
  const svc = new SubagentService({
    transport: {
      async run(args: string[], options?: TransportOptions) {
        if (args[0] === "agent" && args[1] === "get" && promptReturned) {
          // Count sampler get calls issued AFTER the prompt returned.
          getAfterPrompt += 1;
        }
        if (args[0] === "agent" && args[1] === "prompt") {
          const r = await base.run(args, options);
          promptReturned = true;
          return r;
        }
        return base.run(args, options);
      },
    },
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
    defaults: { detectionMs: 500, boundedWaitMs: 200, finishWaitMs: 5000, maxWaitMs: 60_000 },
  });
  ensureScriptsDir();
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
  const r = await svc.execute("prompt", { target: "wF:p9", task: "hi", waitMode: "bounded", timeoutMs: 60_000 });
  assert.equal(r.ok, true, "bounded prompt reaches a terminal state");
  // Give any (incorrectly) running sampler a moment to poll, then assert it
  // did not.
  await new Promise((res) => setTimeout(res, 400));
  assert.equal(getAfterPrompt, 0, "sampler stopped polling after the prompt returned");
});

// ---------------------------------------------------------------------------
// process transport (meaningful node:child_process tests)
// ---------------------------------------------------------------------------

import { HerdrTransport, TransportError } from "../src/transport.js";

test("transport: awaits close and captures stdout of a real command", async () => {
  const t = new HerdrTransport("node");
  const r = await t.run(["-e", "process.stdout.write('hello\\n')"], { timeoutMs: 5_000 });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, "hello\n");
  assert.equal(r.timedOut, false);
});

test("transport: a multi-byte UTF-8 char SPLIT across two delayed writes decodes correctly", async () => {
  // 🧵 is 4 bytes (f0 9f a7 b5). Written as two separate 2-byte chunks with a
  // delay, the sequence straddles a chunk boundary; a byte-slice decoder would
  // corrupt it, a shared StringDecoder must not.
  const fs = await import("node:fs");
  const file = `${process.cwd()}/.fk-split-${process.pid}.js`;
  fs.writeFileSync(file, `const b=Buffer.from([0xf0,0x9f,0xa7,0xb5]);\n` +
    `process.stdout.write(b.subarray(0,2));\n` +
    `setTimeout(()=>process.stdout.write(b.subarray(2)),30);\n`);
  const t = new HerdrTransport("node");
  try {
    const r = await t.run([file], { timeoutMs: 5_000 });
    assert.equal(r.stdout, "\u{1F9F5}", "cross-chunk multi-byte char decoded intact");
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("transport: finite timeout SIGKILLs a hanging command with a typed TimeoutError", async () => {
  const t = new HerdrTransport("node");
  await assert.rejects(
    () => t.run(["-e", "setTimeout(()=>{}, 30000)"], { timeoutMs: 300 }),
    (err: unknown) => err instanceof TransportError && err.name === "TimeoutError",
  );
});

test("transport: abort signal reaps the local process (typed AbortError)", async () => {
  const t = new HerdrTransport("node");
  const controller = new AbortController();
  const p = t.run(["-e", "setTimeout(()=>{}, 30000)"], { timeoutMs: 5_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(p, (err: unknown) => (err as Error).name === "AbortError");
});

test("transport: non-positive timeout is rejected before spawning", async () => {
  const t = new HerdrTransport("node");
  await assert.rejects(
    () => t.run(["-e", ""], { timeoutMs: 0 }),
    (err: unknown) => (err as Error).name === "SpawnError",
  );
});

test("transport: invalid maxBytes (non-positive / non-integer) is rejected before spawning", async () => {
  const t = new HerdrTransport("node");
  await assert.rejects(
    () => t.run(["-e", ""], { maxBytes: 0 }),
    (err: unknown) => (err as Error).name === "SpawnError",
  );
  await assert.rejects(
    () => t.run(["-e", ""], { maxBytes: 1.5 }),
    (err: unknown) => (err as Error).name === "SpawnError",
  );
});

test("transport: a non-existent command yields a typed SpawnError, not a false success", async () => {
  const t = new HerdrTransport("definitely-not-a-real-binary-xyz");
  const t0 = Date.now();
  await assert.rejects(
    () => t.run(["--version"], { timeoutMs: 5_000 }),
    (err: unknown) => err instanceof TransportError && err.name === "SpawnError",
  );
  // Must settle promptly (the error event fires), not hang to the timeout.
  assert.ok(Date.now() - t0 < 4_000, "spawn error settled without waiting for the timeout");
});

test("transport: repeated runs sharing one AbortSignal do not leak abort listeners", async () => {
  const t = new HerdrTransport("node");
  const controller = new AbortController();
  const sig = controller.signal;
  const count = (): number => (sig as unknown as { listenerCount?: (t: string) => number }).listenerCount?.("abort") ?? -1;
  const before = count();
  for (let i = 0; i < 5; i++) {
    await t.run(["-e", "process.stdout.write('x')"], { timeoutMs: 5_000, signal: sig });
  }
  const after = count();
  assert.equal(after, before, `abort listener count must not grow across runs (before=${before}, after=${after})`);
});

test("transport: combined stdout+stderr overflow kills + reaps a hanging producer promptly", async () => {
  // The producer keeps writing (hanging) but the COMBINED byte cap is small.
  // Overflow must kill+reap the child promptly (not wait out the timeout) and
  // report the overflow as the reason.
  const t = new HerdrTransport("node");
  const t0 = Date.now();
  await assert.rejects(
    () =>
      t.run(
        ["-e", "setInterval(()=>{process.stdout.write('x'.repeat(64));}, 10);"],
        { timeoutMs: 30_000, maxBytes: 512 },
      ),
    (err: unknown) => err instanceof TransportError && err.name === "OutputOverflowError",
  );
  assert.ok(Date.now() - t0 < 2_000, "overflow killed and reaped the child promptly, not on the timeout");
});

test("transport: a child killed by an external signal is NOT mislabelled a timeout", async () => {
  // A child killed by an arbitrary signal (SIGSEGV) that the transport never
  // sent must NOT be attributed to a timeout. Only the timer's own SIGKILL may
  // be labelled a TimeoutError. The child writes its pid to a scratch file so
  // we can kill it externally.
  const fs = await import("node:fs");
  const pidFile = `${process.cwd()}/.fk-pid-${process.pid}`;

  const t = new HerdrTransport("node");
  // The child prints its pid, writes the pid file, then hangs until killed.
  const script = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>{},60000);`;
  const p = t.run(["-e", script], { timeoutMs: 30_000 });

  // Wait until the pid file exists, then kill the child with SIGSEGV.
  let pid: number | null = null;
  for (let i = 0; i < 100 && pid === null; i++) {
    await new Promise((r) => setTimeout(r, 20));
    if (fs.existsSync(pidFile)) pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
  }
  assert.ok(pid !== null, "child wrote its pid");
  process.kill(pid!, "SIGSEGV"); // an arbitrary signal, not the transport's SIGKILL

  let outcome: string;
  try {
    await p;
    outcome = "resolved";
  } catch (err) {
    outcome = (err as Error).name;
  } finally {
    fs.rmSync(pidFile, { force: true });
  }
  assert.ok(
    outcome !== "TimeoutError",
    `an externally signalled child must not be a TimeoutError (got ${outcome})`,
  );
});

// ---------------------------------------------------------------------------
// error-envelope stream boundary (transport preserves streams; core decodes)
// ---------------------------------------------------------------------------

// The pinned live contract (docs/evidence/stageA_agent_probe.json):
//   success -> JSON envelope on stdout (code 0, stderr empty)
//   typed error -> JSON envelope on STDERR (code 1, stdout empty)
// The transport must preserve both raw streams; the core protocol boundary
// must decode the failure envelope from stderr and the success envelope from
// stdout. These regressions pin that split.

const RAW = { exitCode: 0, signal: null, stdout: "", stderr: "" };

function envWorld() {
  const w = new FakeWorld();
  w.addPanes(["wF:p1"], "wF");
  return w;
}

function serviceWithEnvelope(
  base: Transport,
  success?: { stdout: string; stderr?: string },
  failure?: { stdout?: string; stderr: string; code?: number },
) {
  return new SubagentService({
    transport: {
      async run(args: string[], _opts?: TransportOptions): Promise<TransportResult> {
        if (args[0] === "pane" && args[1] === "get" && args[2] === "wF:p9") {
          return {
            ...RAW,
            exitCode: 0,
            stdout: JSON.stringify({
              id: "cli:pane:get",
              result: {
                type: "pane_info",
                pane: { pane_id: "wF:p9", workspace_id: "wF", terminal_id: "term_env_p9" },
              },
            }),
          };
        }
        if (args[0] === "agent" && args[1] === "read" && args[2] === "wF:p9") {
          return {
            ...RAW,
            exitCode: success ? 0 : (failure?.code ?? 1),
            stdout: success ? success.stdout : (failure?.stdout ?? ""),
            stderr: success ? success.stderr ?? "" : failure!.stderr,
          };
        }
        return base.run(args, _opts);
      },
    },
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
  });
}

test("envelope: typed error on stderr (exit 1, empty stdout) decodes to the typed code", async () => {
  const world = envWorld();
  world.addAgent("wF:p9", "wF", { status: "idle" });
  const svc = serviceWithEnvelope(
    makeTransport(world),
    undefined,
    {
      stdout: "",
      stderr: JSON.stringify({ id: "cli:agent:get", error: { code: "agent_not_found", message: "agent target wF:p9 not found" } }),
    },
  );
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
  const r = await svc.execute("read", { target: "wF:p9" });
  assert.equal(r.ok, false, "a non-zero exit is not ok");
  assert.equal(r.code, "agent_not_found", "the typed code comes from the stderr envelope");
  assert.equal(r.outcome, "error");
});

test("envelope: success text + diagnostic stderr stay distinct (stderr never misread as error)", async () => {
  const world = envWorld();
  world.addAgent("wF:p9", "wF", { status: "idle" });
  const successStdout = JSON.stringify({
    id: "cli:agent:get",
    result: { type: "agent_info", agent: { agent: "pi", agent_status: "idle", state_change_seq: 1, pane_id: "wF:p9", workspace_id: "wF", terminal_id: "term_env_p9", name: null } },
  });
  // Diagnostics on stderr that is NOT a typed error envelope (just warning prose).
  const svc = serviceWithEnvelope(
    makeTransport(world),
    { stdout: successStdout, stderr: "warning: some diagnostic noise" },
    undefined,
  );
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
  const r = await svc.execute("read", { target: "wF:p9" });
  assert.equal(r.ok, true, "success on exit 0 is ok despite diagnostic stderr");
  assert.equal(r.outcome, "read", "the stdout envelope drives the result, not the stderr");
});

test("envelope: transport preserves raw stdout/stderr exactly (no rewrite)", async () => {
  const t = new HerdrTransport("node");
  const r = await t.run(
    ["-e", "process.stderr.write('err-json'); process.stdout.write('out-text'); process.exitCode = 3;"],
    { timeoutMs: 5_000 },
  );
  assert.equal(r.stdout, "out-text", "stdout preserved verbatim");
  assert.equal(r.stderr, "err-json", "stderr preserved verbatim (not folded into stdout)");
  assert.equal(r.exitCode, 3);
  assert.equal(r.signal, null, "normal exit: no signal");
});

test("envelope: signal-terminated run is NOT false success (exitCode null + signal set)", async () => {
  const fs = await import("node:fs");
  const pidFile = `${process.cwd()}/.fk-sigenv-${process.pid}`;
  const t = new HerdrTransport("node");
  const script = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>{},60000);`;
  const p = t.run(["-e", script], { timeoutMs: 30_000 });
  let pid: number | null = null;
  for (let i = 0; i < 100 && pid === null; i++) {
    await new Promise((r) => setTimeout(r, 20));
    if (fs.existsSync(pidFile)) pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
  }
  assert.ok(pid !== null, "child wrote its pid");
  process.kill(pid!, "SIGSEGV");
  let resolved: { exitCode: number | null; signal: NodeJS.Signals | null } | null = null;
  try {
    resolved = (await p) as { exitCode: number | null; signal: NodeJS.Signals | null };
  } finally {
    fs.rmSync(pidFile, { force: true });
  }
  // A signal-terminated run must NOT report exitCode 0 (the old `?? 0` bug).
  assert.equal(resolved!.exitCode, null, "no exit code is produced when signalled");
  assert.equal(resolved!.signal, "SIGSEGV", "the terminating signal is surfaced");
  // The protocol boundary must treat this as not-ok, not as a successful envelope.
  const world = envWorld();
  world.addAgent("wF:p9", "wF", { status: "idle" });
  const svc = new SubagentService({
    transport: {
      async run(args: string[]): Promise<TransportResult> {
        if (args[0] === "agent" && args[1] === "read" && args[2] === "wF:p9") {
          return { ...RAW, exitCode: null, signal: "SIGSEGV" as NodeJS.Signals, stdout: "", stderr: "" };
        }
        return makeTransport(world).run(args, undefined);
      },
    },
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
  });
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
  const r = await svc.execute("read", { target: "wF:p9" });
  assert.equal(r.ok, false, "a signal-terminated CLI is never a success");
  assert.equal(r.code, "killed_SIGSEGV", "the signal-termination is surfaced honestly");
});

for (const field of ["workspace_id", "terminal_id"] as const) {
  test(`wait: missing frozen ${field} mid-poll fails closed`, async () => {
    const world = worldWithWorker();
    const a = world.agents.get("wF:p9")!;
    a.status = "idle";
    a.seq = 234;
    const base = makeTransport(world);
    let gets = 0;
    const svc = new SubagentService({
      transport: { async run(args, options) {
        const drop = args[0] === "agent" && args[1] === "get" && args[2] === "wF:p9" && ++gets === 2;
        if (drop) { a.status = "done"; a.seq = 235; }
        const res = await base.run(args, options);
        if (!drop) return res;
        const doc = JSON.parse(res.stdout);
        delete doc.result.agent[field];
        return { ...res, stdout: JSON.stringify(doc) };
      } },
      paneId: "wF:p1", runtimeDir: FAKE_SCRIPTS_DIR,
    });
    const cont = svc.registerContinuation({
      pane_id: "wF:p9", workspace_id: "wF", terminal_id: a.terminalId,
      baseline_seq: 234, delivery_confirmed: true, working_observed: false, state: "idle", seq: 234,
    });
    const r = await svc.execute("wait", { target: "wF:p9", continuation: cont, timeoutMs: 1000 });
    assert.equal(r.ok, false);
    assert.equal(r.code, "identity_mismatch");
    assert.match(r.hint ?? "", /identity missing/);
  });
}

for (const source of ["pane", "agent"] as const) {
  for (const missing of [true, false]) {
    test(`ownership: ${source} terminal ${missing ? "missing" : "changed"} denies close without mutation`, async () => {
      const world = worldWithWorker();
      const base = makeTransport(world);
      const svc = new SubagentService({
        transport: { async run(args, options) {
          const res = await base.run(args, options);
          if (args[0] !== source || args[1] !== "get" || args[2] !== "wF:p9") return res;
          const doc = JSON.parse(res.stdout);
          if (missing) delete doc.result[source].terminal_id;
          else doc.result[source].terminal_id = "term_reused";
          return { ...res, stdout: JSON.stringify(doc) };
        } },
        paneId: "wF:p1", runtimeDir: FAKE_SCRIPTS_DIR,
      });
      svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF", terminal_id: world.agents.get("wF:p9")!.terminalId }]);
      const r = await svc.execute("close", { target: "wF:p9" });
      assert.equal(r.ok, false);
      assert.equal(r.code, "terminal_id_mismatch");
      assert.equal(world.calls.some(c => c.args[0] === "pane" && c.args[1] === "close"), false);
      assert.equal(world.panesAlive.has("wF:p9"), true);
    });
  }
}

test("prompt: missing baseline/receipt identity retains verified owned identity", async () => {
  const world = worldWithWorker();
  const base = makeTransport(world);
  let gets = 0;
  const svc = new SubagentService({
    transport: { async run(args, options) {
      const res = await base.run(args, options);
      if (args[0] !== "agent" || args[2] !== "wF:p9") return res;
      if (args[1] === "get" && ++gets === 1) return res; // ownership proof remains complete
      const doc = JSON.parse(res.stdout);
      if (doc.result?.agent) {
        delete doc.result.agent.workspace_id;
        delete doc.result.agent.terminal_id;
      }
      return { ...res, stdout: JSON.stringify(doc) };
    } },
    paneId: "wF:p1", runtimeDir: FAKE_SCRIPTS_DIR,
  });
  const terminal = world.agents.get("wF:p9")!.terminalId;
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF", terminal_id: terminal }]);
  const r = await svc.execute("prompt", { target: "wF:p9", task: "test", waitMode: "none" });
  assert.equal(r.ok, true);
  assert.equal(r.phase, "submission", "executed prompt is not mislabeled as preflight");
  const cont = getContinuationState(svc, r.continuation!)!;
  assert.equal(cont.workspace_id, "wF");
  assert.equal(cont.terminal_id, terminal);
});

test("start: screen-detected Pi idle is not readiness; prompt only after managed session", async () => {
  ensureScriptsDir();
  const world = new FakeWorld();
  world.addPanes(["wF:p1"], "wF");
  const base = makeTransport(world);
  let ready = false;
  let gets = 0;
  const svc = new SubagentService({
    transport: { async run(args, options) {
      if (args[0] === "agent" && args[1] === "prompt") assert.equal(ready, true, "never type into startup draft handler");
      const res = await base.run(args, options);
      if (args[0] !== "agent" || args[1] !== "get" || args[2] !== "wF:p2") return res;
      gets++;
      if (gets > 2) { ready = true; return res; }
      const doc = JSON.parse(res.stdout);
      delete doc.result.agent.agent_session;
      return { ...res, stdout: JSON.stringify(doc) };
    } }, paneId: "wF:p1", runtimeDir: FAKE_SCRIPTS_DIR,
  });
  const r = await svc.execute("start", { name: "ready", cwd: process.cwd(), task: "test", waitMode: "none" });
  assert.equal(r.ok, true);
  assert.ok(gets >= 3);
  assert.equal(world.calls.filter(c => c.args[0] === "pane" && c.args[1] === "run").length, 1);
  assert.equal(world.calls.filter(c => c.args[0] === "agent" && c.args[1] === "prompt").length, 1);
});

test("start: heuristic idle without managed session times out, no task or duplicate launch", async () => {
  ensureScriptsDir();
  const world = new FakeWorld();
  world.addPanes(["wF:p1"], "wF");
  const base = makeTransport(world);
  let clock = 0;
  const svc = new SubagentService({
    transport: { async run(args, options) {
      const res = await base.run(args, options);
      if (args[0] !== "agent" || args[1] !== "get" || args[2] !== "wF:p2") return res;
      clock += 100;
      const doc = JSON.parse(res.stdout);
      doc.result.agent.agent_session.source = "screen";
      return { ...res, stdout: JSON.stringify(doc) };
    } }, paneId: "wF:p1", runtimeDir: FAKE_SCRIPTS_DIR, now: () => clock, defaults: { detectionMs: 100 },
  });
  const r = await svc.execute("start", { name: "unready", cwd: process.cwd(), task: "test", waitMode: "none" });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "detection_timeout");
  assert.equal(r.owned, true);
  assert.equal(world.calls.filter(c => c.args[0] === "pane" && c.args[1] === "run").length, 1);
  assert.equal(world.calls.filter(c => c.args[0] === "agent" && c.args[1] === "prompt").length, 0);
});

test("prompt: heuristic idle existing target refuses task without authoritative readiness", async () => {
  const world = worldWithWorker();
  const base = makeTransport(world);
  const svc = new SubagentService({
    transport: { async run(args, options) {
      const res = await base.run(args, options);
      if (args[0] !== "agent" || args[1] !== "get" || args[2] !== "wF:p9") return res;
      const doc = JSON.parse(res.stdout);
      delete doc.result.agent.agent_session;
      return { ...res, stdout: JSON.stringify(doc) };
    } }, paneId: "wF:p1", runtimeDir: FAKE_SCRIPTS_DIR,
  });
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF", terminal_id: world.agents.get("wF:p9")!.terminalId }]);
  const r = await svc.execute("prompt", { target: "wF:p9", task: "do not send", waitMode: "none" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "agent_not_ready");
  assert.equal(r.phase, "preflight");
  assert.equal(world.calls.some(c => c.args[0] === "agent" && c.args[1] === "prompt"), false);
});

test("teardown fake scripts", () => {
  rmSync(FAKE_SCRIPTS_DIR, { recursive: true, force: true });
});

test("prompt: timeout surfaces typed console-read failure without inventing a tail", async () => {
  const world = worldWithWorker();
  world.promptOutcomes.set("wF:p9", "timeout");
  world.failCommands.push({ match: /^agent read wF:p9/, code: "server_not_running", message: "read unavailable" });
  const svc = makeService(world);
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
  const r = await svc.execute("prompt", { target: "wF:p9", task: "one task", waitMode: "bounded", timeoutMs: 100, tailChars: 50 });
  assert.equal(r.outcome, "timeout");
  assert.equal(r.tail, undefined);
  assert.match(r.detail ?? "", /console read failed \(server_not_running\): read unavailable/);
  assert.equal(typeof r.continuation, "string");
  assert.deepEqual(world.promptText, ["one task"]);
});

test("prompt: active history refusal reads visible viewport and bounds tail", async () => {
  const world = worldWithWorker();
  world.promptOutcomes.set("wF:p9", "timeout");
  world.failCommands.push({ match: /^agent read wF:p9 .*--source recent-unwrapped/, code: "agent_not_idle", message: "use visible" });
  const svc = makeService(world);
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
  const r = await svc.execute("prompt", { target: "wF:p9", task: "one task", waitMode: "bounded", timeoutMs: 100, tailChars: 5 });
  assert.equal(r.outcome, "timeout");
  assert.equal(r.tail, "🧵 end");
  assert.match(r.detail ?? "", /visible viewport/);
  const reads = world.calls.filter(c => c.args[0] === "agent" && c.args[1] === "read");
  assert.equal(reads.length, 2);
  assert.equal(reads[1].args[reads[1].args.indexOf("--source") + 1], "visible");
  assert.deepEqual(world.promptText, ["one task"]);
});

for (const waitMode of ["finish", "bounded"] as const) {
  test(`prompt: successful ${waitMode} includes requested code-point console tail`, async () => {
    const world = worldWithWorker();
    const svc = makeService(world);
    svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
    const result = await svc.execute("prompt", { target: "wF:p9", task: "terminal-tail", waitMode, tailChars: 7 });
    assert.equal(result.ok, true);
    assert.equal(result.tail, " 🧵🧵 end");
    assert.equal(Array.from(result.tail!).length, 7);
    assert.ok(world.calls.some(c => c.args[0] === "agent" && c.args[1] === "read"));
  });
}

test("prompt: successful finish exposes genuine console read failure without fabricating tail", async () => {
  const world = worldWithWorker();
  world.failCommands.push({ match: /^agent read/, code: "protocol_mismatch", message: "wrong protocol" });
  const svc = makeService(world);
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
  const result = await svc.execute("prompt", { target: "wF:p9", task: "terminal-tail", waitMode: "finish" });
  assert.equal(result.ok, true, "terminal observation remains distinct from successful console retrieval");
  assert.equal(result.tail, undefined);
  assert.match(result.detail!, /protocol_mismatch/);
});

test("prompt: successful CLI wait with nonterminal payload is not a terminal observation", async () => {
  const world = worldWithWorker();
  const base = makeTransport(world);
  const svc = makeService(world, { transport: {
    async run(args: string[], options?: TransportOptions) {
      const result = await base.run(args, options);
      if (args[0] === "agent" && args[1] === "prompt") {
        const document = JSON.parse(result.stdout);
        document.result.agent.agent_status = "working";
        return { ...result, stdout: JSON.stringify(document) };
      }
      return result;
    },
  } });
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
  const result = await svc.execute("prompt", { target: "wF:p9", task: "nonterminal-receipt", waitMode: "finish" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "unexpected_wait_state");
  assert.equal(result.status, "working");
  assert.equal(typeof result.continuation, "string", "retain confirmed submission for inspection/re-wait");
});
