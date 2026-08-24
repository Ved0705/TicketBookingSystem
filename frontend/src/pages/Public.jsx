import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, dateTime, money } from '../lib.jsx';
import { Empty, Notice } from '../components.jsx';

export function Home() {
  const [events, setEvents] = useState(null);

  useEffect(() => {
    api.get('/api/events').then((d) => setEvents(d.events)).catch(() => setEvents([]));
  }, []);

  const upcoming = events || [];
  const cities = [...new Set(upcoming.flatMap((e) => e.cities || []))];
  const shows = upcoming.reduce((n, e) => n + (e.showCount || 0), 0);

  return (
    <div className="page">
      <section className="hero">
        <div className="hero-inner">
          <p className="eyebrow">Now selling</p>
          <h1>Pick your seat,<br />not just your ticket.</h1>
          <p className="lead">
            Choose from a live seating plan and the seat is held for you for ten minutes —
            long enough to check out, short enough that nobody is blocked by an abandoned
            basket. Sold out? Join the queue and we will email you the moment a seat frees up.
          </p>
          <div className="row">
            <Link className="btn" to="/events">Browse what&rsquo;s on</Link>
            <Link className="btn btn-quiet" to="/register">Create an account</Link>
          </div>
        </div>

        <div className="hero-figures">
          <div className="hero-figure">
            <div className="n">{upcoming.length}</div>
            <div className="t">Events on sale</div>
          </div>
          <div className="hero-figure">
            <div className="n">{shows}</div>
            <div className="t">Showtimes</div>
          </div>
          <div className="hero-figure">
            <div className="n">{cities.length}</div>
            <div className="t">{cities.length === 1 ? 'City' : 'Cities'}</div>
          </div>
          <div className="hero-figure">
            <div className="n">10 min</div>
            <div className="t">Seat hold window</div>
          </div>
        </div>
      </section>

      <div className="section-head">
        <h2>Coming up</h2>
        <Link to="/events">See all events &rarr;</Link>
      </div>

      {events === null ? (
        <p className="skeleton">Loading events…</p>
      ) : events.length === 0 ? (
        <Empty title="Nothing scheduled yet">An organiser needs to publish a show first.</Empty>
      ) : (
        <div className="grid grid-3">
          {events.slice(0, 6).map((e) => <EventCard key={e.id} event={e} />)}
        </div>
      )}
    </div>
  );
}

function EventCard({ event }) {
  return (
    <Link className="event-card" to={`/events/${event.id}`}>
      <span className={`tag ${event.type === 'CONCERT' ? 'tag-warn' : ''}`}>{event.type}</span>
      <h3>{event.title}</h3>
      <p className="faint" style={{ margin: 0 }}>
        {event.nextShow ? dateTime(event.nextShow) : 'No upcoming shows'}
        {event.cities?.length ? ` · ${event.cities.join(', ')}` : ''}
      </p>
      {event.description && (
        <p className="muted" style={{ margin: 0, fontSize: 13.5, display: '-webkit-box',
          WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {event.description}
        </p>
      )}
      <div className="spread" style={{ marginTop: 'auto', paddingTop: 8 }}>
        <span className="price">from {money(event.fromPrice)}</span>
        <span className="faint">{event.showCount} show{event.showCount === 1 ? '' : 's'}</span>
      </div>
    </Link>
  );
}

export function EventList() {
  const [params, setParams] = useSearchParams();
  const [events, setEvents] = useState(null);
  const [cities, setCities] = useState([]);
  const [error, setError] = useState('');

  const q = params.get('q') || '';
  const type = params.get('type') || '';
  const city = params.get('city') || '';
  const from = params.get('from') || '';

  useEffect(() => {
    api.get('/api/events/meta/cities').then((d) => setCities(d.cities)).catch(() => {});
  }, []);

  useEffect(() => {
    setEvents(null);
    const query = new URLSearchParams();
    if (q) query.set('q', q);
    if (type) query.set('type', type);
    if (city) query.set('city', city);
    if (from) query.set('from', new Date(from).toISOString());
    api
      .get(`/api/events?${query.toString()}`)
      .then((d) => setEvents(d.events))
      .catch((err) => { setError(err.message); setEvents([]); });
  }, [q, type, city, from]);

  const update = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">What&rsquo;s on</p>
          <h1>Movies and concerts</h1>
        </div>
        {(q || type || city || from) && (
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => setParams({}, { replace: true })}>
            Clear filters
          </button>
        )}
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="filters">
          <div>
            <label htmlFor="f-q">Search</label>
            <input id="f-q" value={q} placeholder="Title or description"
              onChange={(e) => update('q', e.target.value)} />
          </div>
          <div>
            <label htmlFor="f-type">Type</label>
            <select id="f-type" value={type} onChange={(e) => update('type', e.target.value)}>
              <option value="">All</option>
              <option value="MOVIE">Movies</option>
              <option value="CONCERT">Concerts</option>
            </select>
          </div>
          <div>
            <label htmlFor="f-city">City</label>
            <select id="f-city" value={city} onChange={(e) => update('city', e.target.value)}>
              <option value="">Anywhere</option>
              {cities.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="f-from">On or after</label>
            <input id="f-from" type="date" value={from} onChange={(e) => update('from', e.target.value)} />
          </div>
        </div>
      </div>

      <Notice>{error}</Notice>

      {events === null ? (
        <p className="skeleton">Loading events…</p>
      ) : events.length === 0 ? (
        <Empty title="No events match those filters">Try widening the search or clearing a filter.</Empty>
      ) : (
        <div className="grid grid-3">
          {events.map((e) => <EventCard key={e.id} event={e} />)}
        </div>
      )}
    </div>
  );
}

export function EventDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/api/events/${id}`).then(setData).catch((err) => setError(err.message));
  }, [id]);

  if (error) return <div className="page page-narrow"><Notice>{error}</Notice></div>;
  if (!data) return <div className="page"><p className="skeleton">Loading…</p></div>;

  const { event, shows } = data;

  return (
    <div className="page">
      <p className="eyebrow">{event.type} · {event.language || 'Unspecified language'}</p>
      <h1>{event.title}</h1>
      <p className="muted" style={{ maxWidth: 620 }}>{event.description}</p>
      <p className="faint">
        {event.durationMin ? `${event.durationMin} minutes` : ''} · Presented by {event.organiser}
      </p>

      <h2 style={{ marginTop: 28 }}>Showtimes</h2>
      {shows.length === 0 ? (
        <Empty title="No scheduled shows">Check back soon.</Empty>
      ) : (
        <div className="grid grid-2">
          {shows.map((s) => (
            <div className="card" key={s.id}>
              <div className="spread">
                <div>
                  <h3>{dateTime(s.startsAt)}</h3>
                  <p className="faint" style={{ margin: 0 }}>{s.venue.name} · {s.venue.city}</p>
                </div>
                {s.soldOut
                  ? <span className="tag tag-stop">Sold out</span>
                  : <span className="tag tag-go">{s.seatsAvailable} free</span>}
              </div>
              <div className="spread" style={{ marginTop: 14 }}>
                <span className="muted">from {money(s.fromPrice)}</span>
                <button type="button" className="btn btn-sm" onClick={() => navigate(`/shows/${s.id}`)}>
                  {s.soldOut ? 'View seat map' : 'Choose seats'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
