// Pass-5 defect tests: explicit other-workspace orphan, pending context
// supersede, settled record, receipt baseline preference, identity drift
// fall-through, and provenance truthfulness.
//
// This file is separate from core.test.ts to keep the main suite's
// wall-clock runtime within the node --test file-level timeout.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SubagentService } from "../src/core.js";
import type { Transport, TransportResult, TransportOptions } from "../src/transport.js";

// ---------------------------------------------------------------------------
// Shared fake infrastructure (copied from core.test.ts)
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
        if (outcome === "blocked") {
          a.status = "blocked";
          a.seq += 1;
        } else {
          a.status = "done";
          a.seq += 1;
        }
        const ws = id.slice(0, id.indexOf(":"));
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
// Pass-5 defect tests
// ---------------------------------------------------------------------------

// DEFECT 1: explicit other-workspace start must be rejected before any mutation
// (no orphan pane). The split always creates a pane in the supervisor workspace,
// so an explicit different destination is unsupported.
test("DEFECT 1: start with explicit different workspace is rejected before any mutation (no orphan pane)", async () => {
  const world = worldWithWorker();
  // Add a second workspace to make it "valid" but different.
  world.workspaces.set("wG", { label: "other" });
  const svc = makeService(world);
  const before = world.panesAlive.size;
  const r = await svc.execute("start", {
    name: "worker1", task: "do work", workspace: "wG",
  });
  assert.equal(r.ok, false, "different-workspace start must be rejected");
  assert.equal(r.outcome, "error");
  // The key assertion: NO pane was created (no orphan).
  assert.equal(world.panesAlive.size, before, "no pane was created before the rejection");
});

