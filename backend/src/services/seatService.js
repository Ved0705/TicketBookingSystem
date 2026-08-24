import { db, nowIso, isoIn } from '../db/index.js';
import config from '../config.js';
import { bookingReference } from '../utils/auth.js';
import { qrDataUrl, qrPayloadFor } from '../utils/qr.js';
import { sendMail, bookingConfirmationEmail, waitlistOfferEmail } from '../utils/mailer.js';
import { publishSeatUpdates, publishToShow } from '../realtime/hub.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';

/* ====================================================================
 * Statements
 * ==================================================================== */

const S = {
  showById: db.prepare(`
    SELECT sh.*, e.title AS event_title, e.id AS event_id, e.type AS event_type,
           v.name AS venue_name, v.city AS venue_city, v.id AS venue_id
    FROM shows sh
           JOIN events e ON e.id = sh.event_id
           JOIN venues v ON v.id = sh.venue_id
    WHERE sh.id = ?`),

  seatMap: db.prepare(`
    SELECT ss.id, ss.status, ss.category_id, ss.version,
           s.row_label, s.seat_number,
           c.name AS category, c.rank AS category_rank,
           sp.price
    FROM show_seats ss
           JOIN seats s ON s.id = ss.seat_id
           JOIN seat_categories c ON c.id = ss.category_id
           LEFT JOIN show_prices sp ON sp.show_id = ss.show_id AND sp.category_id = ss.category_id
    WHERE ss.show_id = ?
    ORDER BY c.rank, s.row_label, s.seat_number`),

  seatRowsByIds: (n) => db.prepare(`
    SELECT ss.id, ss.show_id, ss.status, ss.category_id, ss.version,
           s.row_label, s.seat_number, c.name AS category,
           sp.price
    FROM show_seats ss
           JOIN seats s ON s.id = ss.seat_id
           JOIN seat_categories c ON c.id = ss.category_id
           LEFT JOIN show_prices sp ON sp.show_id = ss.show_id AND sp.category_id = ss.category_id
    WHERE ss.id IN (${Array(n).fill('?').join(',')})`),
};

const nextPositionStmt = db.prepare(
    `SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM waitlists WHERE show_id = ? AND category_id = ?`
);

/* ====================================================================
 * Expiry sweeper — the server/database is the source of truth for TTL
 * ==================================================================== */

/**
 * Reconcile expired seat holds and expired waitlist offers.
 *
 * Called (a) every SWEEP_INTERVAL_MS by the background scheduler and
 * (b) lazily at the start of every read/write that depends on seat state,
 * so an answer is never based on a hold that has already lapsed — even if
 * the scheduler is momentarily behind.
 *
 * Returns { changedShows: Map<showId, seatRows[]>, newOffers: [...] }
 */
export function sweepExpired() {
  const now = nowIso();
  const touchedSeatIds = new Set();
  const newOffers = [];

  const work = db.transaction(() => {
    // ---- 1. Expired seat holds -------------------------------------
    const staleHolds = db
        .prepare(`SELECT * FROM seat_holds WHERE status = 'ACTIVE' AND expires_at <= ?`)
        .all(now);

    for (const hold of staleHolds) {
      const seats = db
          .prepare(`SELECT id, show_id, category_id FROM show_seats WHERE hold_id = ? AND status = 'HELD'`)
          .all(hold.id);

      db.prepare(`UPDATE seat_holds SET status = 'EXPIRED' WHERE id = ? AND status = 'ACTIVE'`)
          .run(hold.id);

      for (const seat of seats) {
        db.prepare(
            `UPDATE show_seats
             SET status = 'AVAILABLE', hold_id = NULL, version = version + 1
             WHERE id = ? AND status = 'HELD'`
        ).run(seat.id);
        touchedSeatIds.add(seat.id);

        // A hold created by accepting a waitlist offer goes back to the queue
        // rather than to the open pool.
        if (hold.source === 'WAITLIST_OFFER') {
          const offer = offerSeatToNextInQueue(seat.id, seat.show_id, seat.category_id);
          if (offer) newOffers.push(offer);
        }
      }
    }

    // ---- 2. Expired waitlist offers --------------------------------
    const staleOffers = db
        .prepare(`SELECT * FROM waitlist_offers WHERE status = 'PENDING' AND expires_at <= ?`)
        .all(now);

    for (const offer of staleOffers) {
      db.prepare(`UPDATE waitlist_offers SET status = 'EXPIRED' WHERE id = ? AND status = 'PENDING'`)
          .run(offer.id);
      db.prepare(`UPDATE waitlists SET status = 'EXPIRED' WHERE id = ? AND status = 'OFFERED'`)
          .run(offer.waitlist_id);

      const seat = db
          .prepare(`SELECT id, show_id, category_id, status FROM show_seats WHERE id = ?`)
          .get(offer.show_seat_id);
      if (!seat) continue;

      if (seat.status === 'OFFERED') {
        db.prepare(
            `UPDATE show_seats SET status = 'AVAILABLE', offer_id = NULL, version = version + 1
             WHERE id = ? AND status = 'OFFERED'`
        ).run(seat.id);
        touchedSeatIds.add(seat.id);

        // Hand the seat to the next person in line, if there is one.
        const next = offerSeatToNextInQueue(seat.id, seat.show_id, seat.category_id);
        if (next) newOffers.push(next);
      }
    }
  });

  work.immediate();

  const changed = collectSeatBroadcast(touchedSeatIds);
  for (const [showId, seats] of changed) publishSeatUpdates(showId, seats, 'expiry');
  for (const offer of newOffers) announceOffer(offer);

  return { changedShows: changed, newOffers };
}

