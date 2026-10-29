// One grid tile, with the board's overlays: core badge, video badge + duration on hover, and status states.
import type { AssetTile } from '@acm/core/schemas';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import { fmtDuration, readyAt } from '../i18n/format.ts';
import { Icon } from './Icon.tsx';

export function MediaTile({ a, index, eventTitle }: { a: AssetTile; index: number; eventTitle: string }) {
  const { t } = useTranslation();
  const loc = useLocation();
  const [broken, setBroken] = useState(false);
  const unfinished = a.status === 'uploading' || a.status === 'queued' || a.status === 'processing' || a.status === 'failed';
  const label = [
    a.status === 'processing'
      ? t('tile.processing', { time: a.readyInS != null ? readyAt(a.readyInS) : '' })
      : a.status === 'queued' || a.status === 'uploading'
        ? t('tile.queued')
        : a.status === 'failed'
          ? t('tile.failed')
          : a.kind === 'video'
            ? t('tile.video', { duration: a.durationS ? fmtDuration(a.durationS) : '' })
            : t('tile.photo', { event: eventTitle }),
    a.tier === 'core' ? t('tile.core') : null,
    a.status === 'needs_review' ? t('tile.review') : null,
    a.status === 'original_only' ? t('tile.originalOnly') : null,
    t('tile.item', { n: index + 1 }),
  ]
    .filter(Boolean)
    .join(', ');
  const bg = unfinished || !a.thumbUrl || broken ? 'var(--surface-2)' : 'var(--surface-3)';

  return (
    <Link className="tile" to={`/p/${a.id}`} state={{ background: loc }} aria-label={label} style={{ width: '100%', height: '100%', background: bg }}>
      {a.thumbUrl && !broken && <img src={a.thumbUrl} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
      {a.tier === 'core' && (
        <span className="mb" title={t('tile.core')} style={{ position: 'absolute', top: 6, insetInlineStart: 6 }}>
          <Icon name="shield" />
        </span>
      )}
      {a.kind === 'video' && !unfinished && (
        <>
          <span className="mb" style={{ position: 'absolute', bottom: 6, insetInlineStart: 6 }}>
            <Icon name="play" />
          </span>
          {a.durationS != null && (
            <span className="tile-hover">
              <span className="mb tnum" style={{ position: 'absolute', bottom: 6, insetInlineEnd: 6, width: 'auto', padding: '0 8px', fontSize: 12, fontWeight: 600 }}>
                {fmtDuration(a.durationS)}
              </span>
            </span>
          )}
        </>
      )}
      {(a.status === 'processing' || a.processing) && (
        <>
          {a.status === 'processing' && (
            <span style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--info)' }}>
              <Icon name="refresh" className="spin" size="lg" />
            </span>
          )}
          <span className="progress info" style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
            <span style={{ width: `${Math.round((a.progress ?? 0) * 100)}%` }} />
          </span>
        </>
      )}
      {(a.status === 'queued' || a.status === 'uploading') && (
        <span style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--text-3)' }}>
          <Icon name="clock" size="lg" />
        </span>
      )}
      {a.status === 'failed' && (
        <span style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--danger)' }}>
          <Icon name="alert" size="lg" />
        </span>
      )}
      {a.status === 'needs_review' && (
        <span className="mb" title={t('tile.review')} style={{ position: 'absolute', top: 6, insetInlineEnd: 6, background: 'var(--review-bg)', color: 'var(--review)' }}>
          <Icon name="flag" />
        </span>
      )}
    </Link>
  );
}
