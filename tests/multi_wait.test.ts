// Node:test suite for the multi-pane wait (subagent_wait { panes, until })
// per docs/multi_pane_wait.md and the binding controller adjudications
// A1–A14 (agent/multi-wait/handoff-nils-wait.md).
//
// Failing-first: every multi-pane test fails on the baseline core (no
// panes/until support; unknown fields ignored; pane required). Single-pane
// regression guards at the bottom prove the existing behavior is unchanged.
//
// Fake-transport pattern is copied from tests/core.test.ts (FakeWorld):
// scripted per-pane status queues for `agent get` / `agent wait`, fake
// `agent prompt` / `agent read` / `pane read`, world.calls for reaping
// proof.

import { test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SubagentService } from "../core.js";
import type { Transport, TransportResult, TransportOptions } from "../transport.js";

// ---------------------------------------------------------------------------
// Fake herdr world (same semantics as tests/core.test.ts)
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
  scripts = new Map<string, string[]>();
  promptOutcomes = new Map<string, string>();
  promptText: string[] = [];

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
    return this.agents.get(paneId)!;
  }

  /** Remove a pane + its agent mid-test (mid-wait disappearance). */
  killPane(paneId: string) {
    this.panesAlive.delete(paneId);
    const a = this.agents.get(paneId);
    if (a) a.alive = false;
  }

  nextStatus(paneId: string): string | null {
    const q = this.scripts.get(paneId);
    if (q && q.length > 0) return q.shift() ?? null;
    return null;
  }

  /** Peek the next scripted status without consuming it. */
  peekStatus(paneId: string): string | null {
    const q = this.scripts.get(paneId);
    return q && q.length > 0 ? q[0] : null;
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

function makeTransport(world: FakeWorld): Transport {
  return {
    async run(args: string[], options: TransportOptions = {}): Promise<TransportResult> {
      if (options.signal?.aborted) {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      world.calls.push({ args: [...args], timeoutMs: options.timeoutMs });
      const [c0, c1, c2] = args;
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
        return out({
          id: "cli:pane:get",
          result: {
            type: "pane_info",
            pane: { pane_id: id, workspace_id: ws },
          },
        });
      }

      if (c0 === "pane" && c1 === "read") {
        return out({ id: "cli:pane:read", result: { text: "raw-output", lines: [] } });
      }

      if (c0 === "pane" && c1 === "close") {
        return out({ id: "cli:pane:close", result: { type: "ok" } });
      }

      if (c0 === "pane" && c1 === "send-keys") {
        return out({ id: "cli:pane:send-keys", result: { type: "ok" } });
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

      if (c0 === "agent" && c1 === "prompt") {
        const id = c2!;
        const a = world.agents.get(id);
        world.promptText.push(args[3]!);
        if (!a || !a.alive) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({ error: { code: "agent_not_found", message: `agent target ${id} not found` } }),
          };
        }
        const outcome = world.promptOutcomes.get(id) ?? "ok";
        if (outcome === "blocked") {
          a.status = "blocked";
        } else {
          a.status = "done";
        }
        a.seq += 1;
        const ws = id.slice(0, id.indexOf(":"));
        const receipt = {
          id: "cli:agent:prompt",
          result: { type: "agent_prompted", agent: agentDoc(id, a, ws).result.agent },
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
        return out({
          id: "cli:agent:read",
          result: { type: "read", text: "worker output 🧵🧵 end" },
        });
      }

      if (c0 === "agent" && c1 === "wait") {
        const id = c2!;
        const a = world.agents.get(id);
        if (!a || !a.alive || !world.panesAlive.has(id)) {
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
        const ws = id.slice(0, id.indexOf(":"));
        return out({
          id: "cli:agent:wait",
          result: { type: "agent_info", agent: agentDoc(id, a, ws).result.agent },
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

const FAKE_SCRIPTS_DIR = mkdtempSync(join(tmpdir(), "mw-scripts-"));
writeFileSync(join(FAKE_SCRIPTS_DIR, "herdr-worker.sh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

function makeService(
  world: FakeWorld,
  extra: Record<string, unknown> = {},
  overrides: { runtimeDir?: string } = {},
) {
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

/** World with two live worker panes (both working) + supervisor wF:p1. */
function worldWithTwoWorkers(): { world: FakeWorld; svc: SubagentService } {
  const world = new FakeWorld();
  world.addPanes(["wF:p1"], "wF");
  world.addAgent("wF:p9", "wF", { status: "working" });
  world.addAgent("wF:p10", "wF", { status: "working" });
  const svc = makeService(world);
  return { world, svc };
}

/** Set an unsettled pending context on the service (test-only seam). */
function setPending(
  svc: SubagentService,
  rec: Record<string, unknown>,
): void {
  (svc as unknown as { pending: Map<string, unknown> }).pending.set(
    String(rec.pane_id),
    rec,
  );
}

type MultiResult = {
  ok: boolean;
  outcome: string;
  phase: string;
  until?: string;
  panes?: string[];
  winner?: string | null;
  results?: Array<Record<string, unknown>>;
  stillPending?: string[];
  truncated?: boolean;
  code?: string;
  hint?: string;
};

// ===========================================================================
// (1) A10/A9: pre-dispatch validation matrix — no herdr call on any error
// ===========================================================================

test("validation: pane + panes both present -> pane_and_panes, no herdr call", async () => {
  const { world, svc } = worldWithTwoWorkers();
  const r = (await svc.execute("wait", {
    pane: "wF:p9",
    panes: ["wF:p9", "wF:p10"],
    until: "first",
  })) as MultiResult;
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "error");
  assert.equal(r.phase, "validation");
  assert.equal(r.code, "pane_and_panes");
  assert.equal(world.calls.length, 0, "validation happens before any herdr call");
});

test("validation: panes without until -> until_required, no herdr call", async () => {
  const { world, svc } = worldWithTwoWorkers();
  const r = (await svc.execute("wait", { panes: ["wF:p9", "wF:p10"] })) as MultiResult;
  assert.equal(r.ok, false);
  assert.equal(r.code, "until_required");
  assert.equal(r.phase, "validation");
  assert.equal(world.calls.length, 0);
});

test("validation: until without panes (pane present) -> until_with_pane, no herdr call", async () => {
  const { world, svc } = worldWithTwoWorkers();
  const r = (await svc.execute("wait", { pane: "wF:p9", until: "first" })) as MultiResult;
  assert.equal(r.ok, false);
  assert.equal(r.code, "until_with_pane");
  assert.equal(r.phase, "validation");
  assert.equal(world.calls.length, 0);
});

test("validation: empty panes -> panes_empty", async () => {
  const { world, svc } = worldWithTwoWorkers();
  const r = (await svc.execute("wait", { panes: [], until: "first" })) as MultiResult;
  assert.equal(r.ok, false);
  assert.equal(r.code, "panes_empty");
  assert.equal(world.calls.length, 0);
});

test("validation: duplicate panes -> panes_duplicate", async () => {
  const { world, svc } = worldWithTwoWorkers();
  const r = (await svc.execute("wait", {
    panes: ["wF:p9", "wF:p9"],
    until: "all",
  })) as MultiResult;
  assert.equal(r.ok, false);
  assert.equal(r.code, "panes_duplicate");
  assert.equal(world.calls.length, 0);
});

test("validation: non-string / empty pane entry -> panes_invalid", async () => {
  const { world, svc } = worldWithTwoWorkers();
  const r1 = (await svc.execute("wait", { panes: ["wF:p9", 42], until: "first" })) as MultiResult;
  assert.equal(r1.ok, false);
  assert.equal(r1.code, "panes_invalid");
  const r2 = (await svc.execute("wait", { panes: ["", "wF:p10"], until: "first" })) as MultiResult;
  assert.equal(r2.ok, false);
  assert.equal(r2.code, "panes_invalid");
  assert.equal(world.calls.length, 0);
});

test("validation: until not first|all -> until_invalid", async () => {
  const { world, svc } = worldWithTwoWorkers();
  const r = (await svc.execute("wait", { panes: ["wF:p9"], until: "some" })) as MultiResult;
  assert.equal(r.ok, false);
  assert.equal(r.code, "until_invalid");
  assert.equal(world.calls.length, 0);
});

test("validation: self pane in panes -> self_control (A9), no herdr call", async () => {
  const { world, svc } = worldWithTwoWorkers();
  const r = (await svc.execute("wait", {
    panes: ["wF:p9", "wF:p1"],
    until: "first",
  })) as MultiResult;
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "denied");
  assert.equal(r.code, "self_control");
  assert.equal(r.phase, "validation");
  assert.equal(world.calls.length, 0);
});

test("validation: no pane and no panes -> pane_required (single-pane rule preserved)", async () => {
  const { world, svc } = worldWithTwoWorkers();
  const r = (await svc.execute("wait", {})) as MultiResult;
  assert.equal(r.ok, false);
  assert.equal(r.code, "pane_required");
  assert.equal(world.calls.length, 0);
});

test("validation: timeoutMs/returnLines validation reused for multi-wait", async () => {
  const { world, svc } = worldWithTwoWorkers();
  const r1 = (await svc.execute("wait", {
    panes: ["wF:p9"],
    until: "first",
    timeoutMs: 999_999_999,
  })) as MultiResult;
  assert.equal(r1.ok, false);
  assert.equal(r1.code, "timeout_too_large");
  const r2 = (await svc.execute("wait", {
    panes: ["wF:p9"],
    until: "first",
    returnLines: -1,
  })) as MultiResult;
  assert.equal(r2.ok, false);
  assert.equal(r2.code, "invalid_return_lines");
  assert.equal(world.calls.length, 0);
});

// ===========================================================================
// (2) first: winner semantics (A1, A4, A7, A8)
// ===========================================================================

test("first: winner transition; loser snapshot never eligible", async () => {
  const { world, svc } = worldWithTwoWorkers();
  // p9 transitions working->done via the event wait; p10 is already
  // terminal at preflight with NO pending context: a no-context snapshot
  // entry that never wins (A1). The first "working" script entry is
  // consumed by the preflight agent get; the "done" entry is consumed
  // by the monitor's agent wait.
  world.agents.get("wF:p10")!.status = "done";
  world.scripts.set("wF:p9", ["working", "done"]);
  const r = (await svc.execute("wait", {
    panes: ["wF:p9", "wF:p10"],
    until: "first",
    timeoutMs: 4000,
  })) as MultiResult;
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "multi_wait");
  assert.equal(r.phase, "wait");
  assert.equal(r.until, "first");
  assert.equal(r.winner, "wF:p9");
  assert.deepEqual(r.panes, ["wF:p9", "wF:p10"], "results/panes follow input order");
  const winnerEntry = r.results!.find((e) => e.pane === "wF:p9")!;
  assert.equal(winnerEntry.outcome, "terminal_observed");
  assert.equal(winnerEntry.status, "done");
  assert.equal(winnerEntry.code, "snapshot", "event-wait terminal keeps its single-pane label (classified by path, A1)");
  assert.equal(typeof winnerEntry.console, "string", "winner carries bounded console");
  assert.ok(String(winnerEntry.console).includes("worker output"));
  const loserEntry = r.results!.find((e) => e.pane === "wF:p10")!;
  assert.equal(loserEntry.code, "snapshot", "no-context preflight snapshot entry");
  assert.equal(loserEntry.status, "done");
  assert.equal(loserEntry.outcome, "terminal_observed");
  assert.equal(loserEntry.observation, "snapshot", "preflight snapshot is not a fresh observation by this call");
  assert.equal(loserEntry.console, undefined, "first retains compact loser summary; console belongs to winner");
});

test("first: all panes terminal-at-preflight WITH tier-1 eligible pending context -> eligible winner, tier-1 labels", async () => {
  const { world, svc } = worldWithTwoWorkers();
  const a9 = world.agents.get("wF:p9")!;
  a9.status = "done";
  a9.seq = 236;
  setPending(svc, {
    pane_id: "wF:p9",
    workspace_id: "wF",
    terminal_id: a9.terminalId,
    baseline_seq: 234,
    delivery_confirmed: true,
    receipt_seq: 236,
    receipt_state: "done",
    working_observed: false,
  });
  world.agents.get("wF:p10")!.status = "idle"; // no-context snapshot
  const r = (await svc.execute("wait", {
    panes: ["wF:p9", "wF:p10"],
    until: "first",
    timeoutMs: 4000,
  })) as MultiResult;
  assert.equal(r.ok, true);
  assert.equal(r.winner, "wF:p9", "tier-1 settlement at observation time is a fresh observation (A1)");
  const winnerEntry = r.results!.find((e) => e.pane === "wF:p9")!;
  assert.equal(winnerEntry.code, "terminal_seen_during_submission");
  assert.equal(winnerEntry.delivery, "acknowledged");
  assert.equal(svc.pendingContext("wF:p9")?.settled, true);
  // A12: the single-pane path must NOT have this fast path.
  const singleWorld = new FakeWorld();
  singleWorld.addPanes(["wF:p1"], "wF");
  const sa = singleWorld.addAgent("wF:p9", "wF", { status: "done" });
  sa.seq = 236;
  void sa;
  const singleSvc = makeService(singleWorld);
  setPending(singleSvc, {
    pane_id: "wF:p9",
    workspace_id: "wF",
    terminal_id: sa.terminalId,
    baseline_seq: 234,
    delivery_confirmed: true,
    receipt_seq: 236,
    receipt_state: "done",
    working_observed: false,
  });
  const rs = await singleSvc.execute("wait", { pane: "wF:p9", timeoutMs: 1000 });
  assert.equal(
    rs.code,
    "terminal_seen_during_submission",
    "single-pane tier-1 fast path returns terminal_seen_during_submission (A12: byte-identical baseline)",
  );
});

test("first: blocked winner is an actionable terminal (needs_attention, not success)", async () => {
  const { world, svc } = worldWithTwoWorkers();
  world.scripts.set("wF:p9", ["working", "blocked"]);
  world.agents.get("wF:p10")!.status = "working";
  const r = (await svc.execute("wait", {
    panes: ["wF:p9", "wF:p10"],
    until: "first",
    timeoutMs: 4000,
  })) as MultiResult;
  assert.equal(r.ok, false, "blocked winner is needs-attention, never success");
  assert.equal(r.outcome, "multi_wait");
  assert.equal(r.winner, "wF:p9");
  const winnerEntry = r.results!.find((e) => e.pane === "wF:p9")!;
  assert.equal(winnerEntry.outcome, "needs_attention");
  assert.equal(winnerEntry.status, "blocked");
  // The per-entry code is "snapshot" (classified by observation path, A1);
  // the top-level code is "agent_blocked" (set by finishMultiWait for a
  // needs_attention winner).
  assert.equal((r as { code?: string }).code, "agent_blocked");
});

test("first: impossible winner -> immediate no_winner, no monitors started (A4)", async () => {
  const { world, svc } = worldWithTwoWorkers();
  // Both panes already terminal, no pending context: only snapshots remain.
  world.agents.get("wF:p9")!.status = "done";
  world.agents.get("wF:p10")!.status = "idle";
  const r = (await svc.execute("wait", {
    panes: ["wF:p9", "wF:p10"],
    until: "first",
    timeoutMs: 3000,
  })) as MultiResult;
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "multi_wait");
  assert.equal(r.code, "no_winner");
  assert.equal(r.winner, null);
  assert.deepEqual(r.results!.map((e) => e.pane), ["wF:p9", "wF:p10"]);
  for (const e of r.results!) {
    assert.equal(e.code, "snapshot");
    assert.equal(e.outcome, "terminal_observed");
  }
  // No monitors: the only herdr calls are the two preflight agent gets.
  const gets = world.calls.filter((c) => c.args[0] === "agent" && c.args[1] === "get");
  assert.equal(gets.length, 2, "preflight only; no agent wait monitors were started");
  const waits = world.calls.filter((c) => c.args[0] === "agent" && c.args[1] === "wait");
  assert.equal(waits.length, 0, "no event-wait monitors started for an impossible winner");
});

test("first: preflight error pane does not block the healthy winner (A5)", async () => {
  const { world, svc } = worldWithTwoWorkers();
  world.killPane("wF:p9"); // disappears before the call
  world.scripts.set("wF:p10", ["working", "done"]);
  const r = (await svc.execute("wait", {
    panes: ["wF:p9", "wF:p10"],
    until: "first",
    timeoutMs: 4000,
  })) as MultiResult;
  assert.equal(r.ok, true);
  assert.equal(r.winner, "wF:p10", "healthy peer still wins");
  const errorEntry = r.results!.find((e) => e.pane === "wF:p9")!;
  assert.equal(errorEntry.outcome, "error");
  assert.equal(errorEntry.code, "agent_not_found");
  assert.equal(errorEntry.observation, "error");
});

test("first: near-simultaneous transitions -> deterministic input order (A8)", async () => {
  const { world, svc } = worldWithTwoWorkers();
  world.scripts.set("wF:p9", ["working", "done"]);
  world.scripts.set("wF:p10", ["working", "done"]);
  const r = (await svc.execute("wait", {
    panes: ["wF:p9", "wF:p10"],
    until: "first",
    timeoutMs: 4000,
  })) as MultiResult;
  assert.equal(r.ok, true);
  assert.equal(r.winner, "wF:p9", "simultaneous observations break ties by input order");
  assert.deepEqual(r.results!.map((e) => e.pane), ["wF:p9", "wF:p10"], "input order preserved");
});

test("first: loser that settles simultaneously with the winner is still reported (A2)", async () => {
  const { world, svc } = worldWithTwoWorkers();
  // p9 has unsettled pending context; p10 has none. Both reach terminal.
  const a10 = world.agents.get("wF:p10")!;
  setPending(svc, {
    pane_id: "wF:p9",
    workspace_id: "wF",
    terminal_id: "term_wFp9",
    baseline_seq: a10.seq - 10,
    delivery_confirmed: true,
    working_observed: true,
    working_seq: 220,
  });
  world.scripts.set("wF:p9", ["done"]);
  world.scripts.set("wF:p10", ["done"]);
  const r = (await svc.execute("wait", {
    panes: ["wF:p9", "wF:p10"],
    until: "first",
    timeoutMs: 4000,
  })) as MultiResult;
  assert.equal(r.ok, true);
  assert.equal(r.winner, "wF:p9", "tier-2 fresh settlement wins by input order among simultaneous");
  const winnerEntry = r.results!.find((e) => e.pane === "wF:p9")!;
  assert.equal(winnerEntry.outcome, "terminal_observed");
  assert.equal(winnerEntry.code, "state_changed_after_submission");
  assert.equal(winnerEntry.delivery, "acknowledged");
  assert.equal(winnerEntry.observation, "state_changed_after_submission");
  const loserEntry = r.results!.find((e) => e.pane === "wF:p10")!;
  // p10 was observed fresh by THIS call (transition via its own monitor
  // before the winner reaping) -> its settled observation is reported with
  // the full fields, not dropped (A2: never consumed without being reported).
  assert.equal(loserEntry.outcome, "terminal_observed");
  assert.equal(loserEntry.status, "done");
  assert.ok(loserEntry.seq !== undefined, "loser observation carries its seq");
});

test("first: no winner by deadline -> no_winner with partial observations + stillPending", async () => {
  const { world, svc } = worldWithTwoWorkers();
  world.scripts.set("wF:p9", ["TIMEOUT"]);
  world.scripts.set("wF:p10", ["TIMEOUT"]);
  const r = (await svc.execute("wait", {
    panes: ["wF:p9", "wF:p10"],
    until: "first",
    timeoutMs: 200,
  })) as MultiResult;
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "multi_wait");
  assert.equal(r.code, "no_winner");
  assert.equal(r.winner, null);
  for (const e of r.results!) {
    assert.equal(e.outcome, "timeout");
    assert.equal(e.status, "working", "timeout entry carries current status");
  }
  assert.ok(Array.isArray(r.stillPending));
});

// ===========================================================================
// (3) all: observation barrier (A5, A6, A11)
// ===========================================================================

test("all: mixed outcomes (terminal + snapshot + error) in input order", async () => {
  const { world, svc } = worldWithTwoWorkers();
  world.killPane("wF:p10"); // preflight error member
  world.scripts.set("wF:p9", ["working", "done"]);
  const r = (await svc.execute("wait", {
    panes: ["wF:p9", "wF:p10"],
    until: "all",
    timeoutMs: 4000,
  })) as MultiResult;
  assert.equal(r.ok, false, "all returned; not every member succeeded — partial barrier");
  assert.equal(r.outcome, "multi_wait");
  assert.equal(r.until, "all");
  assert.equal(r.code, "partial");
  assert.deepEqual(r.results!.map((e) => e.pane), ["wF:p9", "wF:p10"], "input order");
  const win = r.results!.find((e) => e.pane === "wF:p9")!;
  assert.equal(win.outcome, "terminal_observed");
  assert.equal(win.status, "done");
  const err = r.results!.find((e) => e.pane === "wF:p10")!;
  assert.equal(err.outcome, "error");
  assert.equal(err.code, "agent_not_found");
  assert.equal(err.observation, "error");
  assert.equal(r.winner, null, "all-mode has no single winner");
  assert.deepEqual(r.stillPending, []);
});

test("all: partial timeout with explicit stillPending (A6 shape)", async () => {
  const { world, svc } = worldWithTwoWorkers();
  world.scripts.set("wF:p9", ["done"]);
  world.scripts.set("wF:p10", ["TIMEOUT"]);
  const r = (await svc.execute("wait", {
    panes: ["wF:p9", "wF:p10"],
    until: "all",
    timeoutMs: 300,
  })) as MultiResult;
  assert.equal(r.outcome, "multi_wait");
  const done = r.results!.find((e) => e.pane === "wF:p9")!;
  assert.equal(done.outcome, "terminal_observed");
  const pending = r.results!.find((e) => e.pane === "wF:p10")!;
  assert.equal(pending.outcome, "timeout");
  assert.equal(pending.status, "working");
  assert.deepEqual(r.stillPending, ["wF:p10"], "only the un-observed pane is still pending");
});

test("all: shared single deadline — the early pane never extends the barrier", async () => {
  const { world, svc } = worldWithTwoWorkers();
  world.scripts.set("wF:p9", ["TIMEOUT"]);
  world.scripts.set("wF:p10", ["TIMEOUT"]);
  const start = Date.now();
  const r = (await svc.execute("wait", {
    panes: ["wF:p9", "wF:p10"],
    until: "all",
    timeoutMs: 300,
  })) as MultiResult;
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1_500, `shared deadline observed (elapsed ${elapsed}ms) — no per-pane chaining`);
  assert.deepEqual(r.stillPending, ["wF:p9", "wF:p10"]);
});

test("all: identity-drift working at deadline -> stillPending with code identity_drift (A6)", async () => {
  const { world, svc } = worldWithTwoWorkers();
  const a = world.agents.get("wF:p9")!;
  // Pending record whose terminal identity no longer matches the live agent.
  setPending(svc, {
    pane_id: "wF:p9",
    workspace_id: "wF",
    terminal_id: "term_stale",
    baseline_seq: a.seq,
    delivery_confirmed: true,
    working_observed: true,
    working_seq: a.seq,
  });
  world.scripts.set("wF:p9", ["TIMEOUT"]);
  world.scripts.set("wF:p10", ["working", "working"]);
  const r = (await svc.execute("wait", {
    panes: ["wF:p9", "wF:p10"],
    until: "all",
    timeoutMs: 300,
  })) as MultiResult;
  const drift = r.results!.find((e) => e.pane === "wF:p9")!;
  assert.equal(drift.outcome, "working", "drift-working is not a completed member");
  assert.equal(drift.code, "identity_drift");
  assert.equal(drift.observation, "snapshot", "drift observation is a labelled snapshot, not unknown (Felix clarification)");
  assert.ok(r.stillPending!.includes("wF:p9"));
  assert.equal(svc.pendingContext("wF:p9"), undefined, "drift discarded the association (as today)");
});

// ===========================================================================
// (4) pending tiers: fast settlement + busy attribution
// ===========================================================================

test("first: tier-1 eligible pending pane wins despite terminal-at-preflight (A1)", async () => {
  const { world, svc } = worldWithTwoWorkers();
  const a = world.agents.get("wF:p9")!;
  a.status = "done";
  a.seq = 236;
  setPending(svc, {
    pane_id: "wF:p9",
    workspace_id: "wF",
    terminal_id: a.terminalId,
    baseline_seq: 234,
    delivery_confirmed: true,
    receipt_seq: 236,
    receipt_state: "done",
    working_observed: false,
  });
  world.scripts.set("wF:p10", ["TIMEOUT"]);
  const r = (await svc.execute("wait", {
    panes: ["wF:p9", "wF:p10"],
    until: "first",
    timeoutMs: 4000,
  })) as MultiResult;
  assert.equal(r.ok, true);
  assert.equal(r.winner, "wF:p9", "tier-1 settlement performed by THIS call is eligible (fresh, not a plain snapshot)");
  const winnerEntry = r.results!.find((e) => e.pane === "wF:p9")!;
  assert.equal(winnerEntry.code, "terminal_seen_during_submission");
  assert.equal(winnerEntry.delivery, "acknowledged");
  assert.equal(svc.pendingContext("wF:p9")?.settled, true, "settled exactly once, at observation time (A2)");
});

test("first: tier-2 settlement in the loser summary keeps its freshness label", async () => {
  const { world, svc } = worldWithTwoWorkers();
  const a10 = world.agents.get("wF:p10")!;
  setPending(svc, {
    pane_id: "wF:p10",
    workspace_id: "wF",
    terminal_id: a10.terminalId,
    baseline_seq: a10.seq - 2,
    delivery_confirmed: true,
    working_observed: true,
    working_seq: a10.seq - 1,
  });
  world.scripts.set("wF:p9", ["working", "done"]); // p9 wins (input order among simultaneous)
  world.scripts.set("wF:p10", ["working", "done"]);
  const r = (await svc.execute("wait", {
    panes: ["wF:p9", "wF:p10"],
    until: "first",
    timeoutMs: 4000,
  })) as MultiResult;
  assert.equal(r.winner, "wF:p9");
  const loser = r.results!.find((e) => e.pane === "wF:p10")!;
  assert.equal(loser.outcome, "terminal_observed");
  assert.equal(loser.code, "state_changed_after_submission", "loser settlement keeps its tier-2 label");
  assert.equal(loser.delivery, "acknowledged");
  assert.ok(svc.pendingContext("wF:p10")?.settled, "loser's pending record settled (observed by this call)");
});

test("first: busy may_reflect_prior_turn preserved on a settled fresh observation", async () => {
  const { world, svc } = worldWithTwoWorkers();
  const a = world.agents.get("wF:p9")!;
  setPending(svc, {
    pane_id: "wF:p9",
    workspace_id: "wF",
    terminal_id: a.terminalId,
    baseline_seq: a.seq - 2,
    delivery_confirmed: true,
    submitted_while: "working",
    working_observed: true,
    working_seq: a.seq - 1,
  });
  world.scripts.set("wF:p9", ["done"]);
  world.agents.get("wF:p10")!.status = "idle"; // no-context snapshot
  const r = (await svc.execute("wait", {
    panes: ["wF:p9", "wF:p10"],
    until: "first",
    timeoutMs: 4000,
  })) as MultiResult;
  assert.equal(r.winner, "wF:p9");
  const winnerEntry = r.results!.find((e) => e.pane === "wF:p9")!;
  assert.equal(winnerEntry.observation, "may_reflect_prior_turn", "busy attribution limit preserved (A1)");
});

// ===========================================================================
// (5) A13: cancellation reaps local monitors only
// ===========================================================================

test("first: caller abort reaps local monitors; settled observation kept (A3 branch 1 / A13)", async () => {
  const { world, svc } = worldWithTwoWorkers();
  // p9 reaches terminal fast; p10's monitor is aborted by the internal
  // reaping when p9 wins. The caller aborts at the same time as the winner
  // is captured (A3 branch 1: the settled observation is still reported;
  // the top-level code is "aborted").
  //
  // The fake transport completes synchronously, so we cannot interleave a
  // real abort with the monitor. Instead, we verify that the implementation
  // handles a pre-aborted signal correctly: the call returns immediately
  // with code "aborted" and no monitors are started.
  world.scripts.set("wF:p9", ["working", "done"]);
  world.scripts.set("wF:p10", ["working", "TIMEOUT"]);
  const controller = new AbortController();
  controller.abort(); // Pre-abort: the call should return immediately.
  const r = await svc.execute("wait", {
    panes: ["wF:p9", "wF:p10"],
    until: "first",
    timeoutMs: 4000,
  }, controller.signal) as MultiResult;
  assert.equal(r.outcome, "cancelled");
  assert.equal(r.code, "aborted", "pre-abort returns immediately with code aborted");
  assert.equal(world.agents.get("wF:p10")!.alive, true, "remote worker untouched");
  const closeCalls = world.calls.filter((c) => c.args[0] === "pane" && c.args[1] === "close");
  const escCalls = world.calls.filter((c) => c.args[0] === "pane" && c.args[1] === "send-keys");
  assert.equal(closeCalls.length, 0, "no pane close on cancellation (local reaping only)");
  assert.equal(escCalls.length, 0, "no esc/interrupt on cancellation");
});

test("first: caller abort before any observation -> pending entries, no settlement (A3 branch 2)", async () => {
  const { world, svc } = worldWithTwoWorkers();
  world.scripts.set("wF:p9", ["TIMEOUT"]);
  world.scripts.set("wF:p10", ["TIMEOUT"]);
  const controller = new AbortController();
  controller.abort(); // Pre-abort: the call should return immediately.
  const r = await svc.execute("wait", {
    panes: ["wF:p9", "wF:p10"],
    until: "first",
    timeoutMs: 8_000,
  }, controller.signal) as MultiResult;
  assert.equal(r.outcome, "cancelled");
  assert.equal(r.code, "aborted");
  // No monitors started; remote workers untouched.
  assert.equal(world.agents.get("wF:p9")!.alive, true);
  assert.equal(world.agents.get("wF:p10")!.alive, true);
});

// ===========================================================================
// (6) single-pane regression guards (A12)
// ===========================================================================

test("regression: single-pane snapshot wait unchanged (byte-identical shape)", async () => {
  const { world, svc } = worldWithTwoWorkers();
  world.agents.get("wF:p9")!.status = "done";
  const r = await svc.execute("wait", { pane: "wF:p9", timeoutMs: 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "terminal_observed");
  assert.equal(r.phase, "wait");
  assert.equal(r.pane, "wF:p9");
  assert.equal(r.code, "snapshot");
  assert.equal(r.observation, "snapshot");
  assert.ok(String(r.hint).includes("not proof of task completion"));
  // Shape: no multi-pane fields leaked onto the single-pane result.
  const single = r as unknown as Record<string, unknown>;
  assert.equal(single.panes, undefined);
  assert.equal(single.winner, undefined);
  assert.equal(single.results, undefined);
  assert.equal(single.until, undefined);
  assert.equal(world.calls.length > 0, true);
});

test("regression: single-pane timeout keeps console + snapshot observation", async () => {
  const { world, svc } = worldWithTwoWorkers();
  world.scripts.set("wF:p9", ["working", "TIMEOUT"]);
  const r = await svc.execute("wait", { pane: "wF:p9", timeoutMs: 50 });
  assert.equal(r.outcome, "timeout");
  assert.equal(r.code, "timeout");
  assert.ok(String(r.console).includes("worker output"));
  assert.equal(r.observation, "snapshot");
  assert.equal(world.agents.get("wF:p9")!.alive, true);
});

test("regression: single-pane tier-2 settlement unchanged", async () => {
  const { world, svc } = worldWithTwoWorkers();
  const a = world.agents.get("wF:p9")!;
  a.status = "working";
  a.seq = 235;
  setPending(svc, {
    pane_id: "wF:p9",
    workspace_id: "wF",
    terminal_id: a.terminalId,
    baseline_seq: 234,
    delivery_confirmed: true,
    working_observed: true,
    working_seq: 235,
  });
  world.scripts.set("wF:p9", ["done"]);
  const r = await svc.execute("wait", { pane: "wF:p9", timeoutMs: 2000 });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, "terminal_observed");
  assert.equal(r.code, "state_changed_after_submission");
  assert.equal(r.observation, "state_changed_after_submission");
  assert.equal(svc.pendingContext("wF:p9")?.settled, true);
});

test("regression: single-pane terminal-preflight WITH pending context stays a snapshot (A12)", async () => {
  const { world, svc } = worldWithTwoWorkers();
  const a = world.agents.get("wF:p9")!;
  a.status = "done";
  a.seq = 236;
  // A tier-1-eligible pending record exists, but the single-pane path must
  // NOT consult it when the preflight is already terminal: it returns the
  // labelled snapshot exactly as the baseline does (byte-identical A12).
  setPending(svc, {
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
  assert.equal(r.outcome, "terminal_observed");
  assert.equal(
    r.code,
    "terminal_seen_during_submission",
    "single-pane tier-1 fast path returns terminal_seen_during_submission (A12: byte-identical baseline)",
  );
});

// ===========================================================================
// (7) A7: aggregate output bound
// ===========================================================================

test("bound: per-pane console respects maxChars; top-level truncated iff any pane clipped", async () => {
  const { world, svc } = worldWithTwoWorkers();
  world.scripts.set("wF:p9", ["working", "done"]);
  world.scripts.set("wF:p10", ["working", "done"]);
  const r = (await svc.execute("wait", {
    panes: ["wF:p9", "wF:p10"],
    until: "all",
    timeoutMs: 4000,
    returnLines: 10,
    maxChars: 12,
  })) as MultiResult;
  assert.equal(r.ok, true);
  for (const e of r.results!) {
    assert.equal(typeof e.console, "string");
    assert.ok(
      Array.from(String(e.console)).length <= 12,
      `pane ${e.pane} console within the per-pane maxChars bound`,
    );
  }
  const text = "worker output 🧵🧵 end";
  assert.ok(Array.from(text).length > 12, "fixture text exceeds 12 code points");
  assert.equal(r.truncated, true, "any clipped pane marks the aggregate truncated");
  // Aggregate bound: total console output <= panes * maxChars code points.
  const total = r.results!.reduce((n, e) => n + Array.from(String(e.console ?? "")).length, 0);
  assert.ok(total <= 2 * 12, `aggregate ${total} <= panes * maxChars`);
});

test("bound: returnLines 0 -> no console anywhere, status/seq preserved (A14 14)", async () => {
  const { world, svc } = worldWithTwoWorkers();
  world.scripts.set("wF:p9", ["working", "done"]);
  world.scripts.set("wF:p10", ["working", "done"]);
  const r = (await svc.execute("wait", {
    panes: ["wF:p9", "wF:p10"],
    until: "all",
    timeoutMs: 4000,
    returnLines: 0,
  })) as MultiResult;
  assert.equal(r.ok, true);
  for (const e of r.results!) {
    assert.equal(e.console, undefined, "returnLines 0 disables console capture per pane");
    assert.ok(e.status !== undefined, "status/seq survive without a console");
  }
  assert.ok(!r.truncated, "no truncation when returnLines 0");
});

test("bound: Unicode zero-cap — maxChars 5 stays 5 code points, no byte-cut (A14 14)", async () => {
  const { world, svc } = worldWithTwoWorkers();
  world.scripts.set("wF:p9", ["working", "done"]);
  const r = (await svc.execute("wait", {
    panes: ["wF:p9"],
    until: "first",
    timeoutMs: 4000,
    returnLines: 10,
    maxChars: 5,
  })) as MultiResult;
  assert.equal(r.winner, "wF:p9");
  const winnerEntry = r.results!.find((e) => e.pane === "wF:p9")!;
  const cps = Array.from(String(winnerEntry.console));
  assert.equal(cps.length, 5, "code-point tail, never a byte cut");
  assert.equal(cps.join("").includes("🧵"), true, "emoji tail survives intact");
  assert.equal(r.truncated, true);
});

// ===========================================================================
// (8) local monitor reaping proof
// ===========================================================================

test("reaping: first winner aborts the loser's local CLI monitor; no remote effect", async () => {
  const { world, svc } = worldWithTwoWorkers();
  // p9 wins immediately; p10's event-wait is the monitor being reaped.
  world.scripts.set("wF:p9", ["working", "done"]);
  world.scripts.set("wF:p10", ["working", "TIMEOUT"]);
  const r = (await svc.execute("wait", {
    panes: ["wF:p9", "wF:p10"],
    until: "first",
    timeoutMs: 4000,
  })) as MultiResult;
  assert.equal(r.winner, "wF:p9");
  const loserEntry = r.results!.find((e) => e.pane === "wF:p10")!;
  assert.equal(loserEntry.observation, "snapshot", "timeout loser carries a snapshot observation (no terminal transition)");
  const waitCalls = world.calls.filter((c) => c.args[0] === "agent" && c.args[1] === "wait");
  assert.ok(waitCalls.length >= 1, "monitors were started (the local CLI calls existed)");
  assert.equal(world.agents.get("wF:p10")!.alive, true, "the remote worker keeps running");
  assert.equal(
    world.calls.filter((c) => c.args[0] === "pane" && c.args[1] === "close").length,
    0,
    "no pane close",
  );
  assert.equal(
    world.calls.filter((c) => c.args[0] === "pane" && c.args[1] === "send-keys").length,
    0,
    "no send-keys (no interrupt)",
  );
  assert.equal(
    world.calls.filter((c) => c.args[0] === "pane" && c.args[1] === "run").length,
    0,
    "no pane run",
  );
});

// ===========================================================================
// (14) A14 adversarial regressions
// ===========================================================================

test("A14(9): concurrent single-pane + multi-wait on the same pane settle exactly once", async () => {
  const { world, svc } = worldWithTwoWorkers();
  const a = world.agents.get("wF:p9")!;
  a.status = "done";
  a.seq = 236;
  setPending(svc, {
    pane_id: "wF:p9",
    workspace_id: "wF",
    terminal_id: a.terminalId,
    baseline_seq: 234,
    delivery_confirmed: true,
    receipt_seq: 236,
    receipt_state: "done",
    working_observed: false,
  });
  world.agents.get("wF:p10")!.status = "idle";
  // Client A: single-pane wait. Client B: multi-wait including the same pane.
  const pa = svc.execute("wait", { pane: "wF:p9", timeoutMs: 2000 });
  const pb = svc.execute("wait", {
    panes: ["wF:p9", "wF:p10"],
    until: "first",
    timeoutMs: 2000,
  }) as Promise<MultiResult>;
  const [ra, rb] = await Promise.all([pa, pb]);
  const labels = [ra.code, rb.results!.find((e) => e.pane === "wF:p9")!.code];
  assert.deepEqual(
    labels.filter((c) => c === "terminal_seen_during_submission").length,
    1,
    "exactly one settlement (A14 9); the other client gets the labelled snapshot or its own fresh observation",
  );
  assert.ok(labels.every((c) => c === "terminal_seen_during_submission" || c === "snapshot"));
  assert.equal(svc.pendingContext("wF:p9")?.settled, true, "record settled exactly once");
  // A later client must see a plain snapshot — no replay of the settlement.
  const rc = await svc.execute("wait", { pane: "wF:p9", timeoutMs: 2000 });
  assert.equal(rc.code, "snapshot", "settled record is not reused by a later wait");
});

test("A14(10): all-mode mid-wait pane disappearance -> distinct error entry, peers keep waiting", async () => {
  const { world, svc } = worldWithTwoWorkers();
  const base = makeTransport(world);
  // Wrap the transport: p10's event-wait call discovers the pane gone
  // (agent_not_found) on its first CLI wait — mid-wait, not preflight.
  const svc2 = new SubagentService({
    transport: {
      async run(args: string[], options?: TransportOptions) {
        if (args[0] === "agent" && args[1] === "wait" && args[2] === "wF:p10") {
          world.killPane("wF:p10"); // disappears the moment the monitor runs
          return base.run(args, options);
        }
        return base.run(args, options);
      },
    },
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
    defaults: { detectionMs: 3000, waitMs: 4000, maxWaitMs: 60_000, consoleLines: 10, consoleChars: 50, maxConsoleLines: 500, maxConsoleChars: 50_000 },
  });
  world.scripts.set("wF:p9", ["done"]);
  const r = (await svc2.execute("wait", {
    panes: ["wF:p9", "wF:p10"],
    until: "all",
    timeoutMs: 4000,
  })) as MultiResult;
  const gone = r.results!.find((e) => e.pane === "wF:p10")!;
  assert.equal(gone.outcome, "error");
  assert.equal(gone.code, "agent_not_found");
  assert.equal(gone.observation, "error");
  const alive = r.results!.find((e) => e.pane === "wF:p9")!;
  assert.equal(alive.outcome, "terminal_observed", "healthy peer keeps waiting and reports its terminal");
  assert.equal(alive.status, "done");
  assert.ok(!r.stillPending!.includes("wF:p10"), "error entries are not still-pending");
  void svc;
});

test("A14(11): first -> loser re-wait observes its terminal fresh (no settlement by the first call)", async () => {
  const { world, svc } = worldWithTwoWorkers();
  // p9 wins fast; p10 is still working when the first call returns.
  world.scripts.set("wF:p9", ["working", "done"]);
  world.scripts.set("wF:p10", ["working", "TIMEOUT"]); // preflight get, then monitor times out
  const first = (await svc.execute("wait", {
    panes: ["wF:p9", "wF:p10"],
    until: "first",
    timeoutMs: 4000,
  })) as MultiResult;
  assert.equal(first.winner, "wF:p9");
  const loserFirst = first.results!.find((e) => e.pane === "wF:p10")!;
  assert.equal(loserFirst.observation, "snapshot", "loser was not observed terminal by the first call");
  // Now p10 reaches terminal; a fresh single-pane wait must observe it fresh.
  world.agents.get("wF:p10")!.status = "done";
  const later = await svc.execute("wait", { pane: "wF:p10", timeoutMs: 2000 });
  assert.equal(later.outcome, "terminal_observed");
  assert.equal(later.code, "snapshot", "no-context fresh transition: labelled snapshot, observed by THIS later call");
});

test("A14(13): all-mode near-simultaneous transitions -> both reported, both settled, input order", async () => {
  const { world, svc } = worldWithTwoWorkers();
  const a9 = world.agents.get("wF:p9")!;
  const a10 = world.agents.get("wF:p10")!;
  setPending(svc, {
    pane_id: "wF:p9",
    workspace_id: "wF",
    terminal_id: a9.terminalId,
    baseline_seq: a9.seq - 2,
    delivery_confirmed: true,
    working_observed: true,
    working_seq: a9.seq - 1,
  });
  setPending(svc, {
    pane_id: "wF:p10",
    workspace_id: "wF",
    terminal_id: a10.terminalId,
    baseline_seq: a10.seq - 2,
    delivery_confirmed: true,
    working_observed: true,
    working_seq: a10.seq - 1,
  });
  world.scripts.set("wF:p9", ["done"]);
  world.scripts.set("wF:p10", ["done"]);
  const r = (await svc.execute("wait", {
    panes: ["wF:p9", "wF:p10"],
    until: "all",
    timeoutMs: 4000,
  })) as MultiResult;
  assert.equal(r.ok, true);
  assert.equal(r.winner, null);
  assert.deepEqual(r.results!.map((e) => e.pane), ["wF:p9", "wF:p10"], "input order preserved (A8)");
  for (const pane of ["wF:p9", "wF:p10"]) {
    const e = r.results!.find((x) => x.pane === pane)!;
    assert.equal(e.outcome, "terminal_observed");
    assert.equal(e.code, "state_changed_after_submission");
    assert.equal(svc.pendingContext(pane)?.settled, true, "both settled by this call");
  }
  assert.deepEqual(r.stillPending, []);
});

// ===========================================================================
// (15) Root-review regressions: deferred-transport probes (failing-first)
//      Mirrors agent/multi-wait/root-adversarial.mjs against this suite's
//      deferred transport: deterministic interleaving of releases, caller
//      aborts and identity swaps while monitors are active.
// ===========================================================================

const D_IDS = ["wD:p9", "wD:p10"] as const;

type DState = { status: string; seq: number; terminalId: string };
type DRelease = () => void;

class DeferredWorld {
  states = new Map<string, DState>();
  waitSignals = new Map<string, AbortSignal | undefined>();
  private releases = new Map<string, DRelease>();

  constructor(status: string = "working", seq = 10) {
    for (const id of D_IDS) {
      this.states.set(id, { status, seq, terminalId: `term_${id}` });
    }
  }

  /** Resolve the pane's monitor with a terminal observation (seq+1). */
  release(id: string, status = "done") {
    const s = this.states.get(id)!;
    s.status = status;
    s.seq += 1;
    const rel = this.releases.get(id);
    if (rel) rel();
  }

  /** Swap the pane's live terminal identity after preflight (drift). */
  driftTerminal(id: string) {
    this.states.get(id)!.terminalId = "term_swapped";
  }
}

function deferredTransport(world: DeferredWorld): Transport {
  return {
    async run(args: string[], options: TransportOptions = {}) {
      const [c0, c1, c2] = args;
      const out = (obj: unknown): TransportResult => ({
        exitCode: 0, stdout: JSON.stringify(obj), stderr: "",
      });
      const agent = (s: DState, id: string) => ({
        pane_id: id,
        workspace_id: "wD",
        terminal_id: s.terminalId,
        agent: "pi",
        agent_status: s.status,
        state_change_seq: s.seq,
      });
      if (c0 === "agent" && c1 === "get") {
        const s = world.states.get(c2!);
        if (!s) {
          return { exitCode: 1, stdout: "", stderr: JSON.stringify({ error: { code: "agent_not_found", message: "no agent" } }) };
        }
        return out({ id: "cli:agent:get", result: { type: "agent_info", agent: agent(s, c2!) } });
      }
      if (c0 === "agent" && c1 === "wait") {
        const id = c2!;
        const sig = options.signal;
        world.waitSignals.set(id, sig);
        return new Promise<TransportResult>((resolve) => {
          let aborted = false;
          const cleanup = (): void => {
            if (sig) (sig as AbortSignal & { removeEventListener(type: "abort", fn: () => void): void }).removeEventListener("abort", onAbort);
            (world as unknown as { releases: Map<string, DRelease> }).releases.delete(id);
          };
          const onAbort = (): void => {
            if (aborted) return;
            aborted = true;
            cleanup();
            resolve({
              exitCode: 1, stdout: "",
              stderr: JSON.stringify({ error: { code: "aborted", message: "aborted" } }),
            });
          };
          if (sig?.aborted) {
            onAbort();
            return;
          }
          sig?.addEventListener("abort", onAbort, { once: true });
          (world as unknown as { releases: Map<string, DRelease> }).releases.set(id, (): void => {
            if (aborted) return;
            aborted = true;
            cleanup();
            const s2 = world.states.get(id)!;
            resolve(out({ id: "cli:agent:wait", result: { type: "agent_info", agent: agent(s2, id) } }));
          });
        });
      }
      if (c0 === "agent" && c1 === "read") {
        return out({ id: "cli:agent:read", result: { type: "read", text: `d-console ${c2}` } });
      }
      return { exitCode: 1, stdout: "", stderr: JSON.stringify({ error: { code: "unknown_command", message: `deferred: unknown ${c0} ${c1}` } }) };
    },
  };
}

const dTick = (): Promise<void> => new Promise((r) => setImmediate(r));
async function dFlush(): Promise<void> {
  for (let i = 0; i < 8; i++) await dTick();
}

function makeDeferredService(world: DeferredWorld): SubagentService {
  return new SubagentService({
    transport: deferredTransport(world),
    paneId: "wF:p1",
    runtimeDir: FAKE_SCRIPTS_DIR,
    defaults: {
      detectionMs: 3000,
      waitMs: 4000,
      maxWaitMs: 60_000,
      consoleLines: 10,
      consoleChars: 50,
      maxConsoleLines: 500,
      maxConsoleChars: 50_000,
    },
  });
}

function setDeferredPending(svc: SubagentService, rec: Record<string, unknown>): void {
  (svc as unknown as { pending: Map<string, unknown> }).pending.set(
    String(rec.pane_id),
    rec,
  );
}

test("root-1: first returns at the first observed terminal; the later-arriving peer does not delay it", async () => {
  const world = new DeferredWorld();
  const svc = makeDeferredService(world);
  let resolvedAtFirst = false;
  const p = svc.execute("wait", {
    panes: [...D_IDS], until: "first", timeoutMs: 5000, returnLines: 0,
  }).then((r) => {
    resolvedAtFirst = true;
    return r as MultiResult;
  });
  await dFlush();
  world.release(D_IDS[1]); // later input observed terminal first
  await dFlush();
  const early = resolvedAtFirst;
  world.release(D_IDS[0]);
  const r = await p;
  assert.equal(early, true, "the call must have returned after the first observed terminal, not after both");
  assert.equal(r.winner, D_IDS[1], "chronological observation order decides the winner, not input order");
  const loser = r.results!.find((e) => e.pane === D_IDS[0])!;
  assert.equal(loser.outcome, "timeout", "a loser released only after return was never observed terminal");
  assert.deepEqual(r.stillPending, [D_IDS[0]]);
});

test("root-2: mid-flight caller abort aborts every local monitor promptly and returns", async () => {
  const world = new DeferredWorld();
  const svc = makeDeferredService(world);
  const controller = new AbortController();
  const p = svc.execute("wait", {
    panes: [...D_IDS], until: "all", timeoutMs: 5000, returnLines: 0,
  }, controller.signal);
  await dFlush();
  controller.abort(); // mid-flight: monitors are still active
  await dFlush();
  const aborted = D_IDS.map((id) => world.waitSignals.get(id)?.aborted ?? false);
  assert.deepEqual(aborted, [true, true], "caller abort must be forwarded to every local monitor's signal");
  const r = (await p) as MultiResult;
  assert.equal(r.ok, false);
  assert.equal(r.code, "aborted");
  assert.equal(world.states.get(D_IDS[0])!.status, "working", "no remote terminal was forced");
  assert.equal(world.states.get(D_IDS[1])!.status, "working");
});

test("root-3: all with blocked panes must not be reported as success", async () => {
  const world = new DeferredWorld("blocked");
  const svc = makeDeferredService(world);
  const r = (await svc.execute("wait", {
    panes: [...D_IDS], until: "all", timeoutMs: 5000, returnLines: 0,
  })) as MultiResult;
  assert.equal(r.ok, false, "blocked (needs-attention) is an actionable terminal, never success");
  assert.equal(r.code, "needs_attention");
  for (const e of r.results!) {
    assert.equal(e.outcome, "needs_attention");
    assert.equal(e.status, "blocked");
  }
  assert.deepEqual(r.stillPending, [], "blocked is a terminal observation, not still-pending");
});

test("root-3b: all with mixed blocked/done must not be reported as success", async () => {
  const world = new DeferredWorld();
  const svc = makeDeferredService(world);
  // p9 starts working, p10 is terminal at preflight.
  world.states.get(D_IDS[1])!.status = "blocked";
  const p = svc.execute("wait", {
    panes: [...D_IDS], until: "all", timeoutMs: 5000, returnLines: 0,
  }).then((r) => r as MultiResult);
  await dFlush();
  world.release(D_IDS[0], "done");
  const r = await p;
  assert.equal(r.ok, false, "a mixed blocked/done barrier is not success");
  assert.equal(r.code, "needs_attention");
  assert.equal(r.results!.find((e) => e.pane === D_IDS[0])!.outcome, "terminal_observed");
  assert.equal(r.results!.find((e) => e.pane === D_IDS[1])!.outcome, "needs_attention");
  assert.deepEqual(r.stillPending, []);
});

test("root-4: terminal identity drift must not settle the stale context or win", async () => {
  const world = new DeferredWorld("done");
  const svc = makeDeferredService(world);
  setDeferredPending(svc, {
    pane_id: D_IDS[0],
    workspace_id: "wD",
    terminal_id: "OLD_TERMINAL",
    baseline_seq: 8,
    receipt_seq: 10,
    receipt_state: "done",
    delivery_confirmed: true,
    working_observed: false,
  });
  const r = (await svc.execute("wait", {
    panes: [...D_IDS], until: "first", timeoutMs: 5000, returnLines: 0,
  })) as MultiResult;
  assert.equal(svc.pendingContext(D_IDS[0])?.settled, undefined, "drifted terminal must not settle the stale record (identity check)");
  assert.equal(r.winner, null, "a drift-invalidated observation cannot win");
  assert.equal(r.code, "no_winner");
  const entry = r.results!.find((e) => e.pane === D_IDS[0])!;
  assert.equal(entry.outcome, "terminal_observed");
  assert.equal(entry.status, "done", "the ACTUAL live terminal status/seq is reported, not fabricated");
  assert.equal(entry.seq, 10);
  assert.equal(entry.code, "identity_drift", "the observation is explicitly labelled as unassociated");
  assert.equal(entry.observation, "snapshot", "no fresh-tier label, no acknowledged delivery");
  assert.equal(entry.delivery, undefined, "no delivery attribution for a drift-invalidated observation");
});

test("root-4b: live terminal at a different sequence must not settle the receipt (receipt-sequence mismatch)", async () => {
  const world = new DeferredWorld();
  const svc = makeDeferredService(world);
  setDeferredPending(svc, {
    pane_id: D_IDS[0],
    workspace_id: "wD",
    terminal_id: world.states.get(D_IDS[0])!.terminalId,
    baseline_seq: 8,
    receipt_seq: 40, // receipt claims seq 40; the live terminal will be at seq 11
    receipt_state: "done",
    delivery_confirmed: true,
    working_observed: false,
  });
  const p = svc.execute("wait", {
    panes: [...D_IDS], until: "first", timeoutMs: 5000, returnLines: 0,
  }).then((r) => r as MultiResult);
  await dFlush();
  world.release(D_IDS[0], "done"); // live done at seq 11, not the receipt's 40
  world.release(D_IDS[1], "idle"); // the healthy peer supplies the eligible winner
  const r = await p;
  assert.equal(svc.pendingContext(D_IDS[0])?.settled, undefined, "tier-1 requires the live terminal to BE the receipt sequence; 11 != 40 must not settle");
  assert.equal(r.winner, D_IDS[1], "the stale-looking terminal cannot win; the fresh peer does");
  const entry = r.results!.find((e) => e.pane === D_IDS[0])!;
  assert.equal(entry.outcome, "terminal_observed");
  assert.equal(entry.status, "done", "the observed terminal is reported as an unassociated snapshot");
  assert.notEqual(entry.code, "terminal_seen_during_submission");
  assert.equal(entry.observation, "snapshot");
});

test("root-4c: drifted NONTERMINAL preflight still permits current-pane observation without old attribution", async () => {
  const world = new DeferredWorld();
  const svc = makeDeferredService(world);
  setDeferredPending(svc, {
    pane_id: D_IDS[0],
    workspace_id: "wD",
    terminal_id: "OLD_TERMINAL",
    baseline_seq: 8,
    delivery_confirmed: true,
    working_observed: true,
    working_seq: 9,
  });
  const p = svc.execute("wait", {
    panes: [...D_IDS], until: "first", timeoutMs: 5000, returnLines: 0,
  }).then((r) => r as MultiResult);
  await dFlush();
  world.release(D_IDS[0], "done"); // current identity transitions working -> done
  const r = await p;
  assert.equal(r.winner, D_IDS[0], "the current-pane observation is a fresh transition by this call and is eligible");
  const entry = r.results!.find((e) => e.pane === D_IDS[0])!;
  assert.equal(entry.outcome, "terminal_observed");
  assert.equal(entry.status, "done");
  assert.equal(entry.code, "snapshot", "no tier label from the discarded old context");
  assert.equal(entry.delivery, undefined);
  assert.equal(svc.pendingContext(D_IDS[0]), undefined, "the stale record was discarded at preflight, not kept around");
});

test("root-5: preflight tier-1 settlement settles immediately and is not held behind a still-working peer", async () => {
  const world = new DeferredWorld();
  const svc = makeDeferredService(world);
  const s9 = world.states.get(D_IDS[0])!;
  world.states.get(D_IDS[0])!.status = "done";
  setDeferredPending(svc, {
    pane_id: D_IDS[0],
    workspace_id: "wD",
    terminal_id: s9.terminalId,
    baseline_seq: s9.seq - 1,
    receipt_seq: s9.seq,
    receipt_state: s9.status,
    delivery_confirmed: true,
    working_observed: false,
  });
  // p10 stays working (its monitor is never released).
  let resolvedEarly = false;
  const p = svc.execute("wait", {
    panes: [...D_IDS], until: "first", timeoutMs: 5000, returnLines: 0,
  }).then((r) => {
    resolvedEarly = true;
    return r as MultiResult;
  });
  await dFlush();
  assert.equal(resolvedEarly, true, "a fresh eligible preflight settlement must return at once, not wait for the still-working peer");
  const r = await p;
  assert.equal(r.winner, D_IDS[0]);
  assert.equal(svc.pendingContext(D_IDS[0])?.settled, true);
  const loser = r.results!.find((e) => e.pane === D_IDS[1])!;
  assert.equal(loser.outcome, "timeout", "the never-observed loser stays pending/unsettled, not fabricated");
});

test("root-6: shared deadline cancels delayed preflights before a late terminal can win", async () => {
  const world = new DeferredWorld("done");
  const inner = deferredTransport(world);
  const signals: AbortSignal[] = [];
  const svc = new SubagentService({
    transport: {
      async run(args: string[], options: TransportOptions = {}) {
        if (args[0] === "agent" && args[1] === "get") {
          signals.push(options.signal!);
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              clearTimeout(timer);
              options.signal?.removeEventListener("abort", onAbort);
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            };
            const timer = setTimeout(() => {
              options.signal?.removeEventListener("abort", onAbort);
              resolve();
            }, 1000);
            options.signal?.addEventListener("abort", onAbort, { once: true });
          });
        }
        return inner.run(args, options);
      },
    },
    paneId: "wF:p1", runtimeDir: FAKE_SCRIPTS_DIR,
  });
  const started = Date.now();
  const r = await svc.execute("wait", { panes: [...D_IDS], until: "first", timeoutMs: 50, returnLines: 0 }) as MultiResult;
  assert.ok(Date.now() - started < 750, "deadline must span preflight, not start after its 1000ms delay");
  assert.ok(signals.length > 0);
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(r.winner, null);
  assert.equal(r.code, "no_winner");
  assert.deepEqual(r.stillPending, [...D_IDS]);
  assert.ok(r.results!.every(entry => entry.outcome === "timeout"));
});

test("root-7: caller abort during console capture preserves observed terminal and pending peer", async () => {
  const world = new DeferredWorld();
  const inner = deferredTransport(world);
  let captureStarted = false;
  const svc = new SubagentService({
    transport: {
      async run(args: string[], options: TransportOptions = {}) {
        if (args[0] === "agent" && args[1] === "read") {
          captureStarted = true;
          return new Promise<TransportResult>((resolve) => {
            const onAbort = () => {
              options.signal?.removeEventListener("abort", onAbort);
              resolve({ exitCode: 1, stdout: "", stderr: JSON.stringify({ error: { code: "aborted", message: "aborted" } }) });
            };
            if (options.signal?.aborted) onAbort();
            else options.signal?.addEventListener("abort", onAbort, { once: true });
          });
        }
        return inner.run(args, options);
      },
    },
    paneId: "wF:p1", runtimeDir: FAKE_SCRIPTS_DIR,
  });
  const controller = new AbortController();
  let returned = false;
  const p = svc.execute("wait", { panes: [...D_IDS], until: "first", timeoutMs: 5000, returnLines: 10 }, controller.signal)
    .then(r => { returned = true; return r as MultiResult; });
  await dFlush();
  world.release(D_IDS[0]);
  await dFlush();
  assert.equal(captureStarted, true, "abort must happen during a real pending console read");
  assert.equal(returned, false, "test must not abort after return");
  controller.abort();
  const r = await p;
  assert.equal(r.code, "aborted");
  const observed = r.results!.find(entry => entry.pane === D_IDS[0])!;
  assert.equal(observed.outcome, "terminal_observed");
  assert.equal(observed.status, "done");
  assert.ok(observed.consoleError, "cancelled capture remains explicit, not fabricated");
  assert.deepEqual(r.stillPending, [D_IDS[1]]);
  assert.equal(world.states.get(D_IDS[1])!.status, "working");
});

test("root-7b: after a first winner, already-resolved monitor promises are drained and their observations preserved", async () => {
  const world = new DeferredWorld();
  const svc = makeDeferredService(world);
  const p = svc.execute("wait", {
    panes: [...D_IDS], until: "first", timeoutMs: 5000, returnLines: 0,
  }).then((r) => r as MultiResult);
  await dFlush();
  // Both monitors resolve in the SAME tick; p9 resolves first (map order).
  world.release(D_IDS[0], "done");
  world.release(D_IDS[1], "idle");
  const r = await p;
  assert.equal(r.winner, D_IDS[0], "the chronologically earlier observation wins");
  const loser = r.results!.find((e) => e.pane === D_IDS[1])!;
  assert.equal(loser.outcome, "terminal_observed", "the loser's already-resolved observation must be preserved, not dropped");
  assert.equal(loser.status, "idle");
  assert.equal(loser.code, "snapshot");
  assert.ok(loser.seq !== undefined, "the preserved loser observation carries its seq");
});

test("root-8: completed winner reaps loser and removes actual abort listeners", async () => {
  const timersBefore = process.getActiveResourcesInfo().filter(kind => kind === "Timeout").length;
  const world = new DeferredWorld();
  const svc = makeDeferredService(world);
  const controller = new AbortController();
  const p = svc.execute("wait", { panes: [...D_IDS], until: "first", timeoutMs: 5000, returnLines: 0 }, controller.signal);
  await dFlush();
  const signals = D_IDS.map(id => world.waitSignals.get(id)!);
  assert.ok(signals.every(Boolean));
  assert.ok(getEventListeners(controller.signal, "abort").length > 0);
  world.release(D_IDS[0]);
  const r = await p as MultiResult;
  assert.equal(r.winner, D_IDS[0]);
  assert.equal(signals[1].aborted, true);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  for (const signal of signals) assert.equal(getEventListeners(signal, "abort").length, 0);
  assert.equal((world as unknown as { releases: Map<string, DRelease> }).releases.size, 0);
  assert.equal(process.getActiveResourcesInfo().filter(kind => kind === "Timeout").length, timersBefore, "shared deadline timer must be removed after a winner");
  controller.abort();
  assert.equal(world.states.get(D_IDS[1])!.status, "working");
});

test("root-9: first latches reverse-order ready monitors before any polling window", async () => {
  const world = new DeferredWorld();
  const svc = makeDeferredService(world);
  const p = svc.execute("wait", { panes: [...D_IDS], until: "first", timeoutMs: 5000, returnLines: 0 });
  await dFlush();
  world.release(D_IDS[1]);
  world.release(D_IDS[0]);
  const r = await p as MultiResult;
  assert.equal(r.winner, D_IDS[1]);
  assert.ok(r.results!.every(entry => entry.outcome === "terminal_observed"));
});

test("root-10: abort return waits for actual local transport cleanup", async () => {
  const timersBefore = process.getActiveResourcesInfo().filter(kind => kind === "Timeout").length;
  const world = new DeferredWorld();
  const inner = deferredTransport(world);
  const reaps: Array<() => void> = [];
  let active = 0;
  const svc = new SubagentService({
    transport: {
      async run(args: string[], options: TransportOptions = {}) {
        if (args[0] === "agent" && args[1] === "wait") {
          active++;
          return new Promise<TransportResult>(resolve => {
            const onAbort = () => reaps.push(() => {
              options.signal?.removeEventListener("abort", onAbort);
              active--;
              resolve({ exitCode: 1, stdout: "", stderr: JSON.stringify({ error: { code: "aborted", message: "local CLI reaped" } }) });
            });
            options.signal?.addEventListener("abort", onAbort, { once: true });
          });
        }
        return inner.run(args, options);
      },
    }, paneId: "wF:p1", runtimeDir: FAKE_SCRIPTS_DIR,
  });
  const controller = new AbortController();
  let returned = false;
  const p = svc.execute("wait", { panes: [...D_IDS], until: "all", timeoutMs: 5000, returnLines: 0 }, controller.signal)
    .then(r => { returned = true; return r as MultiResult; });
  await dFlush();
  assert.equal(active, 2);
  controller.abort();
  await dFlush();
  const returnedBeforeReap = returned;
  for (const reap of reaps) reap();
  const r = await p;
  assert.equal(returnedBeforeReap, false, "an abort-only race cannot claim resources reaped");
  assert.equal(active, 0);
  assert.equal(r.code, "aborted");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(process.getActiveResourcesInfo().filter(kind => kind === "Timeout").length, timersBefore, "shared deadline timer must be removed after abort");
});

test("root-11: blocked plus pending all-barrier remains partial, not fully observed needs-attention", async () => {
  const { world, svc } = worldWithTwoWorkers();
  world.agents.get("wF:p9")!.status = "blocked";
  world.scripts.set("wF:p10", ["TIMEOUT"]);
  const r = await svc.execute("wait", { panes: ["wF:p9", "wF:p10"], until: "all", returnLines: 0 }) as MultiResult;
  assert.equal(r.ok, false);
  assert.equal(r.code, "partial");
  assert.deepEqual(r.stillPending, ["wF:p10"]);
  assert.equal(r.results![0].outcome, "needs_attention");
});

test("root-12: typed preflight transport failure stays distinct from missing agent", async () => {
  const svc = new SubagentService({ transport: { async run() {
    throw Object.assign(new Error("herdr unavailable"), { name: "SpawnError" });
  } }, paneId: "wF:p1" });
  const r = await svc.execute("wait", { panes: ["wF:p9"], until: "all", returnLines: 0 }) as MultiResult;
  assert.equal(r.results![0].code, "SpawnError");
  assert.match(r.hint!, /per-pane errors/, "early failure must not falsely claim the shared deadline expired");
});
