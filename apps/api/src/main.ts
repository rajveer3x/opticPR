import { PrismaClient } from '@opticpr/database';
import { logger } from '@opticpr/runtime';
import { createApp } from './app.js';

const db = new PrismaClient();
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('API must bind to loopback; use a TLS reverse proxy for webhooks');
const server = createApp(db).listen(port, host, () => logger.info({ host, port }, 'API listening'));
server.on('error', () => { logger.error('API failed to listen'); process.exitCode = 1; });
let stopping = false;
const stop = () => {
  if (stopping) return; stopping = true;
  server.close(() => { void db.$disconnect(); });
};
process.once('SIGINT', stop); process.once('SIGTERM', stop);
