# OpticPR

OpticPR replays a synthetic pagination PR or accepts signed GitHub App events through a durable PostgreSQL outbox and a Redis/BullMQ worker. The fixture needs no GitHub or model credentials. The API and worker run on the host; Compose runs the two dependencies.

## Setup

Use Node **24.11.1 LTS**, pnpm **11.11.0**, Git, and Docker with Compose v2 or newer. The workspace pins dependency versions and checks in `pnpm-lock.yaml`. `.nvmrc` and `.node-version` select the Node version. Install pnpm with `npm install --global pnpm@11.11.0` if needed.

From the project directory:

```sh
nvm use
cp .env.example .env
pnpm install --frozen-lockfile
pnpm db:generate
pnpm build
pnpm typecheck
docker compose up -d --wait
pnpm db:migrate
```

`pnpm build` builds compiled shared packages in dependency order before their consumers. Run it before tests or starting services. Prisma generation is explicit and does not require a running database. Migration uses the root `.env`. Compose pins PostgreSQL 16.14 and Redis 7.4.9 by image digest, binds only loopback ports **54329** and **63799**, and persists data in named volumes. Adjust the port mappings and matching URLs in `.env` together if necessary.

## Replay and inspect

Start these in separate terminals:

```sh
pnpm dev:worker
pnpm dev:api
```

Then replay:

```sh
pnpm fixture:replay
# Copy runId from the successful JSON result:
pnpm run:inspect <run-id>
curl http://127.0.0.1:3000/health/ready
curl http://127.0.0.1:3000/api/runs/<run-id>
```

Replay waits for the stored report, exits nonzero on failure or timeout, and prints a success result only after PostgreSQL contains a completed, schema-valid report. Repeating it with the same input/configuration returns the same run ID. `REPLAY_TIMEOUT_MS` controls the wait (default 30 seconds). A worker must be running.

The report identifies these real Git commits from `fixtures/pagination/repository.bundle`:

| Revision | SHA | Boundary |
| --- | --- | --- |
| Base | `c92a9a02fefb3d11bb91c60bbf60e332df13b567` | `end = start + pageSize` |
| Head | `7c7d890027156bff7ffe4fd89356ee5234e39f57` | `end = start + pageSize - 1` |

With `[1,2,3]`, page 1 and page size 3, the base returns all three items and the head drops `3`. A page size of 1 returns an empty page. The finding cites head line 3, its exact source excerpt, the changed hunk, impact and a verification example. `python3 scripts/build-fixture.py` reproducibly regenerates the bundle and manifest. The adapter reads source by SHA and never executes reviewed code.

The default fixture replay’s findings and stage provenance explicitly say `fixture`. Coverage is complete **only for the single fixture rule**. In that default replay, repository and deterministic-stub stages complete; Semgrep and model stages are explicitly skipped. Local JS/TS analysis is described below. Live GitHub intake and current-review publication are also described below; authentication and the browser UI are later slices. The inspection API enforces a loopback bind and exposes only fixture runs.

## Verification

```sh
pnpm test
pnpm test:integration
pnpm test:smoke
```

Unit tests verify the fixture, revision-bound evidence, identity hashing, raw-byte signatures, and the actual Octokit token/request scope using a stubbed HTTP transport. Integration tests use real PostgreSQL and Redis with a fake GitHub repository client to exercise fixture replay and the GitHub acceptance checks: rollback on storage failure, ten concurrent duplicate deliveries, base retargeting, live eligibility, expired dispatch leases, queue-loss recovery, and revocation during an in-flight fetch. The GitHub integration test stops and restarts this Compose project’s Redis and prints measured acknowledgment p95 against the proposed 1000 ms target. Publication integration tests additionally exercise atomic finalization rollback, two-worker stale-result races, stale publication selection, lost create responses, spoofed markers, concurrent publishers, head/base changes before publication, pushes during publication, retry exhaustion and revocation. Tests create and clean up isolated database schemas and queues. Smoke tests launch temporary API/worker processes on loopback port 31997, replay the actual CLI twice, read the report through HTTP, temporarily stop this Compose project's PostgreSQL, verify failure, then restore PostgreSQL. Run these against development/test services.

To inspect the outage manually while the API is running:

```sh
docker compose stop postgres
curl -i http://127.0.0.1:3000/health/ready
pnpm fixture:replay
pnpm check:outage
docker compose start --wait postgres
```

Readiness must return HTTP 503 with `postgresql: down` and `redis: up`. Replay must exit 1 and name PostgreSQL without a success result, even when a previous report already exists. Liveness at `/health/live` stays available.

