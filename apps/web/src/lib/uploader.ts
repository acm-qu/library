// The upload queue. A module singleton, so uploads keep running while the user moves around the app. Built on
// tus-js-client: 8 MiB chunks, fingerprints in localStorage (picking the same file again resumes it), retries
// with backoff, and pause/resume when the browser goes offline and back. Every file first takes a ticket in the
// server-wide queue ('queued') and starts only once granted ('waiting' → 'uploading'); data/uploads.ts polls the
// queue and hands it to sync().
import type { UploadQueue } from '@acm/core/schemas';
import { useSyncExternalStore } from 'react';
import * as tus from 'tus-js-client';
import { ApiError } from '../api/client.ts';
import { cancelTicket, createTicket } from '../api/uploads.ts';

export type Tier = 'member' | 'core';
export type ItemStatus = 'queued' | 'waiting' | 'uploading' | 'paused' | 'done' | 'failed' | 'cancelled';
export type FailReason = 'unsupported_type' | 'too_large' | 'not_found' | 'network' | 'server';
export type Item = {
  key: string;
  file: File;
  eventId: string;
  tier: Tier;
  girlsOnly: boolean;
  status: ItemStatus;
  sent: number;
  total: number;
  drops: number;
  reason?: FailReason;
  assetId?: string;
  pausedByOffline?: boolean;
  /** The granted or waiting queue ticket, and when it was issued. */
  ticketId?: string;
  ticketAt?: number;
  /** Place in line while queued. */
  position?: number | null;
};

const CHUNK = 8 * 1024 * 1024;
/** Per file, the most the server ever gives uploads (media/throttle.ts shares the real rate live, up to the 21 MiB/s line). */
export const UPLOAD_BPS = 21 * 1024 * 1024;
const PARALLEL = 2;
const RETRY = [0, 1000, 3000, 5000, 10_000, 20_000, 30_000];

let items: Item[] = [];
const uploads = new Map<string, tus.Upload>();
const subs = new Set<() => void>();
const emit = () => {
  items = [...items];
  subs.forEach((f) => f());
};
const patch = (key: string, p: Partial<Item>) => {
  items = items.map((it) => (it.key === key ? { ...it, ...p } : it));
  subs.forEach((f) => f());
};
const get = (key: string) => items.find((i) => i.key === key);

export const fileKey = (f: File) => `${f.name}:${f.size}:${f.lastModified}`;

function reasonOf(err: unknown): FailReason {
  const status = err instanceof ApiError ? err.status : (err as { originalResponse?: { getStatus(): number } }).originalResponse?.getStatus?.();
  if (status === 415) return 'unsupported_type';
  if (status === 413) return 'too_large';
  if (status === 404) return 'not_found';
  if (status && status >= 500) return 'server';
  return 'network';
}

/** Waits so chunk requests start at most one per CHUNK / UPLOAD_BPS seconds (about 0.4 s for 8 MiB at 21 MiB/s). */
export function chunkPacer(now = () => Date.now()) {
  let nextAt = 0;
  return (): number => {
    const t = now();
    const wait = Math.max(0, nextAt - t);
    nextAt = Math.max(t, nextAt) + (CHUNK / UPLOAD_BPS) * 1000;
    return wait;
  };
}

const noSlot = (err: tus.DetailedError) => err.originalResponse?.getStatus() === 409 && (err.originalResponse.getBody() ?? '').includes('no_slot');

/** Gives a ticket back so its place (or slot) goes to the next file; failures just let it expire. */
const release = (id: string | undefined) => void (id && cancelTicket(id).catch(() => {}));

