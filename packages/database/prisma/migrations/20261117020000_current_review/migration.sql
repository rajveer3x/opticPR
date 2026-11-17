CREATE TABLE "PullRequest" (
  "repositoryId" TEXT NOT NULL,
  "number" INTEGER NOT NULL,
  "desiredRunKey" VARCHAR(64) NOT NULL,
  "baseSha" VARCHAR(40) NOT NULL,
  "headSha" VARCHAR(40) NOT NULL,
  "eligible" BOOLEAN NOT NULL DEFAULT true,
  "latestRunId" UUID,
  "commentId" TEXT,
  "publishedRunId" UUID,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PullRequest_pkey" PRIMARY KEY ("repositoryId", "number"),
  CONSTRAINT "PullRequest_latestRunId_fkey" FOREIGN KEY ("latestRunId") REFERENCES "ReviewRun"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE TABLE "ReviewPublication" (
  "repositoryId" TEXT NOT NULL,
  "pullRequestNumber" INTEGER NOT NULL,
  "runId" UUID NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "error" TEXT,
  "diagnostics" JSONB,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReviewPublication_pkey" PRIMARY KEY ("repositoryId", "pullRequestNumber"),
  CONSTRAINT "ReviewPublication_pullRequest_fkey" FOREIGN KEY ("repositoryId", "pullRequestNumber") REFERENCES "PullRequest"("repositoryId", "number") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "ReviewPublication_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReviewRun"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE INDEX "ReviewPublication_state_nextAttemptAt_idx" ON "ReviewPublication"("state", "nextAttemptAt");