/** Group touched seats by show and shape them for the websocket payload. */
function collectSeatBroadcast(seatIds) {
  const byShow = new Map();
  if (seatIds.size === 0) return byShow;
  const ids = [...seatIds];
  const rows = db
      .prepare(
          `SELECT id, show_id, status FROM show_seats WHERE id IN (${ids.map(() => '?').join(',')})`
      )
      .all(...ids);
  for (const r of rows) {
    if (!byShow.has(r.show_id)) byShow.set(r.show_id, []);
    byShow.get(r.show_id).push({ id: r.id, status: r.status });
  }
  return byShow;
}

/* ====================================================================
 * Seat map
 * ==================================================================== */

export function getSeatMap(showId, viewerId = null) {
  sweepExpired();
  const show = S.showById.get(showId);
  if (!show) throw notFound('That show does not exist.');

  const seats = S.seatMap.all(showId).map((s) => ({
    id: s.id,
    row: s.row_label,
    number: s.seat_number,
    label: `${s.row_label}${s.seat_number}`,
    categoryId: s.category_id,
    category: s.category,
    price: s.price ?? 0,
    status: s.status,
    version: s.version,
  }));

  const categories = db
      .prepare(
          `SELECT c.id, c.name, c.rank, COALESCE(sp.price, 0) AS price,
                  SUM(CASE WHEN ss.status = 'AVAILABLE' THEN 1 ELSE 0 END) AS available,
                  COUNT(ss.id) AS total
           FROM show_seats ss
                  JOIN seat_categories c ON c.id = ss.category_id
                  LEFT JOIN show_prices sp ON sp.show_id = ss.show_id AND sp.category_id = c.id
           WHERE ss.show_id = ?
           GROUP BY c.id
           ORDER BY c.rank`
      )
      .all(showId);

  let myHold = null;
  if (viewerId) {
    const hold = db
        .prepare(
            `SELECT * FROM seat_holds
             WHERE user_id = ? AND show_id = ? AND status = 'ACTIVE' AND expires_at > ?
             ORDER BY id DESC LIMIT 1`
        )
        .get(viewerId, showId, nowIso());
    if (hold) {
      const heldSeats = db
          .prepare(`SELECT id FROM show_seats WHERE hold_id = ? AND status = 'HELD'`)
          .all(hold.id)
          .map((r) => r.id);
      myHold = { holdId: hold.id, expiresAt: hold.expires_at, seatIds: heldSeats };
    }
  }

  return {
    show: {
      id: show.id,
      eventId: show.event_id,
      eventTitle: show.event_title,
      eventType: show.event_type,
      startsAt: show.starts_at,
      status: show.status,
      venue: { id: show.venue_id, name: show.venue_name, city: show.venue_city },
    },
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      price: c.price,
      available: c.available,
      total: c.total,
      soldOut: c.available === 0,
    })),
    seats,
    myHold,
    holdTtlSeconds: config.holdTtlSeconds,
  };
}

/* ====================================================================
 * CRITICAL FEATURE 1 + 2 — hold seats with TTL, safely under concurrency
 * ==================================================================== */

/**
 * Place a temporary hold on one or more seats.
 *
 * Concurrency strategy (three layers):
 *  1. BEGIN IMMEDIATE — takes the write lock before any read, so two writers
 *     are serialised by SQLite instead of racing.
 *  2. Conditional UPDATE ... WHERE id = ? AND status = 'AVAILABLE' — the
 *     status check and the write are a single atomic statement. The loser of
 *     a race gets `changes === 0` and cannot silently overwrite the winner.
 *  3. Any seat that fails throws, which rolls back the whole transaction —
 *     holds are all-or-nothing, never partially applied.
 */
