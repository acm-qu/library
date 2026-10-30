// Image viewer / video player shell (Viewer and Player boards): always dark, keyboard ← → I Z Esc, focus kept
// inside the dialog, thumbnail first then the view copy, downloads in the info panel.
import type { AssetDetail, AssetTile } from '@acm/core/schemas';
import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, type Location, useNavigate } from 'react-router';
import { useAsset, useEvent } from '../data/library.ts';
import { useMe } from '../data/session.ts';
import { fmtBytes, fmtDate, fmtDateTime } from '../i18n/format.ts';
import { Icon } from '../ui/Icon.tsx';
import { Skeleton } from '../ui/Skeleton.tsx';

/** The loaded grid order for this event, from whichever event-assets query holds the asset. */
function useNeighbours(assetId: string) {
  const qc = useQueryClient();
  return useMemo(() => {
    for (const [, data] of qc.getQueriesData<{ pages: { items: AssetTile[] }[] }>({ queryKey: ['event-assets'] })) {
      const list = data?.pages.flatMap((p) => p.items) ?? [];
      const i = list.findIndex((a) => a.id === assetId);
      if (i >= 0) return { list, i };
    }
    return { list: [] as AssetTile[], i: -1 };
  }, [qc, assetId]);
}

export function Lightbox({ assetId, background, onClose: close, player }: { assetId: string; background?: Location; onClose: () => void; player?: (a: AssetDetail) => ReactNode }) {
  const { t } = useTranslation();
  // Closing plays the short fade-out first (skipped when motion is reduced); a second Esc during it does nothing.
  const [closing, setClosing] = useState(false);
  const onClose = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? close() : setClosing(true));
  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(close, 180);
    return () => clearTimeout(timer);
  }, [closing]); // not on close: the parent passes a new one every render, which would restart the timer
  const navigate = useNavigate();
  const me = useMe().data;
  const asset = useAsset(assetId);
  const a = asset.data;
  const event = useEvent(a?.eventId ?? '');
  const { list, i } = useNeighbours(assetId);
  const [info, setInfo] = useState(() => matchMedia('(min-width: 761px)').matches);
  const [zoom, setZoom] = useState(false);
  const [scale, setScale] = useState(2);
  const img = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(document.activeElement);

  useEffect(() => {
    setZoom(false);
    setLoaded(false);
    setFailed(false);
  }, [assetId]);
  useEffect(() => {
    dialog.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const back = opener.current;
    return () => {
      document.body.style.overflow = prevOverflow;
      if (back instanceof HTMLElement) back.focus();
    };
  }, []);
  useEffect(() => {
    if (a && event.data) document.title = `${a.kind === 'video' ? t('viewer.videoDialog') : t('viewer.dialog')} · ${event.data.title}`;
  }, [a, event.data, t]);

  const go = useCallback(
    (delta: number) => {
      const next = list[i + delta];
      if (next) navigate(`/p/${next.id}`, { replace: true, state: background ? { background } : undefined });
    },
    [list, i, navigate, background],
  );

  // Zoom scales the image in place (the stage never scrolls, so the arrows stay put); the point under the pointer is
  // the anchor, and moving the pointer moves it, which pans. At 100% of the photo's own pixels, or 1.5× if it's small.
  const zoomTo = (on: boolean, x?: number, y?: number) => {
    const el = img.current;
    if (on && el) {
      setScale(Math.max(1.5, el.naturalWidth / el.offsetWidth));
      aim(el, x, y);
    }
    setZoom(on);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const rtl = document.documentElement.dir === 'rtl';
    if (k === 'escape') onClose();
    else if (k === 'arrowright') go(rtl ? -1 : 1);
    else if (k === 'arrowleft') go(rtl ? 1 : -1);
    else if (k === 'i') setInfo((v) => !v);
    else if (k === 'z' && a?.kind === 'image') zoomTo(!zoom);
    else if (k === 'tab') trapTab(e, dialog.current);
    else return;
    if (k !== 'tab') e.preventDefault();
  };

  const total = event.data ? event.data.photoCount + event.data.videoCount : list.length;
  const eventTitle = event.data?.title ?? '';
  const alt = t('viewer.alt', { event: eventTitle, date: event.data ? fmtDate(event.data.startsOn) : '' });

  return (
    <div
      ref={dialog}
      className="lightbox"
      data-theme="dark"
      role="dialog"
      aria-modal="true"
      aria-label={a?.kind === 'video' ? t('viewer.videoDialog') : t('viewer.dialog')}
      tabIndex={-1}
      onKeyDown={closing ? undefined : onKey}
      data-closing={closing || undefined}
    >
      <div className="lb-bar">
        <button className="btn btn-g btn-ic" aria-label={t('viewer.close')} onClick={onClose}>
          <Icon name="close" />
        </button>
        {i >= 0 && <span className="t-sm tnum lb-dim">{t('viewer.position', { n: i + 1, total: Math.max(total, list.length) })}</span>}
        <span className="grow" />
        {a?.kind === 'image' && a.viewUrl && (
          <div className="hide-sm row" style={{ gap: 4 }}>
            <button className="btn btn-g btn-ic" aria-label={t('viewer.zoomOut')} onClick={() => zoomTo(false)} disabled={!zoom}>
              <Icon name="zoomOut" />
            </button>
            <span className="t-sm tnum lb-dim" style={{ display: 'grid', placeItems: 'center', minWidth: 52 }}>
              {zoom ? '100%' : t('viewer.fit')}
            </span>
            <button className="btn btn-g btn-ic" aria-label={t('viewer.zoomIn')} onClick={() => zoomTo(true)} disabled={zoom}>
              <Icon name="zoomIn" />
            </button>
          </div>
        )}
        <button className="btn btn-g btn-ic" aria-label={a?.kind === 'video' ? t('viewer.videoInfo') : t('viewer.info')} aria-pressed={info} onClick={() => setInfo((v) => !v)} style={info ? { background: '#292A2E' } : undefined}>
          <Icon name="info" />
        </button>
        {a?.originalUrl && (
          <a className="btn btn-p btn-sm" href={a.originalUrl} download={a.downloadName}>
            <Icon name="download" />
            <span className="hide-sm">{t('viewer.download')}</span>
          </a>
        )}
      </div>

      <div className="lb-body">
        <div className={`lb-stage${zoom ? ' zoomed' : ''}`} onPointerMove={zoom ? (e) => img.current && aim(img.current, e.clientX, e.clientY) : undefined}>
          <button className="btn btn-ic btn-on-media lb-nav lb-prev" aria-label={t('viewer.prev')} onClick={() => go(-1)} disabled={i <= 0}>
            <Icon name="back" className="flip" />
          </button>
          {!a ? (
            <div aria-busy="true" aria-label={t('states.loading')} style={{ width: 'min(100%, 1080px, calc((100vh - 120px) * 1.5))' }}>
              <Skeleton h="auto" style={{ aspectRatio: '3 / 2' }} />
            </div>
          ) : a.kind === 'video' ? (
            player ? player(a) : null
          ) : !a.viewUrl ? (
            <div className="lb-msg">
              <span className="t-h2">{a.status === 'original_only' ? t('viewer.originalOnly') : t('viewer.notReady')}</span>
            </div>
          ) : failed ? (
            <div className="lb-msg" role="alert">
              <Icon name="alert" size="lg" style={{ color: '#FF8F84' }} />
              <span className="t-h2">{t('viewer.failedTitle')}</span>
              <span className="t-sm lb-dim">{t('viewer.failedBody')}</span>
              <button className="btn btn-s btn-sm" onClick={() => setFailed(false)}>
                {t('viewer.tryAgain')}
              </button>
            </div>
          ) : (
            <>
              {!loaded && a.thumbUrl && <img className="lb-img lb-placeholder" src={a.thumbUrl} alt="" aria-hidden="true" />}
              <img
                ref={img}
                key={a.viewUrl}
                className="lb-img"
                src={a.viewUrl}
                alt={alt}
                onLoad={() => setLoaded(true)}
                onError={() => setFailed(true)}
                onClick={(e) => (zoom ? zoomTo(false) : zoomTo(true, e.clientX, e.clientY))}
                style={loaded ? (zoom ? { transform: `scale(${scale})` } : undefined) : { position: 'absolute', opacity: 0 }}
              />
              {!loaded && (
                <span className="lb-loading row" aria-live="polite">
                  <Icon name="spinner" className="spin" />
                  <span className="t-sm">{t('viewer.loadingFull')}</span>
                </span>
              )}
            </>
          )}
          <button className="btn btn-ic btn-on-media lb-nav lb-next" aria-label={t('viewer.next')} onClick={() => go(1)} disabled={i < 0 || i >= list.length - 1}>
            <Icon name="back" className="flip" style={{ transform: 'scaleX(-1)' }} />
          </button>
          {a?.kind === 'image' && (
            <div className="hide-sm t-xs lb-keys">
              <span>
                <span className="kbd">←</span> <span className="kbd">→</span> {t('viewer.keys')}
              </span>
              <span>
                <span className="kbd">I</span> {t('viewer.keyInfo')}
              </span>
              <span>
                <span className="kbd">Z</span> {t('viewer.keyZoom')}
              </span>
              <span>
                <span className="kbd">Esc</span> {t('viewer.keyClose')}
              </span>
            </div>
          )}
        </div>

        {info && !a && (
          <aside className="lb-info" aria-hidden="true">
            <div className="stack" style={{ gap: 8 }}>
              <Skeleton h={24} w="70%" />
              <Skeleton h={20} w="40%" />
            </div>
            <div className="stack" style={{ gap: 12 }}>
              {[0, 1, 2, 3].map((n) => (
                <Skeleton key={n} h={20} w={`${80 - n * 10}%`} />
              ))}
            </div>
            <Skeleton h="var(--h-ctl)" />
          </aside>
        )}
        {info && a && (
          <aside className="lb-info" aria-label={a.kind === 'video' ? t('viewer.videoInfo') : t('viewer.info')}>
            <div className="row" style={{ alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
              <div className="stack" style={{ gap: 4 }}>
                {event.data && (
                  <Link to={`/events/${event.data.slug}`} className="t-cover" style={{ color: 'var(--text)', textDecoration: 'none' }}>
                    {event.data.title}
                  </Link>
                )}
                {event.data && <span className="t-sm muted">{fmtDate(event.data.startsOn)}</span>}
              </div>
              {(a.tier === 'core' || a.girlsOnly) && (
                <span className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {a.tier === 'core' && (
                    <span className="tier">
                      <Icon name="shield" />
                      {t('viewer.core')}
                    </span>
                  )}
                  {a.girlsOnly && (
                    <span className="tier">
                      <Icon name="person" />
                      {t('viewer.girlsOnly')}
                    </span>
                  )}
                </span>
              )}
            </div>
            <dl className="lb-dl">
              {a.capturedAt && (
                <>
                  <dt className="subtle">{t('viewer.taken')}</dt>
                  <dd className="tnum">{fmtDateTime(a.capturedAt)}</dd>
                </>
              )}
              {a.device && (
                <>
                  <dt className="subtle">{t('viewer.camera')}</dt>
                  <dd>{a.device}</dd>
                </>
              )}
              {a.width && a.height && (
                <>
                  <dt className="subtle">{t('viewer.size')}</dt>
                  <dd className="tnum">{t('viewer.dims', { w: a.width, h: a.height })}</dd>
                </>
              )}
              {a.originalSize != null && (
                <>
                  <dt className="subtle">{t('viewer.original')}</dt>
                  <dd className="tnum">
                    {a.originalFilename.split('.').pop()?.toUpperCase()} · {fmtBytes(a.originalSize)}
                  </dd>
                </>
              )}
              {a.uploader && (
                <>
                  <dt className="subtle">{t('viewer.uploadedBy')}</dt>
                  <dd>{a.uploader.name}</dd>
                </>
              )}
            </dl>
            {a.originalUrl && (
              <a className="btn btn-p btn-block" href={a.originalUrl} download={a.downloadName}>
                <Icon name="download" />
                {t('viewer.downloadOriginal', { format: a.originalFilename.split('.').pop()?.toUpperCase() ?? '', size: fmtBytes(a.originalSize ?? 0) })}
              </a>
            )}
            {me?.isAdmin && (
              <>
                <hr className="divider" />
                <Link to={`/admin/items/${a.id}`} className="btn btn-g btn-sm" style={{ alignSelf: 'flex-start', padding: 0 }}>
                  <Icon name="sliders" />
                  {t('viewer.adminDetails')}
                </Link>
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

/** Anchor the zoom at a screen point (clamped to the image), or at its centre. */
function aim(el: HTMLImageElement, x?: number, y?: number) {
  const box = (el.offsetParent as HTMLElement | null)?.getBoundingClientRect();
  if (x === undefined || y === undefined || !box) return void (el.style.transformOrigin = '50% 50%');
  const fx = Math.min(1, Math.max(0, (x - box.left - el.offsetLeft) / el.offsetWidth));
  const fy = Math.min(1, Math.max(0, (y - box.top - el.offsetTop) / el.offsetHeight));
  el.style.transformOrigin = `${(fx * 100).toFixed(2)}% ${(fy * 100).toFixed(2)}%`;
}

function trapTab(e: React.KeyboardEvent, root: HTMLElement | null) {
  if (!root) return;
  const focusable = [...root.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"]),video')].filter((el) => el.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0]!;
  const last = focusable.at(-1)!;
  if (e.shiftKey && (document.activeElement === first || document.activeElement === root)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
