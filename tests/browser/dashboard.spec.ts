import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';
import {
  githubConfig,
  type RunDetail,
  type DashboardRepository,
} from '../../packages/contracts/src/index.js';

const runId = '11111111-1111-4111-8111-111111111111',
  priorId = '22222222-2222-4222-8222-222222222222',
  findingId = '33333333-3333-4333-8333-333333333333',
  retryId = '44444444-4444-4444-8444-444444444444';
const stamp = '2026-11-17T14:02:00.000Z';
const repository: DashboardRepository = {
  id: '200',
  owner: 'acme',
  name: 'pagination',
  installationId: '12084',
  role: 'maintainer',
  canPublish: true,
  lastEventAt: stamp,
};
const baseSha = 'a'.repeat(40),
  headSha = 'b'.repeat(40);
const evidence = {
  revision: headSha,
  path: 'src/utils/paginate.ts',
  startLine: 3,
  endLine: 4,
  excerpt:
    '  const end = start + pageSize - 1;\n  return items.slice(start, end);',
  hunk: '@@ -1,5 +1,5 @@\n export function paginate(items, page, pageSize) {\n   const start = (page - 1) * pageSize;\n-  const end = start + pageSize;\n+  const end = start + pageSize - 1;\n   return items.slice(start, end);\n }',
};
function fixture(): RunDetail {
  const summary = {
    id: runId,
    baseSha,
    headSha,
    state: 'completed',
    attempt: 0,
    createdAt: stamp,
    completedAt: stamp,
    coverage: 'partial' as const,
    findings: 2,
  };
  const finding = {
    id: findingId,
    source: 'github' as const,
    ruleId: 'opticpr.slice-exclusive-boundary',
    severity: 'high' as const,
    title: 'Final item excluded from the page',
    impact:
      'The exclusive end index is reduced by one, so every page drops its final item. A page size of one returns an empty array.',
    verification:
      'Compare paginate([1, 2, 3], 1, 3) with the expected [1, 2, 3]. Add a boundary test for a page size of one.',
    evidence,
    identity: {
      kind: 'static' as const,
      class: 'boundary',
      expression: 'start + pageSize - 1',
      symbol: 'paginate',
    },
    citations: [
      {
        kind: 'static' as const,
        ruleId: 'opticpr.slice-exclusive-boundary',
        evidence,
      },
      { kind: 'model' as const, ruleId: 'boundary-review', evidence },
    ],
  };
  const history = [
    {
      findingId,
      state: 'new' as const,
      reason: 'First observation of this condition.',
      observation: finding,
      lastObservation: finding,
      lastObservedRunId: runId,
      lastObservedConfigurationDigest: 'c'.repeat(64),
      previous: { runId: priorId, findingId },
    },
    {
      findingId: '55555555-5555-4555-8555-555555555555',
      state: 'still_present' as const,
      reason: 'Unambiguous condition and file mapping.',
      observation: {
        ...finding,
        id: '55555555-5555-4555-8555-555555555555',
        severity: 'medium' as const,
        title: 'Unbounded page size can exhaust memory',
      },
      lastObservation: finding,
      lastObservedRunId: runId,
      lastObservedConfigurationDigest: 'c'.repeat(64),
    },
    {
      findingId: '66666666-6666-4666-8666-666666666666',
      state: 'needs_verification' as const,
      reason: 'Model observation missing from this incomplete scan.',
      lastObservation: {
        ...finding,
        severity: 'low' as const,
        title: 'Invalid page input may skip validation',
      },
      lastObservedRunId: priorId,
      lastObservedConfigurationDigest: 'c'.repeat(64),
      previous: { runId: priorId, findingId },
    },
    {
      findingId: '77777777-7777-4777-8777-777777777777',
      state: 'cleared_by_recheck' as const,
      reason: 'The same rule fully rechecked this file.',
      lastObservation: {
        ...finding,
        title: 'Empty input previously returned undefined',
      },
      lastObservedRunId: priorId,
      lastObservedConfigurationDigest: 'c'.repeat(64),
    },
  ];
  return {
    ...summary,
    repository,
    configurationDigest: 'c'.repeat(64),
    error: null,
    pullRequest: {
      number: 42,
      title: 'Fix pagination boundary handling',
      baseSha,
      headSha,
      eligible: true,
      latestRunId: runId,
      latestRun: summary,
      desiredRun: summary,
      publicationState: 'published',
      updatedAt: stamp,
    },
    revisions: [
      summary,
      {
        ...summary,
        id: priorId,
        headSha: 'd'.repeat(40),
        createdAt: '2026-11-16T14:02:00.000Z',
      },
    ],
    decisions: [],
    retries: [],
    report: {
      schemaVersion: 1,
      runId,
      logicalKey: 'c'.repeat(64),
      input: {
        source: 'github',
        repositoryId: '200',
        pullRequestNumber: 42,
        baseSha,
        headSha,
      },
      configuration: githubConfig,
      configurationDigest: 'c'.repeat(64),
      source: 'github',
      stages: [
        {
          name: 'repository',
          status: 'completed',
          source: 'github',
          version: 'github-rest-v1',
          detail: 'Read exact SHA-addressed source.',
        },
        {
          name: 'semgrep',
          status: 'completed',
          source: 'github',
          version: '1.144.0',
          detail: 'Pinned JavaScript and TypeScript rules completed.',
        },
        {
          name: 'model',
          status: 'failed',
          source: 'github',
          version: 'qwen2.5-coder:7b',
          detail: 'Model timed out. Static findings are preserved.',
        },
      ],
      coverage: {
        status: 'partial',
        scope: 'local-js-ts',
        changedFiles: [
          'src/utils/paginate.ts',
          'src/api/pages.ts',
          'test/paginate.test.ts',
          'dist/generated.js',
        ],
        analyzedFiles: [
          'src/utils/paginate.ts',
          'src/api/pages.ts',
          'test/paginate.test.ts',
        ],
        skippedFiles: [
          {
            path: 'dist/generated.js',
            reason: 'Generated code excluded from analysis',
          },
        ],
        detail:
          'The static checks completed. Model analysis timed out; its previous observations require verification.',
      },
      findings: [finding, history[1]!.observation!],
      history: { previousRunId: priorId, findings: history },
      comparison: [{ path: evidence.path, hunk: evidence.hunk }],
    },
  };
}
async function mock(
  page: Page,
  options: {
    member?: boolean;
    empty?: boolean;
    clean?: boolean;
    active?: boolean;
    denied?: boolean;
  } = {},
) {
  let data = fixture();
  let runReads = 0;
  if (options.member) data.repository = { ...repository, role: 'member' };
  if (options.clean) {
    data.report!.findings = [];
    data.report!.history!.findings = [];
    data.report!.coverage.status = 'complete';
    data.report!.coverage.skippedFiles = [];
    data.report!.stages[2]!.status = 'completed';
    data.coverage = 'complete';
    data.findings = 0;
  }
  if (options.active) {
    data.state = 'running';
    data.report = null;
    data.coverage = null;
    data.pullRequest!.desiredRun = { ...data.revisions[0]!, state: 'running' };
  }
  const writes: { path: string; body: any; csrf: string | undefined }[] = [];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const request = route.request();
    if (request.method() === 'POST') {
      const body = request.postDataJSON();
      writes.push({ path, body, csrf: request.headers()['x-csrf-token'] });
      if (path.endsWith('/decisions'))
        data.decisions.push({
          ...body,
          findingId,
          actor: 'raj',
          createdAt: stamp,
          sequence: data.decisions.length + 1,
        });
      if (path.endsWith('/retry')) {
        data.retries.push({
          ...body,
          sourceRunId: runId,
          runId: retryId,
          actor: 'raj',
          createdAt: stamp,
        });
        data.pullRequest!.desiredRun = {
          ...data.revisions[0]!,
          id: retryId,
          state: 'queued',
          attempt: 1,
        };
      }
      await route.fulfill({ json: { runId: retryId }, status: 201 });
      return;
    }
    if (path === '/api/session') {
      await route.fulfill({
        json: { user: { id: '1', login: 'raj' }, csrfToken: 'test-csrf-token' },
      });
      return;
    }
    if (path === '/api/repos') {
      await route.fulfill({
        json: {
          repositories: options.empty
            ? []
            : [
                data.repository,
                {
                  ...repository,
                  id: '201',
                  name: 'api-service',
                  role: 'member',
                },
                {
                  ...repository,
                  id: '202',
                  owner: 'open-source',
                  name: 'design-system',
                  canPublish: false,
                },
              ],
          installationUrl: 'https://github.com/apps/opticpr/installations/new',
        },
      });
      return;
    }
    if (path.includes('/prs')) {
      await route.fulfill({
        json: {
          repository,
          items: options.empty ? [] : [data.pullRequest],
          page: 1,
          pageSize: 20,
          total: options.empty ? 0 : 1,
          hasActive: false,
        },
      });
      return;
    }
    if (path.startsWith('/api/runs/')) {
      runReads++;
      if (options.denied) {
        await route.fulfill({
          status: 404,
          json: { error: 'Repository access was removed.' },
        });
        return;
      }
      if (options.active && runReads >= 2) {
        data = fixture();
      }
      const result = structuredClone(data);
      if (path.endsWith(priorId)) {
        result.id = priorId;
        result.headSha = 'd'.repeat(40);
        result.report!.input.headSha = result.headSha;
      }
      await route.fulfill({ json: result });
      return;
    }
    await route.fulfill({ status: 404, json: { error: 'Not found' } });
  });
  return { writes, reads: () => runReads };
}