/** Asks for the place a queueTickets() call reserved; a granted ticket makes the item 'waiting' for the local scheduler. */
async function requestTicket(key: string) {
  const it = get(key);
  if (it?.status !== 'queued' || it.ticketId) return; // paused, cancelled or already served meanwhile
  try {
    const t = await createTicket({ eventId: it.eventId, filename: it.file.name, bytes: it.file.size, kind: isVideo(it.file) ? 'video' : 'image', girlsOnly: it.girlsOnly });
    const now = get(key);
    if (now?.status !== 'queued' || now.ticketId) return release(t.id);
    patch(key, { ticketId: t.id, ticketAt: Date.now(), position: t.state === 'waiting' ? t.position : null, status: t.state === 'uploading' ? 'waiting' : 'queued' });
    pump();
  } catch (err) {
    if (get(key)?.status === 'queued') patch(key, { status: 'failed', reason: reasonOf(err) });
  }
}

/** Puts items at the back of the server's line: any old ticket goes back, new ones are asked for one at a time, in file order. */
let ticketChain = Promise.resolve();
function queueTickets(keys: string[]) {
  for (const k of keys) {
    release(get(k)?.ticketId);
    patch(k, { status: 'queued', ticketId: undefined, position: null, reason: undefined, pausedByOffline: false });
    ticketChain = ticketChain.then(() => requestTicket(k));
  }
}

function startOne(it: Item) {
  const nextWait = chunkPacer();
  const up = new tus.Upload(it.file, {
    endpoint: '/api/uploads',
    chunkSize: CHUNK,
    retryDelays: RETRY,
    headers: { 'X-Requested-With': 'acm-media', 'Upload-Ticket': it.ticketId ?? '' },
    onBeforeRequest: (req) => {
      if (req.getMethod() !== 'PATCH') return;
      const wait = nextWait();
      return wait ? new Promise((r) => setTimeout(r, wait)) : undefined;
    },
    metadata: { eventId: it.eventId, tier: it.tier, girlsOnly: String(it.girlsOnly), filename: it.file.name, filetype: it.file.type, ticketId: it.ticketId ?? '' },
    storeFingerprintForResuming: true,
    removeFingerprintOnSuccess: true,
    onProgress: (sent, total) => patch(it.key, { sent, total }),
    onShouldRetry: (err, attempt) => {
      const status = err.originalResponse?.getStatus();
      const transient = !noSlot(err) && (!status || status >= 500 || status === 409 || status === 423);
      if (transient && attempt > 0) patch(it.key, { drops: (get(it.key)?.drops ?? 0) + 1 });
      return transient && navigator.onLine;
    },
    onAfterResponse: (_req, res) => {
      const id = res.getHeader('Asset-Id');
      if (id) patch(it.key, { assetId: id });
    },
    onSuccess: () => {
      uploads.delete(it.key);
      patch(it.key, { status: 'done', sent: it.file.size });
      pump();
    },
    onError: (err) => {
      uploads.delete(it.key);
      if (get(it.key)?.status === 'paused' || get(it.key)?.status === 'cancelled') return;
      // The ticket expired (stalled for 2 minutes): back to the end of the line, resuming where it stopped.
      if (err instanceof tus.DetailedError && noSlot(err)) queueTickets([it.key]);
      else if (!navigator.onLine) patch(it.key, { status: 'paused', pausedByOffline: true });
      else patch(it.key, { status: 'failed', reason: reasonOf(err) });
      pump();
    },
  });
  uploads.set(it.key, up);
  patch(it.key, { status: 'uploading', reason: undefined });
  // If the saved resume state can't be read (storage blocked or full), start fresh rather than sit at 0% forever.
  void up
    .findPreviousUploads()
    .catch(() => [])
    .then((prev) => {
      if (prev[0]) up.resumeFromPreviousUpload(prev[0]);
      up.start();
    });
}

export const isVideo = (f: File) => f.type.startsWith('video/') || /\.(mov|mp4|m4v)$/i.test(f.name);

/** Granted ('waiting') items to start now: up to PARALLEL files, at most one of them a video (the server's disk IO is capped). */
export function toStart(list: Item[]): Item[] {
  const busy = list.filter((i) => i.status === 'uploading');
  let video = busy.some((i) => isVideo(i.file));
  const out: Item[] = [];
  for (const it of list) {
    if (busy.length + out.length >= PARALLEL) break;
    if (it.status !== 'waiting' || (video && isVideo(it.file))) continue;
    video ||= isVideo(it.file);
    out.push(it);
  }
  return out;
}

