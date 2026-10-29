// Theme preference: 'system' follows prefers-color-scheme. Stored per browser; applied to <html data-theme>.
import { useSyncExternalStore } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'acm.theme';
const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
const subs = new Set<() => void>();

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}
let pref = read();
export const resolved = (p: ThemePref = pref) => (p === 'system' ? (media?.matches ? 'dark' : 'light') : p);

function apply() {
  document.documentElement.dataset.theme = resolved();
  subs.forEach((f) => f());
}
media?.addEventListener('change', apply);
apply();

export function setTheme(p: ThemePref) {
  pref = p;
  try {
    if (p === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, p);
  } catch {
    /* ignore */
  }
  apply();
}
/** The top-bar button flips between light and dark from whatever is showing now. */
export const toggleTheme = () => setTheme(resolved() === 'dark' ? 'light' : 'dark');

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};
export const useTheme = () => ({
  pref: useSyncExternalStore(subscribe, () => pref),
  resolved: useSyncExternalStore(subscribe, () => resolved()),
});
