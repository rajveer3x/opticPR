import "dotenv/config";

import type { ConnectionOptions } from "bullmq";

const redisPassword = process.env.REDIS_PASSWORD;
const redisPort = Number.parseInt(process.env.REDIS_PORT ?? "6379", 10);

if (redisPassword === undefined || redisPassword.trim() === "") {
  throw new Error("Missing required environment variable: REDIS_PASSWORD");
}

if (!Number.isInteger(redisPort) || redisPort < 1 || redisPort > 65535) {
  throw new Error("REDIS_PORT must be an integer between 1 and 65535");
}

export const redisConnection: ConnectionOptions = {
  host: process.env.REDIS_HOST ?? "127.0.0.1",
  password: redisPassword,
  port: redisPort,
};
