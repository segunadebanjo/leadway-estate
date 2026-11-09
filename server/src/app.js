import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { prisma } from './db.js';
import { HttpError } from './lib/errors.js';
import { csrfHeader, loadUser, requireAdmin } from './middleware/auth.js';
import { router as authRoutes } from './routes/auth.js';
import { router as residentRoutes } from './routes/residents.js';
import { router as ledgerRoutes } from './routes/ledger.js';
import { router as paymentRoutes } from './routes/payments.js';
import { router as meRoutes } from './routes/me.js';
import { router as visitorRoutes } from './routes/visitors.js';
import { router as adminRoutes } from './routes/admin.js';
import { router as documentRoutes } from './routes/documents.js';
import { router as broadcastRoutes } from './routes/broadcasts.js';
import { router as assetRoutes } from './routes/assets.js';
import { router as reportRoutes } from './routes/reports.js';
import { router as reminderRoutes } from './routes/reminders.js';
import { router as planRoutes } from './routes/plans.js';
import { router as householdRoutes } from './routes/household.js';
import { router as communityRoutes } from './routes/community.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // one proxy hop (nginx / Caddy / PaaS) for client IPs

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", 'https://js.paystack.co'],
          frameSrc: ["'self'", 'https://checkout.paystack.com', 'https://*.paystack.co'],
          connectSrc: ["'self'", 'https://api.paystack.co'],
          imgSrc: ["'self'", 'data:'],
          styleSrc: ["'self'", "'unsafe-inline'"],
        },
      },
    }),
  );
  app.use(compression());
  // Keep the raw body: the Paystack webhook signature is computed over it.
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => (req.rawBody = buf) }));
  app.use(cookieParser());

  app.get('/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  const api = express.Router();
  api.use(loadUser);
  api.use((req, res, next) => (req.path === '/payments/webhook' ? next() : csrfHeader(req, res, next)));
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  api.use('/auth', authRoutes);
  api.use('/payments', paymentRoutes); // webhook public; each route guards itself
  api.use('/me', meRoutes);
  api.use('/visitors', visitorRoutes);
  api.use('/documents', documentRoutes);
  api.use('/residents', requireAdmin, residentRoutes);
  api.use('/ledger', requireAdmin, ledgerRoutes);
  api.use('/admin', requireAdmin, reminderRoutes);
  api.use('/admin', requireAdmin, adminRoutes);
  api.use('/plans', requireAdmin, planRoutes);
  api.use('/household', householdRoutes);
  api.use('/community', communityRoutes);
  api.use('/broadcasts', requireAdmin, broadcastRoutes);
  api.use('/assets', requireAdmin, assetRoutes);
  api.use('/reports', requireAdmin, reportRoutes);
  api.use((_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.use('/api', api);

  // In production the API also serves the built client on the same origin.
  const indexHtml = path.join(config.clientDist, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use(express.static(config.clientDist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(indexHtml));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof HttpError || (err.status && err.status < 600)) {
      const status = err.status || 500;
      return res.status(status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  return app;
}
