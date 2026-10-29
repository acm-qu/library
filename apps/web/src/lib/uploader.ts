// The upload queue. A module singleton, so uploads keep running while the user moves around the app. Built on
// tus-js-client: 8 MiB chunks, fingerprints in localStorage (picking the same file again resumes it), retries
// with backoff, and pause/resume when the browser goes offline and back.
import { useSyncExternalStore } from 'react';
import * as tus from 'tus-js-client';

export type Tier = 'member' | 'core';
export type ItemStatus = 'waiting' | 'uploading' | 'paused' | 'done' | 'failed' | 'cancelled';
export type FailReason = 'unsupported_type' | 'too_large' | 'not_found' | 'network' | 'server';
export type Item = {
  key: string;
  file: File;
  eventId: string;
  tier: Tier;
  status: ItemStatus;
  sent: number;
  total: number;
  drops: number;
  reason?: FailReason;
  assetId?: string;
  pausedByOffline?: boolean;
};

const CHUNK = 8 * 1024 * 1024;
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
  const status = (err as { originalResponse?: { getStatus(): number } }).originalResponse?.getStatus?.();
  if (status === 415) return 'unsupported_type';
  if (status === 413) return 'too_large';
  if (status === 404) return 'not_found';
  if (status && status >= 500) return 'server';
  return 'network';
}

function startOne(it: Item) {
  const up = new tus.Upload(it.file, {
    endpoint: '/api/uploads',
    chunkSize: CHUNK,
    retryDelays: RETRY,
    headers: { 'X-Requested-With': 'acm-media' },
    metadata: { eventId: it.eventId, tier: it.tier, filename: it.file.name, filetype: it.file.type },
    storeFingerprintForResuming: true,
    removeFingerprintOnSuccess: true,
    onProgress: (sent, total) => patch(it.key, { sent, total }),
    onShouldRetry: (err, attempt) => {
      const status = err.originalResponse?.getStatus();
      const transient = !status || status >= 500 || status === 409 || status === 423;
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
      if (!navigator.onLine) patch(it.key, { status: 'paused', pausedByOffline: true });
      else patch(it.key, { status: 'failed', reason: reasonOf(err) });
      pump();
    },
  });
  uploads.set(it.key, up);
  patch(it.key, { status: 'uploading', reason: undefined });
  void up.findPreviousUploads().then((prev) => {
    if (prev[0]) up.resumeFromPreviousUpload(prev[0]);
    up.start();
  });
}

function pump() {
  if (!navigator.onLine) return;
  const running = items.filter((i) => i.status === 'uploading').length;
  for (const it of items.filter((i) => i.status === 'waiting').slice(0, Math.max(0, PARALLEL - running))) startOne(it);
}

export const uploader = {
  add(files: { file: File; tier: Tier }[], eventId: string) {
    const known = new Set(items.filter((i) => i.status !== 'cancelled' && i.status !== 'done').map((i) => i.key));
    for (const { file, tier } of files) {
      const key = fileKey(file);
      if (known.has(key)) continue;
      items.push({ key, file, eventId, tier, status: 'waiting', sent: 0, total: file.size, drops: 0 });
    }
    emit();
    pump();
  },
  pause(key: string) {
    patch(key, { status: 'paused', pausedByOffline: false });
    void uploads.get(key)?.abort(false);
    uploads.delete(key);
    pump();
  },
  resume(key: string) {
    patch(key, { status: 'waiting', pausedByOffline: false });
    pump();
  },
  retry(key: string) {
    patch(key, { status: 'waiting', drops: 0, reason: undefined });
    pump();
  },
  cancel(key: string) {
    const up = uploads.get(key);
    patch(key, { status: 'cancelled' });
    uploads.delete(key);
    void up?.abort(true); // terminates on the server, which deletes the "uploading" row
    pump();
  },
  pauseAll() {
    for (const i of items) if (i.status === 'uploading' || i.status === 'waiting') this.pause(i.key);
  },
  resumeAll() {
    for (const i of items) if (i.status === 'paused') patch(i.key, { status: 'waiting', pausedByOffline: false });
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
addEventListener('online', () => {
  for (const i of items) if (i.status === 'paused' && i.pausedByOffline) patch(i.key, { status: 'waiting', pausedByOffline: false });
  pump();
});
// Leaving the site mid-upload loses nothing (resume picks up), but warn anyway.
addEventListener('beforeunload', (e) => {
  if (items.some((i) => i.status === 'uploading' || i.status === 'waiting')) e.preventDefault();
});

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};
export const useUploads = () => useSyncExternalStore(subscribe, () => items);
