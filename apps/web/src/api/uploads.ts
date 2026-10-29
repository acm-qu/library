import { CreateEventBody, EventDetail, ExistingFiles, MyUploadsPage, UPLOAD_BUCKETS } from '@acm/core/schemas';
import type { z } from 'zod';
import { call, q } from './client.ts';

export type Bucket = (typeof UPLOAD_BUCKETS)[number];
export const getMyUploads = (bucket: Bucket, cursor?: string) => call(MyUploadsPage, `/uploads/mine${q({ bucket, cursor, limit: 100 })}`);
export const retryUpload = (assetId: string) => call(null, `/uploads/${assetId}/retry`, { method: 'POST' });
export const getExisting = (eventId: string) => call(ExistingFiles, `/uploads/existing${q({ eventId })}`);
export const createEvent = (body: z.input<typeof CreateEventBody>) => call(EventDetail, '/events', { method: 'POST', json: body });
/** Discard a server-side unfinished upload (tus termination); its "uploading" row goes with it. */
export const discardUpload = (uploadId: string) =>
  fetch(`/api/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE', headers: { 'X-Requested-With': 'acm-media', 'Tus-Resumable': '1.0.0' } });
