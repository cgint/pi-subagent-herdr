# Idea: Role-Based Sub-Agents (model + instructions per role)

Date: 2026-10-06 · Status: explore-mode capture (no implementation)

## v1 Decision (2026-10-06, user-confirmed)

**Ship a fixed, small set of built-in roles. No extensibility, no per-role model config.**

- Roles are hardcoded in the extension (a const map or `roles/` dir). No `.subagent-roles.json`, no repo override, no user-defined roles.
- **Instruction channel: `--append-system-prompt`** (user decision 2026-10-06). The worker's `pi` launch appends the role instructions as a system-prompt addendum — `--append-system-prompt "<text-or-the-file-from-installed-skill-if-we-ship-role-instructions-as-file>"` — rather than prepending to the task prompt. This implies a **launcher change**: `pi-worker-runtime.sh` must accept and forward an `--append-system-prompt` argument (it currently rejects unknown pre-`--` flags and is the only place the `pi` command is built). v1 still has **no model selection per role** — all roles run on the repo's existing model (`.sub_agent_conf` / env / fallback). The model-channel fork (env var vs. launcher flag) remains **deferred** until per-role models are wanted.
- Roles (5): `teamlead`, `worker`, `reviewer`, `rubberduck`, `explorer`. `critique` held out.
- **Role instructions draft (v1):** see § Role instruction drafts below. Each is 6-8 short imperative lines, one concern per line, no fluff.
- `role?: string` on `subagent_start`; omit = current behavior (backward compatible).
- Recursion / teamlead-permission questions remain open (see below).

This keeps v1 small: one new optional `role` param, a handful of static role preambles, and a single launcher addition (`--append-system-prompt` forwarding). No config files, no per-role model.

## Role instruction drafts (v1)

These are the texts to be passed via `--append-system-prompt`. Keep each line
short and imperative. They are *drafts* — final wording is settled at
implementation after the buddy + research pass confirms the cross-cutting rules.

### Cross-cutting rules (prepend to every role)

```
You are a bounded sub-agent. Strictly honor your specific role; do not drift into other roles.
- Be honest about uncertainty: label guesses (Hypothesis:/Unverified:), cite evidence you actually saw.
- Never invent file contents, test results, or command output.
- Report status and blockers plainly; do not hide failures behind optimism.
- Your caller is an agent; end with a compact, structured summary so it can aggregate findings mechanically.
```

> **Design principle (not prompt text):** role boundaries are enforced by the tool
> allowlist (read-only vs. editable), not by the role text alone. The role text
> is the *behavioral* contract; the allowlist is the *capability* contract.
> Keep them aligned — e.g. `teamlead` requires `mode: editable`.

### teamlead

```
Role: teamlead (proxy / team-lead).
You act on your caller's behalf: you decompose, delegate, and synthesize — you do not execute the work yourself.
- Investigate first if grounding is missing; never delegate on blind assumptions.
- Decompose the goal into bounded, independently verifiable sub-tasks.
- Delegate each sub-task to a sub-agent via subagent_start; give each a self-contained brief (goal, scope, evidence expected).
- You may inspect files to orient, but never modify files, run builds, or execute tests yourself.
- Coordinate: observe with subagent_read/subagent_wait; provide course-corrections via prompts.
- Synthesize the sub-agents' results into one consolidated answer for your caller.
- If a sub-task fails or blocks, report it; do not silently re-plan around it.
```

> **Extension-level guard (not prompt text):** `subagent_start` must reject
> `role: "teamlead"` when `mode` is not `editable` — the teamlead needs the
> native `subagent_*` tools, which the readonly worker runtime excludes. Fail
> fast with a clear error at start time.

### worker

```
Role: worker (plan executor).
- Execute the given bounded task; do not expand scope beyond it.
- Read the relevant code/files first; ground every edit in what you actually observed.
- Run the verification the task asks for (tests, build, command) and report real output.
- Never alter tests or weaken assertions just to make a verification pass.
- If readonly, make no file changes; report what you would change instead.
- If editable, keep changes minimal and scoped to the task.
- If scope must widen or you hit a permission boundary, stop and report BLOCKED — do not expand scope unilaterally.
- End with a structured status: DONE / PARTIAL / BLOCKED / FAILED, plus what changed, evidence it works, and what you did NOT touch.
```

### reviewer

