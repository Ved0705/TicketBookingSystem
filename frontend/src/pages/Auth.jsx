import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib.jsx';
import { Field, Notice } from '../components.jsx';

const landingFor = (role) =>
  role === 'ADMIN' ? '/admin' : role === 'ORGANISER' ? '/organiser' : '/dashboard';

/** Role gates, mirroring the route guards in App.jsx. */
const GATES = [
  { prefix: '/admin', role: 'ADMIN' },
  { prefix: '/organiser', role: 'ORGANISER' },
  { prefix: '/dashboard', role: 'CUSTOMER' },
  { prefix: '/bookings', role: 'CUSTOMER' },
  { prefix: '/waitlist', role: 'CUSTOMER' },
  { prefix: '/checkout', role: 'CUSTOMER' },
];

/**
 * Where to go after signing in. Returning someone to the page that bounced
 * them is only helpful if their role can actually open it — otherwise they
 * land on a "wrong account type" screen, which is a dead end.
 */
function destinationAfterLogin(from, role) {
  if (!from) return landingFor(role);
  const gate = GATES.find((g) => from.startsWith(g.prefix));
  if (gate && gate.role !== role) return landingFor(role);
  return from;
}

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const user = await login(email, password);
      navigate(destinationAfterLogin(location.state?.from, user.role), { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page page-narrow">
      <p className="eyebrow">Welcome back</p>
      <h1>Sign in</h1>

      <form className="card" onSubmit={submit} style={{ marginTop: 16 }}>
        <Notice>{error}</Notice>
        <Field label="Email">
          <input type="email" value={email} required autoComplete="email"
            onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password">
          <input type="password" value={password} required autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <button className="btn btn-block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>

      <p className="muted" style={{ marginTop: 14 }}>
        No account yet? <Link to="/register">Create one</Link>.
      </p>
    </div>
  );
}

export function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'CUSTOMER' });
  const [error, setError] = useState('');
  const [details, setDetails] = useState({});
  const [busy, setBusy] = useState(false);

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setDetails({});
    setBusy(true);
    try {
      const user = await register(form);
      navigate(landingFor(user.role), { replace: true });
    } catch (err) {
      setError(err.message);
      setDetails(err.details || {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page page-narrow">
      <p className="eyebrow">Join</p>
      <h1>Create your account</h1>

      <form className="card" onSubmit={submit} style={{ marginTop: 16 }}>
        <Notice>{error}</Notice>
        <Field label="Name" error={details.name}>
          <input value={form.name} required onChange={set('name')} autoComplete="name" />
        </Field>
        <Field label="Email" error={details.email}>
          <input type="email" value={form.email} required onChange={set('email')} autoComplete="email" />
        </Field>
        <Field label="Password" error={details.password}>
          <input type="password" value={form.password} required minLength={8}
            onChange={set('password')} autoComplete="new-password" />
          <p className="faint" style={{ margin: '4px 0 0' }}>At least 8 characters.</p>
        </Field>
        <Field label="I am signing up as">
          <select value={form.role} onChange={set('role')}>
            <option value="CUSTOMER">A customer booking tickets</option>
            <option value="ORGANISER">An organiser listing events</option>
          </select>
        </Field>
        <button className="btn btn-block" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
      </form>

      <p className="muted" style={{ marginTop: 14 }}>
        Already registered? <Link to="/login">Sign in</Link>.
      </p>
    </div>
  );
}
