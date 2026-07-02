# OpticPR

OpticPR is an intelligent, self-hosted GitHub Pull Request review agent. It leverages local Large Language Models (LLMs) via Ollama, background job processing with BullMQ, and static analysis to automatically review pull requests, identify security vulnerabilities, and summarize changes—all without sending your proprietary code to third-party cloud APIs.

**Current Project Status**: ✅ Phase 1 MVP Completed

---

## 2. Architecture Overview

OpticPR is built as a modular monorepo containing three main components:
1. **Frontend (`apps/web`)**: A React/Vite dashboard to view PR reviews and security findings.
2. **Backend API (`apps/api`)**: An Express.js server that receives GitHub Webhooks and serves the frontend.
3. **AI Service (`apps/ai`)**: A package containing the LLM orchestration logic.

### Request Flow
```mermaid
sequenceDiagram
    participant GitHub
    participant Webhook Receiver (API)
    participant Redis (BullMQ)
    participant Worker (API)
    participant AI Agents (AI)
    participant Ollama (LLM)
    participant PostgreSQL
    participant Frontend

    GitHub->>Webhook Receiver (API): Webhook POST (PR Opened)
    Webhook Receiver (API)->>Webhook Receiver (API): Validate HMAC Signature
    Webhook Receiver (API)->>Redis (BullMQ): Enqueue PR Review Job
    Webhook Receiver (API)-->>GitHub: 202 Accepted
    Redis (BullMQ)->>Worker (API): Dequeue Job
    Worker (API)->>AI Agents (AI): Execute Review Pipeline
    AI Agents (AI)->>Ollama (LLM): Generate Summary & Review
    Ollama (LLM)-->>AI Agents (AI): LLM Output
    AI Agents (AI)->>PostgreSQL: Save Review Findings
    AI Agents (AI)->>GitHub: Post Review Comment
    Frontend->>PostgreSQL: Fetch PR Data
```

---

## 3. Technology Stack

| Framework/Library | Version | Purpose | Why it was chosen |
| :--- | :--- | :--- | :--- |
| **Node.js** | `>=22.0.0` | Runtime environment | Industry standard for backend TS, great async I/O. |
| **pnpm** | `^10.0.0` | Package Manager | Fast, efficient monorepo workspace management. |
| **Express** | `^5.1.0` | Web Framework | Lightweight, battle-tested for webhook ingestion and APIs. |
| **React** | `^18.3.1` | Frontend Library | Component-based, massive ecosystem, easy state management. |
| **Vite** | `^6.3.5` | Frontend Bundler | Extremely fast HMR and build times compared to Webpack. |
| **Tailwind CSS** | `^3.4.17` | Styling | Utility-first, perfect for rapid UI development and glassmorphism. |
| **BullMQ** | `^5.56.0` | Job Queue | Native Redis-backed queues, retries, and concurrency control. |
| **Redis** | `7` | Message Broker | In-memory store required for BullMQ state management. |
| **PostgreSQL** | `16` | Primary Database | ACID compliant, reliable relational data storage. |
| **Prisma** | `^6.19.0` | ORM | Type-safe database queries and easy migrations. |
| **Ollama** | `^0.5.16` | Local LLM Runner | Run models locally to preserve code privacy. |
| **Zod** | `^3.25.67` | Schema Validation | Type-safe runtime parsing for API payloads and LLM outputs. |
| **Octokit** | `^22.0.0` | GitHub API Client | Official client for GitHub App authentication and operations. |

---

## 4. Folder Structure

```text
opticpr/
├── apps/
│   ├── ai/                 # AI service package
│   │   ├── src/
│   │   │   ├── agents/     # CodeReview, Security, and Summary agents
│   │   │   └── ollama/     # Local LLM client configuration
│   │   └── package.json
│   ├── api/                # Express backend and BullMQ workers
│   │   ├── prisma/         # Database schema and migrations
│   │   ├── src/
│   │   │   ├── middleware/ # CORS, GitHub HMAC verification
│   │   │   ├── queues/     # BullMQ queue definitions
│   │   │   ├── routes/     # Webhook and API endpoints
│   │   │   └── workers/    # Background job processors
│   │   └── package.json
│   └── web/                # React dashboard frontend
│       ├── src/
│       │   ├── components/ # Reusable UI components
│       │   ├── layouts/    # App shell and navigation
│       │   ├── pages/      # Route pages (PR List, Detail)
│       │   └── store/      # RTK Query API store
│       └── package.json
├── docker-compose.yml      # Infrastructure (Postgres, Redis, Qdrant)
├── pnpm-workspace.yaml     # Monorepo configuration
└── package.json            # Root workspace configuration
```

