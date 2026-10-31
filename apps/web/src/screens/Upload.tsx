// Upload (core): 1 choose or create the event, 2 add files with per-file tier, 3 progress, 4 done with ETAs.
import type { EventCard } from '@acm/core/schemas';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { discardUpload } from '../api/uploads.ts';
import { useEvent, useEvents } from '../data/library.ts';
import { useCreateEvent, useExisting, useMyUploads } from '../data/uploads.ts';
import { fmtBytes, fmtDate, readyAt } from '../i18n/format.ts';
import { fmtEta } from '../lib/eta.ts';
import { fileKey, isVideo, type Item, type Tier, uploader, useUploads } from '../lib/uploader.ts';
import { type EventForm, EventFields, eventBody, FIELD_MSG, invalidFields, TierChoice } from './EventEdit.tsx';
import { useOnline } from './States.tsx';
import { UploadQueuePanel } from './UploadQueue.tsx';
import { Icon } from '../ui/Icon.tsx';
import { Rich } from '../ui/Rich.tsx';

const ACCEPT = 'image/jpeg,image/png,image/heic,image/heif,image/avif,image/webp,video/mp4,video/quicktime,.heic,.heif,.mov';
type Picked = { file: File; tier: Tier; girlsOnly: boolean; dup: boolean; key: string };

export function UploadScreen() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const eventId = params.get('event') ?? undefined;
  const items = useUploads();
  const batch = items.filter((i) => i.eventId === eventId && i.status !== 'cancelled');
  const [step, setStep] = useState<1 | 2 | 3 | 4>(eventId ? (batch.length ? 3 : 2) : 1);
  const event = useEvent(eventId ?? '');
  const online = useOnline();
  useEffect(() => {
    document.title = `${t('upload.title')} · ${t('brand')}`;
  }, [t]);
  useEffect(() => {
    if (step === 3 && batch.length && batch.every((i) => i.status === 'done' || i.status === 'cancelled')) setStep(4);
  }, [step, batch]);

  const chooseEvent = (id: string) => {
    setParams({ event: id }, { replace: true });
    setStep(2);
  };

  return (
    <>
      {!online && (
        <div className="banner st-w" role="status">
          <Icon name="offline" />
          <span>
            <Rich k="upload.offline" values={{}} />
          </span>
        </div>
      )}
      <ResumeBanner onChoose={(id) => chooseEvent(id)} />
      <main id="main" className="wrap stack" style={{ maxWidth: 1080, paddingTop: 32, paddingBottom: 64, gap: 28 }}>
        <div className="stack" style={{ gap: 16 }}>
          <h1 className="t-display login-title">{t('upload.title')}</h1>
          <ol aria-label={t('upload.steps')} className="row steps">
            {[t('upload.step1'), t('upload.step2'), t('upload.step3')].map((label, i) => (
              <li key={label} aria-current={Math.min(step, 3) === i + 1 ? 'step' : undefined} data-done={Math.min(step, 3) > i + 1 || undefined}>
                <span className="tnum">{i + 1}</span>
                {label}
              </li>
            ))}
          </ol>
        </div>
        {step === 1 && <ChooseEvent initial={eventId} onPick={chooseEvent} />}
        {step === 2 && eventId && event.data && <AddFiles event={event.data} onBack={() => setStep(1)} onStart={() => setStep(3)} />}
        {step === 3 && <Progress batch={batch} />}
        {step === 4 && event.data && (
          <Done
            batch={batch}
            eventSlug={event.data.slug}
            onMore={() => {
              uploader.clearFinished();
              setStep(2);
            }}
          />
        )}
      </main>
    </>
  );
}

