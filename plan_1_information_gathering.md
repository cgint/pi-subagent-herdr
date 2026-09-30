# Plan 1: Information Gathering & Feasibility Probing

**Objective:** Systematically discover, experiment, and verify all technical facts, Herdr CLI behaviors, and Pi extension patterns before designing or implementing the `pi-subagent-herdr` extension.

---

## 1. Core Unknowns & Questions to Answer

### A. Herdr CLI Primitives & Key Sending
- **Interrupts & Keys:** What exact key identifier does `herdr pane send-keys <pane_id> ...` accept for `CTRL-D`? (e.g. `ctrl-d`, `C-d`, `^D`?)
- **Pi Session Reaction:** In an active Pi terminal session inside a Herdr pane, what actually happens when that key is sent?
  - Does it abort an in-flight prompt / model turn?
  - Does it exit the process when the prompt is empty?
  - What does `escape` do in comparison?
- **Text Injection:** How does `herdr pane send-text` handle trailing newlines / `<enter>`? Does it append Enter automatically, or do we need `send-text` + `send-keys Enter`?

### B. Console Reading & Tail Extraction
- **Read Capabilities:** What are the exact flags and output formats of `herdr pane read` vs `herdr agent read`?
- **Tail Mechanics:** Can Herdr return the last $X$ characters natively, or does it only support line counts (`--lines N`) / raw screen buffers requiring the extension to slice the trailing characters?
- **ANSI Codes & Formatting:** Does `herdr pane read` return raw escape sequences, and how should they be handled/stripped for clean consumption?

### C. Waiting & Completion Lifecycle
- **Wait Behavior:** How does `herdr agent wait` vs `herdr pane wait-output` behave under:
  - Normal finish / idle transition?
  - Non-zero process exit?
  - Hard timeouts?
- **Immediate Return with Console Preview:** When the user requests "return immediately e.g. after X seconds with the last 50 characters", what is the cleanest non-blocking mechanism? (e.g. timeout on the wait call, or polling loop?)

### D. Workspace & Pane Introspection
- **Queries:** What JSON structures are returned by `herdr workspace list` and `herdr pane list`?
- **Filtering:** Can `herdr pane list` be filtered directly by workspace ID via CLI flag, or is filtering done on the returned JSON array?

### E. Pi Extension Architectural Patterns (from `../pi-*`)
- How do sibling extensions (`../pi-herdr`, `../pi-supervisor`, `../pi-mini-self-org`) structure their:
  - TypeScript compilation and packaging (`package.json`, `tsconfig.json`)?
  - Tool definition schemas using TypeBox?
  - Execution cancellation (`AbortSignal` / `signal` from Pi tool context)?
  - Child process spawning and error mapping?

---

## 2. Multi-Agent Investigation Graph

```
                        +----------------------+
                        |     User (Human)     |
                        +----------+-----------+
                                   |
                                   v
+--------------------------------------------------------------------+
|                            Horst (Lead)                            |
| - Owns investigation scope, synthesizes findings, stays with User  |
| - Prepares handoffs and accepts findings                           |
+-------------------+----------------------------+-------------------+
                    |                            |
                    v (Critiques discovery plan) v (Delegates bounded research)
+-----------------------------+     +--------------------------------+
|  Judith (Buddy Coordinator) |     |   Sub-Agent Workers (Herdr)    |
|  HERDR_PANE_ID=w2V:p2       |     |                                |
| - Audits questions/assumptions     | [Worker 1: Herdr Experiments]  |
| - Spots discovery blind spots      |   - Tests send-keys, wait, read|
|                             |     | [Worker 2: Pattern Scout]      |
|                             |     |   - Studies ../pi-* extensions |
+-----------------------------+     +--------------------------------+
```

### Roles & Responsibilities:
- **Horst (Lead):** Coordinates the investigation, issues bounded handoffs to workers, inspects raw output, and synthesizes findings into durable evidence.
- **Judith (Buddy / Coordinator at `w2V:p2`):** Peer critique. Evaluates the investigation plan for blind spots, verifies whether experimental evidence is conclusive, and prevents premature solutioning.
- **Worker 1 (Herdr CLI Probe):** Runs in an isolated test pane to run live CLI experiments for `send-keys`, `send-text`, `read`, `wait`, and `list`.
- **Worker 2 (Extension Pattern Scout):** Read-only analysis of `../pi-herdr`, `../pi-supervisor`, etc., extracting exact code patterns for TypeBox schemas, child process management, and cancellation.

---

## 3. Execution Phases for Investigation

1. **Step 1: Peer Audit by Judith**
   - Judith reviews this document (`plan_1_information_gathering.md`).
   - Surfaces any unaddressed technical unknowns or risky assumptions.
2. **Step 2: Delegated Probing**
   - Horst launches Worker 1 and Worker 2 with exact, bounded handoffs.
   - Workers report concrete terminal findings and experimental output.
3. **Step 3: Verification & Evidence Synthesis**
   - Horst independently inspects the findings and updates `plan_1_information_gathering.md` with verified answers.
   - Judith cross-checks that all 9 requirement primitives have verified feasibility.
4. **Step 4: Transition to Solution Design (Plan 2)**
   - Only after all unknowns are grounded do we draft the extension architecture.
