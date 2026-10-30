import { isUnfinished } from '@acm/core/status';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/library.ts';

export function useEvents(f: api.EventFilters) {
  return useInfiniteQuery({
    queryKey: ['events', f],
    queryFn: ({ pageParam }) => api.getEvents(f, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

export const useYears = () => useQuery({ queryKey: ['events', 'years'], queryFn: api.getYears, staleTime: 10 * 60_000 });

export const useEvent = (idOrSlug: string) => useQuery({ queryKey: ['event', idOrSlug], queryFn: () => api.getEvent(idOrSlug), enabled: !!idOrSlug });

/** Polls every 15 s while any loaded tile is still uploading, queued or processing (core members only see those). */
export function useEventAssets(eventId: string | undefined, f: api.AssetFilters) {
  return useInfiniteQuery({
    queryKey: ['event-assets', eventId, f],
    queryFn: ({ pageParam }) => api.getEventAssets(eventId!, f, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    enabled: !!eventId,
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (query.state.data?.pages.some((p) => p.items.some((a) => isUnfinished(a.status) || a.processing)) ? 15_000 : false),
  });
}

/** Refreshes the lists and years (the date may move it) and every cached detail, which is keyed by slug or by id. */
export function usePatchEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Parameters<typeof api.patchEvent>[1]) => api.patchEvent(id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['events'] });
      void qc.invalidateQueries({ queryKey: ['event'] });
    },
  });
}

export function useDeleteEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.deleteEvent,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['events'] });
      void qc.invalidateQueries({ queryKey: ['uploads'] });
      void qc.invalidateQueries({ queryKey: ['admin'] });
      // Marked stale but not refetched: the open event page would flash "not found" before it navigates away.
      void qc.invalidateQueries({ queryKey: ['event'], refetchType: 'none' });
      void qc.invalidateQueries({ queryKey: ['event-assets'], refetchType: 'none' });
    },
  });
}

export const useAsset = (id: string) => useQuery({ queryKey: ['asset', id], queryFn: () => api.getAsset(id) });

export const useLoginMosaic = () => useQuery({ queryKey: ['login-mosaic'], queryFn: api.getLoginMosaic, staleTime: 10 * 60_000, retry: false });
