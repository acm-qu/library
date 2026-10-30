// Admin · Events: every event with its counts, edit (the event page's dialog) and delete (same confirmation).
import type { EventCard } from '@acm/core/schemas';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useEvents } from '../../data/library.ts';
import { fmtDate } from '../../i18n/format.ts';
import { Icon } from '../../ui/Icon.tsx';
import { SkeletonRows } from '../../ui/Skeleton.tsx';
import { DeleteEventConfirm, EventEditDialog } from '../EventEdit.tsx';

export function EventsScreen() {
  const { t } = useTranslation();
  const events = useEvents({});
  const all = useMemo(() => events.data?.pages.flatMap((p) => p.items) ?? [], [events.data]);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<EventCard | null>(null);
  useEffect(() => {
    document.title = `${t('admin.events')} · ${t('brand')}`;
  }, [t]);

  return (
    <>
      <h1 className="t-h1">{t('admin.events')}</h1>
      {deleting && <DeleteEventConfirm event={deleting} onCancel={() => setDeleting(null)} onDeleted={() => setDeleting(null)} />}
      {editing && <EventEditDialog slug={editing} onClose={() => setEditing(null)} onDeleted={() => setEditing(null)} />}

      {!events.isPending && !all.length ? (
        <div className="center-col" style={{ maxWidth: 520, margin: '64px auto' }}>
          <h2 className="t-h1">{t('library.emptyCoreTitle')}</h2>
          <p className="t-body muted">{t('library.emptyCoreBody')}</p>
          <Link className="btn btn-p" to="/upload">
            {t('library.createFirst')}
          </Link>
        </div>
      ) : (
        <div className="card scroll-x" aria-busy={events.isPending || undefined} aria-label={events.isPending ? t('states.loading') : undefined}>
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('admin.e_colEvent')}</th>
                <th className="num">{t('event.photos')}</th>
                <th className="num">{t('event.videos')}</th>
                <th>
                  <span className="vh">{t('admin.e_colActions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {events.isPending && <SkeletonRows rows={6} cols={4} />}
              {all.map((e) => (
                <tr key={e.id}>
                  <td>
                    <div className="stack" style={{ minWidth: 0 }}>
                      <Link to={`/events/${e.slug}`} style={{ fontWeight: 600, color: 'var(--text)' }}>
                        {e.title}
                      </Link>
                      <span className="t-sm muted tnum">{[fmtDate(e.startsOn) + (e.endsOn && e.endsOn !== e.startsOn ? ` – ${fmtDate(e.endsOn)}` : ''), e.location].filter(Boolean).join(' · ')}</span>
                    </div>
                  </td>
                  <td className="num">{e.photoCount}</td>
                  <td className="num">{e.videoCount}</td>
                  <td>
                    <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                      <button className="btn btn-g btn-sm" aria-label={t('admin.e_editFor', { title: e.title })} onClick={() => setEditing(e.slug)}>
                        <Icon name="edit" />
                        {t('admin.e_edit')}
                      </button>
                      <button className="btn btn-g btn-sm" style={{ color: 'var(--danger)' }} aria-label={t('admin.e_deleteFor', { title: e.title })} onClick={() => setDeleting(e)}>
                        {t('admin.e_delete')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {events.hasNextPage && (
        <button className="btn btn-s" style={{ alignSelf: 'center' }} onClick={() => void events.fetchNextPage()} disabled={events.isFetchingNextPage}>
          {t('admin.e_more')}
        </button>
      )}
    </>
  );
}
