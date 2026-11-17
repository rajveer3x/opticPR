# Backend contracts

## Ownership and consistency

A repository belongs to an installation. A PR belongs to a repository and owns the desired run key, current target SHAs, latestRunId and persistent GitHub comment ID. A ReviewRun owns its report, exact inputs, configuration digest and stage coverage. A stable PR-scoped finding links per-run observations. Each observation owns its source, revision, path, lines and excerpt. Append reviewer decisions with actor, reason and time.

Use a unique delivery ID for ingress and a deterministic key derived from repo ID, PR number, baseSha, headSha and analysis configuration digest for queue jobs and runs. Record verified receipt and outbox intent together. Recover unsent work and expired worker leases from PostgreSQL.

Commit Semgrep matches and scan completion together before invoking Ollama. Finalize the report, conditionally advance latestRunId and create publication intent in one Prisma transaction. Guard the pointer write against the desired key. A stale result remains in history. The dashboard reads the summary through the pointer.

Serialize GitHub publication per PR. Read live revisions before database promotion and again before each remote write. Recheck after a write and reconcile any intervening update. Persist remote IDs and app-owned markers to recover from an ambiguous response.

## Access and HTTP

| Operation | Authority | Result |
| --- | --- | --- |
| POST /webhooks/github | Valid HMAC on raw bytes | Durable receipt or confirmed duplicate |
| GET /api/repos | Signed-in user | Accessible installed repositories |
| GET /api/repos/:id/prs | Repo member | Paginated PRs and latest reviewed revision |
| GET /api/runs/:id | Repo member | Coverage, findings, prior run and stage outcomes |
| POST /api/runs/:id/retry | Maintainer | Audited attempt on the same configuration |
| POST /api/findings/:id/decisions | Maintainer | Validated dismiss or reopen decision |

Verify OAuth state. Use HttpOnly, Secure, SameSite session cookies, CSRF protection on mutations and short-lived installation tokens. Resolve child IDs back to their repository before authorization. Logs include run IDs and durations. Keep credentials and raw diffs out of logs.
