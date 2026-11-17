import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { semgrepOutputSchema } from '@opticpr/contracts';

const exec = promisify(execFile);
export const semgrepImage = 'semgrep/semgrep:1.144.0@sha256:10301f060aacf84078f9704fb1ba3a321df4ac46b009fd29c1c66880d1db8e77';
export const rulesPath = fileURLToPath(new URL('../../../config/semgrep/local-js-ts-v1.json', import.meta.url));
export const staticRuleIds = ['opticpr.dynamic-eval', 'opticpr.disabled-tls', 'opticpr.slice-exclusive-boundary'];
export interface SnapshotFile { path: string; source: string }
export interface StaticMatch { path: string; ruleId: string; startLine: number; endLine: number; message: string; severity: 'high' | 'medium' | 'low' }
export interface ScanResult { matches: StaticMatch[]; scanned: string[]; errors: number }
export type StaticScanner = (files: SnapshotFile[]) => Promise<ScanResult>;

/** No repository config, credentials, scripts or network enter this read-only sandbox. */
export const scanSemgrep: StaticScanner = async files => {
  if (!files.length) return { matches: [], scanned: [], errors: 0 };
  const rules = await readFile(rulesPath);
  if (createHash('sha256').update(rules).digest('hex') !== '2059f3843c09b70962e72aa712f3dc32da49f0dc8b852c0b0b9a117c7663c616') throw new Error('Pinned rules changed');
  const directory = await mkdtemp(join(tmpdir(), 'opticpr-scan-'));
  const name = `opticpr-scan-${randomUUID()}`;
  const snapshotDirectory = join(directory, 'source');
  const snapshotRules = join(directory, 'rules.json');
  try {
    await mkdir(snapshotDirectory);
    await writeFile(snapshotRules, rules, { mode: 0o444 });
    for (const file of files) {
      // Only sanitized paths from snapshot selection are accepted, even for callers outside the worker.
      if (!file.path || file.path.startsWith('/') || file.path.includes('\\') || file.path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid snapshot path');
      const target = join(snapshotDirectory, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.source, { mode: 0o444 });
    }
    await chmod(snapshotDirectory, 0o555);
    const { stdout } = await exec('docker', ['run', '--rm', '--pull=never', '--name', name,
      '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128',
      '--memory=1g', '--cpus=1', '--user=65534:65534', '--tmpfs=/tmp:rw,noexec,nosuid,size=128m',
      '-e', 'HOME=/tmp', '-e', 'SEMGREP_SEND_METRICS=off', '-e', 'SEMGREP_ENABLE_VERSION_CHECK=0',
      '-v', `${snapshotDirectory}:/snapshot:ro`, '-v', `${snapshotRules}:/rules.json:ro`, '-w', '/snapshot',
      '--entrypoint=semgrep', semgrepImage, 'scan', '--config=/rules.json', '--json', '--quiet',
      '--metrics=off', '--disable-version-check', '--oss-only', '--no-git-ignore', '--jobs=1', '--timeout=10', '--max-memory=512', '.'],
    { timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
    const result = semgrepOutputSchema.parse(JSON.parse(stdout));
    const normalize = (path: string) => path.replace(/^\/snapshot\//, '').replace(/^\.\//, '');
    return { errors: result.errors.length, scanned: result.paths.scanned.map(normalize), matches: result.results.map(match => ({
      path: normalize(match.path), ruleId: match.check_id, startLine: match.start.line, endLine: match.end.line,
      message: match.extra.message, severity: match.extra.severity === 'ERROR' ? 'high' : match.extra.severity === 'WARNING' ? 'medium' : 'low',
    })) };
  } finally {
    // Killing the CLI alone can leave its container alive after a timeout.
    await exec('docker', ['rm', '-f', name], { timeout: 5000 }).catch(() => {});
    await chmod(snapshotDirectory, 0o755).catch(() => {}); await rm(directory, { recursive: true, force: true });
  }
};
