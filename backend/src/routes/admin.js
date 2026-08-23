import { Router } from 'express';
import { db } from '../db/index.js';
import { validate } from '../utils/validate.js';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN'));

/* ---------------------------------------------------------------- venues */

router.get(
  '/venues',
  asyncHandler(async (_req, res) => {
    const venues = db
      .prepare(
        `SELECT v.*,
                (SELECT COUNT(*) FROM seats s WHERE s.venue_id = v.id) AS seat_count,
                (SELECT COUNT(*) FROM seat_categories c WHERE c.venue_id = v.id) AS category_count
           FROM venues v ORDER BY v.name`
      )
      .all();
    res.json({ venues });
  })
);

router.post(
  '/venues',
  asyncHandler(async (req, res) => {
    const body = validate(req.body, {
      name: { type: 'string', required: true, minLength: 2, maxLength: 120 },
      city: { type: 'string', required: true, minLength: 2, maxLength: 80 },
      address: { type: 'string', maxLength: 200 },
    });
    const id = db
      .prepare('INSERT INTO venues (name, city, address, created_by) VALUES (?, ?, ?, ?)')
      .run(body.name, body.city, body.address || null, req.user.id).lastInsertRowid;
    res.status(201).json({ venue: db.prepare('SELECT * FROM venues WHERE id = ?').get(id) });
  })
);

router.get(
  '/venues/:id',
  asyncHandler(async (req, res) => {
    const venue = db.prepare('SELECT * FROM venues WHERE id = ?').get(req.params.id);
    if (!venue) throw notFound('That venue does not exist.');
    const categories = db
      .prepare('SELECT * FROM seat_categories WHERE venue_id = ? ORDER BY rank')
      .all(venue.id);
    const seats = db
      .prepare(
        `SELECT s.*, c.name AS category
           FROM seats s JOIN seat_categories c ON c.id = s.category_id
          WHERE s.venue_id = ? ORDER BY c.rank, s.row_label, s.seat_number`
      )
      .all(venue.id);
    res.json({ venue, categories, seats });
  })
);

router.patch(
  '/venues/:id',
  asyncHandler(async (req, res) => {
    const venue = db.prepare('SELECT * FROM venues WHERE id = ?').get(req.params.id);
    if (!venue) throw notFound('That venue does not exist.');
    const body = validate(req.body, {
      name: { type: 'string', minLength: 2, maxLength: 120 },
      city: { type: 'string', minLength: 2, maxLength: 80 },
      address: { type: 'string', maxLength: 200 },
    });
    db.prepare('UPDATE venues SET name = ?, city = ?, address = ? WHERE id = ?').run(
      body.name ?? venue.name,
      body.city ?? venue.city,
      body.address ?? venue.address,
      venue.id
    );
    res.json({ venue: db.prepare('SELECT * FROM venues WHERE id = ?').get(venue.id) });
  })
);

router.delete(
  '/venues/:id',
  asyncHandler(async (req, res) => {
    const venue = db.prepare('SELECT * FROM venues WHERE id = ?').get(req.params.id);
    if (!venue) throw notFound('That venue does not exist.');
    const shows = db.prepare('SELECT COUNT(*) AS n FROM shows WHERE venue_id = ?').get(venue.id).n;
    if (shows > 0) throw conflict('Remove the shows scheduled at this venue first.');
    db.prepare('DELETE FROM venues WHERE id = ?').run(venue.id);
    res.status(204).end();
  })
);

/* ----------------------------------------------------------- categories */

router.post(
  '/venues/:id/categories',
  asyncHandler(async (req, res) => {
    const venue = db.prepare('SELECT * FROM venues WHERE id = ?').get(req.params.id);
    if (!venue) throw notFound('That venue does not exist.');
    const body = validate(req.body, {
      name: { type: 'string', required: true, minLength: 2, maxLength: 40 },
      rank: { type: 'int', min: 0, max: 100, default: 0 },
    });
    const dup = db
      .prepare('SELECT id FROM seat_categories WHERE venue_id = ? AND name = ?')
      .get(venue.id, body.name);
    if (dup) throw conflict('That category already exists at this venue.');
    const id = db
      .prepare('INSERT INTO seat_categories (venue_id, name, rank) VALUES (?, ?, ?)')
      .run(venue.id, body.name, body.rank).lastInsertRowid;
    res.status(201).json({ category: db.prepare('SELECT * FROM seat_categories WHERE id = ?').get(id) });
  })
);

