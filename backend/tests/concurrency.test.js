import {
  startServer, stopServer, api, register, createAdmin, buildShow, seatMap, TEST_DB,
} from './helpers.js';
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let admin, organiser;

before(async () => {
  await startServer();
  admin = await createAdmin();
  organiser = await register('ORGANISER');
});
after(async () => { await stopServer(); });

describe('CRITICAL: two customers cannot acquire the same seat', () => {
  test('20 simultaneous holds on one seat produce exactly one winner', async () => {
    const f = await buildShow({
      admin, organiser,
      rows: [{ rowLabel: 'A', seats: 1, category: 'Premium' }],
      prices: { Premium: 500 },
    });
    const seat = (await seatMap(f.show.id)).seats[0];

    const customers = [];
    for (let i = 0; i < 20; i += 1) customers.push(await register('CUSTOMER', `Racer ${i}`));

    // Fire every request before awaiting any of them.
    const results = await Promise.all(
      customers.map((c) =>
        api('/api/holds', {
          method: 'POST', token: c.token,
          body: { showId: f.show.id, seatIds: [seat.id] },
        })
      )
    );

    const winners = results.filter((r) => r.status === 201);
    const losers = results.filter((r) => r.status === 409);

    assert.equal(winners.length, 1, 'exactly one hold may succeed');
    assert.equal(losers.length, 19, 'everyone else must be told the seat is gone');
    assert.ok(losers.every((r) => r.body.error.code === 'CONFLICT'));

    const map = await seatMap(f.show.id);
    assert.equal(map.seats[0].status, 'HELD');
  });

  test('simultaneous multi-seat holds never overlap', async () => {
    const f = await buildShow({
      admin, organiser,
      rows: [{ rowLabel: 'A', seats: 6, category: 'Premium' }],
      prices: { Premium: 500 },
    });
    const seatIds = (await seatMap(f.show.id)).seats.map((s) => s.id);

    // Four customers each ask for an overlapping window of three seats.
    const windows = [
      seatIds.slice(0, 3),
      seatIds.slice(1, 4),
      seatIds.slice(2, 5),
      seatIds.slice(3, 6),
    ];
    const customers = [];
    for (let i = 0; i < windows.length; i += 1) customers.push(await register('CUSTOMER'));

    const results = await Promise.all(
      windows.map((ids, i) =>
        api('/api/holds', {
          method: 'POST', token: customers[i].token,
          body: { showId: f.show.id, seatIds: ids },
        })
      )
    );

    const heldByWinners = results
      .filter((r) => r.status === 201)
      .flatMap((r) => r.body.seats.map((s) => s.id));

    assert.ok(heldByWinners.length > 0, 'at least one request must succeed');
    assert.equal(
      new Set(heldByWinners).size,
      heldByWinners.length,
      'no seat may appear in two successful holds'
    );

    // Every seat is either HELD by a winner or still AVAILABLE — never double-booked.
    const map = await seatMap(f.show.id);
    const held = map.seats.filter((s) => s.status === 'HELD').map((s) => s.id).sort();
    assert.deepEqual(held, [...heldByWinners].sort());
  });

  test('simultaneous checkouts of the same seat cannot both become bookings', async () => {
    const f = await buildShow({
      admin, organiser,
      rows: [{ rowLabel: 'A', seats: 1, category: 'Premium' }],
      prices: { Premium: 500 },
    });
    const seat = (await seatMap(f.show.id)).seats[0];
    const customer = await register('CUSTOMER');

    const hold = await api('/api/holds', {
      method: 'POST', token: customer.token,
      body: { showId: f.show.id, seatIds: [seat.id] },
    });

    // Same hold, submitted five times at once (impatient double-clicking).
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        api('/api/bookings', {
          method: 'POST', token: customer.token, body: { holdId: hold.body.holdId },
        })
      )
    );

    assert.equal(results.filter((r) => r.status === 201).length, 1, 'only one booking may be created');

    const { db } = await import('../src/db/index.js');
    const bookings = db
      .prepare("SELECT COUNT(*) AS n FROM bookings WHERE show_id = ? AND status = 'CONFIRMED'")
      .get(f.show.id).n;
    assert.equal(bookings, 1);

    const seatRows = db
      .prepare('SELECT COUNT(*) AS n FROM booking_seats WHERE show_seat_id = ?')
      .get(seat.id).n;
    assert.equal(seatRows, 1, 'a seat may belong to exactly one booking');
  });
});

describe('CRITICAL: concurrency holds across separate OS processes', () => {
  /**
   * The tests above run inside one Node process, so a sceptic could argue the
   * event loop did the serialising rather than the database. This test forks
   * 8 independent processes that open the same SQLite file directly and race
   * for one seat. Only the database can arbitrate that.
   */
  test('8 separate processes racing for one seat produce exactly one winner', async () => {
    const f = await buildShow({
      admin, organiser,
      rows: [{ rowLabel: 'A', seats: 1, category: 'Premium' }],
      prices: { Premium: 500 },
    });
    const seat = (await seatMap(f.show.id)).seats[0];

    const users = [];
    for (let i = 0; i < 8; i += 1) users.push(await register('CUSTOMER', `Proc ${i}`));

    const workerPath = path.join(os.tmpdir(), `tbs-race-worker-${process.pid}.mjs`);
    fs.writeFileSync(
      workerPath,
      `
      import Database from ${JSON.stringify(path.resolve('node_modules/better-sqlite3/lib/index.js'))};
      const [dbFile, seatId, userId, showId] = process.argv.slice(2);
      const db = new Database(dbFile);
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 8000');

      // Exactly the statement sequence the API uses, in an IMMEDIATE transaction.
      const attempt = db.transaction(() => {
        const holdId = db.prepare(
          "INSERT INTO seat_holds (show_id, user_id, status, expires_at, source) VALUES (?, ?, 'ACTIVE', ?, 'SELECTION')"
        ).run(showId, userId, new Date(Date.now() + 600000).toISOString()).lastInsertRowid;

        const res = db.prepare(
          "UPDATE show_seats SET status='HELD', hold_id=?, version=version+1 WHERE id=? AND status='AVAILABLE'"
        ).run(holdId, seatId);

        if (res.changes !== 1) throw new Error('LOST_RACE');
        return holdId;
      });

      try {
        const holdId = attempt.immediate();
        process.send({ ok: true, holdId });
      } catch (err) {
        process.send({ ok: false, reason: err.message });
      }
      db.close();
      `
    );

    const outcomes = await Promise.all(
      users.map(
        (u) =>
          new Promise((resolve) => {
            const child = fork(workerPath, [TEST_DB, String(seat.id), String(u.id), String(f.show.id)], {
              stdio: 'ignore',
            });
            child.on('message', resolve);
            child.on('exit', (code) => resolve({ ok: false, reason: `exit ${code}` }));
          })
      )
    );

    fs.rmSync(workerPath, { force: true });

    const winners = outcomes.filter((o) => o.ok);
    assert.equal(winners.length, 1, `exactly one process may win, got ${winners.length}`);
    assert.ok(
      outcomes.filter((o) => !o.ok).every((o) => /LOST_RACE/.test(o.reason)),
      'losers must lose on the conditional update, not on a crash'
    );

    const map = await seatMap(f.show.id);
    assert.equal(map.seats[0].status, 'HELD');
  });
});
