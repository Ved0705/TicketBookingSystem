# System Design

## 1. Seat hold mechanism

Physical seats belong to a venue and never carry a booking status. Availability lives in
`show_seats`, one row per `(show_id, seat_id)` created when an organiser schedules a show.
Status is therefore always per show: seat A1 can be `BOOKED` for tonight and `AVAILABLE`
for tomorrow.

A hold is a row in `seat_holds` (`user_id`, `show_id`, `expires_at`, `status`) plus a
pointer from each covered `show_seats` row (`status='HELD'`, `hold_id`). Holds are
all-or-nothing: if any requested seat cannot be taken, the transaction rolls back and no
seat is left stranded. A customer's previous hold on the same show is released first, so
nobody can accumulate parallel holds and starve inventory.

## 2. TTL and auto-release

`expires_at` is written by the server (`HOLD_TTL_SECONDS`, default 600). Expiry is
enforced in two places, both server-side:

1. **A background sweeper** (`src/jobs/scheduler.js`) runs every `SWEEP_INTERVAL_MS`,
   selects holds where `status='ACTIVE' AND expires_at <= now`, marks them `EXPIRED`, and
   returns their seats to `AVAILABLE`.
2. **A lazy sweep** runs at the start of every read or write that depends on seat state,
   so an answer is never computed from a hold that has already lapsed even if the
   scheduler is momentarily behind.

The browser only *displays* a countdown. Closing the tab, killing the frontend, or losing
the network changes nothing — the database still releases the seat, which the test suite
verifies by holding with a 1-second TTL and then simply waiting.

## 3. Concurrency prevention

Three layers, all in the database:

1. **`BEGIN IMMEDIATE`** takes the write lock before any read, so two writers are
   serialised by SQLite rather than discovering a conflict at COMMIT.
2. **Conditional atomic update.** The check and the write are one statement:
   `UPDATE show_seats SET status='HELD', hold_id=?, version=version+1
    WHERE id=? AND status='AVAILABLE'`.
   The loser gets `changes === 0` and cannot overwrite the winner. A `version` counter
   supports optimistic concurrency for clients that want it.
3. **Constraints.** `UNIQUE(show_id, seat_id)` makes duplicate inventory impossible;
   a partial unique index `waitlist_offers(show_seat_id) WHERE status='PENDING'` makes it
   impossible to offer one seat to two customers at once.

Checkout repeats the pattern (`WHERE status='HELD' AND hold_id=?`), so an expired or
stolen hold cannot be converted. Verified by twenty parallel HTTP requests for one seat
(exactly one winner) and by eight **separate OS processes** racing on the same database
file — a test the event loop cannot pass by accident.

## 4. Waitlist auto-assignment

When a category has no `AVAILABLE` seats, a customer joins `waitlists` with a
monotonically increasing `position` per `(show_id, category_id)` — FIFO by construction.

Cancellation releases each seat inside the same transaction that cancels the booking, then
calls `offerSeatToNextInQueue`, which picks the lowest-position `WAITING` entry, inserts a
`PENDING` offer, and moves the seat to `OFFERED` (conditional on it still being
`AVAILABLE`). If that conditional update fails the offer is deleted rather than risking a
double allocation. `OFFERED` seats are invisible to the general public and cannot be held
by anyone else.

## 5. Time-limited offers

Offers carry `expires_at` (`WAITLIST_OFFER_TTL_SECONDS`, default 300). The same sweeper
expires them: the offer becomes `EXPIRED`, the waitlist entry becomes `EXPIRED`, the seat
returns to `AVAILABLE`, and it is immediately re-offered to the next person in line. If
the queue is empty the seat simply returns to public sale. Accepting converts the reserved
seat into an ordinary hold owned by that customer, who then checks out normally; declining
re-offers it at once.

## 6. Real-time seat updates

A WebSocket hub (`/ws?showId=<id>`) keeps one room per show. Every state transition is
published **after** its transaction commits, so a broadcast can never describe a state the
database does not hold. Frames carry only what changed:
`{ type:'seats.updated', showId, reason, seats:[{id,status}], at }` with reasons `hold`,
`booked`, `cancelled`, `expiry`, `offer-accepted`, `hold-released`, `offer-declined`.
The client patches its map in place and reconnects automatically. Expiry sweeps broadcast
too, so an abandoned hold visibly frees up on every open seat map without anyone acting.

## 7. QR and email flow

On confirmation the server generates a collision-resistant reference (`TBS-` plus eight
characters from an alphabet excluding `I`, `O`, `0`, `1`) and a QR PNG encoding *only*
that reference, so a scanner resolves the booking server-side instead of trusting the
payload. The ticket email carries event, venue, date/time, seats, reference and the inline
QR.

Mail runs after the transaction commits — a mail outage never invalidates a paid booking.
`MAIL_TRANSPORT=smtp` delivers for real; the default `file` transport writes rendered
`.html` into `backend/outbox/`, and `console` prints a summary. Every attempt is recorded
in `email_log` and browsable at `/api/dev/emails`, so the flow is fully testable with no
third-party credentials.
