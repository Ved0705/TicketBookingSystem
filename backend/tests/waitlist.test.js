import {
  startServer, stopServer, api, register, createAdmin, buildShow, seatMap, sleep,
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

/** A show with exactly two Premium seats — easy to sell out. */
async function tinyShow() {
  return buildShow({
    admin,
    organiser,
    rows: [{ rowLabel: 'A', seats: 2, category: 'Premium' }],
    prices: { Premium: 500 },
  });
}

/** A show with exactly ONE Premium seat — makes queue ordering unambiguous. */
async function oneSeatShow() {
  return buildShow({
    admin,
    organiser,
    rows: [{ rowLabel: 'A', seats: 1, category: 'Premium' }],
    prices: { Premium: 500 },
  });
}

/** Hold + book every remaining seat of a show as one customer. */
async function sellOut(showId, customer) {
  const map = await seatMap(showId);
  const ids = map.seats.filter((s) => s.status === 'AVAILABLE').map((s) => s.id);
  const hold = await api('/api/holds', {
    method: 'POST', token: customer.token, body: { showId, seatIds: ids },
  });
  const booking = await api('/api/bookings', {
    method: 'POST', token: customer.token, body: { holdId: hold.body.holdId },
  });
  assert.equal(booking.status, 201);
  return booking.body.booking;
}

describe('joining the waitlist', () => {
  test('the waitlist is refused while seats are still available', async () => {
    const f = await tinyShow();
    const customer = await register('CUSTOMER');
    const res = await api('/api/waitlist', {
      method: 'POST', token: customer.token,
      body: { showId: f.show.id, categoryId: f.categories.Premium.id },
    });
    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /still has/i);
  });

  test('a customer can join once a category is sold out', async () => {
    const f = await tinyShow();
    const buyer = await register('CUSTOMER');
    await sellOut(f.show.id, buyer);

    const map = await seatMap(f.show.id);
    assert.equal(map.categories.find((c) => c.name === 'Premium').soldOut, true);

    const waiter = await register('CUSTOMER');
    const res = await api('/api/waitlist', {
      method: 'POST', token: waiter.token,
      body: { showId: f.show.id, categoryId: f.categories.Premium.id },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'WAITING');
    assert.equal(res.body.position, 1);
    assert.equal(res.body.peopleAhead, 0);
  });

  test('the same customer cannot join the same queue twice', async () => {
    const f = await tinyShow();
    await sellOut(f.show.id, await register('CUSTOMER'));
    const waiter = await register('CUSTOMER');
    const body = { showId: f.show.id, categoryId: f.categories.Premium.id };

    assert.equal((await api('/api/waitlist', { method: 'POST', token: waiter.token, body })).status, 201);
    const again = await api('/api/waitlist', { method: 'POST', token: waiter.token, body });
    assert.equal(again.status, 409);
  });

  test('positions are assigned FIFO in join order', async () => {
    const f = await tinyShow();
    await sellOut(f.show.id, await register('CUSTOMER'));

    const waiters = [];
    for (let i = 0; i < 3; i += 1) {
      const w = await register('CUSTOMER', `Waiter ${i}`);
      const res = await api('/api/waitlist', {
        method: 'POST', token: w.token,
        body: { showId: f.show.id, categoryId: f.categories.Premium.id },
      });
      waiters.push({ user: w, entry: res.body });
    }

    assert.deepEqual(waiters.map((w) => w.entry.position), [1, 2, 3]);
    assert.deepEqual(waiters.map((w) => w.entry.peopleAhead), [0, 1, 2]);
  });

  test('a customer can leave the waitlist', async () => {
    const f = await tinyShow();
    await sellOut(f.show.id, await register('CUSTOMER'));
    const waiter = await register('CUSTOMER');
    const entry = await api('/api/waitlist', {
      method: 'POST', token: waiter.token,
      body: { showId: f.show.id, categoryId: f.categories.Premium.id },
    });
    const res = await api(`/api/waitlist/${entry.body.waitlistId}`, {
      method: 'DELETE', token: waiter.token,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'CANCELLED');
  });
});

describe('CRITICAL: cancellation hands the seat to the waitlist', () => {
  test('the first person in the queue receives the offer, nobody else does', async () => {
    const f = await tinyShow();
    const buyer = await register('CUSTOMER');
    const booking = await sellOut(f.show.id, buyer);

    const first = await register('CUSTOMER', 'First In Line');
    const second = await register('CUSTOMER', 'Second In Line');
    for (const w of [first, second]) {
      await api('/api/waitlist', {
        method: 'POST', token: w.token,
        body: { showId: f.show.id, categoryId: f.categories.Premium.id },
      });
    }

    const cancel = await api(`/api/bookings/${booking.id}/cancel`, {
      method: 'POST', token: buyer.token,
    });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.seatsReleased, 2);
    // Two seats freed, two people waiting -> both get an offer, one seat each.
    assert.equal(cancel.body.offersCreated, 2);

    const firstList = (await api('/api/waitlist', { token: first.token })).body.entries;
    const secondList = (await api('/api/waitlist', { token: second.token })).body.entries;

    assert.equal(firstList[0].status, 'OFFERED');
    assert.ok(firstList[0].offer, 'first in line must have a pending offer');
    assert.equal(secondList[0].status, 'OFFERED');
    assert.notEqual(
      firstList[0].offer.showSeatId,
      secondList[0].offer.showSeatId,
      'the same seat must never be offered to two customers'
    );
  });

  test('an offered seat is not selectable by the general public', async () => {
    const f = await tinyShow();
    const buyer = await register('CUSTOMER');
    const booking = await sellOut(f.show.id, buyer);

    const waiter = await register('CUSTOMER');
    await api('/api/waitlist', {
      method: 'POST', token: waiter.token,
      body: { showId: f.show.id, categoryId: f.categories.Premium.id },
    });
    await api(`/api/bookings/${booking.id}/cancel`, { method: 'POST', token: buyer.token });

    const map = await seatMap(f.show.id);
    const offered = map.seats.filter((s) => s.status === 'OFFERED');
    assert.equal(offered.length, 1, 'exactly one seat is reserved for the waitlist');

    const outsider = await register('CUSTOMER');
    const grab = await api('/api/holds', {
      method: 'POST', token: outsider.token,
      body: { showId: f.show.id, seatIds: [offered[0].id] },
    });
    assert.equal(grab.status, 409, 'an OFFERED seat cannot be grabbed by anyone else');
  });

  test('accepting an offer creates a hold that can be checked out', async () => {
    const f = await tinyShow();
    const buyer = await register('CUSTOMER');
    const booking = await sellOut(f.show.id, buyer);

    const waiter = await register('CUSTOMER');
    await api('/api/waitlist', {
      method: 'POST', token: waiter.token,
      body: { showId: f.show.id, categoryId: f.categories.Premium.id },
    });
    await api(`/api/bookings/${booking.id}/cancel`, { method: 'POST', token: buyer.token });

    const entry = (await api('/api/waitlist', { token: waiter.token })).body.entries[0];
    const accept = await api(`/api/waitlist/offers/${entry.offer.id}/accept`, {
      method: 'POST', token: waiter.token,
    });
    assert.equal(accept.status, 200);
    assert.ok(accept.body.holdId);

    const confirmed = await api('/api/bookings', {
      method: 'POST', token: waiter.token, body: { holdId: accept.body.holdId },
    });
    assert.equal(confirmed.status, 201);
    assert.equal(confirmed.body.booking.seats.length, 1);

    const after = (await api('/api/waitlist', { token: waiter.token })).body.entries[0];
    assert.equal(after.status, 'FULFILLED');
  });

  test('an offer cannot be accepted by the wrong customer', async () => {
    const f = await tinyShow();
    const buyer = await register('CUSTOMER');
    const booking = await sellOut(f.show.id, buyer);

    const waiter = await register('CUSTOMER');
    const intruder = await register('CUSTOMER');
    await api('/api/waitlist', {
      method: 'POST', token: waiter.token,
      body: { showId: f.show.id, categoryId: f.categories.Premium.id },
    });
    await api(`/api/bookings/${booking.id}/cancel`, { method: 'POST', token: buyer.token });

    const entry = (await api('/api/waitlist', { token: waiter.token })).body.entries[0];
    const res = await api(`/api/waitlist/offers/${entry.offer.id}/accept`, {
      method: 'POST', token: intruder.token,
    });
    assert.equal(res.status, 403);
  });
});

describe('CRITICAL: offers expire and roll on to the next customer', () => {
  test('an ignored offer expires and the next person in line receives it', async () => {
    // Exactly one seat, so exactly one offer can exist at a time.
    const f = await oneSeatShow();
    const buyer = await register('CUSTOMER');
    const booking = await sellOut(f.show.id, buyer);

    // Two people wait for the single seat, so ordering is visible.
    const first = await register('CUSTOMER', 'Ignores The Offer');
    const second = await register('CUSTOMER', 'Next In Line');
    for (const w of [first, second]) {
      await api('/api/waitlist', {
        method: 'POST', token: w.token,
        body: { showId: f.show.id, categoryId: f.categories.Premium.id },
      });
    }

    await api(`/api/bookings/${booking.id}/cancel`, { method: 'POST', token: buyer.token });

    const firstEntry = (await api('/api/waitlist', { token: first.token })).body.entries[0];
    assert.ok(firstEntry.offer, 'first person got an offer');
    const offeredSeatId = firstEntry.offer.showSeatId;

    // Offer TTL is 2s in the test environment. Do nothing and let it lapse.
    await sleep(2600);

    // Reading any waitlist/seat endpoint forces a sweep; the scheduler also runs.
    const firstAfter = (await api('/api/waitlist', { token: first.token })).body.entries[0];
    assert.equal(firstAfter.status, 'EXPIRED');
    assert.equal(firstAfter.offer, null);

    const secondAfter = (await api('/api/waitlist', { token: second.token })).body.entries[0];
    assert.equal(secondAfter.status, 'OFFERED');
    assert.ok(secondAfter.offer, 'the seat rolled on to the next customer');
    assert.equal(
      secondAfter.offer.showSeatId,
      offeredSeatId,
      'it is the same seat, re-offered'
    );
  });

  test('an expired offer can no longer be accepted', async () => {
    const f = await tinyShow();
    const buyer = await register('CUSTOMER');
    const booking = await sellOut(f.show.id, buyer);
    const waiter = await register('CUSTOMER');
    await api('/api/waitlist', {
      method: 'POST', token: waiter.token,
      body: { showId: f.show.id, categoryId: f.categories.Premium.id },
    });
    await api(`/api/bookings/${booking.id}/cancel`, { method: 'POST', token: buyer.token });

    const entry = (await api('/api/waitlist', { token: waiter.token })).body.entries[0];
    await sleep(2600);

    const res = await api(`/api/waitlist/offers/${entry.offer.id}/accept`, {
      method: 'POST', token: waiter.token,
    });
    assert.equal(res.status, 409);
  });

  test('when the queue empties, the seat returns to the public pool', async () => {
    const f = await tinyShow();
    const buyer = await register('CUSTOMER');
    const booking = await sellOut(f.show.id, buyer);

    const waiter = await register('CUSTOMER');
    await api('/api/waitlist', {
      method: 'POST', token: waiter.token,
      body: { showId: f.show.id, categoryId: f.categories.Premium.id },
    });
    await api(`/api/bookings/${booking.id}/cancel`, { method: 'POST', token: buyer.token });

    await sleep(2600); // the only waiter ignores their offer

    const map = await seatMap(f.show.id);
    const statuses = map.seats.map((s) => s.status).sort();
    assert.deepEqual(statuses, ['AVAILABLE', 'AVAILABLE']);
  });

  test('declining an offer immediately re-offers the seat', async () => {
    const f = await tinyShow();
    const buyer = await register('CUSTOMER');
    const booking = await sellOut(f.show.id, buyer);

    const first = await register('CUSTOMER');
    const second = await register('CUSTOMER');
    for (const w of [first, second]) {
      await api('/api/waitlist', {
        method: 'POST', token: w.token,
        body: { showId: f.show.id, categoryId: f.categories.Premium.id },
      });
    }
    // Cancel frees two seats for two waiters; both hold an offer already.
    await api(`/api/bookings/${booking.id}/cancel`, { method: 'POST', token: buyer.token });

    const third = await register('CUSTOMER');
    // Third joins behind them (category is not "available", it is all OFFERED).
    const join = await api('/api/waitlist', {
      method: 'POST', token: third.token,
      body: { showId: f.show.id, categoryId: f.categories.Premium.id },
    });
    assert.equal(join.status, 201);

    const firstEntry = (await api('/api/waitlist', { token: first.token })).body.entries[0];
    const decline = await api(`/api/waitlist/offers/${firstEntry.offer.id}/decline`, {
      method: 'POST', token: first.token,
    });
    assert.equal(decline.status, 200);
    assert.equal(decline.body.reoffered, true);

    const thirdEntry = (await api('/api/waitlist', { token: third.token })).body.entries[0];
    assert.equal(thirdEntry.status, 'OFFERED');
    assert.equal(thirdEntry.offer.showSeatId, firstEntry.offer.showSeatId);
  });
});
