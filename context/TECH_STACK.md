# Technology choices

| Layer | Tools | Implementation constraint |
| --- | --- | --- |
| Workspace | Git, pnpm workspaces, Node.js LTS, TypeScript | Pin tested versions and commit the lockfile. Build compiled workspace dependencies before consumer type checks. |
| API and contracts | Express, Octokit, Zod | Share schemas from packages/contracts. Verify signed raw webhook bodies before parsing. |
| System of record | PostgreSQL, Prisma | Keep durable receipts, runs, findings, decisions and publication intent across queue restarts. |
| Background work | Redis, BullMQ | Start the local worker at concurrency one. Queue references to durable records. |
| Analysis | Semgrep CLI, Tree-sitter JS/TS grammars, local Ollama with qwen2.5-coder:7b | Pin rules, grammar, prompt and model revisions. Share one active inference slot per model host, including retries. Benchmark 4096 and 8192 context tokens on the demo machine. |
| Dashboard | React, Vite, React Router, RTK Query, Tailwind CSS | Poll active reviews and stop on terminal states. |
| Operations and tests | Docker Compose, GitHub Actions, Vitest, Playwright, Pino | Stub model output in CI. Exercise real PostgreSQL and Redis for integration cases. Benchmark the real model before release. |

## Runtime layout

Place HTTP and sessions in apps/api, analysis and publication in apps/worker, the browser application in apps/web and shared event/report schemas in packages/contracts. A credential-free fixture adapter and the GitHub adapter feed the same worker contract.

Keep database, Redis and inference endpoints private. Use environment configuration for service URLs, session and webhook secrets, and GitHub App credentials. Bind the scanner to read-only synthetic or authorized source with bounded resources and no network. Never execute scripts from a reviewed PR.