function pump() {
  if (!navigator.onLine) return;
  for (const it of toStart(items)) startOne(it);
}

export const uploader = {
  add(files: { file: File; tier: Tier; girlsOnly: boolean }[], eventId: string) {
    const known = new Set(items.filter((i) => i.status !== 'cancelled' && i.status !== 'done').map((i) => i.key));
    const fresh: string[] = [];
    for (const { file, tier, girlsOnly } of files) {
      const key = fileKey(file);
      if (known.has(key)) continue;
      items.push({ key, file, eventId, tier, girlsOnly, status: 'queued', sent: 0, total: file.size, drops: 0 });
      fresh.push(key);
    }
    emit();
    queueTickets(fresh);
  },
  /** A paused file gives its place back; resuming queues it again (the bytes already sent are kept). */
  pause(key: string) {
    release(get(key)?.ticketId);
    patch(key, { status: 'paused', pausedByOffline: false, ticketId: undefined, position: null });
    void uploads.get(key)?.abort(false);
    uploads.delete(key);
    pump();
  },
  resume(key: string) {
    queueTickets([key]);
  },
  retry(key: string) {
    patch(key, { drops: 0 });
    queueTickets([key]);
  },
  cancel(key: string) {
    const up = uploads.get(key);
    release(get(key)?.ticketId);
    patch(key, { status: 'cancelled', ticketId: undefined });
    uploads.delete(key);
    void up?.abort(true); // terminates on the server, which deletes the "uploading" row
    pump();
  },
  pauseAll() {
    for (const i of items) if (i.status === 'uploading' || i.status === 'waiting' || i.status === 'queued') this.pause(i.key);
  },
  resumeAll() {
    queueTickets(items.filter((i) => i.status === 'paused').map((i) => i.key));
  },
  /**
   * Applies a poll of the server queue: granted tickets become 'waiting' (the local 2-at-a-time rule starts them),
   * waiting ones update their place, and a ticket the server no longer lists (expired) queues again.
   */
  sync(q: UploadQueue, now = Date.now()) {
    const mine = new Map(q.items.filter((r) => r.ticketId).map((r) => [r.ticketId!, r]));
    for (const it of items) {
      if (!it.ticketId || (it.status !== 'queued' && it.status !== 'waiting')) continue;
      const r = mine.get(it.ticketId);
      // A poll that started before this ticket existed can't list it yet.
      if (!r) {
        if (now - (it.ticketAt ?? now) > 15_000) queueTickets([it.key]);
      } else if (r.state === 'uploading') {
        if (it.status === 'queued') patch(it.key, { status: 'waiting', position: null });
      } else if (r.position !== it.position) patch(it.key, { position: r.position });
    }
    pump();
  },
  /** Forget finished rows (keeps anything still in flight). */
  clearFinished() {
    items = items.filter((i) => i.status !== 'done' && i.status !== 'cancelled');
    emit();
  },
};

addEventListener('offline', () => {
  for (const i of items) {
    if (i.status === 'uploading') {
      patch(i.key, { status: 'paused', pausedByOffline: true });
      void uploads.get(i.key)?.abort(false);
      uploads.delete(i.key);
    }
  }
});
// Back online, a file whose ticket survived carries on; one whose ticket expired meanwhile gets no_slot and re-queues.
addEventListener('online', () => {
  const back = items.filter((i) => i.status === 'paused' && i.pausedByOffline);
  for (const i of back) if (i.ticketId) patch(i.key, { status: 'waiting', pausedByOffline: false });
  queueTickets(back.filter((i) => !i.ticketId).map((i) => i.key));
  pump();
});
// Leaving the site mid-upload loses nothing (resume picks up), but warn anyway.
addEventListener('beforeunload', (e) => {
  if (items.some((i) => i.status === 'uploading' || i.status === 'waiting' || i.status === 'queued')) e.preventDefault();
});

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};
export const currentUploads = () => items;
export const useUploads = () => useSyncExternalStore(subscribe, currentUploads);
