// The event grid: justified rows, virtualized by row against the window scroll, with the next page requested
// when the last rendered row comes within two screens of the viewport.
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { aspect, justify } from './justify.ts';
import { revealIndex } from './Skeleton.tsx';

type Item = { id: string; width: number | null; height: number | null };

export function JustifiedGrid<T extends Item>({
  items,
  renderTile,
  hasMore,
  loadMore,
  label,
}: {
  items: T[];
  renderTile: (item: T, size: { w: number; h: number }) => ReactNode;
  hasMore: boolean;
  loadMore: () => void;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [offset, setOffset] = useState(0);
  // Rows on screen when the grid first appears rise in; rows virtualized in later while scrolling just appear.
  const mountedAt = useRef(performance.now());
  const intro = performance.now() - mountedAt.current < 1500;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth);
      setOffset(el.getBoundingClientRect().top + window.scrollY);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const phone = width > 0 && width < 600;
  const target = phone ? 116 : 170;
  const gap = phone ? 3 : 6;
  const rows = useMemo(() => (width ? justify(items.map((it) => ({ ...it, ar: aspect(it.width, it.height) })), width, target, gap) : []), [items, width, target, gap]);

  const v = useWindowVirtualizer({
    count: rows.length,
    estimateSize: (i) => (rows[i]?.height ?? target) + gap,
    overscan: 4,
    scrollMargin: offset,
  });
  useEffect(() => v.measure(), [rows, v]);

  const virtualRows = v.getVirtualItems();
  const lastShown = virtualRows.at(-1)?.index ?? 0;
  const screensLeft = rows.length ? ((rows.at(-1)!.top - (rows[lastShown]?.top ?? 0)) / window.innerHeight) : 0;
  useEffect(() => {
    if (hasMore && screensLeft < 2) loadMore();
  }, [hasMore, screensLeft, loadMore, items.length]);

  return (
    <div ref={ref} role="list" aria-label={label} style={{ position: 'relative', height: v.getTotalSize() }}>
      {virtualRows.map((vr) => {
        const row = rows[vr.index]!;
        return (
          <div key={vr.key} role="presentation" style={{ position: 'absolute', top: 0, insetInlineStart: 0, width: '100%', display: 'flex', gap, transform: `translateY(${vr.start - v.options.scrollMargin}px)` }}>
            {row.items.map((it, j) => (
              <div key={it.id} role="listitem" className={intro ? 'reveal' : undefined} style={{ width: it.w, height: row.height, flex: 'none', ...revealIndex(vr.index + j) }}>
                {renderTile(it, { w: it.w, h: row.height })}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** Skeleton rows from the board, at the grid's row height: shown while the first or the next page loads. */
export function GridSkeleton({ count = 5 }: { count?: number }) {
  const ars = [1.5, 0.75, 1.5, 1.33, 1.5, 1, 1.78, 0.75];
  return (
    <div className="jgrid" aria-hidden="true" style={{ opacity: 0.7 }}>
      {Array.from({ length: count }, (_, i) => {
        const ar = ars[i % ars.length]!;
        return <div key={i} className="skel" style={{ flex: `${ar} 1 calc(${ar} * var(--tile-h))` }} />;
      })}
    </div>
  );
}
