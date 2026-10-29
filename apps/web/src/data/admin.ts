import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/admin.ts';

export const useUsers = (f: api.UserFilter) =>
  useInfiniteQuery({
    queryKey: ['admin', 'users', f],
    queryFn: ({ pageParam }) => api.getUsers(f, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });

/** The queue polls every 5 s while anything is running or waiting. */
export const useJobs = (tab: api.JobTab) =>
  useQuery({
    queryKey: ['admin', 'jobs', tab],
    queryFn: () => api.getJobs(tab),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data && q.state.data.summary.running + q.state.data.summary.queued > 0 ? 5000 : false),
  });

export const useProcessing = (id: string) =>
  useQuery({ queryKey: ['admin', 'processing', id], queryFn: () => api.getProcessing(id), refetchInterval: (q) => (q.state.data?.jobs.some((j) => j.state === 'queued' || j.state === 'running') ? 5000 : false) });
export const useStorage = () => useQuery({ queryKey: ['admin', 'storage'], queryFn: api.getStorage });
export const useSettings = () => useQuery({ queryKey: ['admin', 'settings'], queryFn: api.getSettings });

/** Mutations refresh everything admin-related (and the library, whose tiles may change). */
export function useAdminMutation<A extends unknown[], R>(fn: (...a: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: A) => fn(...args),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin'] });
      void qc.invalidateQueries({ queryKey: ['event-assets'] });
      void qc.invalidateQueries({ queryKey: ['asset'] });
    },
  });
}
