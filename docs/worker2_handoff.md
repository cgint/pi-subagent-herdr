# Handoff: Worker 2 (Specs, Scripts & Pi Extension Pattern Scout)

**Identity Chain:** Horst (lead) → Judith (coordinator) → Worker 2: Clara (code scout)
**Task:** Read-only analysis of `sub-agent-herdr-supervisor` scripts and existing `../pi-*` extensions.
**Report Path:** `/Users/christian.gintenreiter/dev-external/pi-subagent-herdr/docs/worker2_report.md`
**Mode:** editable (authorized ONLY to write its report to `/Users/christian.gintenreiter/dev-external/pi-subagent-herdr/docs/worker2_report.md`).

## Specific Analysis Questions
1. **The Scripts as Specification (Requirement 1):**
   - Read `/Users/christian.gintenreiter/.pi/profiles/minimal/agent/skills/sub-agent-herdr-supervisor/scripts/herdr-start-subagent.sh`, `herdr-worker.sh`, `pi-worker-runtime.sh`, and `test_worker_launchers.sh`.
   - What exact flags and environment variables are set for `readonly` vs `editable`?
   - How does `.sub_agent_conf` resolution work, what syntax is allowed/forbidden, and how are models probed?
   - What caller arguments are blacklisted?
   - What are the naming conventions, handoff vs brief requirements, and report path validation rules?
2. **Sibling Pi Extensions Analysis (`../pi-*`):**
   - Inspect `../pi-herdr` (especially `src/herdr.ts`, `src/tools/orchestration.ts`, `src/tools/layout.ts`).
   - What tools does `pi-herdr` register? How does it execute `herdr` CLI commands (child_process, timeouts, AbortSignal)?
   - How does `pi-herdr` handle the agent wait race?
   - Inspect `../pi-supervisor` or `../pi-mini-self-org` for TypeScript structure, TypeBox schema usage, and tool registration patterns.
3. **Pi Extension API & Constraints:**
   - How are tool parameters and returns structured using TypeBox in Pi extensions?
   - Can tool handlers run long-running async operations, and how is `signal` (AbortSignal) passed?

## Expected Report Format (`docs/worker2_report.md`)
- Detailed answers to every question above, citing exact file paths and line numbers.
- Classification: `[Documented]` or `[Inferred]`.
- Summary of architectural recommendations for `pi-subagent-herdr`.
