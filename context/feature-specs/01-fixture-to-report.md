# 01 Fixture to stored report

**Outcome.** From a fresh checkout, replay a synthetic pagination PR and inspect a stored run with a known base and head. This is the first vertical slice. It uses local data and needs no GitHub or model credentials.

**Build.** Set up the pnpm workspace, Compose PostgreSQL and Redis, migrations and shared schemas. Define a repository adapter that supplies revision metadata, changed hunks and file content by SHA. Give the fixture two commits and a known boundary condition. A deterministic analysis stub feeds the worker’s report writer. Label its source as a fixture. Document the actual setup, migrate, replay and inspect commands once they exist.

**Acceptance checks**

- Boot with empty volumes, migrate and replay. Read the stored report by run ID and verify both SHAs, stage provenance and coverage.
- Replay the same input and configuration twice. The logical run key resolves to one run.
- In clean CI, use the frozen lockfile, build compiled shared packages in dependency order, then type-check API and worker. Verify success without restored dist output.
- Stop PostgreSQL. Readiness identifies the failed dependency and replay cannot report success.
