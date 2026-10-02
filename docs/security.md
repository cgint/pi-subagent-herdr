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
