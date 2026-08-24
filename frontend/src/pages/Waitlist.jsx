import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, dateTime } from '../lib.jsx';
import { Countdown, Empty, Notice } from '../components.jsx';

const STATUS_TAG = {
  WAITING: 'tag',
  OFFERED: 'tag tag-warn',
  FULFILLED: 'tag tag-go',
  EXPIRED: 'tag tag-stop',
  CANCELLED: 'tag tag-stop',
};

/**
 * Waitlist status.
 *
 * Offers are time limited and enforced by the backend, so this page polls
 * every few seconds: an offer can lapse while the page is open, and the
 * seat then moves to whoever is next in the queue.
 */
export default function Waitlist() {
  const navigate = useNavigate();
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(
      () => api.get('/api/waitlist').then((d) => setEntries(d.entries)).catch((err) => setError(err.message)),
      []
  );

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  const accept = async (offerId) => {
    setError('');
    setNotice('');
    try {
      const res = await api.post(`/api/waitlist/offers/${offerId}/accept`);
      navigate(`/checkout/${res.holdId}`);
    } catch (err) {
      setError(err.message);
      load();
    }
  };

  const decline = async (offerId) => {
    setError('');
    try {
      await api.post(`/api/waitlist/offers/${offerId}/decline`);
      setNotice('Offer declined. The seat has gone to the next person in the queue.');
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const leave = async (waitlistId) => {
    setError('');
    try {
      await api.del(`/api/waitlist/${waitlistId}`);
      setNotice('You have left that waitlist.');
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
      <div className="page">
        <div className="page-head">
          <div>
            <p className="eyebrow">Sold-out shows</p>
            <h1>Your waitlists</h1>
          </div>
          <Link className="btn btn-quiet btn-sm" to="/events">Browse events</Link>
        </div>

        {notice && <div className="notice notice-ok" style={{ marginBottom: 14 }}>{notice}</div>}
        <Notice>{error}</Notice>

        {entries === null ? (
            <p className="skeleton">Loading…</p>
        ) : entries.length === 0 ? (
            <Empty title="You are not on any waitlist">
              When a seat category is sold out, you can join its queue from the seat map.
            </Empty>
        ) : (
            <div className="grid grid-2">
              {entries.map((e) => (
                  <div className="card" key={e.waitlistId}>
                    <div className="spread">
                      <div>
                        <h3 style={{ marginBottom: 2 }}>{e.show.eventTitle}</h3>
                        <p className="faint" style={{ margin: 0 }}>
                          {dateTime(e.show.startsAt)} · {e.show.venue.name}
                        </p>
                      </div>
                      <span className={STATUS_TAG[e.status] || 'tag'}>{e.status}</span>
                    </div>

                    <p className="muted" style={{ margin: '10px 0 0' }}>{e.category}</p>

                    {e.status === 'WAITING' && (
                        <div className="row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
                          <div>
                            <span className="queue-position">#{e.position}</span>
                            <p className="faint" style={{ margin: '4px 0 0' }}>
                              {e.peopleAhead === 0
                                  ? 'You are next in line'
                                  : `${e.peopleAhead} ${e.peopleAhead === 1 ? 'person' : 'people'} ahead of you`}
                            </p>
                          </div>
                          <button type="button" className="btn btn-quiet btn-sm" style={{ marginLeft: 'auto' }}
                                  onClick={() => leave(e.waitlistId)}>
                            Leave queue
                          </button>
                        </div>
                    )}

                    {e.offer && (
                        <div className="notice notice-info" style={{ marginTop: 12 }}>
                          <div className="spread">
                    <span>
                      Seat <span className="mono">{e.offer.seatLabel}</span> is reserved for you.
                    </span>
                            <Countdown expiresAt={e.offer.expiresAt} onExpire={load} />
                          </div>
                          <div className="row" style={{ marginTop: 10 }}>
                            <button type="button" className="btn btn-sm" onClick={() => accept(e.offer.id)}>
                              Accept and check out
                            </button>
                            <button type="button" className="btn btn-quiet btn-sm" onClick={() => decline(e.offer.id)}>
                              No thanks
                            </button>
                          </div>
                        </div>
                    )}

                    {e.status === 'EXPIRED' && (
                        <p className="faint" style={{ marginTop: 10, marginBottom: 0 }}>
                          Your offer ran out of time and the seat moved on to the next person.
                          You can join the queue again from the seat map.
                        </p>
                    )}
                    {e.status === 'FULFILLED' && (
                        <p className="faint" style={{ marginTop: 10, marginBottom: 0 }}>
                          You took this seat — it is in <Link to="/bookings">your bookings</Link>.
                        </p>
                    )}
                  </div>
              ))}
            </div>
        )}
      </div>
  );
}