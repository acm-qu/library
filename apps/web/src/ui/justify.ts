// Justified rows (pure, tested): fill each row to the container width at roughly the target height, using the
// probe's width/height so rows are laid out before any image loads. The last row keeps the target height.
export type Box = { ar: number };
export type Row<T> = { items: (T & { w: number })[]; height: number; top: number };

export const aspect = (w: number | null | undefined, h: number | null | undefined) =>
  w && h ? Math.min(3, Math.max(0.4, w / h)) : 4 / 3;

export function justify<T extends Box>(items: T[], width: number, target: number, gap: number): Row<T>[] {
  const rows: Row<T>[] = [];
  let cur: T[] = [];
  let sum = 0;
  let top = 0;
  const flush = (height: number) => {
    rows.push({ items: cur.map((it) => ({ ...it, w: it.ar * height })), height, top });
    top += height + gap;
    cur = [];
    sum = 0;
  };
  for (const it of items) {
    cur.push(it);
    sum += it.ar;
    const h = (width - gap * (cur.length - 1)) / sum;
    if (h <= target) flush(h);
  }
  if (cur.length) flush(Math.min(target, (width - gap * (cur.length - 1)) / sum));
  return rows;
}
