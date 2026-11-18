import assert from 'node:assert/strict';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createDemoApp } from '../apps/api/dist/demo.js';
import { demoReplaySchema } from '../packages/contracts/dist/index.js';

const destination = resolve(process.argv[2] ?? 'context/releases/11-review-demo.webm');
const staged = `${destination}.recording-${process.pid}.webm`;
const directory = await mkdtemp(resolve(tmpdir(), 'opticpr-review-recording-'));
let server, browser, context;
try {
  server = (await createDemoApp()).listen(0, '127.0.0.1');
  await new Promise((ready, reject) => { server.once('listening', ready); server.once('error', reject); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { regression, fix } = demoReplaySchema.parse(await (await fetch(`${origin}/api/demo`)).json());
  const short = value => value.slice(0, 7);
  const viewport = { width: 1280, height: 800 };
  browser = await chromium.launch();
  context = await browser.newContext({ viewport, reducedMotion: 'reduce', recordVideo: { dir: directory, size: viewport } });
  const page = await context.newPage();
  const evidence = page.locator('.evidence-panel > .code-viewer');
  const comparisonHead = page.locator('.revision-bar .revision code').nth(1);
  const status = page.locator('.finding-badges');
  const focus = locator => locator.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
  async function caption(title, text) {
    await page.evaluate(({ title, text }) => {
      let overlay = document.getElementById('demo-recording-caption');
      if (!overlay) {
        overlay = document.createElement('aside');
        overlay.id = 'demo-recording-caption';
        Object.assign(overlay.style, {
          position: 'fixed', zIndex: 100, right: '32px', left: '32px', bottom: '56px',
          border: '1px solid #69503e', borderRadius: '8px', padding: '13px 19px',
          background: '#171413f5', color: '#f4eee8', fontSize: '16px',
          boxShadow: '0 10px 35px #000a', pointerEvents: 'none',
        });
        document.body.append(overlay);
      }
      const heading = document.createElement('strong');
      Object.assign(heading.style, { display: 'block', color: '#ffb795', marginBottom: '4px' });
      heading.textContent = title;
      overlay.replaceChildren(heading, document.createTextNode(text));
    }, { title, text });
  }
  await page.goto(`${origin}/demo`);
  await expect(page.getByRole('heading', { name: 'Missing-user regression' })).toBeVisible();
  await expect(comparisonHead).toHaveAttribute('title', regression.report.input.headSha);
  await expect(status).toContainText('New');
  const start = performance.now();
  async function at(seconds) {
    const remaining = start + seconds * 1000 - performance.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
  }
  await caption('OpticPR · Synthetic TypeScript review',
    `Compare base ${short(regression.report.input.baseSha)} with regression ${short(regression.report.input.headSha)}. The worker stored one new finding.`);

  await at(10);
  await expect(evidence).toContainText("throw new Error('User not found');");
  await focus(evidence);
  await caption('Changed throw', 'The lookup now raises an error at src/users.ts line 4 when the record is missing.');

  await at(22);
  await page.getByRole('button', { name: 'Caller fallback' }).click();
  await expect(evidence).toContainText('return { status: 404 }');
  await expect(evidence.locator('.code-toolbar code')).toHaveAttribute('title', regression.report.input.headSha);
  await focus(evidence);
  await caption('Unchanged caller', 'The compiler resolves getUser to findUser. The exception leaves the route before its 404 check can run.');

  await at(34);
  await page.getByRole('button', { name: 'Previous return' }).click();
  await expect(evidence).toContainText('return undefined');
  await expect(evidence.locator('.code-toolbar code')).toHaveAttribute('title', regression.report.input.baseSha);
  await focus(evidence);
  await caption('Base revision', `At ${short(regression.report.input.baseSha)}, the lookup returned undefined and the route reached its 404 fallback.`);

  await at(44);
  await page.getByText('Handled caller', { exact: true }).click();
  await expect(page.locator('.demo-caller')).toContainText('catch');
  await expect(page.locator('.demo-caller .code-toolbar code')).toHaveAttribute('title', regression.report.input.headSha);
  await focus(page.locator('.demo-caller .diff-evidence').filter({ hasText: '} catch {' }));
  await caption('Handled comparison', 'The companion route already catches the same exception and returns 404. This caller produces zero findings.');

  await at(56);
  await page.getByRole('button', { name: 'View fix push' }).click();
  await expect(comparisonHead).toHaveAttribute('title', fix.report.input.headSha);
  await expect(status).toContainText('Cleared by recheck');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await caption('Fix push', `The worker reviewed ${short(fix.report.input.headSha)} with the same rule and completed the check of both files.`);

  await at(61);
  await focus(status);
  await caption('Cleared by recheck', 'The finding is cleared. The evidence pane still shows the original observation for comparison.');

  await at(66);
  await page.getByText('Fix in src/route.ts', { exact: true }).click();
  await expect(page.locator('.demo-caller .code-toolbar code')).toHaveAttribute('title', fix.report.input.headSha);
  await expect(page.locator('.demo-caller')).toContainText('catch');
  await focus(page.locator('.demo-caller .diff-added').filter({ hasText: '} catch {' }));
  await caption('The route now catches the error', 'The follow-up change keeps the throwing lookup and makes the original route return 404.');

  await at(79);
  await page.getByRole('link', { name: 'Previous observation' }).click();
  await expect(comparisonHead).toHaveAttribute('title', regression.report.input.headSha);
  await expect(status).toContainText('New');
  assert.equal(new URL(page.url()).searchParams.get('finding'), regression.report.findings[0].id);
  await focus(evidence);
  await caption('Original evidence stays available', `The previous observation reopens regression ${short(regression.report.input.headSha)} and its three original citations.`);

  await at(90);
  const video = page.video();
  assert.ok(video);
  await context.close();
  context = undefined;
  // Preserve the existing recording if the new capture cannot play or overruns.
  await video.saveAs(staged);
  const preview = await browser.newPage();
  await preview.goto(pathToFileURL(staged).href);
  await preview.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
  const duration = await preview.locator('video').evaluate(element => element.duration);
  assert.ok(duration > 88 && duration < 95, `Expected approximately 90 seconds, recorded ${duration}s`);
  await preview.close();
  await rename(staged, destination);
  console.log(`Recorded ${destination}`);
} finally {
  await context?.close();
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(staged, { force: true });
  await rm(directory, { recursive: true, force: true });
}
