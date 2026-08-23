import { Router } from 'express';
import { db } from '../db/index.js';
import { validate } from '../utils/validate.js';
import { hashPassword, verifyPassword, signToken } from '../utils/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { conflict, unauthorized, forbidden } from '../utils/errors.js';

const router = Router();

const publicRoles = ['CUSTOMER', 'ORGANISER'];

router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const body = validate(req.body, {
      name: { type: 'string', required: true, minLength: 2, maxLength: 80 },
      email: { type: 'email', required: true },
      password: { type: 'string', required: true, minLength: 8, maxLength: 100 },
      role: { type: 'string', enum: publicRoles, default: 'CUSTOMER' },
    });

    // Admins are provisioned by seeding, never by self-registration.
    if (!publicRoles.includes(body.role)) throw forbidden('That role cannot self-register.');

    const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(body.email);
    if (exists) throw conflict('An account with that email already exists.');

    const role = db.prepare('SELECT id FROM roles WHERE name = ?').get(body.role);
    const id = db
      .prepare('INSERT INTO users (name, email, password_hash, role_id) VALUES (?, ?, ?, ?)')
      .run(body.name, body.email, hashPassword(body.password), role.id).lastInsertRowid;

    const user = { id, name: body.name, email: body.email, role: body.role };
    res.status(201).json({ user, token: signToken(user) });
  })
);

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const body = validate(req.body, {
      email: { type: 'email', required: true },
      password: { type: 'string', required: true },
    });

    const row = db
      .prepare(
        `SELECT u.id, u.name, u.email, u.password_hash, r.name AS role
           FROM users u JOIN roles r ON r.id = u.role_id
          WHERE u.email = ?`
      )
      .get(body.email);

    // Same message either way so the endpoint cannot be used to enumerate accounts.
    if (!row || !verifyPassword(body.password, row.password_hash)) {
      throw unauthorized('Email or password is incorrect.');
    }

    const user = { id: row.id, name: row.name, email: row.email, role: row.role };
    res.json({ user, token: signToken(user) });
  })
);

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;
