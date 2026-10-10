# Research: cross-check of feature docs (agent-end-pane-reminders)

Worker: research-crosscheck (readonly) · Source: 1_idea, 2_requirements, 4_revalidation, README.md

## Consensus-holds (points all docs agree)
- **(a)** The feature IS `pi-self-reflect`'s mechanism applied to panes, nothing else. ✅
- **(b)** The driving LLM reflects; no second model, no hidden agent, no extension-side verdict. ✅
- **(c)** The steer carries raw status, not a verdict. ✅
- **(d)** Out-of-scope = workspace-redesign, decision-authority, completion/skipped-wait gate. ✅

## Contradictions-found (all concentrated in 1_idea; it lags the 2026-05-02 scope settlement)
1. **1_idea fork #3 + Decisions + Re-entry step 3** still describe the *in-memory* trigger
   ("in-memory `getOwned()` for the trigger; live read optional enrichment"). 2_requirements R5/OQ1
   settled on the *live-list* trigger (`owned===true` items, status from `agent_status`). **Highest
   mislead risk** — an implementator reading 1_idea would build the in-memory trigger.
2. **1_idea "Status source" decision** frames live-read as *optional enrichment, not required.*
   2_requirements R2 makes live status *required*. Contradiction.
3. **1_idea loop guard** says "a `pi-self-reflect`-style `consecutiveAutoContinues` counter is
   overkill." 2_requirements R7/R8 + the self-reflect research say the counter *is* the guard to
   copy. Contradiction.
4. **1_idea Re-entry "design decision (needs user input)"** lists three forks (hook, trigger,
   status) as *open* — all three are settled in 2_requirements. Stale.

## Stale-language
1. **1_idea line ~85:** "The LLM then decides per pane (wait / read / close)." — this is the
   agent-decides phrasing, but it's framed as the *LLM acting*, not "the driving LLM is brought up
   with raw status and reflects." Align with 2_requirements R3/Scope.
2. **1_idea Design C** (footer/status line, "user decides") is *untagged* as non-conforming to the
   settled scope. It's a fallback that does NOT satisfy "the driving LLM reflects" — should be
   tagged as out-of-scope / non-conforming.

## Line-number-violations
- **None.** All docs comply with README guideline 5 (no line numbers; symbol/search anchors). ✅

## OQ-accuracy
- **OQ1** (live-list signal) is RESOLVED in 2_requirements but still sits under "Open questions"
  with a RESOLVED tag — acceptable, but should be visually de-emphasized / moved so a reader
  doesn't think it's open. The *residual* (live Herdr actually populating `agent_status`) is the
  part that stays open — keep that visible.
- **OQ2** (picture shown to user) — accurately open.
- **OQ3** (premature-return gate) — accurately out-of-scope/adjacent.
- **OQ4** (who fetches status) — consistently open, **but only labelled in 2_requirements.**
  1_idea does not reference OQ4 at all. Add a cross-ref in 1_idea.

## Recommended-fixes-prioritized
1. Rewrite 1_idea fork #3 + Decisions + Re-entry step 3 to the live-list trigger (R5/OQ1) —
   highest mislead risk.
2. Align 1_idea loop guard with the `consecutiveAutoContinues` counter + R8 mitigations.
3. Fix 1_idea agent-decides phrasing (line ~85); tag Design C as non-conforming.
4. Prune the superseded "needs user input" fork list in 1_idea's re-entry guide.
5. Move resolved OQ1 out of the "Open questions" framing (keep the spike residual visible).
6. Fix 1_idea's re-validation date anomaly (2026-05-02 vs 2026-10-08 directory date).
7. Add explicit OQ4 cross-reference in 1_idea.
