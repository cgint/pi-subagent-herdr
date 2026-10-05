// Node:test suite for core.ts (0.2.0 ergonomic contract) + transport.
// Fake transport implements a small herdr state machine so start, prompt,
// wait, detection, races, cancellation, ownership (informational), source
// fallbacks, migration, timeout and the two-tier freshness rules are all
// exercised without touching the live herdr server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SubagentService, shellQuote, DEFAULTS, rejectLegacyFields } from "../core.js";
import { HerdrTransport, TransportError } from "../transport.js";
import type { Transport, TransportResult, TransportOptions } from "../transport.js";

// ---------------------------------------------------------------------------
// Fake herdr world
// ---------------------------------------------------------------------------

interface FakeAgent {
  status: string;
  seq: number;
  terminalId: string;
  name: string | null;
  alive: boolean;
  kind: string;
  managed: boolean;
}

class FakeWorld {
  agents = new Map<string, FakeAgent>();
  workspaces = new Map<string, { label: string }>();
  panesAlive = new Set<string>();
  calls: Array<{ args: string[]; timeoutMs?: number }> = [];
  splitPaneCounter = 1;
  splitTerminals = new Map<string, string>();
  scripts = new Map<string, string[]>();
  promptOutcomes = new Map<string, string>();
  detectionDelays = new Map<string, number>();
  detectionCounts = new Map<string, number>();
  failCommands: Array<{ match: RegExp; code: string; message: string }> = [];
  promptText: string[] = [];
  agentNotIdle = false;

  addPanes(paneIds: string[], workspace: string) {
    for (const id of paneIds) this.panesAlive.add(id);
    this.workspaces.set(workspace, { label: `ws-${workspace}` });
  }

