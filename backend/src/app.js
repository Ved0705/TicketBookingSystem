import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import config from './config.js';
import { migrate, db } from './db/index.js';
import { notFoundHandler, errorHandler } from './middleware/error.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import organiserRoutes from './routes/organiser.js';
import eventRoutes from './routes/events.js';
import bookingRoutes from './routes/bookings.js';
import waitlistRoutes from './routes/waitlist.js';

export function createApp() {
  migrate();

  const app = express();

  app.use(
    cors({
      origin(origin, cb) {
        // Same-origin/curl requests have no Origin header.
        if (!origin) return cb(null, true);
        if (config.corsOrigins.includes('*') || config.corsOrigins.includes(origin)) {
          return cb(null, true);
        }
        const err = new Error(`Origin ${origin} is not allowed by CORS.`);
        err.status = 403;
        err.code = 'CORS_REJECTED';
        return cb(err);
      },
      credentials: true,
    })
  );

  app.use(express.json({ limit: '256kb' }));
  app.disable('x-powered-by');

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      env: config.env,
      holdTtlSeconds: config.holdTtlSeconds,
      waitlistOfferTtlSeconds: config.waitlistOfferTtlSeconds,
      mailTransport: config.mail.transport,
      time: new Date().toISOString(),
    });
  });

  // --- OpenAPI spec + a tiny docs page (no extra dependency) -----------
  const specPath = path.resolve(config.backendRoot, 'openapi.json');
  app.get('/api/openapi.json', (_req, res) => {
    if (!fs.existsSync(specPath)) return res.status(404).json({ error: { message: 'Spec missing' } });
    res.type('application/json').send(fs.readFileSync(specPath, 'utf8'));
  });
  app.get('/api/docs', (_req, res) => {
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"/>
<title>Ticket Booking API</title><meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"/></head>
<body><div id="ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({url:'/api/openapi.json',dom_id:'#ui'});</script></body></html>`);
  });

  // --- Development helper: inspect the email outbox --------------------
  app.get('/api/dev/emails', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    res.json({
      transport: config.mail.transport,
      emails: db
        .prepare(
          `SELECT id, to_email, subject, transport, status, error, created_at
             FROM email_log ORDER BY id DESC LIMIT ?`
        )
        .all(limit),
    });
  });
  app.get('/api/dev/emails/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM email_log WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such email.' } });
    res.type('html').send(row.body);
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/organiser', organiserRoutes);
  app.use('/api/events', eventRoutes);
  app.use('/api', bookingRoutes);
  app.use('/api/waitlist', waitlistRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
