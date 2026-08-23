import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, dateTime, money, useAuth } from '../lib.jsx';
import { Countdown, Notice, SeatMap, useSeatSocket } from '../components.jsx';

/**
 * Seat selection.
 *
 * The seat map is refreshed from two sources: a full fetch on mount, and
 * incremental WebSocket frames afterwards. The backend remains the only
 * authority — a click sends a hold request and the UI waits for the answer
 * rather than optimistically colouring the seat.
 */
export default function ShowSeats() {
  const { showId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [map, setMap] = useState(null);
  const [selected, setSelected] = useState([]);
  const [hold, setHold] = useState(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const data = await api.get(`/api/events/shows/${showId}/seatmap`);
    setMap(data);
    setHold(data.myHold);
    return data;
  }, [showId]);

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, [load]);

  // Apply pushed status changes in place so scroll position is preserved.
  const applySeatUpdates = useCallback((updates) => {
    setMap((current) => {
      if (!current) return current;
      const byId = new Map(updates.map((u) => [u.id, u.status]));
      return {
        ...current,
        seats: current.seats.map((s) => (byId.has(s.id) ? { ...s, status: byId.get(s.id) } : s)),
        categories: current.categories.map((c) => {
          const seats = current.seats.map((s) => (byId.has(s.id) ? { ...s, status: byId.get(s.id) } : s));
          const mine = seats.filter((s) => s.categoryId === c.id);
          const available = mine.filter((s) => s.status === 'AVAILABLE').length;
          return { ...c, available, soldOut: available === 0 };
        }),
      };
    });
    // Drop any selection that someone else has just taken.
    setSelected((prev) => prev.filter((id) => {
      const changed = updates.find((u) => u.id === id);
      return !changed || changed.status === 'AVAILABLE';
    }));
  }, []);

  const live = useSeatSocket(Number(showId), { onSeats: applySeatUpdates });

  const toggle = (seat) => {
    setError('');
    setSelected((prev) =>
      prev.includes(seat.id) ? prev.filter((id) => id !== seat.id) : [...prev, seat.id]
    );
  };

  const selectedSeats = useMemo(
    () => (map ? map.seats.filter((s) => selected.includes(s.id)) : []),
    [map, selected]
  );
  const total = selectedSeats.reduce((sum, s) => sum + s.price, 0);

  const placeHold = async () => {
    setError('');
    setBusy(true);
    try {
      const result = await api.post('/api/holds', { showId: Number(showId), seatIds: selected });
      setHold({ holdId: result.holdId, expiresAt: result.expiresAt, seatIds: result.seats.map((s) => s.id) });
      setSelected([]);
      navigate(`/checkout/${result.holdId}`);
    } catch (err) {
      setError(err.message);
      await load(); // resync: the map we were looking at is out of date
    } finally {
      setBusy(false);
    }
  };

  const joinWaitlist = async (categoryId) => {
    setError('');
    setInfo('');
    try {
      const res = await api.post('/api/waitlist', { showId: Number(showId), categoryId });
      setInfo(`You are number ${res.position} in the queue for ${res.category}. We will email you if a seat opens up.`);
    } catch (err) {
      setError(err.message);
    }
  };

  if (error && !map) return <div className="page page-narrow"><Notice>{error}</Notice></div>;
  if (!map) return <div className="page"><p className="skeleton">Loading seat map…</p></div>;

  const isCustomer = user?.role === 'CUSTOMER';

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">{dateTime(map.show.startsAt)} · {map.show.venue.name}, {map.show.venue.city}</p>
          <h1>{map.show.eventTitle}</h1>
        </div>
      </div>

      <div className="split">
        <div>
          <SeatMap
            seats={map.seats}
            selected={selected}
            mine={hold?.seatIds || []}
            onToggle={toggle}
            live={live}
          />
        </div>

        <aside className="sticky-side stack">
          {hold && (
            <div className="card">
              <p className="eyebrow">Seats held for you</p>
              <Countdown expiresAt={hold.expiresAt} onExpire={() => { setHold(null); load(); }} />
              <p className="faint" style={{ margin: '6px 0 10px' }}>
                {hold.seatIds.length} seat{hold.seatIds.length === 1 ? '' : 's'} reserved until checkout.
              </p>
              <button type="button" className="btn btn-block" onClick={() => navigate(`/checkout/${hold.holdId}`)}>
                Go to checkout
              </button>
            </div>
          )}

          <div className="card">
            <p className="eyebrow">Your selection</p>
            {selectedSeats.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                Pick any available seat from the plan to get started.
              </p>
            ) : (
              <>
                <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: '0 0 12px' }}>
                  {selectedSeats.map((s) => (
                    <li key={s.id} className="spread">
                      <span><span className="mono">{s.label}</span> <span className="faint">{s.category}</span></span>
                      <span className="mono">{money(s.price)}</span>
                    </li>
                  ))}
                </ul>
                <div className="spread" style={{ borderTop: '1px solid var(--rule)', paddingTop: 10 }}>
                  <strong>Total</strong>
                  <strong className="mono">{money(total)}</strong>
                </div>
              </>
            )}

            <Notice>{error}</Notice>

            {isCustomer ? (
              <button
                type="button"
                className="btn btn-block"
                style={{ marginTop: 12 }}
                disabled={selected.length === 0 || busy}
                onClick={placeHold}
              >
                {busy ? 'Holding…' : `Hold ${selected.length || ''} seat${selected.length === 1 ? '' : 's'}`.trim()}
              </button>
            ) : (
              <p className="faint" style={{ marginTop: 12, marginBottom: 0 }}>
                {user ? 'Only customer accounts can book seats.' : 'Sign in as a customer to hold seats.'}
              </p>
            )}
            <p className="faint" style={{ marginTop: 8, marginBottom: 0 }}>
              Held seats are yours for {Math.round(map.holdTtlSeconds / 60)} minutes.
            </p>
          </div>

          <div className="card">
            <p className="eyebrow">Availability</p>
            {info && <div className="notice notice-ok" style={{ marginBottom: 10 }}>{info}</div>}
            <div className="stack">
              {map.categories.map((c) => (
                <div key={c.id} className="spread">
                  <span>
                    {c.name} <span className="faint">{money(c.price)}</span>
                  </span>
                  {c.soldOut ? (
                    isCustomer ? (
                      <button type="button" className="btn btn-quiet btn-sm" onClick={() => joinWaitlist(c.id)}>
                        Join waitlist
                      </button>
                    ) : <span className="tag tag-stop">Sold out</span>
                  ) : (
                    <span className="faint">{c.available} of {c.total} free</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
