import { PrismaClient } from '@opticpr/database';
import { retryPublication } from './publication.js';

const db = new PrismaClient();
try {
  const [repositoryId, value] = process.argv.slice(2);
  const number = Number(value);
  if (!repositoryId || !/^[1-9][0-9]*$/.test(repositoryId) || !Number.isSafeInteger(number) || number <= 0) throw new Error('Usage: pnpm publication:retry <repository-id> <pr-number>');
  const intent = await retryPublication(db, repositoryId, number);
  console.log(JSON.stringify({ repositoryId, pullRequestNumber: number, runId: intent.runId, state: intent.state }));
} catch {
  console.error('Could not retry publication. Check arguments, repository access, stored publication intent and PostgreSQL.');
  process.exitCode = 1;
} finally { await db.$disconnect(); }