export function holdSeats({ userId, showId, seatIds, ttlSeconds }) {
  sweepExpired();

  const show = S.showById.get(showId);
  if (!show) throw notFound('That show does not exist.');
  if (show.status === 'CANCELLED') throw conflict('This show has been cancelled.');
  if (new Date(show.starts_at) <= new Date()) throw conflict('This show has already started.');

  const unique = [...new Set(seatIds)];
  if (unique.length === 0) throw badRequest('Select at least one seat.');
  if (unique.length > config.maxSeatsPerHold) {
    throw badRequest(`You can hold at most ${config.maxSeatsPerHold} seats at a time.`);
  }

  const ttl = ttlSeconds || config.holdTtlSeconds;
  const expiresAt = isoIn(ttl);

  const run = db.transaction(() => {
    const rows = S.seatRowsByIds(unique.length).all(...unique);
    if (rows.length !== unique.length) throw notFound('One or more seats do not exist.');
    for (const r of rows) {
      if (r.show_id !== Number(showId)) throw badRequest('Seats do not belong to this show.');
    }

    // Release any previous active hold this user has on this show so a customer
    // cannot pile up parallel holds and starve the inventory.
    releaseActiveHoldsForUser(userId, showId);

    const holdId = db
        .prepare(
            `INSERT INTO seat_holds (show_id, user_id, status, expires_at, source)
             VALUES (?, ?, 'ACTIVE', ?, 'SELECTION')`
        )
        .run(showId, userId, expiresAt).lastInsertRowid;

    const taken = [];
    for (const seat of rows) {
      const res = db
          .prepare(
              `UPDATE show_seats
               SET status = 'HELD', hold_id = ?, version = version + 1
               WHERE id = ? AND status = 'AVAILABLE'`
          )
          .run(holdId, seat.id);

      if (res.changes !== 1) {
        // Someone else won this seat between the customer loading the map and
        // pressing "hold". Roll everything back and say so precisely.
        const current = db.prepare(`SELECT status FROM show_seats WHERE id = ?`).get(seat.id);
        throw conflict(
            `Seat ${seat.row_label}${seat.seat_number} was just taken. Pick another one.`,
            { seatId: seat.id, status: current?.status || 'UNKNOWN' }
        );
      }
      taken.push(seat);
    }

    return { holdId, expiresAt, seats: taken };
  });

  const result = run.immediate();

  publishSeatUpdates(
      showId,
      result.seats.map((s) => ({ id: s.id, status: 'HELD' })),
      'hold'
  );

  return {
    holdId: result.holdId,
    showId: Number(showId),
    expiresAt: result.expiresAt,
    ttlSeconds: ttl,
    seats: result.seats.map((s) => ({
      id: s.id,
      label: `${s.row_label}${s.seat_number}`,
      category: s.category,
      price: s.price ?? 0,
    })),
    total: result.seats.reduce((sum, s) => sum + (s.price ?? 0), 0),
  };
}

/** Internal: release a user's active holds for one show (used inside a tx). */
function releaseActiveHoldsForUser(userId, showId) {
  const holds = db
      .prepare(`SELECT id FROM seat_holds WHERE user_id = ? AND show_id = ? AND status = 'ACTIVE'`)
      .all(userId, showId);
  for (const h of holds) {
    db.prepare(
        `UPDATE show_seats SET status = 'AVAILABLE', hold_id = NULL, version = version + 1
         WHERE hold_id = ? AND status = 'HELD'`
    ).run(h.id);
    db.prepare(`UPDATE seat_holds SET status = 'RELEASED' WHERE id = ?`).run(h.id);
  }
}

/** Voluntarily give up a hold (customer navigated away from checkout). */
export function releaseHold({ userId, holdId }) {
  const hold = db.prepare(`SELECT * FROM seat_holds WHERE id = ?`).get(holdId);
  if (!hold) throw notFound('That hold does not exist.');
  if (hold.user_id !== userId) throw forbidden('That hold belongs to someone else.');

  const seatIds = db
      .prepare(`SELECT id FROM show_seats WHERE hold_id = ? AND status = 'HELD'`)
      .all(holdId)
      .map((r) => r.id);

  db.transaction(() => {
    db.prepare(
        `UPDATE show_seats SET status = 'AVAILABLE', hold_id = NULL, version = version + 1
         WHERE hold_id = ? AND status = 'HELD'`
    ).run(holdId);
    db.prepare(`UPDATE seat_holds SET status = 'RELEASED' WHERE id = ? AND status = 'ACTIVE'`)
        .run(holdId);
  }).immediate();

  publishSeatUpdates(
      hold.show_id,
      seatIds.map((id) => ({ id, status: 'AVAILABLE' })),
      'hold-released'
  );
  return { released: seatIds.length };
}

