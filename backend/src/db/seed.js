import { db, migrate } from './index.js';
import { hashPassword } from '../utils/auth.js';

migrate();

const DEMO_PASSWORD = process.env.SEED_PASSWORD || 'Password123!';

function upsertUser(name, email, role) {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return existing.id;
  const roleId = db.prepare('SELECT id FROM roles WHERE name = ?').get(role).id;
  return db
    .prepare('INSERT INTO users (name, email, password_hash, role_id) VALUES (?, ?, ?, ?)')
    .run(name, email, hashPassword(DEMO_PASSWORD), roleId).lastInsertRowid;
}

function buildVenue({ name, city, address, adminId, categories, rows }) {
  const existing = db.prepare('SELECT id FROM venues WHERE name = ? AND city = ?').get(name, city);
  if (existing) return existing.id;

  const venueId = db
    .prepare('INSERT INTO venues (name, city, address, created_by) VALUES (?, ?, ?, ?)')
    .run(name, city, address, adminId).lastInsertRowid;

  const catIds = {};
  for (const c of categories) {
    catIds[c.name] = db
      .prepare('INSERT INTO seat_categories (venue_id, name, rank) VALUES (?, ?, ?)')
      .run(venueId, c.name, c.rank).lastInsertRowid;
  }

  const insertSeat = db.prepare(
    'INSERT INTO seats (venue_id, category_id, row_label, seat_number) VALUES (?, ?, ?, ?)'
  );
  for (const row of rows) {
    for (let n = 1; n <= row.seats; n += 1) {
      insertSeat.run(venueId, catIds[row.category], row.label, n);
    }
  }
  return venueId;
}

function createShow(eventId, venueId, startsAt, priceByCategory) {
  const existing = db
    .prepare('SELECT id FROM shows WHERE event_id = ? AND venue_id = ? AND starts_at = ?')
    .get(eventId, venueId, startsAt);
  if (existing) return existing.id;

  return db.transaction(() => {
    const showId = db
      .prepare('INSERT INTO shows (event_id, venue_id, starts_at) VALUES (?, ?, ?)')
      .run(eventId, venueId, startsAt).lastInsertRowid;

    const categories = db.prepare('SELECT * FROM seat_categories WHERE venue_id = ?').all(venueId);
    const priceStmt = db.prepare(
      'INSERT INTO show_prices (show_id, category_id, price) VALUES (?, ?, ?)'
    );
    for (const c of categories) priceStmt.run(showId, c.id, priceByCategory[c.name] ?? 0);

    const seats = db.prepare('SELECT * FROM seats WHERE venue_id = ?').all(venueId);
    const seatStmt = db.prepare(
      "INSERT INTO show_seats (show_id, seat_id, category_id, status) VALUES (?, ?, ?, 'AVAILABLE')"
    );
    for (const s of seats) seatStmt.run(showId, s.id, s.category_id);
    return showId;
  }).immediate();
}

const daysFromNow = (d, hour = 19) => {
  const dt = new Date();
  dt.setUTCDate(dt.getUTCDate() + d);
  dt.setUTCHours(hour, 0, 0, 0);
  return dt.toISOString();
};

// ---------------------------------------------------------------- users
const adminId = upsertUser('Asha Menon', 'admin@tbs.local', 'ADMIN');
const organiserId = upsertUser('Ravi Kulkarni', 'organiser@tbs.local', 'ORGANISER');
const organiser2Id = upsertUser('Lena Fischer', 'organiser2@tbs.local', 'ORGANISER');
const customerId = upsertUser('Priya Nair', 'customer@tbs.local', 'CUSTOMER');
const customer2Id = upsertUser('Dev Sharma', 'customer2@tbs.local', 'CUSTOMER');
const customer3Id = upsertUser('Maya Iyer', 'customer3@tbs.local', 'CUSTOMER');

// --------------------------------------------------------------- venues
const cineplex = buildVenue({
  name: 'Aurora Cineplex — Screen 1',
  city: 'Bengaluru',
  address: '14 Residency Road',
  adminId,
  categories: [
    { name: 'Premium', rank: 0 },
    { name: 'Standard', rank: 1 },
  ],
  rows: [
    { label: 'A', seats: 10, category: 'Premium' },
    { label: 'B', seats: 10, category: 'Premium' },
    { label: 'C', seats: 12, category: 'Standard' },
    { label: 'D', seats: 12, category: 'Standard' },
    { label: 'E', seats: 12, category: 'Standard' },
  ],
});

