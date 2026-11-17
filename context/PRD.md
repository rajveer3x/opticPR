# OpticPR product requirements

**Operating scope — November 18, 2026:** This is a local-only CV/portfolio project. Public hosting is disabled at the user’s request. Keep services on loopback; do not start public tunnels, expose the Mac, or provision hosting unless the user explicitly requests hosting again. Recorded demos, local benchmarks and recovery evidence are the portfolio deliverables.

A maintainer opens a PR for the second time. Which findings still need attention after the author’s latest push? OpticPR should answer in the existing GitHub conversation, then let the maintainer inspect the evidence for either revision.

## First release

Support selected GitHub repositories and JavaScript or TypeScript changes. A contributor receives a short SHA-labeled review and verified inline findings. A maintainer can inspect coverage, compare runs, retry an incomplete review and dismiss a finding with a recorded reason. An installation grants the app access only to selected repositories. Each dashboard user also needs current repository access.

## What counts as success

- A pagination change drops the final item. A pinned fixture rule produces a reproducible finding. Its citation opens the reviewed source at the exact revision.
- After a line move, the same finding shows its new location. After a fully covered deterministic recheck, the fixed finding retains its prior evidence. An incomplete recheck remains visible as needing verification.
- A model outage preserves rule findings. A delayed worker cannot replace a newer review. A redelivered event leaves one current summary.
- Evaluate model utility on held-out PRs and publish counts, latency and limitations. CV claims use the measured values.

## Scope after release

Consider Qdrant if cross-file context gaps persist after the Tree-sitter experiment. Reviewer ranking, risk prediction, repository chat and other Git hosts belong to later decisions. The detailed product rationale is in the [revision 3 design](../OpticPR_Project_Design_and_Rebuild_Plan.docx).
