# High-Level Plan: Investigation & Information Gathering

**Objective:** Systematically discover and verify all facts, mechanics, and constraints needed to design the `pi-subagent-herdr` extension before committing to any solution architecture.

---

## 1. Information Gaps to Investigate

Before drafting any tool signatures or implementation details, we must verify:

1. **Herdr CLI Primitives & Capabilities:**
   - How does Herdr send keys (`herdr pane send-keys`)? Does it support `C-d`, `ctrl-d`, `escape`? What is the exact syntax?
   - How does `herdr pane send-text` handle newlines / `<enter>`?
   - How does `herdr pane read` vs `herdr agent read` work, what output formats/flags do they provide, and how do they handle unwrapped lines / trailing characters?
   - What does `herdr pane wait-output` vs `herdr agent wait` output on timeout, success, or abort?
   - How are workspaces and panes queried and filtered via JSON?
2. **Pi Subagent Runtime & Security Environment:**
   - What environment variables, profile paths, and safety guards (`PI_WRITE_GUARD_DIRS`, tool limitations, `.sub_agent_conf`) are required to make a subagent launch correctly in Herdr?
   - How does Pi handle interrupts (Ctrl-D vs Escape)? What does each do to an interactive Pi session in a Herdr pane?
3. **Existing Extensions in `../pi-*`:**
   - How do sibling extensions (`../pi-herdr`, `../pi-supervisor`, `../pi-mini-self-org`) structure their TypeScript modules, manage child processes, handle timeouts, and integrate with Pi's extension API?

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
+-------------------+----------------------------+-------------------+
                    |                            |
                    v (Reviews investigation)    v (Bounded research tasks)
+-----------------------------+     +--------------------------------+
|  Judith (Buddy Coordinator) |     |   Sub-Agent Workers (Herdr)    |
|  HERDR_PANE_ID=w2V:p2       |     |                                |
| - Audits investigation plan |     | [Worker 1: Herdr CLI & Keys]   |
| - Checks for blind spots    |     |   - Tests send-keys, wait, etc |
| - Evaluates findings        |     | [Worker 2: Pi Extension Study] |
|                             |     |   - Studies ../pi-* patterns   |
+-----------------------------+     +--------------------------------+
```

---

## 3. High-Level Phases of Investigation

- **Phase 1: Review of this Investigation Plan (Current)**
  - Have Judith audit these investigation questions and identify any blind spots we missed.
- **Phase 2: Delegated Fact-Finding via Subagents**
  - Worker 1: Probes Herdr CLI capabilities (send-keys for CTRL-D/Escape, send-text with enter, pane/agent read, workspace/pane listing).
  - Worker 2: Inspects sibling extensions (`../pi-herdr`, etc.) to map out standard Pi extension patterns, schemas, and lifecycle hooks.
- **Phase 3: Synthesis & Verification**
  - Horst and Judith inspect the concrete findings.
  - Only after facts are verified do we move to designing the actual extension architecture.
