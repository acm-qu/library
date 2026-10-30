// My uploads (core): everything I uploaded, grouped by event, with live status, ETA and Retry.
import type { MyUploadItem } from '@acm/core/schemas';
import { useEffect, useMemo, useState } from 'react';
import { type TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { Bucket } from '../api/uploads.ts';
import { useMe } from '../data/session.ts';
import { useMyUploads, useRetry } from '../data/uploads.ts';
import { fmtBytes, fmtDate, fmtDuration, fmtTime, readyAt } from '../i18n/format.ts';
import { useUploads } from '../lib/uploader.ts';
import { Icon, type IconName } from '../ui/Icon.tsx';
import { Skeleton } from '../ui/Skeleton.tsx';
import { useTabIndicator } from '../ui/useTabIndicator.ts';

const BUCKETS: Bucket[] = ['all', 'active', 'attention', 'ready'];

export function MyUploadsScreen() {
  const { t } = useTranslation();
  const me = useMe().data!;
  const [bucket, setBucket] = useState<Bucket>('all');
  const tabs = useTabIndicator<HTMLDivElement>('line-bottom', bucket);
  const q = useMyUploads(bucket);
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const counts = q.data?.pages[0]?.counts;
  useEffect(() => {
    document.title = `${t('myUploads.title')} · ${t('brand')}`;
  }, [t]);

  const groups = useMemo(() => {
    const m = new Map<string, { id: string; title: string; startsOn: string; rows: MyUploadItem[] }>();
    for (const i of items) {
      const g = m.get(i.eventId) ?? { id: i.eventId, title: i.eventTitle, startsOn: i.eventStartsOn, rows: [] };
      g.rows.push(i);
      m.set(i.eventId, g);
    }
    return [...m.values()];
  }, [items]);
  const maxEta = Math.max(0, ...items.filter((i) => i.readyInS != null).map((i) => i.readyInS!));
  const waiting = !maxEta && items.some((i) => i.status === 'queued' || i.status === 'processing');
  const live = !!counts && counts.active > 0;

  return (
    <main id="main" className="wrap stack" style={{ maxWidth: 1080, paddingTop: 32, paddingBottom: 64, gap: 24 }}>
      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', gap: 16 }}>
        <div className="stack grow" style={{ gap: 6 }}>
          <h1 className="t-display login-title">{t('myUploads.title')}</h1>
          {!counts && q.isPending && <Skeleton h={26} w={320} />}
          {counts && (
            <span className="t-body muted tnum">
              {t('myUploads.summary', { active: counts.active, eta: maxEta > 0 ? readyAt(maxEta) : waiting ? 'waiting' : 'none', review: items.filter((i) => i.status === 'needs_review').length })}
            </span>
          )}
        </div>
        {live && (
          <span className="t-sm subtle row" style={{ gap: 6 }} aria-live="polite">
            <span style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--ok)' }} />
            {t('myUploads.live')}
          </span>
        )}
      </div>

      <div ref={tabs} className="tabs" role="tablist" aria-label={t('myUploads.filter')}>
        {BUCKETS.map((b) => (
          <button key={b} className="tab" role="tab" aria-selected={bucket === b} onClick={() => setBucket(b)}>
            {t(`myUploads.${b}`)}
            {counts && <span className="count">{counts[b]}</span>}
          </button>
        ))}
      </div>

      {q.isPending ? (
        <section className="stack" style={{ gap: 10 }} aria-busy="true" aria-label={t('states.loading')}>
          <Skeleton h={30} w={280} />
          <ul className="filelist panel" style={{ padding: 0 }} aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <li key={i}>
                <Skeleton h={48} w={48} />
                <div className="stack grow" style={{ gap: 6, flexBasis: 240 }}>
                  <Skeleton h={18} w={`${55 - i * 6}%`} />
                  <Skeleton h={14} w="30%" />
                </div>
                <div className="stack" style={{ gap: 4, alignItems: 'flex-end', minWidth: 180 }}>
                  <Skeleton h={28} w={96} />
                  <Skeleton h={20} w={120} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : !items.length ? (
        <div className="center-col" style={{ maxWidth: 520, margin: '64px auto' }}>
          <Icon name="upload" style={{ width: 32, height: 32, color: 'var(--text-3)' }} />
          <h2 className="t-h2">{bucket === 'all' ? t('myUploads.emptyTitle') : t('myUploads.emptyBucket')}</h2>
          {bucket === 'all' && <p className="t-body muted">{t('myUploads.emptyBody')}</p>}
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.id} className="stack" aria-labelledby={`g-${g.id}`} style={{ gap: 10 }}>
            <div className="row" style={{ flexWrap: 'wrap', gap: '4px 12px', alignItems: 'baseline' }}>
              <h2 className="t-h2" id={`g-${g.id}`}>
                <Link to={`/events/${g.id}`} style={{ color: 'var(--text)', textDecoration: 'none' }}>
                  {g.title}
                </Link>
              </h2>
              <span className="t-sm muted tnum">{t('myUploads.eventMeta', { date: fmtDate(g.startsOn), n: g.rows.length })}</span>
            </div>
            <ul className="filelist panel" style={{ padding: 0 }}>
              {collapse(g.rows).map((r) => (
                <Row key={r.item.assetId} r={r} isAdmin={me.isAdmin} female={me.isFemale === true} />
              ))}
            </ul>
          </section>
        ))
      )}
      {q.hasNextPage && (
        <button className="btn btn-s" style={{ alignSelf: 'center' }} onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
          {t('myUploads.more')}
        </button>
      )}
    </main>
  );
}