// DEFECT 1b: split_workspace_mismatch must close the created pane and verify absence
// (no orphan pane when the split unexpectedly lands in a different workspace).
test("DEFECT 1b: split_workspace_mismatch closes the created pane and verifies absence", async () => {
  const world = worldWithWorker();
  const base = makeTransport(world);
  const svc = new SubagentService({
    transport: {
      async run(args: string[], options?: TransportOptions) {
        if (args[0] === "pane" && args[1] === "split") {
          const doc = {
            id: "cli:pane:split",
            result: {
              type: "pane_info",
              pane: {
                agent_status: "unknown",
                cwd: "/private/tmp",
                focused: false,
                pane_id: "wF:p99",
                revision: 0,
                tab_id: "wF:t1",
                terminal_id: "term_split_99",
                workspace_id: "wWRONG",
              },
            },
          };
          world.panesAlive.add("wF:p99");
          return { exitCode: 0, stdout: JSON.stringify(doc), stderr: "" };
        }
        return base.run(args, options);
      },
    },
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
    defaults: { detectionMs: 500, waitMs: 4000, maxWaitMs: 60_000 },
  });
  ensureScriptsDir();
  const r = await svc.execute("start", { name: "worker1", task: "do work" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "split_workspace_mismatch");
  assert.equal(r.pane, "wF:p99", "the created pane is reported");
  assert.equal(r.verifiedAbsent, true, "absence must be verified");
  assert.ok(!world.panesAlive.has("wF:p99"), "the created pane must be closed");
  const closeCall = world.calls.find((c) => c.args[0] === "pane" && c.args[1] === "close" && c.args[2] === "wF:p99");
  assert.ok(closeCall, "a `pane close` call must have been made for the created pane");
});

// DEFECT 2: submitPrompt abort/timeout/stall/transport error must supersede/delete
// the old pending association. A later wait must not treat the old prompt as
// the latest.
test("DEFECT 2a: prompt timeout with existing pending context deletes the old association", async () => {
  const world = worldWithWorker();
  const a = world.agents.get("wF:p9")!;
  a.status = "idle";
  a.seq = 200;
  const base = makeTransport(world);
  let promptCount = 0;
  const svc = new SubagentService({
    transport: {
      async run(args: string[], options?: TransportOptions) {
        if (args[0] === "agent" && args[1] === "prompt") {
          promptCount++;
          if (promptCount >= 2) {
            return { exitCode: 1, stdout: "", stderr: JSON.stringify({ error: { code: "timeout", message: "timed out" } }) };
          }
        }
        return base.run(args, options);
      },
    },
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
    defaults: { detectionMs: 500, waitMs: 4000, maxWaitMs: 60_000 },
  });
  ensureScriptsDir();
  // First: create a pending context via a successful prompt (wait=false).
  const r1 = await svc.execute("prompt", { pane: "wF:p9", prompt: "first", wait: false });
  assert.equal(r1.ok, true, "first prompt succeeds");
  const pendingBefore = svc.pendingContext("wF:p9");
  assert.ok(pendingBefore, "pending context exists after first prompt");
  assert.equal(pendingBefore!.baseline_seq, 200, "baseline seq matches first prompt");
  // Now: a second prompt that times out must delete/supersede the old context.
  const r2 = await svc.execute("prompt", { pane: "wF:p9", prompt: "second", wait: true });
  assert.equal(r2.ok, false, "timeout is not a success");
  assert.equal(r2.outcome, "timeout");
  // The old pending context must be gone (superseded by the failed attempt).
  const pendingAfter = svc.pendingContext("wF:p9");
  assert.equal(pendingAfter, undefined, "old pending context must be deleted after timeout");
});

test("DEFECT 2b: prompt stall with existing pending context deletes the old association", async () => {
  const world = worldWithWorker();
  const a = world.agents.get("wF:p9")!;
  a.status = "idle";
  a.seq = 200;
  const base = makeTransport(world);
  let promptCount = 0;
  const svc = new SubagentService({
    transport: {
      async run(args: string[], options?: TransportOptions) {
        if (args[0] === "agent" && args[1] === "prompt") {
          promptCount++;
          if (promptCount >= 2) {
            return { exitCode: 1, stdout: "", stderr: JSON.stringify({ error: { code: "agent_prompt_stalled", message: "stalled" } }) };
          }
        }
        return base.run(args, options);
      },
    },
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
    defaults: { detectionMs: 500, waitMs: 4000, maxWaitMs: 60_000 },
  });
  ensureScriptsDir();
  const r1 = await svc.execute("prompt", { pane: "wF:p9", prompt: "first", wait: false });
  assert.equal(r1.ok, true);
  const pendingBefore = svc.pendingContext("wF:p9");
  assert.ok(pendingBefore, "pending context exists");
  assert.equal(pendingBefore!.baseline_seq, 200, "baseline seq matches first prompt");
  const r2 = await svc.execute("prompt", { pane: "wF:p9", prompt: "second", wait: true });
  assert.equal(r2.ok, false);
  assert.equal(r2.outcome, "stalled");
  const pendingAfter = svc.pendingContext("wF:p9");
  assert.equal(pendingAfter, undefined, "old pending context must be deleted after stall");
});

test("DEFECT 2c: prompt abort with existing pending context deletes the old association", async () => {
  const world = worldWithWorker();
  const a = world.agents.get("wF:p9")!;
  a.status = "idle";
  a.seq = 200;
  const svc = makeService(world);
  const r1 = await svc.execute("prompt", { pane: "wF:p9", prompt: "first", wait: false });
  assert.equal(r1.ok, true);
  assert.ok(svc.pendingContext("wF:p9"), "pending context exists");
  // Simulate abort: use a transport that aborts the prompt.
  const base = makeTransport(world);
  const svc2 = new SubagentService({
    transport: {
      async run(args: string[], options?: TransportOptions) {
        if (args[0] === "agent" && args[1] === "prompt") {
          // Simulate an abort: return an aborted transport error.
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({ error: { code: "aborted", message: "aborted" } }),
          };
        }
        return base.run(args, options);
      },
    },
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
    defaults: { detectionMs: 500, waitMs: 4000, maxWaitMs: 60_000 },
  });
  // Copy the pending context from svc to svc2 (simulating same session).
  const pending = svc.pendingContext("wF:p9");
  if (pending) {
    (svc2 as unknown as { pending: Map<string, unknown> }).pending.set("wF:p9", pending);
  }
  const r2 = await svc2.execute("prompt", { pane: "wF:p9", prompt: "second", wait: true });
  assert.equal(r2.ok, false);
  assert.equal(r2.outcome, "cancelled");
  const pendingAfter = svc2.pendingContext("wF:p9");
  assert.equal(pendingAfter, undefined, "old pending context must be deleted after abort");
});

