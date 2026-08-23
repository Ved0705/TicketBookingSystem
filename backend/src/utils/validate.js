import { badRequest } from './errors.js';

/**
 * Tiny schema validator. Deliberately hand-rolled instead of pulling in a
 * validation library — the rule set the API needs is small and explicit.
 *
 * Schema shape:
 *   { field: { type, required, min, max, minLength, maxLength, enum, of } }
 * Supported types: string, email, int, number, boolean, array, object, isoDate
 */
export function validate(payload, schema) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const out = {};
  const errors = {};

  for (const [field, rule] of Object.entries(schema)) {
    const raw = input[field];
    const missing = raw === undefined || raw === null || raw === '';

    if (missing) {
      if (rule.required) errors[field] = 'is required';
      else if ('default' in rule) out[field] = rule.default;
      continue;
    }

    const err = (m) => {
      errors[field] = m;
    };

    switch (rule.type) {
      case 'string': {
        if (typeof raw !== 'string') { err('must be a string'); break; }
        const v = raw.trim();
        if (rule.minLength && v.length < rule.minLength) { err(`must be at least ${rule.minLength} characters`); break; }
        if (rule.maxLength && v.length > rule.maxLength) { err(`must be at most ${rule.maxLength} characters`); break; }
        if (rule.enum && !rule.enum.includes(v)) { err(`must be one of: ${rule.enum.join(', ')}`); break; }
        out[field] = v;
        break;
      }
      case 'email': {
        if (typeof raw !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim())) {
          err('must be a valid email address');
          break;
        }
        out[field] = raw.trim().toLowerCase();
        break;
      }
      case 'int': {
        const n = Number(raw);
        if (!Number.isInteger(n)) { err('must be an integer'); break; }
        if (rule.min !== undefined && n < rule.min) { err(`must be >= ${rule.min}`); break; }
        if (rule.max !== undefined && n > rule.max) { err(`must be <= ${rule.max}`); break; }
        out[field] = n;
        break;
      }
      case 'number': {
        const n = Number(raw);
        if (!Number.isFinite(n)) { err('must be a number'); break; }
        if (rule.min !== undefined && n < rule.min) { err(`must be >= ${rule.min}`); break; }
        if (rule.max !== undefined && n > rule.max) { err(`must be <= ${rule.max}`); break; }
        out[field] = n;
        break;
      }
      case 'boolean': {
        if (typeof raw === 'boolean') out[field] = raw;
        else if (raw === 'true' || raw === 'false') out[field] = raw === 'true';
        else err('must be a boolean');
        break;
      }
      case 'isoDate': {
        const d = new Date(raw);
        if (Number.isNaN(d.getTime())) { err('must be a valid date'); break; }
        out[field] = d.toISOString();
        break;
      }
      case 'array': {
        if (!Array.isArray(raw)) { err('must be an array'); break; }
        if (rule.minLength && raw.length < rule.minLength) { err(`must contain at least ${rule.minLength} item(s)`); break; }
        if (rule.maxLength && raw.length > rule.maxLength) { err(`must contain at most ${rule.maxLength} item(s)`); break; }
        if (rule.of === 'int') {
          const items = raw.map(Number);
          if (items.some((n) => !Number.isInteger(n))) { err('must contain integers only'); break; }
          out[field] = items;
        } else {
          out[field] = raw;
        }
        break;
      }
      case 'object': {
        if (typeof raw !== 'object' || Array.isArray(raw)) { err('must be an object'); break; }
        out[field] = raw;
        break;
      }
      default:
        out[field] = raw;
    }
  }

  if (Object.keys(errors).length > 0) {
    throw badRequest('Some fields need attention.', errors);
  }
  return out;
}

export default validate;
