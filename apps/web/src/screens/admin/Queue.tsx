// Admin · Processing queue: health summary, tabs (running, queued, failed, needs review, recent) and actions.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import * as api from '../../api/admin.ts';
import { useAdminMutation, useJobs } from '../../data/admin.ts';
import { fmtDateTime, fmtDuration, readyAt } from '../../i18n/format.ts';
import { fmtEta } from '../../lib/eta.ts';
import { Icon } from '../../ui/Icon.tsx';
import { Skeleton, SkeletonRows } from '../../ui/Skeleton.tsx';
import { useTabIndicator } from '../../ui/useTabIndicator.ts';

const TABS: api.JobTab[] = ['running', 'queued', 'failed', 'needs_review', 'recent'];

export function QueueScreen() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<api.JobTab>('queued');
  const tabs = useTabIndicator<HTMLDivElement>('line-bottom', tab);
  const q = useJobs(tab);
  const s = q.data?.summary;
  useEffect(() => {
    document.title = `${t('admin.queue')} · ${t('brand')}`;
  }, [t]);
  const action = useAdminMutation((id: string, a: 'retry' | 'cancel' | 'prioritize') => api.jobAction(id, a));
  const resolve = useAdminMutation((id: string, a: 'process_default' | 'original_only') => api.resolveAsset(id, a));
  const counts: Record<api.JobTab, number | undefined> = { running: s?.running, queued: s?.queued, failed: s?.failed, needs_review: s?.needsReview, recent: undefined };
  const items = q.data?.items ?? [];
  const tick = s?.workerTick ? new Date(s.workerTick) : null;
  const stale = tick ? Date.now() - tick.getTime() > 3 * 60_000 : true; // the API drops ETAs at the same age
  const fmt = (i: api.AdminJobItem) => (i.asset?.kind === 'image' ? t('admin.fmt_photo') : t(`admin.fmt_${(i.asset?.hdr ?? 'sdr') as 'sdr'}`));
  const name = (i: api.AdminJobItem) => (
    <div className="stack" style={{ minWidth: 0 }}>
      <bdi style={{ fontWeight: 600 }}>{i.asset?.filename ?? '—'}</bdi>
      <span className="t-sm muted">{i.asset?.eventTitle}</span>
    </div>
  );
  const details = (i: api.AdminJobItem) =>
    i.asset && (
      <Link className="btn btn-g btn-sm" to={`/admin/items/${i.asset.id}`}>
        {t('admin.q_details')}
      </Link>
    );

  return (
    <>
      <div className="row" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
        <h1 className="t-h1 grow">{t('admin.queue')}</h1>
        {s && s.running + s.queued > 0 && (
          <span className="t-sm subtle row" style={{ gap: 6 }} aria-live="polite">
            <span style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--ok)' }} />
            {t('admin.live')}
          </span>
        )}
      </div>

      {!s && q.isPending && (
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }} aria-hidden="true">
          {[0, 1, 2].map((n) => (
            <div key={n} className="panel stack" style={{ flex: '1 1 220px', gap: 4, padding: 20 }}>
              <Skeleton h={16} w="45%" />
              <Skeleton h={40} w="35%" />
              <Skeleton h={20} w="70%" />
            </div>
          ))}
        </div>
      )}
      {!s && q.isPending && <Skeleton h={20} w={260} />}
      {s && (
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <Stat label={t('admin.q_waiting')} value={String(s.running + s.queued)} note={t('admin.q_waitingNote', { running: s.running, queued: s.queued })} />
          <Stat label={t('admin.q_video')} value={s.queuedVideoS ? fmtEta(s.queuedVideoS) : '0'} note={t('admin.q_timesHelp').split('.')[0]!} />
          <Stat
            label={t('admin.q_clear')}
            value={s.drainS ? fmtEta(s.drainS) : s.running + s.queued ? t('myUploads.waitingProcessor') : t('admin.q_empty')}
            note={s.drainS ? t('admin.q_clearNote', { time: readyAt(s.drainS) }) : s.running + s.queued ? '' : t('admin.q_idle')}
          />
        </div>
      )}
      {s && (
        <span className={`t-sm ${stale ? '' : 'subtle'}`} style={stale ? { color: 'var(--warn)' } : undefined} role={stale ? 'alert' : undefined}>
          {!tick ? t('admin.q_workerNever') : stale ? t('admin.q_workerStale', { time: fmtDateTime(tick.toISOString()) }) : t('admin.q_worker', { time: fmtDateTime(tick.toISOString()) })}
        </span>
      )}

      <div ref={tabs} className="tabs" role="tablist" aria-label={t('admin.queue')}>
        {TABS.map((x) => (
          <button key={x} className="tab" role="tab" aria-selected={tab === x} onClick={() => setTab(x)}>
            {t(`admin.tab_${x}`)}
            {counts[x] !== undefined && <span className="count">{counts[x]}</span>}
          </button>
        ))}
      </div>

      <div role="tabpanel" aria-busy={q.isPending || undefined} aria-label={q.isPending ? t('states.loading') : undefined}>
        {q.isPending ? (
          <div className="card">
            <table className="tbl">
              <tbody>
                <SkeletonRows rows={5} cols={5} />
              </tbody>
            </table>
          </div>
        ) : !items.length ? (
          <p className="t-body muted">{t('admin.q_none')}</p>
        ) : tab === 'running' ? (
          <div className="stack" style={{ gap: 12 }}>
            {items.map((i) => (
              <div key={i.id} className="panel row" style={{ gap: 16, flexWrap: 'wrap' }}>
                <div className="stack grow" style={{ gap: 6, minWidth: 240 }}>
                  <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                    <bdi className="t-h3">{i.asset?.filename}</bdi>
                    <span className="st st-p">
                      <Icon name="refresh" className="spin" />
                      {i.step ?? t('admin.kind_process')}
                    </span>
                  </div>
                  <span className="t-sm muted">
                    {[fmt(i), i.asset?.durationS ? fmtDuration(i.asset.durationS) : null, i.asset?.eventTitle].filter(Boolean).join(' · ')}
                  </span>
                  <div className="progress info">
                    <span style={{ width: `${Math.round((i.progress ?? 0) * 100)}%` }} />
                  </div>
                  {i.startedAt && <span className="t-sm subtle tnum">{i.readyInS != null ? t('admin.q_runningFor', { d: fmtDuration((Date.now() - Date.parse(i.startedAt)) / 1000), time: readyAt(i.readyInS) }) : t('admin.q_runningForWaiting', { d: fmtDuration((Date.now() - Date.parse(i.startedAt)) / 1000) })}</span>}
                </div>
                <div className="row" style={{ gap: 4 }}>
                  {details(i)}
                  <button className="btn btn-g btn-sm" onClick={() => action.mutate([i.id, 'cancel'])}>
                    {t('admin.q_cancel')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : tab === 'queued' ? (
          <>
            <div className="card scroll-x">
              <table className="tbl">
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>{t('admin.q_colItem')}</th>
                    <th>{t('admin.q_colLength')}</th>
                    <th>{t('admin.q_colFormat')}</th>
                    <th>{t('admin.q_colReady')}</th>
                    <th>
                      <span className="vh">{t('admin.q_colActions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i, n) => (
                    <tr key={i.id}>
                      <td className="num">{n + 1}</td>
                      <td>{name(i)}</td>
                      <td className="tnum">{i.asset?.durationS ? fmtDuration(i.asset.durationS) : '—'}</td>
                      <td>{fmt(i)}</td>
                      <td className="tnum">{i.readyInS != null ? readyAt(i.readyInS) : t('myUploads.waitingProcessor')}</td>
                      <td>
                        <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                          {n > 0 && (
                            <button className="btn btn-g btn-sm btn-ic" aria-label={t('admin.q_moveTop', { name: i.asset?.filename ?? '' })} title={t('admin.q_moveTop', { name: i.asset?.filename ?? '' })} onClick={() => action.mutate([i.id, 'prioritize'])}>
                              <Icon name="upload" />
                            </button>
                          )}
                          {details(i)}
                          <button className="btn btn-g btn-sm" onClick={() => action.mutate([i.id, 'cancel'])}>
                            {t('admin.q_cancel')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="help">{t('admin.q_timesHelp')}</p>
          </>
        ) : tab === 'failed' ? (
          <div className="card scroll-x">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('admin.q_colItem')}</th>
                  <th>{t('admin.q_colWhat')}</th>
                  <th className="num">{t('admin.q_colAttempts')}</th>
                  <th>{t('admin.q_colLast')}</th>
                  <th>
                    <span className="vh">{t('admin.q_colActions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td>{name(i)}</td>
                    <td>
                      <div className="stack">
                        <span>{t(`admin.err_${(i.lastError ?? 'generic') as 'generic'}`, { defaultValue: t('admin.err_generic') })}</span>
                        <code className="t-xs subtle">{i.lastError}</code>
                      </div>
                    </td>
                    <td className="num">{i.attempts}</td>
                    <td className="tnum t-sm">{i.finishedAt ? fmtDateTime(i.finishedAt) : '—'}</td>
                    <td>
                      <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                        <button className="btn btn-s btn-sm" onClick={() => action.mutate([i.id, 'retry'])}>
                          <Icon name="refresh" />
                          {t('admin.q_retry')}
                        </button>
                        {details(i)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : tab === 'needs_review' ? (
          <div className="stack" style={{ gap: 12 }}>
            {items.map((i) => {
              const reason = (i.asset?.reviewReason ?? 'unknown_transfer') as 'unknown_transfer';
              return (
                <div key={i.id} className="panel row" style={{ gap: 16, flexWrap: 'wrap' }}>
                  <div className="stack grow" style={{ gap: 4, minWidth: 240 }}>
                    <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                      <bdi className="t-h3">{i.asset?.filename}</bdi>
                      <span className="st st-r">
                        <Icon name="flag" />
                        {t(`admin.rev_${reason}`)}
                      </span>
                    </div>
                    <span className="t-sm">{t(`admin.rev_${reason}Why`)}</span>
                    <span className="t-sm muted">{[i.asset?.eventTitle, i.asset?.durationS ? fmtDuration(i.asset.durationS) : null].filter(Boolean).join(' · ')}</span>
                  </div>
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    {details(i)}
                    <button className="btn btn-s btn-sm" title={t('admin.q_keepOriginalTitle')} onClick={() => i.asset && resolve.mutate([i.asset.id, 'original_only'])}>
                      {t('admin.q_keepOriginal')}
                    </button>
                    <button className="btn btn-p btn-sm" onClick={() => i.asset && resolve.mutate([i.asset.id, 'process_default'])}>
                      {t('admin.q_processAnyway')}
                    </button>
                  </div>
                </div>
              );
            })}
            <p className="help">{t('admin.q_reviewHelp')}</p>
          </div>
        ) : (
          <div className="card scroll-x">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('admin.q_colItem')}</th>
                  <th>{t('admin.q_colKind')}</th>
                  <th>{t('admin.q_colFinished')}</th>
                  <th>{t('admin.q_colTook')}</th>
                  <th>
                    <span className="vh">{t('admin.q_colActions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td>{name(i)}</td>
                    <td>{t(`admin.kind_${i.kind}`)}</td>
                    <td className="tnum t-sm">{i.finishedAt ? fmtDateTime(i.finishedAt) : '—'}</td>
                    <td className="tnum">{i.startedAt && i.finishedAt ? fmtDuration((Date.parse(i.finishedAt) - Date.parse(i.startedAt)) / 1000) : '—'}</td>
                    <td>
                      <div className="row" style={{ justifyContent: 'flex-end' }}>{details(i)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="panel stack" style={{ flex: '1 1 220px', gap: 4, padding: 20 }}>
      <span className="t-over">{label}</span>
      <span className="t-h1 tnum">{value}</span>
      <span className="t-sm muted">{note}</span>
    </div>
  );
}
