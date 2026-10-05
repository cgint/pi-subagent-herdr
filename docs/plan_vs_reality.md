# Plan versus pulled reality

Comparison baseline: source commit `0220e75`. This is an independent checkout assessment, not a new live acceptance or a code repair.

## Summary

The repository now contains a substantial implementation of the planned native supervision tools, tests, packaging metadata, usage documentation and curated native evidence. It is no longer research-only. However, the portable clean-checkout verification gate fails on this host. Historical test/native records must not be presented as fresh local verification.

## Comparison

| Planned stage/outcome | Current reality | Assessment |
|---|---|---|
| Refresh contract and R-1..R-10 evidence matrix | `docs/acceptance.md` maps requirements; ergonomic and multi-pane documents distinguish later evidence and limits | Delivered, but original per-requirement live gates were not all rerun for final ergonomic code |
| Small coherent design | Actual contracts in README, `docs/tool_usage_review.md`, `docs/multi_pane_wait.md`; `docs/plan_2_design.md` contains only authority/scope corrections | Design exists across documents; overview's description of plan_2 as full tool/outcome/gate design is inaccurate |
| Complete launch/detect/deliver/wait/cleanup slice | Source starts task-free installed wrapper, requires managed readiness, renames, prompts after detection; native records cover lifecycle and nested worker probes | Implemented with recorded bounded live evidence; not independently rerun here |
| Nine tools and footer | Nine `subagent_*` registrations in `src/index.ts`; footer status hooks; Escape key in core | Source presence independently checked; tests did not run to completion locally |
| Self-contained TypeScript worker runtime (earlier proposal) | Installed `herdr-worker.sh` remains a required external dependency, with runtime-dir resolution and pre-launch validation | Deliberate change, not an accidental omission: later user scope explicitly required reuse unchanged runtime |
| Bounded waits, honest delivery/timeout state | Internal freshness tiers, identity checks, no public continuation, console/status isolation; later first/all multi-pane wait | Plan expanded. Busy attribution, blocked multi-mode and identity drift retain unit-only limits; no task-success guarantee |
| Installation and clean-checkout checks | GitHub installation documented, package private, host peers declared; fresh local check fails | Portability gate not satisfied on this checkout |
| Hardening and independent evidence | Failure regressions, local monitor cancellation/reaping, cleanup originals, explicit security limits | Significant work delivered; neither full live parity nor statistical reliability established |

## Fresh verification and concrete blocker

- `npm run check` initially could not find `tsc` because this fresh checkout had no dependencies.
- `npm ci --ignore-scripts` succeeded: local dependencies were installed without lifecycle scripts. It reported one high-severity vulnerability; no dependency fixes/overrides were attempted.
- Subsequent `npm run check` failed during typechecking with `TS2688: Cannot find type definition file for 'node'`.
- `npm ls typescript @types/node --depth=0` confirms TypeScript 5.9.3 and @types/node 22.20.4 are installed locally.
- Root cause observed in committed `tsconfig.json`: `typeRoots` is hardcoded to `/Users/cgint/.pi/profiles/minimal/agent/node_modules/@types`, rather than portable project-local resolution. The current checkout is under `/Users/christian.gintenreiter/...`.
- Current host Node is 26.10.0; documented validated host was Node 22.23.3. Fixing the path alone would not establish live equivalence with that host.

This is a confirmed cross-machine build/typecheck defect, not evidence that the extension's runtime tools all fail. Tests were not reached; the historical 224-test pass was not reproduced. No implementation/configuration repair was performed during this comparison.

## Remaining limits and priorities

1. Fix portable TypeScript type resolution, then rerun complete `npm run check` on a documented host. Do not call the checkout independently green until it actually passes.
2. Correct design-document pointers or consolidate the current contract so `plan_2_design.md` is not advertised as content it does not contain. Preserve historical approvals and superseding scope decisions.
3. For final-code live confidence, prioritize busy-follow-up attribution and bounded timeout/re-wait without resend; retain existing unit-only/native distinctions. Do not replay every old gate blindly or target historical fixture panes.
4. Preserve declared limits: multiline send rejected, sibling co-loading unexecuted, readonly is not a security sandbox, SDK dependency audit not clean, selected model can loop/fail upstream. See `docs/security.md`, `docs/ergonomic_acceptance.md`, and `docs/multi_pane_wait.md`.

No commit, push, installed-runtime change, deployment or new live worker orchestration was performed as part of this comparison. Package files remain unchanged; dependency installation is local/ignored.
