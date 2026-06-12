import { Worker } from "bullmq";
import type { Job } from "bullmq";

import { redisConnection } from "../config/redis.js";
import { PR_REVIEW_QUEUE_NAME } from "../queues/names.js";
import type { PullRequestOpenedPayload } from "../queues/pr-review.js";

function processPrReviewJob(job: Job<PullRequestOpenedPayload>): Promise<void> {
  process.stdout.write(
    `Received ${job.name} job ${job.id ?? "unknown"} for pull request ${job.data.pull_request.number}\n`,
  );

  return Promise.resolve();
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
