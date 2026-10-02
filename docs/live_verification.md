# Live verification — first-version evidence

R-1..R-10 functional gates are verified within the declared v1 limits. Terminal observation is not task acceptance; the fixed batch is not a statistical reliability guarantee. Exact gate definitions remain in `acceptance.md`.

## Tested environments

- Initial native registration/footer controls: Pi0.99.1, Herdr0.9.3.
- Resumed native lifecycle/final production/package probes: Pi1.0.0, Herdr0.9.3, Node22.23.3, TypeBox1.3.27.
- Installed unchanged minimal worker runtime: actual home-llm/qwen3.8-27b-nvfp4-dflash2-direct, distinct from controller model. No installed scripts/configuration or `.sub_agent_conf` modified.
- 2026-10-02 final strict SDK1.0.0 observation: npm run check,130 passed/0 failed (`agent/final-check.log`). This is a timestamped observation, not a permanent count.

## Requirement proof

All evidence paths below are under `docs/evidence/`; original role order and independent task oracles are load-bearing, not echoed prompt tokens.

| Gate | Independently checked evidence |
|---|---|
| R-1 | reliability_live.json:5 immediate starts/task deliveries per mode, exact hidden SHA256 role proofs. native_resumed_partial.json: editable artifact recomputed. Readonly evidence is terminal-only. |
| R-2 | native_l3_partial.json and native_visible_send.json: registered immediate/bounded/finish paths. native_final_gates.json → long_bounded: ≥65s original bash task,10s bounded50-code-point working snapshot, surviving worker, newer-seq continuation and exact digest. finish_tail_live.json: repaired finish returns requested2000-code-point-bound console containing actual verified child stdout. |
| R-3 | native_final_gates.json → console/oracle and unicode/oracle: registered reads equal direct CLI suffixes; non-BMP bounds count code points. |
| R-4 | lead_l2_final.json/native lifecycle/long_bounded: actual working observation, newer-seq idle/done, original task result. Unknown receipt stays conservative activity observation; blocked is needs_attention, never task success. |
| R-5 | native_visible_send.json: registered text+Enter executes shell Unicode output/hidden digest, not mere echo. native_final_gates.json: multiline characterized and registered multiline_unverified rejection. |
| R-6 | native_resumed_partial.json: working turn Escape-aborted, completion result absent, managed Pi survives. Additional model-loop recovery in native_final_gates. No ctrl+d. |
| R-7 | native_final_gates.json → list: two renamed workers plus unrenamed panes, direct pane/agent join and ownership comparison. Controller status changes while executing listing are explicitly a snapshot boundary. |
| R-8 | Same record → spaces: actual registered result/direct comparison with two owned workspaces; secondary workspace independently cleaned. No user workspace mutated. |
| R-9 | Native owned/repeated close, fresh typed absence, noninteractive external no_ui_available denial with target surviving. Mechanic/original-worker closure and final frozen sole-manager/workspace absence in native_final_gates. |
| R-10 | footer_controlled.json: same-terminal inside negative/positive bottom-line bytes; footer_outside_pty.json: genuine outside-Herdr interactive no-status control/normal exit. native_editable_blocker.json: independent owned cleanup. Terminal captures, not desktop screenshots. |

## Cross-cutting gates

- reliability_live.json:20 exact chronological user/tool-result/assistant oracle proofs (5 starts/mode+10fast prompts); zero lost tasks/false terminal claims in that batch. Final cleanup parser threw; retained exception plus independent workspace/all10worker absence resolves cleanup, not invocation passage.
- packaging_live.json: real hostSDK loads packed archive outside repository dependency ancestry, no bundled/local node_modules, all nine registered tools/no loader errors. Host SDK/pi-ai/typebox wildcard peers, exact local dev pins, actual lock/tree/current audit inspected. No user-config install.
- session_isolation_live.json: genuine SDK fork/new/switch-original, no injected services; fork/new do not inherit ownership, original resume restores it. Native same-session reload separately verified.
- cancel_live.json: actual herdr agent wait PID captured, cancelled/reaped, worker still working with same identity, original task later verified, full cleanup.
- env_reach_live.json: original child bash stdout directly proves HERDR_ENV=1, HERDR_PANE_ID matches captured child, PI_WORKER_DEFAULT_MODEL matches selector and actual assistant model. Reporter metadata supports, not substitutes, this proof.
- Final source regressions: finish/fastbounded terminal console tails; explicit genuine read failures; unexpected_wait_state on nonterminal successful wait/prompt payload, never fabricated terminal. Real assertion-red/green; previous tautological wait assertion strengthened.
- security.md owns current explicit SDK1.0.0 residual host-glob DoS risk decision. Audit is not clean.

## Disclosures and rejected evidence

- Tails are raw console suffixes, not assistant-answer extraction; small tails may contain footer/padding. Verify larger read/result/artifact.
- Separate Qwen fixture made348 pwd calls for one request. Honest timeout, original-role inspection, registered Escape recovery/closure recorded in native_final_gates. Outside passing20turn batch; a disclosed model reliability limit, not task acceptance.
- Multiline send deliberately rejected; characterization does not establish a portable safe multiline contract.
- Genuine pi-herdr unavailable in checked profile/settings/local trees: conditional co-loading not executed, no fake sibling or collision-free claim.
- HTTP500 editable trial, stale startup continuation, input-echo acceptance, outside-scratch harness and lost post-reload controller request remain failed/historical records. Later original role proofs supersede, not erase, them.
- Packaging worker's initial red was ENOENT, not manifest failure; unsupported Node-quirk claim retracted. Correct compiled-root URL and later controlled old-manifest mutation produce three genuine assertion failures. This is not original preimplementation TDD; packaging_live preserves correction.
- Initial direct-env multi-name BSD printenv probe was invalid (only prints first name); portable printf corrected it. No missing-env claim derives from that failed probe.

All owned workers/raw fixtures/managers/scratch workspaces independently absent after inspection. Recorded IDs/absolute paths are historical provenance, never reusable handles. Raw forensic logs remain ignored under agent/; curated evidence is deliverable.
