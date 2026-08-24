import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, dateTime, money } from '../lib.jsx';
import { Empty, Field, Notice, Stat } from '../components.jsx';

/* --------------------------------------------------- organiser dashboard */

export function OrganiserDashboard() {
  const [events, setEvents] = useState(null);
  const [revenue, setRevenue] = useState(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ title: '', type: 'MOVIE', description: '', language: '', durationMin: '' });
  const [details, setDetails] = useState({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    Promise.all([api.get('/api/organiser/events'), api.get('/api/organiser/revenue')])
        .then(([e, r]) => { setEvents(e.events); setRevenue(r); })
        .catch((err) => setError(err.message));
  }, []);

  useEffect(load, [load]);

  const create = async (e) => {
    e.preventDefault();
    setError('');
    setDetails({});
    setBusy(true);
    try {
      await api.post('/api/organiser/events', {
        title: form.title,
        type: form.type,
        description: form.description || undefined,
        language: form.language || undefined,
        durationMin: form.durationMin ? Number(form.durationMin) : undefined,
      });
      setForm({ title: '', type: 'MOVIE', description: '', language: '', durationMin: '' });
      load();
    } catch (err) {
      setError(err.message);
      setDetails(err.details || {});
    } finally {
      setBusy(false);
    }
  };

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
      <div className="page">
        <p className="eyebrow">Organiser</p>
        <h1>Your events</h1>

        <Notice>{error}</Notice>

        {revenue && (
            <div className="grid grid-3" style={{ margin: '18px 0' }}>
              <Stat label="Events" value={revenue.events.length} />
              <Stat label="Confirmed bookings" value={revenue.events.reduce((n, e) => n + e.bookings, 0)} />
              <Stat label="Total revenue" value={money(revenue.total)} />
            </div>
        )}

        <div className="split">
          <div>
            <h2>Listings</h2>
            {events === null ? (
                <p className="skeleton">Loading…</p>
            ) : events.length === 0 ? (
                <Empty title="No events yet">Create your first listing on the right.</Empty>
            ) : (
                <div className="card" style={{ padding: 0 }}>
                  <table>
                    <thead>
                    <tr><th>Title</th><th>Type</th><th>Shows</th><th className="right">Revenue</th><th /></tr>
                    </thead>
                    <tbody>
                    {events.map((e) => {
                      const rev = revenue?.events.find((r) => r.event_id === e.id);
                      return (
                          <tr key={e.id}>
                            <td>{e.title}</td>
                            <td><span className="tag">{e.type}</span></td>
                            <td>{e.show_count}</td>
                            <td className="right mono">{money(rev?.revenue || 0)}</td>
                            <td className="right"><Link to={`/organiser/events/${e.id}`}>Manage</Link></td>
                          </tr>
                      );
                    })}
                    </tbody>
                  </table>
                </div>
            )}
          </div>

          <aside className="sticky-side">
            <form className="card" onSubmit={create}>
              <p className="eyebrow">New listing</p>
              <Field label="Title" error={details.title}>
                <input value={form.title} required onChange={set('title')} />
              </Field>
              <Field label="Type">
                <select value={form.type} onChange={set('type')}>
                  <option value="MOVIE">Movie</option>
                  <option value="CONCERT">Concert</option>
                </select>
              </Field>
              <Field label="Description" error={details.description}>
                <textarea rows={3} value={form.description} onChange={set('description')} />
              </Field>
              <Field label="Language">
                <input value={form.language} onChange={set('language')} placeholder="Hindi, English…" />
              </Field>
              <Field label="Duration (minutes)" error={details.durationMin}>
                <input type="number" min="1" value={form.durationMin} onChange={set('durationMin')} />
              </Field>
              <button className="btn btn-block" disabled={busy}>{busy ? 'Creating…' : 'Create event'}</button>
            </form>
          </aside>
        </div>
      </div>
  );
}

/* ------------------------------------------------- event management page */

export function OrganiserEvent() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [summary, setSummary] = useState(null);
  const [venues, setVenues] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    Promise.all([
      api.get(`/api/organiser/events/${id}`),
      api.get(`/api/organiser/events/${id}/summary`),
    ])
        .then(([e, s]) => { setData(e); setSummary(s); })
        .catch((err) => setError(err.message));
  }, [id]);

  useEffect(load, [load]);

  // The public event endpoint exposes venues indirectly; organisers pick from
  // the venues that already have a seat layout.
  useEffect(() => {
    api.get('/api/events/meta/venues')
        .then((d) => setVenues(d.venues))
        .catch(() => setVenues([]));
  }, []);

  if (error && !data) return <div className="page page-narrow"><Notice>{error}</Notice></div>;
  if (!data) return <div className="page"><p className="skeleton">Loading…</p></div>;

  return (
      <div className="page">
        <p className="eyebrow">
          <Link to="/organiser">Organiser</Link> · {data.event.type}
        </p>
        <h1>{data.event.title}</h1>

        {notice && <div className="notice notice-ok" style={{ margin: '12px 0' }}>{notice}</div>}
        <Notice>{error}</Notice>

        {summary && (
            <div className="grid grid-3" style={{ margin: '18px 0' }}>
              <Stat label="Seats sold" value={`${summary.totals.seatsBooked} / ${summary.totals.seatsTotal}`} />
              <Stat label="Occupancy" value={`${Math.round(summary.totals.occupancy * 100)}%`} />
              <Stat label="Revenue" value={money(summary.totals.revenue)} />
            </div>
        )}

        <div className="split">
          <div className="stack">
            <EditEvent event={data.event} onSaved={(msg) => { setNotice(msg); load(); }} onError={setError} />
            <ShowList shows={data.shows} summary={summary} onChanged={load} onError={setError}
                      onNotice={setNotice} />
            {summary && summary.byCategory.length > 0 && (
                <div className="card">
                  <p className="eyebrow">Sales by category</p>
                  <table>
                    <thead><tr><th>Category</th><th>Seats sold</th><th className="right">Revenue</th></tr></thead>
                    <tbody>
                    {summary.byCategory.map((c) => (
                        <tr key={c.category}>
                          <td>{c.category}</td>
                          <td>{c.seats_sold}</td>
                          <td className="right mono">{money(c.revenue)}</td>
                        </tr>
                    ))}
                    </tbody>
                  </table>
                </div>
            )}
          </div>

          <aside className="sticky-side">
            <ScheduleShow eventId={id} venues={venues} onCreated={(msg) => { setNotice(msg); load(); }}
                          onError={setError} />
          </aside>
        </div>
      </div>
  );
}

