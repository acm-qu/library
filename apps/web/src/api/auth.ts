import { type Gender, Me } from '@acm/core/schemas';
import { ApiError, call } from './client.ts';

export const requestCode = (email: string) => call(null, '/auth/request-code', { method: 'POST', json: { email } });
export const verify = (email: string, code: string) => call(Me, '/auth/verify', { method: 'POST', json: { email, code } });
export const logout = () => call(null, '/auth/logout', { method: 'POST' });
export const logoutAll = () => call(null, '/auth/logout-all', { method: 'POST' });

/** The signed-in user, or null when there is no session. */
export async function getMe(): Promise<Me | null> {
  try {
    return await call(Me, '/me');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}
export const patchMe = (b: { name: string; gender: Gender }) => call(Me, '/me', { method: 'PATCH', json: b });
export const requestAccess = (b: { email: string; name: string; gender: Gender }) => call(null, '/auth/request-access', { method: 'POST', json: b });
