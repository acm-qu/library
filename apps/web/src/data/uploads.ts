import { isUnfinished } from '@acm/core/status';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import * as api from '../api/uploads.ts';
import { type Item, uploader, useUploads } from '../lib/uploader.ts';

/** Polls every 15 s while anything is unfinished, which keeps entry processes low on the host. */
export function useMyUploads(bucket: api.Bucket, enabled = true) {
  return useInfiniteQuery({
    queryKey: ['uploads', 'mine', bucket],
    queryFn: ({ pageParam }) => api.getMyUploads(bucket, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    enabled,
    refetchInterval: (query) => {
      const first = query.state.data?.pages[0];
      return first && (first.counts.active > 0 || query.state.data!.pages.some((p) => p.items.some((i) => isUnfinished(i.status)))) ? 15_000 : false;
    },
  });
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
