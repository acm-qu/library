import { CreateEventBody, EventDetail, ExistingFiles, MyUploadsPage, UPLOAD_BUCKETS, UploadProgress, UploadQueue, UploadTicket, type UploadTicketBody } from '@acm/core/schemas';
import type { z } from 'zod';
import { call, q } from './client.ts';

export type Bucket = (typeof UPLOAD_BUCKETS)[number];
export const getMyUploads = (bucket: Bucket, cursor?: string) => call(MyUploadsPage, `/uploads/mine${q({ bucket, cursor, limit: 100 })}`);
export const retryUpload = (assetId: string) => call(null, `/uploads/${assetId}/retry`, { method: 'POST' });
export const getExisting = (eventId: string) => call(ExistingFiles, `/uploads/existing${q({ eventId })}`);
export const createTicket = (body: z.input<typeof UploadTicketBody>) => call(UploadTicket, '/uploads/tickets', { method: 'POST', json: body });
export const cancelTicket = (id: string) => call(null, `/uploads/tickets/${id}`, { method: 'DELETE' });
export const getUploadQueue = () => call(UploadQueue, '/uploads/queue');
export const createEvent = (body: z.input<typeof CreateEventBody>) => call(EventDetail, '/events', { method: 'POST', json: body });
/** Discard a server-side unfinished upload (tus termination); its "uploading" row goes with it. */
export const discardUpload = (uploadId: string) =>
  fetch(`/api/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE', headers: { 'X-Requested-With': 'acm-media', 'Tus-Resumable': '1.0.0' } });

/** Status and job progress of the caller's unfinished uploads only (one small query; polled every second on My uploads). */
export const getUploadProgress = () => call(UploadProgress, '/uploads/progress');
