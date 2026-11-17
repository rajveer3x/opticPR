ALTER TABLE "ReviewRun" ADD COLUMN "staticCheckpoint" JSONB, ADD COLUMN "staticCompletedAt" TIMESTAMP(3);
CREATE TABLE "RunObservation" (
  "runId" UUID NOT NULL REFERENCES "ReviewRun"("id") ON DELETE CASCADE,
  "fingerprint" VARCHAR(64) NOT NULL,
  "finding" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("runId", "fingerprint")
);
CREATE TABLE "RunEnrichment" (
  "runId" UUID NOT NULL REFERENCES "ReviewRun"("id") ON DELETE CASCADE,
  "fingerprint" VARCHAR(64) NOT NULL,
  "candidate" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("runId", "fingerprint")
);
