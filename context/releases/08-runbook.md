# Feature 08 release and recovery runbook

**Operating scope — November 18, 2026:** This is a local-only CV/portfolio project. Public hosting is disabled at the user’s request. Keep services on loopback; do not start public tunnels, expose the Mac, or provision hosting unless the user explicitly requests hosting again. Recorded demos, local benchmarks and recovery evidence are the portfolio deliverables.

The former public preview and ngrok tunnel are stopped. Temporary preview containers and the isolated deployment database schema have been removed. Local application services and development data remain available. Deployment commands below are historical/optional reference, not steps to execute for the current local-only project.

The release has a measured synthetic evaluation and a reproducible local recovery drill. See [results](../evaluation/08-results.md), [raw recovery evidence](08-recovery.json), [demo transcript](08-demo-transcript.md), and [deployment evidence](08-deployment.json). Production hosting, permanent DNS, GitHub OAuth callback registration at that permanent origin, independent label review, and hosted CI are separate release steps; a temporary HTTPS preview does not establish production availability.

## Historical preview — retired

The earlier temporary preview used the existing development machine and the already-selected synthetic `rajveer3x/opticpr-test` PR #4. No hosting purchase was made. Both the Cloudflare preview and the pre-existing ngrok tunnel have now been stopped. The deployment JSON records a historical smoke test rather than a current public deployment.

Cloudflare documents Quick Tunnels as account-free, temporary development endpoints, with no production guarantee: [official Quick Tunnel documentation](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/). The assigned URL expires with its tunnel container. The recorded deployment file contains the actual URL, image ID, schema, container names, fixture/live revision pairs and run IDs. The new-origin OAuth callback has not been registered; keep the configured local sign-in flow for development. The smoke verifies HTTPS readiness, the built app, unauthenticated report rejection and unsigned webhook rejection. It runs the real worker and pinned scanner on the fixture and live PR with a read-only installation client. It does not send a GitHub comment or claim live publication-race evidence.

To reproduce the preview after building an image:

```sh
docker build -t opticpr:release .
docker image inspect opticpr:release --format '{{.Id}}'
# Pass that printed sha256 image ID; mutable tags are rejected.
CLOUDFLARED_IMAGE=cloudflare/cloudflared@sha256:e613aadbc2d9511785d2e67a86b0c8ac18dd63a3f9af0d06faf04cbfdcb35f2d \
  node --env-file=.env scripts/release-smoke.mjs sha256:<printed-image-id>
```

Each invocation writes a new `output/deployment-<id>.json`; an optional path after the image ID must be previously absent. The preview launcher creates an isolated schema/queue, runs the image by its content ID, and keeps only the API, namespace holder and HTTPS tunnel running after successful checks. It passes credentials through child-process environment variables, never command arguments or a new credential file. It shares a network namespace to preserve the API's loopback-only bind on Docker Desktop. Clean up using the exact container names/schema in `08-deployment.json`; do not remove the normal development Compose volumes.

## Permanent Linux host

For a permanent installation, use one Linux host with Docker Engine and a fixed DNS hostname pointing to it. This keeps the existing private loopback Ollama architecture and scanner sandbox intact. A separate managed frontend hosting product would still require this worker/database/inference host, so it is not sufficient on its own. No paid host or domain has been purchased by this implementation.

1. Create a private `.env` from `.env.example`. Generate a random hexadecimal PostgreSQL password and update both `POSTGRES_PASSWORD` and `DATABASE_URL`. Use a non-empty random `SESSION_SECRET`; configure App/OAuth credentials, `DASHBOARD_ORIGIN=https://<hostname>` and `OPTICPR_DOMAIN=<hostname>`. Keep model enrichment disabled unless explicitly opting in. Fresh volumes are required when changing the initial database password; existing databases require an intentional PostgreSQL password rotation.
2. Build the supplied `Dockerfile`, push to a registry you control, and set `OPTICPR_IMAGE=registry/repository@sha256:<registry-manifest-digest>`. Get the registry digest after pushing; a local image ID is not a pullable registry reference. Node and Docker CLI base images, PostgreSQL, Redis, Caddy and Semgrep are digest-pinned. The lockfile pins application dependencies. The image build was tested locally; the permanent host stack has not been deployed here.
3. Allow inbound 80/443 for Caddy, keep PostgreSQL/Redis bound to loopback, and create `/var/lib/opticpr/snapshots`. The worker's Docker socket is an operational privilege: run it on a host dedicated to this application. Mount the snapshot path at the same absolute location on host and worker. Scanner rules are copied beside the temporary source snapshot so Docker bind mounts resolve on the host as well as inside the worker.
4. Run `pnpm release:check` from a prepared checkout. It rejects mutable service images and a non-HTTPS dashboard origin. The release Compose override requires an explicit password and application image; it never supplies a fabricated digest. Run the scanner pull command before starting workers.

