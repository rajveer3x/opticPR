# 03 Current review publication

**Requires:** [GitHub intake](02-github-intake.md). **Outcome:** GitHub shows one current summary and the dashboard pointer selects the corresponding eligible report.

**Build.** Resolve the live head and base before promotion. In one Prisma transaction finalize the run, compare the PR’s desired run key, advance latestRunId if eligible and record publication intent. Serialize remote writes per PR. Compare both SHAs and desired key again immediately before posting. Put an app-owned marker and the reviewed SHA in the conversation comment. Store its remote ID. After writing, recheck the pair and reconcile a push that landed during the request.

**Acceptance checks**

- Interrupt finalization between writes. Verify rollback, retry and read the report through latestRunId.
- Pause run A before promotion, complete run B, then resume A. Assert the final pointer and GitHub summary identify B. Repeat with A paused before publication.
- Simulate a remote create that succeeds but loses its response. On retry, recover the app-authored comment by marker. Count exactly one visible summary.
- Honor rate-limit hints and back off with jitter. After three failed attempts, preserve the intended revision, diagnostics and a retry path.

## Teach me after implementation

Walk through two pushes that finish in reverse order. Show which transaction and publication checks keep the newer review visible. Add the walkthrough to this file and explain it to me in chat using the [project teaching instructions](../../AGENTS.md).
