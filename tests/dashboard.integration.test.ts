import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { PrismaClient } from '../packages/database/src/index.js';
import {
  githubConfig,
  reportSchema,
  runDetailSchema,
  pullRequestListSchema,
  type ReviewInput,
} from '../packages/contracts/src/index.js';
import {
  createQueue,
  repositoryScope,
  waitForReport,
  type Worker,
} from '../packages/runtime/src/index.js';
import { createApp } from '../apps/api/src/app.js';
import type { DashboardGitHub } from '../apps/api/src/dashboard-auth.js';
import { createWorker } from '../apps/worker/src/worker.js';
import { createDispatcher } from '../apps/worker/src/dispatcher.js';
import { scanSemgrep } from '../apps/worker/src/semgrep.js';
import {
  lockPullRequest,
  observeLiveTarget,
} from '../apps/worker/src/current-review.js';
import { GitSnapshotAdapter, type GitHubClientFactory } from '../packages/repository/src/index.js';
import { missingUserFixture, routePath, usersPath } from './cross-file-fixture.js';

const namespace = `dashboard_${randomUUID().replaceAll('-', '')}`;
const url = new URL(process.env.DATABASE_URL!);
url.searchParams.set('schema', namespace);
const db = new PrismaClient({ datasourceUrl: url.toString() }),
  admin = new PrismaClient();
let server: Server,
  origin: string,
  queue: ReturnType<typeof createQueue>,
  worker: Worker,
  dispatcher: ReturnType<typeof createDispatcher>;
let currentLogin = 'maintainer',
  userAccess = true,
  modelFails = true;
const baseSha = 'a'.repeat(40),
  headSha = 'b'.repeat(40);
let targetHead = headSha;
const missingUserPR = 93;
let missingUserInput: ReviewInput;
let missingUser: GitSnapshotAdapter;
let missingUserDirectory: string;
async function prepareMissingUser() {
  const fixtureInput = { source: 'github' as const, repositoryId: '200', pullRequestNumber: missingUserPR, baseSha, headSha: 'e'.repeat(40) };
  const { adapter } = missingUserFixture(fixtureInput);
  missingUserDirectory = await mkdtemp(join(tmpdir(), 'opticpr-dashboard-git-'));
  const env = { ...process.env, GIT_AUTHOR_DATE: '2026-11-18T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-18T00:00:00Z' };
  const exec = promisify(execFile);
  const git = (...args: string[]) => exec('git', ['-C', missingUserDirectory, '-c', 'core.hooksPath=/dev/null',
    '-c', 'user.name=OpticPR fixture', '-c', 'user.email=fixture@example.invalid', ...args], { env, timeout: 5000 });
  await git('init', '--quiet', '--template=');
  async function commit(sha: string, title: string) {
    for (const path of (await adapter.sourceTreeAt(sha)).paths) {
      const file = join(missingUserDirectory, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, await adapter.fileAt(sha, path));
    }
    await git('add', '--all');
    await git('commit', '--quiet', '--no-gpg-sign', '-m', title);
    return (await git('rev-parse', 'HEAD')).stdout.trim();
  }
  missingUserInput = { ...fixtureInput, baseSha: await commit(fixtureInput.baseSha, 'Return a missing user'),
    headSha: await commit(fixtureInput.headSha, 'Throw on a missing user') };
  missingUser = new GitSnapshotAdapter(missingUserDirectory, missingUserInput);
}
const source =
  'export function paginate(items: number[], start: number, size: number) {\n  const end = start + size - 1;\n  return items.slice(start, end);\n}\n';
const hunk =
  '@@ -1,4 +1,4 @@\n export function paginate(items: number[], start: number, size: number) {\n-  const end = start + size;\n+  const end = start + size - 1;\n   return items.slice(start, end);\n }';
const clients: GitHubClientFactory = (scope, assertAccess) => ({
  async pullRequest(number) {
    await assertAccess();
    return {
      repositoryId: scope.repositoryId,
      number,
      title: number === missingUserPR ? 'Change missing-user lookup' : 'Fix pagination boundary',
      baseSha: number === missingUserPR ? missingUserInput.baseSha : baseSha,
      headSha: number === missingUserPR ? missingUserInput.headSha : targetHead,
      state: 'open',
      draft: false,
    };
  },
  async compare(base, head) {
    await assertAccess();
    if (head === missingUserInput.headSha) return missingUser.changedFiles(base, head);
    return [{ path: 'src/paginate.ts', hunk, status: 'modified' }];
  },
  async file(sha, path) {
    await assertAccess();
    if (path !== 'src/paginate.ts') return missingUser.fileAt(sha, path);
    return source;
  },
  async sourceTree(sha) {
    await assertAccess();
    return missingUser.sourceTreeAt(sha);
  },
});
const gateway: DashboardGitHub = {
  async exchange() {
    return { token: currentLogin, expiresIn: 3600 };
  },
  async identity(token) {
    return { id: token === 'maintainer' ? '1' : '2', login: token };
  },
  async repositories(token) {
    return userAccess
      ? [
          {
            id: '200',
            installationId: '100',
            owner: 'acme',
            name: 'pagination',
            maintainer: token === 'maintainer',
            canPublish: true,
          },
        ]
      : [];
  },
};
let maintainer: { cookie: string; csrf: string },
  member: { cookie: string; csrf: string },
  runId: string,
  findingId: string;
