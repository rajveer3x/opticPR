import { Worker } from "bullmq";
import type { Job } from "bullmq";
import { runPullRequestReview } from "@opticpr/ai/agents/pr-review";

import { redisConnection } from "../config/redis.js";
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

  const diff = await fetchPullRequestDiff(owner, repo, pullNumber);
  const review = await runPullRequestReview(diff);

  await publishGitHubReview(owner, repo, pullNumber, review);

  process.stdout.write(`Published AI review for ${owner}/${repo}#${pullNumber}\n`);
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
