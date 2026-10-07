// Node:test suite for role-based subagents (v1).
// Tests role validation, teamlead guard, launch command construction with
// --append-system-prompt, and preamble content integrity.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SubagentService,
  shellQuote,
  ROLES,
  CROSS_CUTTING_RULES,
  rolePreamble,
} from "../core.js";
import type { Transport, TransportResult, TransportOptions } from "../transport.js";

// ---------------------------------------------------------------------------
// Minimal fake world (reuses the same pattern as core.test.ts)
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
  panesAlive = new Set<string>();
  calls: Array<{ args: string[]; timeoutMs?: number }> = [];
  splitPaneCounter = 1;
  splitTerminals = new Map<string, string>();
  promptText: string[] = [];

  addPanes(paneIds: string[], _workspace: string) {
    for (const id of paneIds) this.panesAlive.add(id);
  }

  addAgent(
    paneId: string,
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
    this.addPanes([paneId], "wF");
  }
}

function agentDoc(paneId: string, a: FakeAgent) {
  const doc: Record<string, unknown> = {
    agent: a.kind,
    agent_status: a.status,
    state_change_seq: a.seq,
    pane_id: paneId,
    workspace_id: "wF",
    terminal_id: a.terminalId,
    name: a.name,
  };
  if (a.managed && a.kind === "pi") {
    doc.agent_session = { agent: "pi", kind: "path", source: "herdr:pi", value: `/fake/${paneId}.jsonl` };
  }
  return {
    id: "cli:agent:get",
    result: { type: "agent_info", agent: doc },
  };
}

