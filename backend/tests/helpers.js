/**
 * Test harness.
 *
 * IMPORTANT: this module must be imported *before* anything that touches
 * src/config.js, because it points the app at a throwaway database file.
 * ES modules evaluate depth-first in import order, so putting this import
 * first in a test file is enough.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbs-test-'));
export const TEST_DB = path.join(tmpDir, `${crypto.randomUUID()}.db`);

process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = TEST_DB;
process.env.JWT_SECRET = 'test-secret';
process.env.BCRYPT_ROUNDS = '4'; // keep the suite fast
process.env.MAIL_TRANSPORT = 'console';
process.env.CORS_ORIGINS = '*';
process.env.SWEEP_INTERVAL_MS = '1000';
process.env.WAITLIST_OFFER_TTL_SECONDS = '2'; // keep offer-expiry tests quick

let server = null;
let baseUrl = null;

export async function startServer() {
  if (server) return baseUrl;
  const { createApp } = await import('../src/app.js');
  const { attachWebSocket } = await import('../src/realtime/hub.js');
  const { startScheduler } = await import('../src/jobs/scheduler.js');
  const app = createApp();
  server = http.createServer(app);
  attachWebSocket(server);
  // Run the real background sweeper, exactly as production does.
  startScheduler();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return baseUrl;
}

export async function stopServer() {
  const { closeWebSocket } = await import('../src/realtime/hub.js');
  const { stopScheduler } = await import('../src/jobs/scheduler.js');
  stopScheduler();
  closeWebSocket();
  if (server) await new Promise((r) => server.close(r));
  server = null;
  baseUrl = null;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

export const wsUrl = (showId) => `${baseUrl.replace('http', 'ws')}/ws?showId=${showId}`;

/** Minimal fetch wrapper returning { status, body }. */
export async function api(pathname, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

let counter = 0;
export const uniqueEmail = (prefix = 'user') => `${prefix}${Date.now()}${counter++}@test.local`;

export async function register(role = 'CUSTOMER', name = 'Test Person') {
  const email = uniqueEmail(role.toLowerCase());
  const res = await api('/api/auth/register', {
    method: 'POST',
    body: { name, email, password: 'Password123!', role },
  });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  return { ...res.body.user, token: res.body.token, password: 'Password123!' };
}

/** Create an ADMIN directly in the database (admins never self-register). */
export async function createAdmin() {
  const { db } = await import('../src/db/index.js');
  const { hashPassword, signToken } = await import('../src/utils/auth.js');
  const email = uniqueEmail('admin');
  const roleId = db.prepare("SELECT id FROM roles WHERE name = 'ADMIN'").get().id;
  const id = db
    .prepare('INSERT INTO users (name, email, password_hash, role_id) VALUES (?, ?, ?, ?)')
    .run('Test Admin', email, hashPassword('Password123!'), roleId).lastInsertRowid;
  const user = { id, name: 'Test Admin', email, role: 'ADMIN' };
  return { ...user, token: signToken(user), password: 'Password123!' };
}

/**
 * Build a complete venue + layout + event + show through the public API,
 * so the fixtures exercise the same code paths a real operator would.
 *
 * `rows` example: [{ rowLabel: 'A', seats: 2, category: 'Premium' }]
 */
export async function buildShow({
  admin,
  organiser,
  rows = [
    { rowLabel: 'A', seats: 4, category: 'Premium' },
    { rowLabel: 'B', seats: 6, category: 'Standard' },
  ],
  prices = { Premium: 500, Standard: 200 },
  startsInDays = 3,
  title = 'Test Event',
} = {}) {
  const venueRes = await api('/api/admin/venues', {
    method: 'POST',
    token: admin.token,
    body: { name: `Venue ${uniqueEmail('v')}`, city: 'Testville' },
  });
  const venue = venueRes.body.venue;

  const categoryNames = [...new Set(rows.map((r) => r.category))];
  const categories = {};
  for (const [i, name] of categoryNames.entries()) {
    const res = await api(`/api/admin/venues/${venue.id}/categories`, {
      method: 'POST',
      token: admin.token,
      body: { name, rank: i },
    });
    categories[name] = res.body.category;
  }

  await api(`/api/admin/venues/${venue.id}/layout`, {
    method: 'PUT',
    token: admin.token,
    body: {
      rows: rows.map((r) => ({
        rowLabel: r.rowLabel,
        seats: r.seats,
        categoryId: categories[r.category].id,
      })),
    },
  });

  const eventRes = await api('/api/organiser/events', {
    method: 'POST',
    token: organiser.token,
    body: { title: `${title} ${uniqueEmail('e')}`, type: 'MOVIE', description: 'Fixture event' },
  });
  const event = eventRes.body.event;

  const startsAt = new Date(Date.now() + startsInDays * 86400000).toISOString();
  const showRes = await api(`/api/organiser/events/${event.id}/shows`, {
    method: 'POST',
    token: organiser.token,
    body: {
      venueId: venue.id,
      startsAt,
      prices: Object.entries(prices).map(([name, price]) => ({
        categoryId: categories[name].id,
        price,
      })),
    },
  });
  if (showRes.status !== 201) throw new Error(`show failed: ${JSON.stringify(showRes.body)}`);

  return {
    venue,
    categories,
    event,
    show: showRes.body.show,
    seatsCreated: showRes.body.seatsCreated,
  };
}

export async function seatMap(showId, token) {
  const res = await api(`/api/events/shows/${showId}/seatmap`, { token });
  return res.body;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