  addAgent(
    paneId: string,
    workspace: string,
    init: Partial<{ status: string; terminalId: string; kind: string; managed: boolean }> = {},
  ) {
    this.agents.set(paneId, {
      status: init.status ?? "idle",
      seq: 100 + this.agents.size,
      terminalId: init.terminalId ?? `term_${paneId.replace(/[^a-z0-9]/gi, "")}`,
      name: null,
      alive: true,
      kind: init.kind ?? "pi",
      managed: init.managed ?? true,
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
  const doc: Record<string, unknown> = {
    agent: a.kind,
    agent_status: a.status,
    state_change_seq: a.seq,
    pane_id: paneId,
    workspace_id: workspace,
    terminal_id: a.terminalId,
    name: a.name,
  };
  if (a.managed && a.kind === "pi") {
    doc.agent_session = { agent: "pi", kind: "path", source: "herdr:pi", value: `/fake/${paneId}.jsonl` };
  }
  return {
    id: "cli:agent:get",
    result: {
      type: "agent_info",
      agent: doc,
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

function makeTransport(world: FakeWorld): Transport {
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
      const [c0, c1, c2, c3] = args;
      const c4 = args[4];
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
        world.splitPaneCounter += 1;
        const id = `wF:p${world.splitPaneCounter}`;
        world.workspaces.set(ws, { label: "scratch" });
        world.panesAlive.add(id);
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
        // Find the --workspace value if present; default to wF.
        const wsIdx = args.indexOf("--workspace");
        const ws = wsIdx !== -1 ? args[wsIdx + 1] : "wF";
        const panes = [...world.panesAlive]
          .filter((id) => (ws === "all" ? true : id.startsWith(`${ws}:`)))
          .map((id) => ({
            pane_id: id,
            workspace_id: id.slice(0, id.indexOf(":")),
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
        if (scripted && scripted !== "TIMEOUT") {
          a.status = scripted;
          a.seq += 1;
        } else if (scripted === "TIMEOUT") {
          // Put it back: TIMEOUT is only consumed by agent wait.
          world.scripts.get(id)!.unshift("TIMEOUT");
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
        // Advance the agent state (the prompt was accepted and the turn
        // reached its terminal outcome).
        if (outcome === "blocked") {
          a.status = "blocked";
          a.seq += 1;
        } else {
          a.status = "done";
          a.seq += 1;
        }
        const ws = id.slice(0, id.indexOf(":"));
        // `agent prompt --wait` returns the terminal state; a bare
        // `agent prompt` (no --wait) returns the pre-prompt snapshot.
        const hasWait = args.includes("--wait");
        const receiptAgent = hasWait
          ? agentDoc(id, a, ws).result.agent
          : agentDoc(id, { ...a, status: a.status === "done" ? "idle" : a.status, seq: a.seq - 1 }, ws).result.agent;
        const receipt = {
          id: "cli:agent:prompt",
          result: { type: "agent_prompted", agent: receiptAgent },
        };
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
        // The visible viewport source succeeds even when the agent is not idle.
        const sourceIdx = args.indexOf("--source");
        const sourceVal = sourceIdx !== -1 ? args[sourceIdx + 1] : "default";
        if (world.agentNotIdle && sourceVal !== "visible") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({ error: { code: "agent_not_idle", message: "active alternate screen; use visible source" } }),
          };
        }
        return out({
          id: "cli:agent:read",
          result: { type: "read", text: sourceVal === "visible" ? "visible-viewport-output" : "worker output 🧵🧵 end" },
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
        // If the agent is non-terminal and the --timeout is very small, the
        // real CLI would time out before the agent reaches a terminal state.
        // Simulate this to prevent tight-spinning in the fake transport.
        const timeoutIdx = args.indexOf("--timeout");
        const timeoutVal = timeoutIdx !== -1 ? parseInt(args[timeoutIdx + 1], 10) : 0;
        if (a.status !== "idle" && a.status !== "done" && a.status !== "blocked" && timeoutVal > 0 && timeoutVal < 5) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({ error: { code: "timeout", message: "timed out waiting for agent status" } }),
          };
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

const FAKE_SCRIPTS_DIR = mkdtempSync(join(tmpdir(), "fake-scripts-"));
let SCRIPTS_DIR_READY = false;
function ensureScriptsDir() {
  if (SCRIPTS_DIR_READY) return;
  writeFileSync(join(FAKE_SCRIPTS_DIR, "herdr-worker.sh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  SCRIPTS_DIR_READY = true;
}
test("setup fake scripts", () => {
  ensureScriptsDir();
});

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
      waitMs: 4000,
      maxWaitMs: 60_000,
      consoleLines: 10,
      consoleChars: 50,
      maxConsoleLines: 500,
      maxConsoleChars: 50_000,
    },
    ...extra,
  });
  return svc;
}

function worldWithWorker() {
  const world = new FakeWorld();
  world.addPanes(["wF:p1"], "wF");
  world.addAgent("wF:p9", "wF", { status: "idle" });
  return world;
}

// ---------------------------------------------------------------------------
// shellQuote
// ---------------------------------------------------------------------------

test("shellQuote: safe strings pass through", () => {
  assert.equal(shellQuote("/Users/x/scripts/herdr-worker.sh"), "/Users/x/scripts/herdr-worker.sh");
});

test("shellQuote: quotes paths with spaces", () => {
  const q = shellQuote("/home/user/my scripts/herdr-worker.sh");
  assert.equal(q, "'/home/user/my scripts/herdr-worker.sh'");
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
    "/home/user/my scripts/herdr-worker.sh",
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
// test isolation guard
// ---------------------------------------------------------------------------

test("isolation: the unit-test service uses the FakeWorld transport, never the real herdr CLI", async () => {
  const world = new FakeWorld();
  world.addPanes(["wF:p1"], "wF");
  const svc = makeService(world);
  const inner = (svc as unknown as { transport: Transport }).transport;
  assert.ok(inner, "service has a transport");
  world.addAgent("wF:p1", "wF", { status: "idle" });
  await svc.execute("spaces", {});
  const spacesCalls = world.calls.filter((c) => c.args[0] === "workspace");
  assert.ok(spacesCalls.length >= 1, "the call was routed to the FakeWorld transport");
  assert.ok(!(inner as unknown as { herdrPath?: string }).herdrPath, "transport is not a real HerdrTransport (no herdrPath)");
});

// ---------------------------------------------------------------------------
// 0.1.x -> 0.2.0 migration: legacy field rejection (before any action)
// ---------------------------------------------------------------------------

test("migration: legacy target rejected with replacement hint, no action taken", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  const r = await svc.execute("prompt", { target: "wF:p9", prompt: "hi" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "legacy_field");
  assert.match(r.hint ?? "", /use pane/);
  assert.deepEqual(world.promptText, [], "no prompt sent");
});

test("migration: prompt task (old field) rejected", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  const r = await svc.execute("prompt", { pane: "wF:p9", task: "hi" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "legacy_field");
  assert.match(r.hint ?? "", /use prompt/);
});

test("migration: waitMode rejected on all operations", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  for (const [op, args] of [
    ["prompt", { pane: "wF:p9", prompt: "hi", waitMode: "none" }],
    ["wait", { pane: "wF:p9", waitMode: "finish" }],
    ["read", { pane: "wF:p9", waitMode: "none" }],
  ] as const) {
    const r = await svc.execute(op, args);
    assert.equal(r.ok, false, `${op} waitMode`);
    assert.equal(r.code, "legacy_field", `${op} waitMode`);
    assert.match(r.hint ?? "", /use wait/);
  }
});

test("migration: tailChars rejected", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  const r = await svc.execute("read", { pane: "wF:p9", tailChars: 50 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "legacy_field");
  assert.match(r.hint ?? "", /use returnLines \+ maxChars/);
});

test("migration: read lines/raw rejected", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  const r1 = await svc.execute("read", { pane: "wF:p9", lines: 50 });
  assert.equal(r1.ok, false);
  assert.match(r1.hint ?? "", /use returnLines/);
  const r2 = await svc.execute("read", { pane: "wF:p9", raw: true });
  assert.equal(r2.ok, false);
  assert.match(r2.hint ?? "", /source: "raw"/);
});

test("migration: continuation rejected with direct-pane hint", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  const r = await svc.execute("wait", { pane: "wF:p9", continuation: "cont_1" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "legacy_field");
  assert.match(r.hint ?? "", /address the pane directly/);
});

test("migration: rejectLegacyFields is pure (no service needed)", () => {
  const r = rejectLegacyFields({ target: "x" }, "read");
  assert.equal(r?.code, "legacy_field");
  assert.equal(rejectLegacyFields({ pane: "x", allowExternal: true }, "read"), null, "allowExternal accepted-but-ignored, not rejected");
  assert.equal(rejectLegacyFields({ pane: "x" }, "read"), null);
});

// ---------------------------------------------------------------------------
// start: full happy path
// ---------------------------------------------------------------------------

test("start: full lifecycle split→run→detection→rename→prompt (submit-only default)", async () => {
  const world = new FakeWorld();
  world.addPanes(["wF:p1"], "wF");
  const svc = makeService(world);
  const r = await svc.execute("start", {
    name: "otto",
    cwd: process.cwd(),
    mode: "readonly",
    task: "Do the thing",
  });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "submitted");
  assert.equal(r.phase, "submission");
  assert.match(r.pane!, /^wF:p\d+$/);
  assert.equal(r.code, "agent_prompted");
  assert.equal(r.delivery, "acknowledged", "agent_prompted acknowledges submission");

  const splitCall = world.calls.find((c) => c.args[0] === "pane" && c.args[1] === "split")!;
  assert.ok(splitCall);
  assert.equal(splitCall.args[2], "wF:p1", "split targets the supervisor pane explicitly");
  assert.ok(!splitCall.args.includes("--current"), "never uses --current");

  const runCall = world.calls.find((c) => c.args[0] === "pane" && c.args[1] === "run")!;
  assert.ok(runCall);
  const command = runCall.args[3];
  assert.ok(command.includes(`--mode readonly --`), `wrapper cmd: ${command}`);
  assert.ok(command.includes("herdr-worker.sh"), "wrapper path present");
  assert.ok(!command.includes("Do the thing"), "task NOT in launch command");

  const renameCall = world.calls.find((c) => c.args[0] === "agent" && c.args[1] === "rename")!;
  assert.equal(renameCall.args[3], "otto");

  assert.deepEqual(world.promptText, ["Do the thing"]);

  const owned = svc.getOwned();
  assert.equal(owned.length, 1);
  assert.equal(owned[0].pane_id, r.pane);
  assert.equal(owned[0].name, "otto");
  assert.equal(owned[0].workspace_id, "wF");
  assert.ok(owned[0].terminal_id?.startsWith("term_"));
  assert.equal(typeof owned[0].launched_at, "number");

  assert.ok(svc.pendingContext(r.pane!), "pending context recorded after start");
  assert.ok(!("continuation" in (r as unknown as Record<string, unknown>)), "no public continuation field");
});

test("start: wait=true combines launch -> submit -> wait -> console", async () => {
  const world = new FakeWorld();
  world.addPanes(["wF:p1"], "wF");
  const svc = makeService(world);
  const r = await svc.execute("start", {
    name: "otto",
    cwd: process.cwd(),
    task: "Do the thing",
    wait: true,
    timeoutMs: 4000,
    returnLines: 10,
    maxChars: 50,
  });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "terminal_observed");
  assert.equal(r.status, "done");
  assert.equal(r.delivery, "acknowledged");
  assert.ok(r.console?.includes("worker output"), "console captured in the same result");
  assert.equal(r.consoleSource, "agent");
  assert.equal(r.code, "done");
});

test("start: explicit timeoutMs with wait=false is rejected (migration hint)", async () => {
  const world = new FakeWorld();
  world.addPanes(["wF:p1"], "wF");
  const svc = makeService(world);
  const r = await svc.execute("start", {
    name: "a",
    cwd: process.cwd(),
    task: "t",
    wait: false,
    timeoutMs: 1000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "timeout_without_wait");
  assert.match(r.hint ?? "", /wait phase/);
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
    name: "a",
    cwd: process.cwd(),
    task: "t",
    wait: true,
    timeoutMs: 999_999_999,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "timeout_too_large");
});

test("start: explicit other-workspace destination validated before mutation", async () => {
  const world = new FakeWorld();
  world.addPanes(["wF:p1"], "wF");
  const svc = makeService(world);
  const r = await svc.execute("start", {
    name: "a",
    cwd: process.cwd(),
    task: "t",
    workspace: "wNOPE",
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "workspace_not_found");
  assert.equal(r.phase, "validation");
  const splits = world.calls.filter((c) => c.args[1] === "split");
  assert.equal(splits.length, 0, "no split before destination validation");
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
  const r = await svc.execute("start", { name: "a", cwd: process.cwd(), task: "t" });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "detection_timeout");
  assert.equal(r.phase, "detection");
  assert.equal(r.code, "agent_not_found");
  assert.equal(r.delivery, "not_sent", "no task sent on detection timeout");
  assert.ok(r.pane, "pane id surfaced for inspection");
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
    transport: base,
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
    defaults: { detectionMs: 1000 },
  });
  const r = await svc.execute("start", { name: "a", cwd: process.cwd(), task: "t" });
  assert.equal(r.ok, true);
  assert.equal(r.pane, "wF:p2");
  const owned = (svc as unknown as { owned: Map<string, { terminal_id?: string; pending: boolean }> }).owned;
  const rec = owned.get("wF:p2");
  assert.ok(rec, "owned record exists");
  assert.equal(rec.terminal_id, "term_split_2", "terminal_id recorded from the split object");
  assert.equal(rec.pending, false, "promoted to verified");
});

test("start: launch fails and close is unverified -> ownership RETAINED (pane stays owned)", async () => {
  const world = new FakeWorld();
  world.addPanes(["wF:p1"], "wF");
  ensureScriptsDir();
  world.failCommands.push({ match: /^pane run /, code: "internal_error", message: "boom" });
  world.failCommands.push({ match: /^pane close /, code: "internal_error", message: "boom" });
  const svc = makeService(world);
  const r = await svc.execute("start", { name: "a", cwd: process.cwd(), task: "t" });
  assert.equal(r.ok, false);
  assert.equal(r.phase, "launch");
  const owned = svc.getOwned();
  assert.equal(owned.length, 1, "ownership retained when close is unverified");
  assert.equal(owned[0].pane_id, r.pane);
});

test("start: launch fails but close verifies the pane is gone -> ownership released", async () => {
  const world = new FakeWorld();
  world.addPanes(["wF:p1"], "wF");
  ensureScriptsDir();
  world.failCommands.push({ match: /^pane run /, code: "internal_error", message: "boom" });
  const svc = makeService(world);
  const r = await svc.execute("start", { name: "a", cwd: process.cwd(), task: "t" });
  assert.equal(r.ok, false);
  assert.equal(r.phase, "launch");
  const owned = svc.getOwned();
  assert.equal(owned.length, 0, "ownership released when close verifies the pane is gone");
});

// ---------------------------------------------------------------------------
// prompt: preflight, agent-neutrality, busy/blocked, submission
// ---------------------------------------------------------------------------

test("prompt: happy path wait=false -> submitted receipt", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  const r = await svc.execute("prompt", { pane: "wF:p9", prompt: "hello", wait: false });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "submitted");
  assert.equal(r.code, "agent_prompted");
  assert.equal(r.delivery, "acknowledged");
  assert.deepEqual(world.promptText, ["hello"]);
  assert.ok(!("continuation" in (r as unknown as Record<string, unknown>)), "no public continuation");
  assert.ok(svc.pendingContext("wF:p9"), "internal pending context recorded");
});

test("prompt: default wait=true submits, waits, returns status + console", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  const r = await svc.execute("prompt", { pane: "wF:p9", prompt: "hello" });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "terminal_observed");
  assert.equal(r.status, "done");
  assert.equal(r.delivery, "acknowledged");
  assert.ok(r.console?.includes("worker output"), "console in the same result");
  assert.equal(r.consoleSource, "agent");
});

