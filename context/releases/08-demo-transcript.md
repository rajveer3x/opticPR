# Three-minute recovery demo

Recorded playback of the measured [recovery trace](08-recovery.json), rather than a live GitHub recording. PostgreSQL dump/restore, queues, workers and Semgrep were real; the model outage and GitHub service were controlled.

- 0:00 — Static evidence survives a model outage. The worker commits the Semgrep checkpoint before inference. A deliberately failing model leaves the pagination alert and its exact Git citation in the published summary.
- 0:40 — Restore the database; recover unfinished work. A real pg_dump is restored into a fresh database. The prior report and a running review survive. The dispatcher rebuilds the missing Redis job using the same durable run ID.
- 1:15 — A fix push wins over the late worker. Pause the older comparison, finish the fix on a second BullMQ worker, then release the old worker. The latestRunId pointer and single visible summary still select the fix.
- 2:05 — Redelivery leaves one summary. Send the same signed delivery twice and reconcile publication. The stored remote comment ID is unchanged: one visible summary, one remote create.
- 2:35 — Incomplete scans retain prior evidence. A scanner omitting the affected file yields partial coverage and needs verification. It clears zero prior findings. GitHub comment IDs in this recovery drill are mocked; no live remote race is claimed.
