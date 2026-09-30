# Handoff: Worker 1 (Herdr Live CLI Experiments)

**Identity Chain:** Horst (lead) → Judith (coordinator) → Worker 1: Fritz (experimenter)
**Task:** Live probing of Herdr CLI primitives for keys, text, wait, console read, and workspace/pane management.
**Report Path:** `/Users/christian.gintenreiter/dev-external/pi-subagent-herdr/docs/worker1_report.md`
**Mode:** editable (strictly authorized ONLY to write to the designated report path and test inside its own scratch workspace).

## Safety Box & Strict Constraints
1. Create a dedicated scratch workspace (e.g. `herdr workspace create probe-scratch`) or dedicated scratch tab for all tests.
2. **DO NOT** send text, send keys, or close `w2V:p1` (Horst) or `w2V:p2` (Judith) under any circumstances.
3. Track every pane and workspace created and clean them up before exiting.

## Specific Experiments to Run & Document
1. **Keys & Interrupt:**
   - Test `herdr pane send-keys <pane_id> ...` syntax. What keys are valid? (e.g. `c-d`, `C-d`, `ctrl-d`, `ctrl+d`, `esc`, `Enter`).
   - Launch a throwaway dummy Pi or bash process in the scratch workspace. What happens when you send `ctrl-d` vs `esc`? Does `ctrl-d` exit Pi when prompt is empty? Does `esc` cancel?
2. **Send Text:**
   - Test `herdr pane send-text <pane_id> "hello"`. Does it submit immediately with enter, or require an explicit newline / Enter keypress?
3. **Console Read:**
   - Run commands in a scratch pane. Test `herdr pane read <pane_id> --source recent-unwrapped` and `--source recent`.
   - Test `--lines <N>` and `--format text`. Does Herdr support character slicing natively, or is string slicing needed client-side?
4. **Wait Mechanics & Race:**
   - Test `herdr agent wait <target> --timeout 2000`. What is the JSON payload on timeout vs success?
   - Test what happens right after prompting an agent: does `herdr agent wait` immediately return if queried before status transitions from idle to working? How does `state_change_seq` relate?
5. **Pane & Workspace Queries:**
   - Test `herdr workspace list` and `herdr pane list`. Can `pane list` filter by workspace?
   - Test `herdr pane close <pane_id>`. What happens if the pane is already closed?

## Expected Report Format (`docs/worker1_report.md`)
- Table of findings with exact CLI commands, raw JSON/terminal outputs, and status `[Observed]`.
- Confirmation that all scratch panes/workspaces were closed.
