import { Router, raw } from "express";

import { verifyGithubSignature } from "../middleware/verify-github-signature.js";

export const githubWebhookRouter = Router();

githubWebhookRouter.post(
  "/",
  raw({ type: "application/json" }),
  verifyGithubSignature,
  (_request, response) => {
    response.status(202).json({ status: "accepted" });
  },
);
