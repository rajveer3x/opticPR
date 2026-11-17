import { PrismaClient } from '@opticpr/database';
import { createQueue, logger, requireReady } from '@opticpr/runtime';
import { createWorker } from './worker.js';
import { createDispatcher } from './dispatcher.js';
import { createPublisher } from './publication.js';

const db = new PrismaClient();
try {
  await requireReady(db);
  const queue = createQueue();
  const dispatcher = createDispatcher(db, queue);
  dispatcher.start();
  const publisher = createPublisher(db);
  publisher.start();
  const worker = createWorker(db);
  await worker.waitUntilReady();
  logger.info({ concurrency: 1 }, 'Review worker, intake dispatcher and publisher ready');
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    await dispatcher.close(); await publisher.close(); await worker.close(); await queue.close(); await db.$disconnect();
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} catch {
  logger.error('Worker startup failed; check PostgreSQL, migrations and Redis');
  await db.$disconnect(); process.exitCode = 1;
}
