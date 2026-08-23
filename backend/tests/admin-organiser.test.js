import {
  startServer, stopServer, api, register, createAdmin, buildShow, seatMap, uniqueEmail,
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

describe('admin: venues, categories and seat layout', () => {
  test('an admin can create a venue, categories and a seat layout', async () => {
    const venue = (await api('/api/admin/venues', {
      method: 'POST', token: admin.token,
      body: { name: `Odeon ${uniqueEmail('v')}`, city: 'Kochi', address: '1 MG Road' },
    })).body.venue;

    const premium = (await api(`/api/admin/venues/${venue.id}/categories`, {
      method: 'POST', token: admin.token, body: { name: 'Premium', rank: 0 },
    })).body.category;
    const standard = (await api(`/api/admin/venues/${venue.id}/categories`, {
      method: 'POST', token: admin.token, body: { name: 'Standard', rank: 1 },
    })).body.category;

    const layout = await api(`/api/admin/venues/${venue.id}/layout`, {
      method: 'PUT', token: admin.token,
      body: {
        rows: [
          { rowLabel: 'A', seats: 5, categoryId: premium.id },
          { rowLabel: 'B', seats: 7, categoryId: standard.id },
        ],
      },
    });
    assert.equal(layout.status, 200);
    assert.equal(layout.body.seatCount, 12);

    const detail = await api(`/api/admin/venues/${venue.id}`, { token: admin.token });
    assert.equal(detail.body.seats.length, 12);
    assert.equal(detail.body.categories.length, 2);
    // Individual seats are addressable, not just row counts.
    assert.ok(detail.body.seats.some((s) => s.row_label === 'A' && s.seat_number === 5));
  });

  test('duplicate categories are rejected', async () => {
    const venue = (await api('/api/admin/venues', {
      method: 'POST', token: admin.token, body: { name: `Dup ${uniqueEmail('v')}`, city: 'Pune' },
    })).body.venue;
    const body = { name: 'Premium', rank: 0 };
    assert.equal((await api(`/api/admin/venues/${venue.id}/categories`, { method: 'POST', token: admin.token, body })).status, 201);
    assert.equal((await api(`/api/admin/venues/${venue.id}/categories`, { method: 'POST', token: admin.token, body })).status, 409);
  });

  test('a layout cannot reference a category from another venue', async () => {
    const venue = (await api('/api/admin/venues', {
      method: 'POST', token: admin.token, body: { name: `X ${uniqueEmail('v')}`, city: 'Delhi' },
    })).body.venue;
    const res = await api(`/api/admin/venues/${venue.id}/layout`, {
      method: 'PUT', token: admin.token,
      body: { rows: [{ rowLabel: 'A', seats: 3, categoryId: 999999 }] },
    });
    assert.equal(res.status, 400);
  });

  test('a layout cannot be rewritten once a show is selling those seats', async () => {
    const f = await buildShow({ admin, organiser });
    const res = await api(`/api/admin/venues/${f.venue.id}/layout`, {
      method: 'PUT', token: admin.token,
      body: { rows: [{ rowLabel: 'Z', seats: 2, categoryId: f.categories.Premium.id }] },
    });
    assert.equal(res.status, 409);
  });

  test('a venue with scheduled shows cannot be deleted', async () => {
    const f = await buildShow({ admin, organiser });
    const res = await api(`/api/admin/venues/${f.venue.id}`, { method: 'DELETE', token: admin.token });
    assert.equal(res.status, 409);
  });

  test('admin stats reflect the platform', async () => {
    const res = await api('/api/admin/stats', { token: admin.token });
    assert.equal(res.status, 200);
    assert.ok(res.body.venues > 0);
    assert.ok(typeof res.body.revenue === 'number');
  });
});

describe('organiser: events, shows, pricing and revenue', () => {
  test('creating a show materialises per-show seat inventory', async () => {
    const f = await buildShow({ admin, organiser });
    assert.equal(f.seatsCreated, 10);
    const map = await seatMap(f.show.id);
    assert.equal(map.seats.length, 10);
    assert.ok(map.seats.every((s) => s.status === 'AVAILABLE'));
  });

  test('a show cannot be created without a price for every category', async () => {
    const f = await buildShow({ admin, organiser });
    const res = await api(`/api/organiser/events/${f.event.id}/shows`, {
      method: 'POST', token: organiser.token,
      body: {
        venueId: f.venue.id,
        startsAt: new Date(Date.now() + 86400000).toISOString(),
        prices: [{ categoryId: f.categories.Premium.id, price: 300 }],
      },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /price for every category/i);
  });

  test('an organiser cannot touch another organiser\'s event', async () => {
    const f = await buildShow({ admin, organiser });
    const intruder = await register('ORGANISER');

    assert.equal((await api(`/api/organiser/events/${f.event.id}`, { token: intruder.token })).status, 403);
    assert.equal(
      (await api(`/api/organiser/events/${f.event.id}`, {
        method: 'PATCH', token: intruder.token, body: { title: 'Hijacked' },
      })).status,
      403
    );
    assert.equal(
      (await api(`/api/organiser/events/${f.event.id}`, { method: 'DELETE', token: intruder.token })).status,
      403
    );
  });

  test('the booking summary and revenue reflect confirmed bookings only', async () => {
    const f = await buildShow({ admin, organiser, prices: { Premium: 500, Standard: 200 } });
    const map = await seatMap(f.show.id);
    const premium = map.seats.filter((s) => s.category === 'Premium').slice(0, 2);

    const buyer = await register('CUSTOMER');
    const hold = await api('/api/holds', {
      method: 'POST', token: buyer.token,
      body: { showId: f.show.id, seatIds: premium.map((s) => s.id) },
    });
    const booking = (await api('/api/bookings', {
      method: 'POST', token: buyer.token, body: { holdId: hold.body.holdId },
    })).body.booking;
    assert.equal(booking.total, 1000);

    const summary = await api(`/api/organiser/events/${f.event.id}/summary`, { token: organiser.token });
    assert.equal(summary.status, 200);
    assert.equal(summary.body.totals.seatsBooked, 2);
    assert.equal(summary.body.totals.revenue, 1000);
    assert.equal(summary.body.byCategory.find((c) => c.category === 'Premium').seats_sold, 2);

    // Cancelling removes it from revenue.
    await api(`/api/bookings/${booking.id}/cancel`, { method: 'POST', token: buyer.token });
    const after = await api(`/api/organiser/events/${f.event.id}/summary`, { token: organiser.token });
    assert.equal(after.body.totals.revenue, 0);
    assert.equal(after.body.totals.cancelledBookings, 1);
  });

  test('the organiser can list bookings for their show with customer detail', async () => {
    const f = await buildShow({ admin, organiser });
    const seat = (await seatMap(f.show.id)).seats[0];
    const buyer = await register('CUSTOMER', 'Nisha Rao');
    const hold = await api('/api/holds', {
      method: 'POST', token: buyer.token, body: { showId: f.show.id, seatIds: [seat.id] },
    });
    await api('/api/bookings', { method: 'POST', token: buyer.token, body: { holdId: hold.body.holdId } });

    const res = await api(`/api/organiser/shows/${f.show.id}/bookings`, { token: organiser.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.bookings.length, 1);
    assert.equal(res.body.bookings[0].customer, 'Nisha Rao');
    assert.ok(res.body.bookings[0].seats);
  });

  test('revenue is reported per event', async () => {
    const res = await api('/api/organiser/revenue', { token: organiser.token });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.events));
    assert.ok(typeof res.body.total === 'number');
  });
});

describe('public browsing and filtering', () => {
  test('events can be filtered by search text, type and city', async () => {
    await buildShow({ admin, organiser, title: 'Zephyr Nights' });

    const all = await api('/api/events');
    assert.equal(all.status, 200);
    assert.ok(all.body.events.length > 0);

    const byText = await api('/api/events?q=Zephyr');
    assert.ok(byText.body.events.every((e) => /Zephyr/i.test(e.title)));
    assert.ok(byText.body.events.length >= 1);

    const byType = await api('/api/events?type=CONCERT');
    assert.ok(byType.body.events.every((e) => e.type === 'CONCERT'));

    const byCity = await api('/api/events?city=Testville');
    assert.ok(byCity.body.events.length > 0);

    const noMatch = await api('/api/events?city=Atlantis');
    assert.equal(noMatch.body.events.length, 0);
  });

  test('event detail lists upcoming shows with availability', async () => {
    const f = await buildShow({ admin, organiser });
    const res = await api(`/api/events/${f.event.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.shows.length, 1);
    assert.equal(res.body.shows[0].seatsAvailable, 10);
    assert.equal(res.body.shows[0].soldOut, false);
    assert.ok(res.body.event.organiser);
  });

  test('unknown events and shows return 404', async () => {
    assert.equal((await api('/api/events/999999')).status, 404);
    assert.equal((await api('/api/events/shows/999999/seatmap')).status, 404);
  });
});
