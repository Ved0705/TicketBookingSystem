import {
  startServer, stopServer, api, register, createAdmin, buildShow, seatMap, wsUrl, sleep,
} from './helpers.js';
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

let admin, organiser;

before(async () => {
  await startServer();
  admin = await createAdmin();
  organiser = await register('ORGANISER');
});
after(async () => { await stopServer(); });

/**
 * Open a websocket subscribed to one show and collect frames.
 * Resolves once the socket is connected so no event is missed.
 */
async function listen(showId) {
  const ws = new WebSocket(wsUrl(showId));
  const frames = [];
  // Attach the listener before awaiting 'open' so the server's greeting frame,
  // which is sent immediately on connection, is never missed.
  ws.on('message', (buf) => {
    try { frames.push(JSON.parse(buf.toString())); } catch { /* ignore */ }
  });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  return {
    frames,
    seatUpdates: () => frames.filter((f) => f.type === 'seats.updated'),
    /** Wait until a frame satisfying `match` arrives, or fail after `timeout`. */
    async waitFor(match, timeout = 3000) {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const hit = frames.find(match);
        if (hit) return hit;
        await sleep(25);
      }
      throw new Error(`no matching frame within ${timeout}ms. Got: ${JSON.stringify(frames)}`);
    },
    close: () => ws.close(),
  };
}

const seatIn = (frame, seatId) => frame.seats.find((s) => s.id === seatId);