export function getHold({ userId, holdId }) {
  sweepExpired();
  const hold = db.prepare(`SELECT * FROM seat_holds WHERE id = ?`).get(holdId);
  if (!hold) throw notFound('That hold does not exist.');
  if (hold.user_id !== userId) throw forbidden('That hold belongs to someone else.');

  const seats = db
      .prepare(
          `SELECT ss.id, s.row_label, s.seat_number, c.name AS category,
                  COALESCE(sp.price, 0) AS price
           FROM show_seats ss
                  JOIN seats s ON s.id = ss.seat_id
                  JOIN seat_categories c ON c.id = ss.category_id
                  LEFT JOIN show_prices sp ON sp.show_id = ss.show_id AND sp.category_id = ss.category_id
           WHERE ss.hold_id = ?`
      )
      .all(holdId);

  const show = S.showById.get(hold.show_id);
  return {
    holdId: hold.id,
    status: hold.status,
    expiresAt: hold.expires_at,
    expired: hold.status !== 'ACTIVE' || new Date(hold.expires_at) <= new Date(),
    show: {
      id: show.id,
      eventTitle: show.event_title,
      startsAt: show.starts_at,
      venue: { name: show.venue_name, city: show.venue_city },
    },
    seats: seats.map((s) => ({
      id: s.id,
      label: `${s.row_label}${s.seat_number}`,
      category: s.category,
      price: s.price,
    })),
    total: seats.reduce((sum, s) => sum + s.price, 0),
  };
}

/* ====================================================================
 * Booking confirmation
 * ==================================================================== */

export async function confirmBooking({ userId, holdId }) {
  sweepExpired(); // an expired hold must not be bookable

  const commit = db.transaction(() => {
    const hold = db.prepare(`SELECT * FROM seat_holds WHERE id = ?`).get(holdId);
    if (!hold) throw notFound('That hold does not exist.');
    if (hold.user_id !== userId) throw forbidden('That hold belongs to someone else.');
    if (hold.status !== 'ACTIVE') throw conflict('This hold has expired. Please pick seats again.');
    if (new Date(hold.expires_at) <= new Date()) {
      throw conflict('This hold has expired. Please pick seats again.');
    }

    const seats = db
        .prepare(
            `SELECT ss.id, ss.category_id, s.row_label, s.seat_number, c.name AS category,
                    COALESCE(sp.price, 0) AS price
             FROM show_seats ss
                    JOIN seats s ON s.id = ss.seat_id
                    JOIN seat_categories c ON c.id = ss.category_id
                    LEFT JOIN show_prices sp ON sp.show_id = ss.show_id AND sp.category_id = ss.category_id
             WHERE ss.hold_id = ? AND ss.status = 'HELD'`
        )
        .all(holdId);

    if (seats.length === 0) throw conflict('This hold no longer covers any seats.');

    const total = seats.reduce((sum, s) => sum + s.price, 0);
    const reference = bookingReference();

    const bookingId = db
        .prepare(
            `INSERT INTO bookings (reference, user_id, show_id, status, total_amount, qr_payload)
             VALUES (?, ?, ?, 'CONFIRMED', ?, ?)`
        )
        .run(reference, userId, hold.show_id, total, qrPayloadFor(reference)).lastInsertRowid;

    for (const seat of seats) {
      const res = db
          .prepare(
              `UPDATE show_seats
               SET status = 'BOOKED', booking_id = ?, hold_id = NULL, offer_id = NULL,
                   version = version + 1
               WHERE id = ? AND status = 'HELD' AND hold_id = ?`
          )
          .run(bookingId, seat.id, holdId);
      if (res.changes !== 1) {
        throw conflict(`Seat ${seat.row_label}${seat.seat_number} is no longer held by you.`);
      }
      db.prepare(
          `INSERT INTO booking_seats (booking_id, show_seat_id, price) VALUES (?, ?, ?)`
      ).run(bookingId, seat.id, seat.price);
    }

    db.prepare(`UPDATE seat_holds SET status = 'CONVERTED' WHERE id = ?`).run(holdId);

    // Close out any waitlist offer that produced this booking.
    const acceptedOffers = db
        .prepare(
            `SELECT * FROM waitlist_offers
             WHERE user_id = ? AND status = 'ACCEPTED'
               AND show_seat_id IN (${seats.map(() => '?').join(',')})`
        )
        .all(userId, ...seats.map((s) => s.id));
    for (const offer of acceptedOffers) {
      db.prepare(`UPDATE waitlists SET status = 'FULFILLED' WHERE id = ?`).run(offer.waitlist_id);
    }

    return { bookingId, reference, total, seats, showId: hold.show_id };
  });

  const result = commit.immediate();

  publishSeatUpdates(
      result.showId,
      result.seats.map((s) => ({ id: s.id, status: 'BOOKED' })),
      'booked'
  );

  // The booking is fully committed at this point — the customer has their
  // seats regardless of what happens next. Ticket delivery runs in the
  // background rather than being awaited here: a slow or unreachable mail
  // provider must never make checkout feel hung or time out, since nothing
  // about the booking depends on the email actually landing before the
  // response goes out. `deliverTicket` records its own outcome in
  // `email_log`, and the client can check delivery status or trigger a
  // re-send from the booking detail page.
  deliverTicket(result.bookingId).catch((err) => {
    console.error(`[mail] ticket delivery failed for booking ${result.bookingId}:`, err.message);
  });

  return {
    ...(await getBooking({ userId, bookingId: result.bookingId })),
    email: { pending: true },
  };
}

