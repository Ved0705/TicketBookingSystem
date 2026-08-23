import {
  startServer, stopServer, api, register, createAdmin, buildShow, seatMap, sleep,
} from './helpers.js';
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

let admin, organiser, fixture;

before(async () => {
  await startServer();
  admin = await createAdmin();
  organiser = await register('ORGANISER');
  fixture = await buildShow({ admin, organiser });
});
after(async () => { await stopServer(); });

const available = (map) => map.seats.filter((s) => s.status === 'AVAILABLE');

describe('seat map', () => {
  test('exposes per-show seats with status, category and price', async () => {
    const map = await seatMap(fixture.show.id);
    assert.equal(map.seats.length, 10);
    assert.equal(map.show.id, fixture.show.id);
    assert.ok(map.categories.find((c) => c.name === 'Premium').price === 500);
    assert.ok(map.seats.every((s) => ['AVAILABLE', 'HELD', 'BOOKED', 'OFFERED'].includes(s.status)));
    assert.equal(map.holdTtlSeconds > 0, true);
  });

  test('seat status is tracked per show, not globally on the venue seat', async () => {
    // A second show at the same venue must start with a clean inventory even
    // after seats are held for the first show.
    const second = await api(`/api/organiser/events/${fixture.event.id}/shows`, {
      method: 'POST',
      token: organiser.token,
      body: {
        venueId: fixture.venue.id,
        startsAt: new Date(Date.now() + 5 * 86400000).toISOString(),
        prices: [
          { categoryId: fixture.categories.Premium.id, price: 500 },
          { categoryId: fixture.categories.Standard.id, price: 200 },
        ],
      },
    });
    assert.equal(second.status, 201);

    const customer = await register('CUSTOMER');
    const mapA = await seatMap(fixture.show.id);
    const seatA = available(mapA)[0];
    await api('/api/holds', {
      method: 'POST', token: customer.token,
      body: { showId: fixture.show.id, seatIds: [seatA.id] },
    });

    const mapB = await seatMap(second.body.show.id);
    assert.equal(available(mapB).length, 10, 'other show must be untouched');
  });
});

