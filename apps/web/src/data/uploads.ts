import { isUnfinished } from '@acm/core/status';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import * as api from '../api/uploads.ts';
import { type Item, uploader, useUploads } from '../lib/uploader.ts';

/**
 * Polls every 4 s while something is uploading or processing (the top bar's chip, on every page), 15 s while anything
 * else is unfinished. With `live` (My uploads) the bars move from useUploadProgress instead, so the list stays at 15 s.
 */
export function useMyUploads(bucket: api.Bucket, enabled = true, live = false) {
  return useInfiniteQuery({
    queryKey: ['uploads', 'mine', bucket],
    queryFn: ({ pageParam }) => api.getMyUploads(bucket, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    enabled,
    refetchInterval: (query) => {
      const pages = query.state.data?.pages ?? [];
      const items = pages.flatMap((p) => p.items);
      if (!live && items.some((i) => i.status === 'uploading' || i.status === 'processing')) return 4_000;
      return pages[0] && (pages[0].counts.active > 0 || items.some((i) => isUnfinished(i.status))) ? 15_000 : false;
    },
  });
}

/**
 * Every second while `enabled`: the status and progress of the caller's unfinished uploads (one small query). When
 * any status differs from the last answer, the full My uploads list is re-fetched.
 */
export function useUploadProgress(enabled: boolean) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['uploads', 'progress'], queryFn: api.getUploadProgress, enabled, refetchInterval: enabled ? 1_000 : false });
  const statuses = (q.data?.items ?? []).map((i) => `${i.assetId}:${i.status}`).join('|');
  useEffect(() => {
    if (q.data) void qc.invalidateQueries({ queryKey: ['uploads', 'mine'] });
  }, [statuses]); // eslint-disable-line react-hooks/exhaustive-deps -- only a status change should refresh the list
  return useMemo(() => new Map((q.data?.items ?? []).map((i) => [i.assetId, i])), [q.data]);
}

/** Refreshes My uploads as soon as one of this browser's uploads starts, finishes or fails, instead of at the next poll. */
export function useRefreshOnUploadChange() {
  const qc = useQueryClient();
  const states = useUploads()
    .map((u) => `${u.key}:${u.status}`)
    .join('|');
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: ['uploads', 'mine'] });
  }, [states, qc]);
}

export function useRetry() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: api.retryUpload, onSuccess: () => qc.invalidateQueries({ queryKey: ['uploads'] }) });
}

export function useCreateEvent() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: api.createEvent, onSuccess: () => qc.invalidateQueries({ queryKey: ['events'] }) });
}

export const useExisting = (eventId: string | undefined) =>
  useQuery({ queryKey: ['uploads', 'existing', eventId], queryFn: () => api.getExisting(eventId!), enabled: !!eventId, staleTime: 30_000 });

const QUEUE_KEY = ['uploads', 'queue'];
/** This tab holds tickets that haven't started: polling the queue is what keeps them alive and starts them when granted. */
const holdsTickets = (items: Item[]) => items.some((i) => i.ticketId && (i.status === 'queued' || i.status === 'waiting'));

/** Mounted once in the app shell: polls the queue every 5 s while this tab holds unstarted tickets, and feeds the uploader. */
export function useUploadQueueSync(enabled: boolean) {
  const holding = holdsTickets(useUploads());
  const q = useQuery({ queryKey: QUEUE_KEY, queryFn: api.getUploadQueue, enabled: enabled && holding, refetchInterval: 5000 });
  useEffect(() => {
    if (q.data) uploader.sync(q.data);
  }, [q.data]);
}

/** The queue panel. Polls on its own only when the shell isn't already polling for this tab: 5 s while anyone is in it, else 15 s. */
export function useUploadQueue() {
  const holding = holdsTickets(useUploads());
  return useQuery({ queryKey: QUEUE_KEY, queryFn: api.getUploadQueue, refetchInterval: (query) => (holding ? false : query.state.data?.items.length ? 5000 : 15_000) });
}
