import "dotenv/config";

type RequiredEnvironmentVariable = "DATABASE_URL" | "GITHUB_WEBHOOK_SECRET";

const readRequiredEnvironmentVariable = (name: RequiredEnvironmentVariable): string => {
  const value = process.env[name];

  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
};

export const env = {
  DATABASE_URL: readRequiredEnvironmentVariable("DATABASE_URL"),
  GITHUB_WEBHOOK_SECRET: readRequiredEnvironmentVariable("GITHUB_WEBHOOK_SECRET"),
  PORT: Number.parseInt(process.env.PORT ?? "3000", 10),
} as const;

if (!Number.isInteger(env.PORT) || env.PORT < 1 || env.PORT > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
