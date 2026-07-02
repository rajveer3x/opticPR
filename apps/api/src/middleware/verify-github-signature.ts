import { createHmac, timingSafeEqual } from "node:crypto";

import type { NextFunction, Request, Response } from "express";

import { env } from "../config/env.js";

export function verifyGithubSignature(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const signature = request.header("x-hub-signature-256");

  if (signature === undefined || !Buffer.isBuffer(request.body)) {
    response.status(401).json({ error: "Invalid GitHub signature" });
    return;
  }

  const expectedSignature = `sha256=${createHmac("sha256", env.GITHUB_WEBHOOK_SECRET)
    .update(request.body)
    .digest("hex")}`;
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    response.status(401).json({ error: "Invalid GitHub signature" });
    return;
  }

  next();
}
