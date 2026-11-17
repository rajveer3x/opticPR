CREATE TABLE "ReviewRun" (
  "id" UUID NOT NULL,
  "logicalKey" VARCHAR(64) NOT NULL,
  "source" TEXT NOT NULL,
  "repositoryId" TEXT NOT NULL,
  "pullRequestNumber" INTEGER NOT NULL,
  "baseSha" VARCHAR(40) NOT NULL,
  "headSha" VARCHAR(40) NOT NULL,
  "configurationDigest" VARCHAR(64) NOT NULL,
  "configuration" JSONB NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'queued',
  "report" JSONB,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReviewRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReviewRun_state_check" CHECK ("state" IN ('queued', 'running', 'completed', 'failed')),
  CONSTRAINT "ReviewRun_completed_report_check" CHECK ("state" <> 'completed' OR ("report" IS NOT NULL AND "completedAt" IS NOT NULL))
);
CREATE UNIQUE INDEX "ReviewRun_logicalKey_key" ON "ReviewRun"("logicalKey");
