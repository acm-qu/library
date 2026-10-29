import { z } from 'zod';

// Every error the API can return. The web app maps each code to an i18n message key `errors.<code>`.
export const ERROR_CODES = [
  'bad_request',
  'unauthorized',
  'not_found',
  'csrf',
  'rate_limited',
  'wrong_code',
  'expired_code',
  'too_many_attempts',
  'not_allowed', // an action the viewer can see but may not take, e.g. demoting the last admin
  'conflict',
  'unsupported_type',
  'too_large',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ApiErrorBody = z.object({
  error: z.enum(ERROR_CODES),
  message: z.string(),
  attemptsLeft: z.number().int().optional(),
  retry_after: z.number().int().optional(),
  fields: z.record(z.string(), z.string()).optional(),
  /** Request id shown as "Reference" on the server-error screen; matches the API log line. */
  reference: z.string().optional(),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;
