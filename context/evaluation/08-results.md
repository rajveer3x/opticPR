# Feature 08 evaluation — November 18, 2026 (IST)

Model enrichment remains **opt-in**. Neither model arm added a verified defect to Semgrep. The system emitted one true finding out of seventeen labeled defects in the held-out split. High measured precision here reflects a single emitted finding and does not establish useful broad review quality.

| Arm | PRs | Matched | Missed | False findings | Precision | Recall | Clean PRs flagged | Valid citation records | False clearances | End-to-end p50 | p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Semgrep | 20 | 1 | 16 | 0 | 100% | 5.9% | 0/8 | 2/2 | 0 | 1.441 s | 2.516 s |
| Semgrep + diff-only Ollama | 20 | 1 | 16 | 0 | 100% | 5.9% | 0/8 | 3/3 | 0 | 2.985 s | 26.294 s |
| Semgrep + Tree-sitter context + Ollama | 20 | 1 | 16 | 0 | 100% | 5.9% | 0/8 | 3/3 | 0 | 11.302 s | 28.821 s |

The one match in each arm is `page-05-d1`, the decremented exclusive slice boundary. Each model arm successfully enriched that static observation once, but emitted no accepted novel model finding. Diff-only rejected eleven candidates and function context rejected fourteen for evidence validation; eight and eleven respective reports were partial. No model transport/schema failures occurred in this run. Rejected proposals are recorded separately from emitted false findings, so zero emitted false findings does not mean every model proposal was correct. No novel accepted model alerts required adjudication.

All three finding anchors are exact, and every associated citation record is valid. The citation-record count includes each primary evidence record and its static/model source citations; these are not independent findings. The evaluation reports zero unsafe clearances; the separate [recovery drill](../releases/08-recovery.json) additionally exercised an affected file omitted by a scanner and retained its finding as `needs_verification`, with zero clearances in that injected incomplete scan.

## Reproduction and labels

The [sealed corpus](../../fixtures/evaluation/cases.json) has thirty TypeScript PRs: twelve single-defect, six multi-defect and twelve clean changes across pagination, parsing and state updates. Every PR has real deterministic Git base/head commits in the [bundle](../../fixtures/evaluation/repository.bundle), an exact [manifest](../../fixtures/evaluation/manifest.json), expected behavior, acceptable head evidence ranges and confirming checks. Tests execute only these trusted synthetic checks, verifying base success, head failures for each labeled defect, and unchanged expectations for clean changes. The worker/evaluator never executes reviewed code.

The [seal](../../fixtures/evaluation/seal.json) reserves ten tuning cases and twenty held-out cases, including seven single-defect, five multi-defect and eight clean PRs (seventeen defects). Related base/head revisions share one group; no alternate revision crosses the split. This dataset was reserved during feature 08, **after** the pre-existing `review-v1` prompt had already been developed for feature 04. It is not a retroactive claim that reservation preceded the project's initial prompt development. No prompt or rule tuning used these thirty cases, and no prompt changes occurred between the two recorded evaluation executions.

Labeler: **Codex, synthetic author and first labeler**. Independent human labeling: **not performed**. Disputes: **none recorded; no independent dispute resolution performed**. These synthetic, small-function tasks are not representative production PRs. The acceptable ranges and executable checks make the labels inspectable, but shared authorship can bias both task construction and labels.

Run `pnpm build`, ensure local PostgreSQL/Redis and the pinned scanner/model are available, then:

```sh
pnpm evaluation run context/evaluation/new-fixed-run evaluation
pnpm evaluation score context/evaluation/new-fixed-run
```

The CLI refuses to overwrite an output directory and checks hashes of the labels, manifest and Git bundle. The scorer checks exact input/configuration/run identity, equal model-arm instructions/budgets, complete arm membership and reasoned adjudications. It matches each defect at most once; duplicate alerts count as false findings. A valid anchor alone cannot establish a model-only true positive. Unknown model judgments block precision and default enablement. Runtime enablement remains an explicit setting, even if a future experiment meets the proposed gate.

## Hardware, configuration and timing

The [primary raw reports and model responses](08-held-out/raw.json) and [scored counts/matches/misses](08-held-out/score.json) are the released measurements. The machine was an Apple M5, ten CPU cores, 16 GiB RAM, arm64 macOS; Node 26.5.0. The raw file records the local Ollama version, exact model digest and all per-arm configuration values. Both model arms used `qwen2.5-coder:7b` at `sha256:dae161e27b0e90dd1856c8bb3209201fd6736d8eb66298e75ed87571486f4364`, `review-v1`, 4096 context tokens, a 1024-token output budget, seed zero, temperature zero and the same 90-second deadline. Only context mode differs between model arms. Semgrep 1.144.0, the three pinned `local-js-ts-v1` rules, and pinned WASM grammars were unchanged.

One sequential sample per case/arm used the normal queue, concurrency-one worker, real Git reads, pinned scanner container, static checkpoint and durable report/history finalization. Cases ran in sealed order, with static, diff-only, then function context. End-to-end timing starts before scheduling and ends after polling the durable completed report. It includes queue/DB polling, clone/snapshot work, scanning, context, inference where enabled and persistence; it excludes webhook reception, GitHub publication and label checking. Percentiles use nearest rank across twenty samples per arm. They are not inference-only timings or a controlled hardware benchmark.

The first diff-only inference found the model absent from `/api/ps`; the other thirty-nine model calls found it resident. There was no explicit OS/cache reset or warm-up. Residency denotes loaded/unloaded state, not fully controlled cold hardware. During the primary run, a browser recorded the evidence demo and isolated static deployment smoke attempts used the same machine; there were **no concurrent acceptance-suite dependency restarts**. Treat latency differences as observations on this shared development machine, not statistically established speed comparisons.

An earlier full execution is retained as [contended raw data](08-contended/raw.json) and [scores](08-contended/score.json). It overlapped integration tests, their shared model-host lock, and a deliberate Redis restart. Its latency is excluded from the primary table. The primary rerun kept the exact sealed cases, prompt, model and configuration; it was not selected for a better quality score. Both executions produced the same matched/missed/false counts and no novel verified model finding.

## Gate and portfolio claim

The proposed default-enable gate requires at least one additional verified true finding and combined precision of at least 80%, complete held-out baseline/model results, valid evidence and zero unsafe clearances. Both arms meet the precision threshold on one emitted finding but fail the additional-finding requirement. `MODEL_ENRICHMENT_ENABLED=0` is therefore the documented default; use `1` only for explicit experimentation. No prompt change was made in response to the held-out results. Further development should use a new tuning/evaluation reservation and independent labels before claiming improved utility.

Evidence-backed CV bullet:

> Built a SHA-bound PR review pipeline with PostgreSQL/BullMQ, Semgrep and local Ollama; published a 60-run comparison on 20 synthetic held-out PRs and verified database restoration, stale-worker fencing and single-summary replay in automated recovery drills.

This does not claim a production deployment, independent labeling, improved model recall, or live GitHub race verification. The [runbook](../releases/08-runbook.md), [three-minute evidence playback](../releases/08-demo.webm), [actual recovery IDs](../releases/08-recovery.json) and [HTTPS/live-source smoke](../releases/08-deployment.json) state their respective limits.

The temporary HTTPS smoke environment has since been retired at the user’s request. This project is maintained locally for CV/portfolio demonstration; the deployment JSON is historical evidence, not an active hosting claim.
