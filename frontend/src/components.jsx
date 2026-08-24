import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, NavLink, useLocation } from 'react-router-dom';
import { API_URL, useAuth, useCountdown } from './lib.jsx';

/* ---------------------------------------------------------------- chrome */

export function Masthead() {
  const { user, logout } = useAuth();
  const link = ({ isActive }) => (isActive ? 'active' : undefined);

  return (
    <header className="masthead">
      <div className="masthead-inner">
        <NavLink to="/" className="wordmark">
          <span className="wordmark-mark" aria-hidden="true" />
          Box Office
        </NavLink>
        <nav className="nav">
          <NavLink to="/events" className={link}>Events</NavLink>
          {user?.role === 'CUSTOMER' && (
            <>
              <NavLink to="/dashboard" className={link}>Dashboard</NavLink>
              <NavLink to="/bookings" className={link}>Bookings</NavLink>
              <NavLink to="/waitlist" className={link}>Waitlist</NavLink>
            </>
          )}
          {user?.role === 'ORGANISER' && <NavLink to="/organiser" className={link}>Organiser</NavLink>}
          {user?.role === 'ADMIN' && <NavLink to="/admin" className={link}>Admin</NavLink>}
          {user ? (
            <>
              <span className="faint">{user.name}</span>
              <button type="button" className="btn btn-quiet btn-sm" onClick={logout}>Sign out</button>
            </>
          ) : (
            <>
              <NavLink to="/login" className={link}>Sign in</NavLink>
              <NavLink to="/register" className="btn btn-sm">Create account</NavLink>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}

/** Blocks a route until the user is signed in with one of `roles`. */
export function Protected({ roles, children }) {
  const { user, ready } = useAuth();
  const location = useLocation();

  if (!ready) return <div className="page"><p className="skeleton">Checking your session…</p></div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (roles && !roles.includes(user.role)) {
    return (
      <div className="page page-narrow">
        <p className="eyebrow">Wrong account type</p>
        <h1>This area is for {roles.join(' and ').toLowerCase()} accounts</h1>
        <p className="muted">You are signed in as {user.name} ({user.role.toLowerCase()}).</p>
      </div>
    );
  }
  return children;
}

export const Notice = ({ kind = 'error', children }) =>
  children ? <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div> : null;

export const Empty = ({ title, children }) => (
  <div className="empty">
    <h3>{title}</h3>
    {children && <p className="muted" style={{ margin: '6px 0 0' }}>{children}</p>}
  </div>
);

export const Stat = ({ label, value }) => (
  <div className="stat">
    <div className="stat-value">{value}</div>
    <div className="stat-label">{label}</div>
  </div>
);

/** A field wrapper that surfaces server-side per-field validation messages. */
export const Field = ({ label, error, children }) => (
  <div className="field">
    <label>{label}</label>
    {children}
    {error && <div className="field-error">{error}</div>}
  </div>
);

export function Countdown({ expiresAt, onExpire }) {
  const { label, seconds, expired } = useCountdown(expiresAt);
  const fired = useRef(false);

  useEffect(() => {
    if (expired && !fired.current && expiresAt) {
      fired.current = true;
      onExpire?.();
    }
    if (!expired) fired.current = false;
  }, [expired, expiresAt, onExpire]);

  return <span className={`countdown ${seconds <= 60 ? 'countdown-urgent' : ''}`}>{label}</span>;
}

/* -------------------------------------------------------------- realtime */

/**
 * Subscribe to live seat changes for one show.
 *
 * The server pushes every status transition (hold, booking, cancellation,
 * TTL expiry) over a WebSocket. Nothing here guesses at state: the frontend
 * only applies statuses the backend has already committed.
 */
export function useSeatSocket(showId, { onSeats, onOffer } = {}) {
  const [connected, setConnected] = useState(false);
  const handlers = useRef({ onSeats, onOffer });
  handlers.current = { onSeats, onOffer };

  useEffect(() => {
    if (!showId) return undefined;
    const url = `${API_URL.replace(/^http/, 'ws')}/ws?showId=${showId}`;
    let socket;
    let retry;
    let closed = false;

    const connect = () => {
      socket = new WebSocket(url);
      socket.onopen = () => setConnected(true);
      socket.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 2000); // survive a server restart
      };
      socket.onerror = () => socket.close();
      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'seats.updated') handlers.current.onSeats?.(msg.seats, msg.reason);
          if (msg.type === 'waitlist.offer') handlers.current.onOffer?.(msg);
        } catch { /* ignore malformed frames */ }
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, [showId]);

  return connected;
}

/* -------------------------------------------------------------- seat map */

// Kept in step with the seat colours in styles.css.
const LEGEND = [
  { key: 'available', label: 'Available', border: '#3c466b', bg: '#222941' },
  { key: 'selected', label: 'Your selection', border: '#ffd977', bg: '#f0b429' },
  { key: 'held', label: 'Held by someone', border: '#ffae5c', bg: '#f0932b' },
  { key: 'booked', label: 'Booked', border: '#5a6480', bg: '#4b5570' },
  { key: 'offered', label: 'Reserved for waitlist', border: '#b9a1ff', bg: '#9b7bf0' },
];

/**
 * Visual auditorium plan. AVAILABLE seats are selectable; HELD, BOOKED and
 * OFFERED are visibly unavailable and cannot be clicked.
 */
export function SeatMap({ seats, selected = [], mine = [], onToggle, live }) {
  const grouped = useMemo(() => {
    const byCategory = new Map();
    for (const seat of seats) {
      if (!byCategory.has(seat.category)) byCategory.set(seat.category, new Map());
      const rows = byCategory.get(seat.category);
      if (!rows.has(seat.row)) rows.set(seat.row, []);
      rows.get(seat.row).push(seat);
    }
    return [...byCategory.entries()].map(([category, rows]) => ({
      category,
      price: rows.values().next().value?.[0]?.price ?? 0,
      rows: [...rows.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([row, list]) => ({ row, seats: list.sort((a, b) => a.number - b.number) })),
    }));
  }, [seats]);

  const selectedSet = new Set(selected);
  const mineSet = new Set(mine);

  const classFor = (seat) => {
    if (selectedSet.has(seat.id)) return 'seat-selected';
    if (mineSet.has(seat.id)) return 'seat-mine';
    if (seat.status === 'HELD') return 'seat-held';
    if (seat.status === 'BOOKED') return 'seat-booked';
    if (seat.status === 'OFFERED') return 'seat-offered';
    return 'seat-available';
  };

  const labelFor = (seat) => {
    if (mineSet.has(seat.id)) return `Seat ${seat.label}, held by you`;
    if (seat.status === 'AVAILABLE') return `Seat ${seat.label}, ${seat.category}, available`;
    if (seat.status === 'OFFERED') return `Seat ${seat.label}, reserved for a waitlist customer`;
    return `Seat ${seat.label}, ${seat.status.toLowerCase()}`;
  };

  return (
    <div>
      <div className="auditorium">
        <div className="screen"><span>Screen / Stage</span></div>

        {grouped.map(({ category, rows }) => (
          <div key={category}>
            <div className="category-band">{category}</div>
            <div className="seat-rows">
              {rows.map(({ row, seats: rowSeats }) => (
                <div className="seat-row" key={row}>
                  <span className="row-label">{row}</span>
                  {rowSeats.map((seat, i) => (
                    <span key={seat.id} style={{ display: 'contents' }}>
                      {i > 0 && i % 6 === 0 && <span className="seat-gap" aria-hidden="true" />}
                      <button
                        type="button"
                        className={`seat ${classFor(seat)}`}
                        disabled={seat.status !== 'AVAILABLE' && !mineSet.has(seat.id)}
                        onClick={() => seat.status === 'AVAILABLE' && onToggle?.(seat)}
                        aria-pressed={selectedSet.has(seat.id)}
                        aria-label={labelFor(seat)}
                        title={labelFor(seat)}
                      >
                        {seat.number}
                      </button>
                    </span>
                  ))}
                  <span className="row-label">{row}</span>
                </div>
              ))}
            </div>
          </div>
        ))}

        <div className="legend">
          {LEGEND.map((l) => (
            <span className="legend-item" key={l.key}>
              <span className="legend-swatch" style={{ background: l.bg, borderColor: l.border }} />
              {l.label}
            </span>
          ))}
        </div>
      </div>

      <p className="faint" style={{ marginTop: 10 }}>
        <span className={`live-dot ${live ? '' : 'off'}`} />{' '}
        {live ? 'Live — seats update as other people book' : 'Reconnecting to live updates…'}
      </p>
    </div>
  );
}
