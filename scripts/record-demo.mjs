import { chromium } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const evidence = JSON.parse(await readFile('context/releases/08-recovery.json', 'utf8'));
const directory = await mkdtemp(join(tmpdir(), 'opticpr-demo-'));
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: directory, size: { width: 1280, height: 720 } } });
const page = await context.newPage();
const phases = [
  { at: 0, title: 'Static evidence survives a model outage', event: 'static-alert-survived-model-failure', explanation: 'The worker commits the Semgrep checkpoint before inference. A deliberately failing model leaves the pagination alert and its exact Git citation in the published summary.' },
  { at: 40, title: 'Restore the database; recover unfinished work', event: 'backup-restored', explanation: 'A real pg_dump is restored into a fresh database. The prior report and a running review survive. The dispatcher rebuilds the missing Redis job using the same durable run ID.' },
  { at: 75, title: 'A fix push wins over the late worker', event: 'fix-won-over-late-worker', explanation: 'Pause the older comparison, finish the fix on a second BullMQ worker, then release the old worker. The latestRunId pointer and single visible summary still select the fix.' },
  { at: 125, title: 'Redelivery leaves one summary', event: 'redelivery-preserved-one-summary', explanation: 'Send the same signed delivery twice and reconcile publication. The stored remote comment ID is unchanged: one visible summary, one remote create.' },
  { at: 155, title: 'Incomplete scans retain prior evidence', event: 'incomplete-scan-retained-evidence', explanation: 'A scanner omitting the affected file yields partial coverage and needs verification. It clears zero prior findings. GitHub comment IDs in this recovery drill are mocked; no live remote race is claimed.' },
];
try {
  await page.setContent(`<!doctype html><html lang="en"><meta charset="utf-8"><title>OpticPR recovery demo</title><style>
  *{box-sizing:border-box}body{margin:0;background:#10141e;color:#f0f3fc;font:20px system-ui,sans-serif}main{padding:42px 54px}header{display:flex;justify-content:space-between;color:#99aac9;font-size:16px;letter-spacing:1px}h1{font-size:42px;line-height:1.14;max-width:1080px;margin:28px 0 18px}p{color:#c3cee0;line-height:1.55;max-width:1120px;margin:0 0 24px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#1b2434;border:1px solid #35415b;border-left:4px solid #ff9459;border-radius:8px;padding:22px;font:17px/1.55 ui-monospace,monospace;min-height:260px;margin:0}footer{position:fixed;bottom:0;width:100%;padding:18px 54px 24px;background:#10141e;color:#99aac9;font-size:15px}#bar{height:5px;background:#ff9459;width:0;margin-top:12px}#clock{font-variant-numeric:tabular-nums;color:#ffb68f}strong{color:#ffb68f}</style><main><header><span>OPTICPR / EVALUATION & RECOVERY</span><span id="clock">00:00 / 03:00</span></header><h1 id="title"></h1><p id="explanation"></p><pre id="evidence"></pre></main><footer><strong>Recorded evidence playback</strong> · Real PostgreSQL restore, Redis/BullMQ & pinned Semgrep · Synthetic source · Mock GitHub<div id="bar"></div></footer></html>`);
  await page.evaluate(({ evidence, phases }) => {
    const started = performance.now();
    const update = () => {
      const seconds = Math.min(180, Math.floor((performance.now() - started) / 1000));
      const phase = phases.filter(phase => phase.at <= seconds).at(-1);
      document.querySelector('#title').textContent = phase.title;
      document.querySelector('#explanation').textContent = phase.explanation;
      const event = evidence.events.find(event => event.name === phase.event);
      document.querySelector('#evidence').textContent = Object.entries(event).filter(([key]) => key !== 'name').map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join('\n');
      document.querySelector('#clock').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')} / 03:00`;
      document.querySelector('#bar').style.width = `${seconds / 180 * 100}%`;
    }; update(); setInterval(update, 200);
  }, { evidence, phases });
  await page.screenshot({ path: 'context/releases/08-demo-preview.png' });
  await writeFile('context/releases/08-demo-transcript.md', '# Three-minute recovery demo\n\nRecorded playback of the measured [recovery trace](08-recovery.json), rather than a live GitHub recording. PostgreSQL dump/restore, queues, workers and Semgrep were real; the model outage and GitHub service were controlled.\n\n' + phases.map(phase => `- ${Math.floor(phase.at/60)}:${String(phase.at%60).padStart(2,'0')} — ${phase.title}. ${phase.explanation}`).join('\n') + '\n');
  await page.waitForTimeout(180000);
  const video = page.video(); await context.close(); await video.saveAs(resolve('context/releases/08-demo.webm'));
  console.log('Recorded the three-minute evidence demo.');
} finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
