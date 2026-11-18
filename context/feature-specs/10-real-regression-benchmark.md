# 10 Benchmark on historical TypeScript regressions

**Implemented and measured.** The [historical replay](../../apps/worker/src/benchmark-historical.ts) compares the pinned Semgrep scanner with the same scanner plus the [cross-file rule](09-cross-file-regression.md). Two public repositories supply four revision pairs. Labels are provisional pending an independent human review of the upstream changes. [Reviewer handoff](../benchmarks/10-historical/label-review.md)

## Build

Select historical TypeScript regressions whose introducing changes and later fixes can be traced to public source. Record the repository, revision pair for the introducing change, fix reference, expected behavior and acceptable evidence locations. Use the later fix to establish the label. Give the scanner only information available at review time. Include comparable clean changes, such as a caller that already handles the exception.

Reserve entire repositories for held-out evaluation so related code stays together. Have a second human reviewer check labels and record disagreements and their resolution. If independent review is pending, mark the labels provisional. Keep this corpus separate from the earlier synthetic evaluation.

## Acceptance checks

- Replay the same pinned revisions through the existing static scanner alone and the scanner plus the new rule. Keep hardware, input budgets and other settings fixed. Record configuration, run IDs and coverage for both.
- Publish raw counts of additional verified defects, misses, false findings and clean PRs flagged, alongside denominators and end-to-end p50/p95 latency. Include partial scans and explain how they affect scoring.
- Provide a local reproduction command and trace representative outcomes back to source and labels. Report the measured result even if the rule adds zero findings.

## Teach me after implementation

Walk through one labeled regression and one clean change from their Git revisions to the score table. Recalculate one metric from its raw counts and explain what the sample can support. Add the walkthrough to this file and explain it to me in chat using the [project teaching instructions](../../AGENTS.md).

## Implementation walkthrough

A **revision pair** is the exact Git commit before a change and the commit that introduced it. A **label** states the expected behavior, where a correct finding could point, and which later upstream fix supports that judgment. The [sealed corpus](../../fixtures/historical/cases.json) contains two regressions and two clean comparisons. Here, a clean comparison is a merged fix that restores the labeled behavior. Both repositories are held out as a whole, so all four comparisons are reserved for final evaluation. The reservation followed the first implementation of feature 09 and preceded scanner runs on the corpus. No rule tuning used these measurements. The independent-review field remains provisional, with a place to record reviewer disagreements and their resolution. [Corpus hash](../../fixtures/historical/seal.json)

The runner fetches the pinned public commits once, verifies each earlier commit is the introducing or fixing commit's first parent, and gives the worker access to just that revision pair. The label and later fix are used by scoring. The raw input uses `fixture` for the offline replay mode, and its repository name and commit IDs come from the public upstream history. Both configurations use the same machine, Semgrep image, file and line budgets, and disabled model enrichment. They run one at a time through Redis and PostgreSQL, with separate histories and alternating run order. The timer starts at scheduling and ends when the completed report is available. Setup downloads and the subsequent evidence verification sit outside the timer. The raw output includes run IDs, exact inputs, configuration digests, stage outcomes and skipped files. [Benchmark runner](../../apps/worker/src/benchmark-historical.ts) · [Git source reader](../../packages/repository/src/index.ts) · [Recorded runs](../benchmarks/10-historical/raw.json)

### Follow one regression and its clean comparison

