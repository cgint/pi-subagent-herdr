# Implementation & Live Acceptance: `/herdr-reloc-tab`

> **Status:** Implemented + live-accepted (2026-10-12/27 session)
> **Requirements:** [`2_requirements__herdr-reloc-tab.md`](./2_requirements__herdr-reloc-tab.md)
> **Plan:** [`3_plan__herdr-reloc-tab.md`](./3_plan__herdr-reloc-tab.md)

## What was built

| File | Role |
|---|---|
| `reloc.ts` | `HerdrRelocService` + `RelocResult` + `defaultRelocLauncherPath()` (mirrors `HerdrForkService`) |
| `scripts/pi-reloc-launcher.sh` | Dedicated peer-session RESUME launcher (`exec pi --session <file>`; no worker runtime, no instruction, no `--` marker) |
| `tests/reloc.test.ts` | 22 service-level tests (fake transport; exact 4-call CLI sequence; probe-confirmed silent-failure close modes) |
| `tests/reloc_command.test.ts` | 8 handler-level tests (real `index.ts` registration + injected `relocTransport`) |
| `index.ts` | `registerRelocCommand()` + `relocTransport` in `RegistrationDeps` (mirrors `registerForkCommand`) |

The four-step choreography (plan §1.4) is implemented as: `pane get` (resolve workspace) → `tab create --workspace … --cwd … [--env PI_CODING_AGENT_DIR=…] --focus` → `pane run <rootPane> "<launcher> --session-file <quoted>"` → `pane close <originalPaneId>` (LAST action). A launch failure does NOT close the original pane. A close that does not return a clean ok envelope (truncated/empty, timeout, non-zero exit, typed `pane_not_found`) yields `ok:true, outcome:"relocated", staleOriginalPane:true` — the session is already live in the new tab.

## Verification gate (pre-implementation, plan §9)

Two live probes decided the design before any code was written:

- **Probe A (pane-close timing):** cross-pane `pane close` returns a clean `{"type":"ok"}` envelope in ~32 ms. **Self-pane-close: the PTY is killed silently before the CLI writes its envelope — 0-byte stdout, shell truncated.** This confirms the plan's step-4 silent-failure risk is real, not theoretical.
- **Probe B (resume semantics, initial):** `pi --session <abs-path>` on a stale cross-profile session created a *new* session file instead of resuming — initial hard-stop.
- **Probe B2 (discriminating):** with the new pane under the **same profile/agent-dir** (`PI_CODING_AGENT_DIR` set), `pi --session <abs-path>` resumed **in place** (same file appended, no fork prompt, no read-only banner), for both same-project and cross-project paths. Probe B's failure was a profile/agent-dir mismatch, not a design flaw.

**Conclusion:** the design is viable *provided* the new pane runs under the same profile as the original session — which the single `--env PI_CODING_AGENT_DIR=…` on `tab create` guarantees (the handler reads it from `ctx.env`; it is present in a herdr pane's pi env, e.g. `~/.pi/profiles/minimal/agent`).

## Live acceptance (Phase 4, plan §7)

Driven in a scratch herdr workspace with a real pi loaded from this checkout (`pi -e <repo>/index.ts`, minimal profile). A seeded secret phrase (`ZEBRA-QUARTZ-9`) distinguished the resumed session from a fresh one. `/herdr-reloc-tab` was triggered via `herdr pane send-text <pane> "/herdr-reloc-tab"` + `herdr pane send-keys <pane> enter`.

| AC | Verdict | Evidence |
|---|---|---|
| 1 single command | PASS | 4 steps ran; new tab `w58:t2` with resumed session, original pane `w58:p1` closed |
| 2 continuity | PASS | seed exchange (ZEBRA-QUARTZ-9 / SEEDED) visible in the new pane's history |
| 3 profile parity | PASS | new pi ran under `PI_CODING_AGENT_DIR=…/profiles/minimal/agent`; session stored under that profile |
| 4 no fork | PASS | **same session file** resumed via `--session`; file appended in place (6→10 lines), no new file |
| 5 fresh pane id | PASS | footer showed `w58:p2`, not `w58:p1` |
| 6 original pane closed | PASS | `herdr pane get w58:p1` → typed `pane_not_found` |
| 7 failure isolation | N-A live | deliberately not induced (orphan risk); covered by unit tests (tab-create / pane-run failure leaves original untouched) |
| 8 no worker contamination | PASS | new pane's `[Extensions]` banner: ordinary extensions only; no worker runtime, no `.sub_agent_conf`, no role preamble |
| 9 notification when it fires | N-A / accepted | no notification fired (issuing pi dead before the CLI envelope) — the documented silent-failure mode |
| 10 human verification | PASS | (a) old tab gone, (b) new tab live/typeable with full history, (c) typing continued the conversation — the new tab answered "ZEBRA-QUARTZ-9" |

**Silent-failure mode, observed:** the issuing pane's PTY was destroyed before its CLI envelope could be written (probe A), so **no confirmation notification fired**. The user-visible outcome is: the old tab vanishes, the new tab holds the live, resumed session, with no feedback. This is the accepted, documented risk of step 4 (plan §3.1, §8). The user must verify the new tab is live after a reloc.

**Race-timing note (live observation):** the live run showed the 4-step choreography had already *completed* (tab created → pi resumed → original closed, in that order; pane gone ~5 s later). This is consistent with probe A: the PTY dies, but the substantive steps (tab create, resume) execute *before* the final self-close, so the resume is unaffected by the close's envelope loss. The close only determines notification delivery, not reloc success. Both outcomes (clean close → `staleOriginalPane:false`; degraded close → `true`) are handled correctly by `reloc.ts`.

## Test status

- `npx tsc --noEmit` → clean.
- `npm test` (full suite, `node --test`): **310/314 pass**, 30 new reloc tests all green.
- The 4 failures are the **pre-existing** `fork_command` injected-transport tests, caused by `npm test`'s `tsc` build not copying `scripts/` into `.test-build` (so `defaultForkLauncherPath()` resolves to a missing file). Proven pre-existing: a clean baseline with no reloc code at all also reports exactly these 4 failures (284 tests / 4 fail). The reloc command-handler tests materialize the launcher asset into `.test-build/scripts/` as a fixture to avoid this artifact (a test fixture, not a bent test).

## Known limitations / environment findings (non-blocking)

1. **Silent-failure mode of step 4** is by design (see above). Only AC 10 (human verification) catches it; there is no in-band confirmation when the issuing pi dies.
2. **Stale pre-installed extension copy** in the minimal profile (`~/.pi/profiles/minimal/agent/git/…`) caused duplicate tool registration during live testing, requiring `--no-extensions` on the scratch pi. This is an **environment** issue owned by the installed package's repository (the `~/.local/bin` Firstmate), not a defect in this repo's source. In normal deployment the installed copy should be refreshed.
3. **Pi version:** herdr panes resolve pi to 1.1.0 (the handoff assumed 1.0.0). Session resume semantics verified against 1.1.0.

## Cleanup

All scratch herdr resources (workspace `w58`, panes) were closed and verified absent after evidence capture. No pre-existing pane or other-repository Firstmate was touched.
