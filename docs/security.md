# Dependency assessment

## Decision (Firstmate, reassessed 2026-10-02)

**Accept the disclosed host-SDK dependency risk for this first version; do not suppress the audit or claim a clean dependency tree.** This is a technical risk decision, not acceptance of the extension's functionality.

A fresh `npm audit --json` reports one high-severity vulnerable package: `brace-expansion@5.0.9`, under `@earendil-works/pi-coding-agent@1.0.0 → minimatch@10.2.6`. The SDK publishes an `npm-shrinkwrap.json` pinning that version. Earlier0.99.1 targeted `npm update brace-expansion` and standard non-force `npm audit fix` left the pin unchanged; current1.0.0 lock/audit still show the same published shrinkwrap pin. These mitigation commands were not claimed rerun on1.0.0. No dependency overrides, forced upgrades, or installed-host modifications were made.

Affected advisories:
- [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr): quadratic CPU denial of service; patched in 5.0.12.
- [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7): recursive brace-group stack exhaustion; patched in 5.0.11.
- [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p): recursive comma-parser stack exhaustion; patched in 5.0.10.

The SDK uses minimatch for package/resource selection and model glob resolution. Malicious patterns can therefore exhaust the host Pi process: **this is a real residual host risk**, not harmless merely because the SDK is also used for local development. The extension does not call minimatch or brace-expansion, expose a glob interface, or import the SDK as executable runtime code; it imports SDK types and calls the host-provided extension API. SDK/pi-ai/TypeBox are host-provided wildcard peers; exact local development pins compile against1.0.0/1.0.0/1.3.27. No host module is bundled as an executable dependency.

Rationale: these advisories describe availability failures in host-controlled pattern handling, not a demonstrated extension-specific privilege or data-access path. The extension reuses the existing Pi host; hiding its pin behind a local override would not fix the actual installed host and would give false assurance. Host upgrades are outside this repository-only scope.

## Follow-up and verification

- Use trusted Pi model/resource glob configuration; this is **not** a guarantee against untrusted configuration or package patterns.
- On a Pi upgrade, verify the published shrinkwrap and the actual installed host tree use `brace-expansion >=5.0.12`, then rerun typechecking, tests, and live acceptance.
- Keep `npm audit --json` visible. Reassess if the host path changes, a new advisory changes impact, or the extension gains glob handling.
- Current audit/tree are curated in `docs/evidence/packaging_live.json`; raw mitigation logs remain ephemeral under `agent/`. This document owns the durable decision.

## Security scan review (2026-10-03)

The initial `security_scan.sh` secret scan did **not run**: its installed plugin
requires `/repo/.gitleaks.toml`, which was absent. “Found ? secrets” was a scanner
failure, not a finding. The local `.gitleaks.toml` now extends all built-in
Gitleaks rules without additional allowlists or suppressions. The rerun scanned
14 local commits and reported no leaks. This historical scan does not cover
uncommitted content or later fetched history; scan those before publication.

Trivy reported CVE-2026-102276 and CVE-2026-102278 against
`agent/install-check/package-lock.json`, the scratch installation's
brace-expansion 5.0.9. These match the already disclosed host-SDK stack-exhaustion
risk above, not new extension runtime dependencies. Its default scan excludes
development dependencies; this is not a complete dependency audit. Scanner exit
2 is retained honestly; no clean vulnerability claim. The existing scoped risk
acceptance stands; installed host upgrades remain outside this goal. Raw reports
stay local under `.scan-results/`, not in the publication commit.

Local scanner configuration and raw scanner outputs are not part of the scoped
source/documentation publication. No vulnerable dependency pin is changed.

Before the adaptation commit, Gitleaks scanned the staged adaptation (~379 KB)
and all fetched history (17 commits, ~4.38 MB), both exit 0/no leaks found.
Suppression comments were ignored; reports remain redacted/local. This is a
bounded scanner observation, not a guarantee that all secrets are absent.

## Readonly-worker Git metadata limit (2026-10-03)

An acceptance reviewer launched in readonly mode executed `git config --add
safe.directory` in this repository despite an explicit no-config-write brief.
The lead observed the new local setting, removed only that entry, and verified
all other local Git settings and unrelated-file hashes were preserved. Do not
treat worker mode or self-reported compliance as a filesystem security sandbox.
An integration worker also unnecessarily aborted/recreated the isolated merge;
lead byte comparisons and exact-tree checks verified the resulting preserved
artifacts. Future handoffs must forbid abort/recreation and config writes, and
leads must inspect actual command effects. No installed guard/runtime changes
are included here. Git SHA-1 blob identifiers and file SHA-256 digests are not
comparable; a reviewer mismatch claim based on them was rejected.