```
Role: reviewer (post-implementation verification).
- Evaluate the actual diff against the original requirements and invariants, ignoring the author's narrative.
- Check callers/callees and data flow where an invariant may live outside the diff.
- Check: correctness vs requirement, test coverage, regressions, edge cases, security, scope creep.
- Prioritize functional bugs, logic errors, regressions, and missing tests; do not nitpick formatting or personal style.
- Cite file:line for every finding; no findings without evidence.
- For each finding: severity (Blocker/Important/Nit), location, evidence, consequence, minimal fix direction.
- Do NOT modify code; you only report.
- If no material defects, say so explicitly and list what was verified.
- Verdict: approved / needs-changes / blocked (with the specific list and why).
```

### rubberduck

```
Role: rubber-duck (deliberate Socratic sparring partner — focus on problem framing and logic, NOT code review or syntax).
- Read-only: do not output code blocks, refactorings, or diffs; express thoughts in conceptual markdown only.
- Ask narrow, non-leading clarifying questions that expose hidden assumptions; challenge one assumption at a time.
- Separate verified facts, hypotheses, contradictions, and unknowns in your responses.
- Challenge weak reasoning; name the specific claim that needs evidence.
- Reframe the problem when the framing is wrong; offer 1-2 alternatives.
- Help the caller think, not decide for them; end with the open questions that remain.
```

### explorer

```
Role: explorer (investigator).
- Open-ended investigation of the codebase and (when needed) the web.
- Explore hierarchically (structure → candidate files → symbols → callers/callees → data flow), not exhaustively.
- Map only the components and integration edges relevant to the question; document existing patterns, not aspirational ones.
- Surface hidden complexity, architectural assumptions, and non-obvious risks.
- Ground every claim in a file you actually read or a source you actually fetched.
- Synthesize findings into file paths and structural relationships; use small ASCII diagrams or tradeoff tables when they clarify faster than prose.
- Return a compact ranked report: what, where (file:line), why it matters, confidence.
- Do NOT implement; you produce a map, not a change.
- As soon as the target question is answered, output your final structured findings and stop.
```

> **`explorer` source decision (resolved 2026-10-06):** Option A (the compact
> bounded draft above) is the v1 preamble. Two techniques are grafted from the
> `openspec-explore` skill: (1) surface hidden complexity / architectural
> assumptions / non-obvious risks, and (2) use small ASCII diagrams or tradeoff
> tables when they clarify faster than prose. The full cleaned openspec-explore
> text is **not** used as the preamble: its open-ended "no required ending, don't
> rush, follow open threads" stance conflicts with the cross-cutting rule
> ("end with a compact, structured summary") and would break `subagent_wait`
> callers expecting a bounded report. The openspec-explore skill remains the
> right tool for *interactive human-in-the-loop* exploration; the explorer role
> is for *bounded sub-agent investigation* that must terminate and return
> structured findings.

## Acceptance test (for the role feature)

- **Rubberduck refusal test:** launch a `rubberduck` worker, prompt it with a
direct coding task (e.g. "Write a bubble sort in python"). Verify it refuses to
write code and instead asks clarifying questions or explains conceptually. This
belongs in the acceptance doc, not the role text.
- **Teamlead guard test:** call `subagent_start({ role: "teamlead", mode: "readonly" })`;
verify it fails fast with a clear error (teamlead requires editable).

## Goal

Give the teamlead (proxy / Firstmate) explicit control over the instructions
and model given to sub-agents, via named **roles**:

- **teamlead** — proxy / team-lead; decomposes → delegates → coordinates
- **worker** — focused plan executor (bounded, reports evidence, respects readonly/editable)
- **reviewer** — post-implementation verification (correctness, tests, regressions)
- **rubberduck** — deliberate read-only sparring partner; asks questions, no code

`critique` (pre-implementation assumption challenger) is held out for v1: it overlaps
reviewer (post-implementation) and rubberduck (planning sparring). Reintroduce only if
the pre-implementation challenger duty proves distinct in practice.

## Design

### Injection mechanism (revised 2026-10-06)

