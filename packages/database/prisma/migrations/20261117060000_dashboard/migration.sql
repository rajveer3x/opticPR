ALTER TABLE "ReviewRun" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PullRequest" ADD COLUMN "title" TEXT NOT NULL DEFAULT 'Pull request';
CREATE TABLE "DashboardSession" (
  "id" VARCHAR(64) PRIMARY KEY, "userId" TEXT NOT NULL, "login" TEXT NOT NULL,
  "credential" TEXT NOT NULL, "csrfToken" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "DashboardSession_expiresAt_idx" ON "DashboardSession"("expiresAt");
CREATE TABLE "ReviewRetry" (
  "id" UUID PRIMARY KEY, "sourceRunId" UUID NOT NULL REFERENCES "ReviewRun"("id"),
  "runId" UUID NOT NULL UNIQUE REFERENCES "ReviewRun"("id"), "actor" TEXT NOT NULL,
  "reason" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ReviewRetry_sourceRunId_idx" ON "ReviewRetry"("sourceRunId");
CREATE RULE "ReviewRetry_no_update" AS ON UPDATE TO "ReviewRetry" DO INSTEAD NOTHING;
CREATE RULE "ReviewRetry_no_delete" AS ON DELETE TO "ReviewRetry" DO INSTEAD NOTHING;
