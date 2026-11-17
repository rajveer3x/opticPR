# Dashboard guidelines

| View | Primary decision | Required information |
| --- | --- | --- |
| Connected repositories | Which repository can I review? | Installation scope, last event, publish capability and empty/access-lost states. |
| Repository pull requests | Which review needs attention? | PR number, title, target vs. reviewed revision, run state and link to history. Paginate results. |
| Run detail | Is this finding actionable on this revision? | Revision selector, stage outcomes, coverage, changed hunk with head line, source, impact, verification, decision history and prior observation. |

Lead the run detail with the reviewed base/head pair. Put the finding’s source excerpt next to its claim. Keep a previous revision’s citation bound to that revision when a reviewer switches commits. Group duplicate source observations under one finding with separate evidence.

Use text alongside every severity and status color. Show “Needs verification” for a missing model observation or incomplete scan. Display a maintainer’s dismissal as a separate decision. A clean result gives analyzed and skipped counts. An unavailable scan explains what failed.

Support keyboard navigation for the commit selector, evidence links, retry action and dismissal form. Show loading, empty, error, access-denied and partial-report states on the normal routes. After retry or dismissal, refresh the affected data and preserve the selected revision.
