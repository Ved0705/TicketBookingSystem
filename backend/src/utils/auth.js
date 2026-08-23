import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import config from '../config.js';

export const hashPassword = (plain) => bcrypt.hashSync(plain, config.bcryptRounds);
export const verifyPassword = (plain, hash) => bcrypt.compareSync(plain, hash);

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

export function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret);
}

// Crockford-ish alphabet: no I, O, 0, 1 so references are easy to read aloud.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function bookingReference() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `TBS-${out}`;
}
