import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib.jsx';
import { Empty, Field, Notice, Stat } from '../components.jsx';

export function AdminDashboard() {
  const [venues, setVenues] = useState(null);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ name: '', city: '', address: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    Promise.all([api.get('/api/admin/venues'), api.get('/api/admin/stats')])
        .then(([v, s]) => { setVenues(v.venues); setStats(s); })
        .catch((err) => setError(err.message));
  }, []);

  useEffect(load, [load]);

  const create = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.post('/api/admin/venues', form);
      setForm({ name: '', city: '', address: '' });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
      <div className="page">
        <p className="eyebrow">Admin</p>
        <h1>Venues and seating</h1>

        <Notice>{error}</Notice>

        {stats && (
            <div className="grid grid-3" style={{ margin: '18px 0' }}>
              <Stat label="Customers" value={stats.customers} />
              <Stat label="Organisers" value={stats.organisers} />
              <Stat label="Venues" value={stats.venues} />
              <Stat label="Events" value={stats.events} />
              <Stat label="Shows" value={stats.shows} />
              <Stat label="Confirmed bookings" value={stats.bookings} />
            </div>
        )}

        <div className="split">
          <div>
            <h2>Venues</h2>
            {venues === null ? (
                <p className="skeleton">Loading…</p>
            ) : venues.length === 0 ? (
                <Empty title="No venues yet">Create one, then define its categories and seat layout.</Empty>
            ) : (
                <div className="card" style={{ padding: 0 }}>
                  <table>
                    <thead>
                    <tr><th>Venue</th><th>City</th><th>Categories</th><th>Seats</th><th /></tr>
                    </thead>
                    <tbody>
                    {venues.map((v) => (
                        <tr key={v.id}>
                          <td>{v.name}</td>
                          <td>{v.city}</td>
                          <td>{v.category_count}</td>
                          <td>
                            {v.seat_count > 0
                                ? v.seat_count
                                : <span className="tag tag-warn">No layout</span>}
                          </td>
                          <td className="right"><Link to={`/admin/venues/${v.id}`}>Manage</Link></td>
                        </tr>
                    ))}
                    </tbody>
                  </table>
                </div>
            )}
          </div>

          <aside className="sticky-side">
            <form className="card" onSubmit={create}>
              <p className="eyebrow">New venue</p>
              <Field label="Name"><input value={form.name} required onChange={set('name')} /></Field>
              <Field label="City"><input value={form.city} required onChange={set('city')} /></Field>
              <Field label="Address"><input value={form.address} onChange={set('address')} /></Field>
              <button className="btn btn-block" disabled={busy}>{busy ? 'Creating…' : 'Create venue'}</button>
            </form>
          </aside>
        </div>
      </div>
  );
}

/* ------------------------------------------------ venue / layout editor */

