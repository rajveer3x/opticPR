# 11 Credential-free cross-file review demo

**Implemented.** The [90-second recording](../releases/11-review-demo.webm) and a local read-only viewer follow the same two worker-generated reports for a synthetic missing-user change.

## Build

Use a trusted synthetic repository with a breaking change, an unchanged caller and a fix push. Include a second caller that already handles the exception. Package a read-only local replay with the reports and revision-bound excerpts produced by the detector. Restrict demo data access to the bundled fixture. Keep private repository reports behind the existing authorization checks.

Record the local walkthrough and put the recording and replay instructions near the top of the root README. Identify the example as synthetic. Link the [historical benchmark](10-real-regression-benchmark.md) for measured quality and the [recovery demo](../releases/08-demo-transcript.md) for worker behavior.

## Acceptance checks

- From a fresh checkout, follow the documented setup and replay steps with no GitHub credentials or model download. Confirm the viewer can inspect fixture evidence and cannot use the demo entry point to retrieve private reports.
- In about 90 seconds, show the changed throw, its unchanged caller and the handled comparison. Advance to the fix, show the completed recheck and reopen the original evidence.
- Verify the README recording plays and that the displayed revision IDs and finding states match the bundled reports.

## Teach me after implementation

Replay the demo with the learner. Pause on each revision and explain which stored evidence supports the finding, the clean comparison and the eventual clearance. Add the walkthrough to this file and explain it to me in chat using the [project teaching instructions](../../AGENTS.md).

## Implementation walkthrough

The [generator](../../scripts/build-review-demo.mjs) creates three commits in a synthetic Git repository and runs the normal worker twice. The worker uses the TypeScript detector and pinned Semgrep, the project's static scanner. It stores a report for the breaking commit and then checks the fix against that earlier report. The replay packages both reports and their source excerpts. The Git bundle, a standalone file containing the synthetic commits, lets you check those excerpts against the original files. [Revision manifest](../../fixtures/review-demo/manifest.json) · [Bundled reports](../../fixtures/review-demo/replay.json) · [Git bundle](../../fixtures/review-demo/repository.bundle)

Start with a request for user ID `missing`. The base commit `fb8a50a` returns `undefined`, so the route responds with HTTP 404. At regression commit `ea3e1f1`, `findUser` throws on that same branch. The route still imports it as `getUser`. The TypeScript compiler connects the alias to the changed function, and the detector reports one **New** finding. The companion route already catches that exception and still returns 404. In fix commit `3de34ee`, the original route gains the same protection. The worker rechecks both files and stores **Cleared by recheck** with zero current findings. [Detector](../../apps/worker/src/cross-file-regression.ts) · [Fixture evidence checks](../../tests/demo.unit.test.ts)

### Pause points in the recording

| Time | Open in the viewer | Evidence to inspect |
| --- | --- | --- |
| 0:10 | **Changed throw** | On `ea3e1f1`, `src/users.ts` line 4 now throws. |
| 0:22 | **Caller fallback** | On the same commit, `src/route.ts` lines 4–5 contain the call and the unchanged 404 check it bypasses. |
| 0:34 | **Previous return** | At base `fb8a50a`, the same branch returned `undefined`. The source pane shows the earlier revision. |
| 0:44 | **Handled caller** | `src/handled.ts` shows its original catch and 404. This caller produced zero findings. |
| 0:56 | **View fix push** | The head switches to `3de34ee`. The TypeScript caller analysis is **Completed**, and finding history says **Cleared by recheck**. |
| 1:06 | **Fix in src/route.ts** | The original route now catches the error and responds with 404. The lookup still throws. |
| 1:19 | **Previous observation** | The same finding ID opens the report at `ea3e1f1` and restores its three citations. |

The [demo server](../../apps/api/src/demo.ts) binds to loopback, an address reachable only from the local machine. It validates the two bundled reports against the fixture manifest and serves them through a fixed endpoint. It has no database connection. An unlisted run ID returns HTTP 404 and attempts to change data return HTTP 405. The [demo page](../../apps/web/src/demo.tsx) uses the regular [review components](../../apps/web/src/review.tsx) to display the saved reports. **View fix push** selects the second saved report. **Previous observation** reads the original run and finding IDs from history, so selecting it works after a page refresh. The authenticated dashboard continues to authorize its own requests. [Browser and endpoint tests](../../tests/browser/demo.spec.ts) · [Authenticated dashboard tests](../../tests/dashboard.integration.test.ts)

### Replay and verify locally

From a fresh checkout, install the locked dependencies, generate the database types used at build time, and compile the workspace. Then start the fixture viewer.

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm build
pnpm review:demo
```

Open [the local demo](http://127.0.0.1:4175/demo) and follow the pause points. A clean copy with no environment file, installed dependencies, or build output completed those steps and showed the original finding and the cleared fix in Chromium. The test had no GitHub, database, Redis, or model settings. The source and playback tests checked the commit IDs, excerpts, finding states, and private-route rejection. Chromium played the final README-linked video at 1280 × 800 for 90 seconds and could seek to the fix. The build, typecheck, 82 unit tests, 63 integration tests, 18 browser tests, and the CLI/API smoke test passed locally. The separate PostgreSQL/Redis recovery drill also passed. [README link](../../README.md#90-second-review-demo) · [Replay tests](../../tests/browser/demo.spec.ts)

To regenerate the reports after changing the synthetic fixture, start the project's usual PostgreSQL and Redis services and make the pinned Semgrep image available. Run `pnpm review:demo:generate` to queue the two reviews in an isolated schema and export their reports. With Playwright Chromium installed, `pnpm review:demo:record` captures the live local viewer and verifies the displayed revisions and finding states along the way. The replay demonstrates a constructed cross-file regression. Historical quality and worker recovery have separate evidence. [Historical benchmark](10-real-regression-benchmark.md) · [Recovery demo](../releases/08-demo-transcript.md)
