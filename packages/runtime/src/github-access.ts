import type { GitHubScope } from '@opticpr/contracts';
import type { Prisma, PrismaClient } from '@opticpr/database';

export class AccessRevokedError extends Error {
  constructor() { super('GitHub repository access revoked'); }
}

/** All grant changes and durable work writes for an installation use this lock. */
export async function lockInstallation(tx: Prisma.TransactionClient, installationId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`github:${installationId}`}, 0))::text`;
}

export async function repositoryScope(db: PrismaClient | Prisma.TransactionClient, installationId: string, repositoryId: string, grantVersion?: string): Promise<GitHubScope> {
  const repository = await db.gitHubRepository.findFirst({ where: {
    id: repositoryId, installationId, active: true, installation: { active: true },
    ...(grantVersion ? { grantVersion } : {}),
  } });
  if (!repository) throw new AccessRevokedError();
  return { installationId, repositoryId, owner: repository.owner, name: repository.name, grantVersion: repository.grantVersion };
}

export async function revokeRepositories(tx: Prisma.TransactionClient, installationId: string, ids?: string[], deselect = true) {
  const where = { installationId, ...(ids ? { id: { in: ids } } : {}) };
  if (deselect) await tx.gitHubRepository.updateMany({ where, data: { active: false } });
  const work = { installationId, ...(ids ? { repositoryId: { in: ids } } : {}) };
  await tx.intakeOutbox.updateMany({ where: { ...work, state: { in: ['pending', 'dispatched'] } }, data: {
    state: 'cancelled', leaseUntil: null, leaseToken: null, error: 'Repository access revoked',
  } });
  await tx.reviewRun.updateMany({ where: { ...work, source: 'github', state: { in: ['queued', 'running', 'failed'] } }, data: {
    state: 'cancelled', error: 'Repository access revoked',
  } });
  const repositories = await tx.gitHubRepository.findMany({ where, select: { id: true } });
  const repositoryIds = repositories.map(repository => repository.id);
  await tx.pullRequest.updateMany({ where: { repositoryId: { in: repositoryIds } }, data: { eligible: false } });
  await tx.reviewPublication.updateMany({ where: { repositoryId: { in: repositoryIds }, state: { in: ['pending', 'waiting', 'failed'] } }, data: {
    state: 'cancelled', error: 'Repository access revoked',
  } });
}