function ChooseEvent({ initial, onPick }: { initial?: string; onPick: (id: string) => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);
  const events = useEvents({ q: debounced || undefined });
  const list = (events.data?.pages[0]?.items ?? []).slice(0, 8);
  const [picked, setPicked] = useState<string | undefined>(initial);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<EventForm>({ title: '', startsOn: new Date().toISOString().slice(0, 10), endsOn: '', location: '', description: '', defaultTier: 'member' });
  const [error, setError] = useState<string | null>(null);
  const create = useCreateEvent();

  async function next() {
    setError(null);
    if (!creating) return picked ? onPick(picked) : setError(t('upload.pickEvent'));
    const bad = invalidFields(form)[0];
    if (bad) return setError(t(FIELD_MSG[bad]));
    const ev = await create.mutateAsync(eventBody(form));
    onPick(ev.id);
  }

  return (
    <section className="panel stack" aria-labelledby="h-ev" style={{ gap: 20 }}>
      <h2 className="t-h2" id="h-ev">
        {t('upload.whichEvent')}
      </h2>
      <label className="search" style={{ height: 44 }}>
        <Icon name="search" />
        <input type="search" placeholder={t('upload.searchEvents')} aria-label={t('upload.searchEvents')} value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      <div role="radiogroup" aria-label={t('upload.events')} className="stack" style={{ gap: 6 }}>
        {list.map((e: EventCard) => (
          <button
            key={e.id}
            role="radio"
            aria-checked={!creating && picked === e.id}
            className="pick"
            onClick={() => {
              setCreating(false);
              setPicked(e.id);
            }}
          >
            <span className="pick-thumb" style={{ background: 'var(--surface-3)' }}>
              {e.coverUrl && <img src={e.coverUrl} alt="" onError={(x) => (x.currentTarget.style.display = 'none')} />}
            </span>
            <span className="stack grow" style={{ gap: 2, textAlign: 'start' }}>
              <span style={{ fontWeight: 600 }}>{e.title}</span>
              <span className="t-sm muted">{[fmtDate(e.startsOn), e.location].filter(Boolean).join(' · ')}</span>
            </span>
            <span className="radio" aria-hidden="true" />
          </button>
        ))}
        <button className="pick" aria-checked={creating} role="radio" onClick={() => setCreating(true)}>
          <span className="pick-thumb" style={{ display: 'grid', placeItems: 'center' }}>
            <Icon name="plus" />
          </span>
          <span className="grow" style={{ textAlign: 'start', fontWeight: 600 }}>
            {t('upload.createNew')}
          </span>
          <span className="radio" aria-hidden="true" />
        </button>
      </div>
      {creating && (
        <div className="stack" style={{ gap: 16, borderTop: '1px solid var(--border)', paddingTop: 20 }}>
          <h3 className="t-h3">{t('upload.newEvent')}</h3>
          <EventFields form={form} setForm={setForm} tierHelp={t('upload.tierHelp')} />
        </div>
      )}
      {error && (
        <span className="err" role="alert">
          <Icon name="alert" size="sm" style={{ marginTop: 3 }} />
          {error}
        </span>
      )}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <Link className="btn btn-g" to="/">
          {t('upload.cancel')}
        </Link>
        <button className="btn btn-p" onClick={() => void next()} disabled={create.isPending}>
          {t('upload.continue')}
        </button>
      </div>
    </section>
  );
}

