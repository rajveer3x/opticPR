# 02 GitHub intake

**Requires:** [Fixture to stored report](01-fixture-to-report.md). **Outcome:** a signed live event reaches the same worker contract as the fixture.

**Build.** Verify HMAC-SHA256 against the raw body. Handle opened, reopened, synchronize and ready_for_review on eligible PRs. On edited, inspect a base-branch change. Skip closed and draft PRs. Atomically record the delivery and outbox entry before acknowledging. A dispatcher resolves the current GitHub revisions and sends a stable job ID to BullMQ. Scope every fetch to the selected installation and repository.

**Acceptance checks**

- Send an invalid signature. No receipt or queued work is created. On durable storage failure return an error so the delivery can be redelivered.
- Deliver an eligible event ten times with the same delivery ID. Expect one durable receipt and one logical run. Measure local acknowledgment p95 against the proposed one-second target.
- Retarget to a base with a different SHA while the head remains fixed. An edited event produces a new key and diff. A title-only edit does not schedule a new comparison.
- Restart Redis between receipt and dispatch. Reconciliation recovers the run. On repository removal, cancel outstanding work and revoke access.
