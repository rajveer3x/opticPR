import { decisionInputSchema, reportSchema } from '@opticpr/contracts';
import type { Prisma, PrismaClient } from '@opticpr/database';

/** Shared append-only decision entry point for authenticated HTTP and operators. */
export async function appendFindingDecision(
  db: PrismaClient,
  raw: unknown,
  transaction?: Prisma.TransactionClient,
) {
  const input = decisionInputSchema.parse(raw);
  const write = async (tx: Prisma.TransactionClient) => {
    const run = await tx.reviewRun.findUniqueOrThrow({
      where: { id: input.runId },
    });
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`history:${run.source}:${run.repositoryId}:${run.pullRequestNumber}`}, 0))::text`;
    const snapshot = await tx.findingSnapshot.findUniqueOrThrow({
      where: { runId: input.runId },
    });
    const entry = reportSchema
      .parse(snapshot.report)
      .history?.findings.find((item) => item.findingId === input.findingId);
    const finding = await tx.finding.findUniqueOrThrow({
      where: { id: input.findingId },
    });
    if (
      !entry?.observation ||
      entry.state === 'needs_verification' ||
      run.state !== 'completed' ||
      finding.source !== run.source ||
      finding.repositoryId !== run.repositoryId ||
      finding.pullRequestNumber !== run.pullRequestNumber
    )
      throw new Error(
        'Decision requires a confirmed observation in this PR snapshot',
      );
    const existing = await tx.findingDecision.findUnique({
      where: { id: input.id },
    });
    if (existing) {
      const {
        createdAt: _createdAt,
        sequence: _sequence,
        ...previousInput
      } = existing;
      if (
        JSON.stringify(decisionInputSchema.parse(previousInput)) !==
        JSON.stringify(input)
      )
        throw new Error('Decision idempotency key conflict');
      return existing;
    }
    return tx.findingDecision.create({ data: input });
  };
  return transaction ? write(transaction) : db.$transaction(write);
}
