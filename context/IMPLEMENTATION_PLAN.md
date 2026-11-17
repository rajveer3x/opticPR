# Implementation plan

**Current state:** features 01–06 are implemented. Local acceptance checks use real PostgreSQL/Redis, pinned Semgrep and mocked GitHub; feature 04 benchmark results are recorded in `context/benchmarks/`. A clean CI workflow is included; hosted CI has not been run in this session. Features 07–08 remain pending. The eight-week schedule is an estimate. Each feature spec defines the evidence for completing that slice.

| Order | Milestone | Dependency | Exit evidence |
| --- | --- | --- | --- |
| 1 | [Fixture to stored report](feature-specs/01-fixture-to-report.md) | None | Clean checkout persists a known revision pair. |
| 2 | [GitHub intake](feature-specs/02-github-intake.md) | 1 | Redelivery and base retargeting schedule the correct work. |
| 3 | [Current review publication](feature-specs/03-current-review.md) | 2 | A late worker leaves GitHub and the dashboard pointer on the newer commit. |
| 4 | [Local analysis and context](feature-specs/04-local-analysis.md) | 1, 3 | A model failure preserves an independently verifiable static finding. |
| 5 | [Finding history](feature-specs/05-finding-history.md) | 4 | Move, fix and incomplete recheck produce distinct outcomes. |
| 6 | [Inline review comments](feature-specs/06-inline-comments.md) | 3, 5 | Valid current anchors get one thread across retries. |
| 7 | [Authenticated dashboard](feature-specs/07-dashboard.md) | 3, 5 | An authorized reviewer can inspect both runs. An outsider cannot open either by ID. |
| 8 | [Evaluation and release](feature-specs/08-evaluation-release.md) | 1–7 | Reproducible comparison, recovery traces and a three-minute demo. |

Use week 1 for the fixture, week 2 for intake and publication, weeks 3–4 for local analysis, week 5 for history and inline comments, week 6 for the dashboard and weeks 7–8 for evaluation and release. Reserve the held-out evaluation cases before tuning prompts in week 3.

## Feature 01 evidence — November 17, 2026

The [runbook](../README.md) documents setup, migration, replay, inspection and verification commands. The pnpm workspace includes shared contracts, a Prisma migration, the bundled Git repository adapter, a concurrency-one BullMQ worker, a deterministic fixture analyzer and a loopback report API. Reports store exact revisions, configuration digest, source, stage outcomes, coverage and head-bound finding evidence together.

Validated with Node 24.11.1 and pnpm 11.11.0:

- `pnpm install --frozen-lockfile`, followed by `pnpm build` and `pnpm typecheck`, succeeded with all six compiled `dist` directories removed beforehand. Shared dependencies built before API/worker consumers. The CI workflow uses this same order without restoring build output.
- `pnpm test`: 3 unit tests passed. `pnpm test:integration`: 3 tests passed against real PostgreSQL and Redis, with isolated schema/queue cleanup. Concurrent first replay resolves to one durable row; queue-loss recovery preserves the run ID.
- Started the `opticpr-fixture` Compose project with newly created PostgreSQL and Redis volumes; `pnpm db:migrate` applied the initial migration successfully.
- `pnpm test:smoke` replayed the real CLI twice and inspected run `2acd77dd-a7e8-466d-8e43-b8eba159675c` through HTTP. Its base is `c92a9a02fefb3d11bb91c60bbf60e332df13b567`; its head is `7c7d890027156bff7ffe4fd89356ee5234e39f57`. The report contains fixture provenance, single-rule coverage and the pagination finding at head line 3.
- The same smoke test stopped PostgreSQL: readiness returned 503 with `postgresql: down` and `redis: up`; replay exited 1 with empty stdout. PostgreSQL was restored and became healthy before the test exited successfully.

The fixture stub does not run Semgrep or a model; both stages are explicitly skipped. Automatic outbox recovery, GitHub publication and user authorization remain in later slices.

## Features 02–03 evidence — November 17, 2026

GitHub intake is present, and feature 03 adds a durable PR target, `latestRunId`, one stored conversation-comment ID and a replaceable publication outbox. Dispatch, finalization and publication resolve live revisions under PostgreSQL advisory locks. Report completion, conditional pointer promotion and publication intent commit in one transaction. The worker starts both reconcilers; new comparisons discovered during publication become durable analysis work even without webhook delivery.