CI installs with the frozen lockfile, pulls the pinned Semgrep sandbox image, generates Prisma Client, builds the complete dependency graph without restored `dist` output, type-checks API and worker, migrates fresh Compose volumes, and runs all three verification commands. Only the pnpm package store is cached.

For a fresh-volume rehearsal that preserves existing Compose volumes, use a separate project name throughout a shell session (stop any existing OpticPR services first to free the ports):

```sh
export COMPOSE_PROJECT_NAME=opticpr-fresh-check
docker compose up -d --wait
pnpm db:migrate
pnpm test:integration
pnpm test:smoke
```

`docker compose down` stops services and preserves reports. `docker compose down --volumes` intentionally deletes that project's development data; use it only when you want a reset.

## Layout and recovery

- `apps/api`: signed raw-body GitHub intake, health and local fixture inspection endpoints.
- `apps/worker`: concurrency-one analysis worker, durable intake dispatcher, current-review finalization, summary publisher, reconciliation and operator CLIs.
- `packages/contracts`: shared Zod schemas for inputs, configuration, jobs, reports and evidence.
- `packages/repository`: shared adapter contract, bundled Git fixture and repository-scoped GitHub REST implementation.
- `packages/database`: Prisma schema, checked-in migration and client export.
- `packages/runtime`: readiness, queue connections, stable identity, scheduling and report waiting.

PostgreSQL has a unique logical key derived from repository ID, PR number, both SHAs and a canonical configuration digest. Queue payloads contain only the durable run ID. The worker validates that identity before committing report, coverage, provenance and completed state atomically. BullMQ retries failures three times and recovers stalled work. Replay repairs a missing Redis job from the durable record; replaying a failed run retries its retained job. A queue restart never changes the logical run identity. GitHub jobs are also recovered automatically from PostgreSQL by the dispatcher described below. GitHub finalization and remote publication use the current-review protocol described below.


## GitHub intake

Apply the new migration with `pnpm db:migrate`, rebuild with `pnpm build`, then start the API and worker with the existing commands. The worker also starts the intake dispatcher and summary publisher. Fixture commands still work when the GitHub settings are empty.

Create a GitHub App with **Contents: read** and **Pull requests: write**, subscribe to **Pull request**, and enable its webhook. Installation and installation-repository lifecycle events maintain the selected repository grants. Install the app on the repositories you select. Configure:

- `GITHUB_WEBHOOK_SECRET`: the same random secret configured in the App webhook.
- `GITHUB_APP_ID`: the GitHub App ID.
- `GITHUB_APP_PRIVATE_KEY`: its PEM private key, quoted on one environment-file line with literal `\n` separators.

Set the App webhook URL to `https://<your-TLS-proxy>/webhooks/github`. Forward to the loopback API and preserve the request body bytes and GitHub headers. The API keeps its loopback bind; fixture inspection remains local. No public report endpoint or OAuth login is added here. For an existing installation, redeliver its installation-created and subsequent selection-change events so local grants reflect the current selection before sending PR events.

`POST /webhooks/github` verifies `X-Hub-Signature-256` with HMAC-SHA256 over raw bytes before parsing. Missing or incorrect signatures return 401 and write nothing. Missing configuration or durable storage failure returns 503; GitHub deliveries can be redelivered after recovery. Malformed signed payloads return 400. A first verified delivery returns 202 only after its receipt and eligible outbox intent commit together. A matching duplicate returns 200; reuse of a delivery ID for different bytes or event type returns 409. Raw bodies are limited to 25 MB and compressed requests are rejected.

Opened, reopened, synchronize and ready-for-review events schedule only open, non-draft PRs in locally selected repositories. Edited events schedule only when `changes.base.ref` or `changes.base.sha` identifies a base change. Title-only edits, closed PRs and drafts get an ignored receipt. No PR event grants repository access. The dispatcher rechecks live PR eligibility and reads the current base/head SHAs rather than trusting event revisions.

Each comparison uses a stable SHA256 logical key and queue job ID derived from repository ID, PR number, both SHAs, source and configuration digest. The queue payload is the durable run ID, shared with the fixture worker. GitHub tokens are short-lived installation tokens requested with exactly one repository ID. Intake/analysis tokens request read-only permissions; the publisher requests Contents: read and Pull requests: write. PR, SHA comparison and SHA-addressed file requests stay in that selected base repository, including fork PRs; source-provided URLs are never fetched. Local grant/version checks guard every outbound request, including token acquisition and retries. See GitHub’s [installation authentication documentation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation).

