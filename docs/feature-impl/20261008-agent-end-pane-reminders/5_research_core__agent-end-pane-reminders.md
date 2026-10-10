# Research: core.ts data needs (agent-end-pane-reminders)

Worker: research-core (readonly) · Source: core.ts + index.ts (full read)

## getOwned() shape + pruning
- `getOwned(): OwnedRecord[]` returns shallow copies of a private `Map<pane_id, OwnedRecord>`;
  keyed on `pane_id` only.
- `OwnedRecord`: `pane_id, workspace_id, terminal_id?, name?, launched_at?, session?, pending?` —
  **identity only; no live status, no liveness flag.**
- Pruning (`owned.delete`) at exactly 3 sites: start (launch failed + verified close), and two in
  `close()` (verified absence; also writes a retired tombstone). **No periodic pruning** — dead-but-
  unclosed panes stay "owned" (core keeps them "managed for inspection"). **Owned ≠ live-open.**
- `restoreOwned()` repopulates from persisted session entries (index.ts calls it after restart) —
  so `getOwned().length > 0` can be true while *nothing* is live-open (restored-but-dead panes).

## list() per-pane fields
- Public async method: `list(args, signal)`; `args.workspace` = "current" (default, via supervisor
  pane get) | explicit id | "all". No other args; `signal` optional.
- Items (`listWorkspace`): `pane_id, workspace_id, terminal_id, cwd, name, agent, agent_status,
  terminal_title, focused, owned`.
- `agent_status` = **raw pass-through** (`a?.agent_status ?? p.agent_status ?? "unknown"`). Terminal
  set in core is `["idle","done","blocked"]`; `working`/`unknown` also occur. **No interpretation —
  raw only**, as the feature requires.
- `owned` computed in the wrapper: `p.pane_id ? this.isOwned(p.pane_id) !== undefined : false`.
- Cost: **2 Herdr CLI calls per workspace** (`pane list --workspace` + `agent list`); failures →
  `ok:false`, no items.

## isOwned
- `private isOwned(paneId)`: pure `owned.get(paneId)` map lookup, exact `pane_id` match, sync.
  **Private** — the extension must use `getOwned().some(r => r.pane_id === x)` (the existing
  index.ts `runOp` pattern).

## Extension access path (feasible)
- `ensureService(ctx)` (index.ts) is the only access route; needs `ExtensionContext` (for
  session-scoped caching). Returns `SubagentServiceLike` (interface): only `execute(op, params,
  signal)`, `getOwned()`, `restoreOwned()`.
- Calling `list()` from a handler is feasible: `await service.execute("list",
  { workspace: "current" }, signal)`. `execute` does no UI/session work — pure service logic.
  Proven pattern: `pi.on("session_start")` already calls `ensureService(ctx)` + `getOwned()`.
- No-op fast path: `getOwned()` is synchronous, zero CLI calls — `length 0` → skip.

## Existing handlers to coexist with
- `pi.on("session_start")`: footer + `ensureService` + restored-panes notify.
- `pi.on("session_shutdown")`: footer + warn on `ownedState.service.getOwned()` pane ids still
  open, then nulls `ownedState`. Closest sibling to the new handler — mirror its notify style;
  don't disturb `ownedState` nulling.
- **No existing `agent_end` handler** (grep confirmed). Also coexists: the 9 `subagent_*` tools and
  `/herdr-fork` (separate `HerdrForkService`, unrelated instance).

## Gaps (feature needs core.ts does NOT provide)
1. **"Live-open" is not a field.** The feature's trigger (fire when an owned pane is live-open)
   must *derive* liveness: an owned pane is live-open iff it appears in `list` items (pane still
   enumerable by `pane list`) or a `pane get` probe. Gating on `getOwned().length > 0` alone would
   fire reminders on dead-but-owned panes *and* on restored-but-dead panes after restart.
   **The trigger must gate on live-open, not `getOwned().length > 0`.** (Note: `session_shutdown`
   today warns on `getOwned()` alone — that is arguably the stale case this feature should fix.)
2. **No cheap owned-only status query.** Raw live status per owned pane is obtainable only via
   `execute("list", ...)` (2 CLI calls/workspace, includes non-owned panes; filter `owned===true`)
   OR per-pane `execute("read", { pane, returnLines: 0 })` (1 `agent get` call per owned pane,
   returns raw `{ status, seq, agent, workspace }`, no console — `read`'s `lines<=0` early return).
   N owned panes ⇒ N CLI calls, **no batch primitive**. Leanest raw-status path is per-pane
   `read returnLines=0`; exact cost of `agent list` vs N×`agent get` unverified.
3. **`isOwned` is private** — feature must use `getOwned().some(...)`.
4. **No `agent_end` hook surface in core.** Core is event-agnostic; the handler lives entirely in
   index.ts and touches the service only via `ensureService` + `getOwned`/`execute`. Nothing to add
   to core for the trigger itself.
5. **`agent_status` values are raw Herdr strings** — no normalization beyond `?? "unknown"`; a
   `blocked` pane reads as `blocked`, the natural "needs attention" signal for the reminder text.
