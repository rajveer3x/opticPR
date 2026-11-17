# 08 Evaluation and portfolio release

**Requires:** [Implementation milestones 1–7](../context/IMPLEMENTATION_PLAN.md) for final measurement. Reserve the dataset split before prompt tuning. **Outcome:** a reviewer can reproduce a quality comparison and a recovery demo on synthetic code.

**Experiment.** Prepare 30 labeled TypeScript PRs covering pagination, parsing and state updates. Include 12 single-defect, six multi-defect and 12 clean changes. Record expected behavior, acceptable evidence ranges and confirming tests. Use ten cases for tuning and seal twenty for evaluation. Keep related revisions together. Compare Semgrep alone, Semgrep with diff-only Ollama and Semgrep with Tree-sitter context plus Ollama. Fix the model digest, prompt instructions and token budget across model arms.

**Acceptance checks**

- Publish raw matched, missed and false-finding counts, precision, recall, clean PRs flagged, exact-anchor validity, false clearances, and end-to-end p50/p95. Record labeler, disputes, hardware, configuration and warm/cold conditions. Target all fixture citations valid and zero false clearances on incomplete scans.
- Default-enable model enrichment only if it adds a verified true finding and combined precision meets the proposed 80% floor. Publish measured outcomes even if the model remains opt-in.
- Restore a backup, reconcile unfinished work, deploy pinned images behind HTTPS and smoke-test one fixture plus one live PR. Document deletion of temporary snapshots, the proposed 30-day report retention and uninstall cleanup.
- Record a three-minute demo showing a static alert surviving a model failure, a fix push winning over a late worker and a redelivery preserving one summary. Retain the run IDs, revision pairs, pointer and remote comment ID. Build the CV bullet from the released evidence.
