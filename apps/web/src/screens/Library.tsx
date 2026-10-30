// Library (home): events grouped by year, search, year filter, "Has videos", infinite scroll.
import type { EventCard } from '@acm/core/schemas';
import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { useEvents, useYears } from '../data/library.ts';
import { useMe } from '../data/session.ts';
import { fmtDate } from '../i18n/format.ts';
import { Icon } from '../ui/Icon.tsx';
import { SearchBox } from '../ui/SearchBox.tsx';
import { Select } from '../ui/Select.tsx';
import { fadeIn, revealIndex, Skeleton } from '../ui/Skeleton.tsx';

export function LibraryScreen() {
  const { t } = useTranslation();
  const isCore = useMe().data?.role === 'core';
  const [params, setParams] = useSearchParams();
  const qText = params.get('q')?.trim() || undefined;
  const year = Number(params.get('year')) || undefined;
  const hasVideos = params.get('videos') === '1';
  const filters = { q: qText, year, hasVideos };
  const events = useEvents(filters);
  const years = useYears();
  const items = useMemo(() => events.data?.pages.flatMap((p) => p.items) ?? [], [events.data]);
  useEffect(() => {
    document.title = `${t('library.title')} · ${t('brand')}`;
  }, [t]);

  const set = (k: string, v: string | null) =>
    setParams(
      (p) => {
        if (v) p.set(k, v);
        else p.delete(k);
        return p;
      },
      { replace: true },
    );

  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es[0]?.isIntersecting && events.hasNextPage && !events.isFetchingNextPage && void events.fetchNextPage(), { rootMargin: '800px' });
    io.observe(el);
    return () => io.disconnect();
  }, [events]);

  const groups = useMemo(() => {
    const m = new Map<string, EventCard[]>();
    for (const e of items) {
      const y = e.startsOn.slice(0, 4);
      m.set(y, [...(m.get(y) ?? []), e]);
    }
    return [...m.entries()];
  }, [items]);

  const filtersUi = (
    <div className="row" style={{ gap: 8 }}>
      <label className="vh" htmlFor="yr">
        {t('library.year')}
      </label>
      <Select
        id="yr"
        variant="chip"
        value={year ? String(year) : ''}
        options={[{ value: '', label: t('library.allYears') }, ...(years.data?.years ?? []).map((y) => ({ value: String(y), label: String(y) }))]}
        onChange={(v) => set('year', v || null)}
      />
      <button className="chip" aria-pressed={hasVideos} onClick={() => set('videos', hasVideos ? null : '1')}>
        <Icon name="video" size="sm" />
        {t('library.hasVideos')}
      </button>
    </div>
  );

  let body;
  if (events.isPending) body = <CoversSkeleton count={8} busyLabel={t('library.loading')} />;
  else if (events.isError)
    body = (
      <div role="alert" className="center-col" style={{ maxWidth: 520, margin: '96px auto' }}>
        <Icon name="alert" style={{ width: 32, height: 32, color: 'var(--danger)' }} />
        <h1 className="t-h1">{t('library.errorTitle')}</h1>
        <p className="t-body muted">{t('library.errorBody')}</p>
        <button className="btn btn-p" onClick={() => void events.refetch()}>
          <Icon name="refresh" />
          {t('states.tryAgain')}
        </button>
      </div>
    );
  else if (qText)
    body = items.length ? (
      <>
        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'baseline', gap: 12, borderBottom: '1px solid var(--border)', paddingBottom: 10 }}>
          <h1 className="t-h1">{t('library.resultsFor', { q: qText })}</h1>
          <span className="muted tnum">{t('library.eventCount', { n: items.length })}</span>
          <span className="grow" />
          <button className="btn btn-g btn-sm" onClick={() => set('q', null)}>
            {t('library.clearSearch')}
          </button>
        </div>
        <div className="covers">
          {items.map((e, i) => (
            <Cover key={e.id} e={e} i={i} isCore={isCore} showDate />
          ))}
        </div>
      </>
    ) : (
      <div className="center-col" style={{ maxWidth: 520, margin: '96px auto' }}>
        <Icon name="search" style={{ width: 32, height: 32, color: 'var(--text-3)' }} />
        <h1 className="t-h2">{t('library.noResultsTitle', { q: qText })}</h1>
        <p className="t-body muted">{t('library.noResultsBody')}</p>
        <button className="btn btn-s" onClick={() => set('q', null)}>
          {t('library.clearSearch')}
        </button>
      </div>
    );
  else if (!items.length && !year && !hasVideos)
    body = isCore ? (
      <div className="center-col" style={{ maxWidth: 520, margin: '96px auto' }}>
        <Icon name="photos" style={{ width: 32, height: 32, color: 'var(--text-3)' }} />
        <h1 className="t-h1">{t('library.emptyCoreTitle')}</h1>
        <p className="t-body muted">{t('library.emptyCoreBody')}</p>
        <Link className="btn btn-p" to="/upload">
          <Icon name="plus" />
          {t('library.createFirst')}
        </Link>
      </div>
    ) : (
      <div className="center-col" style={{ maxWidth: 520, margin: '96px auto' }}>
        <Icon name="photos" style={{ width: 32, height: 32, color: 'var(--text-3)' }} />
        <h1 className="t-h1">{t('library.emptyMemberTitle')}</h1>
        <p className="t-body muted">{t('library.emptyMemberBody')}</p>
      </div>
    );
  else
    body = (
      <>
        {(groups.length ? groups : [[String(year ?? new Date().getFullYear()), []] as [string, EventCard[]]]).map(([y, evs], gi) => (
          <section key={y} className="stack" style={{ gap: 20 }} aria-labelledby={`y-${y}`}>
            <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', gap: '12px 16px', borderBottom: '1px solid var(--border)', paddingBottom: 10 }}>
              <h2 className="t-display" id={`y-${y}`} style={{ fontSize: 40, lineHeight: '44px' }}>
                {y}
              </h2>
              <span className="grow" />
              {gi === 0 && filtersUi}
            </div>
            {evs.length ? (
              <div className="covers">
                {evs.map((e, i) => (
                  <Cover key={e.id} e={e} i={i} isCore={isCore} />
                ))}
              </div>
            ) : (
              <p className="t-body muted">{t('event.noneMatch')}</p>
            )}
          </section>
        ))}
        {events.isFetchingNextPage && <CoversSkeleton count={4} />}
        <span className="vh" aria-live="polite">
          {events.isFetchingNextPage ? t('library.loadingMore') : ''}
        </span>
      </>
    );

  return (
    <main id="main" className="wrap" style={{ flex: 1, paddingTop: 32, paddingBottom: 64, display: 'flex', flexDirection: 'column', gap: 28 }}>
      <div className="show-sm">
        <SearchBox big />
      </div>
      {body}
      <div ref={sentinel} aria-hidden="true" />
    </main>
  );
}