/* ====================================================================
 * QR + email delivery
 * ==================================================================== */

export async function deliverTicket(bookingId) {
  const booking = db.prepare(`SELECT * FROM bookings WHERE id = ?`).get(bookingId);
  if (!booking) throw notFound('That booking does not exist.');

  const user = db.prepare(`SELECT id, name, email FROM users WHERE id = ?`).get(booking.user_id);
  const show = S.showById.get(booking.show_id);
  const seats = db
      .prepare(
          `SELECT s.row_label, s.seat_number, c.name AS category
           FROM booking_seats bs
                  JOIN show_seats ss ON ss.id = bs.show_seat_id
                  JOIN seats s ON s.id = ss.seat_id
                  JOIN seat_categories c ON c.id = ss.category_id
           WHERE bs.booking_id = ?`
      )
      .all(bookingId);

  const dataUrl = await qrDataUrl(booking.reference);
  const { subject, html, text, attachments } = bookingConfirmationEmail({
    booking,
    event: { title: show.event_title },
    show,
    venue: { name: show.venue_name, city: show.venue_city },
    seats,
    qrDataUrl: dataUrl,
  });

  const res = await sendMail({ to: user.email, subject, html, text, attachments });
  return { to: user.email, subject, ...res };
}

/* ====================================================================
 * Bookings: read, history, cancel
 * ==================================================================== */

export async function getBooking({ userId, bookingId, reference, allowAny = false }) {
  const booking = reference
      ? db.prepare(`SELECT * FROM bookings WHERE reference = ?`).get(reference)
      : db.prepare(`SELECT * FROM bookings WHERE id = ?`).get(bookingId);

  if (!booking) throw notFound('That booking does not exist.');
  if (!allowAny && booking.user_id !== userId) {
    // Do not leak the existence of someone else's booking.
    throw forbidden('That booking belongs to another account.');
  }

  const show = S.showById.get(booking.show_id);
  const seats = db
      .prepare(
          `SELECT bs.price, s.row_label, s.seat_number, c.name AS category
           FROM booking_seats bs
                  JOIN show_seats ss ON ss.id = bs.show_seat_id
                  JOIN seats s ON s.id = ss.seat_id
                  JOIN seat_categories c ON c.id = ss.category_id
           WHERE bs.booking_id = ?`
      )
      .all(booking.id);

  return {
    id: booking.id,
    reference: booking.reference,
    status: booking.status,
    total: booking.total_amount,
    createdAt: booking.created_at,
    cancelledAt: booking.cancelled_at,
    qrDataUrl: await qrDataUrl(booking.reference),
    show: {
      id: show.id,
      eventId: show.event_id,
      eventTitle: show.event_title,
      startsAt: show.starts_at,
      venue: { name: show.venue_name, city: show.venue_city },
    },
    seats: seats.map((s) => ({
      label: `${s.row_label}${s.seat_number}`,
      category: s.category,
      price: s.price,
    })),
  };
}

export function listBookings(userId) {
  const rows = db
      .prepare(
          `SELECT b.id, b.reference, b.status, b.total_amount, b.created_at,
                  e.title AS event_title, sh.starts_at, v.name AS venue_name, v.city,
                  (SELECT GROUP_CONCAT(s.row_label || s.seat_number, ', ')
                   FROM booking_seats bs
                          JOIN show_seats ss ON ss.id = bs.show_seat_id
                          JOIN seats s ON s.id = ss.seat_id
                   WHERE bs.booking_id = b.id) AS seat_labels
           FROM bookings b
                  JOIN shows sh ON sh.id = b.show_id
                  JOIN events e ON e.id = sh.event_id
                  JOIN venues v ON v.id = sh.venue_id
           WHERE b.user_id = ?
           ORDER BY b.created_at DESC, b.id DESC`
      )
      .all(userId);

  return rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    status: r.status,
    total: r.total_amount,
    createdAt: r.created_at,
    seats: r.seat_labels || '',
    show: { eventTitle: r.event_title, startsAt: r.starts_at, venue: { name: r.venue_name, city: r.city } },
  }));
}