test('polished review links claims to exact evidence, supports keyboard revision switching, and keeps the selected revision on refresh', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mock(page);
  await page.goto(`/runs/${runId}?finding=${findingId}`);
  await expect(
    page.getByRole('heading', { name: 'Fix pagination boundary handling' }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: /Source hunk at bbbbbbb/ }),
  ).toContainText('start + pageSize - 1');
  await expect(page.getByRole('link', { name: /View source/ })).toHaveAttribute(
    'href',
    /blob\/bbbbbbbb.*#L3-L4/,
  );
  await expect(
    page.getByText('Needs verification', { exact: false }).first(),
  ).toBeVisible();
  await expect(
    page.getByText('Still present', { exact: false }).first(),
  ).toBeVisible();
  await page.screenshot({
    path: 'test-results/dashboard-review.png',
    fullPage: true,
    animations: 'disabled',
  });
  const select = page.getByLabel('Revision', { exact: true });
  await select.focus();
  await select.press('ArrowDown');
  await expect(page).toHaveURL(new RegExp(priorId));
  await page.reload();
  await expect(page.getByLabel('Revision', { exact: true })).toHaveValue(
    priorId,
  );
  await expect(page).toHaveURL(new RegExp(`finding=${findingId}`));
  expect(errors).toEqual([]);
});
test('maintainer dismisses, reopens and retries with reasons while preserving revision and audit history', async ({
  page,
}) => {
  const { writes } = await mock(page);
  await page.goto(`/runs/${runId}?finding=${findingId}`);
  await page
    .getByRole('button', { name: 'Dismiss finding', exact: true })
    .click();
  await page
    .getByLabel('Reason', { exact: false })
    .fill('Accepted until the next release');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Dismiss finding', exact: true })
    .click();
  await expect(page.getByText('Accepted until the next release')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Reopen finding' }),
  ).toBeFocused();
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Reopen finding' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Reopen finding' }).click();
  await page
    .getByLabel('Reason', { exact: false })
    .fill('Ready to address this now');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Reopen finding', exact: true })
    .click();
  await page.getByRole('button', { name: 'Retry review' }).click();
  await page
    .getByLabel('Reason', { exact: false })
    .fill('Model is available again');
  await page.getByRole('button', { name: 'Queue review' }).click();
  await expect(
    page.getByText('A fresh review is queued.', { exact: false }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(runId));
  await expect(
    page.getByRole('button', { name: 'Retry review' }),
  ).toBeDisabled();
  expect(writes.map((write) => write.body.action ?? 'retry')).toEqual([
    'dismiss',
    'reopen',
    'retry',
  ]);
  expect(writes.every((write) => write.csrf === 'test-csrf-token')).toBe(true);
});
test('members see evidence and history without maintainer writes, including retained prior observations', async ({
  page,
}) => {
  await mock(page, { member: true });
  await page.goto(`/runs/${runId}`);
  await expect(page.getByRole('button', { name: 'Retry review' })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('button', { name: 'Dismiss finding' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: /Needs verification 1/ }).click();
  await expect(
    page.getByText('Retained evidence from', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: /Previous observation/ }),
  ).toHaveAttribute('href', new RegExp(priorId));
});
test('repository list, PR navigation, search, and empty repositories have distinct usable screens', async ({
  page,
}) => {
  await mock(page);
  await page.goto('/repos');
  await expect(
    page.getByRole('heading', { name: /Repositories/, level: 1 }),
  ).toBeVisible();
  await page.screenshot({
    path: 'test-results/dashboard-repositories.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByLabel('Find a repository').fill('pagination');
  await expect(page.getByRole('heading', { name: 'api-service' })).toHaveCount(
    0,
  );
  await page.getByRole('link', { name: /pagination.*Explore reviews/ }).click();
  await page
    .getByRole('link', { name: 'Fix pagination boundary handling' })
    .click();
  await expect(page).toHaveURL(new RegExp(runId));
});
test('clean scans and access loss explain their actual state', async ({
  page,
}) => {
  await mock(page, { clean: true });
  await page.goto(`/runs/${runId}`);
  await expect(
    page.getByRole('heading', {
      name: 'A clear review, within the analyzed scope',
    }),
  ).toBeVisible();
  await page.unrouteAll();
  await mock(page, { denied: true });
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'This review is out of reach' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Final item excluded from the page' }),
  ).toHaveCount(0);
});
test('empty installation and empty repository explain how reviews arrive', async ({
  page,
}) => {
  await mock(page, { empty: true });
  await page.goto('/repos');
  await expect(
    page.getByRole('heading', { name: /first repository/ }),
  ).toBeVisible();
  await page.goto('/repos/200');
  await expect(
    page.getByRole('heading', { name: 'A fresh start, ready for review' }),
  ).toBeVisible();
});
test('polling finishes after the active review reaches a terminal outcome', async ({
  page,
}) => {
  const mockState = await mock(page, { active: true });
  await page.goto(`/runs/${runId}`);
  await expect(
    page.getByRole('heading', { name: 'Bringing this revision into focus' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', {
      name: 'Final item excluded from the page',
      exact: true,
    }),
  ).toBeVisible({ timeout: 10000 });
  const reads = mockState.reads();
  await page.waitForTimeout(4600);
  expect(mockState.reads()).toBe(reads);
});
test('mobile review fits the viewport and retains usable navigation and evidence', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mock(page);
  await page.goto(`/runs/${runId}`);
  await expect(
    page.getByRole('heading', {
      name: 'Final item excluded from the page',
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: 'test-results/dashboard-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(
    page.getByRole('navigation', { name: 'Main navigation' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Close navigation', exact: true })
    .first()
    .click();
});

test('review meets automated accessibility checks', async ({ page }) => {
  await mock(page);
  await page.goto(`/runs/${runId}`);
  await expect(
    page.getByRole('heading', {
      name: 'Final item excluded from the page',
      exact: true,
    }),
  ).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      nodes: violation.nodes.map((node) => ({
        target: node.target,
        summary: node.failureSummary,
      })),
    })),
  ).toEqual([]);
});

test('expired GitHub authorization clears private data without a request loop', async ({
  page,
}) => {
  await mock(page);
  let reads = 0;
  await page.route('**/api/runs/**', async (route) => {
    reads++;
    await route.fulfill({
      status: 401,
      json: { error: 'GitHub authorization expired' },
    });
  });
  await page.goto(`/runs/${runId}`);
  await expect(
    page.getByRole('link', { name: /Continue with GitHub/ }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', {
      name: 'Final item excluded from the page',
      exact: true,
    }),
  ).toHaveCount(0);
  await page.waitForTimeout(1000);
  expect(reads).toBe(1);
  await expect(
    page.getByRole('link', { name: /Continue with GitHub/ }),
  ).toHaveAttribute('href', new RegExp(`returnTo=.*${runId}`));
});
test('repository list, sign-in, coverage details, and decision dialog pass accessibility checks', async ({
  page,
}) => {
  await mock(page);
  await page.goto('/repos');
  await expect(
    page.getByRole('heading', { name: /Repositories/, level: 1 }),
  ).toBeVisible();
  for (const view of ['repositories', 'details', 'dialog', 'sign-in']) {
    if (view === 'details') {
      await page.goto(`/runs/${runId}`);
      await page.getByText('Coverage & stage details', { exact: true }).click();
    }
    if (view === 'dialog') {
      await page
        .getByRole('button', { name: 'Dismiss finding', exact: true })
        .click();
    }
    if (view === 'sign-in') {
      await page.unrouteAll();
      await page.route('**/api/session', (route) =>
        route.fulfill({ status: 401, json: { error: 'Sign in' } }),
      );
      await page.goto('/');
      await expect(
        page.getByRole('link', { name: /Continue with GitHub/ }),
      ).toBeVisible();
      await page.screenshot({
        path: 'test-results/dashboard-signin.png',
        fullPage: true,
        animations: 'disabled',
      });
    }
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      result.violations.map((item) => ({
        id: item.id,
        view,
        nodes: item.nodes.map((node) => ({
          target: node.target,
          summary: node.failureSummary,
        })),
      })),
    ).toEqual([]);
  }
});

