---
name: repo-maintenance
description: Self-sufficient routine for dependency upgrades, audit hygiene and verified push in this repository. For agents working on this repo; never deployed to extension users.
---

# Repository maintenance routine (self-sufficient)

This skill is the single source of truth for maintaining this repository.
It must remain fully self-sufficient: never depend on resources outside
this repository (no central skill, no external memory).

## Goal & hard rules
- All npm dependencies at latest published versions, MAJOR bumps included.
- npm audit green (exit 0), fixed at ROOT CAUSE (upgrade the vulnerable
  package itself). Never via: lowered audit level, --force, npm audit
  ignore/suppressions, overrides that mask advisories, or downgrade-to-dodge.
- NO restrictions may be loosened to get green. If a temporary measure is
  truly unavoidable, flag it explicitly in the evidence file and name the
  real fix.
- Never bend a test to pass. Failures are either pre-existing (prove it via
  a stash/HEAD baseline) or regressions (fix root cause or stop and report).

## Procedure
1. git fetch origin; ensure local branch is even with origin before starting.
2. Record BEFORE-state: package versions (npm ls --depth=0), npm audit
   output, full test verdict on the clean tree.
3. Bump deps to latest (majors included). Regenerate lockfile fresh
   (remove package-lock.json, npm install).
4. Typecheck/build + full test suite. Compare against BEFORE-state; any
   new failure is a regression. Investigate root cause before touching code.
5. npm audit must exit 0.
6. Commit (conventional message) and push ONLY when: tests no worse than
   baseline, audit exit 0, tree clean.

## Evidence contract
Commit agent/dep-refresh-YYYYMMDD.md containing: before/after table per
changed package, audit before/after, test verdict incl. pre-existing
failures with proof they pre-date the change, residual risks/overrides
kept and why.

## Acceptance protocol (verifier duties - NEVER trust a worker self-report)
- git fetch, then HEAD == origin on the working branch
- zero dirty tracked files
- re-run npm audit (expect exit 0)
- inspect the diff for loosened restrictions (audit config, skipped
  tests, downgraded pins)
- spot-check the evidence file exists and matches reality

## Repo-specific facts
<!-- maintainer: derive from the repository itself (package.json scripts,
     AGENTS.md, docs/, known issues, existing overrides and why). Keep
     current; prune stale facts. -->
- Commands (package.json `scripts`): `npm run check` = typecheck + tests.
  `typecheck` = `tsc --noEmit`; `test` = build to `.test-build/` (gitignored)
  then `node --test --test-timeout=10000 .test-build/tests/*.test.js` — node's
  native test runner, no test framework.
- Node: dev host runs node v22.x with @types/node pinned ^26 (types may
  out-run the local runtime; the extension itself imports SDK types and host
  API only, so typecheck is the compile gate).
- Dependencies: only devDependencies exist (host SDKs
  @earendil-works/pi-coding-agent + pi-ai, typebox, typescript, @types/node);
  these same three are wildcard peerDependencies because the Pi host provides
  them at runtime. No production deps, no `overrides`, no audit ignores —
  none have ever been needed.
- Pre-existing test baseline on master (2026-11-05): 313 tests → 307 pass,
  5 fail, 1 cancelled (fork_command suite: 4 fails; core zsh: 1 fail). Verified
  by re-running `npm run check` on the clean tree — matches the pre-existing
  note in AGENTS.md and `agent/dep-refresh-20261105.md`. These failures are NOT
  regressions; a maintenance run must be no worse than this baseline.
- Vulnerable transitive packages live inside the host SDK's shrinkwrap
  (historically brace-expansion/minimatch/undici under pi-coding-agent). The
  proven root-cause fix is a host-SDK bump (1.0.0→1.5.0 took audit 4→0),
  never an override or ignore — see docs/security.md.
- Evidence precedent: `agent/dep-refresh-20261105.md` shows the expected
  before/after table format. AGENTS.md declares master as the working branch.
- Hard wall for maintainers: never add maintainer-facing skills to the
  `pi.skills` manifest or root `skills/` — that channel is packaged for
  extension users. This `.pi/skills/` directory is gitignored and agent-local.