test("DEFECT 2d: prompt not_sent (agent_blocked pre-submission) preserves the old association", async () => {
  const world = worldWithWorker();
  const a = world.agents.get("wF:p9")!;
  a.status = "idle";
  a.seq = 200;
  const svc = makeService(world);
  const r1 = await svc.execute("prompt", { pane: "wF:p9", prompt: "first", wait: false });
  assert.equal(r1.ok, true);
  const pendingBefore = svc.pendingContext("wF:p9");
  assert.ok(pendingBefore, "pending context exists");
  assert.equal(pendingBefore!.baseline_seq, 200, "baseline seq matches first prompt");
  // Now block the agent.
  a.status = "blocked";
  a.seq += 1;
  const r2 = await svc.execute("prompt", { pane: "wF:p9", prompt: "second", wait: false });
  assert.equal(r2.ok, false);
  assert.equal(r2.outcome, "not_sent");
  assert.equal(r2.delivery, "not_sent");
  // The old pending context must be PRESERVED (nothing reached the pane).
  const pendingAfter = svc.pendingContext("wF:p9");
  assert.ok(pendingAfter, "pending context must survive not_sent");
  assert.equal(pendingAfter!.baseline_seq, 200, "old context is unchanged");
});

// DEFECT 3: successful fresh terminal wait:true prompt must mark the record
// settled so a subsequent wait returns snapshot, not a repeated tier-1 settle.
test("DEFECT 3: wait:true prompt observing a fresh terminal marks the record settled", async () => {
  const world = worldWithWorker();
  const a = world.agents.get("wF:p9")!;
  a.status = "idle";
  a.seq = 200;
  const svc = makeService(world);
  // Submit with wait=true; the fake transport advances to done (seq 201).
  const r1 = await svc.execute("prompt", { pane: "wF:p9", prompt: "task", wait: true });
  assert.equal(r1.ok, true, "wait:true prompt reaches terminal");
  assert.equal(r1.outcome, "terminal_observed");
  assert.equal(r1.observation, "state_changed_after_submission");
  // The pending record should now be settled.
  const pending = svc.pendingContext("wF:p9");
  assert.ok(pending, "pending record exists");
  assert.equal(pending!.settled, true, "record must be marked settled after fresh terminal observation");
  // A subsequent wait must return snapshot (no repeated tier-1 settle).
  const r2 = await svc.execute("wait", { pane: "wF:p9", timeoutMs: 200 });
  assert.equal(r2.ok, true);
  assert.equal(r2.outcome, "terminal_observed");
  assert.equal(r2.code, "snapshot", "subsequent wait must be a snapshot, not a repeated tier-1 settle");
  assert.equal(r2.observation, "snapshot");
});

