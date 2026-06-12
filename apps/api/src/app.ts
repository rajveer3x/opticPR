import express from "express";

import { apiV1Router } from "./routes/api-v1.js";
import { githubWebhookRouter } from "./routes/github-webhook.js";
import { healthRouter } from "./routes/health.js";

export function createApp(): express.Express {
  const app = express();

  app.use("/health", healthRouter);
  app.use("/webhooks/github", githubWebhookRouter);
  app.use(express.json());
  app.use("/api/v1", apiV1Router);

  return app;
}