test("prompt: agent-neutral — non-Pi (claude) existing agent is prompted", async () => {
  const world = worldWithWorker();
  world.agents.set("wF:p77", {
    status: "idle",
    seq: 300,
    terminalId: "term_claude",
    name: "buddy",
    alive: true,
    kind: "claude",
    managed: false,
  });
  world.panesAlive.add("wF:p77");
  world.workspaces.set("wF", { label: "wF" });
  const svc = makeService(world);
  const r = await svc.execute("prompt", { pane: "wF:p77", prompt: "hi buddy", wait: false });
  assert.equal(r.ok, true, "non-Pi agent prompted without managed-Pi readiness gate");
  assert.equal(r.outcome, "submitted");
  assert.equal(r.delivery, "acknowledged");
  assert.equal(r.agent, "claude");
  assert.deepEqual(world.promptText, ["hi buddy"]);
});

test("prompt: blocked preflight -> not_sent (actual CLI agent_blocked)", async () => {
  const world = worldWithWorker();
  world.agents.get("wF:p9")!.status = "blocked";
  const svc = makeService(world);
  const r = await svc.execute("prompt", { pane: "wF:p9", prompt: "hi" });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "not_sent");
  assert.equal(r.code, "agent_blocked");
  assert.equal(r.delivery, "not_sent");
  assert.deepEqual(world.promptText, [], "blocked = nothing sent");
});

test("prompt: busy (working) preflight is allowed; submittedWhile + no automatic pending", async () => {
  const world = worldWithWorker();
  world.agents.get("wF:p9")!.status = "working";
  const base = makeTransport(world);
  const svc = new SubagentService({
    transport: {
      async run(args: string[], options?: TransportOptions) {
        const result = await base.run(args, options);
        if (args[0] === "agent" && args[1] === "prompt") {
          // Keep the receipt in the working state (busy submission):
          // the CLI snapshot still reflects the pre-existing turn.
          const doc = JSON.parse(result.stdout);
          doc.result.agent.agent_status = "working";
          return { ...result, stdout: JSON.stringify(doc) };
        }
        return result;
      },
    },
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
    defaults: { detectionMs: 500, waitMs: 4000, maxWaitMs: 60_000 },
  });
  ensureScriptsDir();
  const r = await svc.execute("prompt", { pane: "wF:p9", prompt: "next", wait: false });
  assert.equal(r.ok, true, "busy submission is allowed as Herdr allows it");
  assert.equal(r.submittedWhile, "working");
  assert.deepEqual(world.promptText, ["next"], "submission delivered");
  assert.equal(svc.pendingContext("wF:p9"), undefined, "busy submission carries no automatic pending context");
});

test("prompt: busy wait=true carries observation may_reflect_prior_turn", async () => {
  const world = worldWithWorker();
  world.agents.get("wF:p9")!.status = "working";
  world.agents.get("wF:p9")!.seq = 200;
  const base = makeTransport(world);
  const svc = new SubagentService({
    transport: {
      async run(args: string[], options?: TransportOptions) {
        const result = await base.run(args, options);
        if (args[0] === "agent" && args[1] === "prompt" && args.includes("--wait")) {
          // The --wait receipt returns the terminal state (done at seq 201).
          const doc = JSON.parse(result.stdout);
          doc.result.agent.agent_status = "done";
          doc.result.agent.state_change_seq = 201;
          return { ...result, stdout: JSON.stringify(doc) };
        }
        return result;
      },
    },
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
    defaults: { detectionMs: 500, waitMs: 4000, maxWaitMs: 60_000 },
  });
  ensureScriptsDir();
  const r = await svc.execute("prompt", { pane: "wF:p9", prompt: "busy-wait", wait: true });
  assert.equal(r.ok, true, "busy wait=true reaches terminal");
  assert.equal(r.outcome, "terminal_observed");
  assert.equal(r.status, "done");
  assert.equal(r.observation, "may_reflect_prior_turn", "busy submission carries may_reflect_prior_turn");
  assert.equal(r.submittedWhile, "working");
});

test("prompt: unknown pane (no agent) -> agent_not_found preflight error", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  const r = await svc.execute("prompt", { pane: "wF:pX999", prompt: "hi" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "agent_not_found");
  assert.equal(r.phase, "preflight");
});

test("prompt: stalled -> stalled outcome with console, no auto-resend", async () => {
  const world = worldWithWorker();
  world.promptOutcomes.set("wF:p9", "stalled");
  const base = makeTransport(world);
  const svc = new SubagentService({
    transport: {
      async run(args: string[], options?: TransportOptions) {
        if (args[0] === "agent" && args[1] === "prompt") {
          world.agents.get("wF:p9")!.status = "working";
          world.agents.get("wF:p9")!.seq += 1;
          await new Promise((res) => setTimeout(res, 200));
        }
        return base.run(args, options);
      },
    },
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
    defaults: { detectionMs: 500, waitMs: 4000, maxWaitMs: 60_000 },
  });
  ensureScriptsDir();
  const r = await svc.execute("prompt", { pane: "wF:p9", prompt: "hi", wait: true, timeoutMs: 4000 });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "stalled");
  assert.equal(r.code, "agent_prompt_stalled");
  assert.ok(r.console?.includes("worker output"), "console included on stall");
  assert.equal(r.delivery, "unknown", "stall does not confirm delivery");
  assert.deepEqual(world.promptText, ["hi"], "sent exactly once — no auto-resend");
});

test("prompt: parallel submissions deliver (no wrapper-level serialization required)", async () => {
  ensureScriptsDir();
  const world = worldWithWorker();
  const svc = makeService(world);
  await Promise.all([
    svc.execute("prompt", { pane: "wF:p9", prompt: "one", wait: false }),
    svc.execute("prompt", { pane: "wF:p9", prompt: "two", wait: false }),
  ]);
  assert.deepEqual(world.promptText.sort(), ["one", "two"]);
});

// ---------------------------------------------------------------------------
// read: source semantics, bounds, unicode
// ---------------------------------------------------------------------------

test("read: auto source happy path with unicode tail bounds", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  const r = await svc.execute("read", { pane: "wF:p9" });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "read");
  assert.equal(r.console, "worker output 🧵🧵 end");
  assert.equal(r.consoleSource, "agent");
});