---

## 5. Prerequisites

Before running the project, ensure you have the following installed:
* Node.js `>=22.0.0`
* pnpm `>=10.0.0`
* Docker & Docker Compose
* Git
* Ollama (running locally on port `11434`)
* A GitHub App (configured with webhooks)
* ngrok (for local webhook testing)

---

## 6. Installation Guide

1. **Clone the repository:**
   ```bash
   git clone https://github.com/your-org/opticpr.git
   cd opticpr
   ```

2. **Install dependencies:**
   ```bash
   pnpm install
   ```

3. **Configure Environment Variables:**
   ```bash
   cp .env.example .env
   # Edit .env with your specific GitHub App credentials and local secrets
   ```

4. **Pull the Ollama Model:**
   ```bash
   ollama pull qwen2.5-coder:7b
   ```

5. **Start Infrastructure Services:**
   ```bash
   docker-compose up -d
   ```

6. **Initialize the Database:**
   ```bash
   pnpm --filter @opticpr/api run prisma:migrate
   ```

---

## 7. Environment Variables

| Variable Name | Description | Required | Example |
| :--- | :--- | :--- | :--- |
| `POSTGRES_USER` | Database username | Yes | `opticpr` |
| `POSTGRES_PASSWORD` | Database password | Yes | `secure_password` |
| `POSTGRES_DB` | Database name | Yes | `opticpr` |
| `DATABASE_URL` | Prisma connection string | Yes | `postgresql://...` |
| `REDIS_HOST` | Redis host | Yes | `127.0.0.1` |
| `REDIS_PORT` | Redis port | Yes | `6379` |
| `REDIS_PASSWORD` | Redis authentication | Yes | `secure_redis_pass` |
| `GITHUB_WEBHOOK_SECRET`| HMAC secret for webhook validation| Yes | `my-secret-key` |
| `GITHUB_APP_ID` | Your GitHub App ID | Yes | `4140745` |
| `GITHUB_INSTALLATION_ID`| Target repo installation ID | Yes | `142499152` |
| `GITHUB_OAUTH_CLIENT_ID`| For frontend authentication | Yes | `Iv23...` |
| `GITHUB_OAUTH_CLIENT_SECRET`| OAuth secret | Yes | `304f...` |
| `GITHUB_PRIVATE_KEY` | App private key (PEM format) | Yes | `-----BEGIN PRIVATE KEY...` |
| `JWT_SECRET` | Secret for frontend auth tokens | Yes | `local-jwt-secret` |
| `OLLAMA_HOST` | Local LLM URL | No | `http://127.0.0.1:11434` |
| `VITE_API_BASE_URL` | API URL for frontend | No | `http://localhost:3000/api/v1` |

---

## 8. How to Start the Project

Execute these commands from the root of the project in separate terminal windows.

1. **Start Infrastructure:**
   ```bash
   docker-compose up -d
   ```
2. **Start the Express API:**
   ```bash
   pnpm --filter @opticpr/api run dev
   ```
3. **Start the BullMQ Worker:**
   ```bash
   pnpm --filter @opticpr/api run worker
   ```
4. **Start the React Frontend:**
   ```bash
   pnpm --filter @opticpr/web run dev
   ```
5. **Start ngrok (for Webhooks):**
   ```bash
   ngrok http 3000
   ```
   *Update your GitHub App webhook URL to `<ngrok-url>/webhooks/github`*

---

## 9. Running the MVP

1. Ensure all services (API, Worker, Frontend, Docker, Ollama, ngrok) are running.
2. In your GitHub repository (where the App is installed), open a new Pull Request.
3. GitHub sends a payload to your ngrok URL.
4. Watch the API terminal: it verifies the HMAC signature and adds a job to BullMQ.
5. Watch the Worker terminal: it dequeues the job and queries Ollama.
6. The AI reviews the code.
7. Open the frontend (`http://localhost:5173`) to see the newly generated PR review, AI summary, and risk score.

---

## 10. Available Scripts

