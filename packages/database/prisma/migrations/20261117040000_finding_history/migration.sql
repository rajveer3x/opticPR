CREATE TABLE "FindingSnapshot" (
  "runId" UUID PRIMARY KEY REFERENCES "ReviewRun"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  "report" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "Finding" (
  "id" UUID PRIMARY KEY,
  "source" TEXT NOT NULL,
  "repositoryId" TEXT NOT NULL,
  "pullRequestNumber" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "Finding_source_repositoryId_pullRequestNumber_idx" ON "Finding"("source", "repositoryId", "pullRequestNumber");
CREATE TABLE "FindingDecision" (
  "id" UUID PRIMARY KEY,
  "findingId" UUID NOT NULL REFERENCES "Finding"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  "runId" UUID NOT NULL REFERENCES "FindingSnapshot"("runId") ON DELETE NO ACTION ON UPDATE NO ACTION,
  "action" TEXT NOT NULL CHECK ("action" IN ('dismiss', 'reopen')),
  "actor" TEXT NOT NULL CHECK (length(trim("actor")) > 0),
  "reason" TEXT NOT NULL CHECK (length(trim("reason")) > 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "FindingDecision_findingId_createdAt_idx" ON "FindingDecision"("findingId", "createdAt");
CREATE RULE "FindingSnapshot_no_update" AS ON UPDATE TO "FindingSnapshot" DO INSTEAD NOTHING;
CREATE RULE "FindingSnapshot_no_delete" AS ON DELETE TO "FindingSnapshot" DO INSTEAD NOTHING;
CREATE RULE "FindingDecision_no_update" AS ON UPDATE TO "FindingDecision" DO INSTEAD NOTHING;
CREATE RULE "FindingDecision_no_delete" AS ON DELETE TO "FindingDecision" DO INSTEAD NOTHING;
