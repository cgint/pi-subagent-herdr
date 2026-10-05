# Package-owned Herdr shell runtime

The extension defaults to its installed `skills/subagent-herdr-supervision/scripts/` directory, not an old profile skill or `~/.local/bin` runtime directory. Explicit CLI/environment runtime overrides still win; invalid paths do not silently fall back.

## Ownership and behavior

- All five packaged collaboration skills stay in scope.
- Herdr shell entrypoints/helpers and `pi-worker-runtime.sh` stay bundled. The runtime originated in the user's shared runtime definitions, but the extension executes its own copy.
- **Profile management is outside this extension.** Bundled `pi-profile.sh` is removed. Global `pi-profile` and shared runtime originals are never modified/deleted by this change.
- When system `pi-profile` is on PATH, workers invoke it with **minimal** by default. `PI_WORKER_PROFILE` overrides that selection, including `default`. Invalid/option-like profile names fail before invoking the command.
- Without system `pi-profile`, workers launch Pi directly. An explicit non-default profile fails clearly rather than being silently discarded. Selected reporter/profile failures do not fall back to another profile.
- Worker controllers load this installed package's `src/index.ts`, not a GitHub cache. No runtime chmod or legacy runtime-directory scan is used.

## External prerequisites

Pi, Herdr, Bash and ordinary shell utilities remain required. Profile management (optional system `pi-profile`), configured profiles, authentication and Herdr-managed `herdr-agent-state.ts` remain external integrations/state. The runtime also loads Pi focus-guard, tool-intent, advisor, mini-self-org and provider-specific extensions; their implementation is outside this package.

Readonly/editable flags, cwd write boundary and model-selection validation are retained. The runtime guard is not a security sandbox. Older shell orchestration/helpers and their imported shell test harness remain reference material; normal use stays with native tools. Historical positional-brief/parser limitations are not repaired here.

## Verification

`tests/runtime_packaging.test.ts` extracts an actual tarball outside repository ancestry, with spaces and unrelated cwd. It asserts that `pi-profile.sh` does not ship, the worker is executable, and the Herdr runtime/self-extension are package-local. Isolated HOME/PATH cases exercise direct Pi without the system wrapper (even with profile directories present), explicit named-profile failure without it, and a fixture system wrapper invoked for both model probe and worker launch. Coverage retains minimal default, explicit overrides, readonly/editable flags, option-injection rejection, invalid model and missing-minimal reporter failure.

`docs/evidence/self_contained_runtime.json` preserves **historical** native readonly/editable/nested probe originals from the earlier bundled-profile implementation. Their owned panes/fixtures were independently cleaned. They do not establish fresh native acceptance of the subsequent external-profile correction. Functional probes are not model-reliability or security-sandbox guarantees.

## Separate legacy retirement

Removing the package-local profile-manager copy does not authorize touching any global original. Legacy Herdr-only retirement belongs to its owning repository and requires refreshed installations/overrides and shared-consumer checks. Shared utilities, cmux, other supervisors, profiles and Herdr's reporter remain outside that cleanup scope.
