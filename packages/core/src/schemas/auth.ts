import { z } from 'zod';
import { ROLES, USER_STATUSES } from '../enums.ts';
import { Email, Id } from './common.ts';

export const RequestCodeBody = z.object({ email: Email });
export const VerifyBody = z.object({ email: Email, code: z.string().regex(/^\d{6}$/) });

export const Me = z.object({
  id: Id,
  email: z.string(),
  name: z.string(),
  role: z.enum(ROLES),
  isAdmin: z.boolean(),
});
export type Me = z.infer<typeof Me>;

export const PatchMeBody = z.object({ name: z.string().trim().max(120) });

/** What policy code needs to know about the signed-in user. */
export const Viewer = Me.extend({ status: z.enum(USER_STATUSES) });
export type Viewer = z.infer<typeof Viewer>;
