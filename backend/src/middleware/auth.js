import { verifyToken } from '../utils/auth.js';
import { db } from '../db/index.js';
import { forbidden, unauthorized } from '../utils/errors.js';

function readToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

/** Populates req.user when a valid token is present; otherwise leaves it null. */
export function optionalAuth(req, _res, next) {
  const token = readToken(req);
  req.user = null;
  if (!token) return next();
  try {
    const payload = verifyToken(token);
    req.user = loadUser(payload.sub);
  } catch {
    req.user = null;
  }
  next();
}

/** Rejects the request unless a valid token maps to a real user. */
export function requireAuth(req, _res, next) {
  const token = readToken(req);
  if (!token) return next(unauthorized('Sign in to continue.'));
  let payload;
  try {
    payload = verifyToken(token);
  } catch (err) {
    const msg = err.name === 'TokenExpiredError' ? 'Your session expired. Sign in again.' : 'Invalid token.';
    return next(unauthorized(msg));
  }
  const user = loadUser(payload.sub);
  if (!user) return next(unauthorized('This account no longer exists.'));
  req.user = user;
  next();
}

/** Rejects the request unless the signed-in user holds one of `roles`. */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized('Sign in to continue.'));
    if (!roles.includes(req.user.role)) {
      return next(forbidden(`This area is for ${roles.join(' / ').toLowerCase()} accounts.`));
    }
    next();
  };
}

function loadUser(id) {
  return db
    .prepare(
      `SELECT u.id, u.name, u.email, u.created_at, r.name AS role
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.id = ?`
    )
    .get(id);
}
