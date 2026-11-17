import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// Requires a running API with PostgreSQL stopped, Redis still running.
const response = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/health/ready`, { signal: AbortSignal.timeout(10000) });
const health = await response.json();
assert.equal(response.status, 503);
assert.equal(health.ready, false);
assert.equal(health.dependencies.postgresql, 'down');
assert.equal(health.dependencies.redis, 'up');
const child = spawn(process.execPath, ['--env-file=.env', 'apps/worker/dist/replay.js'], { stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = ''; let stderr = '';
child.stdout.on('data', data => { stdout += data; });
child.stderr.on('data', data => { stderr += data; });
const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
clearTimeout(timer);
assert.equal(code, 1, stderr);
assert.equal(stdout, '', 'Failed replay must not print a success result');
assert.match(stderr, /Dependencies unavailable: postgresql/);
console.log('Verified PostgreSQL outage: readiness 503 names PostgreSQL; replay exits 1 without a success result.');
