# 05 Finding history across commits

**Requires:** [Local analysis](04-local-analysis.md). **Outcome:** a maintainer can distinguish an actual fix from a line move, an ambiguous match and an incomplete recheck.

**Build.** Keep observations immutable per completed snapshot. Compare each candidate with prior PR-scoped findings using rule or class, normalized expression, enclosing symbol and rename metadata. Link unambiguous matches to the earlier observation. Group agreeing sources while retaining both citations. Keep user decisions in an append-only history.

**Acceptance checks**

| Change to the pagination fixture | Expected result |
| --- | --- |
| Add the original off-by-one condition | New finding with the exact original citation |
| Insert a header above it or rename the file with a clear mapping | Still present, stable finding ID and updated citation |
| Fix the condition and fully rerun the same rule over the affected scope | Cleared by recheck, previous evidence available |
| Skip the file, change configuration, lose a model-only observation or find multiple plausible matches | Needs verification, prior evidence retained |
| Dismiss, then move the line | Dismissal carries only across an unambiguous match, with actor and reason preserved |

Run the boundary test on the trusted synthetic fixture to confirm the example’s expected behavior. Inspect both historical snapshots after the comparison.

## Teach me after implementation

Compare a moved finding, a verified fix and a skipped file. Explain which evidence lets OpticPR choose each history state. Add the walkthrough to this file and explain it to me in chat using the [project teaching instructions](../../AGENTS.md).
