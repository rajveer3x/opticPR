# Historical benchmark label review

**Status: Pending independent review.** The labels state which behavior each upstream change broke or restored and where a reviewer could point to the evidence. A reviewer who did not select or label these cases should fill in this sheet. The review checks the benchmark's labels. It leaves the recorded scanner runs available for comparison.

Start from the pinned earlier and later Git revisions in each comparison. Decide what changed, whether it introduced the reported regression, and which file and lines support your conclusion. For the introducing changes, check the upstream discussion and later fix. Record your own judgment before opening the sealed labels or scanner results. Then compare your notes with the recorded labels and note any disagreements.

| Case | Comparison and upstream evidence | Reviewer judgment and source lines |
| --- | --- | --- |
| Ky introducing change | [Pinned comparison](https://github.com/sindresorhus/ky/compare/b49cd03d8673ea522a29bae4ef6b4672cf23201b...e48386e70144bfb7ccd2264ab5760b154048cf48) · [Reported behavior](https://github.com/sindresorhus/ky/issues/688) · [Later fix](https://github.com/sindresorhus/ky/pull/711) | Pending |
| Ky fix | [Pinned comparison](https://github.com/sindresorhus/ky/compare/3207ecc30677fea718b8206a1bd9d3ea152a9975...24eec6fef2db724153915a1f80098216fe7571a8) · [Merged change](https://github.com/sindresorhus/ky/pull/711) | Pending |
| MCP TypeScript SDK introducing change | [Pinned comparison](https://github.com/modelcontextprotocol/typescript-sdk/compare/b59a2bde7d134f1c5b834fe33df71e45e54c1ba5...3c50d07e9f390751df4f6da87fde369074c41e6c) · [Later fix and regression test](https://github.com/modelcontextprotocol/typescript-sdk/pull/1184) | Pending |
| MCP TypeScript SDK fix | [Pinned comparison](https://github.com/modelcontextprotocol/typescript-sdk/compare/b9538a222a6042188e52fc92b54becd304c15d57...9203091219db5e90e5f66a3e1492706a15feab39) · [Merged change](https://github.com/modelcontextprotocol/typescript-sdk/pull/1184) | Pending |

Record the reviewer name and review date here. For each disagreement, record the affected case, both interpretations, and the agreed resolution. If a label changes, preserve this measured version and run a newly sealed corpus so each set of results stays tied to the labels it used. [Recorded labels](../../../fixtures/historical/cases.json) · [Corpus seal](../../../fixtures/historical/seal.json) · [Benchmark walkthrough](../../feature-specs/10-real-regression-benchmark.md)
