# Application flow

1. **Connect a repository.** The maintainer installs the GitHub App on selected repos and signs in. The repo list shows only the intersection of user and installation access. An empty list explains how to select a repository.
2. **Open or update a PR.** GitHub delivers the event. The API acknowledges durable receipt, and the worker resolves the current revision pair. The dashboard displays the target and stage while the last published report stays accessible.
3. **Read the review.** The persistent conversation comment names the reviewed revision and coverage, lists up to five findings and links to the complete run. A verified changed line may also receive an inline comment.
4. **Inspect the evidence.** Open the run to see the hunk, source, impact, verification step, stage outcomes and skipped files. A maintainer can retry incomplete work or dismiss a finding with a reason.
5. **Push a fix or change the base.** Schedule the new comparison. Switch between its snapshot and the prior one. Following a rename or line move should open the citation for the selected revision.
6. **Lose access.** Repository removal or uninstall revokes grants and cancels affected work. Direct report URLs also recheck access.

## Recovery paths

A timed-out model leaves a partial report with the static results. A clean scan states what was analyzed. An unavailable or skipped scan shows unknown coverage. A delayed publish checks live revisions and reconciles the current comment. A user can follow the run ID from the report to the operator’s trace.
