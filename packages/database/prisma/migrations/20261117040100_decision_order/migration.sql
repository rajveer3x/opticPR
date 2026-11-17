ALTER TABLE "FindingDecision" ADD COLUMN "sequence" SERIAL NOT NULL;
CREATE UNIQUE INDEX "FindingDecision_sequence_key" ON "FindingDecision"("sequence");