function makeTransport(world: FakeWorld): Transport {
  return {
    async run(args: string[], _options: TransportOptions = {}): Promise<TransportResult> {
      world.calls.push({ args: [...args] });
      const [c0, c1, c2] = args;
      const out = (obj: unknown): TransportResult => ({
        exitCode: 0,
        stdout: JSON.stringify(obj),
        stderr: "",
      });

      if (c0 === "pane" && c1 === "get") {
        const id = c2!;
        if (!world.panesAlive.has(id)) {
          return { exitCode: 1, stdout: "", stderr: JSON.stringify({ error: { code: "pane_not_found", message: `pane ${id} not found` } }) };
        }
        const a = world.agents.get(id);
        return out({
          id: "cli:pane:get",
          result: {
            type: "pane_info",
            pane: { pane_id: id, workspace_id: "wF", terminal_id: a?.terminalId, agent_status: a?.status ?? "unknown" },
          },
        });
      }

      if (c0 === "pane" && c1 === "split") {
        world.splitPaneCounter += 1;
        const id = `wF:p${world.splitPaneCounter}`;
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
              tab_id: "wF:t1",
              terminal_id: `term_split_${world.splitPaneCounter}`,
              workspace_id: "wF",
            },
          },
        });
      }

      if (c0 === "pane" && c1 === "run") {
        const id = c2!;
        if (!world.panesAlive.has(id)) {
          return { exitCode: 1, stdout: "", stderr: JSON.stringify({ error: { code: "pane_not_found", message: `pane ${id} not found` } }) };
        }
        if (!world.agents.has(id)) {
          world.addAgent(id, { status: "idle", terminalId: world.splitTerminals.get(id) });
        }
        return out({ id: "cli:pane:run", result: { type: "ok" } });
      }

      if (c0 === "agent" && c1 === "get") {
        const id = c2!;
        const a = world.agents.get(id);
        if (!a || !a.alive || !world.panesAlive.has(id)) {
          return { exitCode: 1, stdout: "", stderr: JSON.stringify({ error: { code: "agent_not_found", message: `agent target ${id} not found` } }) };
        }
        return out(agentDoc(id, a));
      }

      if (c0 === "agent" && c1 === "rename") {
        const id = c2!;
        const a = world.agents.get(id);
        if (!a || !a.alive) {
          return { exitCode: 1, stdout: "", stderr: JSON.stringify({ error: { code: "agent_not_found", message: `agent target ${id} not found` } }) };
        }
        a.name = args[3]!;
        return out({ id: "cli:agent:rename", result: { type: "ok" } });
      }

      if (c0 === "agent" && c1 === "prompt") {
        const id = c2!;
        world.promptText.push(args[3]!);
        const a = world.agents.get(id);
        if (!a || !a.alive) {
          return { exitCode: 1, stdout: "", stderr: JSON.stringify({ error: { code: "agent_not_found", message: `agent target ${id} not found` } }) };
        }
        return out({ id: "cli:agent:prompt", result: { type: "agent_prompted" } });
      }

      if (c0 === "pane" && c1 === "close") {
        const id = c2!;
        world.panesAlive.delete(id);
        return out({ id: "cli:pane:close", result: { type: "ok" } });
      }

      if (c0 === "agent" && c1 === "wait") {
        const id = c2!;
        const a = world.agents.get(id);
        if (!a || !a.alive) {
          return { exitCode: 1, stdout: "", stderr: JSON.stringify({ error: { code: "agent_not_found", message: `agent target ${id} not found` } }) };
        }
        return out({ id: "cli:agent:wait", result: { type: "agent_state", agent_status: a.status, state_change_seq: a.seq } });
      }

      // Default: return ok for unknown commands
      return out({ id: `cli:${c0}:${c1}`, result: { type: "ok" } });
    },
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const FAKE_SCRIPTS_DIR = mkdtempSync(join(tmpdir(), "role-fake-scripts-"));
writeFileSync(join(FAKE_SCRIPTS_DIR, "herdr-worker.sh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

function makeService(world: FakeWorld): SubagentService {
  return new SubagentService({
    transport: makeTransport(world),
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

function worldWithSupervisor() {
  const world = new FakeWorld();
  world.addPanes(["wF:p1"], "wF");
  return world;
}

// ---------------------------------------------------------------------------
// 1. Role omitted → no --append-system-prompt in launch command
// ---------------------------------------------------------------------------

test("role omitted: launch command has no --append-system-prompt", async () => {
  const world = worldWithSupervisor();
  const svc = makeService(world);
  const r = await svc.execute("start", {
    name: "otto",
    cwd: process.cwd(),
    mode: "readonly",
    task: "Do the thing",
  });
  assert.equal(r.ok, true);
  const runCall = world.calls.find((c) => c.args[0] === "pane" && c.args[1] === "run")!;
  const command = runCall.args[3] as string;
  assert.ok(command.includes("--mode readonly --"), `cmd: ${command}`);
  assert.ok(!command.includes("--append-system-prompt"), `no flag when role omitted: ${command}`);
});

// ---------------------------------------------------------------------------
// 2. Role valid → command contains --append-system-prompt with full preamble
// ---------------------------------------------------------------------------

test("role valid (worker): launch command includes --append-system-prompt with combined preamble", async () => {
  const world = worldWithSupervisor();
  const svc = makeService(world);
  const r = await svc.execute("start", {
    name: "wkr",
    cwd: process.cwd(),
    mode: "readonly",
    role: "worker",
    task: "Fix the bug",
  });
  assert.equal(r.ok, true);
  const runCall = world.calls.find((c) => c.args[0] === "pane" && c.args[1] === "run")!;
  const command = runCall.args[3] as string;
  assert.ok(command.includes("--append-system-prompt"), `flag present: ${command}`);
  const expected = rolePreamble("worker");
  // The value is shell-quoted; verify the quoted form is in the command.
  assert.ok(command.includes(shellQuote(expected)), `combined preamble shell-quoted in command: ${command.slice(0, 200)}`);
  assert.ok(command.includes("--mode readonly"), "mode flag present");
  // The flag sits before the final `--`
  const flagIdx = command.indexOf("--append-system-prompt");
  const dashDashIdx = command.lastIndexOf("--");
  assert.ok(flagIdx < dashDashIdx, "flag is before the -- separator");
});

// ---------------------------------------------------------------------------
// 3. Role unknown → error naming the role + known roles, no pane created
// ---------------------------------------------------------------------------

test("role unknown (critic): error naming role and known roles, no pane created", async () => {
  const world = worldWithSupervisor();
  const svc = makeService(world);
  const r = await svc.execute("start", {
    name: "crt",
    cwd: process.cwd(),
    mode: "readonly",
    role: "critic",
    task: "Critique this",
  });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "error");
  assert.equal(r.phase, "validation");
  assert.equal(r.code, "unknown_role");
  assert.ok(r.hint!.includes("critic"), `hint names the role: ${r.hint}`);
  assert.ok(r.hint!.includes("teamlead"), "hint lists known roles");
  assert.ok(r.hint!.includes("worker"), "hint lists known roles");
  assert.ok(r.hint!.includes("reviewer"), "hint lists known roles");
  assert.ok(r.hint!.includes("rubberduck"), "hint lists known roles");
  assert.ok(r.hint!.includes("explorer"), "hint lists known roles");
  // No pane split or run calls made
  const splitCalls = world.calls.filter((c) => c.args[0] === "pane" && c.args[1] === "split");
  assert.equal(splitCalls.length, 0, "no pane split for unknown role");
});

// ---------------------------------------------------------------------------
// 4. Role "teamlead" + mode "readonly" → fail-fast error
// ---------------------------------------------------------------------------

test("role teamlead + mode readonly: fail-fast error", async () => {
  const world = worldWithSupervisor();
  const svc = makeService(world);
  const r = await svc.execute("start", {
    name: "tl",
    cwd: process.cwd(),
    mode: "readonly",
    role: "teamlead",
    task: "Lead the team",
  });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, "error");
  assert.equal(r.phase, "validation");
  assert.equal(r.code, "teamlead_requires_editable");
  assert.ok(r.hint!.includes("teamlead requires mode: editable"), `hint: ${r.hint}`);
  // No pane created
  const splitCalls = world.calls.filter((c) => c.args[0] === "pane" && c.args[1] === "split");
  assert.equal(splitCalls.length, 0, "no pane split for teamlead+readonly");
});

// ---------------------------------------------------------------------------
// 5. Role "teamlead" + mode "editable" → accepted (start flow proceeds)
// ---------------------------------------------------------------------------

test("role teamlead + mode editable: accepted, preamble in launch command", async () => {
  const world = worldWithSupervisor();
  const svc = makeService(world);
  const r = await svc.execute("start", {
    name: "tl",
    cwd: process.cwd(),
    mode: "editable",
    role: "teamlead",
    task: "Lead the team",
  });
  assert.equal(r.ok, true);
  const runCall = world.calls.find((c) => c.args[0] === "pane" && c.args[1] === "run")!;
  const command = runCall.args[3] as string;
  assert.ok(command.includes("--mode editable"), "editable mode");
  assert.ok(command.includes("--append-system-prompt"), "preamble flag present");
  const expected = rolePreamble("teamlead");
  assert.ok(command.includes(shellQuote(expected)), "teamlead preamble in command");
});

// ---------------------------------------------------------------------------
// 6. Preamble content tests
// ---------------------------------------------------------------------------

test("ROLES contains exactly five role keys", () => {
  const keys = Object.keys(ROLES).sort();
  assert.deepEqual(keys, ["explorer", "reviewer", "rubberduck", "teamlead", "worker"]);
});

test("rolePreamble: starts with CROSS_CUTTING_RULES and contains role body", () => {
  for (const role of Object.keys(ROLES)) {
    const combined = rolePreamble(role);
    assert.ok(
      combined.startsWith(CROSS_CUTTING_RULES),
      `${role}: combined starts with cross-cutting rules`,
    );
    assert.ok(
      combined.includes(ROLES[role]),
      `${role}: combined contains role body`,
    );
    // Exact structure: cross-cutting + "\n\n" + body
    assert.equal(combined, `${CROSS_CUTTING_RULES}\n\n${ROLES[role]}`, `${role}: exact join`);
  }
});

test("teamlead preamble: line-for-line spot check against spec", () => {
  const expected = `Role: teamlead (orchestrator / proxy lead).
You act on your caller's behalf. Your product is coordination and acceptance — not code.

Invariants (for application code and tests — no exceptions, no size-based bypass):
1. You NEVER write, edit, or patch application code or tests yourself.
   If a task requires changing repository source or tests, it is DELEGATED.
   (An explicit user instruction to do it directly — any phrasing — overrides;
    say so when acting on it.)
2. Scouting is not licensing: reading specs, code, and test harnesses is
   reconnaissance to write sharp briefs — never a license to implement.
3. No "too small / too cohesive / I already have the context" escape hatches.
   Even a single bounded slice goes through: implementer (editable) → reviewer
   (readonly) → your independent acceptance.

Permitted lead work (your own writes, no delegation needed):
- Handoff briefs, status/docs, pairing memory (AGENTS.md, docs/), workpads.
- Read-only inspection: read, grep, ls, git status/diff/log.
- Final acceptance: inspecting worker evidence and the diff; re-running acceptance
  checks. (For a spawned teamlead, acceptance = inspecting its workers' evidence,
  never re-implementing or re-testing in place of them.)
- Decomposition decisions, course-correction prompts, final acceptance.

Pipeline for every implementation task:
1. Decompose into bounded, verifiable sub-tasks; write a self-contained brief
   (goal, scope, allowed/forbidden paths, evidence contract, stop rule).
2. subagent_start an editable worker with that brief.
3. subagent_start a readonly reviewer to verify the diff against the brief/spec.
4. Independently accept, then report to your caller. Close owned panes after
   evidence capture.
5. On worker failure/block: report it, re-plan with a corrected brief — do not
   absorb the work into yourself.`;
  assert.equal(ROLES["teamlead"], expected, "teamlead preamble matches spec verbatim");
});

test("rubberduck preamble: line-for-line spot check against spec", () => {
  const expected = `Role: rubber-duck (deliberate Socratic sparring partner — focus on problem framing and logic, NOT code review or syntax).
- Read-only: do not output code blocks, refactorings, or diffs; express thoughts in conceptual markdown only.
- Ask narrow, non-leading clarifying questions that expose hidden assumptions; challenge one assumption at a time.
- Separate verified facts, hypotheses, contradictions, and unknowns in your responses.
- Challenge weak reasoning; name the specific claim that needs evidence.
- Reframe the problem when the framing is wrong; offer 1-2 alternatives.
- Help the caller think, not decide for them; end with the open questions that remain.`;
  assert.equal(ROLES["rubberduck"], expected, "rubberduck preamble matches spec verbatim");
});

test("CROSS_CUTTING_RULES: matches spec verbatim", () => {
  const expected = `You are a bounded sub-agent. Strictly honor your specific role; do not drift into other roles.
- Be honest about uncertainty: label guesses (Hypothesis:/Unverified:), cite evidence you actually saw.
- Never invent file contents, test results, or command output.
- Report status and blockers plainly; do not hide failures behind optimism.
- Your caller is an agent; end with a compact, structured summary so it can aggregate findings mechanically.`;
  assert.equal(CROSS_CUTTING_RULES, expected, "cross-cutting rules match spec verbatim");
});

// ---------------------------------------------------------------------------
// 7. Edge: role="" (empty string) behaves like no role
// ---------------------------------------------------------------------------

test("role empty string: no --append-system-prompt, same as omitting", async () => {
  const world = worldWithSupervisor();
  const svc = makeService(world);
  const r = await svc.execute("start", {
    name: "emp",
    cwd: process.cwd(),
    mode: "readonly",
    role: "",
    task: "Task",
  });
  assert.equal(r.ok, true);
  const runCall = world.calls.find((c) => c.args[0] === "pane" && c.args[1] === "run")!;
  const command = runCall.args[3] as string;
  assert.ok(!command.includes("--append-system-prompt"), `no flag for empty role: ${command}`);
});