test("read: char tail counts code points, not bytes/surrogates", async () => {
  ensureScriptsDir();
  const world = worldWithWorker();
  const base = makeTransport(world);
  const svc = new SubagentService({
    transport: {
      async run(args: string[], options?: TransportOptions) {
        if (args[0] === "agent" && args[1] === "read") {
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
  const r = await svc.execute("read", { pane: "wF:p9", maxChars: 4 });
  assert.equal(r.ok, true);
  assert.equal(r.console, "🧵🧵🧵🧵", "tail is 4 code points, not truncated mid-surrogate");
  assert.equal([...r.console!].length, 4);
});

test("read: maxChars clipping is reported as truncated", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  const r = await svc.execute("read", { pane: "wF:p9", maxChars: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true, "clipping is visible");
  assert.equal([...r.console!].length, 5);
});

test("read: returnLines=0 disables console capture", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  const r = await svc.execute("read", { pane: "wF:p9", returnLines: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.console, undefined);
  assert.equal(world.calls.filter((c) => c.args[0] === "agent" && c.args[1] === "read").length, 0, "no console read issued");
});

test("read: source=raw uses pane read only", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  const r = await svc.execute("read", { pane: "wF:p9", source: "raw" });
  assert.equal(r.ok, true);
  const readCall = world.calls.find((c) => c.args[0] === "pane" && c.args[1] === "read")!;
  assert.ok(readCall);
  assert.ok(r.console?.includes("raw-output"));
  assert.equal(r.consoleSource, "raw");
});

test("read: source=auto falls back to raw pane console on typed agent_not_found", async () => {
  const world = worldWithWorker();
  world.killAgent("wF:p9");
  const svc = makeService(world);
  const r = await svc.execute("read", { pane: "wF:p9" });
  assert.equal(r.ok, true, "auto falls back to raw on typed agent_not_found");
  assert.ok(r.console?.includes("raw-output"));
  assert.equal(r.consoleSource, "raw");
  assert.equal(r.status, "unknown", "raw fallback carries unknown status");
});

test("read: source=auto on agent_not_idle reads the visible viewport", async () => {
  const world = worldWithWorker();
  world.agentNotIdle = true;
  const svc = makeService(world);
  const r = await svc.execute("read", { pane: "wF:p9" });
  assert.equal(r.ok, true);
  assert.equal(r.consoleSource, "visible");
  assert.match(r.hint ?? "", /visible viewport/);
  const reads = world.calls.filter((c) => c.args[0] === "agent" && c.args[1] === "read");
  assert.equal(reads.length, 2);
  assert.equal(reads[1].args[reads[1].args.indexOf("--source") + 1], "visible");
  assert.ok(r.console?.includes("visible-viewport-output"));
});

test("read: source=agent strict does not fall back on agent_not_found", async () => {
  const world = worldWithWorker();
  world.killAgent("wF:p9");
  const svc = makeService(world);
  const r = await svc.execute("read", { pane: "wF:p9", source: "agent" });
  assert.equal(r.ok, false, "strict agent source surfaces the error");
  assert.equal(r.code, "console_read_failed");
  assert.match(r.detail ?? "", /agent_not_found/);
});

test("read: other real errors (server) stay errors in auto mode", async () => {
  const world = worldWithWorker();
  world.failCommands.push({ match: /^agent read wF:p9/, code: "server_not_running", message: "no server" });
  const svc = makeService(world);
  const r = await svc.execute("read", { pane: "wF:p9" });
  assert.equal(r.ok, false, "a real server error is not a fallback trigger");
  assert.equal(r.code, "console_read_failed");
  assert.match(r.detail ?? "", /server_not_running/);
});

test("read: out-of-range returnLines rejected before any action", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  const r = await svc.execute("read", { pane: "wF:p9", returnLines: 9999 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "invalid_return_lines");
  assert.equal(world.calls.length, 0, "no herdr call on invalid bounds");
});

// ---------------------------------------------------------------------------
// wait: snapshot, tiers, identity drift, timeout, cancellation
// ---------------------------------------------------------------------------

test("wait: terminal pane without pending context returns labelled snapshot", async () => {
  const world = worldWithWorker();
  world.agents.get("wF:p9")!.status = "done";
  const svc = makeService(world);
  const r = await svc.execute("wait", { pane: "wF:p9", timeoutMs: 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "terminal_observed");
  assert.equal(r.code, "snapshot");
  assert.equal(r.observation, "snapshot", "no baseline -> snapshot, cannot imply a new turn");
});

test("wait: blocked snapshot -> needs_attention", async () => {
  const world = worldWithWorker();
  world.agents.get("wF:p9")!.status = "blocked";
  const svc = makeService(world);
  const r = await svc.execute("wait", { pane: "wF:p9", timeoutMs: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "needs_attention");
  assert.equal(r.status, "blocked");
});

test("wait: working agent times out -> timeout with console, worker not killed", async () => {
  const world = worldWithWorker();
  world.agents.get("wF:p9")!.status = "working";
  world.scripts.set("wF:p9", ["working", "TIMEOUT"]);
  const svc = makeService(world);
  const r = await svc.execute("wait", { pane: "wF:p9", timeoutMs: 50 });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "timeout");
  assert.equal(r.code, "timeout");
  assert.ok(r.console?.includes("worker output"));
  assert.equal(world.agents.get("wF:p9")!.alive, true, "worker still alive after timeout");
  const waitCall = world.calls.find((c) => c.args[0] === "agent" && c.args[1] === "wait")!;
  const untils = waitCall.args.flatMap((a, i) => (a === "--until" ? [waitCall.args[i + 1]] : []));
  assert.deepEqual(untils, ["idle", "done", "blocked"]);
});

test("wait: tier 1 fast case — terminal seen during submission settles once", async () => {
  const world = worldWithWorker();
  const a = world.agents.get("wF:p9")!;
  a.status = "done";
  a.seq = 236;
  const svc = makeService(world);
  (svc as unknown as { pending: Map<string, unknown> }).pending.set("wF:p9", {
    pane_id: "wF:p9",
    workspace_id: "wF",
    terminal_id: a.terminalId,
    baseline_seq: 234,
    delivery_confirmed: true,
    receipt_seq: 236,
    receipt_state: "done",
    working_observed: false,
  });
  const r = await svc.execute("wait", { pane: "wF:p9", timeoutMs: 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "terminal_observed");
  assert.equal(r.code, "terminal_seen_during_submission");
  assert.equal(r.observation, "terminal_seen_during_submission");
  assert.equal(r.seq, 236);
  const r2 = await svc.execute("wait", { pane: "wF:p9", timeoutMs: 1000 });
  assert.equal(r2.code, "snapshot", "settled record is not reused");
});

test("wait: tier 1 fast case yields to tier 2 when the live pane is now working", async () => {
  const world = worldWithWorker();
  const a = world.agents.get("wF:p9")!;
  a.status = "working";
  a.seq = 237; // Newer working state must not settle: wait for terminal.
  world.scripts.set("wF:p9", ["working", "working", "done"]);
  const svc = makeService(world);
  (svc as unknown as { pending: Map<string, unknown> }).pending.set("wF:p9", {
    pane_id: "wF:p9",
    workspace_id: "wF",
    terminal_id: a.terminalId,
    baseline_seq: 234,
    delivery_confirmed: true,
    receipt_seq: 236,
    receipt_state: "done",
    working_observed: false,
  });
  const r = await svc.execute("wait", { pane: "wF:p9", timeoutMs: 2000 });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "terminal_observed");
  assert.equal(r.code, "state_changed_after_submission", "live working overrides the tier 1 fast path");
  assert.equal(r.status, "done", "only terminal state settles tier 2");
  assert.ok(world.calls.some(c => c.args[0] === "agent" && c.args[1] === "wait"));
  assert.equal(r.observation, "state_changed_after_submission");
});

test("wait: tier 2 — terminal at/under the baseline is NOT settled (stale-idle trap)", async () => {
  const world = worldWithWorker();
  const a = world.agents.get("wF:p9")!;
  a.status = "idle";
  a.seq = 234;
  const svc = makeService(world);
  (svc as unknown as { pending: Map<string, unknown> }).pending.set("wF:p9", {
    pane_id: "wF:p9",
    workspace_id: "wF",
    terminal_id: a.terminalId,
    baseline_seq: 234,
    delivery_confirmed: true,
    working_observed: false,
  });
  const r = await svc.execute("wait", { pane: "wF:p9", timeoutMs: 100 });
  assert.notEqual(r.outcome, "terminal_observed", "stale same-seq terminal never settles the pending record");
  assert.equal(r.ok, false, "a stale-idle wait that cannot observe progress is not a success");
  const pending = svc.pendingContext("wF:p9");
  assert.ok(pending && !pending.settled, "pending record stays unsettled");
});

test("wait: tier 2 — newer terminal settles with state_changed_after_submission", async () => {
  const world = worldWithWorker();
  const a = world.agents.get("wF:p9")!;
  a.status = "working";
  a.seq = 235;
  world.scripts.set("wF:p9", ["done"]);
  const svc = makeService(world);
  (svc as unknown as { pending: Map<string, unknown> }).pending.set("wF:p9", {
    pane_id: "wF:p9",
    workspace_id: "wF",
    terminal_id: a.terminalId,
    baseline_seq: 234,
    delivery_confirmed: true,
    working_observed: true,
    working_seq: 235,
  });
  const r = await svc.execute("wait", { pane: "wF:p9", timeoutMs: 2000 });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "terminal_observed");
  assert.equal(r.code, "state_changed_after_submission");
  assert.equal(r.observation, "state_changed_after_submission");
  assert.equal(r.seq, 236);
});

test("wait: both seq missing + lookup supplies baseline → settles with terminal_seen_in_post_submit_lookup", async () => {
  const world = worldWithWorker();
  const a = world.agents.get("wF:p9")!;
  a.status = "done";
  a.seq = 300;
  const svc = makeService(world);
  // Pending record with NO baseline_seq and NO receipt_seq.
  (svc as unknown as { pending: Map<string, unknown> }).pending.set("wF:p9", {
    pane_id: "wF:p9",
    workspace_id: "wF",
    terminal_id: a.terminalId,
    delivery_confirmed: true,
    working_observed: false,
  });
  const r = await svc.execute("wait", { pane: "wF:p9", timeoutMs: 2000 });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "terminal_observed");
  assert.equal(r.code, "terminal_seen_in_post_submit_lookup");
  assert.equal(r.observation, "terminal_seen_in_post_submit_lookup");
  assert.equal(r.seq, 300);
});

test("wait: both seq missing + lookup terminal labelled terminal_seen_in_post_submit_lookup", async () => {
  const world = worldWithWorker();
  const a = world.agents.get("wF:p9")!;
  a.status = "idle";
  a.seq = 310;
  const svc = makeService(world);
  (svc as unknown as { pending: Map<string, unknown> }).pending.set("wF:p9", {
    pane_id: "wF:p9",
    workspace_id: "wF",
    terminal_id: a.terminalId,
    delivery_confirmed: true,
    working_observed: false,
  });
  const r = await svc.execute("wait", { pane: "wF:p9", timeoutMs: 2000 });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "terminal_observed");
  assert.equal(r.code, "terminal_seen_in_post_submit_lookup");
  assert.equal(r.observation, "terminal_seen_in_post_submit_lookup");
  assert.equal(r.status, "idle");
});

test("wait: both seq missing + lookup also seq-less → context_establishment_failed, no settlement", async () => {
  const world = worldWithWorker();
  const a = world.agents.get("wF:p9")!;
  a.status = "working";
  // Delete the seq to simulate a seq-less lookup.
  delete (a as unknown as Record<string, unknown>).seq;
  const base = makeTransport(world);
  const svc = new SubagentService({
    transport: {
      async run(args: string[], options?: TransportOptions) {
        const result = await base.run(args, options);
        if (args[0] === "agent" && args[1] === "get") {
          // Strip state_change_seq from the response to simulate seq-less.
          const doc = JSON.parse(result.stdout);
          delete doc.result.agent.state_change_seq;
          return { ...result, stdout: JSON.stringify(doc) };
        }
        return result;
      },
    },
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
    defaults: { detectionMs: 500, waitMs: 4000, maxWaitMs: 60_000 },
  });
  ensureScriptsDir();
  (svc as unknown as { pending: Map<string, unknown> }).pending.set("wF:p9", {
    pane_id: "wF:p9",
    workspace_id: "wF",
    terminal_id: a.terminalId,
    delivery_confirmed: true,
    working_observed: false,
  });
  const r = await svc.execute("wait", { pane: "wF:p9", timeoutMs: 100 });
  assert.equal(r.ok, false, "context establishment failed is not a success");
  assert.equal(r.code, "context_establishment_failed");
  assert.equal(r.outcome, "error");
  const pending = svc.pendingContext("wF:p9");
  assert.ok(pending && !pending.settled, "pending record stays unsettled");
});

test("wait: identity drift (reused pane) discards the pending association", async () => {
  const world = worldWithWorker();
  const a = world.agents.get("wF:p9")!;
  a.status = "idle";
  a.seq = 234;
  a.terminalId = "term_reused_live";
  const svc = makeService(world);
  (svc as unknown as { pending: Map<string, unknown> }).pending.set("wF:p9", {
    pane_id: "wF:p9",
    workspace_id: "wF",
    terminal_id: "term_wFp9",
    baseline_seq: 234,
    delivery_confirmed: true,
    working_observed: false,
  });
  const r = await svc.execute("wait", { pane: "wF:p9", timeoutMs: 1000 });
  // Identity drift discards the association and falls through to the
  // current-pane observation (snapshot for terminal, event-wait for working).
  // No error-for-drift: the explicit pane call is not vetoed by stale bookkeeping.
  assert.notEqual(r.code, "identity_mismatch", "drift must not produce an identity_mismatch error");
  assert.equal(svc.pendingContext("wF:p9"), undefined, "drift discards the association");
  // The agent is idle (terminal): the wait returns a snapshot.
  assert.equal(r.outcome, "terminal_observed");
  assert.equal(r.code, "snapshot");
});

test("wait: workspace drift is reported as identity mismatch", async () => {
  const world = worldWithWorker();
  const a = world.agents.get("wF:p9")!;
  a.status = "idle";
  a.seq = 234;
  const base = makeTransport(world);
  const svc = new SubagentService({
    transport: {
      async run(args: string[], options?: TransportOptions) {
        const res = await base.run(args, options);
        if (args[0] === "agent" && args[1] === "get" && args[2] === "wF:p9") {
          const doc = JSON.parse(res.stdout);
          doc.result.agent.workspace_id = "wOTHER";
          return { ...res, stdout: JSON.stringify(doc) };
        }
        return res;
      },
    },
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
  });
  (svc as unknown as { pending: Map<string, unknown> }).pending.set("wF:p9", {
    pane_id: "wF:p9",
    workspace_id: "wF",
    terminal_id: a.terminalId,
    baseline_seq: 234,
    delivery_confirmed: true,
    working_observed: false,
  });
  const r = await svc.execute("wait", { pane: "wF:p9", timeoutMs: 1000 });
  // Workspace drift discards the association and falls through to the
  // current-pane observation. No error-for-drift.
  assert.notEqual(r.code, "identity_mismatch", "drift must not produce an identity_mismatch error");
  assert.equal(svc.pendingContext("wF:p9"), undefined, "drift discards the association");
});

test("wait: cancellation mid-wait is cancelled, not timeout; worker untouched", async () => {
  const world = worldWithWorker();
  world.agents.get("wF:p9")!.status = "working";
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
    defaults: { detectionMs: 500, waitMs: 5000, maxWaitMs: 60_000 },
  });
  const p = svc2.execute("wait", { pane: "wF:p9", timeoutMs: 4000 }, controller.signal);
  setTimeout(() => controller.abort(), 50);
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "cancelled");
  assert.equal(r.code, "aborted");
  assert.equal(world.agents.get("wF:p9")!.alive, true, "worker not touched by cancellation");
});

