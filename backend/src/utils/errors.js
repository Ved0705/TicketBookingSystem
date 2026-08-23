export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, 'BAD_REQUEST', msg, details);
export const unauthorized = (msg = 'Sign in to continue.') =>
  new HttpError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = 'You do not have access to this resource.') =>
  new HttpError(403, 'FORBIDDEN', msg);
export const notFound = (msg = 'Not found.') => new HttpError(404, 'NOT_FOUND', msg);
export const conflict = (msg, details) => new HttpError(409, 'CONFLICT', msg, details);
export const unprocessable = (msg, details) =>
  new HttpError(422, 'UNPROCESSABLE', msg, details);