// DEFECT 4: pendingBaseline must prefer the receipt baseline for tier-2.
// The tier-2 contract is "terminal with sequence greater than the ACKNOWLEDGEMENT
// baseline". The preflight baseline is only for the tier-1 fast path.
test("DEFECT 4: pendingBaseline prefers receipt_seq for tier-2 (acknowledgement baseline)", async () => {
  const world = worldWithWorker();
  const a = world.agents.get("wF:p9")!;
  a.status = "idle";
  a.seq = 200;
  const svc = makeService(world);
  // Submit with wait=true: the fake transport advances to done (seq 201).
  // The preflight baseline is 200; the receipt (acknowledgement) is 201.
  const r1 = await svc.execute("prompt", { pane: "wF:p9", prompt: "task", wait: true });
  assert.equal(r1.ok, true, "wait:true prompt reaches terminal");
  const pending = svc.pendingContext("wF:p9");
  assert.ok(pending, "pending context exists");
  assert.equal(pending!.baseline_seq, 200, "preflight baseline is 200");
  assert.equal(pending!.receipt_seq, 201, "receipt baseline is 201 (post-prompt)");
  // Now set the agent to a terminal state at seq 201 (equal to receipt, greater
  // than preflight). If tier-2 uses the preflight baseline (200), this would
  // settle (201 > 200). If it uses the receipt baseline (201), it would NOT
  // settle (201 is not > 201).
  a.status = "done";
  a.seq = 201;
  const r2 = await svc.execute("wait", { pane: "wF:p9", timeoutMs: 500 });
  // With the receipt baseline (201), 201 is NOT > 201, so tier-2 must NOT
  // settle with state_changed_after_submission.
  // Additionally, DEFECT 3 marks the record settled after the fresh terminal
  // observation, so the wait falls through to the no-context path (snapshot).
  assert.notEqual(r2.code, "state_changed_after_submission",
    "tier-2 must not settle at the receipt baseline (201 not > 201); record is settled");
  assert.equal(r2.code, "snapshot",
    "settled record falls through to snapshot (no repeated tier-1 settle)");
});

// INSPECTION ITEM: identity drift must discard stale context AND fall through
// to explicit-current-pane observation (snapshot), not return an error.
test("INSPECTION: identity drift discards context and falls through to snapshot (no error)", async () => {
  const world = worldWithWorker();
  const a = world.agents.get("wF:p9")!;
  a.status = "idle";
  a.seq = 200;
  a.terminalId = "term_original";
  const svc = makeService(world);
  const r1 = await svc.execute("prompt", { pane: "wF:p9", prompt: "task", wait: false });
  assert.equal(r1.ok, true);
  const pending = svc.pendingContext("wF:p9");
  assert.ok(pending, "pending context exists");
  assert.equal(pending!.terminal_id, "term_original");
  // Now change the terminal identity (simulate pane reuse).
  a.terminalId = "term_reused";
  // The wait should detect the drift, discard the association, and fall through
  // to the current-pane observation (snapshot for terminal, event-wait for working).
  a.status = "done";
  a.seq = 201;
  const r2 = await svc.execute("wait", { pane: "wF:p9", timeoutMs: 200 });
  // The drift should NOT produce an identity_mismatch error. Instead, the
  // pending context is discarded and the wait observes the current state.
  assert.notEqual(r2.code, "identity_mismatch", "identity drift must not produce an error");
  assert.ok(pending !== svc.pendingContext("wF:p9") || !svc.pendingContext("wF:p9"),
    "pending context must be discarded after drift");
  // Since the agent is now terminal (done), the wait should return a snapshot.
  assert.equal(r2.outcome, "terminal_observed");
  assert.equal(r2.code, "snapshot", "after drift discard, the wait observes the current pane as a snapshot");
});