/**
 * Cancel a booking. Freed seats are offered to the waitlist (FIFO) before
 * they return to the public pool.
 */
export function cancelBooking({ userId, bookingId, isAdmin = false }) {
  sweepExpired();
  const newOffers = [];
  const freed = [];

  const run = db.transaction(() => {
    const booking = db.prepare(`SELECT * FROM bookings WHERE id = ?`).get(bookingId);
    if (!booking) throw notFound('That booking does not exist.');
    if (!isAdmin && booking.user_id !== userId) {
      throw forbidden('That booking belongs to another account.');
    }
    if (booking.status === 'CANCELLED') throw conflict('This booking is already cancelled.');

    const show = db.prepare(`SELECT * FROM shows WHERE id = ?`).get(booking.show_id);
    if (new Date(show.starts_at) <= new Date()) {
      throw conflict('This show has already started, so it can no longer be cancelled.');
    }

    db.prepare(
        `UPDATE bookings SET status = 'CANCELLED', cancelled_at = ? WHERE id = ? AND status = 'CONFIRMED'`
    ).run(nowIso(), bookingId);

    const seats = db
        .prepare(
            `SELECT ss.id, ss.show_id, ss.category_id
             FROM booking_seats bs JOIN show_seats ss ON ss.id = bs.show_seat_id
             WHERE bs.booking_id = ?`
        )
        .all(bookingId);

    for (const seat of seats) {
      db.prepare(
          `UPDATE show_seats
           SET status = 'AVAILABLE', booking_id = NULL, hold_id = NULL, version = version + 1
           WHERE id = ? AND status = 'BOOKED'`
      ).run(seat.id);

      const offer = offerSeatToNextInQueue(seat.id, seat.show_id, seat.category_id);
      if (offer) newOffers.push(offer);
      freed.push({ id: seat.id, status: offer ? 'OFFERED' : 'AVAILABLE' });
    }

    return { showId: booking.show_id, reference: booking.reference, seatCount: seats.length };
  });

  const result = run.immediate();

  publishSeatUpdates(result.showId, freed, 'cancelled');
  for (const offer of newOffers) announceOffer(offer);

  return {
    reference: result.reference,
    status: 'CANCELLED',
    seatsReleased: result.seatCount,
    offersCreated: newOffers.length,
  };
}

/* ====================================================================
 * CRITICAL FEATURE 3 — waitlist
 * ==================================================================== */

export function joinWaitlist({ userId, showId, categoryId }) {
  sweepExpired();

  const show = S.showById.get(showId);
  if (!show) throw notFound('That show does not exist.');

  const category = db
      .prepare(`SELECT * FROM seat_categories WHERE id = ? AND venue_id = ?`)
      .get(categoryId, show.venue_id);
  if (!category) throw notFound('That seat category does not exist for this venue.');

  const available = db
      .prepare(
          `SELECT COUNT(*) AS n FROM show_seats
           WHERE show_id = ? AND category_id = ? AND status = 'AVAILABLE'`
      )
      .get(showId, categoryId).n;
  if (available > 0) {
    throw conflict(`${category.name} still has ${available} seat(s) free — book one instead.`);
  }

  const existing = db
      .prepare(`SELECT * FROM waitlists WHERE show_id = ? AND category_id = ? AND user_id = ?`)
      .get(showId, categoryId, userId);

  const run = db.transaction(() => {
    if (existing) {
      if (['WAITING', 'OFFERED'].includes(existing.status)) {
        throw conflict('You are already on this waitlist.');
      }
      // Re-joining after an expired/cancelled turn puts the user at the back.
      const pos = nextPositionStmt.get(showId, categoryId).pos;
      db.prepare(`UPDATE waitlists SET status = 'WAITING', position = ?, created_at = ? WHERE id = ?`)
          .run(pos, nowIso(), existing.id);
      return { id: existing.id, position: pos };
    }
    const pos = nextPositionStmt.get(showId, categoryId).pos;
    const id = db
        .prepare(
            `INSERT INTO waitlists (show_id, category_id, user_id, status, position)
             VALUES (?, ?, ?, 'WAITING', ?)`
        )
        .run(showId, categoryId, userId, pos).lastInsertRowid;
    return { id, position: pos };
  });

  const entry = run.immediate();
  const ahead = db
      .prepare(
          `SELECT COUNT(*) AS n FROM waitlists
           WHERE show_id = ? AND category_id = ? AND status = 'WAITING' AND position < ?`
      )
      .get(showId, categoryId, entry.position).n;

  return {
    waitlistId: entry.id,
    showId: Number(showId),
    categoryId: Number(categoryId),
    category: category.name,
    position: entry.position,
    peopleAhead: ahead,
    status: 'WAITING',
  };
}