```sh
pnpm analysis:scanner:pull
docker compose --env-file .env --env-file deploy/images.env \
  -f compose.yaml -f compose.release.yaml up -d --wait postgres redis
# Run migrations from the same release image before starting API/worker.
docker compose --env-file .env --env-file deploy/images.env \
  -f compose.yaml -f compose.release.yaml run --rm api \
  node scripts/migrate.mjs
docker compose --env-file .env --env-file deploy/images.env \
  -f compose.yaml -f compose.release.yaml up -d
```

The migration script normally loads `.env` through its command wrapper; inside Compose, the environment is already supplied. Caddy persists its ACME certificates in separate volumes and proxies to the API's loopback listener. Register `https://<hostname>/auth/github/callback` in the App and point the webhook to `https://<hostname>/webhooks/github`. Verify sign-in, a fixture locally, one authorized synthetic live PR, signed webhook delivery and the app-owned summary before describing this as a production release. Real external publication is an explicit operator action, separate from the read-only smoke tool.

## Backup and restore

`pnpm ops:backup backup backups/<unique-name>.dump` uses `pg_dump -Fc` against the bundled Compose PostgreSQL. It creates a mode-0600 file exclusively and prints only byte count/checksum. The dump contains source evidence, sessions and reviewer audit data: keep it outside Git and encrypt/access-control any off-machine copy. It does not back up Redis, which is a rebuildable work queue. For an external PostgreSQL service, use its own authenticated backup/restore tooling instead of this Compose-specific helper.

`pnpm ops:recovery` creates a synthetic installation and signed webhook flow in an isolated schema. It pauses a real running job, writes a backup, restores into a freshly named database, verifies the preserved report/pointer/run ID, then starts reconciliation with an empty Redis queue. It finishes the fix on a second worker, releases the stale worker, checks one remote summary across redelivery, and injects an incomplete scanner result. Assertions fail the command on any wrong pointer, duplicate summary, lost static alert or false clearance. The GitHub service is explicitly mocked. The command removes both temporary schemas/databases, queues, clones, scanner snapshots and dump files in cleanup. Its JSON trace retains only synthetic evidence and identifiers. Each invocation writes a new `output/recovery-<id>.json` and prints its path; an explicit output argument must name a previously absent file, preserving the released trace/video.

For a real disaster restore, stop API/worker, restore an encrypted backup into a new database, apply any subsequent migrations with the matching image, point the runtime at the restored database and an empty Redis queue, and start the normal worker. Its dispatcher recovers queued/running runs, expired intake leases and missing jobs; its publisher reconciles durable intents and app-authored remote markers. Redis restoration is unnecessary. Recheck installation grants and live GitHub revisions before enabling publication. Preserve the original database until the restored state and remote summary have been verified. Never restore directly over the only database copy.

## Deletion and retention

Scanner and fixture adapters remove temporary snapshots/clones in `finally`; scanner timeout handling also removes its named container. Read-only source mounts and network-disabled Semgrep remain in place. A process/host crash can leave a temp directory or scanner container: stop the worker, remove only its `opticpr-scan-*` containers and `opticpr-scan-*`/`opticpr-fixture-*` directories under the configured private `TMPDIR`, then restart. Never sweep a live worker's snapshots or the database/Redis volumes. The preview smoke removes its shared scanner directory when it exits.

Proposed report retention is 30 days from completion. **It is not an implemented automatic deletion promise.** Immutable snapshots and append-only decision rules deliberately prevent ordinary DELETE/UPDATE. A production purge needs a separately reviewed, transactional privileged procedure that handles decisions, inline intents, retry references, current pointers, observations, snapshots and runs together, including removal of old source excerpts embedded in retained history. Clearing only `ReviewRun.report` would leave data behind. Backups need a compatible maximum lifetime so purged source cannot be restored indefinitely. Until such a purge is implemented, reports remain stored.

Installation removal/suspension immediately revokes local grants and cancels outstanding analysis/publication; the live user permission intersection blocks dashboard reads. It does not currently erase stored reports or delete GitHub comments. Uninstall cleanup requires stopping workers, revoking App/OAuth credentials and sessions, removing temporary source, and intentionally purging the installation's stored evidence with the privileged procedure above or deleting the dedicated installation database and all retained backups. GitHub comments/reviews are separate remote records; remove app-owned comments explicitly if requested. Keep the local development/test installation intact unless deliberately uninstalling it.