async function login(login: string) {
  currentLogin = login;
  const begin = await fetch(`${origin}/auth/github`, { redirect: 'manual' });
  const state = new URL(begin.headers.get('location')!).searchParams.get(
    'state',
  )!;
  const callback = await fetch(
    `${origin}/auth/github/callback?state=${encodeURIComponent(state)}&code=test-code`,
    {
      redirect: 'manual',
      headers: { cookie: begin.headers.getSetCookie()[0]!.split(';')[0]! },
    },
  );
  expect(callback.status).toBe(302);
  const cookie = callback.headers
    .getSetCookie()
    .find((item) => item.startsWith('opticpr_session='))!
    .split(';')[0]!;
  const session = await fetch(`${origin}/api/session`, { headers: { cookie } });
  expect(session.status).toBe(200);
  return { cookie, csrf: (await session.json()).csrfToken as string };
}
function write(
  path: string,
  body: unknown,
  user = maintainer,
  extra: Record<string, string> = {},
) {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      cookie: user.cookie,
      origin,
      'x-csrf-token': user.csrf,
      'content-type': 'application/json',
      ...extra,
    },
    body: JSON.stringify(body),
  });
}
async function inspect(id = runId, user = maintainer) {
  const response = await fetch(`${origin}/api/runs/${id}`, {
    headers: { cookie: user.cookie },
  });
  expect(response.status).toBe(200);
  return runDetailSchema.parse(await response.json());
}
beforeAll(async () => {
  process.env.MODEL_ENRICHMENT_ENABLED = '1';
  await prepareMissingUser();
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${namespace}"`);
  const migrations = new URL(
    '../packages/database/prisma/migrations/',
    import.meta.url,
  );
  for (const name of (await readdir(migrations))
    .filter((name) => /^\d/.test(name))
    .sort()) {
    for (const statement of (
      await readFile(new URL(`${name}/migration.sql`, migrations), 'utf8')
    )
      .split(';')
      .map((value) => value.trim())
      .filter(Boolean))
      await db.$executeRawUnsafe(statement);
  }
  await db.gitHubInstallation.create({ data: { id: '100' } });
  await db.gitHubRepository.createMany({
    data: [
      { id: '200', installationId: '100', owner: 'acme', name: 'pagination' },
      { id: '201', installationId: '100', owner: 'acme', name: 'secret' },
    ],
  });
  queue = createQueue(namespace);
  await queue.waitUntilReady();
  dispatcher = createDispatcher(db, queue, clients);
  worker = createWorker(db, namespace, clients, {
    scanner: async (files) => files.some(file => file.path === usersPath) ? scanSemgrep(files) : ({
      errors: 0,
      scanned: files.map((file) => file.path),
      matches: [
        {
          path: 'src/paginate.ts',
          startLine: 2,
          endLine: 3,
          ruleId: 'opticpr.slice-exclusive-boundary',
          severity: 'high',
          message: 'Final item excluded from the page',
        },
      ],
    }),
    inference: async () => {
      if (modelFails) throw new Error('Model offline');
      return '{"candidates":[]}';
    },
  });
  await worker.waitUntilReady();
  const scope = await repositoryScope(db, '100', '200');
  const target = await db.$transaction(async (tx) => {
    await lockPullRequest(tx, scope, 42);
    return observeLiveTarget(
      tx,
      scope,
      42,
      clients(scope, async () => {}),
    );
  });
  runId = target!.run.id;
  await dispatcher.tick();
  await waitForReport(db, runId);
  server = createApp(db, {
    dashboard: {
      origin: 'http://127.0.0.1:1',
      secret: 'dashboard-integration-secret-32-characters',
      clientId: 'client',
      clientSecret: 'secret',
    },
    github: gateway,
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  origin = `http://127.0.0.1:${address.port}`;
  // CSRF origin is fixed in the configured origin; use a second app with its assigned port.
  await new Promise<void>((resolve) => server.close(() => resolve()));
  server = createApp(db, {
    dashboard: {
      origin,
      secret: 'dashboard-integration-secret-32-characters',
      clientId: 'client',
      clientSecret: 'secret',
    },
    github: gateway,
    webDirectory: fileURLToPath(new URL('../apps/web/dist/', import.meta.url)),
  }).listen(address.port, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  maintainer = await login('maintainer');
  member = await login('member');
  findingId = (await inspect()).report!.history!.findings[0]!.findingId;
}, 30000);

it('serves worker-generated cross-file evidence through the authenticated dashboard', async () => {
  const scope = await repositoryScope(db, '100', '200');
  process.env.MODEL_ENRICHMENT_ENABLED = '0';
  let id: string;
  try {
    const target = await db.$transaction(async tx => {
      await lockPullRequest(tx, scope, missingUserPR);
      return observeLiveTarget(tx, scope, missingUserPR, clients(scope, async () => {}));
    });
    id = target!.run.id;
    await dispatcher.tick();
    await waitForReport(db, id);
  } finally { process.env.MODEL_ENRICHMENT_ENABLED = '1'; }
  const data = await inspect(id, member);
  expect(data.pullRequest.latestRunId).toBe(id);
  expect(data.report!.coverage.status).toBe('complete');
  const [finding] = data.report!.findings;
  expect(data.report!.findings).toHaveLength(1);
  expect(finding!.citations?.map(citation => [citation.role, citation.evidence.path, citation.evidence.revision])).toEqual([
    ['changed-throw', usersPath, missingUserInput.headSha], ['caller-fallback', routePath, missingUserInput.headSha], ['base-return', usersPath, missingUserInput.baseSha],
  ]);
  expect(await db.inlinePublication.findMany({ where: { runId: id }, select: { path: true, line: true, state: true } })).toEqual([
    { path: usersPath, line: 4, state: 'pending' },
  ]);

  if (process.env.OPTICPR_TEST_LIVE_BROWSER !== '1') return;
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.addCookies([{ name: 'opticpr_session', value: member.cookie.split('=')[1]!, url: origin }]);
    const page = await context.newPage();
    const runResponse = page.waitForResponse(response => response.url() === `${origin}/api/runs/${id}` && response.ok());
    await page.goto(`${origin}/runs/${id}?finding=${finding!.id}`);
    expect((await (await runResponse).json()).report.findings[0].citations).toEqual(finding!.citations);
    const link = page.getByRole('link', { name: 'View source' });
    const verify = async (side: string, expected: string, sha: string, path: string, lines: string) => {
      const pane = page.getByRole('region', { name: new RegExp(`Evidence at ${side} lines`) });
      await pane.waitFor();
      expect(await pane.innerText()).toContain(expected);
      expect(await link.getAttribute('href')).toBe(`https://github.com/acme/pagination/blob/${sha}/${path}#${lines}`);
    };
    await verify('head', 'throw new Error', missingUserInput.headSha, usersPath, 'L4-L4');
    await page.getByRole('button', { name: 'Caller fallback' }).click();
    await verify('head', 'return { status: 404 }', missingUserInput.headSha, routePath, 'L3-L4');
    await page.getByRole('button', { name: 'Previous return' }).click();
    await verify('base', 'return undefined', missingUserInput.baseSha, usersPath, 'L4-L4');
    await page.getByRole('button', { name: 'Caller fallback' }).click();
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ path: 'output/09-live-dashboard.png', fullPage: true, animations: 'disabled' });
  } finally { await browser.close(); }
}, 30000);
afterAll(async () => {
  delete process.env.MODEL_ENRICHMENT_ENABLED;
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await worker?.close();
  await dispatcher?.close();
  await queue?.obliterate({ force: true });
  await queue?.close();
  await db.$disconnect();
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
  await admin.$disconnect();
  if (missingUserDirectory) await rm(missingUserDirectory, { recursive: true, force: true });
}, 30000);

