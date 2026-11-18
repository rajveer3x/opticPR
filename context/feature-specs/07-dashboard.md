# 07 Authenticated review dashboard

**Requires:** [Current review publication](03-current-review.md) and [finding history](05-finding-history.md). **Outcome:** a maintainer can trace a summary to its evidence and a contributor can inspect a PR they can access.

**Build.** Implement the repository list, paginated PR list and run detail from the [dashboard guidelines](../FRONTEND_GUIDELINES.md). Use the endpoints and authorization rules in the [backend contracts](../BACKEND_STRUCTURE.md). Read the latest summary through latestRunId. Keep the desired revision visible while processing. Show the selected run’s actual coverage and stage outcomes. Use a maintainer-only action for retries and reasoned dismissal or reopening.

**Acceptance checks**

- A signed-in member follows a summary to the hunk, switches revisions by keyboard and can distinguish new, still present and needs verification without color.
- A maintainer retries a partial review and dismisses a finding. Refreshing preserves the selected revision and decision history. Ordinary members cannot perform those writes.
- Test a guessed run ID from another repo, revoked installation access and a state-changing request missing CSRF protection. No unauthorized report or mutation is returned.
- A clean scan, a partial scan and an empty repository produce distinguishable screens. Polling stops after a terminal outcome.

## Teach me after implementation

Follow one evidence link from the browser through the repository access check to the saved report. Show how the selected revision survives a refresh. Add the walkthrough to this file and explain it to me in chat using the [project teaching instructions](../../AGENTS.md).
