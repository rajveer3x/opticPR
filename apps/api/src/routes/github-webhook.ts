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
    (payload.action === "opened" || payload.action === "synchronize") &&
    typeof pullRequest === "object" &&
    pullRequest !== null &&
    typeof (pullRequest as Record<string, unknown>).id === "number" &&
    typeof (pullRequest as Record<string, unknown>).number === "number" &&
    typeof (pullRequest as Record<string, unknown>).diff_url === "string" &&
    typeof repository === "object" &&
    repository !== null &&
    typeof (repository as Record<string, unknown>).id === "number" &&
    typeof (repository as Record<string, unknown>).name === "string" &&
    typeof (repository as Record<string, unknown>).full_name === "string" &&
    typeof (repository as Record<string, unknown>).owner === "object" &&
    (repository as Record<string, unknown>).owner !== null &&
    typeof ((repository as Record<string, unknown>).owner as Record<string, unknown>).login ===
      "string"
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
      !["opened", "synchronize"].includes(String((payload as Record<string, unknown>).action))
    ) {
      response.status(202).json({ status: "ignored" });
      return;
    }

    if (!isPullRequestOpenedPayload(payload)) {
      response.status(400).json({ error: "Invalid pull request payload" });
      return;
    }

    try {
      const deliveryId = request.header("x-github-delivery");

      if (deliveryId !== undefined) {
        payload.deliveryId = deliveryId;
      }

      await prReviewQueue.add(`pull_request.${payload.action}`, payload, {
        jobId: createPullRequestOpenedJobId(payload),
      });
    } catch (error) {
      next(error);
      return;
    }

    response.status(202).json({ status: "accepted" });
  },
);