- **Ky regression.** Compare base `b49cd03` to head `e48386e`. The changed constructor invokes `AbortSignal.any` when it finds an input signal. Older Safari can supply `AbortController` without `AbortSignal.any`, so this new invocation can throw while building a request. The label accepts evidence around head line 173 of `source/core/Ky.ts`. Both configurations recorded a miss. The cross-file rule looks for a direct replacement of a missing-value return with a throw. The Ky failure comes from calling a browser API that may be absent. [Introducing source](https://github.com/sindresorhus/ky/blob/e48386e70144bfb7ccd2264ab5760b154048cf48/source/core/Ky.ts#L170-L174) · [Upstream regression report](https://github.com/sindresorhus/ky/issues/688)
- **Ky clean comparison.** Compare base `3207ecc` to head `24eec6f`. The fix checks for `AbortSignal.any` before the constructor enters the branch that combines signals. The label expects request construction to continue when the API is absent, with the timeout limitation documented upstream. Both configurations returned zero findings. That contributes one comparison to the denominator of two clean changes and zero to the flagged count. [Merged fix](https://github.com/sindresorhus/ky/pull/711) · [Fixed source](https://github.com/sindresorhus/ky/blob/24eec6fef2db724153915a1f80098216fe7571a8/source/core/Ky.ts#L172-L175)
- **MCP TypeScript SDK pair.** A server-sent event (SSE) is a message in a stream from a server. The introducing change sent an empty message to establish a resumption ID, which the client tried to parse as JSON. The merged fix retains the ID and skips the empty payload before parsing. The upstream regression test sends that empty event followed by a real message. Both configurations missed the introducing change and left the fix unflagged. [Introducing source](https://github.com/modelcontextprotocol/typescript-sdk/blob/3c50d07e9f390751df4f6da87fde369074c41e6c/src/server/streamableHttp.ts#L279-L289) · [Upstream fix and test description](https://github.com/modelcontextprotocol/typescript-sdk/pull/1184)

### Observed results

| Measure | Semgrep | Semgrep + cross-file rule |
| --- | ---: | ---: |
| Pinned comparisons | 4 | 4 |
| Verified defects / labeled defects | 0 / 2 | 0 / 2 |
| Additional verified defects over Semgrep | 0 | 0 |
| Missed labeled defects | 2 | 2 |
| Misses on partial scans | 2 | 2 |
| False findings / emitted findings | 0 / 0 | 0 / 0 |
| Clean comparisons flagged / clean comparisons | 0 / 2 | 0 / 2 |
| Partial scans / comparisons | 2 / 4 | 2 / 4 |
| End-to-end p50 | 1,035 ms | 1,035 ms |
| End-to-end p95 | 1,139 ms | 1,164 ms |

To reproduce the verified detection rate, divide zero matching findings by the two labeled defects. The result is 0% on this corpus for both configurations. Both partial scans remain in that denominator because they are still review attempts. The Ky introduction skipped a package manifest and a test. The MCP introduction skipped a test at the 800-changed-line limit. The labeled source files appeared in the analyzed-file lists. Both clean comparisons had complete coverage within the configured scope. [Raw coverage and timings](../benchmarks/10-historical/raw.json) · [Score by case and configuration](../benchmarks/10-historical/score.json)

The latency percentiles use the second and fourth values after sorting the four times in each configuration. Each comparison ran once per configuration on one Apple M5 machine. With zero findings, precision is undefined. The pilot measures these two historical failure shapes and their two fixes. The historical positives concern a browser API compatibility failure and a JSON parsing error. The exact return-to-throw pattern is demonstrated separately. [Feature 09 test](../../tests/cross-file.unit.test.ts)

### Reproduce locally

Start the [local PostgreSQL and Redis services](../../README.md) and have the pinned Semgrep image available through `pnpm analysis:scanner:pull`. Then run:

```sh
pnpm build
pnpm benchmark:historical run output/10-replay
pnpm benchmark:historical score output/10-replay
```

The first benchmark command fetches the public Git commits and performs eight worker runs. Choose a fresh output directory each time. Expect a `raw.json` with four samples per configuration and a `score.json` with the counts and timings. The second command recomputes the score from the saved observations and checks the corpus and configuration identities. A future emitted finding needs an exact source citation and a reasoned reviewer decision before it contributes to verified detections. The focused test checks agreement on the same inputs, duplicate findings, rejected findings and partial-run scoring. [Scoring logic](../../apps/worker/src/historical-evaluation.ts) · [Scoring tests](../../tests/historical.unit.test.ts)

The published folder contains eight measured runs. The scoring command reproduced the published totals from those runs, and the two historical benchmark unit tests passed. [Recorded runs](../benchmarks/10-historical/raw.json) · [Scoring tests](../../tests/historical.unit.test.ts)
