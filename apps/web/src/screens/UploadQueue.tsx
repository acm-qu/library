// The server-wide upload queue (Upload step 3 and My uploads): who is uploading or waiting for one of the shared
// slots. Others' rows carry only name, kind, size and progress; filenames show on the viewer's own rows alone.
import type { UploadQueueRow } from '@acm/core/schemas';
import { useTranslation } from 'react-i18next';
import { useUploadQueue } from '../data/uploads.ts';
import { fmtBytes } from '../i18n/format.ts';
import { Icon } from '../ui/Icon.tsx';
import { Skeleton } from '../ui/Skeleton.tsx';

const SHOW = 30;

export function UploadQueuePanel() {
  const { t } = useTranslation();
  const q = useUploadQueue();
  const rows = q.data?.items ?? [];
  return (
    <section className="panel stack" aria-labelledby="h-queue" aria-busy={q.isPending || undefined} style={{ gap: 12, padding: 0 }}>
      <div className="stack" style={{ gap: 4, padding: '16px 16px 0' }}>
        <div className="row" style={{ flexWrap: 'wrap', gap: '4px 16px' }}>
          <h2 className="t-h3 grow" id="h-queue">
            {t('queue.title')}
          </h2>
          {q.data ? (
            <span className="t-sm muted tnum">
              {t('queue.slots', { inUse: q.data.inUse, slots: q.data.slots })} · {t('queue.rate', { rate: fmtBytes(q.data.rateBps) })}
            </span>
          ) : (
            q.isPending && <Skeleton h={18} w={180} />
          )}
        </div>
        <span className="help">{t('queue.help', { slots: q.data?.slots ?? 4 })}</span>
      </div>
      {q.isPending ? (
        <ul className="filelist" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <li key={i}>
              <Skeleton h={18} w={`${50 - i * 8}%`} />
              <span className="grow" />
              <Skeleton h={28} w={110} />
            </li>
          ))}
        </ul>
      ) : q.isError && !q.data ? (
        <p className="t-sm muted" style={{ padding: '0 16px 16px', margin: 0 }}>
          {t('queue.error')}
        </p>
      ) : !rows.length ? (
        <p className="t-sm muted" style={{ padding: '0 16px 16px', margin: 0 }}>
          {t('queue.empty')}
        </p>
      ) : (
        <>
          <ul className="filelist" aria-label={t('queue.title')}>
            {rows.slice(0, SHOW).map((r) => (
              <QueueRow key={r.ticketId ?? `${r.state}-${r.position}`} r={r} />
            ))}
          </ul>
          {rows.length > SHOW && (
            <span className="t-sm subtle" style={{ padding: '0 16px 16px' }}>
              {t('queue.more', { n: rows.length - SHOW })}
            </span>
          )}
        </>
      )}
    </section>
  );
}

function QueueRow({ r }: { r: UploadQueueRow }) {
  const { t } = useTranslation();
  const own = r.ticketId !== undefined;
  const pct = r.progress != null && r.bytes ? Math.floor((r.progress / r.bytes) * 100) : null;
  return (
    <li>
      <span className="stack grow" style={{ minWidth: 0, gap: 2, flexBasis: 200 }}>
        <span className="truncate">
          <bdi>{own ? t('queue.you') : r.uploader}</bdi>
          {own && r.filename ? (
            <>
              {' · '}
              <bdi>{r.filename}</bdi>
            </>
          ) : null}
        </span>
        <span className="t-sm muted tnum">
          {t(`queue.${r.kind}`)} · {fmtBytes(r.bytes)}
        </span>
      </span>
      <span className={`st ${r.state === 'uploading' ? 'st-p' : 'st-q'}`}>
        <Icon name={r.state === 'uploading' ? 'upload' : 'clock'} />
        {r.state === 'waiting' ? t('queue.waiting', { n: r.position }) : pct == null ? t('queue.uploadingNoPct') : t('queue.uploading', { pct })}
      </span>
    </li>
  );
}
