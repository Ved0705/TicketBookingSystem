import { HttpError } from '../utils/errors.js';

/** Wrap async route handlers so rejected promises reach the error handler. */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.originalUrl}` },
  });
}

/** Single place where every error becomes a JSON body. */
export function errorHandler(err, _req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
  }

  // SQLite constraint violations surface as races/duplicates, not 500s.
  if (err && typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) {
    return res.status(409).json({
      error: { code: 'CONFLICT', message: 'That change conflicts with existing data.' },
    });
  }

  if (err?.code === 'CORS_REJECTED') {
    return res.status(403).json({ error: { code: 'CORS_REJECTED', message: err.message } });
  }

  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Request body is not valid JSON.' } });
  }

  console.error('[error]', err);
  return res.status(500).json({
    error: { code: 'INTERNAL', message: 'Something went wrong on our side.' },
  });
}
