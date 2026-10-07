# Feature Implementation Documentation Structure

All new features and substantial enhancements are documented under `docs/feature-impl/`.

## Directory Naming Convention
Each feature resides in its own dedicated directory using the creation date:
```text
docs/feature-impl/<YYYYMMDD>-<feature-short-name>/
```
Examples:
- `docs/feature-impl/20261007-herdr-fork/`
- `docs/feature-impl/20261020-herdr-stage-support/`

---

## File Naming Conventions

Inside each feature directory, canonical lifecycle files follow a numbered phase prefix with double underscores (`<number>_<phase>__<feature-short-name>.md`):

| File Name Pattern | Purpose / Phase | Status |
| :--- | :--- | :--- |
| `1_idea__<feature-short-name>.md` | Initial concept, problem exploration, brainstorming notes, early sketches | Optional |
| `2_requirements__<feature-short-name>.md` | Non-technical and user-facing requirements, syntax, parameters, acceptance criteria | Optional (until scoped) |
| `3_plan__<feature-short-name>.md` | Technical architecture, step-by-step implementation tasks, test coverage plan | Optional (until planning) |
| `<any-other-filename-allowed>` | Deep dives, spike findings, benchmark traces, or evidence dumps | Optional (as needed) |

### Guidelines
1. **Ordering & Clarity:** The numbered prefix (`1_`, `2_`, `3_`) preserves intuitive chronological and structural order in directory listings.
2. **Separation of Concerns:** Keep the convention files (`1_idea__*.md`, `2_requirements__*.md`, `3_plan__*.md`) clean, sharp, and focused on their specific lifecycle stage.
3. **Supplemental Files:** Offload long transcripts, CLI output dumps, or detailed architectural spikes into dedicated auxiliary files in the same directory, and cross-reference them from the canonical files.
4. **Phase-Driven:** Files are created as the feature progresses through discovery $\rightarrow$ requirements $\rightarrow$ planning $\rightarrow$ implementation.
