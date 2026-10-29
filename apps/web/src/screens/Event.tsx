// Event page: cover, header, kind and tier filters, justified grid with status tiles.
import { useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router';
import { ApiError } from '../api/client.ts';
import { useEvent, useEventAssets } from '../data/library.ts';
import { useMe } from '../data/session.ts';
import { fmtDate } from '../i18n/format.ts';
import { Icon } from '../ui/Icon.tsx';
import { GridSkeleton, JustifiedGrid } from '../ui/JustifiedGrid.tsx';
import { MediaTile } from '../ui/MediaTile.tsx';
import { NotFound, ServerError } from './States.tsx';

type Kind = 'image' | 'video' | undefined;
type Tier = 'member' | 'core' | undefined;

export function EventScreen({ slug: slugProp }: { slug?: string } = {}) {
  const { t } = useTranslation();
  const params0 = useParams();
  const slug = slugProp ?? params0.slug ?? '';
  const me = useMe().data!;
  const isCore = me.role === 'core';
  const [params, setParams] = useSearchParams();
  const kind = (['image', 'video'].includes(params.get('kind') ?? '') ? params.get('kind') : undefined) as Kind;
  const tier = (isCore && ['member', 'core'].includes(params.get('tier') ?? '') ? params.get('tier') : undefined) as Tier;
  const ev = useEvent(slug);
  const assets = useEventAssets(ev.data?.id, { kind, tier });
  const items = useMemo(() => assets.data?.pages.flatMap((p) => p.items) ?? [], [assets.data]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = assets;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  useEffect(() => {
    if (ev.data) document.title = `${ev.data.title} · ${t('brand')}`;
  }, [ev.data, t]);

  if (ev.isError) return ev.error instanceof ApiError && ev.error.code === 'not_found' ? <NotFound /> : <ServerError onRetry={() => void ev.refetch()} />;
  if (ev.isPending)
    return (
      <>
        <div className="skel" style={{ height: 'var(--cover-h)' }} />
        <main id="main" className="wrap stack" aria-busy="true" style={{ paddingTop: 28, gap: 16 }}>
          <div className="skel" style={{ height: 40, width: 360, maxWidth: '100%' }} />
          <div className="skel" style={{ height: 18, width: 240 }} />
          <div style={{ marginTop: 16 }}>
            <GridSkeleton count={12} />
          </div>
        </main>
      </>
    );

  const e = ev.data;
  const setFilter = (k: 'kind' | 'tier', v: string | undefined) =>
    setParams(
      (p) => {
        if (v) p.set(k, v);
        else p.delete(k);
        return p;
      },
      { replace: true },
    );
  const meta = [fmtDate(e.startsOn) + (e.endsOn && e.endsOn !== e.startsOn ? ` – ${fmtDate(e.endsOn)}` : ''), e.location].filter(Boolean).join(' · ');
  const hasAny = e.photoCount + e.videoCount > 0 || items.length > 0;

  return (
    <>
      <div role="img" aria-label={t('event.coverLabel', { title: e.title })} style={{ position: 'relative', height: 'var(--cover-h)', background: 'linear-gradient(160deg, #5F6B74, #2F353A)', overflow: 'hidden' }}>
        {e.coverUrl && <img src={e.coverUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} onError={(x) => (x.currentTarget.style.display = 'none')} />}
        <Link to="/" className="btn btn-sm btn-on-media" style={{ position: 'absolute', top: 20, insetInlineStart: 'var(--gutter)' }}>
          <Icon name="back" className="flip" />
          {t('event.backToLibrary')}
        </Link>
      </div>

      <main id="main" className="wrap stack" style={{ flex: 1, paddingTop: 28, paddingBottom: 96, gap: 24 }}>
        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', gap: '16px 24px' }}>
          <div className="stack" style={{ flex: '1 1 520px', minWidth: 0, gap: 8 }}>
            <span className="t-sm muted">{meta}</span>
            <h1 className="t-display event-title">{e.title}</h1>
            {e.description && (
              <p className="t-body muted" style={{ maxWidth: 720, whiteSpace: 'pre-line' }}>
                {e.description}
              </p>
            )}
            {hasAny && <span className="t-sm subtle tnum">{t('event.countLine', { photos: e.photoCount, videos: e.videoCount })}</span>}
          </div>
          {isCore && (
            <div className="row" style={{ gap: 8 }}>
              <Link className="btn btn-p" to={`/upload?event=${e.id}`}>
                <Icon name="plus" />
                {t('event.addMedia')}
              </Link>
            </div>
          )}
        </div>

        {hasAny ? (
          <>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8, paddingBottom: 4 }}>
              <div role="group" aria-label={t('event.show')} className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                {([undefined, 'image', 'video'] as Kind[]).map((k) => (
                  <button key={k ?? 'all'} className="chip" aria-pressed={kind === k} onClick={() => setFilter('kind', k)}>
                    {t(k === 'image' ? 'event.photos' : k === 'video' ? 'event.videos' : 'event.all')}
                  </button>
                ))}
              </div>
              {isCore && (
                <>
                  <span aria-hidden="true" style={{ width: 1, height: 24, background: 'var(--border)', margin: '0 6px' }} />
                  <div role="group" aria-label={t('event.tier')} className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                    {([undefined, 'member', 'core'] as Tier[]).map((x) => (
                      <button key={x ?? 'any'} className="chip" aria-pressed={tier === x} onClick={() => setFilter('tier', x)}>
                        {t(x === 'member' ? 'event.memberTier' : x === 'core' ? 'event.coreTier' : 'event.anyTier')}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            {assets.isPending ? (
              <GridSkeleton count={12} />
            ) : assets.isError ? (
              <ServerError onRetry={() => void assets.refetch()} />
            ) : items.length === 0 ? (
              <p className="t-body muted">{t('event.noneMatch')}</p>
            ) : (
              <JustifiedGrid items={items} label={t('event.gridLabel')} hasMore={!!hasNextPage} loadMore={loadMore} renderTile={(a) => <MediaTile a={a} index={items.indexOf(a)} eventTitle={e.title} />} />
            )}
            {isFetchingNextPage && <GridSkeleton />}
          </>
        ) : isCore ? (
          <div className="center-col" style={{ maxWidth: 520, margin: '64px auto' }}>
            <Icon name="photos" style={{ width: 32, height: 32, color: 'var(--text-3)' }} />
            <h2 className="t-h1">{t('event.emptyCoreTitle')}</h2>
            <p className="t-body muted">{t('event.emptyCoreBody')}</p>
            <Link className="btn btn-p" to={`/upload?event=${e.id}`}>
              {t('event.addMedia')}
            </Link>
          </div>
        ) : (
          <div className="center-col" style={{ maxWidth: 520, margin: '64px auto' }}>
            <h2 className="t-h1">{t('event.emptyMemberTitle')}</h2>
            <p className="t-body muted">{t('event.emptyMemberBody')}</p>
          </div>
        )}
      </main>
    </>
  );
}
