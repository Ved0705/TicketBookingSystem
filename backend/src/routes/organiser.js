import { Router } from 'express';
import { db } from '../db/index.js';
import { validate } from '../utils/validate.js';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';

const router = Router();
router.use(requireAuth, requireRole('ORGANISER'));

function ownedEvent(eventId, userId) {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) throw notFound('That event does not exist.');
  if (event.organiser_id !== userId) throw forbidden('That event belongs to another organiser.');
  return event;
}

function ownedShow(showId, userId) {
  const show = db
    .prepare(
      `SELECT sh.*, e.organiser_id, e.title FROM shows sh
         JOIN events e ON e.id = sh.event_id WHERE sh.id = ?`
    )
    .get(showId);
  if (!show) throw notFound('That show does not exist.');
  if (show.organiser_id !== userId) throw forbidden('That show belongs to another organiser.');
  return show;
}

/* ------------------------------------------------------------- events */

router.get(
  '/events',
  asyncHandler(async (req, res) => {
    const events = db
      .prepare(
        `SELECT e.*,
                (SELECT COUNT(*) FROM shows sh WHERE sh.event_id = e.id) AS show_count
           FROM events e WHERE e.organiser_id = ? ORDER BY e.created_at DESC`
      )
      .all(req.user.id);
    res.json({ events });
  })
);

