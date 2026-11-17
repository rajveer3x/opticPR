import { spawnSync } from 'node:child_process';
const result = spawnSync('pnpm', ['--filter', '@opticpr/database', 'migrate'], { stdio: 'inherit', env: process.env });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