**Root Workspace (`package.json`)**
* `pnpm run build`: Builds all packages.
* `pnpm run lint`: Runs ESLint across the monorepo.
* `pnpm run format`: Formats code with Prettier.
* `pnpm run typecheck`: Runs TS type-checking across all apps.

**Backend (`apps/api`)**
* `pnpm run dev`: Starts Express API with watch mode.
* `pnpm run worker`: Starts the BullMQ background worker.
* `pnpm run prisma:migrate`: Runs database migrations.
* `pnpm run prisma:studio`: Opens Prisma database UI.

**Frontend (`apps/web`)**
* `pnpm run dev`: Starts Vite dev server.
* `pnpm run build`: Compiles React for production.

---

## 11. API Documentation

| Method | Route | Purpose | Authentication |
| :--- | :--- | :--- | :--- |
| `POST` | `/webhooks/github` | Ingests PR events from GitHub | HMAC Signature |
| `GET` | `/health` | API health check | None |
| `GET` | `/api/v1/pull-requests` | List PRs for the dashboard | JWT (Future) |
| `GET` | `/api/v1/pull-requests/:id`| Get details/review for a specific PR| JWT (Future) |

---

## 12. AI Pipeline

When a job is picked up by the worker, it executes through `apps/ai`:
1. **SummaryAgent**: Analyzes the raw git diff and creates a human-readable summary of the PR's intent.
2. **CodeReviewAgent**: Reviews the diff for logic errors, maintainability issues, and best practices.
3. **SecurityAgent**: Specifically scans for OWASP vulnerabilities and insecure patterns.

Execution is orchestrated asynchronously, and the combined results are saved to the database.

---

## 13. Database

Using Prisma and PostgreSQL.

* **User**: Represents a GitHub user who authored a PR or logged into the dashboard.
* **Repository**: Tracks the GitHub repositories the App is installed on.
* **PullRequest**: Stores the PR metadata, current status, AI review findings, and risk score.

Relationships: A `PullRequest` belongs to a `Repository` and an `User` (Author).

---

## 14. Security

* **GitHub Webhooks**: Validated using `GITHUB_WEBHOOK_SECRET` to compute an HMAC SHA-256 signature to prevent spoofing.
* **App Authentication**: We use a GitHub App private key to generate short-lived installation tokens, providing precise scope access without relying on static Personal Access Tokens.
* **Local AI**: By using Ollama locally, no proprietary source code is ever sent to OpenAI or Anthropic.

---

## 15. Development Workflow

1. Cut a branch from `main`: `git checkout -b feature/your-feature`.
2. Ensure you have the `.env` setup and Docker running.
3. Run `pnpm run typecheck` and `pnpm run lint` before committing.
4. Open a PR. The local OpticPR agent will review your OpticPR PR!
5. Merge upon approval.

---

## 16. Troubleshooting

* **Webhook validation fails (`400 Bad Request`)**: Ensure your `GITHUB_WEBHOOK_SECRET` in `.env` exactly matches the secret configured in the GitHub App dashboard.
* **Worker crashes fetching diffs**: Check if your `GITHUB_PRIVATE_KEY` is formatted correctly with `\n` newlines in the `.env` file.
* **Ollama Connection Refused**: Ensure Ollama is running (`ollama serve`) and the model is pulled (`ollama pull qwen2.5-coder:7b`).
* **Prisma Connection Error**: Ensure Docker is running and execute `docker-compose up -d postgres`.
* **Jobs not processing**: Ensure the worker is running in a separate terminal (`pnpm --filter @opticpr/api run worker`).

---

## 17. Roadmap

* ✅ Phase 0: Monorepo setup, Database, and GitHub Webhooks
* ✅ Phase 1 MVP: Basic AI Code Review Pipeline & Dashboard UI

**Upcoming:**
* Repository-aware RAG
* Tree-Sitter indexing
* Qdrant retrieval
* Reviewer recommendations
* Risk prediction
* Repository chat

---

## 18. Future Improvements

* Implement WebSocket connections for live UI updates when BullMQ jobs complete.
* Move from local Ollama to a scalable multi-GPU cluster for production.
* Add comprehensive end-to-end testing with Playwright.

---

## 19. License

MIT License. See `LICENSE` for more information.

---

## 20. Contributing

Contributions are welcome! Please read `CONTRIBUTING.md` (coming soon) for details on our code of conduct, and the process for submitting pull requests to us.