describe('real-time seat map over WebSockets', () => {
  test('a client is greeted with its subscription', async () => {
    const f = await buildShow({ admin, organiser, rows: [{ rowLabel: 'A', seats: 2, category: 'Premium' }], prices: { Premium: 100 } });
    const client = await listen(f.show.id);
    const hello = await client.waitFor((x) => x.type === 'connected');
    assert.equal(hello.showId, f.show.id);
    client.close();
  });

  test('HELD is pushed to other viewers when someone holds a seat', async () => {
    const f = await buildShow({ admin, organiser, rows: [{ rowLabel: 'A', seats: 3, category: 'Premium' }], prices: { Premium: 100 } });
    const client = await listen(f.show.id);
    const seat = (await seatMap(f.show.id)).seats[0];
    const customer = await register('CUSTOMER');

    await api('/api/holds', {
      method: 'POST', token: customer.token, body: { showId: f.show.id, seatIds: [seat.id] },
    });

    const frame = await client.waitFor(
      (x) => x.type === 'seats.updated' && seatIn(x, seat.id)?.status === 'HELD'
    );
    assert.equal(frame.reason, 'hold');
    assert.equal(frame.showId, f.show.id);
    assert.ok(frame.at, 'frames carry a timestamp');
    client.close();
  });

  test('BOOKED is pushed when a hold is checked out', async () => {
    const f = await buildShow({ admin, organiser, rows: [{ rowLabel: 'A', seats: 3, category: 'Premium' }], prices: { Premium: 100 } });
    const client = await listen(f.show.id);
    const seat = (await seatMap(f.show.id)).seats[0];
    const customer = await register('CUSTOMER');

    const hold = await api('/api/holds', {
      method: 'POST', token: customer.token, body: { showId: f.show.id, seatIds: [seat.id] },
    });
    await api('/api/bookings', {
      method: 'POST', token: customer.token, body: { holdId: hold.body.holdId },
    });

    const frame = await client.waitFor(
      (x) => x.type === 'seats.updated' && seatIn(x, seat.id)?.status === 'BOOKED'
    );
    assert.equal(frame.reason, 'booked');
    client.close();
  });

  test('AVAILABLE is pushed when a hold expires, with no client involvement', async () => {
    const f = await buildShow({ admin, organiser, rows: [{ rowLabel: 'A', seats: 3, category: 'Premium' }], prices: { Premium: 100 } });
    const client = await listen(f.show.id);
    const seat = (await seatMap(f.show.id)).seats[0];
    const customer = await register('CUSTOMER');

    await api('/api/holds', {
      method: 'POST', token: customer.token,
      body: { showId: f.show.id, seatIds: [seat.id], ttlSeconds: 1 },
    });
    await client.waitFor((x) => x.type === 'seats.updated' && seatIn(x, seat.id)?.status === 'HELD');

    // Nothing further is sent by the test — the background sweeper does this.
    const frame = await client.waitFor(
      (x) => x.type === 'seats.updated' && x.reason === 'expiry' && seatIn(x, seat.id)?.status === 'AVAILABLE',
      6000
    );
    assert.equal(seatIn(frame, seat.id).status, 'AVAILABLE');
    client.close();
  });

  test('AVAILABLE is pushed when a booking is cancelled', async () => {
    const f = await buildShow({ admin, organiser, rows: [{ rowLabel: 'A', seats: 3, category: 'Premium' }], prices: { Premium: 100 } });
    const client = await listen(f.show.id);
    const seat = (await seatMap(f.show.id)).seats[0];
    const customer = await register('CUSTOMER');

    const hold = await api('/api/holds', {
      method: 'POST', token: customer.token, body: { showId: f.show.id, seatIds: [seat.id] },
    });
    const booking = (await api('/api/bookings', {
      method: 'POST', token: customer.token, body: { holdId: hold.body.holdId },
    })).body.booking;

    await api(`/api/bookings/${booking.id}/cancel`, { method: 'POST', token: customer.token });

    const frame = await client.waitFor(
      (x) => x.type === 'seats.updated' && x.reason === 'cancelled' && seatIn(x, seat.id)?.status === 'AVAILABLE'
    );
    assert.ok(frame);
    client.close();
  });

  test('updates are scoped to the show a client subscribed to', async () => {
    const a = await buildShow({ admin, organiser, rows: [{ rowLabel: 'A', seats: 2, category: 'Premium' }], prices: { Premium: 100 } });
    const b = await buildShow({ admin, organiser, rows: [{ rowLabel: 'A', seats: 2, category: 'Premium' }], prices: { Premium: 100 } });

    const watcherA = await listen(a.show.id);
    const watcherB = await listen(b.show.id);

    const seatB = (await seatMap(b.show.id)).seats[0];
    const customer = await register('CUSTOMER');
    await api('/api/holds', {
      method: 'POST', token: customer.token, body: { showId: b.show.id, seatIds: [seatB.id] },
    });

    await watcherB.waitFor((x) => x.type === 'seats.updated');
    await sleep(200);
    assert.equal(watcherA.seatUpdates().length, 0, 'show A must not receive show B traffic');

    watcherA.close();
    watcherB.close();
  });

  test('a client can re-subscribe to a different show on the same socket', async () => {
    const a = await buildShow({ admin, organiser, rows: [{ rowLabel: 'A', seats: 2, category: 'Premium' }], prices: { Premium: 100 } });
    const b = await buildShow({ admin, organiser, rows: [{ rowLabel: 'A', seats: 2, category: 'Premium' }], prices: { Premium: 100 } });

    const ws = new WebSocket(wsUrl(a.show.id));
    const frames = [];
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    ws.on('message', (buf) => frames.push(JSON.parse(buf.toString())));

    ws.send(JSON.stringify({ type: 'subscribe', showId: b.show.id }));
    await sleep(150);

    const seatB = (await seatMap(b.show.id)).seats[0];
    const customer = await register('CUSTOMER');
    await api('/api/holds', {
      method: 'POST', token: customer.token, body: { showId: b.show.id, seatIds: [seatB.id] },
    });

    const started = Date.now();
    while (Date.now() - started < 3000) {
      if (frames.some((f) => f.type === 'seats.updated' && f.showId === b.show.id)) break;
      await sleep(25);
    }
    assert.ok(
      frames.some((f) => f.type === 'seats.updated' && f.showId === b.show.id),
      'must receive updates for the newly subscribed show'
    );
    ws.close();
  });
});
