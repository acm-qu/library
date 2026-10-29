// Event slugs are assigned once and never change: start date + ASCII-folded title ("2026-10-28-hackathon-day-1").
// A title that folds to nothing (e.g. Arabic) uses a short id instead. Collisions get -2, -3, ...
export function baseSlug(title: string, startsOn: string, id: string): string {
  const folded = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return `${startsOn}-${folded || id.replaceAll('-', '').slice(-8)}`;
}

export const withSuffix = (base: string, n: number) => (n <= 1 ? base : `${base}-${n}`);