// ---------------------------------------------------------------------------
// send / interrupt
// ---------------------------------------------------------------------------

test("send: any pane, text+Enter via pane run; no console by default", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  const r = await svc.execute("send", { pane: "wF:p9", text: "ls" });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "sent");
  assert.equal(r.delivery, "not_applicable", "raw send has no lifecycle delivery");
  const runCall = world.calls.find((c) => c.args[0] === "pane" && c.args[1] === "run")!;
  assert.deepEqual(runCall.args.slice(2, 4), ["wF:p9", "ls"]);
  assert.equal(r.console, undefined, "no console by default (raw send)");
  const agentReads = world.calls.filter((c) => c.args[1] === "read");
  assert.equal(agentReads.length, 0, "no console read without returnLines");
});

test("send: console disabled with returnLines=0 (explicit)", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  const r = await svc.execute("send", { pane: "wF:p9", text: "ls", returnLines: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "sent");
  assert.equal(r.console, undefined, "no console when returnLines=0");
  const agentReads = world.calls.filter((c) => c.args[1] === "read");
  assert.equal(agentReads.length, 0, "no console read with returnLines=0");
});

test("send: optional console observation with returnLines", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  const r = await svc.execute("send", { pane: "wF:p9", text: "ls", returnLines: 10 });
  assert.equal(r.ok, true);
  assert.ok(r.console?.includes("worker output"), "optional console observation");
});

