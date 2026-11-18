import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect } from '@playwright/test';
import { demoReplaySchema, type DemoReplay } from '../../packages/contracts/src/index.js';

let server: Server;
let origin: string;
let replay: DemoReplay;
test.beforeAll(async () => {
  const { createDemoApp } = await import('../../apps/api/dist/demo.js');
  server = (await createDemoApp()).listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Demo address unavailable');
  origin = `http://127.0.0.1:${address.port}`;
  replay = demoReplaySchema.parse(JSON.parse(await readFile('fixtures/review-demo/replay.json', 'utf8')));
});
test.afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
});

test('opens the recorded regression, fix and prior evidence without signing in', async ({ page }) => {
  const apiPaths = new Set<string>();
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) apiPaths.add(url.pathname);
  });
  const { regression, fix } = replay;
  await page.goto(origin);
  await expect(page.getByRole('heading', { name: 'Missing-user regression' })).toBeVisible();
  await expect(page.getByText('SYNTHETIC REPOSITORY')).toBeVisible();
  await expect(page.getByText('Read-only demo', { exact: true })).toBeVisible();
  const revision = page.locator('.revision-bar .revision code');
  await expect(revision.nth(0)).toHaveAttribute('title', regression.report.input.baseSha);
  await expect(revision.nth(1)).toHaveAttribute('title', regression.report.input.headSha);
  const evidence = page.locator('.evidence-panel > .code-viewer');
  await expect(evidence).toContainText("throw new Error('User not found');");
  await page.getByRole('button', { name: 'Caller fallback' }).click();
  await expect(evidence).toContainText('return { status: 404 }');
  await expect(evidence.locator('.code-toolbar code')).toHaveAttribute('title', regression.report.input.headSha);
  await page.getByRole('button', { name: 'Previous return' }).click();
  await expect(evidence).toContainText('return undefined');
  await expect(evidence.locator('.code-toolbar code')).toHaveAttribute('title', regression.report.input.baseSha);
  await page.getByText('Handled caller', { exact: true }).click();
  await expect(page.locator('.demo-caller')).toContainText('catch');
  await expect(page.locator('.demo-caller .code-toolbar code')).toHaveAttribute('title', regression.report.input.headSha);
  await expect(page.getByRole('button', { name: /retry review|dismiss finding|reopen finding/i })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /open in github|view source/i })).toHaveCount(0);

  await page.getByRole('button', { name: 'View fix push' }).click();
  await expect(page.getByRole('heading', { name: 'Handle the missing user' })).toBeVisible();
  await expect(revision.nth(1)).toHaveAttribute('title', fix.report.input.headSha);
  await expect(page.locator('.finding-badges')).toContainText('Cleared by recheck');
  await expect(page.locator('.stage-strip')).toContainText('TypeScript caller analysis');
  await expect(page.locator('.prior-evidence-notice')).toContainText(regression.report.input.headSha.slice(0, 7));
  await page.getByText('Fix in src/route.ts', { exact: true }).click();
  await expect(page.locator('.demo-caller .code-toolbar code')).toHaveAttribute('title', fix.report.input.headSha);
  await expect(page.locator('.demo-caller .diff-added')).toContainText(['try', 'getUser', 'if (!user)', 'return { status: 200, user }', 'catch', 'status: 404', '}']);
  await page.getByRole('link', { name: 'Previous observation' }).click();
  await expect(page).toHaveURL(`${origin}/demo/runs/${regression.report.runId}?finding=${regression.report.findings[0]!.id}`);
  await page.reload();
  await expect(evidence).toContainText("throw new Error('User not found');");
  await expect(page.locator('.finding-badges')).toContainText('New');
  expect([...apiPaths]).toEqual(['/api/demo']);
});

test('the demo server exposes only bundled reports and read-only routes', async ({ request }) => {
  const privateId = randomUUID();
  const demoId = replay.regression.report.runId;
  for (const path of ['/api/repos', '/api/session', `/api/runs/${privateId}`, `/api/runs/${demoId}`, `/runs/${privateId}`,
    `/demo/runs/${privateId}`, '/.env', '/fixtures/review-demo/repository.bundle']) {
    const response = await request.get(origin + path);
    expect(response.status(), path).toBe(404);
  }
  for (const path of ['/api/demo', `/api/runs/${demoId}/retry`, '/webhooks/github']) {
    expect((await request.post(origin + path, { data: { runId: privateId } })).status(), path).toBe(405);
  }
  const response = await request.get(`${origin}/api/demo?runId=${privateId}`);
  expect(await response.json()).toEqual(replay);
});

test('the walkthrough linked from the README plays and seeks to the fix', async ({ page }) => {
  const readme = await readFile('README.md', 'utf8');
  const link = /\[Watch the captioned walkthrough \(WebM\)\]\(([^)]+)\)/.exec(readme)?.[1];
  expect(link).toBeTruthy();
  await page.goto(pathToFileURL(resolve(link!)).href);
  const video = page.locator('video');
  await expect(video).toHaveJSProperty('videoWidth', 1280);
  const duration = await video.evaluate(async (element: HTMLVideoElement) => {
    element.muted = true;
    await element.play();
    return element.duration;
  });
  expect(duration).toBeGreaterThan(88);
  expect(duration).toBeLessThan(95);
  await page.waitForFunction(() => document.querySelector('video')!.currentTime > 0.1);
  const seek = await video.evaluate(async (element: HTMLVideoElement) => {
    element.pause();
    await new Promise<void>(resolve => {
      element.addEventListener('seeked', () => resolve(), { once: true });
      element.currentTime = 67;
    });
    return element.currentTime;
  });
  expect(seek).toBeCloseTo(67);
});