router.post(
  '/events',
  asyncHandler(async (req, res) => {
    const body = validate(req.body, {
      title: { type: 'string', required: true, minLength: 2, maxLength: 120 },
      type: { type: 'string', required: true, enum: ['MOVIE', 'CONCERT'] },
      description: { type: 'string', maxLength: 2000 },
      language: { type: 'string', maxLength: 40 },
      durationMin: { type: 'int', min: 1, max: 600 },
      posterUrl: { type: 'string', maxLength: 400 },
    });
    const id = db
      .prepare(
        `INSERT INTO events (organiser_id, title, description, type, language, duration_min, poster_url)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        req.user.id,
        body.title,
        body.description || null,
        body.type,
        body.language || null,
        body.durationMin || null,
        body.posterUrl || null
      ).lastInsertRowid;
    res.status(201).json({ event: db.prepare('SELECT * FROM events WHERE id = ?').get(id) });
  })
);

router.get(
  '/events/:id',
  asyncHandler(async (req, res) => {
    const event = ownedEvent(req.params.id, req.user.id);
    const shows = db
      .prepare(
        `SELECT sh.*, v.name AS venue_name, v.city,
                (SELECT COUNT(*) FROM show_seats ss WHERE ss.show_id = sh.id) AS seats_total,
                (SELECT COUNT(*) FROM show_seats ss WHERE ss.show_id = sh.id AND ss.status='BOOKED') AS seats_booked
           FROM shows sh JOIN venues v ON v.id = sh.venue_id
          WHERE sh.event_id = ? ORDER BY sh.starts_at`
      )
      .all(event.id);
    res.json({ event, shows });
  })
);

router.patch(
  '/events/:id',
  asyncHandler(async (req, res) => {
    const event = ownedEvent(req.params.id, req.user.id);
    const body = validate(req.body, {
      title: { type: 'string', minLength: 2, maxLength: 120 },
      description: { type: 'string', maxLength: 2000 },
      language: { type: 'string', maxLength: 40 },
      durationMin: { type: 'int', min: 1, max: 600 },
      posterUrl: { type: 'string', maxLength: 400 },
    });
    db.prepare(
      `UPDATE events SET title = ?, description = ?, language = ?, duration_min = ?, poster_url = ?
        WHERE id = ?`
    ).run(
      body.title ?? event.title,
      body.description ?? event.description,
      body.language ?? event.language,
      body.durationMin ?? event.duration_min,
      body.posterUrl ?? event.poster_url,
      event.id
    );
    res.json({ event: db.prepare('SELECT * FROM events WHERE id = ?').get(event.id) });
  })
);

router.delete(
  '/events/:id',
  asyncHandler(async (req, res) => {
    const event = ownedEvent(req.params.id, req.user.id);
    const booked = db
      .prepare(
        `SELECT COUNT(*) AS n FROM bookings b JOIN shows sh ON sh.id = b.show_id
          WHERE sh.event_id = ? AND b.status = 'CONFIRMED'`
      )
      .get(event.id).n;
    if (booked > 0) throw conflict('This event has confirmed bookings and cannot be deleted.');
    db.prepare('DELETE FROM events WHERE id = ?').run(event.id);
    res.status(204).end();
  })
);

/* -------------------------------------------------------------- shows */

/**
 * Creating a show materialises per-show seat inventory from the venue layout.
 * That is what allows seat status to be tracked per show rather than globally.
 */
router.post(
  '/events/:id/shows',
  asyncHandler(async (req, res) => {
    const event = ownedEvent(req.params.id, req.user.id);
    const body = validate(req.body, {
      venueId: { type: 'int', required: true },
      startsAt: { type: 'isoDate', required: true },
      prices: { type: 'array', required: true, minLength: 1 },
    });

    const venue = db.prepare('SELECT * FROM venues WHERE id = ?').get(body.venueId);
    if (!venue) throw notFound('That venue does not exist.');

    const seats = db.prepare('SELECT * FROM seats WHERE venue_id = ?').all(venue.id);
    if (seats.length === 0) throw badRequest('That venue has no seat layout yet.');

    const categories = db.prepare('SELECT * FROM seat_categories WHERE venue_id = ?').all(venue.id);
    const catIds = new Set(categories.map((c) => c.id));

    const prices = body.prices.map((p) => {
      const parsed = validate(p, {
        categoryId: { type: 'int', required: true },
        price: { type: 'number', required: true, min: 0, max: 1000000 },
      });
      if (!catIds.has(parsed.categoryId)) {
        throw badRequest('Pricing refers to a category that is not part of this venue.');
      }
      return parsed;
    });

    const priced = new Set(prices.map((p) => p.categoryId));
    const missing = categories.filter((c) => !priced.has(c.id));
    if (missing.length > 0) {
      throw badRequest(`Set a price for every category. Missing: ${missing.map((m) => m.name).join(', ')}`);
    }

    const showId = db.transaction(() => {
      const id = db
        .prepare('INSERT INTO shows (event_id, venue_id, starts_at) VALUES (?, ?, ?)')
        .run(event.id, venue.id, body.startsAt).lastInsertRowid;

      const priceStmt = db.prepare(
        'INSERT INTO show_prices (show_id, category_id, price) VALUES (?, ?, ?)'
      );
      for (const p of prices) priceStmt.run(id, p.categoryId, p.price);

      const seatStmt = db.prepare(
        `INSERT INTO show_seats (show_id, seat_id, category_id, status)
         VALUES (?, ?, ?, 'AVAILABLE')`
      );
      for (const s of seats) seatStmt.run(id, s.id, s.category_id);

      return id;
    }).immediate();

    const show = db.prepare('SELECT * FROM shows WHERE id = ?').get(showId);
    res.status(201).json({ show, seatsCreated: seats.length });
  })
);

router.patch(
  '/shows/:id/prices',
  asyncHandler(async (req, res) => {
    const show = ownedShow(req.params.id, req.user.id);
    const body = validate(req.body, { prices: { type: 'array', required: true, minLength: 1 } });

    const booked = db
      .prepare("SELECT COUNT(*) AS n FROM show_seats WHERE show_id = ? AND status = 'BOOKED'")
      .get(show.id).n;
    if (booked > 0) throw conflict('Seats are already sold at the current prices.');

    const stmt = db.prepare(
      `INSERT INTO show_prices (show_id, category_id, price) VALUES (?, ?, ?)
         ON CONFLICT(show_id, category_id) DO UPDATE SET price = excluded.price`
    );
    db.transaction(() => {
      for (const p of body.prices) {
        const parsed = validate(p, {
          categoryId: { type: 'int', required: true },
          price: { type: 'number', required: true, min: 0 },
        });
        stmt.run(show.id, parsed.categoryId, parsed.price);
      }
    }).immediate();

    res.json({ prices: db.prepare('SELECT * FROM show_prices WHERE show_id = ?').all(show.id) });
  })
);

router.delete(
  '/shows/:id',
  asyncHandler(async (req, res) => {
    const show = ownedShow(req.params.id, req.user.id);
    const booked = db
      .prepare("SELECT COUNT(*) AS n FROM bookings WHERE show_id = ? AND status='CONFIRMED'")
      .get(show.id).n;
    if (booked > 0) throw conflict('This show has confirmed bookings. Cancel them first.');
    db.prepare('DELETE FROM shows WHERE id = ?').run(show.id);
    res.status(204).end();
  })
);

/* ------------------------------------------------- summary and revenue */

router.get(
  '/events/:id/summary',
  asyncHandler(async (req, res) => {
    const event = ownedEvent(req.params.id, req.user.id);

    const shows = db
      .prepare(
        `SELECT sh.id, sh.starts_at, v.name AS venue_name,
                (SELECT COUNT(*) FROM show_seats ss WHERE ss.show_id = sh.id) AS seats_total,
                (SELECT COUNT(*) FROM show_seats ss WHERE ss.show_id = sh.id AND ss.status='BOOKED') AS seats_booked,
                (SELECT COUNT(*) FROM show_seats ss WHERE ss.show_id = sh.id AND ss.status='HELD') AS seats_held,
                (SELECT COUNT(*) FROM bookings b WHERE b.show_id = sh.id AND b.status='CONFIRMED') AS bookings,
                (SELECT COALESCE(SUM(b.total_amount),0) FROM bookings b
                   WHERE b.show_id = sh.id AND b.status='CONFIRMED') AS revenue,
                (SELECT COUNT(*) FROM waitlists w WHERE w.show_id = sh.id AND w.status IN ('WAITING','OFFERED')) AS waitlist
           FROM shows sh JOIN venues v ON v.id = sh.venue_id
          WHERE sh.event_id = ? ORDER BY sh.starts_at`
      )
      .all(event.id);

    const byCategory = db
      .prepare(
        `SELECT c.name AS category, COUNT(bs.id) AS seats_sold, COALESCE(SUM(bs.price),0) AS revenue
           FROM booking_seats bs
           JOIN bookings b ON b.id = bs.booking_id AND b.status = 'CONFIRMED'
           JOIN show_seats ss ON ss.id = bs.show_seat_id
           JOIN seat_categories c ON c.id = ss.category_id
           JOIN shows sh ON sh.id = ss.show_id
          WHERE sh.event_id = ?
          GROUP BY c.id ORDER BY c.rank`
      )
      .all(event.id);

    const totals = shows.reduce(
      (acc, s) => ({
        seatsTotal: acc.seatsTotal + s.seats_total,
        seatsBooked: acc.seatsBooked + s.seats_booked,
        bookings: acc.bookings + s.bookings,
        revenue: acc.revenue + s.revenue,
      }),
      { seatsTotal: 0, seatsBooked: 0, bookings: 0, revenue: 0 }
    );

    const cancelled = db
      .prepare(
        `SELECT COUNT(*) AS n FROM bookings b JOIN shows sh ON sh.id = b.show_id
          WHERE sh.event_id = ? AND b.status = 'CANCELLED'`
      )
      .get(event.id).n;

    res.json({
      event: { id: event.id, title: event.title, type: event.type },
      totals: {
        ...totals,
        cancelledBookings: cancelled,
        occupancy: totals.seatsTotal ? +(totals.seatsBooked / totals.seatsTotal).toFixed(4) : 0,
      },
      shows,
      byCategory,
    });
  })
);

router.get(
  '/revenue',
  asyncHandler(async (req, res) => {
    const rows = db
      .prepare(
        `SELECT e.id AS event_id, e.title, e.type,
                COUNT(DISTINCT b.id) AS bookings,
                COALESCE(SUM(b.total_amount), 0) AS revenue
           FROM events e
           LEFT JOIN shows sh ON sh.event_id = e.id
           LEFT JOIN bookings b ON b.show_id = sh.id AND b.status = 'CONFIRMED'
          WHERE e.organiser_id = ?
          GROUP BY e.id ORDER BY revenue DESC`
      )
      .all(req.user.id);
    res.json({
      events: rows,
      total: rows.reduce((sum, r) => sum + r.revenue, 0),
    });
  })
);

router.get(
  '/shows/:id/bookings',
  asyncHandler(async (req, res) => {
    const show = ownedShow(req.params.id, req.user.id);
    const bookings = db
      .prepare(
        `SELECT b.id, b.reference, b.status, b.total_amount, b.created_at,
                u.name AS customer, u.email,
                (SELECT GROUP_CONCAT(s.row_label || s.seat_number, ', ')
                   FROM booking_seats bs JOIN show_seats ss ON ss.id = bs.show_seat_id
                   JOIN seats s ON s.id = ss.seat_id WHERE bs.booking_id = b.id) AS seats
           FROM bookings b JOIN users u ON u.id = b.user_id
          WHERE b.show_id = ? ORDER BY b.created_at DESC`
      )
      .all(show.id);
    res.json({ showId: show.id, bookings });
  })
);

export default router;
