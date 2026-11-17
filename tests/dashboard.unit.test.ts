import { expect, it, vi } from 'vitest';
import {
  githubDashboardClient,
  DashboardError,
} from '../apps/api/src/dashboard-auth.js';
import { runIdentity } from '../packages/runtime/src/index.js';
import { githubConfig } from '../packages/contracts/src/index.js';
const config = {
  origin: 'https://opticpr.example',
  secret: 'a'.repeat(32),
  clientId: 'client',
  clientSecret: 'secret',
};
it('intersects explicit user installation access, paginates repositories, and separates maintainer authority from push access', async () => {
  const paths: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    paths.push(url.pathname + url.search);
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer user-token',
    );
    expect(init?.redirect).toBe('error');
    if (url.pathname === '/user/installations')
      return Response.json({
        installations: [
          { id: 100, permissions: { pull_requests: 'write' } },
          { id: 101, suspended_at: '2026-11-17' },
        ],
      });
    if (url.searchParams.get('page') === '1')
      return Response.json({
        repositories: Array.from({ length: 100 }, (_, i) => ({
          id: i + 1,
          owner: { login: 'acme' },
          name: `repo-${i}`,
          permissions: { pull: true, push: true, maintain: i === 1 },
        })),
      });
    return Response.json({
      repositories: [
        {
          id: 200,
          owner: { login: 'acme' },
          name: 'admin',
          permissions: { pull: true, admin: true },
        },
        {
          id: 201,
          owner: { login: 'acme' },
          name: 'no-access',
          permissions: { pull: false },
        },
      ],
    });
  };
  const repos = await githubDashboardClient(config, fetcher).repositories(
    'user-token',
  );
  expect(repos).toHaveLength(101);
  expect(repos[0]).toMatchObject({ maintainer: false, canPublish: true });
  expect(repos[1]!.maintainer).toBe(true);
  expect(repos.at(-1)!.maintainer).toBe(true);
  expect(paths).toEqual([
    '/user/installations?per_page=100&page=1',
    '/user/installations/100/repositories?per_page=100&page=1',
    '/user/installations/100/repositories?per_page=100&page=2',
  ]);
});
it('fails closed on expired authorization, revoked access and rate limits', async () => {
  for (const [status, headers, expected] of [
    [401, {}, 401],
    [403, {}, 403],
    [404, {}, 403],
    [403, { 'x-ratelimit-remaining': '0' }, 503],
    [429, {}, 503],
  ] as const) {
    const client = githubDashboardClient(
      config,
      async () => new Response('{}', { status, headers }),
    );
    await expect(client.repositories('secret')).rejects.toMatchObject({
      status: expected,
    });
  }
});
it('exchanges OAuth codes only at the fixed GitHub endpoint and rejects invalid tokens', async () => {
  const client = githubDashboardClient(config, async (url, init) => {
    expect(url).toBe('https://github.com/login/oauth/access_token');
    expect(JSON.parse(String(init!.body))).toMatchObject({
      client_id: 'client',
      redirect_uri: 'https://opticpr.example/auth/github/callback',
    });
    return Response.json({ error: 'bad_verification_code' });
  });
  await expect(client.exchange('invalid')).rejects.toBeInstanceOf(
    DashboardError,
  );
});
it('keys explicit attempts deterministically while retaining the original configuration digest', () => {
  const input = {
    source: 'github' as const,
    repositoryId: '200',
    pullRequestNumber: 42,
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
  };
  const original = runIdentity(input, githubConfig),
    retry = runIdentity(input, githubConfig, 1);
  expect(retry.configurationDigest).toBe(original.configurationDigest);
  expect(retry.logicalKey).not.toBe(original.logicalKey);
  expect(runIdentity(input, githubConfig, 1)).toEqual(retry);
  expect(() => runIdentity(input, githubConfig, -1)).toThrow();
});

it('builds safe revision-specific public dashboard links', async () => {
  const { dashboardRunUrl } = await import('../packages/runtime/src/index.js');
  const run = '11111111-1111-4111-8111-111111111111',
    finding = '22222222-2222-4222-8222-222222222222';
  expect(dashboardRunUrl(run, finding, 'https://opticpr.example')).toBe(
    `https://opticpr.example/runs/${run}?finding=${finding}`,
  );
  expect(() => dashboardRunUrl(run, finding, 'javascript:alert(1)')).toThrow();
  expect(() =>
    dashboardRunUrl(run, finding, 'https://opticpr.example/unsafe-path'),
  ).toThrow();
});

it('links a published summary and inline comment to the exact finding', async () => {
  const { randomUUID } = await import('node:crypto');
  const { FixtureRepositoryAdapter } = await import(
    '../packages/repository/src/index.js'
  );
  const { fixtureConfig } = await import('../packages/contracts/src/index.js');
  const { analyzeFixture } = await import('../apps/worker/src/analyze.js');
  const { summaryBody } = await import('../apps/worker/src/publication.js');
  const { inlineBody } = await import('../apps/worker/src/inline-comments.js');
  const adapter = await FixtureRepositoryAdapter.open();
  vi.stubEnv('DASHBOARD_ORIGIN', 'https://opticpr.example');
  try {
    const input = await adapter.revisions();
    const report = await analyzeFixture(adapter, input, fixtureConfig, {
      runId: randomUUID(),
      ...runIdentity(input, fixtureConfig),
    });
    const finding = { ...report.findings[0]!, id: randomUUID() };
    report.findings = [finding];
    const link = `https://opticpr.example/runs/${report.runId}?finding=${finding.id}`;
    expect(
      summaryBody(
        input.repositoryId,
        input.pullRequestNumber,
        input.baseSha,
        input.headSha,
        report,
      ),
    ).toContain(`[Inspect evidence](${link})`);
    expect(inlineBody(report, finding)).toContain(
      `[Inspect evidence](${link})`,
    );
  } finally {
    vi.unstubAllEnvs();
    await adapter.close();
  }
});
