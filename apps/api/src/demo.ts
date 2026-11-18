import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoManifestSchema, demoReplaySchema } from '@opticpr/contracts';
import express, { type Express } from 'express';

export async function createDemoApp(): Promise<Express> {
  const fixture = new URL('../../../fixtures/review-demo/', import.meta.url);
  const read = async (name: string): Promise<unknown> => JSON.parse(await readFile(new URL(name, fixture), 'utf8'));
  const manifest = demoManifestSchema.parse(await read('manifest.json'));
  const replay = demoReplaySchema.parse(await read('replay.json'));
  const ids = new Set<string>();
  for (const scenario of ['regression', 'fix'] as const) {
    const { report, caller } = replay[scenario];
    if (report.source !== 'fixture' || report.configuration.adapter !== 'review-demo-bundle-v1' ||
        JSON.stringify(report.input) !== JSON.stringify(manifest[scenario]) || caller.revision !== report.input.headSha ||
        ids.has(report.runId)) throw new Error('Demo reports do not match the bundled fixture');
    ids.add(report.runId);
  }
  const web = fileURLToPath(new URL('../../web/dist/', import.meta.url));
  const index = join(web, 'index.html');
  await readFile(index);

  // This app has no database connection, dashboard router or user-supplied file paths.
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.set('Allow', 'GET, HEAD').sendStatus(405); return; }
    next();
  });
  app.get('/api/demo', (_req, res) => { res.json(replay); });
  app.get('/', (_req, res) => { res.redirect('/demo'); });
  app.get('/demo', (_req, res) => { res.sendFile(index); });
  app.get('/demo/runs/:id', (req, res) => {
    if (!ids.has(req.params.id)) { res.sendStatus(404); return; }
    res.sendFile(index);
  });
  app.get('/favicon.svg', (_req, res) => { res.sendFile(join(web, 'favicon.svg')); });
  app.use('/assets', express.static(join(web, 'assets'), { index: false, redirect: false }));
  app.use((_req, res) => { res.sendStatus(404); });
  return app;
}
