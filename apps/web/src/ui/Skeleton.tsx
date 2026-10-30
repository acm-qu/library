// Skeleton blocks (the board's .skel shimmer) and the image fade-in used over them.
import type { CSSProperties, SyntheticEvent } from 'react';

/** One placeholder block. Always aria-hidden: the loading region around it carries aria-busy and the label. */
export function Skeleton({ w = '100%', h, round, style }: { w?: number | string; h: number | string; round?: boolean; style?: CSSProperties }) {
  return <span className={round ? 'skel round' : 'skel'} aria-hidden="true" style={{ display: 'block', flex: 'none', width: w, height: h, maxWidth: '100%', ...style }} />;
}

/** Placeholder table rows: a two-line first cell (name + detail) and one line per other cell, like the admin tables. */
export function SkeletonRows({ rows, cols }: { rows: number; cols: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} aria-hidden="true">
          {Array.from({ length: cols }, (_, c) => (
            <td key={c}>
              {c === 0 ? (
                <span className="stack" style={{ gap: 6 }}>
                  <Skeleton h={20} w={`${60 + ((r * 7) % 30)}%`} />
                  <Skeleton h={15} w="40%" />
                </span>
              ) : (
                <Skeleton h={16} w={c === cols - 1 ? 64 : '60%'} />
              )}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** Spread on an <img>: it fades in once loaded instead of popping; an image already in the cache shows at once. */
export const fadeIn = {
  className: 'fade',
  ref: (el: HTMLImageElement | null) => {
    if (el?.complete && el.naturalWidth) el.dataset.loaded = '';
  },
  onLoad: (e: SyntheticEvent<HTMLImageElement>) => {
    e.currentTarget.dataset.loaded = '';
  },
};

/** Per-item index for the staggered reveal (.reveal reads --i; the CSS caps the delay). */
export const revealIndex = (i: number) => ({ '--i': i }) as CSSProperties;
