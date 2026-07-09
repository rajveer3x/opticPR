import { Worker } from "bullmq";
import type { Job } from "bullmq";
import { runPullRequestReview } from "@opticpr/ai/agents/pr-review";

import { redisConnection } from "../config/redis.js";
import { prisma } from "../config/prisma.js";
import { PR_REVIEW_QUEUE_NAME } from "../queues/names.js";
import type { PullRequestOpenedPayload } from "../queues/pr-review.js";
import { fetchPullRequestDiff, publishGitHubReview } from "../services/githubReviewService.js";

async function processPrReviewJob(job: Job<PullRequestOpenedPayload>): Promise<void> {
  const owner = job.data.repository.owner.login;
  const repo = job.data.repository.name;
  const pullNumber = job.data.pull_request.number;

  process.stdout.write(
    `Received ${job.name} job ${job.id ?? "unknown"} for ${owner}/${repo}#${pullNumber}\n`,
  );

  const authorLogin = job.data.pull_request.user?.login || owner;
  const githubPrId = String(job.data.pull_request.id);
  const repositoryGithubId = String(job.data.repository.id);

  // 1. Upsert User
  const user = await prisma.user.upsert({
    where: { githubId: String(job.data.pull_request.user?.id || 'unknown') },
    update: { name: authorLogin },
    create: {
      githubId: String(job.data.pull_request.user?.id || 'unknown'),
      name: authorLogin,
      email: `${authorLogin}@github.local`,
    },
  });

  // 2. Upsert Repository
  const repository = await prisma.repository.upsert({
    where: { githubRepoId: repositoryGithubId },
    update: { name: repo, owner },
    create: {
      githubRepoId: repositoryGithubId,
      owner,
      name: repo,
    },
  });

  // 3. Upsert Pull Request (IN_PROGRESS)
  const pr = await prisma.pullRequest.upsert({
    where: {
      repositoryId_githubPrId: {
        repositoryId: repository.id,
        githubPrId,
      },
    },
    update: { reviewStatus: "IN_PROGRESS", number: pullNumber },
    create: {
      githubPrId,
      number: pullNumber,
      title: job.data.pull_request.title || `PR #${pullNumber}`,
      description: job.data.pull_request.body || "",
      status: "OPEN",
      reviewStatus: "IN_PROGRESS",
      authorId: user.id,
      repositoryId: repository.id,
      htmlUrl: job.data.pull_request.html_url || "",
    },
  });

  const diff = await fetchPullRequestDiff(owner, repo, pullNumber);
  const review = await runPullRequestReview(diff);

  // 4. Save review results to DB
  await prisma.pullRequest.update({
    where: { id: pr.id },
    data: {
      reviewStatus: "COMPLETED",
      summary: review.summary || "",
      riskScore: review.riskScore || 0,
      issues: (review.issues || []) as any,
      alerts: (review.securityAlerts || []) as any,
    },
  });

  await publishGitHubReview(owner, repo, pullNumber, review);

  process.stdout.write(`Published AI review for ${owner}/${repo}#${pullNumber} and saved to DB\n`);
}

const worker = new Worker<PullRequestOpenedPayload>(PR_REVIEW_QUEUE_NAME, processPrReviewJob, {
  connection: redisConnection,
});

worker.on("error", (error) => {
  process.stderr.write(`PR review worker error: ${error.message}\n`);
});

async function shutdown(): Promise<void> {
  await worker.close();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});
