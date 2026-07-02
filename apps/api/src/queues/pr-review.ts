import { Queue } from "bullmq";

import { redisConnection } from "../config/redis.js";
import { PR_REVIEW_QUEUE_NAME } from "./names.js";

export interface PullRequestOpenedPayload {
  action: "opened" | "synchronize";
  pull_request: {
    id: number;
    number: number;
    diff_url: string;
    [key: string]: unknown;
  };
  repository: {
    id: number;
    name: string;
    full_name: string;
    owner: {
      login: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  deliveryId?: string;
  [key: string]: unknown;
}

export const prReviewQueue = new Queue<PullRequestOpenedPayload>(PR_REVIEW_QUEUE_NAME, {
  connection: redisConnection,
});

export function createPullRequestOpenedJobId(payload: PullRequestOpenedPayload): string {
  if (payload.deliveryId !== undefined && payload.deliveryId.trim() !== "") {
    return `github-delivery-${payload.deliveryId}`;
  }

  return `github-${payload.repository.id}-${payload.pull_request.id}-${payload.action}`;
}