// PROVENANCE: missing-receipt-metadata — ackAgent falling back to preAgent
// for seq/identity when the receipt carries none.
test("PROVENANCE: missing receipt seq falls back to preflight seq for identity and baseline", async () => {
  const world = worldWithWorker();
  const a = world.agents.get("wF:p9")!;
  a.status = "idle";
  a.seq = 200;
  const base = makeTransport(world);
  const svc = new SubagentService({
    transport: {
      async run(args: string[], options?: TransportOptions) {
        const result = await base.run(args, options);
        if (args[0] === "agent" && args[1] === "prompt") {
          // Strip state_change_seq from the receipt to simulate missing metadata.
          const doc = JSON.parse(result.stdout);
          if (doc.result?.agent) {
            delete doc.result.agent.state_change_seq;
          }
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
  const r = await svc.execute("prompt", { pane: "wF:p9", prompt: "task", wait: false });
  assert.equal(r.ok, true);
  const pending = svc.pendingContext("wF:p9");
  assert.ok(pending, "pending context exists");
  // The receipt has no seq, so receipt_seq should be undefined.
  assert.equal(pending!.receipt_seq, undefined, "receipt seq is missing");
  // The preflight baseline should still be available.
  assert.equal(pending!.baseline_seq, 200, "preflight baseline is preserved");
  // The workspace/terminal identity should fall back to the preflight agent.
  assert.equal(pending!.workspace_id, "wF", "workspace falls back to preflight");
  assert.equal(pending!.terminal_id, a.terminalId, "terminal id falls back to preflight");
  // The result's seq must fall back to the preflight seq when the receipt
  // carries no seq (ackAgent.state_change_seq ?? preSeq).
  assert.equal(r.seq, 200, "result seq falls back to preflight seq when receipt has no seq");
});

test("receipt without agent metadata does not invent receipt status or sequence", async () => {
  const world = worldWithWorker();
  const base = makeTransport(world);
  const svc = new SubagentService({
    transport: { async run(args: string[], options?: TransportOptions) {
      const result = await base.run(args, options);
      if (args[0] === "agent" && args[1] === "prompt") {
        return { ...result, stdout: JSON.stringify({ result: { type: "agent_prompted" } }) };
      }
      return result;
    } }, paneId: "wF:p1", runtimeDir: FAKE_SCRIPTS_DIR,
  });
  const r = await svc.execute("prompt", { pane: "wF:p9", prompt: "task", wait: false });
  assert.equal(r.delivery, "acknowledged");
  assert.equal(svc.pendingContext("wF:p9")?.receipt_seq, undefined);
  assert.equal(svc.pendingContext("wF:p9")?.receipt_state, undefined);
});

test("malformed successful submission supersedes prior pending context", async () => {
  const world = worldWithWorker();
  const base = makeTransport(world);
  let submissions = 0;
  const svc = new SubagentService({
    transport: { async run(args: string[], options?: TransportOptions) {
      const result = await base.run(args, options);
      if (args[0] === "agent" && args[1] === "prompt" && ++submissions === 2) {
        return { ...result, stdout: JSON.stringify({ result: { type: "unexpected" } }) };
      }
      return result;
    } }, paneId: "wF:p1", runtimeDir: FAKE_SCRIPTS_DIR,
  });
  await svc.execute("prompt", { pane: "wF:p9", prompt: "first", wait: false });
  assert.ok(svc.pendingContext("wF:p9"));
  await svc.execute("prompt", { pane: "wF:p9", prompt: "second", wait: false });
  assert.equal(svc.pendingContext("wF:p9"), undefined);
});

test("unsettled tier-2 baseline uses receipt rather than preflight sequence", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  await svc.execute("prompt", { pane: "wF:p9", prompt: "task", wait: false });
  const rec = svc.pendingContext("wF:p9")!;
  rec.baseline_seq = 200;
  rec.receipt_seq = 205;
  rec.settled = false;
  const baseline = (svc as unknown as { pendingBaseline(r: typeof rec): number | undefined }).pendingBaseline(rec);
  assert.equal(baseline, 205);
});

test("prompt honors raw console source after terminal receipt", async () => {
  const world = worldWithWorker();
  const r = await makeService(world).execute("prompt", { pane: "wF:p9", prompt: "task", source: "raw" });
  assert.equal(r.consoleSource, "raw");
  assert.ok(world.calls.some(c => c.args[0] === "pane" && c.args[1] === "read"));
  assert.ok(!world.calls.some(c => c.args[0] === "agent" && c.args[1] === "read"));
});

test("prompt strict console source preserves terminal result without visible fallback", async () => {
  const world = worldWithWorker();
  world.agentNotIdle = true;
  const r = await makeService(world).execute("prompt", { pane: "wF:p9", prompt: "task", source: "agent" });
  assert.equal(r.outcome, "terminal_observed");
  assert.equal(r.delivery, "acknowledged");
  assert.match(r.consoleError ?? "", /agent_not_idle/);
  assert.ok(!world.calls.some(c => c.args.includes("visible")));
});

test("prompt binds pending observation to current identity, never stale ownership", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  svc.restoreOwned([{ pane_id: "wF:p9", workspace_id: "wF", terminal_id: "term_old", name: "old" }]);
  world.agents.get("wF:p9")!.name = "current";
  await svc.execute("prompt", { pane: "wF:p9", prompt: "task", wait: false });
  assert.equal(svc.pendingContext("wF:p9")?.terminal_id, world.agents.get("wF:p9")!.terminalId);
  assert.equal(svc.pendingContext("wF:p9")?.name, "current");
});

test("newer working state cannot settle a pending terminal wait", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  await svc.execute("prompt", { pane: "wF:p9", prompt: "task", wait: false });
  const a = world.agents.get("wF:p9")!;
  a.status = "working";
  a.seq += 1;
  world.scripts.set("wF:p9", ["TIMEOUT"]);
  const r = await svc.execute("wait", { pane: "wF:p9", timeoutMs: 100 });
  assert.equal(r.outcome, "timeout");
  assert.equal(r.status, "working");
  assert.notEqual(svc.pendingContext("wF:p9")?.settled, true);
  assert.ok(world.calls.some(c => c.args[0] === "agent" && c.args[1] === "wait"));
});

test("maxChars zero disables character cap without falsely reporting truncation", async () => {
  const r = await makeService(worldWithWorker()).execute("read", { pane: "wF:p9", maxChars: 0 });
  assert.equal(r.console, "worker output 🧵🧵 end");
  assert.notEqual(r.truncated, true);
});

test("read returns sampled status and sequence alongside console", async () => {
  const world = worldWithWorker();
  const r = await makeService(world).execute("read", { pane: "wF:p9" });
  assert.equal(r.status, "idle");
  assert.equal(r.seq, world.agents.get("wF:p9")!.seq);
  assert.ok(r.console);
});

test("read successful no-agent lookup uses raw with unknown status", async () => {
  const world = worldWithWorker();
  const base = makeTransport(world);
  const svc = new SubagentService({ paneId: "wF:p1", transport: { async run(args, options) {
    if (args[0] === "agent" && args[1] === "get") {
      return { exitCode: 0, stdout: JSON.stringify({ result: { type: "agent_info", agent: null } }), stderr: "" };
    }
    return base.run(args, options);
  } } });
  const r = await svc.execute("read", { pane: "wF:p9" });
  assert.equal(r.consoleSource, "raw");
  assert.equal(r.status, "unknown");
  assert.ok(!world.calls.some(c => c.args[0] === "agent" && c.args[1] === "read"));
});

test("read lookup transport failure never masquerades as no agent", async () => {
  const world = worldWithWorker();
  world.failCommands.push({ match: /^agent get/, code: "server_not_running", message: "no server" });
  const r = await makeService(world).execute("read", { pane: "wF:p9" });
  assert.equal(r.ok, false);
  assert.match(r.detail ?? "", /server_not_running/);
  assert.ok(!world.calls.some(c => c.args[1] === "read"));
});

test("nonterminal successful event wait fails without settling pending context", async () => {
  const world = worldWithWorker();
  const svc = makeService(world);
  await svc.execute("prompt", { pane: "wF:p9", prompt: "task", wait: false });
  world.agents.get("wF:p9")!.status = "working";
  world.agents.get("wF:p9")!.seq += 1;
  const r = await svc.execute("wait", { pane: "wF:p9", timeoutMs: 100 });
  assert.equal(r.code, "unexpected_wait_state");
  assert.equal(r.ok, false);
  assert.notEqual(svc.pendingContext("wF:p9")?.settled, true);
});

test("prompt timeout honors raw source without changing delivery uncertainty", async () => {
  const world = worldWithWorker();
  world.failCommands.push({ match: /^agent prompt/, code: "timeout", message: "timed out" });
  const r = await makeService(world).execute("prompt", { pane: "wF:p9", prompt: "task", source: "raw" });
  assert.equal(r.outcome, "timeout");
  assert.equal(r.delivery, "unknown");
  assert.equal(r.consoleSource, "raw");
  assert.ok(!world.calls.some(c => c.args[0] === "agent" && c.args[1] === "read"));
});

// ---------------------------------------------------------------------------
// teardown
// ---------------------------------------------------------------------------

test("teardown fake scripts", () => {
  rmSync(FAKE_SCRIPTS_DIR, { recursive: true, force: true });
});
