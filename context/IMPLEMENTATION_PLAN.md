# Implementation plan

**Current state:** features 01–03 are implemented and their acceptance checks passed locally using real PostgreSQL/Redis and mocked GitHub. A clean CI workflow is included; hosted CI has not run because this workspace is not a Git checkout. Features 04–08 and model benchmark results remain pending. The eight-week schedule is an estimate. Each feature spec defines the evidence for completing that slice.

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

## Starting a work session

Read the [product requirements](PRD.md) and the next feature spec. Consult [backend contracts](BACKEND_STRUCTURE.md), [tool choices](TECH_STACK.md), [application flow](APP_FLOW.md) or [dashboard guidelines](FRONTEND_GUIDELINES.md) for the affected surface. Implement through the feature’s normal entry point and run the acceptance checks. Record completed work here with its test or demo evidence before moving on.