it('checks OAuth state, sets HttpOnly cookies and stores encrypted credentials', async () => {
  const bad = await fetch(
    `${origin}/auth/github/callback?code=x&state=forged`,
    { redirect: 'manual' },
  );
  expect(bad.status).toBe(400);
  const begin = await fetch(`${origin}/auth/github`, { redirect: 'manual' });
  expect(begin.headers.getSetCookie()[0]).toContain('HttpOnly');
  expect(begin.headers.getSetCookie()[0]).toContain('SameSite=Lax');
  const stored = await db.dashboardSession.findFirstOrThrow({
    where: { login: 'maintainer' },
  });
  expect(stored.credential).not.toContain('maintainer');
  expect(stored.id).not.toContain(maintainer.cookie.split('=')[1]);
});
it('preserves a safe deep link through sign-in and rejects external return destinations', async () => {
  for (const [returnTo, destination] of [
    [
      `/runs/${runId}?finding=${findingId}`,
      `/runs/${runId}?finding=${findingId}`,
    ],
    ['https://attacker.example', '/repos'],
    ['//attacker.example', '/repos'],
  ]) {
    const begin = await fetch(
      `${origin}/auth/github?returnTo=${encodeURIComponent(returnTo!)}`,
      { redirect: 'manual' },
    );
    const state = new URL(begin.headers.get('location')!).searchParams.get(
      'state',
    )!;
    const response = await fetch(
      `${origin}/auth/github/callback?state=${encodeURIComponent(state)}&code=valid`,
      {
        redirect: 'manual',
        headers: { cookie: begin.headers.getSetCookie()[0]!.split(';')[0]! },
      },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(destination);
  }
});
it('serves only accessible repositories and reads the current summary through latestRunId', async () => {
  expect((await fetch(`${origin}/api/repos`)).status).toBe(401);
  expect((await fetch(`${origin}/api/runs/${runId}`)).status).toBe(401);
  const repos = await (
    await fetch(`${origin}/api/repos`, { headers: { cookie: member.cookie } })
  ).json();
  expect(repos.repositories.map((repo: { id: string }) => repo.id)).toEqual([
    '200',
  ]);
  const list = await fetch(`${origin}/api/repos/200/prs?page=1`, {
    headers: { cookie: member.cookie },
  });
  const body = pullRequestListSchema.parse(await list.json());
  const pagination = body.items.find(item => item.number === 42);
  expect(pagination!.latestRunId).toBe(runId);
  expect(pagination!.latestRun!.coverage).toBe('partial');
  const report = await inspect(runId, member);
  expect(report.repository.role).toBe('member');
  expect(report.report!.findings[0]!.evidence).toMatchObject({
    revision: headSha,
    startLine: 2,
    hunk,
  });
  expect(
    (
      await fetch(`${origin}/api/repos/200/prs?page=bad`, {
        headers: { cookie: member.cookie },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await fetch(`${origin}/api/repos/200/prs?page=2`, {
        headers: { cookie: member.cookie },
      })
    ).status,
  ).toBe(200);
  const session = await db.dashboardSession.findFirstOrThrow({
    where: { login: 'member' },
  });
  await db.dashboardSession.update({
    where: { id: session.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  expect(
    (await fetch(`${origin}/api/repos`, { headers: { cookie: member.cookie } }))
      .status,
  ).toBe(401);
  member = await login('member');
});
it('rejects guessed child IDs, revoked user access and inactive installation grants', async () => {
  const original = await db.reviewRun.findUniqueOrThrow({
    where: { id: runId },
  });
  const secret = await db.reviewRun.create({
    data: {
      source: 'github',
      state: 'failed',
      repositoryId: '201',
      pullRequestNumber: 42,
      baseSha,
      headSha,
      logicalKey: 'f'.repeat(64),
      configurationDigest: original.configurationDigest,
      configuration: githubConfig,
    },
  });
  expect(
    (
      await fetch(`${origin}/api/runs/${secret.id}`, {
        headers: { cookie: member.cookie },
      })
    ).status,
  ).toBe(404);
  userAccess = false;
  try {
    expect(
      (
        await fetch(`${origin}/api/runs/${runId}`, {
          headers: { cookie: maintainer.cookie },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await write(`/api/runs/${runId}/retry`, {
          id: randomUUID(),
          reason: 'Retry',
        })
      ).status,
    ).toBe(404);
  } finally {
    userAccess = true;
  }
  await db.gitHubInstallation.update({
    where: { id: '100' },
    data: { active: false },
  });
  try {
    expect(
      (
        await fetch(`${origin}/api/runs/${runId}`, {
          headers: { cookie: member.cookie },
        })
      ).status,
    ).toBe(404);
  } finally {
    await db.gitHubInstallation.update({
      where: { id: '100' },
      data: { active: true },
    });
  }
});
it('requires maintainer permissions, same-origin CSRF protection and a validated reason for every mutation', async () => {
  const decision = {
    id: randomUUID(),
    runId,
    action: 'dismiss',
    reason: 'Known fixture behavior',
  };
  expect(
    (await write(`/api/findings/${findingId}/decisions`, decision, member))
      .status,
  ).toBe(403);
  expect(
    (
      await write(
        `/api/runs/${runId}/retry`,
        { id: randomUUID(), reason: 'Retry' },
        member,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await write(
        `/api/findings/${findingId}/decisions`,
        decision,
        maintainer,
        { 'x-csrf-token': '' },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await write(
        `/api/runs/${runId}/retry`,
        { id: randomUUID(), reason: 'Retry' },
        maintainer,
        { origin: 'https://attacker.example' },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await write(`/api/findings/${findingId}/decisions`, {
        ...decision,
        reason: ' ',
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await write(`/api/findings/${findingId}/decisions`, {
        ...decision,
        actor: 'forged',
      })
    ).status,
  ).toBe(400);
  expect(await db.findingDecision.count()).toBe(0);
  expect(await db.reviewRetry.count()).toBe(0);
});
it('appends decisions with server identity, preserves history and handles duplicate requests', async () => {
  const decision = {
    id: randomUUID(),
    runId,
    action: 'dismiss',
    reason: 'Accepted limitation for this example',
  };
  expect(
    (await write(`/api/findings/${findingId}/decisions`, decision)).status,
  ).toBe(201);
  expect(
    (await write(`/api/findings/${findingId}/decisions`, decision)).status,
  ).toBe(201);
  expect(
    (
      await write(`/api/findings/${findingId}/decisions`, {
        ...decision,
        reason: 'Changed',
      })
    ).status,
  ).toBe(409);
  expect((await inspect()).decisions).toMatchObject([
    { action: 'dismiss', actor: 'maintainer', reason: decision.reason },
  ]);
  expect(
    (
      await write(`/api/findings/${findingId}/decisions`, {
        ...decision,
        id: randomUUID(),
        action: 'reopen',
        reason: 'Check the next revision',
      })
    ).status,
  ).toBe(201);
  expect((await inspect()).decisions.map((item) => item.action)).toEqual([
    'dismiss',
    'reopen',
  ]);
});
it('runs an audited partial-review retry through the worker, preserving the original snapshot and pointer until completion', async () => {
  const original = await inspect();
  const input = {
    id: randomUUID(),
    reason: 'Model recovered; verify the full review',
  };
  const response = await write(`/api/runs/${runId}/retry`, input);
  expect(response.status).toBe(202);
  const audit = await response.json();
  expect((await inspect()).pullRequest!.latestRunId).toBe(runId);
  expect((await inspect()).pullRequest!.desiredRun!.id).toBe(audit.runId);
  expect((await write(`/api/runs/${runId}/retry`, input)).status).toBe(202);
  expect(
    (await write(`/api/runs/${runId}/retry`, { ...input, id: randomUUID() }))
      .status,
  ).toBe(409);
  modelFails = false;
  await dispatcher.tick();
  await waitForReport(db, audit.runId);
  const retried = await inspect(audit.runId);
  expect(retried.attempt).toBe(1);
  expect(retried.report!.coverage.status).toBe('complete');
  expect(retried.configurationDigest).toBe(original.configurationDigest);
  expect(retried.pullRequest!.latestRunId).toBe(audit.runId);
  expect(retried.retries[0]).toMatchObject({
    actor: 'maintainer',
    reason: input.reason,
  });
  expect((await inspect()).report).toEqual(original.report);
  expect(retried.report!.history!.findings[0]!.findingId).toBe(findingId);
  // Re-observing live target cannot silently reset the requested attempt.
  const scope = await repositoryScope(db, '100', '200');
  await db.$transaction(async (tx) => {
    await lockPullRequest(tx, scope, 42);
    await observeLiveTarget(
      tx,
      scope,
      42,
      clients(scope, async () => {}),
    );
  });
  expect((await inspect()).pullRequest!.latestRunId).toBe(audit.runId);
});
it('keeps a newer target visible when inspecting old evidence and logs out with CSRF', async () => {
  targetHead = 'c'.repeat(40);
  const scope = await repositoryScope(db, '100', '200');
  await db.$transaction(async (tx) => {
    await lockPullRequest(tx, scope, 42);
    await observeLiveTarget(
      tx,
      scope,
      42,
      clients(scope, async () => {}),
    );
  });
  const original = await inspect();
  expect(original.headSha).toBe(headSha);
  expect(original.pullRequest!.headSha).toBe(targetHead);
  expect(
    (await write('/api/logout', {}, member, { 'x-csrf-token': '' })).status,
  ).toBe(403);
  expect((await write('/api/logout', {}, member)).status).toBe(204);
  expect(
    (
      await fetch(`${origin}/api/session`, {
        headers: { cookie: member.cookie },
      })
    ).status,
  ).toBe(401);
});
