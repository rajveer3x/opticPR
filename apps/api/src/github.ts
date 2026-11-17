import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { githubInstallationEventSchema, githubPullEventSchema } from '@opticpr/contracts';
import { Prisma, type PrismaClient } from '@opticpr/database';
import { lockInstallation, repositoryScope, revokeRepositories, AccessRevokedError } from '@opticpr/runtime';

export class InvalidWebhookError extends Error {}
export class DeliveryConflictError extends Error {}

export function verifySignature(body: Buffer, signature: string | undefined, secret: string): boolean {
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}

/** The transaction does no GitHub or Redis I/O. Only verified compact metadata is stored. */
export async function receiveGitHubEvent(db: PrismaClient, deliveryId: string, event: string, body: Buffer) {
  let payload: unknown;
  try { payload = JSON.parse(body.toString('utf8')); } catch { throw new InvalidWebhookError('Invalid JSON'); }
  const pull = event === 'pull_request' ? githubPullEventSchema.safeParse(payload) : undefined;
  const lifecycle = ['installation', 'installation_repositories'].includes(event) ? githubInstallationEventSchema.safeParse(payload) : undefined;
  if (pull?.success === false || lifecycle?.success === false) throw new InvalidWebhookError('Invalid webhook payload');
  if (pull?.success && pull.data.number !== pull.data.pull_request.number) throw new InvalidWebhookError('PR number mismatch');
  if (lifecycle?.success) {
    const data = lifecycle.data;
    if (event === 'installation' && data.action === 'created' && !data.repositories) throw new InvalidWebhookError('Missing selected repositories');
    if (event === 'installation_repositories' && data.action === 'added' && !data.repositories_added) throw new InvalidWebhookError('Missing added repositories');
    if (event === 'installation_repositories' && data.action === 'removed' && !data.repositories_removed) throw new InvalidWebhookError('Missing removed repositories');
  }
  const payloadDigest = createHash('sha256').update(body).digest('hex');
  const action = pull?.success ? pull.data.action : lifecycle?.success ? lifecycle.data.action : null;
  const sameReceipt = (receipt: { payloadDigest: string; event: string; disposition: string }) => {
    if (receipt.payloadDigest !== payloadDigest || receipt.event !== event) throw new DeliveryConflictError('Delivery ID reused with different content');
    return { duplicate: true, disposition: receipt.disposition };
  };
  try {
    return await db.$transaction(async tx => {
      // Unique delivery ID rolls back all side effects on concurrent redelivery.
      await tx.webhookReceipt.create({ data: { id: deliveryId, event, action, payloadDigest, disposition: 'ignored' } });
      let disposition = 'ignored';
      if (lifecycle?.success) {
        const data = lifecycle.data;
        const installationId = data.installation.id;
        await lockInstallation(tx, installationId);
        if (event === 'installation' && ['deleted', 'suspend'].includes(data.action)) {
          await tx.gitHubInstallation.upsert({ where: { id: installationId }, create: { id: installationId, active: false }, update: { active: false } });
          await revokeRepositories(tx, installationId, undefined, data.action !== 'suspend');
          disposition = 'revoked';
        } else if (event === 'installation' && data.action === 'unsuspend') {
          // Suspension preserves selection; deleted installations cannot be resurrected by PR events.
          await tx.gitHubInstallation.updateMany({ where: { id: installationId }, data: { active: true } });
          disposition = 'installation-updated';
        } else if ((event === 'installation' && data.action === 'created') || (event === 'installation_repositories' && data.action === 'added')) {
          const created = event === 'installation';
          await tx.gitHubInstallation.upsert({ where: { id: installationId }, create: { id: installationId }, update: created ? { active: true } : {} });
          for (const repo of (created ? data.repositories : data.repositories_added) ?? []) {
            // A fresh version fences jobs from a prior selection, even after re-addition.
            const existing = await tx.gitHubRepository.findUnique({ where: { id: repo.id } });
            if (existing && existing.installationId !== installationId && existing.active) {
              const previous = await tx.gitHubInstallation.findUnique({ where: { id: existing.installationId } });
              if (previous?.active) throw new InvalidWebhookError('Repository belongs to another active installation');
            }
            await tx.gitHubRepository.upsert({ where: { id: repo.id },
              create: { id: repo.id, installationId, owner: repo.owner.login, name: repo.name },
              update: { installationId, owner: repo.owner.login, name: repo.name, active: true, ...(!existing?.active || existing.installationId !== installationId ? { grantVersion: randomUUID() } : {}) },
            });
          }
          disposition = 'repositories-selected';
        } else if (event === 'installation_repositories' && data.action === 'removed') {
          await revokeRepositories(tx, installationId, data.repositories_removed!.map(repo => repo.id));
          disposition = 'revoked';
        }
      } else if (pull?.success) {
        const data = pull.data;
        const installationId = data.installation.id;
        await lockInstallation(tx, installationId);
        const eligibleAction = ['opened', 'reopened', 'synchronize', 'ready_for_review'].includes(data.action) ||
          (data.action === 'edited' && (data.changes?.base?.ref !== undefined || data.changes?.base?.sha !== undefined));
        if (eligibleAction && data.pull_request.state === 'open' && !data.pull_request.draft) {
          try {
            const scope = await repositoryScope(tx, installationId, data.repository.id);
            await tx.gitHubRepository.update({ where: { id: scope.repositoryId }, data: { owner: data.repository.owner.login, name: data.repository.name } });
            await tx.intakeOutbox.create({ data: {
              deliveryId, installationId, repositoryId: scope.repositoryId, pullRequestNumber: data.number, grantVersion: scope.grantVersion,
            } });
            disposition = 'accepted';
          } catch (error) {
            if (!(error instanceof AccessRevokedError)) throw error;
            disposition = 'unselected';
          }
        }
      }
      await tx.webhookReceipt.update({ where: { id: deliveryId }, data: { disposition } });
      return { duplicate: false, disposition };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const receipt = await db.webhookReceipt.findUnique({ where: { id: deliveryId } });
      if (receipt) return sameReceipt(receipt);
    }
    throw error;
  }
}
