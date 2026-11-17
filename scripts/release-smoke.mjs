import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { PrismaClient } from '../packages/database/dist/index.js';
import { fixtureConfig, reportSchema } from '../packages/contracts/dist/index.js';
import { FixtureRepositoryAdapter, githubClientsFromEnv } from '../packages/repository/dist/index.js';
import { createQueue, enqueueRun, repositoryScope, scheduleRun, waitForReport } from '../packages/runtime/dist/index.js';
import { createWorker } from '../apps/worker/dist/worker.js';
import { lockPullRequest, observeLiveTarget } from '../apps/worker/dist/current-review.js';
const exec = promisify(execFile);

// This smoke path uses the normal worker and actual read-only installation client.
// It deliberately does not start a publisher or send a GitHub comment.
if (process.argv[2] === 'worker') {
  const db = new PrismaClient(), queue = createQueue();
  const worker = createWorker(db); await worker.waitUntilReady();
  const adapter = await FixtureRepositoryAdapter.open();
  try {
    const fixture = await scheduleRun(db, queue, await adapter.revisions(), fixtureConfig);
    const fixtureReport = reportSchema.parse((await waitForReport(db, fixture.id, 60000)).report);
    assert.equal(fixtureReport.findings.length, 1);
    const repo = await db.gitHubRepository.findFirstOrThrow({ where: { owner: 'rajveer3x', name: 'opticpr-test', active: true } });
    const scope = await repositoryScope(db, repo.installationId, repo.id);
    const client = githubClientsFromEnv()(scope, async () => { await repositoryScope(db, scope.installationId, scope.repositoryId, scope.grantVersion); });
    const target = await db.$transaction(async tx => { await lockPullRequest(tx, scope, 4); return observeLiveTarget(tx, scope, 4, client); }, { timeout: 60000 });
    assert.ok(target); await enqueueRun(queue, target.run);
    const live = reportSchema.parse((await waitForReport(db, target.run.id, 180000)).report);
    assert.equal(live.stages.find(stage => stage.name === 'repository').status, 'completed');
    assert.ok(['completed', 'partial'].includes(live.stages.find(stage => stage.name === 'semgrep').status));
    console.log(JSON.stringify({ fixture: { runId: fixture.id, ...fixtureReport.input, findings: fixtureReport.findings.length },
      live: { runId: live.runId, ...live.input, coverage: live.coverage, stages: live.stages, findings: live.findings.length }, remotePublication: 'not started' }));
  } catch { console.error('Image smoke failed; check App access, migrations and scanner configuration.'); process.exitCode = 1; } finally { await worker.close(); await queue.obliterate({ force: true }); await queue.close(); await adapter.close(); await db.$disconnect(); }
} else {
  const image = process.argv[2];
  if (!/^sha256:[a-f0-9]{64}$/.test(image ?? '')) throw new Error('Pass a local built Docker image ID, not a mutable tag');
  const cloudflaredImage = process.env.CLOUDFLARED_IMAGE;
  if (!/^cloudflare\/cloudflared@sha256:[a-f0-9]{64}$/.test(cloudflaredImage ?? '')) throw new Error('Set CLOUDFLARED_IMAGE to the verified digest');
  const id = randomUUID().replaceAll('-', ''), schema = `release_${id}`, apiName = `opticpr-release-api-${id.slice(0,8)}`, tunnelName = `opticpr-release-tunnel-${id.slice(0,8)}`, networkName = `opticpr-release-network-${id.slice(0,8)}`;
  const previewPort = String(32000 + parseInt(id.slice(0, 6), 16) % 10000);
  const output = resolve(process.argv[3] ?? `output/deployment-${id}.json`);
  const source = new PrismaClient();
  const repo = await source.gitHubRepository.findFirstOrThrow({ where: { owner: 'rajveer3x', name: 'opticpr-test', active: true } });
  const url = new URL(process.env.DATABASE_URL); url.searchParams.set('schema', schema);
  const db = new PrismaClient({ datasourceUrl: url.toString() });
  const snapshots = resolve('tmp/release-snapshots'); await mkdir(snapshots, { recursive: true });
  let completed = false, stage = 'prepare';
  try {
    await source.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const directory = new URL('../packages/database/prisma/migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter(name => /^\d/.test(name)).sort()) {
      for (const statement of (await readFile(new URL(`${name}/migration.sql`, directory), 'utf8')).split(';').map(s => s.trim()).filter(Boolean)) await db.$executeRawUnsafe(statement);
    }
    await db.gitHubInstallation.create({ data: { id: repo.installationId } });
    await db.gitHubRepository.create({ data: repo });
    const env = { ...process.env, DATABASE_URL: url.toString(), REVIEW_QUEUE: schema, MODEL_ENRICHMENT_ENABLED: '0', TMPDIR: snapshots };
    const pass = ['DATABASE_URL', 'REDIS_URL', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'REVIEW_QUEUE', 'MODEL_ENRICHMENT_ENABLED', 'TMPDIR'].flatMap(key => ['-e', key]);
    stage = 'worker';
    const { stdout } = await exec('docker', ['run', '--rm', '--network', 'host', '--user', '0:0', ...pass,
      '-v', '/var/run/docker.sock:/var/run/docker.sock', '-v', `${snapshots}:${snapshots}`, image, 'node', 'scripts/release-smoke.mjs', 'worker'], { env, timeout: 240000, maxBuffer: 2 * 1024 * 1024 });
    const smoke = JSON.parse(stdout.trim());
    stage = 'tunnel';
    await exec('docker', ['run', '-d', '--name', networkName, '--network', 'host', image, 'node', '-e', 'setInterval(()=>{},60000)']);
    await exec('docker', ['run', '-d', '--name', tunnelName, '--network', `container:${networkName}`, cloudflaredImage, 'tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${previewPort}`], { timeout: 120000 });
    let origin;
    for (let attempt = 0; attempt < 90; attempt++) {
      const logs = await exec('docker', ['logs', tunnelName]);
      origin = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(logs.stdout + logs.stderr)?.[0];
      if (origin) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(origin, 'HTTPS preview URL must be assigned');
    console.log(JSON.stringify({ previewOrigin: origin, apiName, tunnelName, networkName }));
    const apiEnv = { ...env, HOST: '127.0.0.1', PORT: previewPort, DASHBOARD_ORIGIN: origin, FIXTURE_INSPECTION_ENABLED: '0' };
    const keys = ['DATABASE_URL', 'REDIS_URL', 'HOST', 'PORT', 'DASHBOARD_ORIGIN', 'FIXTURE_INSPECTION_ENABLED', 'SESSION_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_APP_SLUG', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET'];
    await exec('docker', ['run', '-d', '--name', apiName, '--network', `container:${networkName}`, '--read-only', '--tmpfs', '/tmp', ...keys.flatMap(key => ['-e', key]), image], { env: apiEnv, timeout: 30000 });
    await new Promise(resolve => setTimeout(resolve, 500));
    const state = await exec('docker', ['inspect', apiName, '--format', '{{.State.Running}}']);
    assert.equal(state.stdout.trim(), 'true', 'The new API container must be running; do not accept another process on its port');
    // Resolve only this newly assigned public hostname through Cloudflare DNS;
    // local negative DNS caches can outlive a freshly created quick tunnel. TLS
    // still verifies the assigned hostname; no certificate check is disabled.
    const resolver = new Resolver({ timeout: 5000, tries: 2 }); resolver.setServers(['1.1.1.1']);
    stage = 'dns';
    let address;
    for (let attempt = 0; attempt < 120; attempt++) {
      try { [address] = await resolver.resolve4(new URL(origin).hostname); if (address) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.ok(address, 'Preview DNS must propagate');
    const resolvedHost = `${new URL(origin).hostname}:443:${address}`;
    async function httpsRequest(path, post = false) {
      const { stdout } = await exec('curl', ['--silent', '--show-error', '--resolve', resolvedHost, '--max-time', '5', '--write-out', '\n%{http_code}',
        ...(post ? ['--request', 'POST', '--header', 'content-type: application/json', '--data', '{}'] : []), `${origin}${path}`]);
      const split = stdout.lastIndexOf('\n');
      return { status: Number(stdout.slice(split + 1)), body: stdout.slice(0, split) };
    }
    stage = 'https';
    let readiness, lastFailure;
    for (let attempt = 0; attempt < 90; attempt++) {
      try { const response = await httpsRequest('/health/ready'); if (response.status === 200) { readiness = JSON.parse(response.body); break; } lastFailure = `HTTP ${response.status}`; } catch { lastFailure = 'Host HTTPS request failed'; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!readiness) console.error(JSON.stringify({ lastFailure }));
    assert.equal(readiness?.ready, true);
    assert.equal((await httpsRequest('/')).status, 200);
    assert.equal((await httpsRequest(`/api/runs/${smoke.live.runId}`)).status, 401);
    assert.equal((await httpsRequest('/webhooks/github', true)).status, 401);
    const evidence = { measuredAt: new Date().toISOString(), imageId: image, cloudflaredImage, origin, apiName, tunnelName, networkName, previewPort, schema, readiness, dns: 'Assigned preview hostname resolved via 1.1.1.1 to avoid stale local negative DNS caching; normal HTTPS hostname validation retained.', ...smoke,
      limitations: ['Temporary development HTTPS tunnel; expires when its container stops.', 'GitHub App OAuth callback registration for this temporary origin was not changed. New-origin sign-in remains a deployment setup step.', 'Source/analysis smoke used a read-only installation client; no remote GitHub publication was attempted.'],
      cleanup: `docker rm -f ${apiName} ${tunnelName} ${networkName}; then drop the isolated PostgreSQL schema ${schema}` };
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ evidence: output, origin, imageId: image, fixtureRunId: smoke.fixture.runId, liveRunId: smoke.live.runId, ready: readiness.ready })); completed = true;
  } catch (error) { console.error(JSON.stringify({ stage, code: /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'CHECK_FAILED', actual: typeof error.actual === 'number' ? error.actual : undefined })); throw new Error('Release smoke failed; check worker configuration and HTTPS tunnel diagnostics.'); } finally {
    if (!completed) {
      await exec('docker', ['rm', '-f', apiName, tunnelName, networkName]).catch(() => {});
      await source.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await db.$disconnect(); await source.$disconnect(); await rm(snapshots, { recursive: true, force: true });
  }
}