Validated locally with Node 26.5.0, pnpm 11.11.0, PostgreSQL and Redis:

- `pnpm build`, `pnpm typecheck` and all 11 unit tests passed. HTTP transport tests exercise repository-scoped publication tokens, pagination, app ownership filtering and create/update requests; retry tests verify rate-limit minimums, exponential delays and jitter.
- `pnpm test:integration`: all 29 tests passed, comprising 3 fixture, 14 intake and 12 publication tests. Each suite creates an isolated database schema and Redis queue. GitHub is mocked; no real App token or remote comment was used.
- A database constraint interrupted finalization after report/pointer writes but before publication intent. The entire transaction rolled back; retry completed the report, pointer and intent, and the test read the report through `latestRunId`.
- Two actual BullMQ worker instances paused A during its comparison, completed and published B, then resumed A. Both pointer and visible summary stayed on B. A separate publisher paused after selecting A, completed/published B and resumed the stale publisher with the same result. An older base comparison with the same head also could not replace B.
- A create succeeded remotely but lost its response. A restarted publisher recovered the app-authored marker, stored its ID and left exactly one visible app summary. User-copied markers were ignored. Separate database clients running concurrent publishers produced one create.
- Both head changes and base retargets just before posting were detected without a webhook. A push during create changed the same comment to pending for the new revision; completing that revision replaced it with the corresponding report.
- Three rate-limit/configuration failures preserved the intended run and sanitized diagnostics, stopped automatic retries and allowed an operator retry. Revocation cancelled publication; an old publisher could not cancel fresh intent after repository re-selection, even when the logical run ID was reused.
- `pnpm db:migrate` applied `20261117020000_current_review` to the local development database. A Prisma schema/database diff reported no difference.
- `pnpm test:smoke` passed: compiled API/worker startup, real fixture replay, HTTP inspection and PostgreSQL outage/readiness behavior. The integration and smoke suites must run sequentially because each restarts shared Compose services.

The [runbook](../README.md) documents Pull requests: write, marker recovery, lock behavior, publication states, rate-limit handling and `pnpm publication:retry <repository-id> <pr-number>`. Current GitHub reports still have unknown analysis coverage. Authenticated HTTP access and the browser dashboard remain feature 07; its pointer and shared reader are now available. Installation locks currently serialize operations across PRs in the same installation as well as within each PR.

## Feature 05 evidence — November 17, 2026

Completed reports now include PR-scoped stable finding IDs and immutable history snapshots. Comparisons use rule/class, normalized source tokens, enclosing named symbols and explicit rename mappings. Full-file static checkpoints retain observations outside added diff lines; prior affected files remain eligible for recheck even when a fix removes them from the PR diff. Equivalent deterministic rechecks can clear a finding; configuration changes, missing model-only observations, scanner gaps and ambiguous matches retain prior evidence as needing verification.

The local operator CLI appends dismiss/reopen decisions with actor, reason, time and an ordered audit sequence. UUID idempotency keys prevent duplicate decisions. A dismissal carries only across an unambiguous match. Agreeing model/static sources retain both citations. Report completion, history, current-pointer promotion and publication intent share one transaction; snapshot/decision update and delete rules preserve stored evidence. Historical fixture HTTP responses include the frozen report and a separate decision audit. Authenticated maintainer HTTP actions remain feature 07.

Validated locally with Node 26.5.0, pnpm 11.11.0, PostgreSQL, Redis and the digest-pinned Semgrep image:

- Build, typecheck and 30 unit tests pass, including token normalization preserving string contents, one-to-many/many-to-one ambiguity, source grouping, decision restoration after an unambiguous recheck and repeated checks under a changed configuration.
- All 42 integration tests pass, including the existing intake, publication, inference/checkpoint and fixture recovery suites. The compiled CLI/API smoke test passes, including PostgreSQL outage/readiness recovery. Both history migrations are applied locally; Prisma's schema/database diff reports no difference.
- The six history integration tests use the normal queue/worker and real bundled commits. They verify original line-3 evidence, stable IDs after a header moves the condition to line 5 and after an explicit rename, a cleared fix with the prior citation retained, skipped-file/configuration/model-only uncertainty, and an ambiguous duplicate without inherited dismissal.
- The trusted synthetic TypeScript pagination function is transpiled and executed for both original revisions: the base returns `[1,2,3]` and `[1]`; the regression returns `[1,2]` and `[]` for page sizes three and one.
- Historical reports are inspected over HTTP after comparison. Re-finalization returns the frozen snapshot, SQL update attempts leave snapshots/decisions intact, and dismiss/reopen events preserve their append order. The publication rollback test also checks that failed finalization leaves no snapshot and retry creates exactly one.
- The checked-in deterministic Git bundle preserves the original two commit SHAs and adds moved, renamed, fixed and ambiguous scenario refs. The runbook documents named fixture replay, inspection and `pnpm finding:decide`.

## Feature 06 evidence — November 17, 2026

Current GitHub report finalization now commits revision-scoped inline publication intents with finding history, the frozen report, current-pointer promotion and the summary outbox. Intents retain app markers, head-side paths/lines, comment bodies, skip/supersession reasons and confirmed remote review/comment IDs. The publisher validates unified hunk counts, uses added head source lines across multiple hunks and explicit rename destinations, then rechecks the exact comparison and full source excerpt before publication. Each eligible finding uses the GitHub review API with `COMMENT`, its reviewed head commit and `side: RIGHT`.

Inline writes share the summary's installation/PR advisory locks, access checks and live base/head/current-pointer guard. A push before the write skips stale publication and reconciles the persistent summary. A push during the write leaves the comment attached to its reviewed commit and reconciles the new comparison. Missing patches, mismatched excerpts and rejected anchors retain their findings in both report and summary. Recovery paginates review comments and verifies the authenticated App's reserved bot identity, marker, original commit, path, line and side; user copies, other revisions and replies cannot impersonate a publication. Prior reports and threads are retained.

Validated locally with Node 26.5.0, pnpm 11.11.0, PostgreSQL, Redis and the pinned Semgrep image:

- Build and typecheck pass; all 34 unit tests pass. HTTP transport tests verify explicit commit/line/side submission, review-comment pagination, authenticated bot ownership, scoped write credentials and revocation checks. Parser tests cover multiple hunks after deletions, omitted hunk counts, no final newline, rename destinations and malformed/truncated patches.
- All 51 integration checks pass (the full 48-check suite followed by the expanded 21-check publication suite). The normal webhook/dispatcher/queue/worker path validates two findings and publishes them to source lines 2 and 10 in separate hunks after a deletion. Concurrent publishers produce one thread per finding and one summary.
- Moving the live head during the last source read prevents the stale inline write, marks unposted intent superseded, queues the new comparison and updates the same summary to pending. A separate push during remote creation retains the reviewed commit on the first thread and prevents the remaining stale write.
- A successful remote review followed by a timeout is recovered after webhook replay/restart without another create. The same finding on a later revision preserves its stable ID, prior snapshot and original thread. A returned review ID with temporarily unavailable comment confirmation also prevents another create.
- Missing/rejected anchors, missing live patches and mismatched source excerpts preserve report and summary evidence. An injected inline-intent storage failure rolls back the report, history snapshot, pointer and both publication intents; retry commits and publishes once.
- Migration `20261117050000_inline_comments` is applied locally; Prisma's schema/database diff reports no difference. The compiled CLI/API/worker smoke test passes, including PostgreSQL outage/readiness recovery. An accidentally overlapping focused rerun was interrupted by the smoke test's deliberate database shutdown; it was rerun successfully after recovery, and the abandoned test schema was removed.

The [runbook](../README.md#verified-inline-comments) documents publication states, retry behavior, ownership recovery and single-line anchor behavior. GitHub is mocked in acceptance tests; no live GitHub App review or hosted CI run was performed.

## Starting a work session

Read the [product requirements](PRD.md) and the next feature spec. Consult [backend contracts](BACKEND_STRUCTURE.md), [tool choices](TECH_STACK.md), [application flow](APP_FLOW.md) or [dashboard guidelines](FRONTEND_GUIDELINES.md) for the affected surface. Implement through the feature’s normal entry point and run the acceptance checks. Record completed work here with its test or demo evidence before moving on.
