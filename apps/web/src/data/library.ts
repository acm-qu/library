import { isUnfinished } from '@acm/core/status';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
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

export const useEvent = (idOrSlug: string) => useQuery({ queryKey: ['event', idOrSlug], queryFn: () => api.getEvent(idOrSlug) });

/** Polls every 5 s while any loaded tile is still uploading, queued or processing (core members only see those). */
export function useEventAssets(eventId: string | undefined, f: api.AssetFilters) {
  return useInfiniteQuery({
    queryKey: ['event-assets', eventId, f],
    queryFn: ({ pageParam }) => api.getEventAssets(eventId!, f, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    enabled: !!eventId,
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (query.state.data?.pages.some((p) => p.items.some((a) => isUnfinished(a.status) || a.processing)) ? 5000 : false),
  });
}

export const useAsset = (id: string) => useQuery({ queryKey: ['asset', id], queryFn: () => api.getAsset(id) });