test('missing GitHub configuration explains setup and disables unavailable sign-in', async ({
  page,
}) => {
  await page.route('**/api/session', (route) =>
    route.fulfill({
      status: 503,
      json: {
        error:
          'GitHub sign-in is not configured. Set the dashboard environment variables.',
        code: 'AUTH_NOT_CONFIGURED',
      },
    }),
  );
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'One GitHub App. Then you’re in.' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'GitHub connection needs setup' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('link', { name: /Continue with GitHub/ }),
  ).toHaveCount(0);
  await expect(
    page.getByText('GITHUB_CLIENT_ID', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'your GitHub Apps' }),
  ).toHaveAttribute('href', 'https://github.com/settings/apps');
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(results.violations.map((item) => item.id)).toEqual([]);
  await page.screenshot({
    path: 'test-results/dashboard-setup.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('motion can be paused, persists across refresh, and resumes without hiding content', async ({
  page,
}) => {
  await mock(page);
  await page.goto('/repos');
  await page.getByRole('button', { name: 'Pause animations' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'off');
  await expect(
    page.getByRole('heading', { name: 'pagination', exact: true }),
  ).toBeVisible();
  expect(
    await page
      .locator('.orbit-object')
      .evaluate((element) => getComputedStyle(element).animationName),
  ).toBe('none');
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Enable animations' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Enable animations' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'on');
  expect(
    await page
      .locator('.orbit-object')
      .evaluate((element) => getComputedStyle(element).animationName),
  ).toBe('orbital-drift');
});
test('system reduced-motion preference is respected in the new hero and cards', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mock(page);
  await page.goto('/repos');
  await expect(
    page.getByRole('button', {
      name: 'Animations disabled by system preference',
    }),
  ).toBeDisabled();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'off');
  await expect(
    page.getByRole('heading', { name: 'pagination', exact: true }),
  ).toBeVisible();
  expect(
    await page
      .locator('.signal-marquee>div')
      .evaluate((element) => getComputedStyle(element).animationName),
  ).toBe('none');
});
test('the redesigned workspace fits mobile and tablet viewports', async ({
  page,
}) => {
  await mock(page);
  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/repos');
    await expect(
      page.getByRole('heading', { name: /Repositories/, level: 1 }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.locator('#repositories').scrollIntoViewIfNeeded();
    await expect(
      page.getByRole('heading', { name: 'pagination', exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: `test-results/workspace-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  }
});
