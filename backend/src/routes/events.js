import { Router } from 'express';
import { db } from '../db/index.js';
import { asyncHandler } from '../middleware/error.js';
import { optionalAuth } from '../middleware/auth.js';
import { getSeatMap } from '../services/seatService.js';
import { notFound } from '../utils/errors.js';

const router = Router();

/**
 * GET /api/events
 * Filters: q, type, city, venueId, from, to  (all optional)
 * Public — no authentication required.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { q, type, city, venueId, from, to } = req.query;

    const where = ["sh.status = 'SCHEDULED'"];
    const params = [];

    if (q) {
      where.push('(e.title LIKE ? OR e.description LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }
    if (type) {
      where.push('e.type = ?');
      params.push(String(type).toUpperCase());
    }
    if (city) {
      where.push('v.city LIKE ?');
      params.push(`%${city}%`);
    }
    if (venueId) {
      where.push('v.id = ?');
      params.push(Number(venueId));
    }
    if (from) {
      where.push('sh.starts_at >= ?');
      params.push(new Date(from).toISOString());
    }
    if (to) {
      where.push('sh.starts_at <= ?');
      params.push(new Date(to).toISOString());
    }

    const rows = db
      .prepare(
        `SELECT e.id, e.title, e.type, e.description, e.language, e.duration_min, e.poster_url,
                COUNT(DISTINCT sh.id) AS show_count,
                MIN(sh.starts_at) AS next_show,
                GROUP_CONCAT(DISTINCT v.city) AS cities,
                MIN(sp.price) AS from_price
           FROM events e
           JOIN shows sh ON sh.event_id = e.id
           JOIN venues v ON v.id = sh.venue_id
           LEFT JOIN show_prices sp ON sp.show_id = sh.id
          WHERE ${where.join(' AND ')}
          GROUP BY e.id
          ORDER BY next_show ASC`
      )
      .all(...params);

    res.json({
      events: rows.map((r) => ({
        id: r.id,
        title: r.title,
        type: r.type,
        description: r.description,
        language: r.language,
        durationMin: r.duration_min,
        posterUrl: r.poster_url,
        showCount: r.show_count,
        nextShow: r.next_show,
        cities: (r.cities || '').split(',').filter(Boolean),
        fromPrice: r.from_price ?? 0,
      })),
      filters: { q: q || '', type: type || '', city: city || '', from: from || '', to: to || '' },
    });
  })
);

/** Distinct cities, for building the filter UI. */
router.get(
  '/meta/cities',
  asyncHandler(async (_req, res) => {
    const cities = db
      .prepare('SELECT DISTINCT city FROM venues ORDER BY city')
      .all()
      .map((r) => r.city);
    res.json({ cities });
  })
);

/**
 * Venues that already have a seat layout, with their categories.
 * Organisers need this to schedule a show and price each category.
 */
router.get(
  '/meta/venues',
  asyncHandler(async (_req, res) => {
    const venues = db
      .prepare(
        `SELECT v.id, v.name, v.city,
                (SELECT COUNT(*) FROM seats s WHERE s.venue_id = v.id) AS seat_count
           FROM venues v ORDER BY v.name`
      )
      .all()
      .filter((v) => v.seat_count > 0);

    const categories = db
      .prepare('SELECT id, venue_id, name, rank FROM seat_categories ORDER BY rank')
      .all();

    res.json({
      venues: venues.map((v) => ({
        ...v,
        categories: categories.filter((c) => c.venue_id === v.id),
      })),
    });
  })
);

/** Public event detail including its upcoming shows. */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const event = db
      .prepare(
        `SELECT e.*, u.name AS organiser FROM events e
           JOIN users u ON u.id = e.organiser_id WHERE e.id = ?`
      )
      .get(req.params.id);
    if (!event) throw notFound('That event does not exist.');

    const shows = db
      .prepare(
        `SELECT sh.id, sh.starts_at, sh.status, v.id AS venue_id, v.name AS venue_name, v.city,
                (SELECT COUNT(*) FROM show_seats ss WHERE ss.show_id = sh.id) AS seats_total,
                (SELECT COUNT(*) FROM show_seats ss WHERE ss.show_id = sh.id AND ss.status = 'AVAILABLE') AS seats_available,
                (SELECT MIN(price) FROM show_prices sp WHERE sp.show_id = sh.id) AS from_price
           FROM shows sh JOIN venues v ON v.id = sh.venue_id
          WHERE sh.event_id = ? AND sh.status = 'SCHEDULED'
          ORDER BY sh.starts_at`
      )
      .all(event.id);

    res.json({
      event: {
        id: event.id,
        title: event.title,
        type: event.type,
        description: event.description,
        language: event.language,
        durationMin: event.duration_min,
        posterUrl: event.poster_url,
        organiser: event.organiser,
      },
      shows: shows.map((s) => ({
        id: s.id,
        startsAt: s.starts_at,
        status: s.status,
        venue: { id: s.venue_id, name: s.venue_name, city: s.city },
        seatsTotal: s.seats_total,
        seatsAvailable: s.seats_available,
        soldOut: s.seats_available === 0,
        fromPrice: s.from_price ?? 0,
      })),
    });
  })
);

/**
 * Live seat map for one show. Public, but a signed-in viewer also gets
 * `myHold` so the UI can highlight the seats they personally hold.
 */
router.get(
  '/shows/:showId/seatmap',
  optionalAuth,
  asyncHandler(async (req, res) => {
    res.json(getSeatMap(Number(req.params.showId), req.user?.id || null));
  })
);

export default router;