export function leaveWaitlist({ userId, waitlistId }) {
  const entry = db.prepare(`SELECT * FROM waitlists WHERE id = ?`).get(waitlistId);
  if (!entry) throw notFound('That waitlist entry does not exist.');
  if (entry.user_id !== userId) throw forbidden('That waitlist entry belongs to someone else.');
  db.prepare(`UPDATE waitlists SET status = 'CANCELLED' WHERE id = ?`).run(waitlistId);
  return { waitlistId: Number(waitlistId), status: 'CANCELLED' };
}

export function myWaitlist(userId) {
  sweepExpired();
  const rows = db
      .prepare(
          `SELECT w.*, c.name AS category, e.title AS event_title, sh.starts_at,
                  v.name AS venue_name, v.city
           FROM waitlists w
                  JOIN seat_categories c ON c.id = w.category_id
                  JOIN shows sh ON sh.id = w.show_id
                  JOIN events e ON e.id = sh.event_id
                  JOIN venues v ON v.id = sh.venue_id
           WHERE w.user_id = ?
           ORDER BY w.created_at DESC`
      )
      .all(userId);

  return rows.map((r) => {
    const offer = db
        .prepare(
            `SELECT o.*, s.row_label, s.seat_number
             FROM waitlist_offers o
                    JOIN show_seats ss ON ss.id = o.show_seat_id
                    JOIN seats s ON s.id = ss.seat_id
             WHERE o.waitlist_id = ? AND o.status = 'PENDING'
             ORDER BY o.id DESC LIMIT 1`
        )
        .get(r.id);

    const ahead = db
        .prepare(
            `SELECT COUNT(*) AS n FROM waitlists
             WHERE show_id = ? AND category_id = ? AND status = 'WAITING' AND position < ?`
        )
        .get(r.show_id, r.category_id, r.position).n;

    return {
      waitlistId: r.id,
      showId: r.show_id,
      status: r.status,
      position: r.position,
      peopleAhead: r.status === 'WAITING' ? ahead : 0,
      category: r.category,
      show: {
        eventTitle: r.event_title,
        startsAt: r.starts_at,
        venue: { name: r.venue_name, city: r.city },
      },
      offer: offer
          ? {
            id: offer.id,
            seatLabel: `${offer.row_label}${offer.seat_number}`,
            showSeatId: offer.show_seat_id,
            expiresAt: offer.expires_at,
          }
          : null,
    };
  });
}

/**
 * Give a freed seat to the next WAITING customer for that show + category.
 * MUST be called inside an open transaction.
 *
 * The seat moves to OFFERED and the offer row is unique-indexed on
 * (show_seat_id) WHERE status='PENDING', so the database itself refuses to
 * let one seat be offered to two people at once.
 *
 * Returns the offer context (for the email) or null when nobody is waiting.
 */
function offerSeatToNextInQueue(showSeatId, showId, categoryId) {
  const next = db
      .prepare(
          `SELECT * FROM waitlists
           WHERE show_id = ? AND category_id = ? AND status = 'WAITING'
           ORDER BY position ASC LIMIT 1`
      )
      .get(showId, categoryId);
  if (!next) return null;

  const expiresAt = isoIn(config.waitlistOfferTtlSeconds);

  const offerId = db
      .prepare(
          `INSERT INTO waitlist_offers (waitlist_id, show_seat_id, user_id, status, expires_at)
           VALUES (?, ?, ?, 'PENDING', ?)`
      )
      .run(next.id, showSeatId, next.user_id, expiresAt).lastInsertRowid;

  const res = db
      .prepare(
          `UPDATE show_seats
           SET status = 'OFFERED', offer_id = ?, hold_id = NULL, booking_id = NULL,
               version = version + 1
           WHERE id = ? AND status = 'AVAILABLE'`
      )
      .run(offerId, showSeatId);

  if (res.changes !== 1) {
    // Seat is not free after all — abandon the offer rather than double-book.
    db.prepare(`DELETE FROM waitlist_offers WHERE id = ?`).run(offerId);
    return null;
  }

  db.prepare(`UPDATE waitlists SET status = 'OFFERED' WHERE id = ?`).run(next.id);

  return { offerId, waitlistId: next.id, userId: next.user_id, showSeatId, showId, expiresAt };
}

