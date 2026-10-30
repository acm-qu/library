import { z } from 'zod';
import { GENDERS, ROLES, USER_STATUSES } from '../enums.ts';
import { Email, Id } from './common.ts';

export const RequestCodeBody = z.object({ email: Email });
export const VerifyBody = z.object({ email: Email, code: z.string().regex(/^\d{6}$/) });

export const Me = z.object({
  id: Id,
  email: z.string(),
  name: z.string(),
  role: z.enum(ROLES),
  isAdmin: z.boolean(),
  gender: z.enum(GENDERS).nullable(),
});
export type Me = z.infer<typeof Me>;

const Name = z.string().trim().min(1).max(120);
export const PatchMeBody = z.object({ name: Name, gender: z.enum(GENDERS) });
export const RequestAccessBody = z.object({ email: Email, name: Name, gender: z.enum(GENDERS) });

/** Signed-in people must have a name and gender before using anything beyond their own profile. */
export const profileComplete = (m: Pick<Me, 'name' | 'gender'>) => m.name.trim() !== '' && m.gender !== null;

/** What policy code needs to know about the signed-in user. */
export const Viewer = Me.extend({ status: z.enum(USER_STATUSES) });
export type Viewer = z.infer<typeof Viewer>;