function AddFiles({ event, onBack, onStart }: { event: { id: string; title: string; slug: string; defaultTier: Tier }; onBack: () => void; onStart: () => void }) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<Picked[]>([]);
  const [over, setOver] = useState(false);
  const [tip, setTip] = useState(() => {
    try {
      return localStorage.getItem('acm.tip.hdr') !== 'off';
    } catch {
      return true;
    }
  });
  const input = useRef<HTMLInputElement>(null);
  const existing = useExisting(event.id);
  const known = useMemo(() => new Set((existing.data?.items ?? []).map((x) => `${x.filename}:${x.bytes}`)), [existing.data]);

  const add = (files: FileList | File[]) => {
    const have = new Set(picked.map((p) => p.key));
    const next = [...picked];
    for (const file of Array.from(files)) {
      const key = fileKey(file);
      if (have.has(key)) continue;
      have.add(key);
      next.push({ file, key, tier: event.defaultTier, girlsOnly: false, dup: known.has(`${file.name}:${file.size}`) });
    }
    setPicked(next);
  };
  const set = (key: string, change: Partial<Picked>) => setPicked((p) => p.map((x) => (x.key === key ? { ...x, ...change } : x)));
  // Everything in a core-only event is core (the server enforces it too), so there is no per-file choice.
  const coreEvent = event.defaultTier === 'core';
  const remove = (key: string) => setPicked((p) => p.filter((x) => x.key !== key));
  const videos = picked.filter((p) => isVideo(p.file)).length;
  const bytes = picked.reduce((s, p) => s + p.file.size, 0);
  const SHOW = 50;

  return (
    <div className="row" style={{ alignItems: 'flex-start', gap: 24, flexWrap: 'wrap' }}>
      <section className="panel stack" aria-labelledby="h-files" style={{ gap: 20, flex: '999 1 560px', minWidth: 0 }}>
        <div className="stack" style={{ gap: 4 }}>
          <h2 className="t-h2" id="h-files">
            {t('upload.addFiles')}
          </h2>
          <span className="t-sm muted">
            <Rich k="upload.toEvent" values={{ title: event.title }} />
          </span>
        </div>
        <div
          className="dropzone"
          data-over={over || undefined}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            add(e.dataTransfer.files);
          }}
        >
          <Icon name="upload" size="lg" />
          <span className="t-h3">{t('upload.drop')}</span>
          <button className="btn btn-s btn-sm" onClick={() => input.current?.click()}>
            {t('upload.choose')}
          </button>
          <input ref={input} type="file" multiple accept={ACCEPT} className="vh" tabIndex={-1} onChange={(e) => e.target.files && add(e.target.files)} />
          <span className="help">{t('upload.accepted')}</span>
        </div>
        {picked.length > 0 && (
          <>
            <div className="row" style={{ flexWrap: 'wrap', gap: '8px 12px' }}>
              <span className="t-h3 tnum">{t('upload.fileCount', { n: picked.length })}</span>
              <span className="t-sm muted tnum">{t('upload.fileSummary', { photos: picked.length - videos, videos, size: fmtBytes(bytes) })}</span>
              <span className="grow" />
              {coreEvent ? (
                <span className="tier">
                  <Icon name="shield" />
                  {t('upload.allCore')}
                </span>
              ) : (
                <>
                  <span className="t-sm muted">{t('upload.setAll')}</span>
                  <button className="chip" onClick={() => setPicked((p) => p.map((x) => ({ ...x, tier: 'member' })))}>
                    {t('upload.members')}
                  </button>
                  <button className="chip" onClick={() => setPicked((p) => p.map((x) => ({ ...x, tier: 'core' })))}>
                    <Icon name="shield" size="sm" />
                    {t('upload.core')}
                  </button>
                </>
              )}
            </div>
            <ul className="filelist">
              {picked.slice(0, SHOW).map((p) => (
                <li key={p.key}>
                  <span className="file-thumb">{isVideo(p.file) && <span className="mb"><Icon name="play" /></span>}</span>
                  <span className="stack grow" style={{ minWidth: 0, gap: 2 }}>
                    <bdi className="truncate">{p.file.name}</bdi>
                    <span className="t-sm muted tnum">{t(isVideo(p.file) ? 'upload.videoMeta' : 'upload.photoMeta', { size: fmtBytes(p.file.size) })}</span>
                  </span>
                  {p.dup && (
                    <>
                      <span className="st st-w">
                        <Icon name="alert" />
                        {t('upload.duplicate')}
                      </span>
                      <button className="btn btn-g btn-sm" onClick={() => remove(p.key)}>
                        {t('upload.skip')}
                      </button>
                    </>
                  )}
                  <label className="row" style={{ gap: 6, cursor: 'pointer' }}>
                    <input type="checkbox" className="check" checked={p.girlsOnly} aria-describedby="girls-help" aria-label={t('upload.girlsOnlyFor', { name: p.file.name })} onChange={(e) => set(p.key, { girlsOnly: e.target.checked })} />
                    <span className="t-sm" aria-hidden="true">
                      {t('upload.girlsOnly')}
                    </span>
                  </label>
                  {!coreEvent && <TierChoice value={p.tier} onChange={(v) => set(p.key, { tier: v })} label={t('upload.whoCanSee', { name: p.file.name })} />}
                  <button className="btn btn-g btn-sm btn-ic" aria-label={t('upload.remove', { name: p.file.name })} onClick={() => remove(p.key)}>
                    <Icon name="close" />
                  </button>
                </li>
              ))}
            </ul>
            {picked.length > SHOW && <span className="t-sm subtle">{t('upload.andMore', { n: picked.length - SHOW })}</span>}
            <span className="help" id="girls-help">
              {t('upload.girlsOnlyHelp')}
            </span>
          </>
        )}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-g" onClick={onBack}>
            {t('upload.back')}
          </button>
          <button
            className="btn btn-p"
            disabled={!picked.length}
            onClick={() => {
              uploader.add(picked.map(({ file, tier, girlsOnly }) => ({ file, tier: coreEvent ? 'core' : tier, girlsOnly })), event.id);
              onStart();
            }}
          >
            <Icon name="upload" />
            {t('upload.uploadN', { n: picked.length })}
          </button>
        </div>
      </section>
      {tip && (
        <aside className="panel stack" aria-labelledby="h-tip" style={{ gap: 10, flex: '1 1 280px' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 className="t-h3" id="h-tip">
              {t('upload.tipTitle')}
            </h3>
            <button
              className="btn btn-g btn-sm btn-ic"
              aria-label={t('upload.dismissTip')}
              onClick={() => {
                setTip(false);
                try {
                  localStorage.setItem('acm.tip.hdr', 'off');
                } catch {
                  /* ignore */
                }
              }}
            >
              <Icon name="close" />
            </button>
          </div>
          <p className="t-sm muted" style={{ margin: 0 }}>
            <Rich k="upload.tip" values={{}} />
          </p>
          <span className="t-xs subtle">{t('upload.tipPath')}</span>
        </aside>
      )}
    </div>
  );
}