function EditEvent({ event, onSaved, onError }) {
  const [form, setForm] = useState({
    title: event.title,
    description: event.description || '',
    language: event.language || '',
    durationMin: event.duration_min || '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.patch(`/api/organiser/events/${event.id}`, {
        title: form.title,
        description: form.description,
        language: form.language,
        durationMin: form.durationMin ? Number(form.durationMin) : undefined,
      });
      onSaved('Event details saved.');
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
      <form className="card" onSubmit={save}>
        <p className="eyebrow">Event details</p>
        <Field label="Title"><input value={form.title} onChange={set('title')} required /></Field>
        <Field label="Description"><textarea rows={3} value={form.description} onChange={set('description')} /></Field>
        <div className="grid grid-2">
          <Field label="Language"><input value={form.language} onChange={set('language')} /></Field>
          <Field label="Duration (minutes)">
            <input type="number" min="1" value={form.durationMin} onChange={set('durationMin')} />
          </Field>
        </div>
        <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
      </form>
  );
}

function ShowList({ shows, summary, onChanged, onError, onNotice }) {
  const remove = async (showId) => {
    try {
      await api.del(`/api/organiser/shows/${showId}`);
      onNotice('Show removed.');
      onChanged();
    } catch (err) {
      onError(err.message);
    }
  };

  return (
      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '18px 18px 0' }}><p className="eyebrow">Shows</p></div>
        {shows.length === 0 ? (
            <p className="muted" style={{ padding: '0 18px 18px' }}>
              No shows scheduled. Add one to start selling seats.
            </p>
        ) : (
            <table>
              <thead>
              <tr><th>When</th><th>Venue</th><th>Sold</th><th>Held</th><th>Waiting</th>
                <th className="right">Revenue</th><th /></tr>
              </thead>
              <tbody>
              {shows.map((s) => {
                const stat = summary?.shows.find((x) => x.id === s.id);
                return (
                    <tr key={s.id}>
                      <td>{dateTime(s.starts_at)}</td>
                      <td>{s.venue_name}<div className="faint">{s.city}</div></td>
                      <td>{s.seats_booked} / {s.seats_total}</td>
                      <td>{stat?.seats_held ?? 0}</td>
                      <td>{stat?.waitlist ?? 0}</td>
                      <td className="right mono">{money(stat?.revenue || 0)}</td>
                      <td className="right">
                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                          <Link to={`/shows/${s.id}`}>Seat map</Link>
                          <button type="button" className="btn btn-quiet btn-sm" onClick={() => remove(s.id)}>
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                );
              })}
              </tbody>
            </table>
        )}
      </div>
  );
}

function ScheduleShow({ eventId, venues, onCreated, onError }) {
  const [venueId, setVenueId] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [prices, setPrices] = useState({});
  const [busy, setBusy] = useState(false);

  const venue = venues.find((v) => String(v.id) === String(venueId));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post(`/api/organiser/events/${eventId}/shows`, {
        venueId: Number(venueId),
        startsAt: new Date(startsAt).toISOString(),
        prices: (venue?.categories || []).map((c) => ({
          categoryId: c.id,
          price: Number(prices[c.id] ?? 0),
        })),
      });
      setStartsAt('');
      setPrices({});
      onCreated('Show scheduled and seats opened for sale.');
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
      <form className="card" onSubmit={submit}>
        <p className="eyebrow">Schedule a show</p>
        <Field label="Venue">
          <select value={venueId} onChange={(e) => { setVenueId(e.target.value); setPrices({}); }} required>
            <option value="">Choose a venue…</option>
            {venues.map((v) => (
                <option key={v.id} value={v.id}>{v.name} — {v.city} ({v.seat_count} seats)</option>
            ))}
          </select>
        </Field>
        <Field label="Date and time">
          <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required />
        </Field>

        {venue && (
            <>
              <p className="eyebrow" style={{ marginTop: 14 }}>Pricing per category</p>
              {venue.categories.map((c) => (
                  <Field key={c.id} label={c.name}>
                    <input type="number" min="0" step="1" required
                           value={prices[c.id] ?? ''}
                           onChange={(e) => setPrices({ ...prices, [c.id]: e.target.value })} />
                  </Field>
              ))}
            </>
        )}

        <button className="btn btn-block" disabled={busy || !venueId}>
          {busy ? 'Scheduling…' : 'Schedule show'}
        </button>
        {venues.length === 0 && (
            <p className="faint" style={{ marginBottom: 0 }}>
              No venues with a seat layout yet — an admin needs to create one first.
            </p>
        )}
      </form>
  );
}