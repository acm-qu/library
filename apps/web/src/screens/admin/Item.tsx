// Admin · Item details: source facts, copies, processing runs, tone curve with re-process, tier and delete.
import { TONE_CURVES } from '@acm/core/enums';
import { ToneScores } from '@acm/core/schemas';
import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import * as api from '../../api/admin.ts';
import { ApiError } from '../../api/client.ts';
import { useAdminMutation, useProcessing } from '../../data/admin.ts';
import { fmtBytes, fmtDateTime, fmtDuration, readyAt } from '../../i18n/format.ts';
import { fmtEta } from '../../lib/eta.ts';
import { Confirm } from '../../ui/Confirm.tsx';
import { Icon } from '../../ui/Icon.tsx';
import { Rich } from '../../ui/Rich.tsx';
import { NotFound } from '../States.tsx';

const CURVE_NAMES: Record<string, string> = { hable203: 'Hable (203 nits)', bt2446a: 'BT.2446-A', bt2390: 'BT.2390', reinhard203: 'Reinhard (203 nits)' };

export function ItemScreen() {
  const { t } = useTranslation();
  const { assetId = '' } = useParams();
  const navigate = useNavigate();
  const q = useProcessing(assetId);
  const [pick, setPick] = useState<string>('hable203');
  const [confirm, setConfirm] = useState<'reprocess' | 'tier' | 'delete' | null>(null);
  const reprocess = useAdminMutation((id: string, curve?: string) => api.reprocess(id, curve));
  const tier = useAdminMutation((id: string, to: 'member' | 'core') => api.patchAsset(id, { tier: to }));
  const del = useAdminMutation((id: string) => api.deleteAsset(id));
  useEffect(() => {
    if (q.data) document.title = `${q.data.asset.filename} · ${t('admin.nav')}`;
    const last = q.data?.runs.find((r) => r.toneCurve);
    if (last?.toneCurve) setPick(last.toneCurve);
  }, [q.data, t]);
  if (q.isError) return q.error instanceof ApiError && q.error.code === 'not_found' ? <NotFound /> : null;
  if (!q.data) return <div className="skel" style={{ height: 400 }} aria-busy="true" />;
  const { asset: a, renditions, runs, jobs, reprocessEtaS } = q.data;
  const hdr = a.hdr === 'hlg' || a.hdr === 'pq';
  // The run behind the copies people see now (a re-process in progress has its own, unfinished run).
  const lastRun = runs.find((r) => r.ok) ?? runs[0];
  const scores = ToneScores.safeParse(lastRun?.scores);
  const current = lastRun?.toneCurve ?? 'hable203';
  const busy = jobs.some((j) => j.state === 'queued' || j.state === 'running');
  const toTier = a.tier === 'member' ? 'core' : 'member';

  return (
    <>
      <Link to="/admin/queue" className="t-sm row" style={{ gap: 6, alignSelf: 'flex-start' }}>
        <Icon name="back" className="flip" size="sm" />
        {t('admin.i_back')}
      </Link>
      <div className="row" style={{ gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <span className="pick-thumb" style={{ width: 96, height: 72 }}>
          {a.thumbUrl && <img src={a.thumbUrl} alt="" onError={(e) => (e.currentTarget.style.display = 'none')} />}
        </span>
        <div className="stack grow" style={{ gap: 8, minWidth: 0 }}>
          <bdi className="t-h1" style={{ overflowWrap: 'anywhere' }}>
            {a.filename}
          </bdi>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <StatusChip status={a.status} />
            <span className="tier">
              {a.tier === 'core' && <Icon name="shield" />}
              {t(a.tier === 'core' ? 'admin.i_tierCore' : 'admin.i_tierMember')}
            </span>
            <span className="t-sm muted">
              <Trans i18nKey="admin.i_uploaded" values={{ event: a.eventTitle }} components={{ a: <Link to={`/events/${a.eventId}`} /> }} />
            </span>
          </div>
        </div>
        {(a.status === 'ready' || a.status === 'original_only') && (
          <Link className="btn btn-s" to={`/p/${a.id}`}>
            <Icon name={a.kind === 'video' ? 'play' : 'photos'} />
            {t('admin.i_play')}
          </Link>
        )}
      </div>

      <div className="row" style={{ gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div className="stack" style={{ flex: '999 1 480px', gap: 24, minWidth: 0 }}>
          {a.kind === 'video' && (
            <section className="panel stack" aria-labelledby="h-tm" style={{ gap: 16 }}>
              <div className="stack" style={{ gap: 4 }}>
                <h2 className="t-h2" id="h-tm">
                  {t('admin.i_curve')}
                </h2>
                <span className="t-sm muted">{curveNote(t, hdr, lastRun?.curveSource ?? null, scores.success ? scores.data : null)}</span>
              </div>
              {hdr && scores.success && scores.data.candidates.length > 0 && <ScoreTable s={scores.data} chosen={current} />}
              {hdr && scores.success && !!scores.data.frames?.length && lastRun && <Frames assetId={a.id} runId={lastRun.id} frames={scores.data.frames} />}
              {hdr && (
                <div role="radiogroup" aria-labelledby="h-tm" className="stack" style={{ gap: 6 }}>
                  {TONE_CURVES.map((c) => (
                    <label key={c} className="pick" style={{ minHeight: 48 }}>
                      <input type="radio" name="curve" checked={pick === c} onChange={() => setPick(c)} className="check" />
                      <span className="grow">{CURVE_NAMES[c]}</span>
                      {c === current && <span className="st st-ok">{t('myUploads.st_ready')}</span>}
                    </label>
                  ))}
                </div>
              )}
              {confirm === 'reprocess' ? (
                <Confirm
                  title={t('admin.i_confirmTitle', { curve: CURVE_NAMES[pick] ?? '' })}
                  confirm={t('admin.i_reprocess')}
                  cancel={t('admin.m_cancel')}
                  onCancel={() => setConfirm(null)}
                  busy={reprocess.isPending}
                  // "Current settings" keeps an admin's override; otherwise the curve is chosen again (automatically, or the fallback).
                  onConfirm={() => void reprocess.mutateAsync([a.id, hdr && (pick !== current || lastRun?.curveSource === 'override') ? pick : undefined]).then(() => setConfirm(null))}
                >
                  <Rich k="admin.i_confirmBody" values={{ duration: fmtEta(reprocessEtaS), time: readyAt(reprocessEtaS) }} />
                </Confirm>
              ) : (
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn btn-s" disabled={busy} onClick={() => (setPick(current), setConfirm('reprocess'))} title={t('admin.i_reprocessSameHint')}>
                    {t('admin.i_reprocessSame')}
                  </button>
                  {hdr && (
                    <button className="btn btn-p" disabled={busy || pick === current} onClick={() => setConfirm('reprocess')}>
                      {t('admin.i_reprocessWith', { curve: CURVE_NAMES[pick] ?? '' })}
                    </button>
                  )}
                </div>
              )}
            </section>
          )}
          {a.kind === 'image' && (
            <div className="row">
              <button className="btn btn-s" disabled={busy} onClick={() => void reprocess.mutateAsync([a.id, undefined])}>
                {t('admin.i_reprocessSame')}
              </button>
            </div>
          )}

          <section className="panel stack" aria-labelledby="h-act" style={{ gap: 16 }}>
            <h2 className="t-h2" id="h-act">
              {t('admin.i_access')}
            </h2>
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              <div className="stack grow">
                <span className="label">{t('admin.i_tier')}</span>
                <span className="t-sm muted">{t(a.tier === 'core' ? 'admin.i_tierCoreBody' : 'admin.i_tierMemberBody')}</span>
              </div>
              <button className="btn btn-s" disabled={busy} onClick={() => setConfirm('tier')}>
                {t(toTier === 'core' ? 'admin.i_toCore' : 'admin.i_toMember')}
              </button>
            </div>
            {confirm === 'tier' && (
              <Confirm title={t(toTier === 'core' ? 'admin.i_confirmTierCore' : 'admin.i_confirmTierMember')} confirm={t('admin.i_changeTier')} cancel={t('admin.m_cancel')} onCancel={() => setConfirm(null)} busy={tier.isPending} onConfirm={() => void tier.mutateAsync([a.id, toTier]).then(() => setConfirm(null))}>
                {t('admin.i_confirmTierBody')}
              </Confirm>
            )}
            <hr className="divider" />
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              <div className="stack grow">
                <span className="label">{t('admin.i_delete')}</span>
                <span className="t-sm muted">{t('admin.i_deleteBody')}</span>
              </div>
              <button className="btn btn-d" onClick={() => setConfirm('delete')}>
                {t('admin.i_deleteBtn')}
              </button>
            </div>
            {confirm === 'delete' && (
              <Confirm danger title={t('admin.i_confirmDelete', { name: a.filename })} confirm={t('admin.i_deleteForever')} cancel={t('admin.m_cancel')} onCancel={() => setConfirm(null)} busy={del.isPending} onConfirm={() => void del.mutateAsync([a.id]).then(() => navigate('/admin/queue'))}>
                <Rich k="admin.i_confirmDeleteBody" values={{ size: `${a.filename.split('.').pop()?.toUpperCase()} · ${fmtBytes(a.originalSize ?? 0)}` }} />
              </Confirm>
            )}
          </section>
        </div>

        <aside className="stack" style={{ flex: '1 1 300px', gap: 16 }}>
          <section className="panel stack" style={{ gap: 12 }}>
            <h2 className="t-h3">{t('admin.i_source')}</h2>
            <dl className="lb-dl">
              <dt className="subtle">{t('viewer.size')}</dt>
              <dd className="tnum">{a.width && a.height ? t('viewer.dims', { w: a.width, h: a.height }) : '—'}</dd>
              {a.durationS != null && (
                <>
                  <dt className="subtle">{t('admin.q_colLength')}</dt>
                  <dd className="tnum">{fmtDuration(a.durationS)}</dd>
                </>
              )}
              {a.kind === 'video' && (
                <>
                  <dt className="subtle">{t('admin.q_colFormat')}</dt>
                  <dd>{t(`admin.fmt_${(a.hdr ?? 'unknown') as 'sdr'}`)}</dd>
                </>
              )}
              <dt className="subtle">{t('viewer.original')}</dt>
              <dd className="tnum">{fmtBytes(a.originalSize ?? 0)}</dd>
              <dt className="subtle">{t('admin.i_stored')}</dt>
              <dd>{a.encrypted ? t('admin.i_encrypted') : t('admin.i_plain')}</dd>
            </dl>
            {a.duplicateOf && (
              <Link className="t-sm" to={`/admin/items/${a.duplicateOf}`}>
                {t('admin.i_duplicate')}
              </Link>
            )}
          </section>
          <section className="panel stack" style={{ gap: 8 }}>
            <h2 className="t-h3">{t('admin.i_renditions')}</h2>
            <ul className="stack t-sm" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 4 }}>
              {renditions.map((r) => (
                <li key={`${r.kind}${r.label}`} className="row" style={{ gap: 8 }}>
                  <span className="grow">
                    {r.kind.replace('_', ' ')} {r.label}
                  </span>
                  <span className="tnum muted">{fmtBytes(r.bytes)}</span>
                  {r.encrypted && <Icon name="shield" size="sm" />}
                </li>
              ))}
            </ul>
          </section>
          <section className="panel stack" style={{ gap: 8 }}>
            <h2 className="t-h3">{t('admin.i_jobs')}</h2>
            <ul className="stack t-sm" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 6 }}>
              {jobs.map((j) => (
                <li key={j.id} className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <span className="grow">{t(`admin.kind_${j.kind as 'process'}`)}</span>
                  <span className="muted">{j.state}</span>
                  <span className="tnum subtle">{fmtDateTime(j.finishedAt ?? j.createdAt)}</span>
                  {j.lastError && <code className="t-xs" style={{ color: 'var(--danger)', flexBasis: '100%' }}>{j.lastError}</code>}
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </>
  );
}

type T = ReturnType<typeof useTranslation>['t'];

function curveNote(t: T, hdr: boolean, source: string | null, s: ToneScores | null): string {
  if (!hdr) return t('admin.i_curveSdr');
  if (source === 'override') return t('admin.i_curveOverride');
  if (source === 'auto') return t('admin.i_curveAuto');
  if (s?.reason === 'metrics_disagree') return t('admin.i_curveDisagree', { best: CURVE_NAMES[s.best ?? ''] ?? s.best ?? '' });
  if (s?.reason) return t('admin.i_curveFailed', { code: s.error ?? s.reason });
  return t('admin.i_curveFallback');
}

/** DISTS rank, TOPIQ rank and their sum per candidate (handoff §8.5, design handoff "Item details"). */
function ScoreTable({ s, chosen }: { s: ToneScores; chosen: string }) {
  const { t } = useTranslation();
  const fmt = (v: number) => v.toFixed(3);
  const rank = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="tbl">
        <caption className="vh">{t('admin.i_scoresCaption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('admin.i_colCurve')}</th>
            <th scope="col" className="num" title={t('admin.i_distsHint')}>
              DISTS
            </th>
            <th scope="col" className="num" title={t('admin.i_topiqHint')}>
              TOPIQ
            </th>
            <th scope="col" className="num">
              {t('admin.i_colSum')}
            </th>
          </tr>
        </thead>
        <tbody>
          {[...s.candidates]
            .sort((x, y) => x.sum - y.sum)
            .map((c) => (
              <tr key={c.curve} aria-current={c.curve === chosen ? 'true' : undefined} style={c.curve === chosen ? { background: 'var(--surface-2)' } : undefined}>
                <td>
                  <span className="row" style={{ gap: 8 }}>
                    {CURVE_NAMES[c.curve] ?? c.curve}
                    {c.curve === chosen && <span className="st st-ok">{t('admin.i_chosen')}</span>}
                  </span>
                </td>
                <td className="num">
                  {rank(c.r_dists)} <span className="subtle t-xs">({fmt(c.dists)})</span>
                </td>
                <td className="num">
                  {rank(c.r_topiq)} <span className="subtle t-xs">({fmt(c.topiq)})</span>
                </td>
                <td className="num">{rank(c.sum)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

/** The 8 scored frames on a timeline, as the chosen curve renders them. */
function Frames({ assetId, runId, frames }: { assetId: string; runId: string; frames: NonNullable<ToneScores['frames']> }) {
  const { t } = useTranslation();
  return (
    <div className="stack" style={{ gap: 6 }}>
      <span className="label">{t('admin.i_frames')}</span>
      <ol className="row" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 6, overflowX: 'auto' }}>
        {frames.map((f) => (
          <li key={f.n} className="stack" style={{ gap: 2, flex: '0 0 auto' }}>
            <img
              src={`/api/admin/assets/${assetId}/frames/${f.n}?r=${runId}`}
              alt={t('admin.i_frameAlt', { time: fmtDuration(f.t) })}
              loading="lazy"
              style={{ height: 64, width: 'auto', borderRadius: 4, background: 'var(--surface-2)' }}
            />
            <span className="t-xs tnum subtle">
              {fmtDuration(f.t)}
              {f.why === 'bright' && ` · ${t('admin.i_frameBright')}`}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const { t } = useTranslation();
  const map: Record<string, [string, 'check' | 'refresh' | 'clock' | 'alert' | 'flag']> = {
    ready: ['st-ok', 'check'],
    original_only: ['st-ok', 'check'],
    processing: ['st-p', 'refresh'],
    queued: ['st-q', 'clock'],
    uploading: ['st-q', 'upload' as 'clock'],
    failed: ['st-x', 'alert'],
    needs_review: ['st-r', 'flag'],
  };
  const [cls, icon] = map[status] ?? ['st-q', 'clock'];
  return (
    <span className={`st ${cls}`}>
      <Icon name={icon} />
      {t(`myUploads.st_${status as 'ready'}`, { pos: '', defaultValue: status })}
    </span>
  );
}
