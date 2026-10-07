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

Inside each feature directory, canonical lifecycle files use a **stage-ordinal prefix** with a **double-underscore delimiter**, followed by the stage name and the feature short name:

```
<N>_<stage>__<feature-short-name>.md
```

| File Name Pattern | Purpose / Phase | Status |
| :--- | :--- | :--- |
| `1_idea__<feature-short-name>.md` | Initial concept, problem exploration, brainstorming notes, early sketches | Optional |
| `2_requirements__<feature-short-name>.md` | Non-technical and user-facing requirements, syntax, parameters, acceptance criteria | Optional (until scoped) |
| `3_plan__<feature-short-name>.md` | Technical architecture, step-by-step implementation tasks, test coverage plan | Optional (until planning) |
| `<any-other-filename-allowed>` | Deep dives, spike findings, benchmark traces, or evidence dumps | Optional (as needed) |

The ordinal prefix (`1_`, `2_`, `3_`) encodes lifecycle order so `ls` sorts files in progression order. The double-underscore delimiter visually separates the stage token from the feature name without colliding with feature short names.

### Guidelines
1. **Separation of Concerns:** Keep the canonical files (`1_*__*.md`, `2_*__*.md`, `3_*__*.md`) clean, sharp, and focused on their lifecycle stage.
2. **Supplemental Files:** Offload long transcripts, CLI output dumps, or detailed architectural spikes into dedicated auxiliary files in the same directory, and cross-reference them from the canonical files.
3. **Phase-Driven:** Files are added as the feature progresses through discovery → requirements → planning → implementation.
