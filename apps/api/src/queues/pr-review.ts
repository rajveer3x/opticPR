import { Queue } from "bullmq";

import { redisConnection } from "../config/redis.js";
import { PR_REVIEW_QUEUE_NAME } from "./names.js";

export interface PullRequestOpenedPayload {
  action: "opened";
  pull_request: {
    id: number;
    number: number;
    [key: string]: unknown;
  };
  repository: {
    id: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export const prReviewQueue = new Queue<PullRequestOpenedPayload>(PR_REVIEW_QUEUE_NAME, {
  connection: redisConnection,
});

export function createPullRequestOpenedJobId(payload: PullRequestOpenedPayload): string {
  return `github-${payload.repository.id}-${payload.pull_request.id}-opened`;
}
