import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
// These helpers target the bundled Compose PostgreSQL only. Backups never include Redis.
export async function postgres(command, args = [], input) {
  return new Promise((resolve, reject) => {
    const child = execFile('docker', ['compose', 'exec', '-T', 'postgres', command, '-U', 'opticpr', ...args],
      { encoding: 'buffer', timeout: 60000, maxBuffer: 128 * 1024 * 1024 }, (error, stdout) => error ? reject(new Error(`Compose PostgreSQL ${command} failed`)) : resolve(stdout));
    child.stdin.end(input);
  });
}
export async function backup(file, schema) {
  if (schema && !/^recovery_[a-f0-9]+$/.test(schema)) throw new Error('Invalid recovery schema');
  const dump = await postgres('pg_dump', ['-d', 'opticpr', '-Fc', ...(schema ? ['-n', schema] : [])]);
  await writeFile(file, dump, { mode: 0o600, flag: 'wx' });
  return { sha256: createHash('sha256').update(dump).digest('hex'), bytes: dump.length };
}
export async function restore(file, database) {
  if (!/^opticpr_restore_[a-f0-9]+$/.test(database)) throw new Error('Restore only targets a new isolated drill database');
  await postgres('createdb', [database]);
  try { await postgres('pg_restore', ['-d', database, '--exit-on-error', '--no-owner', '--no-privileges'], await readFile(file)); }
  catch (error) { await postgres('dropdb', [database]); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== 'backup' || !process.argv[3]) throw new Error('Usage: pnpm ops:backup backup <private-file.dump>');
  console.log(JSON.stringify(await backup(process.argv[3])));
}