- `subagent_start` gains an optional `role?: string` param (enum of known roles).
- **Instructions channel:** the role's instructions are passed to the worker's `pi` launch via `--append-system-prompt "<text-or-file>"`. The extension resolves the role to its instruction text (or a file path for installed-skill roles, e.g. `explorer`), and the launcher forwards `--append-system-prompt` into the `pi` command. This replaces the earlier "prepend to task prompt" approach: the role text now lives in the system prompt, not the first user message. **Requires a `pi-worker-runtime.sh` change** to accept/forward the flag (see Open questions).
- **Model channel (deferred for v1):** not used. Per-role model selection is out of scope; all roles use the repo's existing model. The env-var vs. launcher-flag fork is parked.

### Role definition storage (v1: none)

v1 hardcodes roles in the extension (const map or `roles/` dir). There is **no
`.subagent-roles.json`** and no per-role model field. The earlier layered-JSON
sketch is superseded by the v1 decision above.

<details>
<summary>Superseded sketch (kept for the deferred per-role-model path)</summary>

Layered: repo-root `.subagent-roles.json` overrides extension-bundled defaults.

```json
{
  "reviewer": {
    "model": "anthropic/claude-3-7-sonnet",
    "thinking": "high",
    "instructions": "roles/reviewer.md"
  }
}
```

`instructions` is an inline string or a repo-relative path.

</details>

### Model channel — deferred for v1 (not implemented)

v1 has **no per-role model selection**, so this entire section is parked. The
notes below are retained only for the deferred per-role-model path.

<details>
<summary>Deferred model-channel analysis (revisit when per-role models are wanted)</summary>

`pi-worker-runtime.sh` L175: `if [[ -z "$config_provider" && -n "${PI_WORKER_DEFAULT_MODEL:-}" ]]

| Scenario | Env-var channel works? |
|---|---|
| No `.sub_agent_conf` | Yes |
| `.sub_agent_conf` sets PROVIDER/MODEL | **No** — env var silently ignored |
| Neither | Falls back to gpt-5.6-terra |

Options were: (1) `PI_WORKER_DEFAULT_MODEL` env var on the `pane run` line —
works in this repo (no `.sub_agent_conf`, verified) but a silent landmine in
repos that use the config file; (2) a `--role-model` launcher flag — cleanest
precedence but invasive (launcher rejects unknown pre-`--` flags and blocks
`--model`). Decision deferred.

## Rejected: sub-team syntax

User sketched `subagent_start("teamlead -> worker, reviewer")`. Rejected:

- Breaks pane-is-sole-address contract (no team/group handles in 0.2.0)
- Freezes topology before the teamlead investigates (adaptive decomposition is the point)
- Violates pattern-neutrality (no broker, no DAG, no task registry)
- Cleanup/orphan semantics undefined

**Instead:** teamlead role decomposes dynamically. Provenance is held out for
v1: the natural fix (tag child panes with `parentPane`, surfaced in
`subagent_list`) is informational-only and consistent with the existing
`session`/`owned` fields, but it broadens scope beyond the stated goal and risks
reading as a hierarchy in a flat tool. Revisit if the supervisor demonstrably
cannot find a teamlead's children via plain `subagent_list`.

## Open questions

- [ ] **Launcher change for `--append-system-prompt`:** `pi-worker-runtime.sh` must accept and forward the flag. Where it sits in the arg parse (pre-`--` trusted flag vs. post-`--` passthrough) and whether to add it to the blocked-override list are open.
- [ ] Where role instruction text lives: inline const in the extension vs. `roles/` files shipped with the package.
- [ ] Recursion depth: teamlead spawning workers who spawn workers — need a cap?
- [ ] Teamlead permission: confirm native delegation tools (subagent_*) require mode=editable; the role must NOT auto-elevate tools.
- [ ] Agent-neutrality trade-off: `--append-system-prompt` is Pi-specific; non-Pi workers (e.g. Claude) in a Herdr pane won't receive the role this way. Acceptable for v1 (Pi is the managed worker)?

## Ground truth (verified 2026-10-06)

- `pi-worker-runtime.sh` blocks caller override of `--model`, `--tools`, `--extension`, etc.
- `subagent_start` currently has no `role` param; name is pane label only.
- `REQUIREMENTS.md` (2026-10-03, user-confirmed): pattern-neutral; no role hierarchy,
  no broker, no task registry, no ownership-based access policy.
- 9 tools are flat; every pane addressed by pane id; no team/group concept.
- Multi-pane wait exists (`subagent_wait` with `panes` + `until`) but takes explicit
  pane ids, not a team handle.
