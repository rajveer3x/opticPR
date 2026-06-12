import { Router, raw } from "express";

import { verifyGithubSignature } from "../middleware/verify-github-signature.js";
import {
  createPullRequestOpenedJobId,
  prReviewQueue,
  type PullRequestOpenedPayload,
} from "../queues/pr-review.js";

export const githubWebhookRouter: Router = Router();

function isPullRequestOpenedPayload(value: unknown): value is PullRequestOpenedPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const payload = value as Record<string, unknown>;
  const pullRequest = payload.pull_request;
  const repository = payload.repository;

  return (
    payload.action === "opened" &&
    typeof pullRequest === "object" &&
    pullRequest !== null &&
    typeof (pullRequest as Record<string, unknown>).id === "number" &&
    typeof (pullRequest as Record<string, unknown>).number === "number" &&
    typeof repository === "object" &&
    repository !== null &&
    typeof (repository as Record<string, unknown>).id === "number"
  );
}

githubWebhookRouter.post(
  "/",
  raw({ type: "application/json" }),
  verifyGithubSignature,
  async (request, response, next) => {
    const event = request.header("x-github-event");

    if (event === undefined || event.trim() === "") {
      response.status(400).json({ error: "Missing X-GitHub-Event header" });
      return;
    }

    if (event !== "pull_request") {
      response.status(202).json({ status: "ignored" });
      return;
    }

    const rawBody: unknown = request.body;

    if (!Buffer.isBuffer(rawBody)) {
      response.status(400).json({ error: "Invalid request body" });
      return;
    }

    let payload: unknown;

    try {
      payload = JSON.parse(rawBody.toString("utf8")) as unknown;
    } catch {
      response.status(400).json({ error: "Invalid JSON payload" });
      return;
    }

    if (
      typeof payload !== "object" ||
      payload === null ||
      (payload as Record<string, unknown>).action !== "opened"
    ) {
      response.status(202).json({ status: "ignored" });
      return;
    }

    if (!isPullRequestOpenedPayload(payload)) {
      response.status(400).json({ error: "Invalid pull request payload" });
      return;
    }

    try {
      await prReviewQueue.add("pull_request.opened", payload, {
        jobId: createPullRequestOpenedJobId(payload),
      });
    } catch (error) {
      next(error);
      return;
    }

    response.status(202).json({ status: "accepted" });
  },
);
