import express, { type Router } from 'express';
import {
  configSchema,
  dashboardDecisionSchema,
  dashboardRetrySchema,
  findingDecisionSchema,
  inputSchema,
  queueJobSchema,
  reportSchema,
  type DashboardRepository,
} from '@opticpr/contracts';
import { type PrismaClient } from '@opticpr/database';
import {
  appendFindingDecision,
  lockInstallation,
  repositoryScope,
  runIdentity,
} from '@opticpr/runtime';
import {
  DashboardError,
  githubDashboardClient,
  sessionManager,
  type DashboardConfig,
  type DashboardGitHub,
} from './dashboard-auth.js';

type Run = Awaited<ReturnType<PrismaClient['reviewRun']['findUniqueOrThrow']>>;
export function summarizeRun(run: Run) {
  const report = run.report ? reportSchema.parse(run.report) : null;
  return {
    id: run.id,
    baseSha: run.baseSha,
    headSha: run.headSha,
    state: run.state,
    attempt: run.attempt,
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    coverage: report?.coverage.status ?? null,
    findings: report?.findings.length ?? 0,
  };
}
export function dashboardRouter(
  db: PrismaClient,
  config?: DashboardConfig,
  injected?: DashboardGitHub,
): Router {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  if (!config) {
    router.get('/auth/github', (_req, res) => {
      res.redirect('/?setup=github');
    });
    router.use(['/api/session', '/auth'], (_req, res) => {
      res.status(503).json({
        error:
          'GitHub sign-in is not configured. Set the dashboard environment variables.',
        code: 'AUTH_NOT_CONFIGURED',
      });
    });
    router.use('/api', (_req, res) => {
      res.status(401).json({ error: 'Sign in to continue' });
    });
    return router;
  }
  const sessions = sessionManager(db, config);
  const github = injected ?? githubDashboardClient(config);
  router.get('/auth/github', (req, res) => sessions.begin(req, res));
  router.get('/auth/github/callback', async (req, res) => {
    const destination = sessions.verifyState(req, res);
    if (typeof req.query.code !== 'string' || req.query.code.length > 500)
      throw new DashboardError(400, 'Missing OAuth code');
    const credentials = await github.exchange(req.query.code);
    const user = await github.identity(credentials.token);
    await sessions.create(res, user, credentials.token, credentials.expiresIn);
    res.redirect(destination);
  });
  router.get('/api/session', async (req, res) => {
    const session = await sessions.require(req);
    res.json({
      user: { id: session.userId, login: session.login },
      csrfToken: session.csrfToken,
    });
  });
  router.post('/api/logout', async (req, res) => {
    await sessions.logout(req, res);
    res.status(204).end();
  });

  // Each request intersects live GitHub user access with current durable installation grants.
  async function accessible(token: string): Promise<DashboardRepository[]> {
    const live = await github.repositories(token);
    const installed = await db.gitHubRepository.findMany({
      where: {
        active: true,
        installation: { active: true },
        id: { in: live.map((item) => item.id) },
      },
    });
    const repos: DashboardRepository[] = [];
    for (const repo of installed) {
      const grant = live.find(
        (item) =>
          item.id === repo.id &&
          item.installationId === repo.installationId &&
          item.owner === repo.owner &&
          item.name === repo.name,
      );
      if (!grant) continue;
      const last = await db.intakeOutbox.findFirst({
        where: { repositoryId: repo.id },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      repos.push({
        id: repo.id,
        owner: repo.owner,
        name: repo.name,
        installationId: repo.installationId,
        role: grant.maintainer ? 'maintainer' : 'member',
        canPublish: grant.canPublish,
        lastEventAt: last?.createdAt.toISOString() ?? null,
      });
    }
    return repos.sort((a, b) =>
      `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`),
    );
  }
  function requireRepo(
    repos: DashboardRepository[],
    id: string,
    write = false,
  ) {
    const repo = repos.find((item) => item.id === id);
    if (!repo)
      throw new DashboardError(
        404,
        'Repository or review unavailable. Access may have changed.',
      );
    if (write && repo.role !== 'maintainer')
      throw new DashboardError(403, 'Maintainer access is required');
    return repo;
  }
  async function prSummary(
    pr: Awaited<ReturnType<PrismaClient['pullRequest']['findUniqueOrThrow']>>,
  ) {
    const [latest, desired, publication] = await Promise.all([
      pr.latestRunId
        ? db.reviewRun.findFirst({
            where: {
              id: pr.latestRunId,
              source: 'github',
              repositoryId: pr.repositoryId,
              pullRequestNumber: pr.number,
            },
          })
        : null,
      db.reviewRun.findFirst({
        where: {
          logicalKey: pr.desiredRunKey,
          source: 'github',
          repositoryId: pr.repositoryId,
          pullRequestNumber: pr.number,
        },
      }),
      db.reviewPublication.findUnique({
        where: {
          repositoryId_pullRequestNumber: {
            repositoryId: pr.repositoryId,
            pullRequestNumber: pr.number,
          },
        },
      }),
    ]);
    return {
      number: pr.number,
      title: pr.title,
      baseSha: pr.baseSha,
      headSha: pr.headSha,
      eligible: pr.eligible,
      latestRunId: pr.latestRunId,
      latestRun: latest ? summarizeRun(latest) : null,
      desiredRun: desired ? summarizeRun(desired) : null,
      publicationState: publication?.state ?? null,
      updatedAt: pr.updatedAt.toISOString(),
    };
  }
  router.get('/api/repos', async (req, res) => {
    const session = await sessions.require(req);
    res.json({
      repositories: await accessible(session.token),
      installationUrl:
        config.appSlug && /^[a-z0-9-]+$/.test(config.appSlug)
          ? `https://github.com/apps/${config.appSlug}/installations/new`
          : null,
    });
  });
  router.get('/api/repos/:id/prs', async (req, res) => {
    const session = await sessions.require(req);
    const repository = requireRepo(
      await accessible(session.token),
      String(req.params.id),
    );
    const page = Number(req.query.page ?? 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000)
      throw new DashboardError(400, 'Invalid page');
    const pageSize = 20;
    const where = { repositoryId: repository.id };
    const [prs, total, active] = await Promise.all([
      db.pullRequest.findMany({
        where,
        orderBy: { number: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.pullRequest.count({ where }),
      db.reviewRun.count({
        where: {
          source: 'github',
          repositoryId: repository.id,
          state: { in: ['queued', 'running'] },
        },
      }),
    ]);
    res.json({
      repository,
      items: await Promise.all(prs.map(prSummary)),
      total,
      page,
      pageSize,
      hasActive: active > 0,
    });
  });
  router.get('/api/runs/:id', async (req, res) => {
    const session = await sessions.require(req);
    if (!queueJobSchema.safeParse({ runId: req.params.id }).success)
      throw new DashboardError(400, 'Invalid run ID');
    const repos = await accessible(session.token);
    const run = await db.reviewRun.findFirst({
      where: {
        id: String(req.params.id),
        source: 'github',
        repositoryId: { in: repos.map((repo) => repo.id) },
      },
    });
    if (!run)
      throw new DashboardError(
        404,
        'Repository or review unavailable. Access may have changed.',
      );
    const repository = requireRepo(repos, run.repositoryId);
    const report = run.report ? reportSchema.parse(run.report) : null;
    const [pr, revisions, decisions, retries] = await Promise.all([
      db.pullRequest.findUnique({
        where: {
          repositoryId_number: {
            repositoryId: run.repositoryId,
            number: run.pullRequestNumber,
          },
        },
      }),
      db.reviewRun.findMany({
        where: {
          source: 'github',
          repositoryId: run.repositoryId,
          pullRequestNumber: run.pullRequestNumber,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      db.findingDecision.findMany({
        where: {
          findingId: {
            in: report?.history?.findings.map((item) => item.findingId) ?? [],
          },
          finding: {
            source: 'github',
            repositoryId: run.repositoryId,
            pullRequestNumber: run.pullRequestNumber,
          },
        },
        orderBy: { sequence: 'asc' },
      }),
      db.reviewRetry.findMany({
        where: { OR: [{ sourceRunId: run.id }, { runId: run.id }] },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    res.json({
      ...summarizeRun(run),
      configurationDigest: run.configurationDigest,
      error: run.error,
      report,
      repository,
      pullRequest: pr ? await prSummary(pr) : null,
      revisions: revisions.map(summarizeRun),
      decisions: decisions.map((item) =>
        findingDecisionSchema.parse({
          ...item,
          createdAt: item.createdAt.toISOString(),
        }),
      ),
      retries: retries.map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString(),
      })),
    });
  });
  router.post(
    '/api/runs/:id/retry',
    express.json({ limit: '16kb' }),
    async (req, res) => {
      const session = await sessions.require(req);
      sessions.csrf(req, session);
      const input = dashboardRetrySchema.safeParse(req.body);
      if (
        !input.success ||
        !queueJobSchema.safeParse({ runId: req.params.id }).success
      )
        throw new DashboardError(
          400,
          'A valid request ID and retry reason are required',
        );
      const repos = await accessible(session.token);
      const run = await db.reviewRun.findFirst({
        where: {
          id: String(req.params.id),
          source: 'github',
          repositoryId: { in: repos.map((repo) => repo.id) },
        },
      });
      if (!run) throw new DashboardError(404, 'Review unavailable');
      const repo = requireRepo(repos, run.repositoryId, true);
      const result = await db.$transaction(async (tx) => {
        await lockInstallation(tx, repo.installationId);
        await repositoryScope(tx, repo.installationId, repo.id);
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pr:${repo.id}:${run.pullRequestNumber}`}, 0))::text`;
        const previous = await tx.reviewRetry.findUnique({
          where: { id: input.data.id },
        });
        if (previous) {
          if (
            previous.sourceRunId !== run.id ||
            previous.actor !== session.login ||
            previous.reason !== input.data.reason
          )
            throw new DashboardError(409, 'Retry request ID was already used');
          return previous;
        }
        if (!['completed', 'failed'].includes(run.state))
          throw new DashboardError(
            409,
            'Only a terminal review can be retried',
          );
        const configuration = configSchema.parse(run.configuration);
        const where = {
          source: run.source,
          repositoryId: run.repositoryId,
          pullRequestNumber: run.pullRequestNumber,
          baseSha: run.baseSha,
          headSha: run.headSha,
          configurationDigest: run.configurationDigest,
        };
        if (
          await tx.reviewRun.count({
            where: { ...where, state: { in: ['queued', 'running'] } },
          })
        )
          throw new DashboardError(
            409,
            'A review of this revision is already active',
          );
        const max = await tx.reviewRun.aggregate({
          where,
          _max: { attempt: true },
        });
        const attempt = (max._max.attempt ?? 0) + 1;
        const next = await tx.reviewRun.create({
          data: {
            ...inputSchema.parse(run),
            ...runIdentity(inputSchema.parse(run), configuration, attempt),
            configuration,
            installationId: repo.installationId,
            grantVersion: (
              await repositoryScope(tx, repo.installationId, repo.id)
            ).grantVersion,
            attempt,
          },
        });
        // Keep the previous summary available until the fresh attempt finishes.
        await tx.pullRequest.updateMany({
          where: {
            repositoryId: repo.id,
            number: run.pullRequestNumber,
            eligible: true,
            baseSha: run.baseSha,
            headSha: run.headSha,
          },
          data: { desiredRunKey: next.logicalKey },
        });
        return tx.reviewRetry.create({
          data: {
            id: input.data.id,
            sourceRunId: run.id,
            runId: next.id,
            actor: session.login,
            reason: input.data.reason,
          },
        });
      });
      // The existing dispatcher recovers durable queued runs even if Redis is down.
      res
        .status(202)
        .json({ ...result, createdAt: result.createdAt.toISOString() });
    },
  );
  router.post(
    '/api/findings/:id/decisions',
    express.json({ limit: '16kb' }),
    async (req, res) => {
      const session = await sessions.require(req);
      sessions.csrf(req, session);
      const input = dashboardDecisionSchema.safeParse(req.body);
      if (
        !input.success ||
        !queueJobSchema.safeParse({ runId: req.params.id }).success
      )
        throw new DashboardError(
          400,
          'A valid decision and reason are required',
        );
      const repos = await accessible(session.token);
      const finding = await db.finding.findFirst({
        where: {
          id: String(req.params.id),
          source: 'github',
          repositoryId: { in: repos.map((repo) => repo.id) },
        },
      });
      if (!finding) throw new DashboardError(404, 'Finding unavailable');
      const repo = requireRepo(repos, finding.repositoryId, true);
      const selectedRun = await db.reviewRun.findFirst({
        where: {
          id: input.data.runId,
          source: 'github',
          repositoryId: finding.repositoryId,
          pullRequestNumber: finding.pullRequestNumber,
        },
      });
      if (!selectedRun) throw new DashboardError(404, 'Review unavailable');
      // Same installation lock order as report completion and revocation.
      const decision = await db.$transaction(
        async (tx) => {
          await lockInstallation(tx, repo.installationId);
          await repositoryScope(tx, repo.installationId, repo.id);
          // The shared writer owns the PR history lock. Keep this installation lock until it commits.
          return appendFindingDecision(
            db,
            { ...input.data, findingId: finding.id, actor: session.login },
            tx,
          );
        },
        { timeout: 15000 },
      );
      res
        .status(201)
        .json({ ...decision, createdAt: decision.createdAt.toISOString() });
    },
  );
  return router;
}
