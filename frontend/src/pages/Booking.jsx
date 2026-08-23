import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, dateTime, money, useAuth } from '../lib.jsx';
import { Countdown, Empty, Notice, Stat } from '../components.jsx';

/* ------------------------------------------------------------- checkout */

export function Checkout() {
  const { holdId } = useParams();
  const navigate = useNavigate();
  const [hold, setHold] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get(`/api/holds/${holdId}`).then(setHold).catch((err) => setError(err.message));
  }, [holdId]);

  useEffect(load, [load]);

  const confirm = async () => {
    setError('');
    setBusy(true);
    try {
      const { booking } = await api.post('/api/bookings', { holdId: Number(holdId) });
      navigate(`/bookings/${booking.id}?new=1`, { replace: true });
    } catch (err) {
      setError(err.message);
      load();
    } finally {
      setBusy(false);
    }
  };

  const release = async () => {
    try {
      await api.del(`/api/holds/${holdId}`);
    } catch { /* the hold may already have expired, which is fine */ }
    navigate(-1);
  };

  if (error && !hold) return <div className="page page-narrow"><Notice>{error}</Notice></div>;
  if (!hold) return <div className="page"><p className="skeleton">Loading your hold…</p></div>;

  return (
    <div className="page page-narrow">
      <p className="eyebrow">Checkout</p>
      <h1>{hold.show.eventTitle}</h1>
      <p className="muted">
        {dateTime(hold.show.startsAt)} · {hold.show.venue.name}, {hold.show.venue.city}
      </p>

      {hold.expired ? (
        <>
          <div className="notice notice-error" style={{ marginTop: 16 }}>
            This hold expired, so the seats went back on sale. Nothing has been charged.
          </div>
          <Link className="btn" style={{ marginTop: 14, display: 'inline-block' }} to="/events">
            Choose seats again
          </Link>
        </>
      ) : (
        <>
          <div className="card" style={{ marginTop: 16 }}>
            <div className="spread">
              <p className="eyebrow" style={{ margin: 0 }}>Time left to complete</p>
              <Countdown expiresAt={hold.expiresAt} onExpire={load} />
            </div>
          </div>

          <div className="card">
            <p className="eyebrow">Seats</p>
            <table>
              <thead>
                <tr><th>Seat</th><th>Category</th><th className="right">Price</th></tr>
              </thead>
              <tbody>
                {hold.seats.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{s.label}</td>
                    <td>{s.category}</td>
                    <td className="right mono">{money(s.price)}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={2}><strong>Total</strong></td>
                  <td className="right mono"><strong>{money(hold.total)}</strong></td>
                </tr>
              </tbody>
            </table>
          </div>

          <Notice>{error}</Notice>

          <div className="row" style={{ marginTop: 16 }}>
            <button type="button" className="btn" onClick={confirm} disabled={busy}>
              {busy ? 'Confirming…' : `Pay ${money(hold.total)} and confirm`}
            </button>
            <button type="button" className="btn btn-quiet" onClick={release} disabled={busy}>
              Release seats
            </button>
          </div>
          <p className="faint" style={{ marginTop: 10 }}>
            This demo does not take payment. Confirming issues the ticket and emails your QR code.
          </p>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------- booking detail/ticket */

export function BookingDetail() {
  const { id } = useParams();
  const [booking, setBooking] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const isNew = new URLSearchParams(window.location.search).get('new') === '1';

  const load = useCallback(() => {
    api.get(`/api/bookings/${id}`).then((d) => setBooking(d.booking)).catch((err) => setError(err.message));
  }, [id]);

  useEffect(load, [load]);

  const cancel = async () => {
    setError('');
    setNotice('');
    try {
      const res = await api.post(`/api/bookings/${id}/cancel`);
      setNotice(
        res.offersCreated > 0
          ? `Booking cancelled. ${res.seatsReleased} seat(s) released — ${res.offersCreated} went straight to people on the waitlist.`
          : `Booking cancelled. ${res.seatsReleased} seat(s) are back on sale.`
      );
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const resend = async () => {
    setError('');
    setNotice('');
    try {
      const res = await api.post(`/api/bookings/${id}/resend-ticket`);
      setNotice(`Ticket re-sent to ${res.email.to} via the ${res.email.transport} transport.`);
    } catch (err) {
      setError(err.message);
    }
  };

  if (error && !booking) return <div className="page page-narrow"><Notice>{error}</Notice></div>;
  if (!booking) return <div className="page"><p className="skeleton">Loading your ticket…</p></div>;

  return (
    <div className="page page-narrow">
      <p className="eyebrow">{isNew ? 'Booking confirmed' : 'Your ticket'}</p>
      <h1>{booking.show.eventTitle}</h1>

      {notice && <div className="notice notice-ok" style={{ margin: '12px 0' }}>{notice}</div>}
      <Notice>{error}</Notice>

      <div className="ticket" style={{ marginTop: 16 }}>
        <div className="ticket-body">
          <div className="spread" style={{ marginBottom: 14 }}>
            <span className={`tag ${booking.status === 'CONFIRMED' ? 'tag-go' : 'tag-stop'}`}>
              {booking.status}
            </span>
            <span className="faint">Booked {dateTime(booking.createdAt)}</span>
          </div>
          <dl className="detail-list">
            <dt>Venue</dt><dd>{booking.show.venue.name}, {booking.show.venue.city}</dd>
            <dt>When</dt><dd>{dateTime(booking.show.startsAt)}</dd>
            <dt>Seats</dt>
            <dd className="mono">{booking.seats.map((s) => s.label).join(', ')}</dd>
            <dt>Category</dt><dd>{[...new Set(booking.seats.map((s) => s.category))].join(', ')}</dd>
            <dt>Total</dt><dd className="mono">{money(booking.total)}</dd>
          </dl>
        </div>

        <div className="ticket-tear" />

        <div className="ticket-stub">
          <img src={booking.qrDataUrl} alt={`QR code encoding booking reference ${booking.reference}`} />
          <div>
            <p className="eyebrow">Booking reference</p>
            <p className="ticket-ref">{booking.reference}</p>
            <p className="faint" style={{ margin: '8px 0 0' }}>
              {booking.status === 'CONFIRMED'
                ? 'Show this code at the entrance. A copy is in your inbox.'
                : 'This booking was cancelled and will not be admitted.'}
            </p>
          </div>
        </div>
      </div>

      <div className="row" style={{ marginTop: 18 }}>
        <Link className="btn btn-quiet" to="/bookings">All bookings</Link>
        {booking.status === 'CONFIRMED' && (
          <>
            <button type="button" className="btn btn-quiet" onClick={resend}>Email me the ticket again</button>
            <button type="button" className="btn btn-danger" onClick={cancel}>Cancel booking</button>
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------ booking history */

export function Bookings() {
  const [bookings, setBookings] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/bookings').then((d) => setBookings(d.bookings)).catch((err) => setError(err.message));
  }, []);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Your history</p>
          <h1>Bookings</h1>
        </div>
        <Link className="btn btn-quiet btn-sm" to="/events">Book something else</Link>
      </div>

      <Notice>{error}</Notice>

      {bookings === null ? (
        <p className="skeleton">Loading…</p>
      ) : bookings.length === 0 ? (
        <Empty title="No bookings yet">Once you book, your tickets and QR codes live here.</Empty>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Reference</th><th>Event</th><th>When</th><th>Seats</th>
                <th className="right">Total</th><th>Status</th><th />
              </tr>
            </thead>
            <tbody>
              {bookings.map((b) => (
                <tr key={b.id}>
                  <td className="mono">{b.reference}</td>
                  <td>{b.show.eventTitle}<div className="faint">{b.show.venue.name}</div></td>
                  <td>{dateTime(b.show.startsAt)}</td>
                  <td className="mono">{b.seats}</td>
                  <td className="right mono">{money(b.total)}</td>
                  <td>
                    <span className={`tag ${b.status === 'CONFIRMED' ? 'tag-go' : 'tag-stop'}`}>{b.status}</span>
                  </td>
                  <td className="right"><Link to={`/bookings/${b.id}`}>View</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------- customer dashboard */

export function CustomerDashboard() {
  const { user } = useAuth();
  const [bookings, setBookings] = useState([]);
  const [waitlist, setWaitlist] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api.get('/api/bookings'), api.get('/api/waitlist')])
      .then(([b, w]) => { setBookings(b.bookings); setWaitlist(w.entries); })
      .catch((err) => setError(err.message));
  }, []);

  const confirmed = bookings.filter((b) => b.status === 'CONFIRMED');
  const upcoming = confirmed
    .filter((b) => new Date(b.show.startsAt) > new Date())
    .sort((a, b) => new Date(a.show.startsAt) - new Date(b.show.startsAt));
  const offers = waitlist.filter((w) => w.offer);

  return (
    <div className="page">
      <p className="eyebrow">Signed in as {user.email}</p>
      <h1>Hello, {user.name.split(' ')[0]}</h1>

      <Notice>{error}</Notice>

      {offers.length > 0 && (
        <div className="notice notice-info" style={{ margin: '16px 0' }}>
          A seat opened up for you. <Link to="/waitlist">Accept it before the offer expires</Link>.
        </div>
      )}

      <div className="grid grid-3" style={{ margin: '18px 0' }}>
        <Stat label="Confirmed bookings" value={confirmed.length} />
        <Stat label="Upcoming shows" value={upcoming.length} />
        <Stat label="Waitlist entries" value={waitlist.filter((w) => ['WAITING', 'OFFERED'].includes(w.status)).length} />
      </div>

      <h2>Next up</h2>
      {upcoming.length === 0 ? (
        <Empty title="Nothing booked yet">
          <Link to="/events">Browse events</Link> and pick your seats.
        </Empty>
      ) : (
        <div className="grid grid-2">
          {upcoming.slice(0, 4).map((b) => (
            <Link className="event-card" key={b.id} to={`/bookings/${b.id}`}>
              <span className="tag tag-go">{b.reference}</span>
              <h3>{b.show.eventTitle}</h3>
              <p className="faint" style={{ margin: 0 }}>
                {dateTime(b.show.startsAt)} · {b.show.venue.name}
              </p>
              <p className="mono" style={{ margin: 0 }}>Seats {b.seats}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
