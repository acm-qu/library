/** Only same-origin paths are allowed as a post-login destination. */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\') || next.startsWith('/login')) return '/';
  return next;
}