/** Fire the offer email + realtime nudge. Runs outside the transaction. */
function announceOffer(offer) {
  try {
    const user = db.prepare(`SELECT id, name, email FROM users WHERE id = ?`).get(offer.userId);
    const show = S.showById.get(offer.showId);
    const seat = db
        .prepare(
            `SELECT s.row_label, s.seat_number, c.name AS category
             FROM show_seats ss JOIN seats s ON s.id = ss.seat_id
                                JOIN seat_categories c ON c.id = ss.category_id
             WHERE ss.id = ?`
        )
        .get(offer.showSeatId);

    const { subject, html, text } = waitlistOfferEmail({
      user,
      event: { title: show.event_title },
      show,
      venue: { name: show.venue_name, city: show.venue_city },
      seat,
      offer: { id: offer.offerId },
      expiresAt: offer.expiresAt,
    });

    // Fire and forget; the offer stands whether or not the mail lands.
    sendMail({ to: user.email, subject, html, text }).catch(() => {});

    publishToShow(offer.showId, {
      type: 'waitlist.offer',
      userId: offer.userId,
      offerId: offer.offerId,
      seatId: offer.showSeatId,
      expiresAt: offer.expiresAt,
    });
  } catch (err) {
    console.error('[waitlist] failed to announce offer', err.message);
  }
}

/**
 * Accept a pending waitlist offer. Converts the OFFERED seat into a normal
 * HELD seat owned by this customer, who then checks out as usual.
 */
export function acceptOffer({ userId, offerId }) {
  sweepExpired();

  const run = db.transaction(() => {
    const offer = db.prepare(`SELECT * FROM waitlist_offers WHERE id = ?`).get(offerId);
    if (!offer) throw notFound('That offer does not exist.');
    if (offer.user_id !== userId) throw forbidden('That offer belongs to someone else.');
    if (offer.status !== 'PENDING') throw conflict('This offer is no longer open.');
    if (new Date(offer.expires_at) <= new Date()) throw conflict('This offer has expired.');

    const seat = db.prepare(`SELECT * FROM show_seats WHERE id = ?`).get(offer.show_seat_id);
    if (!seat || seat.status !== 'OFFERED') throw conflict('That seat is no longer available.');

    const holdId = db
        .prepare(
            `INSERT INTO seat_holds (show_id, user_id, status, expires_at, source)
             VALUES (?, ?, 'ACTIVE', ?, 'WAITLIST_OFFER')`
        )
        .run(seat.show_id, userId, isoIn(config.holdTtlSeconds)).lastInsertRowid;

    const res = db
        .prepare(
            `UPDATE show_seats
             SET status = 'HELD', hold_id = ?, offer_id = NULL, version = version + 1
             WHERE id = ? AND status = 'OFFERED' AND offer_id = ?`
        )
        .run(holdId, seat.id, offerId);
    if (res.changes !== 1) throw conflict('That seat is no longer available.');

    db.prepare(`UPDATE waitlist_offers SET status = 'ACCEPTED' WHERE id = ?`).run(offerId);

    return { holdId, seatId: seat.id, showId: seat.show_id };
  });

  const result = run.immediate();
  publishSeatUpdates(result.showId, [{ id: result.seatId, status: 'HELD' }], 'offer-accepted');
  return {
    holdId: result.holdId,
    showId: result.showId,
    seatIds: [result.seatId],
    expiresAt: db.prepare(`SELECT expires_at FROM seat_holds WHERE id = ?`).get(result.holdId).expires_at,
  };
}

/** Decline an offer immediately; the seat moves on to the next customer. */
export function declineOffer({ userId, offerId }) {
  const newOffers = [];
  const freed = [];

  const run = db.transaction(() => {
    const offer = db.prepare(`SELECT * FROM waitlist_offers WHERE id = ?`).get(offerId);
    if (!offer) throw notFound('That offer does not exist.');
    if (offer.user_id !== userId) throw forbidden('That offer belongs to someone else.');
    if (offer.status !== 'PENDING') throw conflict('This offer is no longer open.');

    db.prepare(`UPDATE waitlist_offers SET status = 'DECLINED' WHERE id = ?`).run(offerId);
    db.prepare(`UPDATE waitlists SET status = 'CANCELLED' WHERE id = ?`).run(offer.waitlist_id);

    const seat = db.prepare(`SELECT * FROM show_seats WHERE id = ?`).get(offer.show_seat_id);
    db.prepare(
        `UPDATE show_seats SET status = 'AVAILABLE', offer_id = NULL, version = version + 1
         WHERE id = ? AND status = 'OFFERED'`
    ).run(seat.id);

    const next = offerSeatToNextInQueue(seat.id, seat.show_id, seat.category_id);
    if (next) newOffers.push(next);
    freed.push({ id: seat.id, status: next ? 'OFFERED' : 'AVAILABLE' });
    return { showId: seat.show_id };
  });

  const result = run.immediate();
  publishSeatUpdates(result.showId, freed, 'offer-declined');
  for (const offer of newOffers) announceOffer(offer);
  return { offerId: Number(offerId), status: 'DECLINED', reoffered: newOffers.length > 0 };
}

export { offerSeatToNextInQueue };