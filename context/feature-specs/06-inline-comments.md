# 06 Verified inline comments

**Requires:** [Current review publication](03-current-review.md) and [finding history](05-finding-history.md). **Outcome:** a reviewer can open a verified finding directly on the changed line while the persistent summary collects the complete review.

**Build.** Parse the current unified diff and map validated findings onto the head-side path and line. Submit eligible anchors through the GitHub pull request review API with the reviewed head commit. Apply the same publication guard as the summary writer. Store publication intent, app-owned identifiers and confirmed remote IDs for retry reconciliation. Preserve summary evidence for findings without a current diff anchor.

**Acceptance checks**

- On a multi-hunk diff, assert the remote comment lands on the intended changed source line, including a hunk after a deletion.
- Move a line immediately before publication. Skip the stale write and reconcile the current review. A missing or rejected anchor keeps its finding in the report.
- Simulate a successful remote write followed by a timeout. Replay the delivery and verify one thread for that finding and one PR summary. A later change retains the prior revision’s evidence.

## Teach me after implementation

Map one reported line through a diff hunk to its GitHub comment. Explain how retrying a lost response preserves a single thread. Add the walkthrough to this file and explain it to me in chat using the [project teaching instructions](../../AGENTS.md).
