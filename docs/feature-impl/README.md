# Feature Implementation Documentation Structure

All new features and substantial enhancements are documented under `docs/feature-impl/`.

## Directory Naming Convention
Each feature resides in its own dedicated directory using the creation date:
```text
docs/feature-impl/<YYYYMMDD>-<feature-short-name>/
```
Example: `docs/feature-impl/20261007-herdr-fork/`

---

## File Naming Conventions

Inside each feature directory, canonical lifecycle files follow strict naming patterns reflecting the feature's progression:

| File Name Pattern | Purpose / Phase | Status |
| :--- | :--- | :--- |
| `<feature-short-name>-idea.md` | Initial concept, problem exploration, brainstorming notes, early sketches | Optional |
| `<feature-short-name>-requirements.md` | Non-technical and user-facing requirements, syntax, parameters, acceptance criteria | Optional (until scoped) |
| `<feature-short-name>-plan.md` | Technical architecture, step-by-step implementation tasks, test coverage plan | Optional (until planning) |
| `<any-other-filename-allowed>` | Deep dives, spike findings, benchmark traces, or evidence dumps | Optional (as needed) |

### Guidelines
1. **Separation of Concerns:** Keep the convention files (`*-idea.md`, `*-requirements.md`, `*-plan.md`) clean, sharp, and focused on their lifecycle stage.
2. **Supplemental Files:** Offload long transcripts, CLI output dumps, or detailed architectural spikes into dedicated auxiliary files in the same directory, and cross-reference them from the canonical files.
3. **Phase-Driven:** Files are added as the feature progresses through discovery $\rightarrow$ requirements $\rightarrow$ planning $\rightarrow$ implementation.