The dispatcher polls once per second. It claims pending outbox rows with 60-second leases, stores the exact run before enqueueing, retries failures with bounded exponential delays, and reconciles queued/running records whose BullMQ jobs were lost. A dispatcher restart reclaims expired leases. Reconciliation rotates bounded batches so existing jobs cannot starve later missing jobs. Failed analysis jobs retain BullMQ’s three-attempt limit. Credentials or GitHub failures leave dispatch intent pending with a sanitized diagnostic; source and credentials are never logged.

Removal or uninstall atomically revokes local access and cancels pending and outstanding work. Reconciliation removes queued cancelled jobs. An in-flight request may finish, but finalization rechecks access under the same installation lock and cannot commit its report. Re-selection creates a fresh grant version so old jobs remain fenced. Completed historical reports stay stored. Suspension disables installation access and cancels outstanding work while retaining the selection for unsuspension.

New GitHub runs use the local JS/TS pipeline described below. Reports retain comparison metadata and patches; excluded secrets, binaries and generated source have their patches omitted. Historical intake-only configurations remain readable with unknown coverage. Empty findings never establish repository-wide correctness. GitHub comparisons at the REST API’s 300-file boundary fail explicitly rather than recording potentially truncated coverage; files without a patch retain an empty hunk. Live runs can be inspected through Prisma/operator tooling, while `/api/runs/:id` continues to expose fixtures only until repository authorization exists.

The local acceptance run on 2026-11-17 measured **28.6 ms acknowledgment p95** for ten simultaneous deliveries with one delivery ID, producing one receipt, outbox entry and logical run. This is a local ten-request measurement; the integration test prints a fresh measurement each time. GitHub API behavior is tested with mocks; no real App credentials are required by the suite.


## Current review publication

The worker finalizes each GitHub report after reading the live head and base again. In one PostgreSQL transaction it stores the completed report, conditionally advances `PullRequest.latestRunId` for the desired logical key and both SHAs, and records `ReviewPublication` intent. A stale result stays in run history. `readCurrentReview` in `apps/worker/src/current-review.ts` reads the selected report through that pointer for the future authenticated dashboard. Live reports remain unavailable through the unauthenticated fixture API.

The publisher polls durable intent once per second. PostgreSQL transaction advisory locks serialize dispatch, promotion and remote publication per PR across processes. The installation lock is also held during these operations so grant changes and finalization cannot interleave; this currently serializes publication across PRs in one installation. There is no Redis publication job or expiring publication lease. A process/connection failure releases its database locks, and pending intent survives a restart.

