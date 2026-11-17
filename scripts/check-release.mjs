import { execFileSync } from 'node:child_process';
const value = JSON.parse(execFileSync('docker', ['compose', '--env-file', '.env', '--env-file', 'deploy/images.env', '-f', 'compose.yaml', '-f', 'compose.release.yaml', 'config', '--format', 'json'], { encoding: 'utf8' }));
for (const [name, service] of Object.entries(value.services)) {
  if (!/^\S+@sha256:[a-f0-9]{64}$/.test(service.image)) throw new Error(`${name} must use a content-addressed image`);
}
if (new URL(value.services.api.environment.DASHBOARD_ORIGIN).protocol !== 'https:') throw new Error('Release dashboard must use HTTPS');
console.log('All release images use digests; dashboard uses HTTPS.');
