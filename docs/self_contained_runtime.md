# Package-owned shell runtime

The extension defaults to its installed `skills/subagent-herdr-supervision/scripts/` directory, not an old profile skill or `~/.local/bin` script directory. Explicit CLI/environment runtime overrides still win; invalid paths do not silently fall back.

## Files and behavior

- Existing Herdr shell entrypoints/helpers remain in this package.
- `pi-worker-runtime.sh` was copied from `data-dir-agents/definitions/runtime/pi-worker-runtime.sh` in the user's `~/.local/bin` repository.
- `pi-profile.sh` was copied from that repository's `pi-profile` command. Runtime invokes this bundled copy, never a PATH-resolved profile script.
- Adaptations are limited to package-relative profile/self-extension paths, profile default selection and rejecting option-like profile names.
- If profiles are available, default is **minimal**; `PI_WORKER_PROFILE` overrides it. A missing selected profile/reporter fails rather than choosing another. Without profiles, direct Pi uses the default agent layout.
- Worker controllers load this installed package's `src/index.ts`, not a possibly stale GitHub checkout.
- `package.json` already ships `skills`, including the complete runtime dependency chain. No runtime chmod or automatic legacy-script fallback is used.

## External prerequisites

Pi, Herdr, Bash and ordinary shell utilities remain required. Configured profiles, authentication and Herdr-managed `herdr-agent-state.ts` remain external state/integration. The copied runtime also loads Pi focus-guard, tool-intent, advisor, mini-self-org and provider-specific extensions; these are explicit Pi integrations, not supervisor shell dependencies bundled here.

Readonly/editable flags, cwd write boundary and model-selection validation are retained. The runtime guard is not a security sandbox. Older shell orchestration/helpers and their imported shell test harness remain reference material; copying dependencies does not repair their historical positional-brief/parser behavior. Normal use stays with native tools.

## Verification

`tests/runtime_packaging.test.ts` extracts a real tarball outside repository ancestry, with spaces in paths and unrelated cwd. An isolated HOME/PATH has no legacy scripts; a hostile external `pi-profile` proves it is not invoked. Checks include shipped files/permissions, both modes, minimal default, explicit profiles, invalid model/profile and missing-minimal failure.

Fresh genuine Pi native calls loaded an extracted package outside the repository and launched readonly/editable workers using the bundled default. Both original child Bash results printed the requested marker under the minimal profile; both panes were closed and independently returned typed `pane_not_found`. Evidence: `docs/evidence/self_contained_runtime.json`. A fresh packaged editable controller also launched and closed a readonly descendant; its original native calls and descendant Bash result were independently inspected, and both panes were independently absent. All four owned native panes and both extracted fixtures were cleaned. This is functional evidence, not a model-reliability or guard-security guarantee.

## Retirement boundary

No installed profiles or legacy files were edited/deleted. Current sessions/installations can still hold the old extension/runtime; deployment and restart must precede retirement. Remove stale runtime overrides and confirm shared consumers before deleting legacy artifacts through their owning repository's Firstmate. Shared profile/runtime scripts used by other supervisors are not automatically obsolete.