/** Bytes per second over the last 20 s, and whether nothing moved in that time (re-checked every 5 s). */
function useSpeed(sent: number) {
  const samples = useRef<{ t: number; b: number }[]>([]);
  const moved = useRef({ t: Date.now(), b: sent });
  const [, rerender] = useState(0);
  useEffect(() => {
    const id = setInterval(() => rerender((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, []);
  const now = Date.now();
  if (sent !== moved.current.b) moved.current = { t: now, b: sent };
  samples.current = [...samples.current.filter((s) => now - s.t < 20_000), { t: now, b: sent }];
  const first = samples.current[0]!;
  const dt = (now - first.t) / 1000;
  return { speed: dt > 2 ? (sent - first.b) / dt : 0, stalled: now - moved.current.t >= 20_000 };
}

function Progress({ batch }: { batch: Item[] }) {
  const { t } = useTranslation();
  const total = batch.reduce((s, i) => s + i.total, 0);
  const sent = batch.reduce((s, i) => s + (i.status === 'done' ? i.total : i.sent), 0);
  const done = batch.filter((i) => i.status === 'done').length;
  const { speed, stalled } = useSpeed(sent);
  const anyActive = batch.some((i) => i.status === 'uploading' || i.status === 'waiting' || i.status === 'queued');
  const left = !anyActive || sent >= total ? 'none' : stalled ? (sent ? 'stalled' : 'waiting') : speed > 0 ? fmtEta((total - sent) / speed) : 'none';
  const pct = total ? Math.round((sent / total) * 100) : 0;
  const order: Record<string, number> = { failed: 0, uploading: 1, paused: 2, waiting: 3, queued: 4, done: 5, cancelled: 6 };
  const rows = [...batch].sort((a, b) => order[a.status]! - order[b.status]!);
  const SHOW = 30;

  return (
    <section className="stack" aria-labelledby="h-up" style={{ gap: 16 }}>
      <div className="panel stack" style={{ gap: 12 }}>
        <div className="row" style={{ flexWrap: 'wrap', gap: '8px 16px' }}>
          <h2 className="t-h2" id="h-up">
            {done === batch.length ? t('upload.uploadedAll', { n: batch.length }) : t('upload.uploadingN', { done, n: batch.length })}
          </h2>
          <span className="t-sm muted tnum">{t('upload.progressMeta', { sent: fmtBytes(sent), total: fmtBytes(total), left })}</span>
          <span className="grow" />
          <button className="btn btn-s btn-sm" onClick={() => (anyActive ? uploader.pauseAll() : uploader.resumeAll())}>
            {anyActive ? t('upload.pauseAll') : t('upload.resumeAll')}
          </button>
        </div>
        <div className="progress" role="progressbar" aria-label={t('upload.overall')} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${pct}%` }} />
        </div>
        <span className="help">{t('upload.leaveHint')}</span>
      </div>
      <ul className="filelist panel" aria-label={t('upload.files')} style={{ padding: 0 }}>
        {rows.slice(0, SHOW).map((i) => (
          <ProgressRow key={i.key} i={i} />
        ))}
      </ul>
      {rows.length > SHOW && <span className="t-sm subtle">{t('upload.moreWaiting', { n: rows.length - SHOW })}</span>}
      <UploadQueuePanel />
    </section>
  );
}

function ProgressRow({ i }: { i: Item }) {
  const { t } = useTranslation();
  const pct = i.total ? Math.floor((i.sent / i.total) * 100) : 0;
  const cls = { queued: 'st-q', waiting: 'st-q', uploading: 'st-p', paused: 'st-q', done: 'st-ok', failed: 'st-x', cancelled: 'st-q' }[i.status];
  const icon = { queued: 'clock', waiting: 'clock', uploading: 'upload', paused: 'clock', done: 'check', failed: 'alert', cancelled: 'close' }[i.status] as 'clock';
  return (
    <li className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <span className="file-thumb">{isVideo(i.file) && <span className="mb"><Icon name="play" /></span>}</span>
        <span className="stack grow" style={{ minWidth: 0, gap: 2 }}>
          <bdi className="truncate">{i.file.name}</bdi>
          <span className="t-sm muted tnum">
            {fmtBytes(i.file.size)}
            {i.tier === 'core' ? ` · ${t('upload.core')}` : ''}
            {i.girlsOnly ? ` · ${t('upload.girlsOnly')}` : ''}
          </span>
        </span>
        <span className={`st ${cls}`}>
          <Icon name={icon} />
          {t(`upload.st_${i.status}`, { pct, n: i.position ?? 0 })}
        </span>
        {i.status === 'uploading' && (
          <button className="btn btn-g btn-sm btn-ic" aria-label={t('upload.pause', { name: i.file.name })} onClick={() => uploader.pause(i.key)}>
            <Icon name="pause" />
          </button>
        )}
        {i.status === 'paused' && (
          <button className="btn btn-g btn-sm btn-ic" aria-label={t('upload.resume', { name: i.file.name })} onClick={() => uploader.resume(i.key)}>
            <Icon name="play" />
          </button>
        )}
        {i.status === 'failed' && i.reason !== 'unsupported_type' && i.reason !== 'too_large' && (
          <button className="btn btn-s btn-sm" onClick={() => uploader.retry(i.key)}>
            <Icon name="refresh" />
            {t('upload.retry')}
          </button>
        )}
        {i.status !== 'done' && i.status !== 'cancelled' && (
          <button className="btn btn-g btn-sm btn-ic" aria-label={t('upload.cancelFile', { name: i.file.name })} onClick={() => uploader.cancel(i.key)}>
            <Icon name="close" />
          </button>
        )}
      </div>
      {(i.status === 'uploading' || i.status === 'paused') && (
        <div className="progress">
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
      {i.status === 'failed' && (
        <span className="err">
          <Icon name="alert" size="sm" style={{ marginTop: 3 }} />
          {t(`upload.err_${i.reason ?? 'network'}`, { drops: Math.max(1, i.drops), pct })}
        </span>
      )}
    </li>
  );
}

function Done({ batch, eventSlug, onMore }: { batch: Item[]; eventSlug: string; onMore: () => void }) {
  const { t } = useTranslation();
  const mine = useMyUploads('active');
  const ids = new Set(batch.map((i) => i.assetId).filter(Boolean));
  const here = (mine.data?.pages.flatMap((p) => p.items) ?? []).filter((i) => ids.has(i.assetId));
  const longest = Math.max(0, ...here.filter((i) => i.kind === 'video').map((i) => i.readyInS ?? 0));
  const waiting = here.length > 0 && here.every((i) => i.readyInS == null);
  const n = batch.filter((i) => i.status === 'done').length;
  return (
    <section className="stack" aria-labelledby="h-done" style={{ gap: 18, maxWidth: 680 }}>
      <span className="st st-ok" style={{ alignSelf: 'flex-start' }}>
        <Icon name="check" />
        {t('upload.st_done')}
      </span>
      <h2 className="t-display login-title" id="h-done">
        {t('upload.doneTitle', { n })}
      </h2>
      <p className="t-body muted">{waiting ? t('upload.doneWaiting') : longest > 0 ? <Rich k="upload.doneWithVideos" values={{ duration: fmtEta(longest), time: readyAt(longest) }} /> : t('upload.donePhotosOnly')}</p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Link className="btn btn-p" to="/uploads">
          {t('upload.goMyUploads')}
        </Link>
        <Link className="btn btn-s" to={`/events/${eventSlug}`}>
          {t('upload.viewEvent')}
        </Link>
        <button className="btn btn-g" onClick={onMore}>
          {t('upload.uploadMore')}
        </button>
      </div>
      {longest > 0 && <span className="help">{t('upload.etaHelp')}</span>}
    </section>
  );
}

/** Server-side unfinished uploads from an earlier visit (or another tab) that this tab isn't sending. */
function ResumeBanner({ onChoose }: { onChoose: (eventId: string) => void }) {
  const { t } = useTranslation();
  const mine = useMyUploads('active');
  const local = new Set(useUploads().map((i) => i.file.name));
  const stale = (mine.data?.pages.flatMap((p) => p.items) ?? []).filter((i) => i.status === 'uploading' && !local.has(i.filename));
  if (!stale.length) return null;
  const first = stale[0]!;
  const sameEvent = stale.filter((s) => s.eventId === first.eventId);
  return (
    <div className="banner" role="status" style={{ background: 'var(--info-bg)', color: 'var(--text)' }}>
      <Icon name="upload" />
      <span className="grow">
        <Rich k="upload.resumeBanner" values={{ n: sameEvent.length, event: first.eventTitle }} />
      </span>
      <button className="btn btn-p btn-sm" onClick={() => onChoose(first.eventId)}>
        {t('upload.chooseSame')}
      </button>
      <button
        className="btn btn-g btn-sm"
        onClick={() => {
          void Promise.all(sameEvent.map((s) => s.uploadId && discardUpload(s.uploadId))).then(() => mine.refetch());
        }}
      >
        {t('upload.discard')}
      </button>
    </div>
  );
}