function Cover({ e, i, isCore, showDate }: { e: EventCard; i: number; isCore: boolean; showDate?: boolean }) {
  const { t } = useTranslation();
  const counts = t('library.counts', { photos: e.photoCount, videos: e.videoCount, both: e.photoCount && e.videoCount ? 'yes' : 'no' });
  return (
    <Link to={`/events/${e.slug}`} aria-label={t('library.cardLabel', { title: e.title, date: fmtDate(e.startsOn), counts })} className="stack reveal" style={{ gap: 10, color: 'var(--text)', textDecoration: 'none', ...revealIndex(i) }}>
      <div className={e.coverUrl ? 'cover tile skel' : 'cover tile'} style={e.coverUrl ? undefined : { background: 'linear-gradient(160deg, var(--surface-3), var(--surface-2))' }}>
        {isCore && e.hasCore && (
          <span className="mb" title={t('library.hasCore')} style={{ position: 'absolute', top: 8, insetInlineStart: 8, zIndex: 1 }}>
            <Icon name="shield" />
          </span>
        )}
        {e.coverUrl && <img {...fadeIn} src={e.coverUrl} alt="" loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} onError={(ev) => ((ev.currentTarget.style.display = 'none'), (ev.currentTarget.dataset.loaded = ''))} />}
      </div>
      <span className="t-cover">{e.title}</span>
      {showDate && (
        <span className="t-sm muted" style={{ marginTop: -6 }}>
          {fmtDate(e.startsOn)}
        </span>
      )}
    </Link>
  );
}

function CoversSkeleton({ count, busyLabel }: { count: number; busyLabel?: string }) {
  const widths = ['70%', '55%', '62%', '48%', '66%', '52%', '74%', '58%'];
  const covers = (
    <div className="covers" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="stack" style={{ gap: 10 }}>
          <div className="cover skel" />
          <Skeleton h={24} w={widths[i % widths.length]} />
        </div>
      ))}
    </div>
  );
  if (!busyLabel) return covers;
  // First load: also the year heading and filter row, so the real section lands in the same place.
  return (
    <section className="stack" style={{ gap: 20 }} aria-busy="true" aria-label={busyLabel}>
      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', gap: '12px 16px', borderBottom: '1px solid var(--border)', paddingBottom: 10 }}>
        <Skeleton h={44} w={104} />
        <span className="grow" />
        <Skeleton h="var(--h-ctl-sm)" w={120} />
        <Skeleton h="var(--h-ctl-sm)" w={136} />
      </div>
      {covers}
    </section>
  );
}
