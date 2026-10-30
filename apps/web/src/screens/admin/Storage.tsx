// Admin · Storage: bytes (originals vs copies), file count against the host's limit, growth, largest events,
// and the processing settings.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import * as api from '../../api/admin.ts';
import { useAdminMutation, useSettings, useStorage } from '../../data/admin.ts';
import { fmtBytes, fmtDateTime } from '../../i18n/format.ts';
import i18n from '../../i18n/index.ts';
import { Skeleton, SkeletonRows } from '../../ui/Skeleton.tsx';

const fmtInt = (n: number) => new Intl.NumberFormat(i18n.language).format(n);

export function StorageScreen() {
  const { t } = useTranslation();
  const s = useStorage().data;
  const settings = useSettings().data;
  const save = useAdminMutation((b: Parameters<typeof api.patchSettings>[0]) => api.patchSettings(b));
  const [limit, setLimit] = useState('');
  useEffect(() => {
    document.title = `${t('admin.storage')} · ${t('brand')}`;
  }, [t]);
  useEffect(() => setLimit(settings?.inodeLimit ? String(settings.inodeLimit) : ''), [settings?.inodeLimit]);
  if (!s)
    return (
      <>
        <div className="stack" style={{ gap: 4 }}>
          <h1 className="t-h1">{t('admin.storage')}</h1>
          <Skeleton h={20} w={260} />
        </div>
        {/* Space and files tiles, growth chart, largest events: the loaded page's sections at their usual sizes. */}
        <div className="stack" style={{ gap: 24 }} aria-busy="true" aria-label={t('states.loading')}>
          <div className="row" style={{ gap: 16, flexWrap: 'wrap', alignItems: 'stretch' }} aria-hidden="true">
            {[0, 1].map((n) => (
              <div key={n} className="panel stack" style={{ flex: '1 1 320px', gap: 12 }}>
                <Skeleton h={24} w="30%" />
                <Skeleton h={44} w="45%" />
                <Skeleton h={12} />
                <Skeleton h={20} w="60%" />
                <Skeleton h={20} w="40%" />
              </div>
            ))}
          </div>
          <div className="panel stack" style={{ gap: 12 }} aria-hidden="true">
            <Skeleton h={24} w="25%" />
            <div className="row" style={{ gap: 8, alignItems: 'flex-end', height: 160 }}>
              {[40, 48, 52, 58, 61, 66, 70, 74, 80, 86, 92, 100].map((pct, n) => (
                <span key={n} className="grow skel" style={{ height: `${pct}%`, maxWidth: 48 }} />
              ))}
            </div>
          </div>
          <div className="card">
            <table className="tbl">
              <tbody>
                <SkeletonRows rows={4} cols={4} />
              </tbody>
            </table>
          </div>
        </div>
      </>
    );
  const total = s.bytesOriginals + s.bytesRenditions;
  const pctOrig = total ? (s.bytesOriginals / total) * 100 : 0;
  const filePct = s.inodeLimit ? Math.round((s.files / s.inodeLimit) * 100) : null;
  // Month-end points from the daily history.
  const months = new Map<string, { bytes: number }>();
  for (const h of s.history) months.set(h.date.slice(0, 7), { bytes: h.bytes });
  const series = [...months.entries()].slice(-12);
  const max = Math.max(1, ...series.map(([, v]) => v.bytes));
  const topMax = Math.max(1, ...s.topEvents.map((e) => e.bytes));

  return (
    <>
      <div className="stack" style={{ gap: 4 }}>
        <h1 className="t-h1">{t('admin.storage')}</h1>
        <span className="t-sm muted">{s.measuredAt ? t('admin.s_measured', { time: fmtDateTime(s.measuredAt) }) : t('admin.s_notMeasured')}</span>
      </div>
      <div className="row" style={{ gap: 16, flexWrap: 'wrap', alignItems: 'stretch' }}>
        <section className="panel stack" aria-labelledby="h-bytes" style={{ flex: '1 1 320px', gap: 12 }}>
          <h2 className="t-h3" id="h-bytes">
            {t('admin.s_space')}
          </h2>
          <span className="t-display tnum" style={{ fontSize: 40, lineHeight: '44px' }}>
            {fmtBytes(total)}
          </span>
          <div role="img" aria-label={t('admin.s_split', { o: fmtBytes(s.bytesOriginals), c: fmtBytes(s.bytesRenditions) })} className="row" style={{ height: 12, background: 'var(--surface-3)' }}>
            <span style={{ width: `${pctOrig}%`, height: '100%', background: 'var(--primary-fg)' }} />
            <span style={{ width: `${100 - pctOrig}%`, height: '100%', background: 'var(--info)' }} />
          </div>
          <div className="row t-sm" style={{ gap: 16, flexWrap: 'wrap' }}>
            <span className="row" style={{ gap: 6 }}>
              <span style={{ width: 10, height: 10, background: 'var(--primary-fg)' }} />
              {t('admin.s_originals')} <strong className="tnum">{fmtBytes(s.bytesOriginals)}</strong>
            </span>
            <span className="row" style={{ gap: 6 }}>
              <span style={{ width: 10, height: 10, background: 'var(--info)' }} />
              {t('admin.s_copies')} <strong className="tnum">{fmtBytes(s.bytesRenditions)}</strong>
            </span>
          </div>
          <span className="help">
            {t('admin.s_noLimit')} {s.diskFreeBytes != null && t('admin.s_disk', { free: fmtBytes(s.diskFreeBytes) })}
          </span>
        </section>
        <section className="panel stack" aria-labelledby="h-files" style={{ flex: '1 1 320px', gap: 12 }}>
          <h2 className="t-h3" id="h-files">
            {t('admin.s_files')}
          </h2>
          <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
            <span className="t-display tnum" style={{ fontSize: 40, lineHeight: '44px' }}>
              {fmtInt(s.files)}
            </span>
            {s.inodeLimit && <span className="muted tnum">{t('admin.s_of', { n: fmtInt(s.inodeLimit) })}</span>}
          </div>
          {filePct != null ? (
            <>
              <div className="progress" role="progressbar" aria-valuenow={filePct} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${Math.min(100, filePct)}%`, background: filePct > 85 ? 'var(--danger)' : undefined }} />
              </div>
              <span className="t-sm muted">{t('admin.s_pct', { pct: filePct })}</span>
            </>
          ) : (
            <div className="stack" style={{ gap: 4 }}>
              <span className="st st-w" style={{ alignSelf: 'flex-start' }}>
                {t('admin.s_unknownTitle')}
              </span>
              <span className="t-sm muted">{t('admin.s_unknownBody')}</span>
            </div>
          )}
          {s.byKind && (
            <dl className="lb-dl">
              <dt className="subtle">{t('admin.s_originals')}</dt>
              <dd className="tnum">{fmtInt(s.byKind.originals)}</dd>
              <dt className="subtle">{t('admin.s_photoCopies')}</dt>
              <dd className="tnum">{fmtInt(s.byKind.photoCopies)}</dd>
              <dt className="subtle">{t('admin.s_videoFiles')}</dt>
              <dd className="tnum">{fmtInt(s.byKind.videoFiles)}</dd>
            </dl>
          )}
          <form
            className="row"
            style={{ gap: 8, alignItems: 'flex-end' }}
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate([{ inodeLimit: limit ? Number(limit) : null }]);
            }}
          >
            <div className="field grow">
              <label className="label" htmlFor="inode">
                {t('admin.s_setLimit')}
              </label>
              <input className="input tnum" id="inode" inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value.replace(/\D/g, ''))} />
            </div>
            <button className="btn btn-s" type="submit" disabled={save.isPending}>
              {t('admin.s_save')}
            </button>
          </form>
        </section>
      </div>

      {series.length > 0 && (
        <section className="panel stack" aria-labelledby="h-growth" style={{ gap: 12 }}>
          <div className="row" style={{ gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <h2 className="t-h3" id="h-growth">
              {t('admin.s_growth')}
            </h2>
            <span className="t-sm muted">{t('admin.s_growthNote')}</span>
          </div>
          <div className="row" style={{ gap: 8, alignItems: 'flex-end', height: 160 }} role="img" aria-label={series.map(([m, v]) => `${m}: ${fmtBytes(v.bytes)}`).join(', ')}>
            {series.map(([m, v]) => (
              <div key={m} className="stack grow" style={{ alignItems: 'center', gap: 4, height: '100%', justifyContent: 'flex-end' }}>
                <span className="t-xs tnum muted">{fmtBytes(v.bytes)}</span>
                <span style={{ width: '100%', maxWidth: 48, height: `${(v.bytes / max) * 100}%`, minHeight: 2, background: 'var(--primary-fg)' }} />
                <span className="t-xs subtle">{m.slice(2)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="stack" aria-labelledby="h-largest" style={{ gap: 12 }}>
        <h2 className="t-h3" id="h-largest">
          {t('admin.s_largest')}
        </h2>
        <div className="card scroll-x">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('admin.s_colEvent')}</th>
                <th className="num">{t('admin.s_colItems')}</th>
                <th className="num">{t('admin.s_colSpace')}</th>
                <th>
                  <span className="vh">{t('admin.s_colShare')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {s.topEvents.map((e) => (
                <tr key={e.id}>
                  <td>
                    <Link to={`/events/${e.slug}`}>{e.title}</Link>
                  </td>
                  <td className="num">{fmtInt(e.items)}</td>
                  <td className="num">{fmtBytes(e.bytes)}</td>
                  <td style={{ width: '30%' }}>
                    <div className="progress">
                      <span style={{ width: `${(e.bytes / topMax) * 100}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {settings && (
        <section className="panel stack" style={{ gap: 8 }}>
          <h2 className="t-h3">{t('admin.s_curveTitle')}</h2>
          <div className="row" style={{ gap: 12 }}>
            <button
              role="switch"
              aria-checked={settings.tonemapAuto}
              aria-label={t('admin.s_curveTitle')}
              className={`switch${settings.tonemapAuto ? ' on' : ''}`}
              style={{ border: 0, opacity: settings.tonemapGatePassed ? 1 : 0.4, cursor: settings.tonemapGatePassed ? 'pointer' : 'not-allowed' }}
              disabled={!settings.tonemapGatePassed || save.isPending}
              onClick={() => save.mutate([{ tonemapAuto: !settings.tonemapAuto }])}
            />
            <span className="t-sm">{settings.tonemapAuto ? t('admin.s_curveOn') : t('admin.s_curveOff')}</span>
          </div>
          {!settings.tonemapGatePassed && <span className="help">{t('admin.s_curveGate')}</span>}
        </section>
      )}
    </>
  );
}