describe('seat holds', () => {
  test('a customer can hold a single seat and it shows as HELD to everyone', async () => {
    const customer = await register('CUSTOMER');
    const seat = available(await seatMap(fixture.show.id))[0];

    const res = await api('/api/holds', {
      method: 'POST', token: customer.token,
      body: { showId: fixture.show.id, seatIds: [seat.id] },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.seats.length, 1);
    assert.ok(new Date(res.body.expiresAt) > new Date());

    const publicMap = await seatMap(fixture.show.id);
    assert.equal(publicMap.seats.find((s) => s.id === seat.id).status, 'HELD');
  });

  test('a customer can hold several seats at once and gets the right total', async () => {
    const customer = await register('CUSTOMER');
    const seats = available(await seatMap(fixture.show.id)).slice(0, 3);

    const res = await api('/api/holds', {
      method: 'POST', token: customer.token,
      body: { showId: fixture.show.id, seatIds: seats.map((s) => s.id) },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.seats.length, 3);
    assert.equal(res.body.total, seats.reduce((n, s) => n + s.price, 0));
  });

  test('holding is all-or-nothing when one seat is already taken', async () => {
    const one = await register('CUSTOMER');
    const two = await register('CUSTOMER');
    const seats = available(await seatMap(fixture.show.id)).slice(0, 2);

    await api('/api/holds', {
      method: 'POST', token: one.token,
      body: { showId: fixture.show.id, seatIds: [seats[0].id] },
    });

    const res = await api('/api/holds', {
      method: 'POST', token: two.token,
      body: { showId: fixture.show.id, seatIds: [seats[0].id, seats[1].id] },
    });
    assert.equal(res.status, 409);

    const map = await seatMap(fixture.show.id);
    assert.equal(
      map.seats.find((s) => s.id === seats[1].id).status,
      'AVAILABLE',
      'the second seat must not be left stranded in HELD'
    );
  });

  test('a hold cannot exceed the configured seat limit', async () => {
    const customer = await register('CUSTOMER');
    const ids = available(await seatMap(fixture.show.id)).slice(0, 3).map((s) => s.id);
    const res = await api('/api/holds', {
      method: 'POST', token: customer.token,
      body: { showId: fixture.show.id, seatIds: [...ids, ...ids, ...ids, ...ids] },
    });
    assert.equal(res.status, 400);
  });

  test('a customer can release a hold and the seat returns to AVAILABLE', async () => {
    const customer = await register('CUSTOMER');
    const seat = available(await seatMap(fixture.show.id))[0];
    const hold = await api('/api/holds', {
      method: 'POST', token: customer.token,
      body: { showId: fixture.show.id, seatIds: [seat.id] },
    });

    const res = await api(`/api/holds/${hold.body.holdId}`, { method: 'DELETE', token: customer.token });
    assert.equal(res.status, 200);

    const map = await seatMap(fixture.show.id);
    assert.equal(map.seats.find((s) => s.id === seat.id).status, 'AVAILABLE');
  });

  test('a customer cannot see or release another customer\'s hold', async () => {
    const owner = await register('CUSTOMER');
    const stranger = await register('CUSTOMER');
    const seat = available(await seatMap(fixture.show.id))[0];
    const hold = await api('/api/holds', {
      method: 'POST', token: owner.token,
      body: { showId: fixture.show.id, seatIds: [seat.id] },
    });

    assert.equal((await api(`/api/holds/${hold.body.holdId}`, { token: stranger.token })).status, 403);
    assert.equal(
      (await api(`/api/holds/${hold.body.holdId}`, { method: 'DELETE', token: stranger.token })).status,
      403
    );
  });
});

describe('CRITICAL: hold TTL expires server-side', () => {
  test('an abandoned hold expires and the seat becomes bookable again', async () => {
    const abandoner = await register('CUSTOMER');
    const nextCustomer = await register('CUSTOMER');
    const seat = available(await seatMap(fixture.show.id))[0];

    const hold = await api('/api/holds', {
      method: 'POST', token: abandoner.token,
      body: { showId: fixture.show.id, seatIds: [seat.id], ttlSeconds: 1 },
    });
    assert.equal(hold.status, 201);
    assert.equal((await seatMap(fixture.show.id)).seats.find((s) => s.id === seat.id).status, 'HELD');

    // No frontend timer, no client involvement — just wait.
    await sleep(1400);

    const map = await seatMap(fixture.show.id);
    assert.equal(
      map.seats.find((s) => s.id === seat.id).status,
      'AVAILABLE',
      'the database must release the seat on its own'
    );

    // And another customer can now take it.
    const retake = await api('/api/holds', {
      method: 'POST', token: nextCustomer.token,
      body: { showId: fixture.show.id, seatIds: [seat.id] },
    });
    assert.equal(retake.status, 201);
  });

  test('an expired hold cannot be converted into a booking', async () => {
    const customer = await register('CUSTOMER');
    const seat = available(await seatMap(fixture.show.id))[0];
    const hold = await api('/api/holds', {
      method: 'POST', token: customer.token,
      body: { showId: fixture.show.id, seatIds: [seat.id], ttlSeconds: 1 },
    });

    await sleep(1400);

    const res = await api('/api/bookings', {
      method: 'POST', token: customer.token, body: { holdId: hold.body.holdId },
    });
    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /expired/i);
  });

  test('the hold detail endpoint reports expiry honestly', async () => {
    const customer = await register('CUSTOMER');
    const seat = available(await seatMap(fixture.show.id))[0];
    const hold = await api('/api/holds', {
      method: 'POST', token: customer.token,
      body: { showId: fixture.show.id, seatIds: [seat.id], ttlSeconds: 1 },
    });

    const fresh = await api(`/api/holds/${hold.body.holdId}`, { token: customer.token });
    assert.equal(fresh.body.expired, false);

    await sleep(1400);
    const stale = await api(`/api/holds/${hold.body.holdId}`, { token: customer.token });
    assert.equal(stale.body.expired, true);
    assert.equal(stale.body.status, 'EXPIRED');
  });
});

const freshShow = async () => (await buildShow({ admin, organiser })).show;

describe('bookings', () => {
  test('a held seat can be booked and produces a reference and QR code', async () => {
    const show = await freshShow();
    const customer = await register('CUSTOMER');
    const seats = available(await seatMap(show.id)).slice(0, 2);
    const hold = await api('/api/holds', {
      method: 'POST', token: customer.token,
      body: { showId: show.id, seatIds: seats.map((s) => s.id) },
    });

    const res = await api('/api/bookings', {
      method: 'POST', token: customer.token, body: { holdId: hold.body.holdId },
    });
    assert.equal(res.status, 201);
    const booking = res.body.booking;
    assert.match(booking.reference, /^TBS-[A-Z2-9]{8}$/);
    assert.equal(booking.status, 'CONFIRMED');
    assert.equal(booking.seats.length, 2);
    assert.ok(booking.qrDataUrl.startsWith('data:image/png;base64,'));
    assert.equal(booking.total, seats.reduce((n, s) => n + s.price, 0));

    const map = await seatMap(show.id);
    for (const s of seats) {
      assert.equal(map.seats.find((x) => x.id === s.id).status, 'BOOKED');
    }
  });

  test('the same hold cannot be booked twice', async () => {
    const show = await freshShow();
    const customer = await register('CUSTOMER');
    const seat = available(await seatMap(show.id))[0];
    const hold = await api('/api/holds', {
      method: 'POST', token: customer.token,
      body: { showId: show.id, seatIds: [seat.id] },
    });
    const first = await api('/api/bookings', {
      method: 'POST', token: customer.token, body: { holdId: hold.body.holdId },
    });
    const second = await api('/api/bookings', {
      method: 'POST', token: customer.token, body: { holdId: hold.body.holdId },
    });
    assert.equal(first.status, 201);
    assert.equal(second.status, 409);
  });

  test('a customer cannot book someone else\'s hold', async () => {
    const show = await freshShow();
    const owner = await register('CUSTOMER');
    const thief = await register('CUSTOMER');
    const seat = available(await seatMap(show.id))[0];
    const hold = await api('/api/holds', {
      method: 'POST', token: owner.token,
      body: { showId: show.id, seatIds: [seat.id] },
    });
    const res = await api('/api/bookings', {
      method: 'POST', token: thief.token, body: { holdId: hold.body.holdId },
    });
    assert.equal(res.status, 403);
  });

  test('booking history only ever shows your own bookings', async () => {
    const show = await freshShow();
    const mine = await register('CUSTOMER');
    const theirs = await register('CUSTOMER');

    const seat = available(await seatMap(show.id))[0];
    const hold = await api('/api/holds', {
      method: 'POST', token: mine.token, body: { showId: show.id, seatIds: [seat.id] },
    });
    const booking = (await api('/api/bookings', {
      method: 'POST', token: mine.token, body: { holdId: hold.body.holdId },
    })).body.booking;

    const own = await api('/api/bookings', { token: mine.token });
    assert.equal(own.body.bookings.length, 1);
    assert.equal(own.body.bookings[0].reference, booking.reference);

    const others = await api('/api/bookings', { token: theirs.token });
    assert.equal(others.body.bookings.length, 0);

    const peek = await api(`/api/bookings/${booking.id}`, { token: theirs.token });
    assert.equal(peek.status, 403);
  });
});

describe('cancellation', () => {
  test('cancelling a booking frees the seats again', async () => {
    const show = await freshShow();
    const customer = await register('CUSTOMER');
    const seats = available(await seatMap(show.id)).slice(0, 2);
    const hold = await api('/api/holds', {
      method: 'POST', token: customer.token,
      body: { showId: show.id, seatIds: seats.map((s) => s.id) },
    });
    const booking = (await api('/api/bookings', {
      method: 'POST', token: customer.token, body: { holdId: hold.body.holdId },
    })).body.booking;

    const res = await api(`/api/bookings/${booking.id}/cancel`, {
      method: 'POST', token: customer.token,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'CANCELLED');
    assert.equal(res.body.seatsReleased, 2);

    const map = await seatMap(show.id);
    for (const s of seats) {
      assert.equal(map.seats.find((x) => x.id === s.id).status, 'AVAILABLE');
    }

    const history = await api('/api/bookings', { token: customer.token });
    assert.equal(history.body.bookings[0].status, 'CANCELLED');
  });

  test('a booking cannot be cancelled twice, or by a stranger', async () => {
    const show = await freshShow();
    const customer = await register('CUSTOMER');
    const stranger = await register('CUSTOMER');
    const seat = available(await seatMap(show.id))[0];
    const hold = await api('/api/holds', {
      method: 'POST', token: customer.token, body: { showId: show.id, seatIds: [seat.id] },
    });
    const booking = (await api('/api/bookings', {
      method: 'POST', token: customer.token, body: { holdId: hold.body.holdId },
    })).body.booking;

    const byStranger = await api(`/api/bookings/${booking.id}/cancel`, {
      method: 'POST', token: stranger.token,
    });
    assert.equal(byStranger.status, 403);

    assert.equal((await api(`/api/bookings/${booking.id}/cancel`, { method: 'POST', token: customer.token })).status, 200);
    const twice = await api(`/api/bookings/${booking.id}/cancel`, { method: 'POST', token: customer.token });
    assert.equal(twice.status, 409);
  });
});
