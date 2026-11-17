CREATE TABLE "InlinePublication" (
  "runId" UUID NOT NULL,
  "findingId" UUID NOT NULL,
  "marker" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "line" INTEGER,
  "body" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "reason" TEXT,
  "reviewId" TEXT,
  "commentId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InlinePublication_pkey" PRIMARY KEY ("runId", "findingId"),
  CONSTRAINT "InlinePublication_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReviewRun"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "InlinePublication_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "Finding"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "InlinePublication_marker_key" ON "InlinePublication"("marker");