test("send: multi-line rejected (unverified in 0.9.3)", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  const r = await svc.execute("send", { pane: "wF:p9", text: "line1\nline2" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "multiline_unverified");
});

test("send: cross-workspace pane works (no workspace gate)", async () => {
  const world = worldWithWorker();
  world.addAgent("wZ:p1", "wZ");
  const svc = makeService(world);
  const r = await svc.execute("send", { pane: "wZ:p1", text: "ls" });
  assert.equal(r.ok, true, "explicit pane addressing is not workspace-gated");
});

test("interrupt: uses esc, never ctrl+d; reports observed status", async () => {
  const world = worldWithWorker();
  world.agents.get("wF:p9")!.status = "working";
  const svc = makeService(world);
  const r = await svc.execute("interrupt", { pane: "wF:p9" });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "interrupted");
  const keysCall = world.calls.find((c) => c.args[0] === "pane" && c.args[1] === "send-keys")!;
  assert.equal(keysCall.args[3], "esc");
  assert.ok(!world.calls.some((c) => c.args.includes("ctrl+d")), "ctrl+d never sent");
  assert.ok(r.hint?.includes("no guaranteed-abort claim"));
});

test("self-control denied for prompt/wait/send/interrupt/close", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  for (const [op, args] of [
    ["send", { pane: "wF:p1", text: "x" }],
    ["interrupt", { pane: "wF:p1" }],
    ["close", { pane: "wF:p1" }],
    ["prompt", { pane: "wF:p1", prompt: "x" }],
    ["wait", { pane: "wF:p1" }],
  ] as const) {
    const r = await svc.execute(op, { ...args });
    assert.equal(r.ok, false, `${op} self-control`);
    assert.equal(r.outcome, "denied", `${op} self-control`);
    assert.equal(r.code, "self_control", `${op} self-control`);
  }
});

test("ownership is informational: non-owned panes are still controllable", async () => {
  const world = worldWithWorker();
  world.addAgent("wF:p77", "wF");
  const svc = makeService(world);
  const r = await svc.execute("prompt", { pane: "wF:p77", prompt: "hi", wait: false });
  assert.equal(r.ok, true, "non-tracked pane prompt is not denied (provenance is not authority)");
  assert.equal(r.owned, false, "ownership is reported informationally");
});

// ---------------------------------------------------------------------------
// close: verified absence, idempotence
// ---------------------------------------------------------------------------

test("close: tracked pane, idempotent + absence verified; verifiedAbsent=true", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
  const r = await svc.execute("close", { pane: "wF:p9" });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "closed");
  assert.equal(r.verifiedAbsent, true, "close returns verified absence");
  assert.equal(r.console, undefined, "close returns no console tail");
  assert.equal(svc.getOwned().length, 0, "ownership record removed");
  const closeCallsAfterFirst = world.calls.filter((c) => c.args[0] === "pane" && c.args[1] === "close").length;
  const r2 = await svc.execute("close", { pane: "wF:p9" });
  assert.equal(r2.ok, true);
  assert.equal(r2.outcome, "closed");
  assert.equal(r2.code, "pane_not_found", "idempotent close of a gone pane is success");
  const closeCallsAfterSecond = world.calls.filter((c) => c.args[0] === "pane" && c.args[1] === "close").length;
  assert.equal(closeCallsAfterSecond, closeCallsAfterFirst, "repeated close of a retired id does not issue a new pane close");
});

test("close: non-tracked pane can be closed directly (no UI/opt-in gate)", async () => {
  const world = worldWithWorker();
  world.addAgent("wF:p77", "wF");
  const svc = makeService(world);
  const r = await svc.execute("close", { pane: "wF:p77" });
  assert.equal(r.ok, true, "non-owned close no longer requires an opt-in or UI confirmation");
  assert.equal(r.outcome, "closed");
  assert.equal(r.verifiedAbsent, true);
});

test("close: tombstoned id that reappears is closed as a fresh pane", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
  const first = await svc.execute("close", { pane: "wF:p9" });
  assert.equal(first.ok, true);
  world.addAgent("wF:p9", "wF");
  const closeCallsBefore = world.calls.filter((c) => c.args[0] === "pane" && c.args[1] === "close").length;
  const r = await svc.execute("close", { pane: "wF:p9" });
  assert.equal(r.ok, true, "reused id with a live pane is closed (stale bookkeeping never vetoes explicit addressing)");
  const closeCallsAfter = world.calls.filter((c) => c.args[0] === "pane" && c.args[1] === "close").length;
  assert.equal(closeCallsAfter, closeCallsBefore + 1, "a real pane close was issued for the reused id");
});

test("close: retired probe server failure does not claim absence or proceed", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
  const first = await svc.execute("close", { pane: "wF:p9" });
  assert.equal(first.ok, true);
  world.failCommands.push({ match: /^pane get wF:p9$/, code: "server_not_running", message: "no server" });
  const closeCallsBefore = world.calls.filter((c) => c.args[0] === "pane" && c.args[1] === "close").length;
  const r = await svc.execute("close", { pane: "wF:p9" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "server_not_running");
  const closeCallsAfter = world.calls.filter((c) => c.args[0] === "pane" && c.args[1] === "close").length;
  assert.equal(closeCallsAfter, closeCallsBefore, "failed retired probe does not proceed to pane close");
});

test("close: server error does NOT claim absence, tracked ownership retained", async () => {
  const world = worldWithWorker();
  world.failCommands.push({ match: /^pane close wF:p9/, code: "server_not_running", message: "no server" });
  const svc = makeService(world);
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
  const r = await svc.execute("close", { pane: "wF:p9" });
  assert.equal(r.ok, false, "server error is never a success");
  assert.notEqual(r.outcome, "closed", "must not claim the pane is closed");
  assert.equal(r.code, "server_not_running");
  assert.equal(svc.getOwned().some((o) => o.pane_id === "wF:p9"), true, "ownership retained on server error");
});

