-- =====================================================================
-- Ticket Booking System — schema
-- Engine: SQLite (WAL mode, foreign keys on)
--
-- Design notes
--  * Physical seats belong to a venue and never carry a booking status.
--  * Per-show availability lives in `show_seats`, so the same physical
--    seat can be AVAILABLE for one show and BOOKED for another.
--  * `show_seats.status` + `version` are the concurrency control point.
-- =====================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------
-- Users & roles
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE CHECK (name IN ('CUSTOMER', 'ORGANISER', 'ADMIN'))
);

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  email          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash  TEXT    NOT NULL,
  role_id        INTEGER NOT NULL REFERENCES roles(id),
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role_id);

-- ---------------------------------------------------------------------
-- Venues, seat categories, physical seats
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS venues (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  city       TEXT NOT NULL,
  address    TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS seat_categories (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name     TEXT    NOT NULL,               -- e.g. Premium, Standard
  rank     INTEGER NOT NULL DEFAULT 0,     -- display ordering
  UNIQUE (venue_id, name)
);

CREATE TABLE IF NOT EXISTS seats (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_id    INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES seat_categories(id) ON DELETE CASCADE,
  row_label   TEXT    NOT NULL,            -- 'A', 'B', ...
  seat_number INTEGER NOT NULL,            -- 1, 2, ...
  UNIQUE (venue_id, row_label, seat_number)
);
CREATE INDEX IF NOT EXISTS idx_seats_venue ON seats(venue_id);

-- ---------------------------------------------------------------------
-- Events (movie / concert) and shows (a dated screening of an event)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  organiser_id INTEGER NOT NULL REFERENCES users(id),
  title        TEXT    NOT NULL,
  description  TEXT,
  type         TEXT    NOT NULL CHECK (type IN ('MOVIE', 'CONCERT')),
  language     TEXT,
  duration_min INTEGER,
  poster_url   TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_organiser ON events(organiser_id);

CREATE TABLE IF NOT EXISTS shows (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  venue_id   INTEGER NOT NULL REFERENCES venues(id),
  starts_at  TEXT    NOT NULL,             -- ISO-8601 UTC
  status     TEXT    NOT NULL DEFAULT 'SCHEDULED'
             CHECK (status IN ('SCHEDULED', 'CANCELLED')),
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shows_event ON shows(event_id);
CREATE INDEX IF NOT EXISTS idx_shows_starts ON shows(starts_at);

-- Price of a seat category for one specific show.
CREATE TABLE IF NOT EXISTS show_prices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id     INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES seat_categories(id) ON DELETE CASCADE,
  price       REAL    NOT NULL CHECK (price >= 0),
  UNIQUE (show_id, category_id)
);

-- ---------------------------------------------------------------------
-- Per-show seat inventory — the source of truth for availability
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS show_seats (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id     INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  seat_id     INTEGER NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES seat_categories(id),
  status      TEXT    NOT NULL DEFAULT 'AVAILABLE'
              CHECK (status IN ('AVAILABLE', 'HELD', 'BOOKED', 'OFFERED')),
  hold_id     INTEGER REFERENCES seat_holds(id) ON DELETE SET NULL,
  booking_id  INTEGER REFERENCES bookings(id)   ON DELETE SET NULL,
  offer_id    INTEGER REFERENCES waitlist_offers(id) ON DELETE SET NULL,
  version     INTEGER NOT NULL DEFAULT 0,     -- optimistic concurrency counter
  -- One inventory row per seat per show. This unique constraint is what makes
  -- the "same seat twice" race impossible at the storage layer.
  UNIQUE (show_id, seat_id)
);
CREATE INDEX IF NOT EXISTS idx_show_seats_show ON show_seats(show_id, status);
CREATE INDEX IF NOT EXISTS idx_show_seats_cat  ON show_seats(show_id, category_id, status);

-- ---------------------------------------------------------------------
-- Temporary seat holds (TTL enforced server-side)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seat_holds (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id    INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT    NOT NULL DEFAULT 'ACTIVE'
             CHECK (status IN ('ACTIVE', 'EXPIRED', 'CONVERTED', 'RELEASED')),
  expires_at TEXT    NOT NULL,             -- ISO-8601 UTC, checked by the DB/sweeper
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  source     TEXT    NOT NULL DEFAULT 'SELECTION'
             CHECK (source IN ('SELECTION', 'WAITLIST_OFFER'))
);
CREATE INDEX IF NOT EXISTS idx_holds_active ON seat_holds(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_holds_user   ON seat_holds(user_id, status);

-- ---------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bookings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  reference    TEXT    NOT NULL UNIQUE,    -- e.g. TBS-7KQ4M2XD
  user_id      INTEGER NOT NULL REFERENCES users(id),
  show_id      INTEGER NOT NULL REFERENCES shows(id),
  status       TEXT    NOT NULL DEFAULT 'CONFIRMED'
               CHECK (status IN ('CONFIRMED', 'CANCELLED')),
  total_amount REAL    NOT NULL DEFAULT 0,
  qr_payload   TEXT,                       -- what the QR encodes (booking reference)
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id, status);
CREATE INDEX IF NOT EXISTS idx_bookings_show ON bookings(show_id, status);

CREATE TABLE IF NOT EXISTS booking_seats (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id    INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  show_seat_id  INTEGER NOT NULL REFERENCES show_seats(id),
  price         REAL    NOT NULL,
  UNIQUE (booking_id, show_seat_id)
);

-- ---------------------------------------------------------------------
-- Waitlist (FIFO per show + seat category)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS waitlists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id     INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES seat_categories(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      TEXT    NOT NULL DEFAULT 'WAITING'
              CHECK (status IN ('WAITING', 'OFFERED', 'FULFILLED', 'EXPIRED', 'CANCELLED')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  -- position is assigned monotonically per (show, category) => FIFO ordering
  position    INTEGER NOT NULL,
  -- A user may only queue once per show+category while active.
  UNIQUE (show_id, category_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_waitlist_fifo
  ON waitlists(show_id, category_id, status, position);

CREATE TABLE IF NOT EXISTS waitlist_offers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  waitlist_id  INTEGER NOT NULL REFERENCES waitlists(id) ON DELETE CASCADE,
  show_seat_id INTEGER NOT NULL REFERENCES show_seats(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT    NOT NULL DEFAULT 'PENDING'
               CHECK (status IN ('PENDING', 'ACCEPTED', 'EXPIRED', 'DECLINED')),
  expires_at   TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_offers_pending ON waitlist_offers(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_offers_user    ON waitlist_offers(user_id, status);

-- A seat can have at most ONE pending offer at a time. Enforced by the DB so
-- the same seat can never be offered to two customers simultaneously.
CREATE UNIQUE INDEX IF NOT EXISTS uq_offer_one_pending_per_seat
  ON waitlist_offers(show_seat_id) WHERE status = 'PENDING';

-- ---------------------------------------------------------------------
-- Outbox for emails (development fallback + delivery audit trail)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  transport  TEXT NOT NULL,                -- smtp | console | file
  status     TEXT NOT NULL,                -- SENT | FAILED
  error      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO roles (id, name) VALUES (1, 'CUSTOMER'), (2, 'ORGANISER'), (3, 'ADMIN');
