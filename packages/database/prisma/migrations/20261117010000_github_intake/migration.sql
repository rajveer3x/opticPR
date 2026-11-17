ALTER TABLE "ReviewRun" ADD COLUMN "installationId" TEXT, ADD COLUMN "grantVersion" UUID;
ALTER TABLE "ReviewRun" DROP CONSTRAINT "ReviewRun_state_check";
ALTER TABLE "ReviewRun" ADD CONSTRAINT "ReviewRun_state_check" CHECK ("state" IN ('queued', 'running', 'completed', 'failed', 'cancelled'));
CREATE TABLE "GitHubInstallation" (
  "id" TEXT PRIMARY KEY, "active" BOOLEAN NOT NULL DEFAULT true, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "GitHubRepository" (
  "id" TEXT PRIMARY KEY, "installationId" TEXT NOT NULL REFERENCES "GitHubInstallation"("id"),
  "owner" TEXT NOT NULL, "name" TEXT NOT NULL, "active" BOOLEAN NOT NULL DEFAULT true,
  "grantVersion" UUID NOT NULL, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "GitHubRepository_installationId_active_idx" ON "GitHubRepository"("installationId", "active");
CREATE TABLE "WebhookReceipt" (
  "id" TEXT PRIMARY KEY, "payloadDigest" VARCHAR(64) NOT NULL, "event" TEXT NOT NULL,
  "action" TEXT, "disposition" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "IntakeOutbox" (
  "id" UUID PRIMARY KEY, "deliveryId" TEXT NOT NULL UNIQUE REFERENCES "WebhookReceipt"("id"),
  "installationId" TEXT NOT NULL, "repositoryId" TEXT NOT NULL, "pullRequestNumber" INTEGER NOT NULL,
  "grantVersion" UUID NOT NULL, "state" TEXT NOT NULL DEFAULT 'pending', "runId" UUID,
  "attempts" INTEGER NOT NULL DEFAULT 0, "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseUntil" TIMESTAMP(3), "leaseToken" UUID, "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IntakeOutbox_state_check" CHECK ("state" IN ('pending', 'dispatched', 'cancelled'))
);
CREATE INDEX "IntakeOutbox_state_nextAttemptAt_idx" ON "IntakeOutbox"("state", "nextAttemptAt");
CREATE INDEX "ReviewRun_source_state_idx" ON "ReviewRun"("source", "state");
