// The only place the web app calls fetch. Every response is parsed with the same zod schema the API uses.
import { ApiErrorBody, type ErrorCode } from '@acm/core/schemas';
import type { z } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode | 'network',
    readonly status: number,
    readonly body: Partial<ApiErrorBody> = {},
  ) {
    super(body.message ?? code);
  }
  static from(json: unknown, status: number) {
    const r = ApiErrorBody.safeParse(json);
    return r.success ? new ApiError(r.data.error, status, r.data) : new ApiError(status >= 500 ? 'internal' : 'bad_request', status);
  }
}

/** Raised on any 401 except from the auth routes; the app shell turns it into the "session ended" dialog. */
export class SessionExpired extends ApiError {
  constructor() {
    super('unauthorized', 401);
  }
}

const listeners = new Set<() => void>();
export function onSessionExpired(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export async function call<S extends z.ZodType>(schema: S | null, path: string, init: RequestInit & { json?: unknown } = {}): Promise<z.infer<S>> {
  const { json, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      ...rest,
      headers: {
        'X-Requested-With': 'acm-media',
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...rest.headers,
      },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiError('network', 0);
  }
  if (res.status === 401 && !path.startsWith('/auth/') && path !== '/me') {
    listeners.forEach((fn) => fn());
    throw new SessionExpired();
  }
  if (!res.ok) throw ApiError.from(await res.json().catch(() => null), res.status);
  if (res.status === 204 || schema === null) return undefined as z.infer<S>;
  return schema.parse(await res.json());
}

export const q = (params: Record<string, string | number | boolean | undefined | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
};
