# 09 Cross-file TypeScript regression detection

**Implemented.** [Local analysis](04-local-analysis.md) and [finding history](05-finding-history.md) share a rule that gives the same result on the same reviewed source. A function used to return `undefined` for a missing record. The change makes it throw for that same condition. An unchanged caller still expects to handle the missing value. TypeScript permits both implementations, but the exception bypasses the caller’s fallback.

## Build

Start with an exported synchronous function, an identifiable missing-value branch, and direct callers in local TypeScript modules. Compare the function at the base and head revisions. Use the TypeScript compiler API to resolve direct imports, including renamed imports, to the same declaration. Read unchanged callers from the reviewed Git snapshot within explicit analysis limits. Perform static analysis without executing repository code or loading its plugins.

On the review dashboard, cite the changed throw as primary evidence and the unchanged caller’s fallback as supporting evidence. Bind both excerpts to the reviewed head and link the earlier return to the base revision. Only the changed line is eligible for an inline GitHub comment. Report unresolved symbols and exhausted file budgets as partial coverage.

## Acceptance checks

- Change a missing-user branch from returning `undefined` to throwing. An unchanged route calls the function and maps a missing value to HTTP 404. Assert one finding with the correct callee and caller locations, including when the route uses a renamed import.
- Include a caller that catches the new exception and maps it to 404, and an unrelated function with the same name. Verify neither is flagged.
- Restore the original return or add a handler at the caller. A complete recheck of the affected pair clears the finding. An unavailable caller or incomplete scan preserves the prior evidence as needing verification.

## Teach me after implementation

Trace the example from the base return to the new throw, through symbol resolution to the unchanged caller and its two source citations. Compare it with the handled caller. Add the walkthrough to this file and explain it to me in chat using the [project teaching instructions](../../AGENTS.md).

## Implementation walkthrough

Enter `missing` as the user ID in the trusted test example. The **base** is the earlier commit. At base line 4 of `src/users.ts`, `findUser` returns `undefined`, JavaScript's missing-value result. The route checks the result and returns HTTP 404. The **head** is the reviewed commit. Its copy of line 4 throws an error, so the route never reaches its 404 fallback. The companion route wraps the lookup in `try`/`catch` and returns 404 from the handler. The test executes these three paths on the synthetic example and observes 404, the thrown error, and 404. [Example sources](../../tests/cross-file-fixture.ts) · [Behavior and detector assertions](../../tests/cross-file.unit.test.ts)

`scanCrossFileRegression` compares the body up to the missing-value condition in both commits. It reads candidate callers from the head's Git tree, the list of files stored in that commit. The TypeScript compiler connects the route's renamed import, `getUser`, to the declaration of `findUser`. The rule uses that declaration to distinguish the real caller from the unrelated import with the same function name. The compiler sees only the retrieved source files in memory. The worker reads repository code as text. [Rule and revision reads](../../apps/worker/src/cross-file-regression.ts) · [Compiler symbol and fallback checks](../../apps/worker/src/cross-file-syntax.ts)

The reviewer gets one finding and three selectable citations. **Changed throw** shows `src/users.ts:4` at the head. **Caller fallback** shows the unchanged call and 404 branch at `src/route.ts:3–4`, also at the head. **Previous return** opens `src/users.ts:4` at the base. Each link contains the exact Git commit ID. The worker created one eligible inline comment intent at the changed throw. The other citations are review context. [Dashboard evidence](../../apps/web/src/review.tsx) · [Inline anchor validation](../../apps/worker/src/inline-comments.ts) · [Live dashboard test](../../tests/dashboard.integration.test.ts)

The rule checks named, exported synchronous function declarations with a recognizable top-level missing-value guard. It follows direct relative TypeScript imports and checks an immediate conditional return after the call, including when the route first assigns the result to a constant. It recognizes a catch that directly returns the fallback. Broader control flow and repository-specific module mappings fall outside this rule's scope. If a local import or symbol fails to resolve, a required source is unavailable, or more than 40 head TypeScript files are eligible for the caller scan, the coverage panel shows **Partial**. History requires both files and a complete equivalent TypeScript recheck before clearing the finding. The history test observed **Needs verification** for both an unavailable caller and an exhausted budget, then **Cleared by recheck** after restoring the return or adding the handler. The original excerpts stayed available. [History matching](../../apps/worker/src/finding-history.ts) · [Recheck test](../../tests/analysis.integration.test.ts)

### Reproduce locally

Run `pnpm build` to compile the worker and dashboard, then `pnpm exec vitest run tests/cross-file.unit.test.ts` to check the missing-user behavior, symbol matching and excerpt locations. Expect one finding and an inline anchor at `src/users.ts:4`.

With the project's [local services](../../README.md), pinned Semgrep image and Playwright Chromium installed, run:

```sh
OPTICPR_TEST_LIVE_BROWSER=1 pnpm test:dashboard -t 'worker-generated cross-file evidence'
```

The integration test creates two local Git commits, lets the queue and worker store a real report in PostgreSQL, then opens that run in Chromium through the authenticated API. It verifies the code and URL in all three citations and saves `output/09-live-dashboard.png`. The GitHub transport and sign-in use test doubles, and the test inspects the stored comment intent locally. [Browser and API assertions](../../tests/dashboard.integration.test.ts)

The frozen-lockfile install, build, typecheck, 80 unit tests, 63 integration tests, 15 browser tests, and compiled CLI/API smoke test passed locally. The smoke test also observed the expected readiness error during a PostgreSQL outage and restored the service. [Test commands](../../package.json)
