# Project Overview: pi-subagent-herdr

**Status:** Initial bootstrapping & planning phase (Date: 2025-09-30)

## Quick Re-entry
- **Goal:** Replace bash scripts from `sub-agent-herdr-supervisor` skill with a native TypeScript Pi extension providing direct tools to control Herdr sub-agents.
- **Active Team:**
  - Horst (Lead / Firstmate)
  - Judith (Coordinator / Plan Cross-checker at `HERDR_PANE_ID=w2V:p2`)
- **Key Documents:**
  - `REQUIREMENTS.md`: Verbatim user requirements for the extension toolset.
  - `AGENTS.md`: Standing memory stewardship contract and operating guidelines.
  - `docs/plan.md`: (Pending) Architectural specification and implementation roadmap.

## Required Tool Capabilities (from REQUIREMENTS.md)
1. `start_subagent`: Launch sub-agent (modes: read-only, read-write / editable, etc., matching existing wrapper script capabilities).
2. `wait_subagent_or_timeout`: Decide whether to wait for completion directly or return immediately (e.g. after X seconds with the last 50 chars of console).
3. `get_console_content`: Read console content from a target pane.
4. `wait_console_finish`: Wait for a console to finish (`--wait`) and return with the last X chars of console.
5. `send_pane_text`: Send text followed by `<enter>` to another pane.
6. `send_pane_interrupt`: Send interrupt to another pane (specifically CTRL-D for Pi).
7. `list_workspace_panes`: List all panes within the same Herdr workspace.
8. `list_workspaces`: List Herdr workspaces.
9. `close_pane`: Close a pane.

## Next Actions
1. Investigate existing `scripts/herdr-start-subagent.sh`, `scripts/herdr-worker.sh`, and `herdr_prompt_agent.sh` in `.pi` profiles to capture all edge cases and parameters.
2. Draft architecture & tool signatures in `docs/plan.md`.
3. Consult and cross-check with Judith (`w2V:p2`).
4. Review with user before implementation.
