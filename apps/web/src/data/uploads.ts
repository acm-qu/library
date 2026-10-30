import { isUnfinished } from '@acm/core/status';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/uploads.ts';

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
