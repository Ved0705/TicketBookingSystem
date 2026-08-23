import { startServer, stopServer, api, register, createAdmin, uniqueEmail } from './helpers.js';
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

before(async () => { await startServer(); });
after(async () => { await stopServer(); });

describe('authentication', () => {
  test('a customer can register and receives a token', async () => {
    const email = uniqueEmail('cust');
    const res = await api('/api/auth/register', {
      method: 'POST',
      body: { name: 'Priya Nair', email, password: 'Password123!', role: 'CUSTOMER' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.role, 'CUSTOMER');
    assert.equal(res.body.user.email, email);
    assert.ok(res.body.token);
    assert.equal(res.body.user.password_hash, undefined, 'must never leak the hash');
  });

  test('registration defaults to CUSTOMER when no role is given', async () => {
    const res = await api('/api/auth/register', {
      method: 'POST',
      body: { name: 'No Role', email: uniqueEmail(), password: 'Password123!' },
    });
    assert.equal(res.body.user.role, 'CUSTOMER');
  });

  test('an organiser can register', async () => {
    const organiser = await register('ORGANISER', 'Ravi Kulkarni');
    assert.equal(organiser.role, 'ORGANISER');
  });

  test('nobody can self-register as ADMIN', async () => {
    const res = await api('/api/auth/register', {
      method: 'POST',
      body: { name: 'Sneaky', email: uniqueEmail(), password: 'Password123!', role: 'ADMIN' },
    });
    assert.equal(res.status, 400);
  });

  test('duplicate emails are rejected with 409', async () => {
    const email = uniqueEmail();
    const body = { name: 'First', email, password: 'Password123!' };
    assert.equal((await api('/api/auth/register', { method: 'POST', body })).status, 201);
    const second = await api('/api/auth/register', { method: 'POST', body });
    assert.equal(second.status, 409);
  });

  test('short passwords are rejected with field-level detail', async () => {
    const res = await api('/api/auth/register', {
      method: 'POST',
      body: { name: 'Weak', email: uniqueEmail(), password: 'abc' },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.details.password);
  });

  test('login succeeds with the right password', async () => {
    const user = await register('CUSTOMER');
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: 'Password123!' },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
  });

  test('login fails with the wrong password and does not reveal why', async () => {
    const user = await register('CUSTOMER');
    const wrongPass = await api('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: 'WrongPassword1!' },
    });
    const noUser = await api('/api/auth/login', {
      method: 'POST',
      body: { email: uniqueEmail('ghost'), password: 'WrongPassword1!' },
    });
    assert.equal(wrongPass.status, 401);
    assert.equal(noUser.status, 401);
    assert.equal(wrongPass.body.error.message, noUser.body.error.message);
  });

  test('GET /me returns the signed-in user and rejects bad tokens', async () => {
    const user = await register('CUSTOMER');
    const ok = await api('/api/auth/me', { token: user.token });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.email, user.email);

    assert.equal((await api('/api/auth/me')).status, 401);
    assert.equal((await api('/api/auth/me', { token: 'not.a.token' })).status, 401);
  });
});

describe('role-based authorization', () => {
  test('a customer cannot reach admin endpoints', async () => {
    const customer = await register('CUSTOMER');
    const res = await api('/api/admin/venues', { token: customer.token });
    assert.equal(res.status, 403);
  });

  test('an organiser cannot reach admin endpoints', async () => {
    const organiser = await register('ORGANISER');
    const res = await api('/api/admin/venues', {
      method: 'POST',
      token: organiser.token,
      body: { name: 'Rogue Venue', city: 'Nowhere' },
    });
    assert.equal(res.status, 403);
  });

  test('a customer cannot create events', async () => {
    const customer = await register('CUSTOMER');
    const res = await api('/api/organiser/events', {
      method: 'POST',
      token: customer.token,
      body: { title: 'Not allowed', type: 'MOVIE' },
    });
    assert.equal(res.status, 403);
  });

  test('an admin can reach admin endpoints', async () => {
    const admin = await createAdmin();
    const res = await api('/api/admin/venues', { token: admin.token });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.venues));
  });

  test('unauthenticated requests to protected routes get 401, not 403', async () => {
    assert.equal((await api('/api/admin/venues')).status, 401);
    assert.equal((await api('/api/bookings')).status, 401);
  });
});
