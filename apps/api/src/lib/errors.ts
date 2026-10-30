import type { ApiErrorBody, ErrorCode } from '@acm/core/schemas';
import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  wrong_code: 400,
  expired_code: 400,
  unauthorized: 401,
  csrf: 403,
  not_allowed: 403,
  not_found: 404,
  conflict: 409,
  no_slot: 409,
  profile_incomplete: 409,
  too_large: 413,
  unsupported_type: 415,
  rate_limited: 429,
  too_many_attempts: 429,
  internal: 500,
};

/** Default English messages; the web app shows its own translated copy keyed by `error`. */
const MESSAGES: Record<ErrorCode, string> = {
  bad_request: 'The request was not valid.',
  wrong_code: "That code isn't right.",
  expired_code: 'That code has expired. Request a new one.',
  unauthorized: 'Sign in to continue.',
  csrf: 'Missing request header.',
  not_allowed: "You can't do that.",
  not_found: 'Not found.',
  conflict: 'That conflicts with the current state.',
  no_slot: 'Wait for a free upload slot.',
  profile_incomplete: 'Add your name and gender to your profile first.',
  too_large: 'That file is too large.',
  unsupported_type: "That file type isn't supported.",
  rate_limited: 'Too many requests. Try again later.',
  too_many_attempts: 'Too many attempts. Request a new code.',
  internal: 'Something went wrong on our side.',
};

export class HttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly extra: Omit<ApiErrorBody, 'error' | 'message'> = {},
    message = MESSAGES[code],
  ) {
    super(message);
  }
  get status() {
    return STATUS[this.code];
  }
  body(): ApiErrorBody {
    return { error: this.code, message: this.message, ...this.extra };
  }
}

export const notFound = () => new HttpError('not_found');

export function registerErrorHandling(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | HttpError | ZodError, req, reply) => {
    if (err instanceof HttpError) {
      if (err.extra.retry_after) void reply.header('Retry-After', String(err.extra.retry_after));
      return reply.code(err.status).send(err.body());
    }
    if (err instanceof ZodError) {
      const fields = Object.fromEntries(err.issues.map((i) => [i.path.join('.') || '_', i.message]));
      return reply.code(400).send(new HttpError('bad_request', { fields }).body());
    }
    const status = err.statusCode ?? 500;
    if (status === 413) return reply.code(413).send(new HttpError('too_large').body());
    if (status === 415) return reply.code(415).send(new HttpError('unsupported_type').body());
    if (status >= 400 && status < 500) return reply.code(400).send(new HttpError('bad_request').body());
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send(new HttpError('internal', { reference: req.id }).body());
  });
}
