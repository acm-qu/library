import type { Me } from '@acm/core/schemas';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/auth.ts';

export const ME_KEY = ['me'] as const;

export const useMe = () => useQuery({ queryKey: ME_KEY, queryFn: api.getMe, staleTime: 5 * 60_000, retry: false });

export const useRequestCode = () => useMutation({ mutationFn: (email: string) => api.requestCode(email) });

export function useVerify() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ email, code }: { email: string; code: string }) => api.verify(email, code),
    onSuccess: (me) => qc.setQueryData<Me | null>(ME_KEY, me),
  });
}

export function useLogout(all = false) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => (all ? api.logoutAll() : api.logout()),
    onSuccess: () => {
      qc.clear();
      qc.setQueryData(ME_KEY, null);
    },
  });
}

export function usePatchMe() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: api.patchMe, onSuccess: (me) => qc.setQueryData(ME_KEY, me) });
}
