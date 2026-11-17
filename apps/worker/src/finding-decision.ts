import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@opticpr/database';
import { appendFindingDecision } from './finding-history.js';

const [runId, findingId, action, actor, reason, id = randomUUID()] = process.argv.slice(2);
const db = new PrismaClient();
try {
  const decision = await appendFindingDecision(db, { id, runId, findingId, action, actor, reason });
  console.log(JSON.stringify(decision, null, 2));
} catch {
  console.error('Usage: pnpm finding:decide <run-id> <finding-id> <dismiss|reopen> <actor> <reason> [decision-id]. Requires a confirmed observation; no decision was changed.');
  process.exitCode = 1;
} finally { await db.$disconnect(); }