export function AdminVenue() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [catName, setCatName] = useState('');
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get(`/api/admin/venues/${id}`)
        .then((d) => {
          setData(d);
          // Rebuild the row editor from the seats that already exist.
          const grouped = new Map();
          for (const s of d.seats) {
            if (!grouped.has(s.row_label)) grouped.set(s.row_label, { rowLabel: s.row_label, seats: 0, categoryId: s.category_id });
            grouped.get(s.row_label).seats += 1;
          }
          setRows(grouped.size ? [...grouped.values()] : []);
        })
        .catch((err) => setError(err.message));
  }, [id]);

  useEffect(load, [load]);

  const addCategory = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.post(`/api/admin/venues/${id}/categories`, {
        name: catName,
        rank: data.categories.length,
      });
      setCatName('');
      setNotice('Category added.');
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteCategory = async (categoryId) => {
    setError('');
    try {
      await api.del(`/api/admin/categories/${categoryId}`);
      setNotice('Category removed.');
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const saveLayout = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.put(`/api/admin/venues/${id}/layout`, {
        rows: rows.map((r) => ({
          rowLabel: r.rowLabel,
          seats: Number(r.seats),
          categoryId: Number(r.categoryId),
        })),
      });
      setNotice('Seat layout saved.');
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const updateRow = (i, key, value) =>
      setRows(rows.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));

  const addRow = () => {
    const nextLabel = String.fromCharCode(65 + rows.length);
    setRows([...rows, { rowLabel: nextLabel, seats: 10, categoryId: data.categories[0]?.id }]);
  };

  if (error && !data) return <div className="page page-narrow"><Notice>{error}</Notice></div>;
  if (!data) return <div className="page"><p className="skeleton">Loading…</p></div>;

  const totalSeats = rows.reduce((n, r) => n + Number(r.seats || 0), 0);

  return (
      <div className="page">
        <p className="eyebrow"><Link to="/admin">Admin</Link> · {data.venue.city}</p>
        <h1>{data.venue.name}</h1>
        <p className="muted">{data.venue.address}</p>

        {notice && <div className="notice notice-ok" style={{ margin: '12px 0' }}>{notice}</div>}
        <Notice>{error}</Notice>

        <div className="split" style={{ marginTop: 18 }}>
          <div className="stack">
            <form className="card" onSubmit={saveLayout}>
              <div className="spread">
                <p className="eyebrow" style={{ margin: 0 }}>Seat layout</p>
                <span className="faint">{totalSeats} seats</span>
              </div>
              <p className="muted" style={{ marginTop: 6 }}>
                Each row generates individually numbered seats, from 1 to the count you set.
              </p>

              {data.categories.length === 0 ? (
                  <p className="notice notice-info">Add at least one seat category before defining rows.</p>
              ) : (
                  <>
                    {rows.map((r, i) => (
                        <div className="layout-row" key={i}>
                          <Field label="Row">
                            <input value={r.rowLabel} maxLength={3}
                                   onChange={(e) => updateRow(i, 'rowLabel', e.target.value.toUpperCase())} />
                          </Field>
                          <Field label="Seats">
                            <input type="number" min="1" max="60" value={r.seats}
                                   onChange={(e) => updateRow(i, 'seats', e.target.value)} />
                          </Field>
                          <Field label="Category">
                            <select value={r.categoryId} onChange={(e) => updateRow(i, 'categoryId', e.target.value)}>
                              {data.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </select>
                          </Field>
                          <Field label="&nbsp;">
                            <button type="button" className="btn btn-quiet btn-sm"
                                    onClick={() => setRows(rows.filter((_, idx) => idx !== i))}>×</button>
                          </Field>
                        </div>
                    ))}

                    <div className="row">
                      <button type="button" className="btn btn-quiet btn-sm" onClick={addRow}>Add a row</button>
                      <button className="btn btn-sm" disabled={busy || rows.length === 0}>
                        {busy ? 'Saving…' : 'Save layout'}
                      </button>
                    </div>
                    <p className="faint" style={{ marginTop: 10, marginBottom: 0 }}>
                      Saving replaces the whole layout. Once a show is selling these seats the layout is locked.
                    </p>
                  </>
              )}
            </form>

            {data.seats.length > 0 && (
                <div className="card">
                  <p className="eyebrow">Current seats</p>
                  <table>
                    <thead><tr><th>Row</th><th>Category</th><th>Seats</th></tr></thead>
                    <tbody>
                    {[...new Set(data.seats.map((s) => s.row_label))].map((row) => {
                      const inRow = data.seats.filter((s) => s.row_label === row);
                      return (
                          <tr key={row}>
                            <td className="mono">{row}</td>
                            <td>{inRow[0].category}</td>
                            <td>{inRow.length} <span className="faint">({row}1–{row}{inRow.length})</span></td>
                          </tr>
                      );
                    })}
                    </tbody>
                  </table>
                </div>
            )}
          </div>

          <aside className="sticky-side">
            <form className="card" onSubmit={addCategory}>
              <p className="eyebrow">Seat categories</p>
              {data.categories.length === 0 ? (
                  <p className="muted">None yet. Premium and Standard are a good start.</p>
              ) : (
                  <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: '0 0 12px' }}>
                    {data.categories.map((c) => (
                        <li key={c.id} className="spread">
                          <span>{c.name}</span>
                          <button type="button" className="btn btn-quiet btn-sm" onClick={() => deleteCategory(c.id)}>
                            Remove
                          </button>
                        </li>
                    ))}
                  </ul>
              )}
              <Field label="Add a category">
                <input value={catName} onChange={(e) => setCatName(e.target.value)} placeholder="Premium" required />
              </Field>
              <button className="btn btn-block btn-sm">Add category</button>
            </form>
          </aside>
        </div>
      </div>
  );
}