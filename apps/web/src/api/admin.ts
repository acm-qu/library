import { AdminJobPage, AdminUser, AppSettings, BulkUsersResult, ProcessingReport, StorageReport } from '@acm/core/schemas';
import { z } from 'zod';
import { call, q } from './client.ts';

export const UsersPage = z.object({
  items: z.array(AdminUser),
  nextCursor: z.string().nullable(),
  counts: z.object({ all: z.number(), core: z.number(), admins: z.number(), disabled: z.number() }),
});
export type UserFilter = { q?: string; status?: 'active' | 'disabled' };
export const getUsers = (f: UserFilter, cursor?: string) => call(UsersPage, `/admin/users${q({ ...f, cursor, limit: 50 })}`);
export const createUser = (b: { email: string; name: string; isAdmin: boolean }) => call(z.object({ id: z.string() }), '/admin/users', { method: 'POST', json: b });
export const bulkUsers = (emails: string, isAdmin: boolean) => call(BulkUsersResult, '/admin/users/bulk', { method: 'POST', json: { emails: [emails], isAdmin } });
export const patchUser = (id: string, b: Partial<{ isAdmin: boolean; status: 'active' | 'disabled'; name: string }>) =>
  call(null, `/admin/users/${id}`, { method: 'PATCH', json: b });

export type JobTab = 'running' | 'queued' | 'failed' | 'needs_review' | 'recent';
const AdminJobPageWide = AdminJobPage.extend({
  items: z.array(
    AdminJobPage.shape.items.element.extend({
      asset: z
        .object({ id: z.string(), filename: z.string(), status: z.string(), eventTitle: z.string(), thumbUrl: z.string().nullable(), kind: z.enum(['image', 'video']), durationS: z.number().nullable(), hdr: z.string().nullable(), bytes: z.number().nullable(), reviewReason: z.string().nullable() })
        .nullable(),
    }),
  ),
});
export type AdminJobItem = z.infer<typeof AdminJobPageWide>['items'][number];
export const getJobs = (tab: JobTab, cursor?: string) => call(AdminJobPageWide, `/admin/jobs${q({ tab, cursor, limit: 50 })}`);
export const jobAction = (id: string, action: 'retry' | 'cancel' | 'prioritize') => call(null, `/admin/jobs/${id}/${action}`, { method: 'POST' });
export const resolveAsset = (id: string, action: 'process_default' | 'original_only') => call(null, `/admin/assets/${id}/resolve`, { method: 'POST', json: { action } });
export const reprocess = (id: string, toneCurve?: string) => call(null, `/admin/assets/${id}/reprocess`, { method: 'POST', json: toneCurve ? { toneCurve } : {} });
export const getProcessing = (id: string) => call(ProcessingReport, `/admin/assets/${id}/processing`);
export const getStorage = () => call(StorageReport, '/admin/storage');
export const getSettings = () => call(AppSettings, '/admin/settings');
export const patchSettings = (b: Partial<{ tonemapAuto: boolean; inodeLimit: number | null }>) => call(null, '/admin/settings', { method: 'PATCH', json: b });
export const patchAsset = (id: string, b: { tier?: 'member' | 'core' }) => call(null, `/assets/${id}`, { method: 'PATCH', json: b });
export const deleteAsset = (id: string) => call(null, `/assets/${id}`, { method: 'DELETE' });