router.delete(
  '/categories/:id',
  asyncHandler(async (req, res) => {
    const cat = db.prepare('SELECT * FROM seat_categories WHERE id = ?').get(req.params.id);
    if (!cat) throw notFound('That category does not exist.');
    const used = db
      .prepare('SELECT COUNT(*) AS n FROM show_seats WHERE category_id = ?')
      .get(cat.id).n;
    if (used > 0) throw conflict('This category is in use by a scheduled show.');
    db.prepare('DELETE FROM seat_categories WHERE id = ?').run(cat.id);
    res.status(204).end();
  })
);

/* --------------------------------------------------------- seat layout */

/**
 * Define a seat layout as a list of row blocks:
 *   { rows: [{ rowLabel: 'A', seats: 12, categoryId: 3 }, ...] }
 * Existing seats for the venue are replaced, which is refused once any show
 * has inventory built from them.
 */
router.put(
  '/venues/:id/layout',
  asyncHandler(async (req, res) => {
    const venue = db.prepare('SELECT * FROM venues WHERE id = ?').get(req.params.id);
    if (!venue) throw notFound('That venue does not exist.');

    const body = validate(req.body, {
      rows: { type: 'array', required: true, minLength: 1, maxLength: 40 },
    });

    const inUse = db
      .prepare(
        `SELECT COUNT(*) AS n FROM show_seats ss
           JOIN seats s ON s.id = ss.seat_id WHERE s.venue_id = ?`
      )
      .get(venue.id).n;
    if (inUse > 0) {
      throw conflict('Seats are already in use by a show. Create a new venue instead.');
    }

    const categories = db.prepare('SELECT * FROM seat_categories WHERE venue_id = ?').all(venue.id);
    const byId = new Map(categories.map((c) => [c.id, c]));

    const parsed = body.rows.map((row, i) => {
      const r = validate(row, {
        rowLabel: { type: 'string', required: true, minLength: 1, maxLength: 3 },
        seats: { type: 'int', required: true, min: 1, max: 60 },
        categoryId: { type: 'int', required: true },
      });
      if (!byId.has(r.categoryId)) {
        throw badRequest(`Row ${i + 1} points at a category that is not part of this venue.`);
      }
      return r;
    });

    const labels = new Set(parsed.map((r) => r.rowLabel.toUpperCase()));
    if (labels.size !== parsed.length) throw badRequest('Row labels must be unique.');

    db.transaction(() => {
      db.prepare('DELETE FROM seats WHERE venue_id = ?').run(venue.id);
      const insert = db.prepare(
        'INSERT INTO seats (venue_id, category_id, row_label, seat_number) VALUES (?, ?, ?, ?)'
      );
      for (const row of parsed) {
        for (let n = 1; n <= row.seats; n += 1) {
          insert.run(venue.id, row.categoryId, row.rowLabel.toUpperCase(), n);
        }
      }
    }).immediate();

    const seats = db
      .prepare(
        `SELECT s.*, c.name AS category FROM seats s
           JOIN seat_categories c ON c.id = s.category_id
          WHERE s.venue_id = ? ORDER BY c.rank, s.row_label, s.seat_number`
      )
      .all(venue.id);
    res.json({ venueId: venue.id, seatCount: seats.length, seats });
  })
);

/* ------------------------------------------------------------ overview */

router.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    const one = (sql) => db.prepare(sql).get().n;
    res.json({
      users: one('SELECT COUNT(*) AS n FROM users'),
      customers: one("SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id=u.role_id WHERE r.name='CUSTOMER'"),
      organisers: one("SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id=u.role_id WHERE r.name='ORGANISER'"),
      venues: one('SELECT COUNT(*) AS n FROM venues'),
      events: one('SELECT COUNT(*) AS n FROM events'),
      shows: one('SELECT COUNT(*) AS n FROM shows'),
      bookings: one("SELECT COUNT(*) AS n FROM bookings WHERE status='CONFIRMED'"),
      revenue: db.prepare("SELECT COALESCE(SUM(total_amount),0) AS n FROM bookings WHERE status='CONFIRMED'").get().n,
    });
  })
);

export default router;