test("close: non-typed verify failure (server down) retains ownership, no absence claim", async () => {
  const world = worldWithWorker();
  let serverDown = false;
  const base = makeTransport(world);
  const svc = new SubagentService({
    transport: {
      async run(args: string[], options?: TransportOptions) {
        if (args[0] === "pane" && args[1] === "close") {
          const r = await base.run(args, options);
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
  const r = await svc.execute("close", { pane: "wF:p9" });
  assert.equal(r.ok, false, "unverified absence is not a success");
  assert.equal(r.outcome, "error");
  assert.equal(r.phase, "verify");
  assert.equal(r.code, "server_not_running");
  assert.equal(svc.getOwned().some((o) => o.pane_id === "wF:p9"), true, "ownership retained when absence unverified");
});

// ---------------------------------------------------------------------------
// list / spaces
// ---------------------------------------------------------------------------

test("list: current workspace joins agent names/status by pane id; ownership informational", async () => {
  const world = worldWithWorker();
  world.agents.get("wF:p9")!.name = "otto";
  world.agents.get("wF:p9")!.status = "working";
  const svc = makeService(world);
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF" }]);
  world.addAgent("wF:p77", "wF");
  const r = await svc.execute("list", {});
  assert.equal(r.ok, true);
  assert.equal(r.phase, "list");
  assert.equal(r.workspace, "wF");
  const items = r.items! as Array<{ pane_id: string; name: string | null; agent_status: string; owned: boolean; workspace_id: string | null; cwd: string | null }>;
  const p9 = items.find((i) => i.pane_id === "wF:p9")!;
  assert.equal(p9.name, "otto");
  assert.equal(p9.agent_status, "working");
  assert.equal(p9.owned, true, "ownership reported informationally");
  const p77 = items.find((i) => i.pane_id === "wF:p77")!;
  assert.equal(p77.owned, false);
  const p1 = items.find((i) => i.pane_id === "wF:p1")!;
  assert.equal(p1.name, null, "unrenamed pane has null name");
});

test("list: explicit workspace id uses pane list --workspace <id>", async () => {
  const world = worldWithWorker();
  world.addAgent("wZ:p1", "wZ");
  const svc = makeService(world);
  const r = await svc.execute("list", { workspace: "wZ" });
  assert.equal(r.ok, true);
  const listCall = world.calls.find((c) => c.args[0] === "pane" && c.args[1] === "list")!;
  assert.equal(listCall.args[listCall.args.indexOf("--workspace") + 1], "wZ");
  assert.ok((r.items ?? []).length >= 1);
});

test("list: workspace=all lists panes across all workspaces", async () => {
  const world = worldWithWorker();
  world.addAgent("wZ:p1", "wZ");
  const svc = makeService(world);
  const r = await svc.execute("list", { workspace: "all" });
  assert.equal(r.ok, true);
  assert.equal(r.workspace, "all");
  const panes = (r.items ?? []).map((i) => (i as { pane_id: string }).pane_id).sort();
  assert.ok(panes.includes("wF:p9") && panes.includes("wZ:p1"));
});

test("list: invalid workspace rejected", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  const r = await svc.execute("list", { workspace: 42 as unknown as string });
  assert.equal(r.ok, false);
  assert.equal(r.code, "invalid_workspace");
});

test("spaces: workspace list mapped to structured items", async () => {
  const world = worldWithWorker();
  world.addPanes(["wZ:p1"], "wZ");
  const svc = makeService(world);
  const r = await svc.execute("spaces", {});
  assert.equal(r.ok, true);
  const items = r.items! as Array<{ workspace_id: string | null; label: string | null }>;
  const ids = items.map((i) => i.workspace_id).sort();
  assert.ok(ids.includes("wF") && ids.includes("wZ"));
});

// ---------------------------------------------------------------------------
// cancellation
// ---------------------------------------------------------------------------

test("abort: pre-call abort -> cancelled, no herdr call", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  const controller = new AbortController();
  controller.abort();
  const r = await svc.execute("read", { pane: "wF:p9" }, controller.signal);
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "cancelled");
  assert.equal(r.code, "aborted");
  assert.equal(world.calls.length, 0, "aborted before any herdr call");
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
    { name: "a", cwd: process.cwd(), task: "t" },
    controller.signal,
  );
  setTimeout(() => controller.abort(), 80);
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "cancelled");
  assert.equal(r.phase, "detection");
  assert.ok(r.pane, "pane id kept available for inspection");
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
// action outcome survives console-read failure (distinct field, no resend)
// ---------------------------------------------------------------------------

test("prompt: wait success with failing console read keeps the terminal outcome (consoleError separate)", async () => {
  const world = worldWithWorker();
  world.failCommands.push({ match: /^agent read /, code: "protocol_mismatch", message: "wrong protocol" });
  const svc = makeService(world);
  const result = await svc.execute("prompt", { pane: "wF:p9", prompt: "terminal-tail", wait: true });
  assert.equal(result.ok, true, "terminal observation remains distinct from successful console retrieval");
  assert.equal(result.outcome, "terminal_observed");
  assert.equal(result.status, "done");
  assert.equal(result.console, undefined);
  assert.match(result.consoleError ?? "", /protocol_mismatch/, "console failure is a separate field");
  assert.deepEqual(world.promptText, ["terminal-tail"], "no resend after a console failure");
});

test("consoleSpread: action status/seq survive a successful raw-fallback console (no clobber)", async () => {
  // The console read succeeds via the raw fallback (agent read returns
  // agent_not_found -> pane read, status "unknown"). The action's status
  // ("done") and seq must survive the consoleSpread.
  const world2 = worldWithWorker();
  world2.failCommands.push({ match: /^agent read /, code: "agent_not_found", message: "no agent" });
  const svc = makeService(world2);
  const r = await svc.execute("prompt", { pane: "wF:p9", prompt: "clobber-test", wait: true });
  assert.equal(r.ok, true, "terminal observation");
  assert.equal(r.outcome, "terminal_observed");
  assert.equal(r.status, "done", "action status is not clobbered by console fallback status");
  assert.ok(typeof r.seq === "number" && r.seq > 0, "action seq is preserved");
  assert.ok(r.console, "console text is present (raw fallback)");
  assert.equal(r.consoleSource, "raw", "console source is raw fallback");
});

test("prompt: timeout with failing console read surfaces both honestly", async () => {
  const world = worldWithWorker();
  world.promptOutcomes.set("wF:p9", "timeout");
  world.failCommands.push({ match: /^agent read /, code: "server_not_running", message: "read unavailable" });
  const svc = makeService(world);
  const r = await svc.execute("prompt", { pane: "wF:p9", prompt: "one task", wait: true, timeoutMs: 100 });
  assert.equal(r.outcome, "timeout");
  assert.equal(r.console, undefined);
  assert.match(r.consoleError ?? "", /console read failed \(server_not_running\): read unavailable/);
  assert.equal(r.delivery, "unknown");
  assert.deepEqual(world.promptText, ["one task"], "exactly one send");
});

test("wait: timeout with failing console read keeps the timeout outcome", async () => {
  const world = worldWithWorker();
  world.panesAlive.add("wF:p9");
  world.agents.get("wF:p9")!.status = "working";
  world.scripts.set("wF:p9", ["TIMEOUT"]);
  world.failCommands.push({ match: /^agent read /, code: "server_not_running", message: "no" });
  const svc = makeService(world);
  const r = await svc.execute("wait", { pane: "wF:p9", timeoutMs: 50 });
  assert.equal(r.outcome, "timeout");
  assert.equal(r.console, undefined);
  assert.match(r.consoleError ?? "", /server_not_running/);
});

// ---------------------------------------------------------------------------
// start: managed-Pi readiness (launch-specific)
// ---------------------------------------------------------------------------

test("start: screen-detected Pi idle is not readiness; prompt only after managed session", async () => {
  ensureScriptsDir();
  const world = new FakeWorld();
  world.addPanes(["wF:p1"], "wF");
  const base = makeTransport(world);
  let ready = false;
  let gets = 0;
  const svc = new SubagentService({
    transport: {
      async run(args, options) {
        if (args[0] === "agent" && args[1] === "prompt") assert.equal(ready, true, "never type into startup draft handler");
        const res = await base.run(args, options);
        if (args[0] !== "agent" || args[1] !== "get" || args[2] !== "wF:p2") return res;
        gets++;
        if (gets > 2) {
          ready = true;
          return res;
        }
        const doc = JSON.parse(res.stdout);
        delete doc.result.agent.agent_session;
        return { ...res, stdout: JSON.stringify(doc) };
      },
    },
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
  });
  const r = await svc.execute("start", { name: "ready", cwd: process.cwd(), task: "test" });
  assert.equal(r.ok, true);
  assert.ok(gets >= 3);
  assert.equal(world.calls.filter((c) => c.args[0] === "pane" && c.args[1] === "run").length, 1);
  assert.equal(world.calls.filter((c) => c.args[0] === "agent" && c.args[1] === "prompt").length, 1);
});

test("start: heuristic idle without managed session times out, no task or duplicate launch", async () => {
  ensureScriptsDir();
  const world = new FakeWorld();
  world.addPanes(["wF:p1"], "wF");
  const base = makeTransport(world);
  let clock = 0;
  const svc = new SubagentService({
    transport: {
      async run(args, options) {
        const res = await base.run(args, options);
        if (args[0] !== "agent" || args[1] !== "get" || args[2] !== "wF:p2") return res;
        clock += 100;
        const doc = JSON.parse(res.stdout);
        doc.result.agent.agent_session.source = "screen";
        return { ...res, stdout: JSON.stringify(doc) };
      },
    },
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
    now: () => clock,
    defaults: { detectionMs: 100 },
  });
  const r = await svc.execute("start", { name: "unready", cwd: process.cwd(), task: "test" });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "detection_timeout");
  assert.equal(r.owned, true);
  assert.equal(r.delivery, "not_sent");
  assert.equal(world.calls.filter((c) => c.args[0] === "pane" && c.args[1] === "run").length, 1);
  assert.equal(world.calls.filter((c) => c.args[0] === "agent" && c.args[1] === "prompt").length, 0);
});

// ---------------------------------------------------------------------------
// prompt: wait with nonterminal CLI payload is not a terminal observation
// ---------------------------------------------------------------------------

test("prompt: successful CLI wait with nonterminal payload is not a terminal observation", async () => {
  const world = worldWithWorker();
  const base = makeTransport(world);
  const svc = makeService(world, {
    transport: {
      async run(args: string[], options?: TransportOptions) {
        const result = await base.run(args, options);
        if (args[0] === "agent" && args[1] === "prompt") {
          const document = JSON.parse(result.stdout);
          document.result.agent.agent_status = "working";
          return { ...result, stdout: JSON.stringify(document) };
        }
        return result;
      },
    },
  });
  const result = await svc.execute("prompt", { pane: "wF:p9", prompt: "nonterminal-receipt", wait: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, "unexpected_wait_state");
  assert.equal(result.status, "working");
  assert.equal(result.delivery, "acknowledged", "submission still acknowledged");
});

// ---------------------------------------------------------------------------
// defaults
// ---------------------------------------------------------------------------

test("defaults: match the 0.2.0 contract", () => {
  assert.equal(DEFAULTS.detectionMs, 15_000);
  assert.equal(DEFAULTS.waitMs, 1_800_000);
  assert.equal(DEFAULTS.maxWaitMs, 3_600_000);
  assert.equal(DEFAULTS.consoleLines, 100);
  assert.equal(DEFAULTS.consoleChars, 8_000);
  assert.equal(DEFAULTS.maxConsoleLines, 500);
  assert.equal(DEFAULTS.maxConsoleChars, 50_000);
});

// ---------------------------------------------------------------------------
// sampler / listener cleanup (wait prompt does not poll forever)
// ---------------------------------------------------------------------------

test("prompt: sampler is reaped when the wait prompt returns (no 30-min polling)", async () => {
  const world = worldWithWorker();
  let getAfterPrompt = 0;
  let promptReturned = false;
  const base = makeTransport(world);
  const svc = new SubagentService({
    transport: {
      async run(args: string[], options?: TransportOptions) {
        if (args[0] === "agent" && args[1] === "get" && promptReturned) {
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
    defaults: { detectionMs: 500, waitMs: 200, maxWaitMs: 60_000 },
  });
  ensureScriptsDir();
  const r = await svc.execute("prompt", { pane: "wF:p9", prompt: "hi", wait: true, timeoutMs: 60_000 });
  assert.equal(r.ok, true, "wait prompt reaches a terminal state");
  await new Promise((res) => setTimeout(res, 400));
  assert.equal(getAfterPrompt, 0, "sampler stopped polling after the prompt returned");
});

// ---------------------------------------------------------------------------
// process transport (meaningful node:child_process tests)
// ---------------------------------------------------------------------------

test("transport: awaits close and captures stdout of a real command", async () => {
  const t = new HerdrTransport("node");
  const r = await t.run(["-e", "process.stdout.write('hello\\n')"], { timeoutMs: 5_000 });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, "hello\n");
  assert.equal(r.timedOut, false);
});

test("transport: a multi-byte UTF-8 char SPLIT across two delayed writes decodes correctly", async () => {
  const fs = await import("node:fs");
  const file = `${process.cwd()}/.fk-split-${process.pid}.js`;
  fs.writeFileSync(
    file,
    `const b=Buffer.from([0xf0,0x9f,0xa7,0xb5]);\nprocess.stdout.write(b.subarray(0,2));\nsetTimeout(()=>process.stdout.write(b.subarray(2)),30);\n`,
  );
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
  const t = new HerdrTransport("node");
  const t0 = Date.now();
  await assert.rejects(
    () =>
      t.run(["-e", "setInterval(()=>{process.stdout.write('x'.repeat(64));}, 10);"], {
        timeoutMs: 30_000,
        maxBytes: 512,
      }),
    (err: unknown) => err instanceof TransportError && err.name === "OutputOverflowError",
  );
  assert.ok(Date.now() - t0 < 2_000, "overflow killed and reaped the child promptly, not on the timeout");
});

test("transport: a child killed by an external signal is NOT mislabelled a timeout", async () => {
  const fs = await import("node:fs");
  const pidFile = `${process.cwd()}/.fk-pid-${process.pid}`;
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
  let outcome: string;
  try {
    await p;
    outcome = "resolved";
  } catch (err) {
    outcome = (err as Error).name;
  } finally {
    fs.rmSync(pidFile, { force: true });
  }
  assert.ok(outcome !== "TimeoutError", `an externally signalled child must not be a TimeoutError (got ${outcome})`);
});

// ---------------------------------------------------------------------------
// error-envelope stream boundary (transport preserves streams; core decodes)
// ---------------------------------------------------------------------------

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
            exitCode: success ? 0 : failure?.code ?? 1,
            stdout: success ? success.stdout : failure?.stdout ?? "",
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
  const r = await svc.execute("read", { pane: "wF:p9", source: "agent" });
  assert.equal(r.ok, false, "a non-zero exit is not ok");
  assert.equal(r.code, "console_read_failed", "the typed code is surfaced in the read failure");
  assert.match(r.detail ?? "", /agent_not_found/);
});

test("envelope: success text + diagnostic stderr stay distinct (stderr never misread as error)", async () => {
  const world = envWorld();
  world.addAgent("wF:p9", "wF", { status: "idle" });
  const successStdout = JSON.stringify({
    id: "cli:agent:get",
    result: {
      type: "agent_info",
      agent: { agent: "pi", agent_status: "idle", state_change_seq: 1, pane_id: "wF:p9", workspace_id: "wF", terminal_id: "term_env_p9", name: null },
    },
  });
  const svc = serviceWithEnvelope(makeTransport(world), { stdout: successStdout, stderr: "warning: some diagnostic noise" }, undefined);
  const r = await svc.execute("read", { pane: "wF:p9" });
  assert.equal(r.ok, true, "success on exit 0 is ok despite diagnostic stderr");
  assert.equal(r.outcome, "read", "the stdout envelope drives the result, not the stderr");
});

test("envelope: transport preserves raw stdout/stderr exactly (no rewrite)", async () => {
  const t = new HerdrTransport("node");
  const r = await t.run(["-e", "process.stderr.write('err-json'); process.stdout.write('out-text'); process.exitCode = 3;"], {
    timeoutMs: 5_000,
  });
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
  assert.equal(resolved!.exitCode, null, "no exit code is produced when signalled");
  assert.equal(resolved!.signal, "SIGSEGV", "the terminating signal is surfaced");
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
  const r = await svc.execute("read", { pane: "wF:p9", source: "agent" });
  assert.equal(r.ok, false, "a signal-terminated CLI is never a success");
  assert.match(r.detail ?? "", /killed_SIGSEGV/, "the signal-termination is surfaced honestly");
});


// ---------------------------------------------------------------------------
// teardown
// ---------------------------------------------------------------------------

test("teardown fake scripts", () => {
  rmSync(FAKE_SCRIPTS_DIR, { recursive: true, force: true });
});