const amphitheatre = buildVenue({
  name: 'Riverbank Amphitheatre',
  city: 'Chennai',
  address: 'Marina Promenade',
  adminId,
  categories: [
    { name: 'Premium', rank: 0 },
    { name: 'Standard', rank: 1 },
  ],
  rows: [
    { label: 'A', seats: 8, category: 'Premium' },
    { label: 'B', seats: 8, category: 'Premium' },
    { label: 'C', seats: 10, category: 'Standard' },
    { label: 'D', seats: 10, category: 'Standard' },
  ],
});

// A deliberately tiny room, handy for demonstrating sold-out + waitlist.
const studio = buildVenue({
  name: 'The Black Box Studio',
  city: 'Bengaluru',
  address: '2 Church Street',
  adminId,
  categories: [
    { name: 'Premium', rank: 0 },
    { name: 'Standard', rank: 1 },
  ],
  rows: [
    { label: 'A', seats: 4, category: 'Premium' },
    { label: 'B', seats: 6, category: 'Standard' },
  ],
});

// --------------------------------------------------------------- events
function upsertEvent(organiser, title, type, extra) {
  const existing = db.prepare('SELECT id FROM events WHERE title = ?').get(title);
  if (existing) return existing.id;
  return db
    .prepare(
      `INSERT INTO events (organiser_id, title, description, type, language, duration_min, poster_url)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      organiser,
      title,
      extra.description,
      type,
      extra.language || null,
      extra.durationMin || null,
      extra.posterUrl || null
    ).lastInsertRowid;
}

const movie1 = upsertEvent(organiserId, 'The Longest Monsoon', 'MOVIE', {
  description:
    'A postal clerk in 1970s Kerala keeps delivering letters to an address that no longer exists.',
  language: 'Malayalam',
  durationMin: 138,
});

const movie2 = upsertEvent(organiserId, 'Signal Lost', 'MOVIE', {
  description: 'Two radio operators on opposite sides of a border share a frequency and a secret.',
  language: 'Hindi',
  durationMin: 112,
});

const concert1 = upsertEvent(organiser2Id, 'Karthik Rao — Strings at Dusk', 'CONCERT', {
  description: 'Carnatic violin reworked for a nine-piece ensemble, performed outdoors at sunset.',
  language: 'Instrumental',
  durationMin: 95,
});

const concert2 = upsertEvent(organiser2Id, 'Night Bus Sessions', 'CONCERT', {
  description: 'An intimate late-night set in a forty-eight seat room. No amplification.',
  language: 'English',
  durationMin: 70,
});

// ---------------------------------------------------------------- shows
createShow(movie1, cineplex, daysFromNow(2, 18), { Premium: 450, Standard: 250 });
createShow(movie1, cineplex, daysFromNow(3, 21), { Premium: 450, Standard: 250 });
createShow(movie2, cineplex, daysFromNow(4, 19), { Premium: 400, Standard: 220 });
createShow(concert1, amphitheatre, daysFromNow(6, 19), { Premium: 1500, Standard: 800 });
createShow(concert2, studio, daysFromNow(5, 22), { Premium: 2000, Standard: 1200 });

const counts = {
  users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
  venues: db.prepare('SELECT COUNT(*) AS n FROM venues').get().n,
  seats: db.prepare('SELECT COUNT(*) AS n FROM seats').get().n,
  events: db.prepare('SELECT COUNT(*) AS n FROM events').get().n,
  shows: db.prepare('SELECT COUNT(*) AS n FROM shows').get().n,
  showSeats: db.prepare('SELECT COUNT(*) AS n FROM show_seats').get().n,
};

console.log('[seed] done:', counts);
console.log(`[seed] demo password for every account: ${DEMO_PASSWORD}`);
console.log('[seed] admin@tbs.local | organiser@tbs.local | customer@tbs.local (+ customer2, customer3)');

// Keep ids referenced so linters do not flag them as unused.
void customerId; void customer2Id; void customer3Id;
