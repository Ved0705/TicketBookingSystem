import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

const TOKEN_KEY = 'tbs.token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

/** Thrown for any non-2xx response so callers can show the server's message. */
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details;
  }
}

export async function request(path, { method = 'GET', body, auth = true } = {}) {
  const token = auth ? getToken() : null;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 204) return null;
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, parsed);
  return parsed;
}

export const api = {
  get: (p) => request(p),
  post: (p, body) => request(p, { method: 'POST', body }),
  patch: (p, body) => request(p, { method: 'PATCH', body }),
  put: (p, body) => request(p, { method: 'PUT', body }),
  del: (p) => request(p, { method: 'DELETE' }),
};

/* ------------------------------------------------------------------ auth */

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) { setReady(true); return; }
    api
      .get('/api/auth/me')
      .then((d) => setUser(d.user))
      .catch(() => setToken(null))
      .finally(() => setReady(true));
  }, []);

  const login = useCallback(async (email, password) => {
    const data = await api.post('/api/auth/login', { email, password });
    setToken(data.token);
    setUser(data.user);
    return data.user;
  }, []);

  const register = useCallback(async (payload) => {
    const data = await api.post('/api/auth/register', payload);
    setToken(data.token);
    setUser(data.user);
    return data.user;
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, ready, login, register, logout }),
    [user, ready, login, register, logout]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/* --------------------------------------------------------------- helpers */

export const money = (n) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })
    .format(Number(n || 0));

export const dateTime = (iso) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });

export const dateOnly = (iso) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** Countdown to an ISO timestamp, ticking once a second. Returns mm:ss. */
export function useCountdown(expiresAt) {
  const [left, setLeft] = useState(() => remaining(expiresAt));
  useEffect(() => {
    setLeft(remaining(expiresAt));
    if (!expiresAt) return undefined;
    const id = setInterval(() => setLeft(remaining(expiresAt)), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  return left;
}

function remaining(expiresAt) {
  if (!expiresAt) return { seconds: 0, label: '--:--', expired: true };
  const seconds = Math.max(0, Math.floor((new Date(expiresAt) - Date.now()) / 1000));
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return { seconds, label: `${mm}:${ss}`, expired: seconds === 0 };
}
