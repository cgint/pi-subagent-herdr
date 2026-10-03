# 0.2.0 ergonomic acceptance — 2026-10-03

**Verdict: accepted for scoped GitHub publication and later human testing.**
This is Firstmate automated acceptance of the agreed adaptation, not a claim
that every first-version live gate was rerun. The user explicitly places human
testing after publication. No installed runtime, configuration, model,
packaging or orchestration change is included.

## Requirement-to-artifact audit

| Requirement | Inspected artifacts and evidence |
|---|---|
| Nine stable verbs, sole `pane` address, flat schemas, no public continuation/cursor | `src/index.ts`, `src/core.ts`; registration schema inventories and output-schema regression in `tests/registration.test.ts`. Start takes name/task and returns the pane address. |
| Reliable readonly/editable launch, readiness then delivery, no positional task | Core start lifecycle and managed readiness; fake-transport ordering/detection/cancellation tests. Earlier native controller battery covers readonly launch; baseline editable/nested evidence is historical. |
| Explicit destination safety | Different-workspace launch rejected before mutation; unexpected split workspace closes only the created pane and independently verifies absence. Defect 1/1b regressions; native battery's different-destination rejection. No cross-workspace launch workaround. |
| Existing agents, no ownership/workspace/UI gates | Agent-neutral prompt and explicit-pane send/interrupt/close source; fake Claude and cross-workspace tests. Ownership remains provenance. Native non-Pi parity is unverified. Self prompt/wait is circular; self raw control can interfere with the executing process and is rejected. |
| Busy steering and blocked submission | Busy calls allowed, `submittedWhile=working`, `may_reflect_prior_turn`, no automatic pending association; blocked reports `not_sent`. Core tests distinguish submit-only/awaited busy, actual blocked refusal and uncertainty. Native busy behavior remains unverified. |
| Delivery/failure/timeout semantics | Acknowledgement only from `agent_prompted`; uncertain delivery remains unknown; no automatic resend. Timeout/stall/abort/malformed responses supersede old pending association; pre-submit not-sent preserves it. `tests/core-defects.test.ts` and core tests. Worker lifetime is not the wait deadline. |
| Two-tier freshness and settlement | Newer terminal receipt/live same sequence settles once; otherwise terminal must be newer than receipt baseline. A newer working state cannot settle. Settled contexts become snapshots; changed identities discard association. Missing metadata has separately labelled lookup/context-error coverage. Core and defect suites; these final corrections are automated-only. |
| Bounded, honest console results | Source selection, defaults 100 lines/8000 code points, numeric caps, Unicode, disabled capture, auto/strict/raw fallback tests. Standalone read returns separately sampled status/sequence; failed lookup never becomes no-agent. Prompt terminal/timeout honors selected source; read failure never erases acknowledged action. Zero character cap does not falsely report clipping. |
| Inspection, raw send, Escape, verified close, footer | Core mapping tests, real process-transport cancellation tests, all-nine registration/session/footer tests. Native battery covers list/spaces/read and close/idempotent typed absence. Historical v1 send/Escape/footer proof is not a new 0.2.0 live pass. |
| Migration and version metadata | README and `tool_usage_review.md` map legacy fields to pane/prompt/wait/output controls. Core rejects obsolete fields before actions; acknowledgement flags are ignored for this transition. Package and lockfile root versions are both 0.2.0; dependency pins unchanged. |
| Scope and publication | Stage explicit adaptation source/tests/version/canonical-doc paths only. Exclude `docs/multiplexer_compatibility.md`, other research and local scanner configuration. Verify origin/master, normally integrate remote history without importing old runtime state, then normal push and compare remote SHA. Publication evidence is the Git history and final remote comparison, not this pre-publication verdict. |

## Review and correction evidence

Firstmate read final schemas, dispatch, core paths, regression assertions and
canonical documents against `tool_usage_review.md`. Buddy review previously
identified destination orphan, failed-submission context, duplicate settlement
and receipt-baseline defects. Lead verified their corrections and added receipt
metadata/malformed-submission regressions.

Independent advisor review confirmed stale ownership precedence was a real
remaining defect. Adopted the finding, but bind pending identity to sampled
live metadata without a saved-ownership fallback. Also corrected ignored
prompt console source, newer-working false settlement, missing read status,
nonterminal event spinning, and false zero-cap clipping. Five new tests failed
by assertion before correction (0/5); zero-cap clipping separately failed
(0/1). An existing working-state test wrongly allowed terminal settlement;
it now requires actual terminal progression and event-wait evidence rather
than endorsing the bug. The original 10-second test timeout is retained.

Final evidence: `evidence/ergonomic_automated_review.json` records the actual
`npm run check` exit 0, **163 passed / 0 failed**, timestamp and exact hashes
of source/tests/version metadata. This is an observation, not a permanent
count. Typecheck and the complete built suite ran, not just the new regressions.
Advisor's suggestion to treat historical nested evidence as current completion
proof was not adopted; neither passing tests nor that older probe proves the
GitHub publication deliverable or current comprehensive live behavior.

## Native evidence and limits

`evidence/ergonomic_native_live.json` projects exact registered-tool calls and
results from the earlier controller session, excluding reasoning/provider
metadata. It records readonly startup/delivery with READY console, awaited
essay prompt, later snapshot, STOP-7/DONE-7 observation, read, list/spaces,
pre-create destination rejection and close/repeated close with typed absence.
These are console observations, not hidden-oracle deliverable acceptance.

The controller repeatedly attempted `wait=false` with an explicit timeout;
validation rejected those calls. It then waited through the full task. This
**did not verify busy steering or timeout recovery**. Final lead corrections,
metadata edge cases, strict/raw prompt source, working-state settlement and
read status are unit-tested only. Non-Pi native parity, every output viewport,
all profiles/models, and sibling co-loading remain unverified. The original
first-version live gates and model-loop/security limitations remain indexed in
`live_verification.md`; they are not relabelled as adapted-code proof.

Known host `brace-expansion` denial-of-service risk remains explicitly accepted
within the scope in `security.md`; no clean vulnerability audit is claimed.
Local unsuppressed secret scanning is a publication check, not a guarantee that
all secrets or vulnerabilities are absent.

## Human update/testing

Use the README GitHub install/update commands, then restart Pi and existing
controllers/workers so the pane-only schemas replace the already-loaded 0.1.x
tools. Test busy follow-up attribution, bounded timeout then re-wait without
resend, source selection and verified cleanup in disposable panes. Human
results can extend this record; they are not claimed or required before push.
