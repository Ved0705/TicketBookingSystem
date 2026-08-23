import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, '..');

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const config = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 4000),

  // Absolute path to the SQLite file. ':memory:' is used by the test suite.
  databaseFile:
    process.env.DATABASE_FILE === ':memory:'
      ? ':memory:'
      : path.resolve(backendRoot, process.env.DATABASE_FILE || 'data/ticket-booking.db'),

  jwtSecret: process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  bcryptRounds: num(process.env.BCRYPT_ROUNDS, 10),

  corsOrigins: (
    process.env.CORS_ORIGINS ||
    'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // --- Seat hold TTL -------------------------------------------------
  holdTtlSeconds: num(process.env.HOLD_TTL_SECONDS, 600), // 10 minutes
  maxSeatsPerHold: num(process.env.MAX_SEATS_PER_HOLD, 8),

  // --- Waitlist offer TTL --------------------------------------------
  waitlistOfferTtlSeconds: num(process.env.WAITLIST_OFFER_TTL_SECONDS, 300), // 5 minutes

  // How often the background sweeper reconciles expired holds/offers.
  sweepIntervalMs: num(process.env.SWEEP_INTERVAL_MS, 5000),

  // --- Email ----------------------------------------------------------
  mail: {
    // smtp | console | file . Anything other than 'smtp' is a dev fallback.
    transport: (process.env.MAIL_TRANSPORT || 'file').toLowerCase(),
    from: process.env.MAIL_FROM || 'Ticket Booking <no-reply@ticketbooking.local>',
    host: process.env.SMTP_HOST || '',
    port: num(process.env.SMTP_PORT, 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    outboxDir: path.resolve(backendRoot, process.env.MAIL_OUTBOX_DIR || 'outbox'),
  },

  backendRoot,
};

export default config;