/** Long runs of ready photos fold into one row, as on the board ("IMG_4790.HEIC + 87 photos"). */
function collapse(rows: MyUploadItem[]) {
  const out: { item: MyUploadItem; more: number; bytes: number }[] = [];
  for (const item of rows) {
    const prev = out.at(-1);
    if (prev && item.kind === 'image' && item.status === 'ready' && prev.item.kind === 'image' && prev.item.status === 'ready') {
      prev.more++;
      prev.bytes += item.bytes ?? 0;
    } else out.push({ item, more: 0, bytes: item.bytes ?? 0 });
  }
  return out;
}

function Row({ r, isAdmin, female }: { r: { item: MyUploadItem; more: number; bytes: number }; isAdmin: boolean; female: boolean }) {
  const { t } = useTranslation();
  const retry = useRetry();
  const i = r.item;
  const video = i.kind === 'video';
  const meta = [
    r.more ? t('upload.fileCount', { n: r.more + 1 }) : t(video ? 'myUploads.video' : 'myUploads.photo'),
    r.bytes ? fmtBytes(r.bytes) : null,
    video && i.durationS ? fmtDuration(i.durationS) : null,
    video && (i.hdr === 'hlg' || i.hdr === 'pq') ? t('myUploads.hdr') : null,
    i.girlsOnly ? t('upload.girlsOnly') : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const [cls, icon, label] = statusChip(i, t);
  const eta =
    i.status === 'ready' || i.status === 'original_only'
      ? t('myUploads.readyAt', { time: fmtTime(new Date(i.updatedAt)) })
      : i.status === 'needs_review'
        ? t('myUploads.waitingAdmin')
        : i.readyInS != null
          ? t('myUploads.readyAbout', { time: readyAt(i.readyInS) })
          : i.status === 'queued' || i.status === 'processing'
            ? t('myUploads.waitingProcessor')
            : '';
  // Uploading in this browser: bytes sent so far. Processing: the job's progress. Otherwise a moving "busy" bar.
  const local = useUploads().find((u) => u.status === 'uploading' && u.file.name === i.filename && u.total === i.bytes);
  const busy = i.status === 'uploading' || i.status === 'processing';
  const pct = i.status === 'processing' ? i.progress : local?.total ? local.sent / local.total : null;
  const err = i.status === 'failed' || i.status === 'needs_review' ? t(`uploadErrors.${(i.error ?? 'generic') as 'generic'}`, { defaultValue: t('uploadErrors.generic') }) : null;

  return (
    <li>
      <span className="file-thumb">{video && <span className="mb"><Icon name="play" /></span>}</span>
      <div className="stack grow" style={{ minWidth: 0, gap: 2, flexBasis: 240 }}>
        <bdi className="truncate">{r.more ? t('myUploads.collapsed', { name: i.filename, n: r.more }) : i.filename}</bdi>
        <span className="t-sm muted tnum">{meta}</span>
        {err && <span className="t-sm" style={{ color: i.status === 'failed' ? 'var(--danger)' : 'var(--review)' }}>{err}</span>}
        {busy && (
          <div
            className={`progress${pct == null ? ' busy' : ''}`}
            role="progressbar"
            aria-label={t('myUploads.progressLabel', { name: i.filename })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct == null ? undefined : Math.round(pct * 100)}
            style={{ marginTop: 6 }}
          >
            <span style={pct == null ? undefined : { width: `${Math.round(pct * 100)}%` }} />
          </div>
        )}
      </div>
      <div className="stack" style={{ gap: 4, alignItems: 'flex-end', minWidth: 180 }}>
        <span className={`st ${cls}`}>
          <Icon name={icon} className={i.status === 'processing' ? 'spin' : ''} />
          {label}
        </span>
        <span className="t-sm muted tnum">{eta}</span>
      </div>
      <div className="row" style={{ gap: 4, minWidth: 96, justifyContent: 'flex-end' }}>
        {i.status === 'failed' && (
          <button className="btn btn-s btn-sm" onClick={() => retry.mutate(i.assetId)} disabled={retry.isPending}>
            <Icon name="refresh" />
            {t('myUploads.retry')}
          </button>
        )}
        {isAdmin && (!i.girlsOnly || female) && (i.status === 'failed' || i.status === 'needs_review') && (
          <Link className="btn btn-g btn-sm" to={`/admin/items/${i.assetId}`}>
            {t('myUploads.details')}
          </Link>
        )}
      </div>
    </li>
  );
}

function statusChip(i: MyUploadItem, t: TFunction): [string, IconName, string] {
  switch (i.status) {
    case 'uploading':
      return ['st-q', 'upload', t('myUploads.st_uploading')];
    case 'queued':
      return ['st-q', 'clock', i.queuePosition ? t('myUploads.st_queued', { pos: i.queuePosition }) : t('myUploads.st_queuedNoPos')];
    case 'processing':
      return ['st-p', 'refresh', i.step ? `${t('myUploads.st_processing')} · ${i.step}` : t('myUploads.st_processing')];
    case 'ready':
      return ['st-ok', 'check', t('myUploads.st_ready')];
    case 'original_only':
      return ['st-ok', 'check', t('myUploads.st_original_only')];
    case 'failed':
      return ['st-x', 'alert', t('myUploads.st_failed')];
    case 'needs_review':
      return ['st-r', 'flag', t('myUploads.st_needs_review')];
    default:
      return ['st-q', 'clock', i.status];
  }
}