Before each write the publisher reads live revisions and compares both SHAs and the desired key. It writes one conversation comment beginning with `<!-- opticpr:summary:<repository-id>:<pr-number> -->`, includes full base/head SHAs and the reviewed SHA/run, and stores the comment ID. It lists all comment pages to recover a successful create whose response was lost. Recovery accepts only comments authored by this GitHub App; user copies and other apps' comments cannot claim the marker. A deleted comment is recreated on retry. GitHub's [issue comment endpoints](https://docs.github.com/en/rest/issues/comments) accept Pull requests: write for these mutations. Existing installations must approve the updated App permission before publication can succeed.

The publisher rechecks revisions after writing. If a push or base retarget landed during the request, it records the new pair as durable work and updates the same comment to say the new comparison is pending. Once that report completes, the same comment receives its review. Reconciliation is bounded to three changing revisions per tick, with remaining work kept in PostgreSQL. New GitHub runs include static findings and independently verified model proposals. The summary labels partial or unknown coverage, retains static alerts when enrichment fails, and includes paths, line numbers, excerpts and verification guidance.

`ReviewPublication.state` is `pending`, `waiting` for a report, `published`, `failed`, or `cancelled`. Network/configuration errors retry up to three attempts per intended revision. `nextAttemptAt` honors `Retry-After`, exhausted primary-rate-limit reset times and secondary-limit delays, plus exponential backoff and jitter, following [GitHub's retry guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api). After exhaustion, the intended run, exact revisions, attempt count and sanitized diagnostics remain stored. Repository removal, suspension or uninstall cancels outstanding publication.

Inspect `ReviewPublication` and its related `ReviewRun` with local Prisma/operator tooling. After resolving credentials, permissions, rate limits or connectivity, reset the same PR's durable intent:

```sh
pnpm publication:retry <github-repository-id> <pr-number>
```

The running worker publishes it on the next poll. This local operator command rechecks installation/repository access; an authenticated maintainer retry endpoint belongs to feature 07. Re-observing the same revision through another webhook does not reset an exhausted retry budget. Rebuild after pulling code changes and apply migrations with `pnpm db:migrate` before starting services.
# opticPR

## Local analysis and function context

New GitHub comparisons use `local-analysis` v1. Before starting the worker, apply the migration and pull the pinned Semgrep 1.144.0 image (Docker must remain available):

```sh
pnpm db:migrate
pnpm analysis:scanner:pull
pnpm build
ollama pull qwen2.5-coder:7b
OLLAMA_NUM_PARALLEL=1 OLLAMA_HOST=127.0.0.1:11434 ollama serve
```

Run Ollama in a separate terminal and start the worker normally. `OLLAMA_URL` defaults to `http://127.0.0.1:11434` and accepts only loopback HTTP origins. The worker verifies the installed model manifest digest is `dae161e27b0e90dd1856c8bb3209201fd6736d8eb66298e75ed87571486f4364` before generation. A different or unavailable model produces partial coverage while retaining static findings. Model, prompt, rules, grammar revisions and budgets are part of logical run identity. The default remains 4096 context tokens and function context. The credential-free fixture replay retains its deterministic stub; the benchmark opts that same fixture into real local analysis.

The worker reads at most 20 eligible changed JS/TS head files and 800 added/deleted lines. It skips deleted files, missing patches, unsupported types, dependencies, lockfiles, generated output, unsafe paths, binary/invalid UTF-8 data, files above 128 KiB, and recognizable secret files or embedded credentials. Skip reasons and scanner errors remain in coverage. Secret detection is deliberately conservative and does not replace a dedicated secrets scanner. Semgrep receives only the selected SHA-addressed snapshot, mounted read-only into a digest-pinned container with no network, no capabilities, a read-only root, non-root user, bounded CPU/memory/processes and a 45-second process deadline. No reviewed code or repository configuration is executed. Three checked-in rules cover dynamic evaluation, disabled certificate verification and a possibly decremented exclusive slice boundary; “complete” coverage is limited to those rules and bounded context.

`RunObservation` is unique by `(runId, fingerprint)`. Its exact head evidence and `ReviewRun.staticCheckpoint` / `staticCompletedAt` commit together before any Ollama request. A retry reuses the checkpoint and leaves one static observation. `RunEnrichment` stores accepted proposals separately; model text cannot delete or overwrite a static alert. A static scanner failure is recorded as a partial checkpoint, so repairing the scanner does not silently change an already checkpointed run. Re-run with a new analyzer/configuration revision to perform a new static scan.

Tree-sitter maps changed head lines to JS/TS functions, arrows and methods, using pinned WASM grammars. Parsing failures, top-level changes and functions above the context budget use bounded head hunk windows. Requests include exact SHA, path, line ranges, changed-line numbers, diff and source. Context omitted for prompt limits is recorded as partial coverage. Ollama receives a structural JSON schema through `format`; strict Zod limits are checked afterward (large string bounds in generation grammars exceed llama.cpp repetition limits). Each candidate must additionally match an exact supplied source excerpt and begin on an added head line whose patch text matches the snapshot. Invalid anchors, revisions, observation references or excerpts increment the rejection counter. Malformed output, unavailable inference and the 90-second per-run inference deadline produce a completed partial report and normal publication containing the original static alerts.

Every inference stage uses `withInferenceSlot`. A PostgreSQL advisory transaction lock, normalized by local Ollama origin, spans the entire transport request and is shared across workers, processes, schemas and retries using this application's database. Waiting for the slot counts toward the model deadline. Keep all workers on the same database and run the local Ollama server with `OLLAMA_NUM_PARALLEL=1`; the latter also bounds server-side generation during client cancellation. Logs contain run IDs and sanitized stage outcomes, not source or model output.

Acceptance tests inject malformed JSON, timeout and a schema-valid wrong excerpt; query committed evidence using a separate database client before inference; inspect a partial published comment; and exercise two workers plus actual BullMQ retry with a measured peak of one active inference request. Integration tests also execute the pinned real scanner sandbox. CI stubs inference and needs no Ollama model.

Run the real-model comparison after setup, with no other reviews consuming the host slot:

```sh
pnpm analysis:benchmark
# Optional output path:
pnpm analysis:benchmark /absolute/path/results.json
```

It runs 4096/8192 tokens × diff-only/function-context against the same bundled pagination commits, stores reports/checkpoints in PostgreSQL, and records inference latency, sampled runner RSS, loaded model/accelerator bytes, accepted/rejected proposals and exact outputs. See [the measured results](context/benchmarks/04-local-analysis.md) and [raw data](context/benchmarks/04-local-analysis.json). This five-line fixture is an operational comparison, not a broad quality benchmark.
