# 04 Local analysis and function context

**Requires:** [Current review publication](03-current-review.md). **Outcome:** a reviewer can inspect a static finding even when local inference fails.

**Build.** Scan supported JS/TS on a read-only snapshot using pinned Semgrep rules. Upsert each observation by run and fingerprint and commit the completed static checkpoint before the first model call. Exclude generated code, secrets, binaries, dependencies and lockfiles. Start with 20 files, 800 changed lines and a 90-second model deadline per run. Record skipped files and partial coverage.

Map hunks to their enclosing function or method using Tree-sitter. Supply exact source with SHA, path and lines. Fall back to a bounded hunk if parsing fails or the function exceeds budget. Keep a diff-only mode for the benchmark. Pass a schema through Ollama’s format parameter, validate with Zod and independently verify each changed head-side anchor and excerpt. Persist enrichment separately.

**Acceptance checks**

- Inject malformed JSON and a timeout in separate runs. Inspect the database before invocation, then inspect the partial published report. The same static alert survives and retry leaves one copy.
- Give a schema-valid candidate the wrong excerpt. Reject the candidate and count the rejection.
- Queue two reviews with retries. Instrument the inference client and verify peak active requests equals one across all stages on the local host.
- Compare 4096 and 8192 context tokens on the demo machine. Record memory use, latency and quality. Run the diff-only and function-context modes on the same fixture.
