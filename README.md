# Ticket Booking System

A booking platform for movies and concerts, built around the hard parts of high-demand
ticketing: **temporary seat holds with a server-enforced TTL**, **concurrency protection
that makes double-booking impossible**, a **FIFO waitlist with time-limited offers**,
**QR tickets by email**, and a **real-time seat map**.

---

## Table of contents

1. [Project overview](#1-project-overview)
2. [Features](#2-features)
3. [Tech stack](#3-tech-stack)
4. [Architecture](#4-architecture)
5. [Folder structure](#5-folder-structure)
6. [Prerequisites](#6-prerequisites)
7. [Installation](#7-installation)
8. [Environment variables](#8-environment-variables)
9. [Database setup](#9-database-setup)
10. [Running locally](#10-running-locally)
11. [API documentation](#11-api-documentation)
12. [Database schema](#12-database-schema)
13. [Seat hold and TTL mechanism](#13-seat-hold-and-ttl-mechanism)
14. [Concurrency protection](#14-concurrency-protection)
15. [Waitlist logic](#15-waitlist-logic)
16. [QR and email implementation](#16-qr-and-email-implementation)
17. [Real-time implementation](#17-real-time-implementation)
18. [Testing](#18-testing)
19. [Deployment](#19-deployment)

---

## 1. Project overview

Three roles share one system:

| Role | Can do |
| --- | --- |
| **Customer** | Browse and filter events, view a visual seat map, hold seats, check out, view and cancel bookings, join a waitlist when sold out |
| **Organiser** | Create events, schedule shows, set per-category pricing, view booking summaries and revenue |
| **Admin** | Create venues, define seat categories and seat layouts, view platform statistics |

The design rule throughout: **the backend and database are the source of truth.** The
frontend never decides whether a seat is free, whether a hold is still valid, or when a
hold expires — it asks, and it is told.

---

## 2. Features

**Customer**
- Register, log in, browse and filter events (text, type, city, date)
- Event detail with every showtime and live availability
- Visual seat map showing `AVAILABLE` / `HELD` / `BOOKED` / `OFFERED`
- Select seats, place a temporary hold, see a live countdown
- Check out, receive a QR ticket by email, view booking history and detail
- Cancel a booking; join a FIFO waitlist for a sold-out seat category
- Accept or decline a time-limited waitlist offer

**Organiser** — event CRUD, show scheduling, per-category pricing, booking summary
(occupancy, seats held/sold, waitlist depth), revenue per event and per category, per-show
booking list.

**Admin** — venue CRUD, seat category management, seat layout definition generating
individually addressable seats, platform statistics.

**Platform** — server-enforced hold TTL, transactional concurrency protection, FIFO
waitlist with expiring offers and automatic reassignment, QR generation, email with a
development fallback, WebSocket seat updates, JWT auth with role-based authorisation,
input validation, consistent error envelopes, OpenAPI docs.

---

## 3. Tech stack

| Layer | Choice | Why |
| --- | --- | --- |
| Runtime | Node.js 18.17+ (ES modules) | — |
| API | Express 4 | Small, explicit |
| Database | SQLite via `better-sqlite3` (WAL) | Zero setup for a reviewer; synchronous API makes transaction boundaries obvious. Concurrency is enforced with `BEGIN IMMEDIATE` + conditional updates, which port directly to Postgres |
| Auth | `jsonwebtoken` + `bcryptjs` | — |
| Real-time | `ws` | Plain WebSockets, no broker |
| QR | `qrcode` | PNG data URLs |
| Email | `nodemailer` | SMTP plus file/console dev fallbacks |
| Frontend | React 19 + Vite + React Router | — |
| Tests | Node's built-in `node:test` | No extra test dependencies |

No CSS framework, no state library, no ORM — the dependency list is deliberately short.

---

## 4. Architecture

```
┌────────────────────────┐         REST (JSON)        ┌──────────────────────────┐
│  React SPA (Vite)      │ ─────────────────────────► │  Express API             │
│  · seat map            │ ◄───────────────────────── │  · routes (role-guarded) │
│  · checkout + tickets  │        WebSocket /ws       │  · services (seat logic) │
│  · organiser / admin   │ ◄───────────────────────── │  · middleware (auth)     │
└────────────────────────┘      seats.updated         └───────────┬──────────────┘
                                                                  │
                             ┌────────────────────────────────────┼──────────────┐
                             │                                    │              │
                    ┌────────▼─────────┐              ┌───────────▼──────┐  ┌────▼─────┐
                    │ SQLite (WAL)     │              │ Expiry sweeper   │  │ Mailer   │
                    │ source of truth  │ ◄─────────── │ holds + offers   │  │ QR email │
                    └──────────────────┘              └──────────────────┘  └──────────┘
```

Request flow for a hold: route → validation → auth/role middleware → `seatService` →
`BEGIN IMMEDIATE` transaction → conditional UPDATE → COMMIT → WebSocket broadcast.
Broadcasts always happen *after* commit.

---

## 5. Folder structure

```
ticket-booking-system/
├── backend/
│   ├── src/
│   │   ├── config.js              # env-driven configuration
│   │   ├── app.js                 # express assembly, CORS, docs, error handling
│   │   ├── server.js              # http server + websocket + scheduler
│   │   ├── db/
│   │   │   ├── schema.sql         # full schema (tables, indexes, constraints)
│   │   │   ├── index.js           # connection, migrate, transaction helpers
│   │   │   ├── migrate.js         # migration CLI
│   │   │   └── seed.js            # demo venues, events, shows, accounts
│   │   ├── middleware/            # auth.js (JWT + roles), error.js
│   │   ├── routes/                # auth, admin, organiser, events, bookings, waitlist
│   │   ├── services/seatService.js# holds, TTL sweep, booking, cancellation, waitlist
│   │   ├── realtime/hub.js        # websocket rooms + publishing
│   │   ├── jobs/scheduler.js      # background expiry sweeper
│   │   └── utils/                 # auth, validate, qr, mailer, errors
│   ├── tests/                     # 78 tests across 6 suites
│   ├── openapi.json               # OpenAPI 3.0 spec (served at /api/docs)
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── lib.jsx                # api client, auth context, formatting, countdown
│   │   ├── components.jsx         # masthead, route guards, seat map, websocket hook
│   │   ├── pages/                 # Public, Auth, ShowSeats, Booking, Waitlist, Organiser, Admin
│   │   ├── styles.css             # design system
│   │   ├── App.jsx                # routing
│   │   └── main.jsx
│   └── package.json
├── README.md
├── SYSTEM_DESIGN.md
├── .env.example
└── .gitignore
```

---

## 6. Prerequisites

- **Node.js 18.17 or newer** (developed and tested on Node 22) and npm
- A C toolchain is only needed if npm cannot fetch a `better-sqlite3` prebuilt binary
- No database server to install — SQLite is a file

---

## 7. Installation

```bash
# from the project root
cd backend  && npm install
cd ../frontend && npm install
```

---

## 8. Environment variables

Copy the example file and adjust as needed:

```bash
cp .env.example backend/.env
```

The frontend reads `VITE_API_URL`; if you are not using the default port, also create
`frontend/.env` with that variable.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4000` | API port |
| `NODE_ENV` | `development` | — |
| `DATABASE_FILE` | `data/ticket-booking.db` | SQLite path, relative to `backend/` |
| `JWT_SECRET` | dev fallback | **Set a real secret outside development** |
| `JWT_EXPIRES_IN` | `12h` | Token lifetime |
| `BCRYPT_ROUNDS` | `10` | Password hashing cost |
| `CORS_ORIGINS` | localhost/127.0.0.1 on 5173 and 4173 | Comma-separated allowlist |
| `HOLD_TTL_SECONDS` | `600` | **Seat hold TTL (10 minutes)** |
| `MAX_SEATS_PER_HOLD` | `8` | Seats one customer may hold at once |
| `WAITLIST_OFFER_TTL_SECONDS` | `300` | How long a waitlist offer stays open |
| `SWEEP_INTERVAL_MS` | `5000` | Background expiry sweep interval |
| `MAIL_TRANSPORT` | `file` | `smtp`, `file` or `console` |
| `MAIL_FROM` | no-reply address | Sender |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` | empty | Only for `MAIL_TRANSPORT=smtp` |
| `MAIL_OUTBOX_DIR` | `outbox` | Where the `file` transport writes emails |
| `VITE_API_URL` | `http://localhost:4000` | Frontend → API base URL |

`.env` is git-ignored. **No real credentials are committed anywhere in this repository.**

---

## 9. Database setup

```bash
cd backend
npm run migrate     # create tables and indexes (idempotent)
npm run seed        # demo venues, events, shows and accounts
# or, to start completely fresh:
npm run reset       # drop everything, recreate, reseed
```

Seeded accounts (password `Password123!` for all):

| Email | Role |
| --- | --- |
| `admin@tbs.local` | Admin |
| `organiser@tbs.local`, `organiser2@tbs.local` | Organiser |
| `customer@tbs.local`, `customer2@tbs.local`, `customer3@tbs.local` | Customer |

The seed includes a deliberately tiny 10-seat venue ("The Black Box Studio") so you can
sell a show out quickly and exercise the waitlist.

---

## 10. Running locally

Two terminals:

```bash
# terminal 1 — API on http://localhost:4000
cd backend && npm run dev        # or: npm start

# terminal 2 — UI on http://localhost:5173
cd frontend && npm run dev
```

Then open **http://localhost:5173** and sign in with a seeded account.

| URL | What |
| --- | --- |
| `http://localhost:5173` | The application |
| `http://localhost:4000/api/health` | Health + active configuration |
| `http://localhost:4000/api/docs` | Swagger UI |
| `http://localhost:4000/api/dev/emails` | Development email outbox |

Production builds: `cd frontend && npm run build && npm run preview`.

---

## 11. API documentation

Full interactive documentation with request/response examples and error cases is served at
**`/api/docs`** (Swagger UI over `backend/openapi.json`, 35 paths / 44 operations).
Send `Authorization: Bearer <token>` for authenticated routes.

Every error uses one envelope:

```json
{ "error": { "code": "CONFLICT", "message": "Seat A4 was just taken. Pick another one.",
             "details": { "seatId": 12, "status": "HELD" } } }
```

Status codes: `400` validation, `401` missing/invalid token, `403` wrong role or another
user's resource, `404` not found, `409` conflict (race lost, expired hold, already
cancelled, sold out), `500` unexpected.

### Key endpoints

**Auth** — `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`

**Public** — `GET /api/events` (filters: `q`, `type`, `city`, `venueId`, `from`, `to`),
`GET /api/events/:id`, `GET /api/events/shows/:showId/seatmap`,
`GET /api/events/meta/cities`, `GET /api/events/meta/venues`

**Customer** — `POST /api/holds`, `GET /api/holds/:id`, `DELETE /api/holds/:id`,
`POST /api/bookings`, `GET /api/bookings`, `GET /api/bookings/:id`,
`POST /api/bookings/:id/cancel`, `POST /api/bookings/:id/resend-ticket`

**Waitlist** — `POST /api/waitlist`, `GET /api/waitlist`, `DELETE /api/waitlist/:id`,
`POST /api/waitlist/offers/:id/accept`, `POST /api/waitlist/offers/:id/decline`,
`POST /api/waitlist/sweep` (admin)

**Organiser** — `GET|POST /api/organiser/events`, `GET|PATCH|DELETE /api/organiser/events/:id`,
`POST /api/organiser/events/:id/shows`, `PATCH /api/organiser/shows/:id/prices`,
`DELETE /api/organiser/shows/:id`, `GET /api/organiser/events/:id/summary`,
`GET /api/organiser/revenue`, `GET /api/organiser/shows/:id/bookings`

**Admin** — `GET|POST /api/admin/venues`, `GET|PATCH|DELETE /api/admin/venues/:id`,
`POST /api/admin/venues/:id/categories`, `DELETE /api/admin/categories/:id`,
`PUT /api/admin/venues/:id/layout`, `GET /api/admin/stats`

#### Example: hold seats

```http
POST /api/holds
Authorization: Bearer <customer token>

{ "showId": 1, "seatIds": [12, 13] }
```

```json
{ "holdId": 7, "showId": 1, "expiresAt": "2026-08-23T10:35:16.912Z", "ttlSeconds": 600,
  "seats": [{ "id": 12, "label": "C1", "category": "Standard", "price": 250 }],
  "total": 500 }
```

`409` if another customer took a seat first; the hold is all-or-nothing.

---

## 12. Database schema

```
roles ──< users ──< bookings ──< booking_seats >── show_seats >── seats >── seat_categories
                        │                              │            │              │
venues ──< seat_categories                             │          venues ──────────┘
   │                                                   │
   └──< seats                shows ──< show_prices     │
   └──< shows ──────────────────┴──< show_seats ───────┘
                                 └──< seat_holds
                                 └──< waitlists ──< waitlist_offers
```

| Table | Purpose | Notable columns / constraints |
| --- | --- | --- |
| `roles` | CUSTOMER, ORGANISER, ADMIN | `UNIQUE(name)` |
| `users` | Accounts | `UNIQUE(email)`, `password_hash` (bcrypt) |
| `venues` | Physical venues | — |
| `seat_categories` | Premium / Standard per venue | `UNIQUE(venue_id, name)` |
| `seats` | Individual physical seats | `UNIQUE(venue_id, row_label, seat_number)` |
| `events` | Movie or concert listing | `organiser_id` owner |
| `shows` | A dated screening at a venue | indexed on `starts_at` |
| `show_prices` | Price per category per show | `UNIQUE(show_id, category_id)` |
| **`show_seats`** | **Per-show seat inventory — the availability source of truth** | `UNIQUE(show_id, seat_id)`, `status` ∈ AVAILABLE/HELD/BOOKED/OFFERED, `version` counter, FKs to `hold_id`, `booking_id`, `offer_id` |
| `seat_holds` | Temporary holds | `expires_at`, `status` ∈ ACTIVE/EXPIRED/CONVERTED/RELEASED, `source` ∈ SELECTION/WAITLIST_OFFER |
| `bookings` | Confirmed or cancelled | `UNIQUE(reference)`, `qr_payload`, `total_amount` |
| `booking_seats` | Seats in a booking | `UNIQUE(booking_id, show_seat_id)` |
| `waitlists` | FIFO queue per show+category | `position`, `UNIQUE(show_id, category_id, user_id)` |
| `waitlist_offers` | Time-limited seat offers | `expires_at`, **partial unique index on `show_seat_id WHERE status='PENDING'`** |
| `email_log` | Every email attempt | Audit trail + dev outbox |

**Why status is per show:** `seats` describes the room, `show_seats` describes one
performance. Seat A1 may be `BOOKED` tonight and `AVAILABLE` tomorrow, because those are
different rows.

**How concurrency is prevented at the schema level:** `UNIQUE(show_id, seat_id)` makes
duplicate inventory impossible; `UNIQUE(booking_id, show_seat_id)` stops a seat appearing
twice in one booking; the partial unique index on pending offers makes it structurally
impossible to offer one seat to two customers simultaneously. Application logic then uses
`BEGIN IMMEDIATE` plus conditional updates (below).

---

## 13. Seat hold and TTL mechanism

Selecting seats writes a `seat_holds` row with a server-computed `expires_at` and flips
each `show_seats` row to `HELD`. While held, every other customer sees the seat as
unavailable.

Expiry is enforced **in the backend, never by a browser timer**:

- a **background scheduler** (`SWEEP_INTERVAL_MS`, default 5s) expires lapsed holds and
  returns their seats to `AVAILABLE`;
- a **lazy sweep** runs before every seat-state read or write, so a stale hold can never
  influence an answer even if the scheduler is behind.

The UI countdown is presentation only. Verified by test: a seat held with a 1-second TTL
returns to `AVAILABLE` with no client involvement, becomes holdable by someone else, and
the expired hold is refused at checkout with `409`.

---

## 14. Concurrency protection

```js
// inside BEGIN IMMEDIATE
const res = db.prepare(
  `UPDATE show_seats SET status='HELD', hold_id=?, version=version+1
    WHERE id=? AND status='AVAILABLE'`
).run(holdId, seatId);

if (res.changes !== 1) throw conflict(`Seat ${label} was just taken.`);
```

1. `BEGIN IMMEDIATE` acquires the write lock up front, serialising writers.
2. The status check and the write are a **single atomic statement** — there is no window
   between reading "available" and writing "held".
3. Any failed seat throws, rolling back the whole hold.
4. `version` increments on every transition, supporting optimistic concurrency.
5. Checkout re-checks `status='HELD' AND hold_id=?`, so expired or foreign holds cannot be
   converted.

**Tested three ways:** 20 parallel HTTP holds on one seat → exactly 1 success, 19 × `409`;
overlapping multi-seat holds → no seat in two successful holds; and **8 separate OS
processes** racing on the same database file → exactly one winner, every loser losing on
the conditional update. The last one cannot be passed by single-threaded luck.

---

## 15. Waitlist logic

1. Join is allowed only when the category has zero `AVAILABLE` seats.
2. `position` increases monotonically per `(show, category)` — FIFO by construction.
3. On cancellation each freed seat is offered, inside the same transaction, to the
   lowest-position `WAITING` customer: an offer row is created, the seat becomes `OFFERED`
   (invisible and unholdable for everyone else), and an email goes out.
4. The offer expires after `WAITLIST_OFFER_TTL_SECONDS`; the sweeper then marks it
   `EXPIRED` and re-offers the same seat to the next person, or returns it to public sale
   if the queue is empty.
5. Accepting converts the seat into an ordinary hold for that customer, who checks out
   normally. Declining re-offers immediately.

The same seat is never offered to two customers at once — guaranteed by the partial unique
index, not just by application logic.

---

## 16. QR and email implementation

On confirmation the server generates a reference like `TBS-3M6XS6TU` (8 characters from an
alphabet that excludes `I`, `O`, `0`, `1` so it can be read aloud) and a QR PNG that
encodes **only the reference**, so a scanner resolves the booking server-side rather than
trusting the payload. The email contains event, venue, date/time, seats, reference and the
inline QR.

Mail is sent **after** the booking transaction commits, so a mail outage can never
invalidate a paid booking.

| `MAIL_TRANSPORT` | Behaviour |
| --- | --- |
| `smtp` | Real delivery; on failure it logs and falls back to a file |
| `file` *(default)* | Writes rendered `.html` into `backend/outbox/` |
| `console` | Prints a summary to stdout |

Every attempt is recorded in `email_log`, listed at `GET /api/dev/emails` and viewable as
HTML at `/api/dev/emails/:id` — so the whole flow is verifiable with no third-party
credentials. Customers can also re-send their own ticket.

---

## 17. Real-time implementation

WebSocket endpoint: `ws://localhost:4000/ws?showId=<id>`, one room per show. Clients may
re-subscribe on the same socket with `{"type":"subscribe","showId":N}`.

Published **after commit** so a broadcast can never describe uncommitted state:

```json
{ "type": "seats.updated", "showId": 1, "reason": "hold",
  "seats": [{ "id": 12, "status": "HELD" }], "at": "2026-08-23T10:25:16.912Z" }
```

`reason` is one of `hold`, `booked`, `cancelled`, `expiry`, `hold-released`,
`offer-accepted`, `offer-declined`. Expiry sweeps broadcast too, so an abandoned hold
visibly frees up on every open seat map with nobody acting. The client patches its map in
place (preserving scroll position) and reconnects automatically after a server restart.

---

## 18. Testing

```bash
cd backend && npm test
```

**78 automated tests across 6 suites, all passing.**

| Suite | Covers |
| --- | --- |
| `auth.test.js` (14) | Registration, login, `/me`, duplicate email, weak password, admin self-registration blocked, every role-access combination, 401 vs 403 |
| `booking.test.js` (17) | Seat map, per-show status isolation, single and multi-seat holds, all-or-nothing holds, seat limits, release, **TTL expiry**, expired hold refused at checkout, booking, double-booking prevented, ownership isolation, cancellation |
| `waitlist.test.js` (13) | Join refused while seats remain, sold-out join, FIFO ordering, offer on cancellation, offered seat unholdable by others, accept → book, wrong-customer rejection, **offer expiry rolls to the next customer**, empty queue returns seat to sale, decline re-offers |
| `concurrency.test.js` (4) | 20 parallel holds on one seat, overlapping multi-seat holds, duplicate checkout, **8 separate OS processes racing on the same database file** |
| `qr-email.test.js` (8) | Reference format and uniqueness, QR is a valid PNG encoding exactly the reference, email recorded with event/venue/seats/reference/QR, dev outbox, re-send ownership, waitlist offer email |
| `admin-organiser.test.js` (15) | Venue/category/layout CRUD, layout locking, cross-organiser isolation, per-show inventory creation, pricing validation, summary and revenue accuracy, public filtering |

Each suite runs against its own throwaway database and a real HTTP server with the real
background scheduler.

**Also verified manually against a running stack** (backend + built frontend, driven in a
real Chromium browser):

- full customer journey: browse → filter → seat map → select → hold → checkout → ticket
  with QR → history → cancel
- **live updates across two independent browser sessions**: one customer holds seats and
  the other sees `HELD` appear, then `BOOKED`, then seats freed on cancellation — without
  reloading
- **TTL in the UI**: a 5-second hold placed via the API visibly returns to `AVAILABLE` on
  an open seat map with no user action
- **waitlist journey**: sell out → "Join waitlist" → cancellation → offer with countdown →
  accept → checkout → ticket
- organiser and admin dashboards, layout editor, venue picker, statistics
- zero browser console errors

---

## 19. Deployment

**Backend**

1. Set `NODE_ENV=production`, a strong `JWT_SECRET`, and `CORS_ORIGINS` to your frontend
   origin.
2. Point `DATABASE_FILE` at persistent storage (SQLite in WAL mode is fine for a single
   node). For multiple API instances, move to PostgreSQL — the concurrency approach
   (`BEGIN IMMEDIATE` → `SELECT … FOR UPDATE` or the same conditional `UPDATE … WHERE
   status='AVAILABLE'`) ports directly, since the guarantees live in SQL, not in Node.
3. `npm ci --omit=dev && npm run migrate && npm start` behind a reverse proxy that
   forwards WebSocket upgrades on `/ws`.
4. Set `MAIL_TRANSPORT=smtp` with real credentials supplied as environment variables.

**Frontend**

```bash
cd frontend && VITE_API_URL=https://api.example.com npm run build
```

Serve `dist/` from any static host with SPA fallback (rewrite unknown paths to
`index.html`).

**Notes** — run one sweeper per database (the scheduler is per-process; with several API
instances, run it in a single worker or move expiry to a shared scheduler). Terminate TLS
at the proxy and use `wss://` in production.
