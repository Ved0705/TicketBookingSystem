import {
  startServer, stopServer, api, register, createAdmin, buildShow, seatMap,
} from './helpers.js';
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

let admin, organiser;

before(async () => {
  await startServer();
  admin = await createAdmin();
  organiser = await register('ORGANISER');
});
after(async () => { await stopServer(); });

async function bookOneSeat(customer) {
  const f = await buildShow({
    admin, organiser,
    rows: [{ rowLabel: 'A', seats: 2, category: 'Premium' }],
    prices: { Premium: 750 },
  });
  const seat = (await seatMap(f.show.id)).seats[0];
  const hold = await api('/api/holds', {
    method: 'POST', token: customer.token, body: { showId: f.show.id, seatIds: [seat.id] },
  });
  const res = await api('/api/bookings', {
    method: 'POST', token: customer.token, body: { holdId: hold.body.holdId },
  });
  assert.equal(res.status, 201);
  return { fixture: f, booking: res.body.booking };
}

describe('booking reference and QR code', () => {
  test('every booking gets a unique, readable reference', async () => {
    const seen = new Set();
    for (let i = 0; i < 3; i += 1) {
      const customer = await register('CUSTOMER');
      const { booking } = await bookOneSeat(customer);
      assert.match(booking.reference, /^TBS-[A-Z2-9]{8}$/);
      // Ambiguous glyphs are excluded so the code can be read aloud.
      assert.ok(!/[IO01]/.test(booking.reference.slice(4)));
      assert.equal(seen.has(booking.reference), false, 'references must be unique');
      seen.add(booking.reference);
    }
  });

  test('the QR code is a real PNG and encodes exactly the booking reference', async () => {
    const customer = await register('CUSTOMER');
    const { booking } = await bookOneSeat(customer);

    assert.ok(booking.qrDataUrl.startsWith('data:image/png;base64,'));
    const bytes = Buffer.from(booking.qrDataUrl.split(',')[1], 'base64');
    assert.deepEqual(
      [...bytes.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      'must carry a valid PNG signature'
    );
    assert.ok(bytes.length > 200, 'must not be an empty image');

    // What the QR encodes is stored alongside the booking; assert it matches.
    const { db } = await import('../src/db/index.js');
    const row = db.prepare('SELECT qr_payload FROM bookings WHERE id = ?').get(booking.id);
    assert.equal(row.qr_payload, booking.reference);

    // Re-encoding the reference reproduces the same image, which confirms the
    // payload that went into the QR is the reference and nothing else.
    const { qrDataUrl } = await import('../src/utils/qr.js');
    assert.equal(await qrDataUrl(booking.reference), booking.qrDataUrl);
  });

  test('the QR is available again when re-reading the booking', async () => {
    const customer = await register('CUSTOMER');
    const { booking } = await bookOneSeat(customer);
    const res = await api(`/api/bookings/${booking.id}`, { token: customer.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.booking.qrDataUrl, booking.qrDataUrl);
  });
});

describe('ticket email', () => {
  test('confirming a booking sends a ticket email and records it', async () => {
    const customer = await register('CUSTOMER');
    const { booking } = await bookOneSeat(customer);

    assert.ok(booking.email, 'the API reports the delivery outcome');
    assert.equal(booking.email.ok, true);
    assert.equal(booking.email.to, customer.email);

    const { db } = await import('../src/db/index.js');
    const row = db
      .prepare('SELECT * FROM email_log WHERE to_email = ? ORDER BY id DESC LIMIT 1')
      .get(customer.email);

    assert.ok(row, 'the send is recorded in email_log');
    assert.equal(row.status, 'SENT');
    assert.match(row.subject, new RegExp(booking.reference));
  });

  test('the email body carries the event, venue, seats, reference and QR image', async () => {
    const customer = await register('CUSTOMER');
    const { fixture, booking } = await bookOneSeat(customer);

    const { db } = await import('../src/db/index.js');
    const row = db
      .prepare('SELECT * FROM email_log WHERE to_email = ? ORDER BY id DESC LIMIT 1')
      .get(customer.email);

    assert.match(row.body, new RegExp(fixture.event.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(row.body, new RegExp(fixture.venue.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(row.body, new RegExp(booking.reference));
    assert.match(row.body, /A1/, 'seat label');
    assert.match(row.body, /data:image\/png;base64,/, 'inline QR image');
  });

  test('the developer outbox endpoint exposes what was sent', async () => {
    const customer = await register('CUSTOMER');
    const { booking } = await bookOneSeat(customer);

    const list = await api('/api/dev/emails?limit=5');
    assert.equal(list.status, 200);
    assert.ok(list.body.emails.length > 0);

    const mine = list.body.emails.find((e) => e.to_email === customer.email);
    assert.ok(mine, 'the ticket email is listed');
    assert.match(mine.subject, new RegExp(booking.reference));

    const html = await fetch(`${(await startServer())}/api/dev/emails/${mine.id}`);
    assert.equal(html.status, 200);
    assert.match(await html.text(), new RegExp(booking.reference));
  });

  test('a customer can re-send their own ticket but not someone else\'s', async () => {
    const customer = await register('CUSTOMER');
    const stranger = await register('CUSTOMER');
    const { booking } = await bookOneSeat(customer);

    const resend = await api(`/api/bookings/${booking.id}/resend-ticket`, {
      method: 'POST', token: customer.token,
    });
    assert.equal(resend.status, 200);
    assert.equal(resend.body.email.ok, true);

    const stolen = await api(`/api/bookings/${booking.id}/resend-ticket`, {
      method: 'POST', token: stranger.token,
    });
    assert.equal(stolen.status, 403);
  });

  test('a waitlist offer sends an email to the offered customer', async () => {
    const f = await buildShow({
      admin, organiser,
      rows: [{ rowLabel: 'A', seats: 1, category: 'Premium' }],
      prices: { Premium: 500 },
    });
    const buyer = await register('CUSTOMER');
    const seat = (await seatMap(f.show.id)).seats[0];
    const hold = await api('/api/holds', {
      method: 'POST', token: buyer.token, body: { showId: f.show.id, seatIds: [seat.id] },
    });
    const booking = (await api('/api/bookings', {
      method: 'POST', token: buyer.token, body: { holdId: hold.body.holdId },
    })).body.booking;

    const waiter = await register('CUSTOMER');
    await api('/api/waitlist', {
      method: 'POST', token: waiter.token,
      body: { showId: f.show.id, categoryId: f.categories.Premium.id },
    });
    await api(`/api/bookings/${booking.id}/cancel`, { method: 'POST', token: buyer.token });

    // The offer email is dispatched without blocking the cancellation response.
    await new Promise((r) => setTimeout(r, 250));

    const { db } = await import('../src/db/index.js');
    const row = db
      .prepare('SELECT * FROM email_log WHERE to_email = ? ORDER BY id DESC LIMIT 1')
      .get(waiter.email);
    assert.ok(row, 'the waitlist offer email was sent');
    assert.match(row.subject, /accept within/i);
    assert.match(row.body, /A1/);
  });
});
