import express, { type ErrorRequestHandler, type Express } from 'express';
import { queueJobSchema, reportSchema } from '@opticpr/contracts';
import type { PrismaClient } from '@opticpr/database';
import { verifySignature, receiveGitHubEvent, InvalidWebhookError, DeliveryConflictError } from './github.js';
import { logger, readiness } from '@opticpr/runtime';

export function createApp(db: PrismaClient, options: { webhookSecret?: string } = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.post('/webhooks/github', express.raw({ type: () => true, inflate: false, limit: '25mb' }), async (req, res) => {
    const started = Date.now();
    const secret = options.webhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) { res.status(503).json({ error: 'GitHub intake is not configured' }); return; }
    if (!Buffer.isBuffer(req.body) || !verifySignature(req.body, req.get('x-hub-signature-256'), secret)) {
      res.status(401).json({ error: 'Invalid webhook signature' }); return;
    }
    const deliveryId = req.get('x-github-delivery');
    const event = req.get('x-github-event');
    if (!deliveryId || !/^[A-Za-z0-9-]{1,200}$/.test(deliveryId) || !event || !/^[a-z_]{1,100}$/.test(event)) {
      res.status(400).json({ error: 'Invalid delivery headers' }); return;
    }
    try {
      const result = await receiveGitHubEvent(db, deliveryId, event, req.body);
      logger.info({ deliveryId, durationMs: Date.now() - started, ...result }, 'GitHub delivery stored');
      res.status(result.duplicate ? 200 : 202).json(result);
    } catch (error) {
      if (error instanceof InvalidWebhookError) { res.status(400).json({ error: error.message }); return; }
      if (error instanceof DeliveryConflictError) { res.status(409).json({ error: error.message }); return; }
      logger.error({ deliveryId, durationMs: Date.now() - started }, 'GitHub delivery storage failed');
      res.status(503).json({ error: 'Delivery not stored; retry delivery' });
    }
  });
  app.get('/health/live', (_req, res) => { res.json({ alive: true }); });
  app.get('/health/ready', async (_req, res) => {
    const status = await readiness(db);
    res.status(status.ready ? 200 : 503).json(status);
  });
  // Local fixture inspection only. Repository authorization belongs to slice 07.
  app.get('/api/runs/:id', async (req, res) => {
    const parsed = queueJobSchema.safeParse({ runId: req.params.id });
    if (!parsed.success) { res.status(400).json({ error: 'Invalid run ID' }); return; }
    const run = await db.reviewRun.findUnique({ where: { id: parsed.data.runId } });
    if (!run || run.source !== 'fixture') { res.status(404).json({ error: 'Run not found' }); return; }
    res.json({
      id: run.id, logicalKey: run.logicalKey, source: run.source,
      baseSha: run.baseSha, headSha: run.headSha, configurationDigest: run.configurationDigest,
      state: run.state, createdAt: run.createdAt, completedAt: run.completedAt,
      error: run.error, report: run.report === null ? null : reportSchema.parse(run.report),
    });
  });
  const handleError: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error.type === 'entity.too.large') { res.status(413).json({ error: 'Webhook body too large' }); return; }
    if (error.status === 415) { res.status(415).json({ error: 'Unsupported body encoding' }); return; }
    logger.error('Report request failed');
    res.status(503).json({ error: 'Report unavailable; check dependencies and stored report validity' });
  };
  app.use(handleError);
  return app;
}
